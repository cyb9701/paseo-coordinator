/// <reference types="node" />

import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import type { CoordinatorRequest, Task } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import { continuedBy, finishRequestIfDone } from "./completion";
import { workspaceTitle } from "./coordinator";
import type { StateStore } from "./store";
import type { WorkerChannel } from "./worker-channel";

type Settings = PluginSettings<typeof settingsSchema>;
type TaskPatch = Partial<Pick<Task, "status" | "workspaceId" | "agentId" | "branch" | "note" | "poteto" | "doneNudgedAt">>;

/** 이 라벨로 워커를 알아본다. 코디네이터 라벨과 같은 키를 쓴다. */
const ROLE_LABEL = "paseo-coordinator.role";

// 선행 작업이 이 상태면 다음 작업을 시작한다. review 는 워커가 일을 마치고 사람의 확인만 남은 상태다.
const FINISHED: ReadonlySet<Task["status"]> = new Set(["done", "review"]);

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
function potetoOverride(grade: CoordinatorRequest["grade"], branch: string): string[] {
  return [
    "",
    `This kickoff overrides worker.md as follows. Your working branch is ${branch}. Go as far as pushing this branch and opening a pull request from it. Do not merge pull requests (including stacked ones or auto-merge), push to any other branch, write to any database in any environment, deploy, send external messages, write outside this worktree, or access secret files. If you need any of those, report it with the report_blocker tool and stop. Make reversible implementation choices yourself and list what you chose and why in report_done.`,
    ...(grade === "B"
      ? ["If you must choose a data structure, a public API or a library, do not choose: report the options and your recommendation with report_blocker."]
      : []),
  ];
}

/**
 * 워커 첫 프롬프트. 플러그인이 보내므로 Paseo 가 감싸지 않는다 (RULES.md §13). A·B·C 등급 Claude 워커는 /poteto-mode 로 시작한다.
 * 금지 사항은 RULES.md H2 와 같다. 명령 단위 차단은 Claude auto 모드와 사용자 권한 규칙(ask: gh pr merge 등)이 맡는다.
 */
function kickoff(request: CoordinatorRequest, task: Task, branch: string, continuesFrom: Task | null, poteto: boolean): string {
  const readOnly = request.kind === "read";
  const others = request.tasks
    .filter((other) => other.number !== task.number)
    .map((other) => `- ${other.number} ${other.name}${other.dependsOn.length ? ` (after ${other.dependsOn.join(", ")})` : ""}`);
  const language = request.language === "ko" ? "Korean" : "English";
  const successor = readOnly ? null : continuedBy(request, task);
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
    `- Work only inside this worktree, on branch ${branch}. Do not read or change other worktrees.`,
    ...(continuesFrom
      ? [
          `- Task ${continuesFrom.number} (${continuesFrom.name}) ran before you in this same worktree. Its changes, committed or not, are already here; build on them.`,
        ]
      : []),
    readOnly
      ? "- This is a read-only investigation. Do not change, create or delete any file. Investigate and report."
      : successor
        ? `- You may edit files here, run local builds, tests and linters, and commit. Do not push or open a pull request: task ${successor.number} (${successor.name}) continues in this worktree and opens it.`
        : "- You may edit files here, run local builds, tests and linters, commit, push this branch, and open a pull request from it against the default branch.",
    "- Never merge pull requests, push to any other branch, force push, write to any database (any environment), deploy, send messages to people, or read or write secret files (.env, keys, credentials).",
    "- If you need a decision the request and scope do not settle, a change to your scope or approach, or you are stuck, call the report_blocker tool with the facts, the options and your recommendation, then end your turn and wait. Do not ask in plain text: only report_blocker reaches the human as a decision card.",
    readOnly
      ? `- Finish with a short report in ${language}: what you found, where you found it, and what is left unknown.`
      : `- When the task is done and verified${successor ? " and committed" : ", pushed, with the pull request open"}, call the report_done tool as your last action, written in ${language}. Done means your verification passed${successor ? "" : " and the pull request exists"}. Never merge it: the human merges from a card. If the human's request says not to commit, push or open a pull request, follow the request and quote it as noPullRequestReason in report_done.`,
    ...(poteto ? potetoOverride(request.grade, branch) : []),
  ].join("\n");
}

/**
 * 시작된 요청의 작업을 워커로 만든다 (PLAN.md 3e). 선행 작업이 끝난 대기 작업만, 의존 순서대로 배정한다.
 * 한 번에 한 흐름만 돌도록 묶고, 도는 동안 또 불리면 끝난 뒤 한 번 더 돈다.
 */
export class Dispatcher {
  private running = false;
  private again = false;

  constructor(
    private readonly store: StateStore,
    private readonly settings: Settings,
    private readonly channel: WorkerChannel,
    private readonly onRequestDone: (paseo: PaseoApi, requestId: string) => void,
  ) {}

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
  async onWorkerTurn(
    paseo: PaseoApi,
    agentId: string,
    outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string },
    /** 보정 검사에서 부를 때는 false. 배정은 이미 돌고 있는 흐름이 이어서 한다. */
    dispatchNext = true,
  ): Promise<void> {
    const found = await this.findWorker(agentId);
    if (!found || found.request.status !== "running") return;
    const { request, task } = found;
    // 턴 사이에 쌓인 메시지(코디네이터 지시, 사람의 결정)가 있으면 먼저 보낸다. 워커가 이어서 일하므로 상태는 그대로다.
    if (await this.channel.flush(paseo, request.id, task.number)) return;
    // report_blocker 로 보고하고 멈춘 워커는 결정을 기다리는 중이다. 끝난 것으로 보지 않는다.
    if (task.blocker) return;
    if (outcome.kind === "failed") {
      await this.patchTask(request.id, task.number, { status: "blocked", note: outcome.error.message });
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
      await this.patchTask(request.id, task.number, { status: continuedBy(request, task) ? "done" : "review", note: null });
      return true;
    }
    if (!task.doneNudgedAt) {
      await this.patchTask(request.id, task.number, { doneNudgedAt: new Date().toISOString() });
      await this.channel.deliver(
        paseo,
        request.id,
        task.number,
        "[From the coordinator plugin] Your turn ended without report_done. If the task is finished and verified, call report_done now (after pushing and opening the pull request if you are the last task on the branch, unless the human's request says not to: then quote it as noPullRequestReason). If you are blocked, call report_blocker instead.",
      );
      return false;
    }
    await this.patchTask(request.id, task.number, { status: "blocked", note: "The worker ended twice without report_done. Open the worker to see where it stopped." });
    return true;
  }

  /**
   * hook 이 유실돼도 상태가 맞게, 실행 중으로 표시된 작업의 워커를 직접 확인한다. 알림형 hook 은 best-effort 라
   * 다시 오지 않는다 (2026-11-25: 사람의 결정을 받고 일을 마친 워커의 턴 종료가 오지 않아 작업이 running 에 멈췄다).
   * 워커가 쉬고 있으면 턴이 끝난 것으로, 에러면 막힌 것으로 처리한다.
   */
  private async reconcile(paseo: PaseoApi): Promise<void> {
    const state = await this.store.read();
    for (const request of state.requests) {
      if (request.status !== "running") continue;
      for (const task of request.tasks) {
        if (task.status !== "running" || !task.agentId || task.blocker || task.outbox.length > 0) continue;
        const snapshot = await paseo.agents.ref(task.agentId).refresh().catch(() => null);
        if (!snapshot) continue;
        const agent = snapshot.agent;
        if ((agent.pendingPermissions?.length ?? 0) > 0) continue;
        if (agent.status === "idle") {
          await this.onWorkerTurn(paseo, task.agentId, { kind: "completed" }, false);
        } else if (agent.status === "error") {
          await this.onWorkerTurn(paseo, task.agentId, { kind: "failed", error: { message: agent.lastError ?? "Worker stopped with an error." } }, false);
        }
      }
    }
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
        if (task.dependsOn.every((number) => FINISHED.has(byNumber.get(number)?.status ?? "waiting"))) {
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
      throw new Error(`Project ${task.projectId} is no longer allowed in coordinator settings.`);
    }
    const project = projects.find((item) => item.projectId === task.projectId);
    if (!project) throw new Error(`Project ${task.projectId} is not registered on this host.`);
    // 같은 프로젝트의 앞 작업에 이어지는 작업은 그 작업의 worktree 와 브랜치를 이어서 쓴다. 따로 worktree 를 만들면
    // 앞 작업의 (커밋하지 않은) 결과가 보이지 않아, 워커가 다른 worktree 를 뒤져 읽었다 (2026-11-25 r6 테스트).
    const continuesFrom =
      request.tasks
        .filter((other) => task.dependsOn.includes(other.number) && other.projectId === task.projectId && other.workspaceId)
        .sort((a, b) => b.number - a.number)[0] ?? null;
    const branch = continuesFrom?.branch ?? branchFor(request, task);
    // 두 번 배정되지 않게 워커를 만들기 전에 먼저 실행 중으로 표시한다.
    await this.patchTask(request.id, task.number, { status: "running", branch, note: null });
    const title = workspaceTitle(request.title ?? request.id, task);
    const workspace = continuesFrom?.workspaceId
      ? paseo.workspaces.ref(continuesFrom.workspaceId)
      : await paseo.workspaces.create({
          title,
          source: {
            kind: "worktree",
            cwd: project.projectRootPath,
            projectId: project.projectId,
            action: "branch-off",
            branchName: branch,
            worktreeSlug: branch.replace(/\//g, "-"),
          },
        });
    if (continuesFrom?.workspaceId) {
      // 이어 쓰는 워크스페이스는 지금 하는 작업이 보이도록 제목을 바꾼다.
      await workspace.setTitle(title).catch(() => undefined);
    }
    await this.patchTask(request.id, task.number, { workspaceId: workspace.id });
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
      config: { provider: values.worker.model, modeId, thinkingOptionId: values.worker.effort },
      title: `${task.number} ${task.name}`,
      labels: {
        [ROLE_LABEL]: "worker",
        "paseo-coordinator.request": request.id,
        "paseo-coordinator.task": String(task.number),
      },
    });
    const poteto = values.poteto ? await this.potetoFor(paseo, request, provider, agent.id) : { use: false, note: null };
    await paseo.agents.ref(agent.id).send(kickoff(request, task, branch, continuesFrom, poteto.use));
    // 킥오프를 보낸 뒤에 기록한다. 먼저 기록하면 보정 검사(reconcile)가 프롬프트 전의 쉬는 워커를 끝난 것으로 본다.
    await this.patchTask(request.id, task.number, { agentId: agent.id, poteto: poteto.use, note: poteto.note });
    console.log(`[coordinator] started ${request.id} task ${task.number} as ${agent.id} on ${branch}${poteto.use ? " with /poteto-mode" : ""}`);
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
    return { use: false, note: `Started without /poteto-mode: ${result.error ?? "pstack is not loaded in the worker session"}.` };
  }

  /** 읽기 조사가 모두 끝났으면 워커들의 마지막 보고를 모아 답변으로 만든다. */
  private async compileAnswer(paseo: PaseoApi, requestId: string): Promise<void> {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    if (!request || request.status !== "running" || !request.tasks.every((task) => task.status === "done")) return;
    const sections: string[] = [];
    for (const task of request.tasks) {
      if (!task.agentId) continue;
      const page = await paseo.agents.ref(task.agentId).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => null);
      const entries = (page as { entries?: readonly { item?: { type?: string; text?: string } }[] } | null)?.entries ?? [];
      const last = [...entries].reverse().find((entry) => entry.item?.type === "assistant_message" && entry.item.text?.trim());
      sections.push(`## ${task.number} ${task.name}\n\n${last?.item?.text?.trim() ?? "(no report)"}`);
    }
    const at = new Date().toISOString();
    await this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === requestId
            ? {
                ...item,
                status: "answered" as const,
                answer: {
                  text: sections.join("\n\n"),
                  sources: request.tasks.map((task) => `${task.number} ${task.name}`),
                  unknowns: [],
                  projectIds: [...new Set(request.tasks.map((task) => task.projectId))],
                  at,
                },
              }
            : item,
        ),
      },
      result: undefined,
    }));
  }

  private patchTask(requestId: string, number: number, patch: TaskPatch): Promise<void> {
    return this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id === requestId
            ? { ...request, tasks: request.tasks.map((task) => (task.number === number ? { ...task, ...patch } : task)) }
            : request,
        ),
      },
      result: undefined,
    }));
  }
}
