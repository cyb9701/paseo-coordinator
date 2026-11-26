/// <reference types="node" />

import { execFile } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CoordinatorRequest, Task } from "../shared/model";
import type { StateStore } from "./store";
import type { WorkerChannel } from "./worker-channel";

type PullRequest = NonNullable<NonNullable<Task["completion"]>["pr"]>;

// 플러그인 server 는 앱이 띄운 프로세스라 셸 프로필의 PATH 를 받지 못할 수 있다. Homebrew 위치를 덧붙인다.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");

function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: { ...process.env, PATH }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}

const PR_FIELDS = "number,url,title,state,baseRefName,headRefName,additions,deletions,changedFiles,mergeable,statusCheckRollup";

type RawPr = Omit<PullRequest, "checks" | "readAt"> & {
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[] | null;
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
  };
}

/** 브랜치에서 연 PR 을 gh 로 찾는다. 워커가 준 URL 을 믿지 않고, 플러그인이 정한 작업 브랜치로 찾는다. */
async function findPullRequest(cwd: string, branch: string): Promise<PullRequest | null> {
  const out = await run("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", PR_FIELDS, "--limit", "1"], cwd);
  const [raw] = JSON.parse(out) as RawPr[];
  return raw ? toPullRequest(raw) : null;
}

async function readPullRequest(cwd: string, url: string): Promise<PullRequest> {
  return toPullRequest(JSON.parse(await run("gh", ["pr", "view", url, "--json", PR_FIELDS], cwd)) as RawPr);
}

/**
 * worktree 에 PR 에 담기지 않은 변경이 남았는지. 커밋하지 않은 파일, 또는 원격의 다른 브랜치(main 포함)에 없는 커밋.
 * PR 없이 '끝났다'고 보고한 워커가 정말 바꾼 것이 없는지 확인할 때 쓴다.
 */
async function unpublishedWork(cwd: string, branch: string): Promise<string | null> {
  const dirty = (await run("git", ["status", "--porcelain"], cwd)).trim();
  if (dirty) return `uncommitted changes:\n${dirty.split("\n").slice(0, 10).join("\n")}`;
  const ahead = Number(
    (await run("git", ["rev-list", "--count", "HEAD", "--not", `--exclude=refs/remotes/origin/${branch}`, "--remotes"], cwd)).trim(),
  );
  return ahead > 0 ? `${ahead} commit(s) on ${branch} that no pull request carries` : null;
}

/**
 * 같은 프로젝트의 다음 작업이 이 작업의 worktree 를 이어 쓰는지 (배정기의 continuesFrom 과 같은 규칙).
 * 이어 쓰면 PR 은 마지막 작업이 만든다.
 */
export function continuedBy(request: CoordinatorRequest, task: Task): Task | null {
  return (
    request.tasks.find((other) => {
      if (other.projectId !== task.projectId || !other.dependsOn.includes(task.number)) return false;
      const sameProject = request.tasks.filter((dep) => other.dependsOn.includes(dep.number) && dep.projectId === task.projectId);
      return Math.max(...sameProject.map((dep) => dep.number)) === task.number;
    }) ?? null
  );
}

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

/** 모든 작업이 끝났으면 요청을 끝낸다. 끝냈으면 true. */
export async function finishRequestIfDone(store: StateStore, requestId: string): Promise<boolean> {
  return store.update((state) => {
    const request = state.requests.find((item) => item.id === requestId);
    if (!request || request.status !== "running" || request.kind !== "change") return { state, result: false };
    if (!request.tasks.every((task) => task.status === "done")) return { state, result: false };
    return {
      state: { ...state, requests: state.requests.map((item) => (item.id === requestId ? { ...item, status: "done" as const } : item)) },
      result: true,
    };
  });
}

/**
 * 워커의 완료 보고 도구 (7단계). 완료 = 검증 통과 + PR 생성 (RULES.md §11).
 * 글로만 '끝났다'고 쓰면 무엇을 검증했는지, PR 이 있는지 플러그인이 알 수 없어 머지 카드를 만들 수 없다.
 */
export function reportDoneTool(store: StateStore) {
  return defineAgentTool({
    name: "report_done",
    title: "Report the task done",
    description:
      "Call this once your task is finished and verified, as your last action before ending the turn. If you are the last task on your branch, push the branch and open a pull request first: the plugin finds the pull request by your branch. Give what you did, how you verified it (commands and results), the reversible choices you made yourself with why, and anything left.",
    input: z.object({
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
        .describe("Only when the human's request says not to commit, push or open a pull request: quote that instruction here."),
    }),
    execute: async (input, { agent }) => {
      const state = await store.read();
      const request = state.requests.find((item) => item.tasks.some((task) => task.agentId === agent.id));
      const task = request?.tasks.find((item) => item.agentId === agent.id);
      if (!request || !task) return { text: "You are not a coordinator worker; nothing was reported.", isError: true };
      if (request.kind === "read") {
        return { text: "This is a read-only investigation: end with your report as plain text instead.", isError: true };
      }
      if (!task.branch) return { text: "This task has no branch recorded; report it with report_blocker.", isError: true };
      let pr: PullRequest | null = null;
      let unpublished: string | null = null;
      if (!continuedBy(request, task)) {
        try {
          pr = await findPullRequest(agent.cwd, task.branch);
          if (!pr) {
            const left = await unpublishedWork(agent.cwd, task.branch);
            unpublished = left;
            if (left && !input.noPullRequestReason) {
              return {
                text: `There is work on ${task.branch} without a pull request (${left}). Commit, push ${task.branch} and open a pull request against the default branch, then call report_done again.`,
                isError: true,
              };
            }
          } else if (pr.state !== "OPEN") {
            return { text: `The pull request for ${task.branch} is ${pr.state}. Open a new one, then call report_done again.`, isError: true };
          }
        } catch (error) {
          return { text: `Could not check the pull request: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      }
      const at = new Date().toISOString();
      const { noPullRequestReason, ...report } = input;
      await store.update((current) => ({
        state: {
          ...current,
          requests: patchTask(current, request.id, [task.number], (item) => ({
            ...item,
            completion: { ...report, pr, noPrReason: pr ? null : noPullRequestReason, unpublished, at, closedAt: null },
          })),
        },
        result: undefined,
      }));
      return {
        text: pr
          ? `Recorded with pull request #${pr.number}. End your turn now; the human decides the merge.`
          : continuedBy(request, task)
            ? "Recorded. The next task continues on this branch and opens the pull request. End your turn now."
            : noPullRequestReason
              ? "Recorded without a pull request, as the request asked. End your turn now."
              : "Recorded with no pull request, since nothing changed. End your turn now.",
      };
    },
  });
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
      throw new Error("This card is no longer open.");
    }
    if (input.action === "revise") return this.revise(paseo, request, task, input.instruction);

    const projects = (await paseo.projects.list()).projects;
    const root = projects.find((item) => item.projectId === task.projectId)?.projectRootPath;
    if (!root) throw new Error(`Project ${task.projectId} is not registered on this host.`);
    if (completion.pr) {
      const pr = await readPullRequest(root, completion.pr.url);
      if (pr.state === "CLOSED") throw new Error(`Pull request #${pr.number} was closed without merging.`);
      if (pr.state === "OPEN") {
        if (pr.mergeable === "CONFLICTING") throw new Error(`Pull request #${pr.number} has conflicts with ${pr.baseRefName}. Ask the worker to fix them.`);
        await run("gh", ["pr", "merge", pr.url, "--squash"], root);
      }
      // 저장소 설정으로 이미 지워졌으면 실패해도 된다.
      await run("gh", ["api", "-X", "DELETE", `repos/{owner}/{repo}/git/refs/heads/${pr.headRefName}`], root).catch(() => undefined);
    }
    // 이 브랜치를 같이 쓴 작업(앞 작업들)도 함께 끝낸다. 워크스페이스는 하나다.
    const sharing = request.tasks.filter((item) => item.workspaceId && item.workspaceId === task.workspaceId).map((item) => item.number);
    const numbers = [...new Set([task.number, ...sharing])];
    const at = new Date().toISOString();
    await this.store.update((current) => ({
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
                    summary: completion.pr
                      ? `Merged #${completion.pr.number} (squash)`
                      : completion.noPrReason
                        ? `Confirmed without a pull request: ${completion.noPrReason}`
                        : "Confirmed: finished without changes",
                    by: "human" as const,
                    at,
                    qa: [],
                  },
                ]
              : item.decisions,
        })),
      },
      result: undefined,
    }));
    // PR 에 담기지 않은 변경이 남았으면 워크스페이스를 지우지 않는다. 지우면 그 변경이 사라진다.
    if (task.workspaceId && !completion.unpublished) {
      await paseo.workspaces
        .ref(task.workspaceId)
        .archive()
        .catch((error: unknown) => console.error(`[coordinator] could not archive workspace ${task.workspaceId}`, error));
    }
    if (await finishRequestIfDone(this.store, request.id)) this.onRequestDone(paseo, request.id);
  }

  private async revise(paseo: PaseoApi, request: CoordinatorRequest, task: Task, instruction: string | null): Promise<void> {
    const text = instruction?.trim();
    if (!text) throw new Error("Write what the worker should change.");
    const at = new Date().toISOString();
    await this.store.update((current) => ({
      state: {
        ...current,
        requests: patchTask(current, request.id, [task.number], (item) => ({
          ...item,
          status: "running" as const,
          completion: null,
          doneNudgedAt: null,
          decisions: [...item.decisions, { summary: `Asked for changes before merge: ${text}`, by: "human" as const, at, qa: [] }],
        })),
      },
      result: undefined,
    }));
    await this.channel.deliver(
      paseo,
      request.id,
      task.number,
      `[Change request from the human before merging]\n${text}\nMake the change on the same branch, verify it, push, and call report_done again.`,
    );
  }
}
