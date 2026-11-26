/// <reference types="node" />

import { existsSync } from "node:fs";
import type { PaseoApi } from "./paseo-api";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type CoordinatorRequest, type Task, chainEndingAt, continuedBy, unreadInstructionAt } from "../shared/model";
import { answeredQa } from "./requests";
import type { StateStore } from "./store";
import { type WorkerChannel, queued } from "./worker-channel";
import { run } from "./run";
import { say } from "./say";

export const REPORT_DONE_TOOL = "report_done";

type PullRequest = NonNullable<NonNullable<Task["completion"]>["pr"]>;

const PR_FIELDS =
  "number,url,title,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,additions,deletions,changedFiles,mergeable,statusCheckRollup";

type RawPr = Omit<PullRequest, "checks" | "readAt" | "headRefOid" | "headRepository"> & {
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[] | null;
  headRefOid?: string | null;
  headRepository?: { name?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
};

function toPullRequest(raw: RawPr): PullRequest {
  const rollup = raw.statusCheckRollup ?? [];
  // CheckRun 은 status/conclusion, StatusContext 는 state 로 결과를 준다.
  const outcome = (item: (typeof rollup)[number]) => {
    const value = (item.conclusion || item.state || "").toUpperCase();
    if (item.status && item.status !== "COMPLETED") return "pending";
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(value)) return "passed";
    if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", ""].includes(value)) return "pending";
    return "failed";
  };
  const counts = { passed: 0, failed: 0, pending: 0 };
  for (const item of rollup) counts[outcome(item)] += 1;
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: raw.state,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    additions: raw.additions,
    deletions: raw.deletions,
    changedFiles: raw.changedFiles,
    mergeable: raw.mergeable,
    checks: rollup.length ? `passed ${counts.passed}, failed ${counts.failed}, pending ${counts.pending}` : null,
    readAt: new Date().toISOString(),
    headRefOid: raw.headRefOid ?? null,
    headRepository: raw.headRepositoryOwner?.login && raw.headRepository?.name ? `${raw.headRepositoryOwner.login}/${raw.headRepository.name}` : null,
  };
}

/** 브랜치에서 연 PR 을 gh 로 찾는다. 워커가 준 URL 을 믿지 않고, 플러그인이 정한 작업 브랜치로 찾는다. */
async function findPullRequest(cwd: string, branch: string): Promise<PullRequest | null> {
  const out = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", PR_FIELDS, "--limit", "1"], cwd);
  const [raw] = JSON.parse(out) as RawPr[];
  return raw ? toPullRequest(raw) : null;
}

/**
 * 커밋하지 않은 변경. Paseo 가 worktree 를 만들 때 남기는 빈 paseo.json(내용 '{}')은 워커의 변경이 아니라 뺀다.
 * 빼지 않았을 때 r15 의 정리 작업 두 개가 'PR 에 없는 변경'으로 판정돼 워크스페이스가 남았고, PR 이 있는 작업이면 워커가
 * 무관한 파일을 커밋하도록 떠밀렸다 (2026-11-26 전수 검사).
 */
export async function uncommittedChanges(cwd: string): Promise<string | null> {
  // 저장소 설정 status.showUntrackedFiles=no 면 새 파일이 보이지 않아, 정리하면서 그 파일이 사라졌다 (2026-11-26 전수 검사).
  const lines = (await run("git", ["status", "--porcelain", "--untracked-files=normal"], cwd))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && line !== "?? paseo.json");
  return lines.length ? `uncommitted changes:\n${lines.slice(0, 10).join("\n")}` : null;
}

/**
 * 로컬 브랜치를 지운다. 그 브랜치의 커밋이 모두 어떤 원격 브랜치에 있을 때만 지운다. 원격에 없는 커밋이 있으면 지우지 않고
 * 사람이 볼 수 있게 남긴다. 지웠으면 true.
 */
export async function deleteBranchIfPublished(root: string, branch: string): Promise<boolean> {
  const exists = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root).then(() => true, () => false);
  if (!exists) return false;
  const unpushed = Number((await run("git", ["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"], root).catch(() => "1")).trim());
  if (unpushed > 0) return false;
  return run("git", ["branch", "-D", branch], root).then(
    () => true,
    (error: unknown) => (console.error(`[coordinator] could not delete local branch ${branch}`, error), false),
  );
}

/**
 * worktree 가 PR 에 담긴 것과 같은지. 커밋하지 않은 변경이 있거나 HEAD 가 PR 의 마지막 커밋과 다르면 그 차이를 돌려준다.
 * PR 이 있어도 워커가 고친 뒤 push 하지 않았을 수 있다. 그대로 머지하면 고치기 전 PR 이 들어가고, 정리하면서 그 커밋이 사라진다.
 */
async function differsFromPr(cwd: string, url: string): Promise<string | null> {
  const dirty = await uncommittedChanges(cwd);
  if (dirty) return dirty;
  const head = (await run("git", ["rev-parse", "HEAD"], cwd)).trim();
  const prHead = (JSON.parse(await run("gh", ["pr", "view", url, "--json", "headRefOid"], cwd)) as { headRefOid: string }).headRefOid;
  return head === prHead ? null : `local HEAD ${head.slice(0, 7)} is not the pull request head ${prHead.slice(0, 7)} (not pushed?)`;
}

async function readPullRequest(cwd: string, url: string): Promise<PullRequest> {
  return toPullRequest(JSON.parse(await run("gh", ["pr", "view", url, "--json", PR_FIELDS], cwd)) as RawPr);
}

const refExists = (cwd: string, ref: string) => run("git", ["rev-parse", "--verify", "--quiet", ref], cwd).then(() => true, () => false);

/**
 * worktree 에 PR 에 담기지 않은 변경이 남았는지. 커밋하지 않은 파일, 또는 기준 브랜치에 없는 커밋.
 * PR 없이 '끝났다'고 보고한 워커가 정말 바꾼 것이 없는지 확인할 때 쓴다.
 * 기준 브랜치(원격과 로컬)에서부터 센다. 예전처럼 '어느 원격에든 있으면 게시됨'으로 세면, 워커가 다른 원격 브랜치로 push 하고
 * PR 을 열지 않은 작업이 '바뀐 것 없음'이 되어 확인 한 번에 worktree 와 함께 정리됐다 (2026-11-26 전수 검사).
 */
async function unpublishedWork(cwd: string, branch: string, baseBranch: string | null): Promise<string | null> {
  const dirty = await uncommittedChanges(cwd);
  if (dirty) return dirty;
  // 기준 브랜치가 로컬에만 있으면 그 커밋은 워커가 만든 것이 아니다. 빼야 워커의 커밋만 센다.
  const bases = baseBranch
    ? (
        await Promise.all(
          [`refs/remotes/origin/${baseBranch}`, `refs/heads/${baseBranch}`].map(async (ref) => ((await refExists(cwd, ref)) ? ref : null)),
        )
      ).filter((ref): ref is string => ref !== null)
    : [];
  const ahead = Number(
    (
      await run(
        "git",
        // 기준을 모르는 예전 기록은 원격 어딘가에 있는 커밋을 게시된 것으로 본다. --exclude 는 refs/remotes/ 를 뺀 이름으로 써야 걸린다.
        bases.length ? ["rev-list", "--count", "HEAD", "--not", ...bases] : ["rev-list", "--count", "HEAD", "--not", `--exclude=origin/${branch}`, "--remotes"],
        cwd,
      )
    ).trim(),
  );
  return ahead > 0 ? `${ahead} commit(s) on ${branch} that no pull request carries` : null;
}

/** ancestor 가 descendant 의 조상(또는 같은 커밋)인지. 커밋이 없거나 확인하지 못하면 false. */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return run("git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd).then(
    () => true,
    () => false,
  );
}

/** 지금 checkout 된 브랜치. detached HEAD 면 null. */
async function currentBranch(cwd: string): Promise<string | null> {
  return run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd).then(
    (out) => out.trim() || null,
    () => null,
  );
}

export { continuedBy };

function patchTask(
  state: { requests: CoordinatorRequest[] },
  requestId: string,
  numbers: readonly number[],
  patch: (task: Task) => Task,
): CoordinatorRequest[] {
  return state.requests.map((request) =>
    request.id !== requestId
      ? request
      : { ...request, tasks: request.tasks.map((task) => (numbers.includes(task.number) ? patch(task) : task)) },
  );
}

/**
 * 모든 작업이 끝났거나 사람이 취소했으면 요청을 끝낸다. 끝냈으면 true. 모두 취소된 요청은 cancelTask 가 취소로 둔다.
 * 코디네이터의 질문 카드가 열려 있으면 끝내지 않는다. 끝내면 카드가 답도 기록도 없이 사라지고 코디네이터도 정리된다
 * (2026-11-26 전수 검사). 답이 오면 코디네이터가 처리하고, 그 턴이 끝난 뒤 다시 이 검사를 한다 (index.server.ts).
 */
export async function finishRequestIfDone(store: StateStore, requestId: string): Promise<boolean> {
  return store.update((state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request || request.status !== "running" || request.kind !== "change" || request.question) return { state, result: false };
    if (!request.tasks.every((task) => task.status === "done" || task.status === "canceled")) return { state, result: false };
    // 코디네이터가 아직 읽지 않은 사람의 지시가 있으면 끝내지 않는다. 그 지시로 작업이 더해질 수 있다.
    if (unreadInstructionAt(request)) return { state, result: false };
    return {
      state: { ...state, requests: state.requests.map((item) => (item.id === requestId ? { ...item, status: "done" as const } : item)) },
      result: true,
    };
  });
}

export const reportDoneInput = z.object({
  summary: z.string().trim().min(1),
  verification: z.array(z.string().trim().min(1)).min(1),
  choices: z.array(z.object({ choice: z.string().trim().min(1), why: z.string().trim().min(1) })).default([]),
  left: z.array(z.string().trim().min(1)).default([]),
  noPullRequestReason: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .default(null)
    .describe(
      "When the human's request says not to commit, push or open a pull request, quote that sentence of the request word for word. When your kickoff says the base branch is local only, say so.",
    ),
});

/** 따옴표와 공백 차이를 무시하고 비교한다. 워커가 인용 부호를 붙이거나 줄바꿈을 바꿔도 같은 문장으로 본다. */
function normalizeQuote(text: string): string {
  return text.replace(/["'“”‘’「」『』`]/g, "").replace(/\s+/g, " ").trim();
}

/** 워커가 든 이유가 사람의 요청(원문이나 추가 지시)에 그대로 있는 문장인지. */
export function quotesRequest(request: Pick<CoordinatorRequest, "text" | "feedback" | "doneCriteria">, quote: string): boolean {
  const needle = normalizeQuote(quote);
  if (needle.length < 2) return false;
  const sources = [request.text, request.doneCriteria ?? "", ...request.feedback.map((item) => item.text)].map(normalizeQuote);
  return sources.some((source) => source.includes(needle));
}

async function baseIsLocalOnly(cwd: string, baseBranch: string | null): Promise<boolean> {
  if (!baseBranch) return false;
  const local = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`], cwd).then(() => true, () => false);
  const remote = await run("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], cwd).then(() => true, () => false);
  return local && !remote;
}

/**
 * 완료 보고를 검사하고 기록한다. report_done 도구와, 도구 호출이 실패했을 때 타임라인의 입력으로 다시 처리하는 길
 * (Dispatcher.settleChange) 이 같이 쓴다. 기록하지 못하면 isError 와 워커에게 줄 이유를 돌려준다.
 */
export async function recordCompletion(
  store: StateStore,
  agent: { id: string; cwd: string },
  input: z.infer<typeof reportDoneInput>,
): Promise<{ text: string; isError?: boolean }> {
  const state = await store.read();
  const request = state.requests.find((item) => item.tasks.some((task) => task.agentId === agent.id));
  const task = request?.tasks.find((item) => item.agentId === agent.id);
  if (!request || !task) return { text: "You are not a coordinator worker; nothing was reported.", isError: true };
  if (request.kind === "read") {
    return { text: "This is a read-only investigation: end with your report as plain text instead.", isError: true };
  }
  // 취소됐거나 끝난 작업의 워커가 늦게 보낸 보고다. 받으면 취소한 작업에 머지 카드가 뜬다 (2026-11-26 전수 검사).
  if (request.status !== "running" || (task.status !== "running" && task.status !== "blocked")) {
    return { text: `This task is ${task.status === "running" ? "no longer active" : task.status}; nothing was reported. End your turn.`, isError: true };
  }
  if (!task.branch) return { text: "This task has no branch recorded; report it with report_blocker.", isError: true };
  let pr: PullRequest | null = null;
  let unpublished: string | null = null;
  let noPrSource: NonNullable<Task["completion"]>["noPrSource"] = null;
  let noPrReason: string | null = null;
  try {
    if (task.kind === "operation") {
      // 운영 작업은 worktree 의 파일을 바꾸지 않는다. worktree 밖 대상(다른 브랜치 checkout 포함)은 커밋 수로 판정하지 않는다.
      const dirty = await uncommittedChanges(agent.cwd);
      if (dirty) {
        // 사람의 워크스페이스에서는 그 변경이 사람의 것일 수 있다. 무조건 되돌리라고 하면 사람의 일을 지운다.
        return {
          text: task.existingWorkspaceId
            ? `This is an operation task, but files in this workspace changed (${dirty}). If you changed them, undo only your own changes. If you did not, leave them as they are and report it with report_blocker.`
            : `This is an operation task, but files in this worktree changed (${dirty}). Undo those changes, or report with report_blocker if they are needed.`,
          isError: true,
        };
      }
      noPrSource = "operation";
      noPrReason = input.noPullRequestReason;
    } else if (task.existingWorkspaceId) {
      // 사람의 기존 워크스페이스: 커밋까지만 한다 (2026-11-26 사용자 결정). push 와 PR 은 사람이 자기 방식대로 한다.
      const dirty = await uncommittedChanges(agent.cwd);
      if (dirty) {
        return {
          text: `Commit your changes on ${task.branch} before reporting (${dirty}). If some of them are not yours, do not commit, undo or stash them: report it with report_blocker.`,
          isError: true,
        };
      }
      const current = await currentBranch(agent.cwd);
      if (current !== task.branch) {
        return {
          text: `This workspace is on ${current ?? "a detached HEAD"}, not ${task.branch}. Do not switch branches in the human's workspace; report it with report_blocker.`,
          isError: true,
        };
      }
      // 시작할 때의 HEAD 가 지금 HEAD 의 조상이 아니면 reset·rebase·amend 로 사람의 기록이 바뀐 것이다. '바뀐 것 없음'으로 받으면
      // 사람의 커밋이 사라진 것을 아무도 모른다 (2026-11-26 전수 검사).
      if (task.startCommit && !(await isAncestor(agent.cwd, task.startCommit, "HEAD"))) {
        return {
          text: `The history of ${task.branch} changed under you: ${task.startCommit.slice(0, 7)}, where you started, is no longer in it (reset, rebase or amend). Do not rewrite the human's commits; report it with report_blocker.`,
          isError: true,
        };
      }
      if (!continuedBy(request, task)) {
        // 같은 워크스페이스를 이어 쓴 앞 작업들의 커밋도 이 카드가 보여 준다. 이 사슬에서 가장 먼저 시작한 작업의 HEAD 부터 센다.
        // 워크스페이스 단위로 세면 이전 요청의 작업이나 사람의 커밋까지 이 작업의 커밋으로 보였다.
        const start = chainEndingAt(request, task)
          .filter((item) => item.startCommit)
          .sort((a, b) => a.number - b.number)[0]?.startCommit;
        const commits = start ? Number((await run("git", ["rev-list", "--count", `${start}..HEAD`], agent.cwd)).trim()) : 0;
        noPrSource = commits > 0 ? "existingWorkspace" : "noChanges";
      }
    } else if ((await currentBranch(agent.cwd)) !== task.branch) {
      // 다른 브랜치로 옮긴 worktree 는 이 작업의 커밋과 PR 을 판정할 수 없다. 그대로 받으면 '바뀐 것 없음'으로 정리될 수 있다.
      return {
        text: `This worktree is not on ${task.branch}. Switch back to ${task.branch} (git switch ${task.branch}) and call report_done again, or report with report_blocker.`,
        isError: true,
      };
    } else if (!continuedBy(request, task)) {
      pr = await findPullRequest(agent.cwd, task.branch);
      if (!pr) {
        unpublished = await unpublishedWork(agent.cwd, task.branch, task.baseBranch);
        if (await baseIsLocalOnly(agent.cwd, task.baseBranch)) {
          noPrSource = "localBase";
          noPrReason = input.noPullRequestReason ?? `The base branch ${task.baseBranch} exists only on this machine.`;
        } else if (unpublished) {
          if (!input.noPullRequestReason) {
            return {
              text: `There is work on ${task.branch} without a pull request (${unpublished}). Commit, push ${task.branch} and open a pull request against ${task.baseBranch ?? "the default branch"}, then call report_done again.`,
              isError: true,
            };
          }
          if (!quotesRequest(request, input.noPullRequestReason)) {
            return {
              text: `noPullRequestReason must quote the human's request word for word, and "${input.noPullRequestReason}" is not in it. If the request does not tell you to skip committing, pushing or the pull request, push ${task.branch}, open the pull request and call report_done again. If something else stops you, call report_blocker.`,
              isError: true,
            };
          }
          noPrSource = "request";
          noPrReason = input.noPullRequestReason;
        } else {
          noPrSource = "noChanges";
        }
      } else if (pr.state !== "OPEN") {
        return { text: `The pull request for ${task.branch} is ${pr.state}. Open a new one, then call report_done again.`, isError: true };
      } else if (task.baseBranch && pr.baseRefName !== task.baseBranch) {
        // 다른 브랜치를 대상으로 연 PR 을 머지하면 기준 브랜치의 커밋까지 엉뚱한 곳에 들어간다 (2026-11-26 전수 검사).
        return {
          text: `Pull request #${pr.number} targets ${pr.baseRefName}, but this task's base is ${task.baseBranch}. Change it (gh pr edit ${pr.number} --base ${task.baseBranch}), then call report_done again.`,
          isError: true,
        };
      } else {
        const differs = await differsFromPr(agent.cwd, pr.url);
        if (differs) {
          return { text: `Your worktree is not what pull request #${pr.number} contains (${differs}). Commit and push ${task.branch}, then call report_done again.`, isError: true };
        }
      }
    }
  } catch (error) {
    return { text: `Could not check the pull request: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  const at = new Date().toISOString();
  const { noPullRequestReason: _ignored, ...report } = input;
  await store.update((current) => ({
    state: {
      ...current,
      requests: patchTask(current, request.id, [task.number], (item) => ({
        ...item,
        completion: { ...report, pr, noPrReason, noPrSource, unpublished, qa: [], at, closedAt: null },
      })),
    },
    result: undefined,
  }));
  return {
    text: pr
      ? `Recorded with pull request #${pr.number}. End your turn now; the human decides the merge.`
      : noPrSource === "existingWorkspace"
        ? `Recorded. Your commits stay on ${task.branch} for the human to review; do not push. End your turn now.`
      : continuedBy(request, task) && task.kind !== "operation"
        ? "Recorded. The next task continues on this branch and opens the pull request. End your turn now."
        : noPrSource === "operation"
          ? "Recorded as a finished operation task. End your turn now."
          : noPrSource === "request"
            ? "Recorded without a pull request, as the request asked. End your turn now."
            : noPrSource === "localBase"
              ? "Recorded without a pull request, since the base branch is local only. End your turn now."
              : "Recorded with no pull request, since nothing changed. End your turn now.",
  };
}

/**
 * 워커의 완료 보고 도구 (7단계). 완료 = 검증 통과 + PR 생성 (RULES.md §11). 운영 작업은 PR 이 없다.
 * 글로만 '끝났다'고 쓰면 무엇을 검증했는지, PR 이 있는지 플러그인이 알 수 없어 머지 카드를 만들 수 없다.
 */
export function reportDoneTool(store: StateStore) {
  return defineAgentTool({
    name: REPORT_DONE_TOOL,
    title: "Report the task done",
    description:
      "Call this once your task is finished and verified, as your last action before ending the turn. If your kickoff tells you to open a pull request, push the branch and open it first: the plugin finds the pull request by your branch. Operation tasks, tasks in the human's existing workspace, tasks on a local-only base branch and tasks that another task continues finish without a pull request, as your kickoff says. Give what you did, how you verified it (commands and results), the reversible choices you made yourself with why, and anything left.",
    input: reportDoneInput,
    execute: (input, { agent }) => recordCompletion(store, agent, input),
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 작업의 worktree 폴더. 워커 세션의 cwd 를 먼저 보고, 세션이 없으면 워크스페이스의 폴더를 본다. 폴더가 디스크에 없으면(이미 지워짐)
 * 잃을 것이 없으므로 null. 조회가 실패하면 던진다. 실패를 '없음'으로 치면 확인 없이 머지·정리한다.
 */
export async function worktreeOf(paseo: PaseoApi, task: Task): Promise<string | null> {
  let directory: string | null = null;
  const snapshot = task.agentId ? await paseo.agents.ref(task.agentId).refresh() : null;
  if (snapshot) directory = snapshot.agent.cwd ?? null;
  else if (task.workspaceId) directory = (await paseo.workspaces.ref(task.workspaceId).refresh())?.workspaceDirectory ?? null;
  return directory && existsSync(directory) ? directory : null;
}

/**
 * 머지 카드의 결정을 실행한다 (7단계). 머지는 사람의 결정이라(RULES.md H2) 카드 버튼으로만 일어난다.
 * 머지 방식은 squash, 머지 뒤 원격 브랜치와 워크스페이스를 정리한다 (2026-11-26 사용자 결정).
 */
export class CompletionRunner {
  constructor(
    private readonly store: StateStore,
    private readonly channel: WorkerChannel,
    private readonly onRequestDone: (paseo: PaseoApi, requestId: string) => void,
  ) {}

  async close(
    paseo: PaseoApi,
    input: { requestId: string; taskNumber: number; action: "merge" | "revise"; instruction: string | null },
  ): Promise<void> {
    const state = await this.store.read();
    const request = state.requests.find((item) => item.id === input.requestId);
    const task = request?.tasks.find((item) => item.number === input.taskNumber);
    const completion = task?.completion;
    if (!request || !task || !completion || completion.closedAt || task.status !== "review") {
      throw new Error(say(request?.language, "This card is no longer open.", "이 카드는 이미 닫혔어요."));
    }
    const lang = request.language;
    if (input.action === "revise") return this.revise(paseo, request, task, input.instruction);
    // gh 를 부르는 몇 초 사이에 코디네이터 메시지나 되돌리기로 작업이 다시 일하게 될 수 있다. 그때 머지하고 정리하면 막 재개한
    // 워커의 worktree 가 지워진다 (2026-11-26 전수 검사). 머지와 정리 직전에 카드가 그대로인지 다시 본다.
    const stillOpen = async () => {
      const latest = (await this.store.read()).requests.find((item) => item.id === request.id)?.tasks.find((item) => item.number === task.number);
      return latest?.status === "review" && !latest.completion?.closedAt && latest.completion?.at === completion.at;
    };
    const changed = () => new Error(say(lang, "The task changed while the card was being closed. Look at it again.", "카드를 닫는 사이 작업이 바뀌었어요. 다시 확인해 주세요."));

    const projects = (await paseo.projects.list()).projects;
    const root = projects.find((item) => item.projectId === task.projectId)?.projectRootPath;
    if (!root) throw new Error(say(lang, `Project ${task.projectId} is not registered on this host.`, `프로젝트 ${task.projectId} 가 이 호스트에 등록돼 있지 않아요.`));
    // 확인하지 못한 것을 '차이 없음'으로 치면 push 하지 않은 커밋이 머지·정리와 함께 사라진다 (2026-11-26 전수 검사). 확인이 실패하면 멈춘다.
    const worktree = await worktreeOf(paseo, task).catch((error: unknown) => {
      throw new Error(say(lang, `Could not find the worker's worktree: ${message(error)}`, `워커의 worktree 를 확인하지 못했어요: ${message(error)}`));
    });
    let mergedHead: string | null = null;
    let closedUnmerged = false;
    if (completion.pr) {
      if (worktree) {
        const differs = await differsFromPr(worktree, completion.pr.url).catch((error: unknown) => {
          throw new Error(say(lang, `Could not compare the worktree with the pull request: ${message(error)}`, `worktree 와 PR 을 비교하지 못했어요: ${message(error)}`));
        });
        if (differs) {
          throw new Error(
            say(
              lang,
              `The worker's worktree has changes the pull request does not (${differs}). Ask the worker to push them first.`,
              `워커의 worktree 에 PR 에 없는 변경이 있어요 (${differs}). 수정 지시로 먼저 push 해 달라고 해 주세요.`,
            ),
          );
        }
      }
      const pr = await readPullRequest(root, completion.pr.url);
      if (pr.state === "OPEN") {
        // 카드가 보여 준 커밋만 머지한다. 보고 뒤에 워커가 더 push 했으면 사람이 보지 않은 커밋이다.
        if (completion.pr.headRefOid && pr.headRefOid && pr.headRefOid !== completion.pr.headRefOid) {
          throw new Error(
            say(
              lang,
              `Pull request #${pr.number} has new commits since the worker reported (${completion.pr.headRefOid.slice(0, 7)} → ${pr.headRefOid.slice(0, 7)}). Send the worker an instruction to report again so the card shows what will be merged.`,
              `워커가 보고한 뒤 PR #${pr.number} 에 새 커밋이 올라왔어요 (${completion.pr.headRefOid.slice(0, 7)} → ${pr.headRefOid.slice(0, 7)}). 수정 지시로 다시 보고하게 해서, 머지할 내용을 카드에서 확인해 주세요.`,
            ),
          );
        }
        if (task.baseBranch && pr.baseRefName !== task.baseBranch) {
          throw new Error(
            say(
              lang,
              `Pull request #${pr.number} targets ${pr.baseRefName}, not ${task.baseBranch}. Ask the worker to change its base.`,
              `PR #${pr.number} 의 대상이 ${task.baseBranch} 가 아니라 ${pr.baseRefName} 이에요. 수정 지시로 대상 브랜치를 고치게 해 주세요.`,
            ),
          );
        }
        if (pr.mergeable === "CONFLICTING") {
          throw new Error(
            say(lang, `Pull request #${pr.number} has conflicts with ${pr.baseRefName}. Ask the worker to fix them.`, `PR #${pr.number} 이 ${pr.baseRefName} 과 충돌해요. 수정 지시로 워커에게 고쳐 달라고 해 주세요.`),
          );
        }
        if (!(await stillOpen())) throw changed();
        await run("gh", ["pr", "merge", pr.url, "--squash", ...(pr.headRefOid ? ["--match-head-commit", pr.headRefOid] : [])], root);
        // merge queue 가 있는 저장소에서는 명령이 성공해도 대기열에 들어갔을 뿐이다. 그때 브랜치를 지우면 PR 이 닫힌다.
        // 머지가 확인될 때까지 카드를 닫지 않는다. 다시 누르면 이미 머지된 PR 로 보고 정리만 한다.
        const after = await readPullRequest(root, completion.pr.url);
        if (after.state !== "MERGED") {
          throw new Error(
            say(
              lang,
              `Pull request #${pr.number} is not merged yet (${after.state}); it may be waiting in a merge queue. Press merge again once it is merged.`,
              `PR #${pr.number} 이 아직 머지되지 않았어요 (${after.state}). 머지 대기열에 들어갔을 수 있어요. 머지된 뒤 다시 눌러 주세요.`,
            ),
          );
        }
        mergedHead = after.headRefOid ?? pr.headRefOid;
      } else if (pr.state === "MERGED") {
        mergedHead = pr.headRefOid;
      } else {
        // 사람이 GitHub 에서 PR 을 닫았다. 예전에는 머지 버튼이 매번 오류를 내서 이 카드를 닫을 길이 없었고, 이 작업에 기대는
        // 작업도 영원히 기다렸다 (2026-11-26 전수 검사). 머지하지 않고 카드만 닫는다. 변경이 남은 worktree 와 브랜치는 그대로 둔다.
        closedUnmerged = true;
      }
      if (mergedHead !== null) {
        // 저장소 설정으로 이미 지워졌으면 실패해도 된다. fork 에서 연 PR 이면 head 저장소의 브랜치를 지운다.
        const repo = pr.headRepository ?? "{owner}/{repo}";
        await run("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${pr.headRefName}`], root).catch(() => undefined);
      }
    }
    // PR 없이 끝난 카드는 보고 뒤에 worktree 에 변경이 생겼을 수 있다(워커가 다시 일했거나 사람이 썼다). 정리 직전에 다시 보고, 있으면 남긴다.
    let kept: string | null = completion.unpublished;
    if (!completion.pr && !task.existingWorkspaceId && worktree && !kept) {
      kept = await (task.kind === "operation" || !task.branch ? uncommittedChanges(worktree) : unpublishedWork(worktree, task.branch, task.baseBranch)).catch(
        (error: unknown) => `could not check the worktree: ${message(error)}`,
      );
    }
    if (closedUnmerged) kept = kept ?? `pull request #${completion.pr!.number} was closed without merging`;
    // 이 브랜치를 같이 쓴 작업(앞 작업들)도 함께 끝낸다. 이 작업까지 worktree 를 넘겨준 사슬만 끝낸다. 워크스페이스 id 로 묶으면
    // 같은 worktree 를 이어 받은 뒤 작업이 일하는 중에 완료가 됐다 (2026-11-26 전수 검사). 취소된 작업은 취소로 남긴다.
    const numbers = chainEndingAt(request, task)
      .filter((item) => item.number === task.number || item.status === "done")
      .map((item) => item.number);
    const at = new Date().toISOString();
    const summary = closedUnmerged
      ? `Closed: pull request #${completion.pr!.number} was closed without merging; the workspace is kept`
      : completion.pr
        ? `Merged #${completion.pr.number} (squash)`
        : completion.noPrSource === "existingWorkspace"
          ? `Confirmed the commits on ${task.branch}`
          : completion.noPrSource === "operation"
            ? "Confirmed the finished operation task"
            : completion.noPrReason
              ? `Confirmed without a pull request: ${completion.noPrReason}`
              : "Confirmed: finished without changes";
    // 머지는 이미 일어났으면 기록해야 한다. 머지가 없는 카드는 그사이 작업이 바뀌었으면 닫지 않는다.
    const saved = await this.store.update((current) => {
      const latest = current.requests.find((item) => item.id === request.id)?.tasks.find((item) => item.number === task.number);
      const open = latest?.status === "review" && !latest.completion?.closedAt && latest.completion?.at === completion.at;
      if (!open && mergedHead === null) return { state: current, result: false };
      return {
        state: {
          ...current,
          requests: patchTask(current, request.id, numbers, (item) => ({
            ...item,
            status: "done" as const,
            note: null,
            completion: item.completion ? { ...item.completion, closedAt: at } : item.completion,
            decisions:
              item.number === task.number
                ? [
                    ...item.decisions,
                    {
                      summary: kept && !closedUnmerged && !completion.unpublished ? `${summary}; kept the workspace: ${kept}` : summary,
                      by: "human" as const,
                      at,
                      qa: answeredQa(completion.qa),
                    },
                  ]
                : item.decisions,
          })),
        },
        result: open,
      };
    });
    if (!saved && mergedHead === null) throw changed();
    // 사람의 기존 워크스페이스와 그 브랜치는 사람의 것이다. 워커 세션만 닫는다.
    if (task.existingWorkspaceId) {
      const agentIds = request.tasks.filter((item) => numbers.includes(item.number) && item.agentId).map((item) => item.agentId!);
      for (const agentId of agentIds) await paseo.agents.ref(agentId).archive().catch(() => undefined);
    }
    // PR 에 담기지 않은 변경이 남았으면 워크스페이스를 지우지 않는다. 지우면 그 변경이 사라진다. 저장하는 사이 작업이 다시 일하게
    // 됐으면(saved false) 그 워커의 worktree 이므로 지우지 않는다.
    else if (task.workspaceId && !kept && saved) {
      const archived = await paseo.workspaces
        .ref(task.workspaceId)
        .archive()
        .then(() => true)
        .catch((error: unknown) => (console.error(`[coordinator] could not archive workspace ${task.workspaceId}`, error), false));
      if (archived && mergedHead !== null && task.branch) {
        // 머지된 브랜치는 로컬에도 남길 이유가 없다. worktree 가 지워진 뒤에만 지울 수 있다. squash 머지라 git 은 머지된 것으로
        // 알아보지 못하므로 -D 로 지운다. 다만 로컬 브랜치에 머지된 PR 에 없는 커밋이 있으면 남긴다.
        const tip = await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${task.branch}`], root).then((out) => out.trim(), () => null);
        if (tip && (tip === mergedHead || (await isAncestor(root, tip, mergedHead)))) {
          await run("git", ["branch", "-D", task.branch], root).catch((error: unknown) =>
            console.error(`[coordinator] could not delete local branch ${task.branch}`, error),
          );
        } else if (tip) {
          console.error(`[coordinator] kept local branch ${task.branch}: it has commits the merged pull request does not`);
        }
      } else if (archived && task.branch && !completion.pr) {
        // PR 없이 끝난 작업의 브랜치도 남기지 않는다. 다만 원격 어디에도 없는 커밋이 있으면 지우지 않는다 (r15 뒤 coord/r15-*
        // 브랜치 16개가 남았다, 2026-11-26).
        await deleteBranchIfPublished(root, task.branch);
      }
    }
    if (await finishRequestIfDone(this.store, request.id)) this.onRequestDone(paseo, request.id);
  }

  private async revise(paseo: PaseoApi, request: CoordinatorRequest, task: Task, instruction: string | null): Promise<void> {
    const text = instruction?.trim();
    if (!text) throw new Error(say(request.language, "Write what the worker should change.", "워커가 무엇을 고쳐야 하는지 적어 주세요."));
    // 끝내는 방법은 처음 킥오프와 같아야 한다. 늘 'push' 라고 하면 '커밋하지 마' 요청이나 로컬 기준 브랜치, 운영 작업과 부딪힌다.
    const source = task.completion?.noPrSource;
    const finish = task.completion?.pr
      ? "Make the change on the same branch, verify it, push, and call report_done again."
      : task.existingWorkspaceId && task.kind !== "operation"
        ? `Make the change on ${task.branch}, verify it, commit, and call report_done again. Do not push or open a pull request.`
      : source === "operation"
        ? "Do it within the approved targets of this operation task, verify it, and call report_done again. Do not change files in the worktree."
        : source === "request"
          ? "Make the change, verify it, and call report_done again. Keep following the request: do not commit, push or open a pull request where it says not to."
          : source === "localBase"
            ? "Make the change on the same branch, verify it, commit, and call report_done again. Do not push: the base branch is local only."
            : // 바뀐 것 없이 끝났거나 예전 기록이라 끝내는 방법을 모른다. 'push' 를 단정하면 '커밋하지 마' 요청과 부딪힌다.
              "Make the change on the same branch, verify it, and call report_done again. Follow the human's request and your kickoff about committing, pushing and opening the pull request.";
    const at = new Date().toISOString();
    await this.store.update((current) => ({
      state: {
        ...current,
        requests: patchTask(current, request.id, [task.number], (item) =>
          queued(
            {
              ...item,
              status: "running" as const,
              completion: null,
              doneNudgedAt: null,
              decisions: [
                ...item.decisions,
                { summary: `Asked for changes before merge: ${text}`, by: "human" as const, at, qa: answeredQa(item.completion?.qa ?? []) },
              ],
            },
            `[Change request from the human before merging]\n${text}\n${finish}`,
          ),
        ),
      },
      result: undefined,
    }));
    await this.channel.flush(paseo, request.id, task.number).catch((error: unknown) =>
      console.error(`[coordinator] could not send the change request for ${request.id}:${task.number}; it stays queued`, error),
    );
  }
}
