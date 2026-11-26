/// <reference types="node" />

import type { PaseoApi } from "./paseo-api";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { type CoordinatorRequest, type CoordinatorState, type Task, completionNeedsDecision } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import { REPORT_DONE_TOOL, continuedBy, finishRequestIfDone, recordCompletion, reportDoneInput } from "./completion";
import { workspaceTitle } from "./coordinator";
import type { StateStore } from "./store";
import { type WorkerChannel, queued } from "./worker-channel";
import { type BaseRef, remoteDefaultBranch, resolveBaseRef } from "./branches";
import { preapprovedOptions } from "./preapprove";
import { say } from "./say";
import { REPORT_BLOCKER_TOOL, recordBlocker, reportBlockerInput } from "./worker-tools";
import { type ExistingWorkspace, busyReason, listExistingWorkspaces, pluginWorkspaceIds, readCheckout, workspaceProblem } from "./existing-workspace";

type Settings = PluginSettings<typeof settingsSchema>;
type TaskPatch = Partial<
  Pick<Task, "status" | "workspaceId" | "agentId" | "branch" | "baseBranch" | "note" | "poteto" | "doneNudgedAt" | "existingWorkspaceId" | "startCommit">
>;

/** 이 라벨로 워커를 알아본다. 코디네이터 라벨과 같은 키를 쓴다. */
const ROLE_LABEL = "paseo-coordinator.role";

type TurnOutcome = { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };

const RECONCILE_INTERVAL_MS = 15_000;

/** 워커 snapshot 에서 아직 도는 백그라운드 작업(셸, 모니터) 수. 프로토콜이 runningCount 를 주지 않으면 count 를 쓴다. */
function backgroundRunning(agent: { backgroundWork?: { count: number; runningCount?: number } | null }): number {
  return agent.backgroundWork?.runningCount ?? agent.backgroundWork?.count ?? 0;
}

type TimelineItem = { type?: string; name?: string; status?: string; callId?: string; detail?: { input?: unknown; output?: unknown } };

/**
 * 워커가 마지막으로 부른 보고 도구(report_done, report_blocker). 도구가 세션에 없어 실패했는지도 본다.
 * 플러그인이 다시 시작되면 이미 열린 워커 세션의 플러그인 도구가 끊길 수 있다. r12 워커는 일을 다 끝내고 report_done 을 불렀지만
 * "Tool report_done not found" 로 실패했고, 플러그인은 그 작업을 '완료 보고 없이 두 번 멈춤'으로 막았다. 사람은 성공한 작업을
 * 취소했다 (2026-11-26).
 */
async function lastReportCall(
  paseo: PaseoApi,
  agentId: string,
): Promise<{ tool: "done" | "blocker"; input: unknown; missing: boolean; callId: string } | null> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 }).catch(() => null);
  const entries = (page as { entries?: readonly { item?: TimelineItem }[] } | null)?.entries ?? [];
  for (const entry of [...entries].reverse()) {
    const item = entry.item;
    if (item?.type !== "tool_call" || !item.name) continue;
    const tool = item.name.endsWith(REPORT_DONE_TOOL) ? "done" : item.name.endsWith(REPORT_BLOCKER_TOOL) ? "blocker" : null;
    if (!tool) continue;
    const output = JSON.stringify(item.detail?.output ?? "");
    return {
      tool,
      input: item.detail?.input,
      missing: item.status === "failed" && /not found/i.test(output),
      callId: item.callId ?? JSON.stringify(item.detail?.input ?? null),
    };
  }
  return null;
}

/** report_done 없이 끝난 워커에게 다시 요청하는 말. 끝내는 방법은 킥오프와 같아야 한다 (운영 작업과 로컬 기준 브랜치는 PR 이 없다). */
function nudge(task: Task): string {
  const finish =
    task.kind === "operation"
      ? "call report_done now; operation tasks need no pull request"
      : task.existingWorkspaceId
        ? `call report_done now, after committing your changes on ${task.branch}; do not push or open a pull request`
        : "call report_done now, after pushing and opening the pull request if your kickoff told you to (if the human's request says not to, quote it as noPullRequestReason)";
  return `[From the coordinator plugin] Your turn ended without report_done. If the task is finished and verified, ${finish}. If you are blocked, call report_blocker instead.`;
}

/**
 * 백그라운드 작업을 기다리는 워커를 끝난 것으로 보지 않는 최대 시간. 빌드 대기는 그 작업이 끝나면 워커가 다시 일한다.
 * 다만 앱 실행이나 dev 서버처럼 끝나지 않는 작업을 띄워 두고 보고 없이 멈추면 영원히 진행 중으로 남으므로, 이 시간이 지나면
 * 보통처럼 다시 요청하고 그래도 없으면 막힘으로 둔다 (2026-11-26 최종 검사).
 */
const BACKGROUND_GRACE_MS = 30 * 60_000;

function patch(state: CoordinatorState, requestId: string, number: number, change: TaskPatch): CoordinatorState {
  return {
    ...state,
    requests: state.requests.map((request) =>
      request.id === requestId
        ? { ...request, tasks: request.tasks.map((task) => (task.number === number ? { ...task, ...change } : task)) }
        : request,
    ),
  };
}

// 선행 작업이 이 상태면 다음 작업을 시작한다. review 는 워커가 일을 마치고 사람의 확인만 남은 상태다.
const FINISHED: ReadonlySet<Task["status"]> = new Set(["done", "review"]);

/**
 * 선행 작업이 끝나 이 작업을 시작해도 되는가. 운영 작업은 앞 코드 작업의 결과가 사람의 결정까지 끝난 뒤에만 시작한다.
 * PR 머지 전(review)에 시작하면 '머지 뒤 브랜치 정리' 같은 운영 작업이 아직 머지되지 않은 PR 의 브랜치를 지울 수 있다
 * (2026-11-26 최종 검사). 이어 쓰기로 done 이 된 작업은 PR 을 뒤 작업이 내므로 사슬 끝 작업을 본다. PR 도 남은 변경도 없이
 * 끝난 작업(확인 필요)은 기다릴 결정이 없어 끝난 것으로 본다. 기다리면 사람이 보지 않는 카드 때문에 운영 작업이 멈춘다.
 */
function dependencyFinished(request: CoordinatorRequest, dependency: Task | undefined, task: Task): boolean {
  if (!dependency || !FINISHED.has(dependency.status)) return false;
  if (task.kind !== "operation" || dependency.kind === "operation") return true;
  let end: Task = dependency;
  for (let next = continuedBy(request, end); next; next = continuedBy(request, end)) end = next;
  if (end.status === "done") return true;
  return end.status === "review" && !completionNeedsDecision(end);
}

async function readSettings(settings: Settings) {
  const state = await settings.read();
  if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
  return state.values;
}

function branchFor(request: CoordinatorRequest, task: Task): string {
  // git 과 경로에 안전한 영문만 쓴다 (DESIGN.md 이름 규칙). 다시 계획해도 겹치지 않게 짧은 꼬리를 붙인다.
  const suffix = Date.now().toString(36).slice(-4);
  return `coord/${request.id}-${task.number}-${suffix}`;
}

/**
 * poteto 의 worker.md 는 킥오프가 명시적으로 말할 때만 규칙을 덮어쓴다 (RULES.md §11 등급별 덮어쓰기).
 * poteto 의 Always pause 목록과 H2 의 차이(PR 머지, DB 쓰기, worktree 밖 쓰기, 비밀 파일)를 여기서 막는다.
 */
function potetoOverride(
  grade: CoordinatorRequest["grade"],
  branch: string,
  finish: "pullRequest" | "existing" | "successor" | "localBase",
): string[] {
  // 끝내는 방법은 같은 킥오프의 규칙과 같아야 한다. 늘 'push 하고 PR' 이라고 쓰면, 뒤 작업이 이어 쓰는 작업과 로컬 기준 브랜치
  // 작업에서 바로 위의 'push 하지 마' 와 부딪혔다 (2026-11-26 전수 검사).
  const reach =
    finish === "pullRequest"
      ? "Go as far as pushing this branch and opening a pull request from it."
      : `Go as far as committing on this branch. Do not push it or open a pull request: ${
          finish === "existing"
            ? "it is the human's branch"
            : finish === "successor"
              ? "the next task continues on it and opens the pull request"
              : "its base branch exists only on this machine"
        }.`;
  return [
    "",
    `This kickoff overrides worker.md as follows. Your working branch is ${branch}. ${reach} Do not merge pull requests (including stacked ones or auto-merge), push to any other branch, write to any database in any environment, deploy, send external messages, write outside this worktree, or access secret files. If you need any of those, report it with the report_blocker tool and stop. Make reversible implementation choices yourself and list what you chose and why in report_done.`,
    ...(grade === "B"
      ? ["If you must choose a data structure, a public API or a library, do not choose: report the options and your recommendation with report_blocker."]
      : []),
  ];
}

/**
 * 워커 첫 프롬프트. 플러그인이 보내므로 Paseo 가 감싸지 않는다 (RULES.md §13). A·B·C 등급 Claude 워커는 /poteto-mode 로 시작한다.
 * 금지 사항은 RULES.md H2 와 같다. 명령 단위 차단은 Claude auto 모드와 사용자 권한 규칙(ask: gh pr merge 등)이 맡는다.
 */
function kickoff(
  request: CoordinatorRequest,
  task: Task,
  branch: string,
  continuesFrom: Task | null,
  poteto: boolean,
  base: BaseRef | null,
  /** 사람의 기존 워크스페이스에서 일하면 그 폴더. 새 worktree 면 null. */
  existing: ExistingWorkspace | null = null,
): string {
  const readOnly = request.kind === "read";
  const operation = !readOnly && task.kind === "operation";
  const others = request.tasks
    .filter((other) => other.number !== task.number)
    .map((other) => `- ${other.number} ${other.name}${other.dependsOn.length ? ` (after ${other.dependsOn.join(", ")})` : ""}`);
  const language = request.language === "ko" ? "Korean" : "English";
  const successor = readOnly || operation ? null : continuedBy(request, task);
  return [
    ...(poteto ? ["/poteto-mode", ""] : []),
    `You are a worker started by the Paseo Coordinator for request ${request.id}, task ${task.number} of ${request.tasks.length}.`,
    "",
    "The human's request, verbatim:",
    "<<<",
    request.text,
    ...(request.doneCriteria ? ["", `Done when: ${request.doneCriteria}`] : []),
    ...request.feedback.map((item) => `Later from the human: ${item.text}`),
    ">>>",
    "",
    `Your task: ${task.number} ${task.name}`,
    `Scope: ${task.scope}`,
    `Done when: ${task.doneCriteria}`,
    ...(others.length ? ["", "Other tasks in this request (context only, do not do them):", ...others] : []),
    "",
    "Rules:",
    // r12(2026-11-26): 워커가 필요한 코드가 다른 worktree 의 브랜치에 있자 그 브랜치를 checkout 했다. 기준이 틀렸으면 보고하게 한다.
    // 운영 작업은 사람이 승인한 대상에 한해 worktree 밖에서 일한다. 이 예외가 없을 때 범위와 규칙이 부딪혀, 워커가 어느 쪽을
    // 따를지 스스로 골랐다 (r15).
    operation
      ? `- This is an operation task: the human approved these targets outside this worktree, and only these: ${task.targets.map((target) => `"${target}"`).join("; ")}. Do not touch anything else outside this worktree; if you need to, report it with report_blocker. Do not edit, commit or push files of this repository and do not open a pull request.`
      : `- Work only inside this worktree, on branch ${branch}. Do not read or change other worktrees, and do not check out other branches or commits. If the code you need is not in this worktree, report it with report_blocker.`,
    // 사람의 작업 트리다. 사람이 하던 변경이나 다른 세션의 결과를 워커가 정리하거나 되돌리면 사람의 일이 사라진다.
    ...(existing
      ? [
          `- This is the human's own workspace "${existing.name}" (${existing.directory}), not a worktree made for you. The human may use it too: do not switch branches, and do not reset, stash, discard, rebase or amend anything you did not make in this task.`,
        ]
      : []),
    ...(base && !continuesFrom && !existing ? [`- This worktree was cut from ${base.branch}.`] : []),
    ...(continuesFrom
      ? [
          `- Task ${continuesFrom.number} (${continuesFrom.name}) ran before you in this same worktree. Its changes, committed or not, are already here; build on them.`,
        ]
      : []),
    readOnly
      ? "- This is a read-only investigation. Do not change, create or delete any file. Investigate and report."
      : operation
        ? "- Before acting on each target, check that it is still in the state the plan describes. If it is not, do not act on it: report it with report_blocker."
        : successor
        ? `- You may edit files here, run local builds, tests and linters, and commit. Do not push or open a pull request: task ${successor.number} (${successor.name}) continues in this worktree${existing ? "" : " and opens it"}.`
        : existing
          ? `- You may edit files here, run local builds, tests and linters, and commit on ${branch}. Do not push and do not open a pull request: the human reviews these commits and merges ${branch} their own way.`
        : base && !base.remote
          ? `- You may edit files here, run local builds, tests and linters, and commit on ${branch}. Do not push or open a pull request: the base branch ${base.branch} exists only on this machine, so there is nothing on GitHub to open it against. When done, call report_done with noPullRequestReason saying the base branch ${base.branch} is local only.`
          : `- You may edit files here, run local builds, tests and linters, commit, push this branch, and open a pull request from it against ${base ? `${base.branch} (gh pr create --base ${base.branch})` : "the default branch"}.`,
    operation
      ? "- Never merge pull requests, force push, write to any database (any environment), deploy, send messages to people, or read or write secret files (.env, keys, credentials). Push to or delete a remote branch only when one of the targets names it."
      : "- Never merge pull requests, push to any other branch, force push, write to any database (any environment), deploy, send messages to people, or read or write secret files (.env, keys, credentials).",
    "- If you need a decision the request and scope do not settle, a change to your scope or approach, or you are stuck, call the report_blocker tool with the facts, the options and your recommendation, then end your turn and wait. Do not ask in plain text: only report_blocker reaches the human as a decision card.",
    readOnly
      ? `- Finish with a short report in ${language}: what you found, where you found it, and what is left unknown.`
      : operation
        ? `- When every target is done and checked, call the report_done tool as your last action, written in ${language}. In verification, list each target with what you did and how you checked it. No pull request is needed.`
        : existing
          ? `- When the task is done, verified and committed on ${branch}, call the report_done tool as your last action, written in ${language}. Done means your verification passed and nothing you changed is left uncommitted.`
          : `- When the task is done and verified${successor ? " and committed" : ", pushed, with the pull request open"}, call the report_done tool as your last action, written in ${language}. Done means your verification passed${successor ? "" : " and the pull request exists"}. Never merge it: the human merges from a card. If the human's request says not to commit, push or open a pull request, follow the request and quote it as noPullRequestReason in report_done.`,
    ...(poteto && !operation
      ? potetoOverride(request.grade, branch, existing ? "existing" : successor ? "successor" : base && !base.remote ? "localBase" : "pullRequest")
      : []),
  ].join("\n");
}

/**
 * 시작된 요청의 작업을 워커로 만든다 (PLAN.md 3e). 선행 작업이 끝난 대기 작업만, 의존 순서대로 배정한다.
 * 한 번에 한 흐름만 돌도록 묶고, 도는 동안 또 불리면 끝난 뒤 한 번 더 돈다.
 */
export class Dispatcher {
  private running = false;
  private again = false;
  /** 워커별로 턴 처리를 한 줄로 세운다. hook 과 보정 검사가 같은 턴을 동시에 처리하지 않게 한다. */
  private readonly turnLocks = new Map<string, Promise<void>>();
  private lastReconcile = 0;

  constructor(
    private readonly store: StateStore,
    private readonly settings: Settings,
    private readonly channel: WorkerChannel,
    private readonly onRequestDone: (paseo: PaseoApi, requestId: string) => void,
    /**
     * 코디네이터가 할 일이 생겼다(조사가 끝나 돌아왔거나, 실패한 막힘 보고를 다시 처리했다). 코디네이터에게 알린다.
     * 워커의 턴 종료는 코디네이터 알림을 부르지 않으므로 이 길로 알린다.
     */
    private readonly onCoordinatorWork: (paseo: PaseoApi, requestId: string) => void = () => {},
  ) {}

  /** 실패한 보고 호출을 이미 다시 처리했는지. 같은 호출을 턴마다 다시 처리하지 않는다. */
  private readonly replayed = new Set<string>();
  /** 워커가 백그라운드 작업을 남긴 채 쉬는 것을 처음 본 시각. 플러그인 프로세스 동안만 센다. */
  private readonly backgroundSince = new Map<string, number>();

  async run(paseo: PaseoApi): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.pass(paseo);
      } while (this.again);
    } finally {
      this.running = false;
    }
  }

  /** 워커 에이전트 id 로 요청과 작업을 찾는다. 워커가 아니면 null. */
  async findWorker(agentId: string): Promise<{ request: CoordinatorRequest; task: Task } | null> {
    const state = await this.store.read();
    for (const request of state.requests) {
      const task = request.tasks.find((item) => item.agentId === agentId);
      if (task) return { request, task };
    }
    return null;
  }

  /**
   * 워커의 턴이 끝났다. 읽기 조사는 끝난 것으로, 변경 작업은 사람의 확인이 남은 것으로 둔다.
   * 그다음 이 작업을 기다리던 작업을 배정하고, 읽기 조사가 모두 끝났으면 보고를 모아 답변으로 만든다.
   */
  async onWorkerTurn(paseo: PaseoApi, agentId: string, outcome: TurnOutcome, dispatchNext = true): Promise<void> {
    const previous = this.turnLocks.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.settleTurn(paseo, agentId, outcome, dispatchNext));
    this.turnLocks.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.turnLocks.get(agentId) === next) this.turnLocks.delete(agentId);
    }
  }

  private async settleTurn(
    paseo: PaseoApi,
    agentId: string,
    outcome: TurnOutcome,
    /** 보정 검사에서 부를 때는 false. 배정은 이미 돌고 있는 흐름이 이어서 한다. */
    dispatchNext: boolean,
  ): Promise<void> {
    const found = await this.findWorker(agentId);
    if (!found || found.request.status !== "running") return;
    const { request, task } = found;
    // 취소한 작업의 워커는 멈추기 직전의 턴이 늦게 끝날 수 있다. 처리하면 취소한 작업이 막힘이나 완료로 되살아난다.
    if (task.status === "canceled") return;
    // 턴 사이에 쌓인 메시지(코디네이터 지시, 사람의 결정)가 있으면 먼저 보낸다. 워커가 이어서 일하므로 상태는 그대로다.
    // 쌓인 메시지가 있는데 보내지 못했으면(워커가 다시 바쁨) 아직 끝난 것이 아니다.
    if (task.outbox.length > 0) {
      await this.channel.flush(paseo, request.id, task.number);
      return;
    }
    // report_blocker 로 보고하고 멈춘 워커는 결정을 기다리는 중이다. 끝난 것으로 보지 않는다.
    if (task.blocker) return;
    if (outcome.kind === "completed") {
      // 백그라운드 작업(빌드 대기, 모니터)을 걸어 두고 턴을 끝낸 워커는 그 작업이 끝나면 다시 일한다. 끝난 것으로 보거나 재촉하면
      // 일하는 중인 작업이 막힘이 된다 (r12: flutter run 을 기다리는 턴 종료를 '보고 없이 멈춤'으로 셌다).
      const snapshot = await paseo.agents.ref(agentId).refresh().catch(() => null);
      const background = snapshot ? backgroundRunning(snapshot.agent as Parameters<typeof backgroundRunning>[0]) : 0;
      const since = this.backgroundSince.get(agentId) ?? Date.now();
      if (background > 0) this.backgroundSince.set(agentId, since);
      else this.backgroundSince.delete(agentId);
      if (background > 0 && !task.completion && Date.now() - since < BACKGROUND_GRACE_MS) {
        const note = say(
          request.language,
          `The worker is waiting for ${background} background job(s) to finish.`,
          `워커가 백그라운드 작업 ${background}개가 끝나기를 기다리고 있어요.`,
        );
        if (task.note !== note) await this.patchTask(request.id, task.number, { note });
        return;
      }
    }
    if (outcome.kind === "failed") {
      await this.patchTask(request.id, task.number, {
        status: "blocked",
        note: say(request.language, `The worker stopped with an error: ${outcome.error.message}`, `워커가 에러로 멈췄어요: ${outcome.error.message}`),
      });
    } else if (outcome.kind === "completed") {
      if (request.kind === "read") {
        await this.patchTask(request.id, task.number, { status: "done", note: null });
      } else if (!(await this.settleChange(paseo, request, task))) {
        return;
      }
    } else {
      return;
    }
    if (request.kind === "read") await this.compileAnswer(paseo, request.id);
    else if (await finishRequestIfDone(this.store, request.id)) this.onRequestDone(paseo, request.id);
    if (dispatchNext) await this.run(paseo);
  }

  /**
   * 변경 작업 워커의 턴이 끝났다 (7단계). report_done 으로 보고했으면 PR 머지 카드로(review), 다음 작업이 같은 브랜치를
   * 이어 쓰면 끝(done)으로 둔다. 보고 없이 끝났으면 한 번 다시 요청하고, 그래도 없으면 막힌 것으로 둔다.
   * 상태를 바꿨으면 true, 워커에게 다시 요청해서 아직 진행 중이면 false.
   */
  private async settleChange(paseo: PaseoApi, request: CoordinatorRequest, task: Task): Promise<boolean> {
    if (task.completion) {
      await this.patchTask(request.id, task.number, { status: continuedBy(request, task) && task.kind !== "operation" ? "done" : "review", note: null });
      return true;
    }
    const replay = await this.replayFailedReport(paseo, request, task);
    if (replay !== null) return replay;
    if (!task.doneNudgedAt) {
      // 다시 요청하는 메시지는 표시와 같은 update 에서 outbox 에 넣는다 (WorkerChannel 설명).
      await this.store.update((state) => ({
        state: {
          ...state,
          requests: state.requests.map((item) =>
            item.id !== request.id
              ? item
              : {
                  ...item,
                  tasks: item.tasks.map((current) =>
                    current.number !== task.number ? current : queued({ ...current, doneNudgedAt: new Date().toISOString() }, nudge(current)),
                  ),
                },
          ),
        },
        result: undefined,
      }));
      await this.channel.flush(paseo, request.id, task.number);
      return false;
    }
    // 다시 요청한 메시지를 처리하는 중일 수 있다. 정말 쉬고 있을 때만 막힘으로 둔다.
    const snapshot = task.agentId ? await paseo.agents.ref(task.agentId).refresh().catch(() => null) : null;
    if (!snapshot || snapshot.agent.status === "running" || (snapshot.agent.pendingPermissions?.length ?? 0) > 0) return false;
    await this.patchTask(request.id, task.number, {
      status: "blocked",
      note: say(
        request.language,
        "The worker ended twice without reporting the task done. Open the worker to see where it stopped.",
        "워커가 완료 보고 없이 두 번 멈췄어요. 워커를 열어 어디서 멈췄는지 확인해 주세요.",
      ),
    });
    return true;
  }

  /**
   * 워커가 보고 도구를 불렀는데 도구가 세션에 없어 실패했으면, 그 호출의 입력으로 보고를 처리한다. 그리고 세션을 다시 열어
   * 도구를 다시 붙인다(reload 는 session-open hook 을 다시 돈다). 처리할 것이 없으면 null.
   * 상태를 바꿨으면 true, 워커에게 다시 하라고 보냈으면 false (settleChange 와 같은 뜻).
   */
  private async replayFailedReport(paseo: PaseoApi, request: CoordinatorRequest, task: Task): Promise<boolean | null> {
    if (!task.agentId) return null;
    const call = await lastReportCall(paseo, task.agentId);
    if (!call?.missing || this.replayed.has(`${task.agentId}:${call.callId}`)) return null;
    this.replayed.add(`${task.agentId}:${call.callId}`);
    const agent = await paseo.agents.ref(task.agentId).refresh().catch(() => null);
    const cwd = agent?.agent.cwd;
    // 도구를 다시 붙인다. 쉬고 있을 때만 한다. 일하는 중에 하면 진행 중인 턴이 끊긴다.
    if (agent && agent.agent.status !== "running") await paseo.agents.ref(task.agentId).reload().catch(() => undefined);
    const note = say(
      request.language,
      "The worker's report tool was missing after the plugin restarted, so the plugin used the report the worker tried to send.",
      "플러그인이 다시 시작된 뒤 워커의 보고 도구가 끊겨, 워커가 보내려던 보고 내용으로 처리했어요.",
    );
    if (call.tool === "blocker") {
      const parsed = reportBlockerInput.safeParse(call.input);
      if (!parsed.success) return null;
      const found = await recordBlocker(this.store, task.agentId, parsed.data);
      if (!found) return null;
      this.onCoordinatorWork(paseo, request.id);
      return true;
    }
    const parsed = reportDoneInput.safeParse(call.input);
    if (!parsed.success || !cwd) return null;
    const result = await recordCompletion(this.store, { id: task.agentId, cwd }, parsed.data);
    if (result.isError) {
      // 보고는 왔지만 조건이 맞지 않는다(PR 이 없음 등). 도구를 다시 붙였으니 워커에게 이유를 알려 다시 보고하게 한다.
      await this.store.update((state) => ({
        state: {
          ...state,
          requests: state.requests.map((item) =>
            item.id !== request.id
              ? item
              : {
                  ...item,
                  tasks: item.tasks.map((current) =>
                    current.number !== task.number
                      ? current
                      : queued(
                          { ...current, doneNudgedAt: new Date().toISOString() },
                          `[From the coordinator plugin] Your report_done call failed because the tool was missing; it is back now. The report was checked and not accepted: ${result.text}`,
                        ),
                  ),
                },
          ),
        },
        result: undefined,
      }));
      await this.channel.flush(paseo, request.id, task.number).catch(() => undefined);
      return false;
    }
    const updated = (await this.store.read()).requests.find((item) => item.id === request.id);
    const current = updated?.tasks.find((item) => item.number === task.number);
    if (!updated || !current?.completion) return null;
    await this.patchTask(request.id, task.number, {
      status: continuedBy(updated, current) && current.kind !== "operation" ? "done" : "review",
      note,
    });
    return true;
  }

  /**
   * hook 이 유실돼도 상태가 맞게, 실행 중으로 표시된 작업의 워커를 직접 확인한다. 알림형 hook 은 best-effort 라
   * 다시 오지 않는다 (2026-11-25: 사람의 결정을 받고 일을 마친 워커의 턴 종료가 오지 않아 작업이 running 에 멈췄다).
   * 워커가 쉬고 있으면 턴이 끝난 것으로, 에러면 막힌 것으로 처리한다.
   */
  private async reconcile(paseo: PaseoApi): Promise<void> {
    // hook 유실을 보정하는 검사라 자주 돌 필요가 없다. 워커가 많을 때 턴이 끝날 때마다 모든 워커를 조회하지 않게 간격을 둔다.
    if (Date.now() - this.lastReconcile < RECONCILE_INTERVAL_MS) return;
    this.lastReconcile = Date.now();
    const state = await this.store.read();
    const watched = state.requests
      .filter((request) => request.status === "running")
      .flatMap((request) =>
        request.tasks
          // 턴 처리가 이미 잡고 있는 워커는 건너뛴다. 그 처리 안에서 이 검사가 돌 때 같은 워커의 턴을 다시 기다리면, 자기 lock 을
          // 기다리느라 배정 흐름 전체가 멈췄다 (2026-11-26 전수 검사).
          .filter((task) => task.agentId && !task.blocker && (task.status === "running" || task.outbox.length > 0) && !this.turnLocks.has(task.agentId))
          .map((task) => ({ request, task })),
      );
    await Promise.all(
      watched.map(async ({ request, task }) => {
        const snapshot = await paseo.agents.ref(task.agentId!).refresh().catch(() => null);
        if (!snapshot) return;
        const agent = snapshot.agent;
        // 사람이 워커 세션을 닫거나 archive 하면 idle 도 error 도 아니어서, 작업이 '작업 중'에 영원히 남았다 (2026-11-26 전수 검사).
        if (agent.archivedAt || agent.status === "closed") {
          if (task.status === "running") {
            await this.patchTask(request.id, task.number, {
              status: "blocked",
              note: say(
                request.language,
                "The worker's session was closed. Restart the task to send it a message again, or cancel it.",
                "워커 세션이 닫혔어요. 다시 시작하면 그 세션에 다시 보내고, 필요 없으면 취소해 주세요.",
              ),
            });
          }
          return;
        }
        if (agent.status === "running" || (agent.pendingPermissions?.length ?? 0) > 0) return;
        // 쉬는 워커에게 보내지 못한 메시지가 남아 있으면 보낸다 (턴 종료 hook 이 유실된 경우).
        if (task.outbox.length > 0) {
          await this.channel.flush(paseo, request.id, task.number).catch(() => undefined);
          return;
        }
        if (agent.status === "idle") {
          await this.onWorkerTurn(paseo, task.agentId!, { kind: "completed" }, false);
        } else if (agent.status === "error") {
          await this.onWorkerTurn(paseo, task.agentId!, { kind: "failed", error: { message: agent.lastError ?? "Worker stopped with an error." } }, false);
        }
      }),
    );
  }

  private async pass(paseo: PaseoApi): Promise<void> {
    await this.reconcile(paseo);
    const state = await this.store.read();
    const ready: { request: CoordinatorRequest; task: Task }[] = [];
    for (const request of state.requests) {
      if (request.status !== "running") continue;
      const byNumber = new Map(request.tasks.map((task) => [task.number, task]));
      for (const task of request.tasks) {
        if (task.status !== "waiting") continue;
        if (task.dependsOn.every((number) => dependencyFinished(request, byNumber.get(number), task))) {
          ready.push({ request, task });
        }
      }
    }
    if (ready.length === 0) return;
    const values = await readSettings(this.settings);
    const { projects } = await paseo.projects.list();
    for (const { request, task } of ready) {
      try {
        await this.start(paseo, request, task, values, projects);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[coordinator] could not start ${request.id} task ${task.number}: ${message}`);
        await this.patchTask(request.id, task.number, { status: "blocked", note: message });
      }
    }
  }

  private async start(
    paseo: PaseoApi,
    request: CoordinatorRequest,
    task: Task,
    values: Awaited<ReturnType<typeof readSettings>>,
    projects: readonly { projectId: string; projectRootPath: string }[],
  ): Promise<void> {
    // 계획을 제출할 때 확인했지만, 그사이 설정에서 빠졌을 수 있어 배정 직전에 다시 확인한다.
    if (!values.allowedProjectIds.includes(task.projectId)) {
      throw new Error(
        say(request.language, `Project ${task.projectId} is no longer allowed in coordinator settings.`, `프로젝트 ${task.projectId} 가 코디네이터 설정의 허용 목록에서 빠졌어요.`),
      );
    }
    const project = projects.find((item) => item.projectId === task.projectId);
    if (!project) throw new Error(say(request.language, `Project ${task.projectId} is not registered on this host.`, `프로젝트 ${task.projectId} 가 이 호스트에 등록돼 있지 않아요.`));
    // 같은 프로젝트의 앞 작업에 이어지는 작업은 그 작업의 worktree 와 브랜치를 이어서 쓴다. 따로 worktree 를 만들면
    // 앞 작업의 (커밋하지 않은) 결과가 보이지 않아, 워커가 다른 worktree 를 뒤져 읽었다 (2026-11-25 r6 테스트).
    // 운영 작업은 이어 쓰지 않고, 운영 작업의 worktree 도 넘겨받지 않는다 (continuedBy 와 같은 규칙).
    const continuesFrom =
      task.kind === "operation"
        ? null
        : (request.tasks
            .filter(
              (other) =>
                task.dependsOn.includes(other.number) && other.projectId === task.projectId && other.kind !== "operation" && other.workspaceId,
            )
            .sort((a, b) => b.number - a.number)[0] ?? null);
    // 한 작업의 worktree 는 한 작업만 이어 쓴다. 둘이 이어 쓰면 두 워커가 한 worktree 에서 동시에 일하고,
    // 한쪽을 머지할 때 다른 쪽의 worktree 가 지워진다. 계획 검증(validatePlan)이 막지만 여기서도 한 번 더 막는다.
    if (continuesFrom && continuedBy(request, continuesFrom)?.number !== task.number) {
      throw new Error(
        say(
          request.language,
          `Task ${task.number} and another task both continue task ${continuesFrom.number} in the same worktree. Chain them instead.`,
          `작업 ${task.number} 와 다른 작업이 모두 작업 ${continuesFrom.number} 의 worktree 를 이어 써요. 앞뒤로 이어지게 계획을 고쳐야 해요.`,
        ),
      );
    }
    // 사람의 기존 워크스페이스에서 일하는 작업. 앞 작업이 그 워크스페이스에서 일했으면 이어 쓰는 뒤 작업도 거기서 일한다.
    const existingId = continuesFrom ? continuesFrom.existingWorkspaceId : task.existingWorkspaceId;
    const existing = existingId ? await this.existingFor(paseo, request, task, existingId, project.projectRootPath) : null;
    if (existing === "busy") return;
    const branch = existing ? existing.branch : (continuesFrom?.branch ?? branchFor(request, task));
    // 이어 쓰는 작업은 이미 있는 worktree 를 쓴다. 그사이 기준 브랜치가 머지되고 지워졌어도 막지 않고 기록된 이름을 쓴다.
    // 막으면 다시 시작해도 같은 이유로 실패했다 (2026-11-26 전수 검사).
    const base = existing
      ? null
      : continuesFrom
        ? await this.baseFor(request, continuesFrom, values, project.projectRootPath).catch(() =>
            continuesFrom.baseBranch ? { branch: continuesFrom.baseBranch, refName: `origin/${continuesFrom.baseBranch}`, remote: true } : null,
          )
        : await this.baseFor(request, task, values, project.projectRootPath);
    // 두 번 배정되지 않게 워커를 만들기 전에 먼저 실행 중으로 표시한다. 저장하는 순간에 요청과 작업이 그대로인지 확인한다
    // (취소되거나 다시 계획됐으면 시작하지 않는다). 이후 기록은 이 브랜치로 표시한 작업에만 한다.
    const claimed = await this.store.update((state) => {
      const current = state.requests.find((item) => item.id === request.id);
      const target = current?.tasks.find((item) => item.number === task.number);
      if (current?.status !== "running" || target?.status !== "waiting") return { state, result: false };
      return {
        state: patch(state, request.id, task.number, {
          status: "running",
          branch,
          baseBranch: base?.branch ?? null,
          note: null,
          existingWorkspaceId: existingId ?? null,
          startCommit: existing ? existing.head : null,
        }),
        result: true,
      };
    });
    if (!claimed) return;
    const title = workspaceTitle(request.title ?? request.id, task);
    const workspace = existing
      ? paseo.workspaces.ref(existing.workspace.id)
      : continuesFrom?.workspaceId
      ? paseo.workspaces.ref(continuesFrom.workspaceId)
      : await paseo.workspaces.create({
          title,
          source: {
            kind: "worktree",
            cwd: project.projectRootPath,
            projectId: project.projectId,
            action: "branch-off",
            branchName: branch,
            // 비우면 데몬이 저장소 기본 브랜치의 로컬 ref 에서 딴다. 그 ref 가 낡았을 수 있어 항상 정해서 넘긴다.
            ...(base ? { refName: base.refName } : {}),
            worktreeSlug: branch.replace(/\//g, "-"),
          },
        });
    if (continuesFrom?.workspaceId && !existing) {
      // 이어 쓰는 워크스페이스는 지금 하는 작업이 보이도록 제목을 바꾼다. 사람의 워크스페이스 제목은 바꾸지 않는다.
      await workspace.setTitle(title).catch(() => undefined);
    }
    if (!(await this.patchClaimed(request.id, task.number, branch, { workspaceId: workspace.id }))) {
      if (!continuesFrom && !existing) await workspace.archive().catch(() => undefined);
      return;
    }
    const provider = values.worker.model.split("/")[0]!;
    const modes = (await paseo.providers.listModes(provider).catch(() => null))?.modes ?? [];
    const has = (id: string) => modes.some((mode) => mode.id === id);
    // 읽기 조사는 plan 모드라 파일을 바꿀 수 없다.
    // 변경 작업은 Auto 모드다 (2026-11-25 사용자 결정). acceptEdits 로 띄웠더니 읽기 전용 git 명령까지 사람에게 물었다.
    // Auto 가 허용한 명령은 플러그인에 오지 않으므로, 막아야 할 명령은 Claude 권한 규칙(ask/deny)으로 묻게 해야
    // 인박스에 올라온다 (RULES.md §9).
    const modeId =
      request.kind === "read" ? (has("plan") ? "plan" : undefined) : has("auto") ? "auto" : has("acceptEdits") ? "acceptEdits" : undefined;
    // 킥오프를 보내기 전에 세션이 /poteto-mode 를 실제로 불러왔는지 본다. 그래서 프롬프트 없이 먼저 만든다.
    const agent = await workspace.agents.create({
      config: {
        provider: values.worker.model,
        modeId,
        thinkingOptionId: values.worker.effort,
        options: preapprovedOptions(values.worker.model, [REPORT_BLOCKER_TOOL, REPORT_DONE_TOOL]),
      },
      // 사람의 워크스페이스에서는 다른 세션 사이에 섞이므로 어느 요청의 워커인지 제목에 남긴다.
      title: existing ? title : `${task.number} ${task.name}`,
      labels: {
        [ROLE_LABEL]: "worker",
        "paseo-coordinator.request": request.id,
        "paseo-coordinator.task": String(task.number),
      },
    });
    // 운영 작업은 코드를 바꾸지 않아 poteto 의 구현 흐름이 맞지 않는다.
    const poteto = values.poteto && task.kind !== "operation" ? await this.potetoFor(paseo, request, provider, agent.id) : { use: false, note: null };
    // 킥오프를 보내지 못하면 이 워커는 기록되지 않는다. 그대로 두면 아무도 모르는 세션이 남고(사람의 워크스페이스라면 그 안에),
    // 실제로는 전달됐다면 기록되지 않은 워커가 일한다. 정리하고 막힘으로 둔다 (2026-11-26 전수 검사).
    try {
      await paseo.agents.ref(agent.id).send(kickoff(request, task, branch, continuesFrom, poteto.use, base, existing?.workspace ?? null));
    } catch (error) {
      await paseo.agents.ref(agent.id).archive().catch(() => undefined);
      throw error;
    }
    // 킥오프를 보낸 뒤에 기록한다. 먼저 기록하면 보정 검사(reconcile)가 프롬프트 전의 쉬는 워커를 끝난 것으로 본다.
    // 그사이 요청이 취소됐거나 다시 계획됐으면 이 워커는 맡을 작업이 없다. 정리한다.
    if (!(await this.patchClaimed(request.id, task.number, branch, { agentId: agent.id, poteto: poteto.use, note: poteto.note }))) {
      await paseo.agents.ref(agent.id).archive().catch(() => undefined);
      return;
    }
    console.log(`[coordinator] started ${request.id} task ${task.number} as ${agent.id} on ${branch}${poteto.use ? " with /poteto-mode" : ""}`);
  }

  /**
   * 사람의 기존 워크스페이스를 확인한다. 쓸 수 없으면(닫혔거나 다른 프로젝트, 브랜치가 아님) 막힘이 되도록 던진다. 다른 에이전트가
   * 일하거나 커밋하지 않은 변경이 있으면 작업을 대기로 두고 이유를 카드에 적은 뒤 "busy" 를 돌려준다. 주기 검사가 다시 시도한다.
   * 읽기 조사는 아무것도 바꾸지 않으므로 기다리지 않는다.
   */
  private async existingFor(
    paseo: PaseoApi,
    request: CoordinatorRequest,
    task: Task,
    workspaceId: string,
    root: string,
  ): Promise<{ workspace: ExistingWorkspace; branch: string; head: string } | "busy"> {
    const [workspaces, state] = await Promise.all([listExistingWorkspaces(paseo, task.projectId), this.store.read()]);
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const problem = workspaceProblem(workspace, workspaceId, task.projectId, pluginWorkspaceIds(state));
    if (problem || !workspace) {
      throw new Error(
        say(
          request.language,
          `Cannot start in the chosen workspace: ${problem}. Open it in Paseo again and restart the task, or cancel it.`,
          `고른 워크스페이스에서 시작할 수 없어요: ${problem}. Paseo 에서 다시 연 뒤 작업을 다시 시작하거나 취소해 주세요.`,
        ),
      );
    }
    if (request.kind !== "read") {
      const busy = await busyReason(paseo, workspace, request.language, state, { requestId: request.id, taskNumber: task.number });
      if (busy) {
        if (task.note !== busy) await this.patchTask(request.id, task.number, { note: busy });
        return "busy";
      }
    }
    const checkout = await readCheckout(workspace.directory);
    if (!checkout.branch) {
      throw new Error(
        say(
          request.language,
          `${workspace.name} is not on a branch (detached HEAD). Check out a branch there and restart the task.`,
          `${workspace.name} 이 브랜치에 있지 않아요(detached HEAD). 브랜치를 checkout 한 뒤 작업을 다시 시작해 주세요.`,
        ),
      );
    }
    // 기본 브랜치는 워커 브랜치가 될 수 없다 (RULES.md §1). 사람이 새 요청 창에서 직접 고른 워크스페이스만 예외다. 코디네이터가 고른
    // 워크스페이스가 main 체크아웃이면 워커가 로컬 기본 브랜치에 바로 커밋했다 (2026-11-26 전수 검사).
    if (request.kind === "change" && task.kind === "code" && request.workspaces[task.projectId] !== workspaceId) {
      const defaultBranch = await remoteDefaultBranch(root).catch(() => null);
      if (defaultBranch && checkout.branch === defaultBranch) {
        throw new Error(
          say(
            request.language,
            `${workspace.name} is on the default branch ${defaultBranch}; workers do not commit on it. Choose that workspace yourself in the new request panel if this is intended, or cancel the task.`,
            `${workspace.name} 은 기본 브랜치 ${defaultBranch} 에 있어요. 워커는 기본 브랜치에 커밋하지 않아요. 의도한 것이면 새 요청 창에서 직접 그 워크스페이스를 고르고, 아니면 작업을 취소해 주세요.`,
          ),
        );
      }
    }
    return { workspace, branch: checkout.branch, head: checkout.head };
  }

  /**
   * 작업의 worktree 를 딸 기준 브랜치. 우선순위는 server/branches.ts 머리말과 같다. 작업의 baseBranch 에는 사람이 고른 것이나
   * 코디네이터가 적은 것이 이미 들어 있다. 정한 브랜치가 저장소에 없으면 막힘으로 두어 사람이 고치게 한다. 다른 브랜치로
   * 몰래 바꾸면 워커가 엉뚱한 코드 위에서 일한다.
   */
  private async baseFor(
    request: CoordinatorRequest,
    task: Task,
    values: Awaited<ReturnType<typeof readSettings>>,
    root: string,
  ): Promise<BaseRef | null> {
    const chosen = task.baseBranch ?? request.baseBranches[task.projectId] ?? values.baseBranches[task.projectId] ?? null;
    const name = chosen ?? (await remoteDefaultBranch(root));
    if (!name) return null;
    const base = await resolveBaseRef(root, name);
    if (!base) {
      throw new Error(
        say(
          request.language,
          `Base branch ${name} does not exist in project ${task.projectId}. Restore that branch and retry, or cancel the request.`,
          `기준 브랜치 ${name} 가 프로젝트 ${task.projectId} 에 없어요. 그 브랜치를 되살린 뒤 다시 시작하거나 요청을 취소해 주세요.`,
        ),
      );
    }
    return base;
  }

  /**
   * /poteto-mode 를 쓸지 (RULES.md §11). A·B·C 등급 변경 작업의 Claude 워커만 쓴다. D 는 하위 에이전트 비용이 작업보다 크다.
   * 읽기 조사는 쓰지 않는다: 플러그인이 A 등급 조사와 일반 읽기 요청을 구분할 수 없고, plan 모드라 poteto 흐름이 맞지 않는다.
   * pstack 이 설치되지 않았으면 쓰지 않고 이유를 작업 메모에 남긴다.
   */
  private async potetoFor(
    paseo: PaseoApi,
    request: CoordinatorRequest,
    provider: string,
    agentId: string,
  ): Promise<{ use: boolean; note: string | null }> {
    if (request.kind !== "change" || !request.grade || request.grade === "D" || provider !== "claude") return { use: false, note: null };
    const result = await paseo.agents.ref(agentId).commands().catch((error: unknown) => ({
      commands: [] as { name: string }[],
      error: error instanceof Error ? error.message : String(error),
    }));
    if (result.commands.some((command) => /(^|:)poteto-mode$/.test(command.name.replace(/^\//, "")))) return { use: true, note: null };
    const reason = result.error ?? say(request.language, "pstack is not loaded in the worker session", "워커 세션에 pstack 이 없어요");
    return { use: false, note: say(request.language, `Started without /poteto-mode: ${reason}.`, `/poteto-mode 없이 시작했어요: ${reason}.`) };
  }

  /**
   * 사람이 작업을 취소한 뒤. 취소된 작업의 워커를 멈추고, 남은 작업이 모두 끝났으면 요청을 마무리한다
   * (읽기 요청은 답변을 모으고, 변경 요청은 끝낸다).
   */
  async afterCancel(paseo: PaseoApi, requestId: string, agentIds: readonly string[]): Promise<void> {
    for (const agentId of agentIds) await paseo.agents.ref(agentId).archive().catch(() => undefined);
    await this.settleRequest(paseo, requestId);
  }

  /** 실행 중인 모든 요청을 마무리할 수 있으면 마무리한다. 코디네이터의 턴 종료 hook 이 유실돼도 주기 검사가 이어 간다. */
  async settleAll(paseo: PaseoApi): Promise<void> {
    const running = (await this.store.read()).requests.filter((request) => request.status === "running").map((request) => request.id);
    for (const id of running) await this.settleRequest(paseo, id);
  }

  /**
   * 요청의 작업이 모두 끝났으면 요청을 마무리한다. 읽기 요청은 보고를 모으고, 변경 요청은 끝낸다.
   * 코디네이터의 턴이 끝난 뒤에도 부른다. 열린 질문 때문에 미뤘던 마무리를 사람이 답하고 코디네이터가 처리한 뒤 이어 간다.
   */
  async settleRequest(paseo: PaseoApi, requestId: string): Promise<void> {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    if (!request || request.status !== "running" || request.tasks.length === 0) return;
    if (request.kind === "read") await this.compileAnswer(paseo, requestId);
    else if (await finishRequestIfDone(this.store, requestId)) this.onRequestDone(paseo, requestId);
  }

  /**
   * 읽기 조사가 모두 끝났으면 워커들의 마지막 보고를 모은다. 보통은 답변 카드가 된다. 다음 경우에는 답변 카드로 끝내지 않고
   * 코디네이터에게 돌려준다. 답변 카드의 확인은 요청을 끝내므로, 사람이 바란 변경이 조용히 사라진다 (r13~r15, 2026-11-26).
   * - 변경 전 조사(beforeChange): 코디네이터가 이 보고로 질문 카드를 만들거나 바로 계획한다 (RULES.md §2.0).
   * - 조사가 도는 동안 사람이 지시를 보냈다: 그 지시(예: '끝나면 그대로 지워줘')를 코디네이터가 처리해야 한다.
   * 코디네이터의 질문 카드가 열려 있으면 그 답을 기다린다(needs_input). 답변 카드로 바꾸면 질문 카드가 사라진다.
   */
  private async compileAnswer(paseo: PaseoApi, requestId: string): Promise<void> {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    if (!request || request.status !== "running" || !request.tasks.every((task) => task.status === "done" || task.status === "canceled")) return;
    const sections: string[] = [];
    for (const task of request.tasks) {
      // 취소한 조사는 답에 없다는 것을 밝힌다. 빠뜨리면 그 프로젝트도 조사한 것처럼 읽힌다.
      if (task.status === "canceled") {
        sections.push(`## ${task.number} ${task.name}\n\n(canceled by the human; not investigated)`);
        continue;
      }
      if (!task.agentId) continue;
      const page = await paseo.agents.ref(task.agentId).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => null);
      const entries = (page as { entries?: readonly { item?: { type?: string; text?: string } }[] } | null)?.entries ?? [];
      const last = [...entries].reverse().find((entry) => entry.item?.type === "assistant_message" && entry.item.text?.trim());
      sections.push(`## ${task.number} ${task.name}\n\n${last?.item?.text?.trim() ?? "(no report)"}`);
    }
    const at = new Date().toISOString();
    const text = sections.join("\n\n");
    // 워커들의 타임라인을 읽는 사이에 요청이 취소되거나 바뀌었을 수 있다. 저장하는 순간에 다시 본다.
    const outcome = await this.store.update((state) => {
      const current = state.requests.find((item) => item.id === requestId);
      if (current?.status !== "running" || current.kind !== "read") return { state, result: null };
      // 조사가 도는 동안 사람이 보낸 것은 지시든 질문의 답이든 코디네이터가 처리해야 한다 ('예, 끝나면 지워줘' 같은 답도 있다).
      // 계획 시각이 없는 옛 기록은 계획 뒤의 피드백을 알 수 없어 예전처럼 답변으로 만든다.
      const instructed = Boolean(current.plannedAt) && current.feedback.some((item) => item.at > current.plannedAt!);
      const toCoordinator = current.beforeChange || instructed;
      const next = toCoordinator
        ? { ...current, status: current.question ? ("needs_input" as const) : ("planning" as const), investigation: { text, at } }
        : {
            ...current,
            status: current.question ? ("needs_input" as const) : ("answered" as const),
            answer: {
              text,
              sources: current.tasks.filter((task) => task.status !== "canceled").map((task) => `${task.number} ${task.name}`),
              // 코디네이터가 계획에 적은 해석과 가정을 답에 옮긴다. '실행은 후속 지시가 필요' 같은 경고가 사람에게 보여야 한다
              // (r13·r14 는 이 경고가 답변 카드에 없어 확인만 누르고 끝났다).
              unknowns: current.unknowns,
              projectIds: [...new Set(current.tasks.map((task) => task.projectId))],
              at,
            },
          };
      return {
        state: { ...state, requests: state.requests.map((item) => (item.id === requestId ? next : item)) },
        result: toCoordinator ? "coordinator" : "answer",
      };
    });
    if (outcome === "coordinator") this.onCoordinatorWork(paseo, requestId);
  }

  /** 요청이 실행 중이고 작업이 아직 이 브랜치로 표시돼 있을 때만 기록한다. 기록했으면 true. */
  private patchClaimed(requestId: string, number: number, branch: string, change: TaskPatch): Promise<boolean> {
    return this.store.update((state) => {
      const current = state.requests.find((item) => item.id === requestId);
      const target = current?.tasks.find((item) => item.number === number);
      if (current?.status !== "running" || target?.status !== "running" || target.branch !== branch) return { state, result: false };
      return { state: patch(state, requestId, number, change), result: true };
    });
  }

  /**
   * 작업 상태를 쓴다. 요청이 실행 중이고 작업이 취소되거나 끝나지 않았을 때만 쓴다. 워커의 턴 처리는 작업을 읽은 뒤 워커 조회를
   * await 하는데, 그사이 취소된 작업을 review 나 blocked 로 덮어써 취소한 작업에 머지 카드가 떴다 (2026-11-26 전수 검사).
   */
  private patchTask(requestId: string, number: number, patch: TaskPatch): Promise<void> {
    return this.store.update((state) => {
      const target = state.requests.find((request) => request.id === requestId);
      const task = target?.tasks.find((item) => item.number === number);
      if (target?.status !== "running" || !task || task.status === "canceled" || task.status === "done") return { state, result: undefined };
      return {
        state: {
          ...state,
          requests: state.requests.map((request) =>
            request.id === requestId
              ? { ...request, tasks: request.tasks.map((item) => (item.number === number ? { ...item, ...patch } : item)) }
              : request,
          ),
        },
        result: undefined,
      };
    });
  }
}
