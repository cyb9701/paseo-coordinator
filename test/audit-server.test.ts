/// <reference types="node" />

/**
 * 2026-11-26 세 번째 전수 검사에서 찾은 서버 흐름 결함의 회귀 테스트: 머지할 PR head 고정, 확인 실패 시 멈춤, GitHub 에서 닫힌 PR,
 * 완료 보고의 브랜치·기준·기록 검사, 늦게 끝난 턴, 기존 워크스페이스 점유, 기본 브랜치, 요청 취소, 킥오프 실패, 닫힌 세션.
 *
 * gh 는 가짜를 쓴다. server/run.ts 는 불러올 때 PATH 를 읽으므로, PATH 맨 앞에 가짜 gh 를 둔 뒤 서버 모듈을 동적으로 불러온다.
 * 실제 gh 는 부르지 않는다. 실행: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { StateStore } from "../server/store";
import { stateSchema } from "../shared/model";

const FAKE = mkdtempSync(join(tmpdir(), "coordinator-fake-gh-"));
mkdirSync(join(FAKE, "bin"));
writeFileSync(
  join(FAKE, "bin", "gh"),
  `#!/bin/bash
echo "$@" >> "$FAKE_GH/log"
case "$1 $2" in
  "pr view") if [ -f "$FAKE_GH/view-fails" ]; then echo "view failed" >&2; exit 1; fi; cat "$FAKE_GH/view.json";;
  "pr list") cat "$FAKE_GH/list.json";;
  "pr merge") cp "$FAKE_GH/merged.json" "$FAKE_GH/view.json";;
  "api -X") ;;
  *) echo "unexpected gh $@" >&2; exit 1;;
esac
`,
);
chmodSync(join(FAKE, "bin", "gh"), 0o755);
process.env.PATH = `${join(FAKE, "bin")}:${process.env.PATH}`;
process.env.FAKE_GH = FAKE;

const server = async () => ({
  completion: await import("../server/completion"),
  dispatcher: await import("../server/dispatcher"),
  requests: await import("../server/requests"),
  tools: await import("../server/worker-tools"),
  channel: await import("../server/worker-channel"),
});

type Fake = any;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" })
    .toString()
    .trim();

/** origin(main) 이 있는 저장소와, 작업 브랜치 coord/r1-1-x 를 checkout 한 worktree. 작업 브랜치에는 커밋 하나가 push 돼 있다. */
function repo(): { root: string; worktree: string; head: string } {
  const origin = mkdtempSync(join(tmpdir(), "coordinator-audit-origin-"));
  git(origin, "init", "--bare", "-b", "main");
  const root = mkdtempSync(join(tmpdir(), "coordinator-audit-root-"));
  git(root, "clone", origin, ".");
  git(root, "commit", "--allow-empty", "-m", "init");
  git(root, "push", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  const worktree = join(mkdtempSync(join(tmpdir(), "coordinator-audit-wt-")), "wt");
  git(root, "worktree", "add", "-b", "coord/r1-1-x", worktree, "main");
  git(worktree, "commit", "--allow-empty", "-m", "work");
  git(worktree, "push", "origin", "coord/r1-1-x");
  return { root, worktree, head: git(worktree, "rev-parse", "HEAD") };
}

function pr(extra: Record<string, unknown> = {}) {
  return {
    number: 7,
    url: "https://example.invalid/o/r/pull/7",
    title: "work",
    state: "OPEN",
    baseRefName: "main",
    headRefName: "coord/r1-1-x",
    headRefOid: "0".repeat(40),
    headRepository: { name: "r" },
    headRepositoryOwner: { login: "o" },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    mergeable: "MERGEABLE",
    statusCheckRollup: [],
    ...extra,
  };
}

/** state.json 에 저장된 형태의 PR (gh 응답의 저장소 객체 대신 owner/name 문자열). */
function recordedPr(extra: Record<string, unknown> = {}) {
  const { headRepository: _repo, headRepositoryOwner: _owner, statusCheckRollup: _checks, ...rest } = pr(extra);
  return { ...rest, checks: null, readAt: "", headRepository: "o/r" };
}

function ghReset(view: Record<string, unknown> | null, list: unknown[] = []) {
  for (const name of ["log", "view-fails"]) rmSync(join(FAKE, name), { force: true });
  writeFileSync(join(FAKE, "log"), "");
  if (view) writeFileSync(join(FAKE, "view.json"), JSON.stringify(view));
  writeFileSync(join(FAKE, "merged.json"), JSON.stringify({ ...(view ?? pr()), state: "MERGED" }));
  writeFileSync(join(FAKE, "list.json"), JSON.stringify(list));
}
const ghLog = () => readFileSync(join(FAKE, "log"), "utf8");

function request(extra: Record<string, unknown>, tasks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: "r1",
    text: "고쳐줘",
    doneCriteria: null,
    projectIds: ["p"],
    language: "ko",
    createdAt: new Date().toISOString(),
    status: "running",
    kind: "change",
    grade: "C",
    title: "수정",
    plannedAt: new Date().toISOString(),
    coordinatorAgentId: "c1",
    ...extra,
    tasks: tasks.map((task, index) => ({
      number: index + 1,
      name: `작업${index + 1}`,
      projectId: "p",
      dependsOn: [],
      status: "running",
      workspaceId: `ws${index + 1}`,
      agentId: `w${index + 1}`,
      branch: "coord/r1-1-x",
      baseBranch: "main",
      ...task,
    })),
  };
}

function storeWith(...requests: Record<string, unknown>[]): StateStore {
  const directory = mkdtempSync(join(tmpdir(), "coordinator-audit-state-"));
  writeFileSync(join(directory, "state.json"), JSON.stringify(stateSchema.parse({ requests, sent: [] })));
  return new StateStore(directory);
}
const first = async (store: StateStore) => (await store.read()).requests[0]!;

function fakePaseo(calls: string[], root: string, agent: Record<string, unknown> = {}): Fake {
  return {
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root, projectDisplayName: "p" }] }) },
    providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
    workspaces: {
      ref: (id: string) => ({ id, archive: async () => (calls.push(`archive-ws ${id}`), {}), refresh: async () => null }),
    },
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: "idle", pendingPermissions: [], archivedAt: null, backgroundWork: { count: 0 }, ...agent } }),
        archive: async () => (calls.push(`archive ${id}`), {}),
        send: async () => void calls.push(`send ${id}`),
        timeline: { refetch: async () => ({ entries: [] }) },
      }),
    },
  };
}

const completion = (extra: Record<string, unknown> = {}) => ({
  summary: "끝",
  verification: ["테스트"],
  choices: [],
  left: [],
  pr: null,
  at: new Date().toISOString(),
  ...extra,
});

const reportInput = { summary: "끝", verification: ["테스트"], choices: [], left: [], noPullRequestReason: null };

describe("머지 카드 닫기", () => {
  test("보고 뒤 PR 에 새 커밋이 오면 머지하지 않고, 같으면 보고한 커밋으로만 머지한다", async () => {
    const { completion: c, channel } = await server();
    const { root, worktree, head } = repo();
    const recorded = recordedPr({ headRefOid: head });
    const store = storeWith(request({}, [{ status: "review", completion: completion({ pr: recorded }) }]));
    const calls: string[] = [];
    const paseo = fakePaseo(calls, root, { cwd: worktree });
    const runner = new c.CompletionRunner(store, new channel.WorkerChannel(store), () => {});
    const input = { requestId: "r1", taskNumber: 1, action: "merge" as const, instruction: null };

    ghReset(pr({ headRefOid: "f".repeat(40) }));
    // 로컬 HEAD 가 PR head 와 다르면 먼저 그 차이로 막힌다. PR 에만 새 커밋이 올라온 경우를 보려면 로컬 비교를 통과시켜야 한다.
    await assert.rejects(runner.close(paseo, input), /PR 에 없는 변경|새 커밋/);
    assert.doesNotMatch(ghLog(), /pr merge/);

    ghReset(pr({ headRefOid: head }));
    await runner.close(paseo, input);
    assert.match(ghLog(), new RegExp(`pr merge https://example.invalid/o/r/pull/7 --squash --match-head-commit ${head}`));
    assert.match(ghLog(), /api -X DELETE repos\/o\/r\/git\/refs\/heads\/coord\/r1-1-x/);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "done");
    assert.ok(calls.includes("archive-ws ws1"));
  });

  test("PR head 만 바뀌었으면(로컬은 보고 때 그대로) 새 커밋이라고 막는다", async () => {
    const { completion: c, channel } = await server();
    const { root, head } = repo();
    const recorded = recordedPr({ headRefOid: head });
    const store = storeWith(request({}, [{ status: "review", completion: completion({ pr: recorded }) }]));
    // worktree 가 이미 지워져 로컬 비교는 건너뛴다.
    const paseo = fakePaseo([], root, { cwd: "/nonexistent-worktree" });
    ghReset(pr({ headRefOid: "f".repeat(40) }));
    await assert.rejects(
      new c.CompletionRunner(store, new channel.WorkerChannel(store), () => {}).close(paseo, { requestId: "r1", taskNumber: 1, action: "merge", instruction: null }),
      /새 커밋/,
    );
    assert.doesNotMatch(ghLog(), /pr merge/);
  });

  test("머지 직전 확인이 실패하면 '차이 없음'으로 치지 않고 멈춘다", async () => {
    const { completion: c, channel } = await server();
    const { root, worktree, head } = repo();
    const recorded = recordedPr({ headRefOid: head });
    const store = storeWith(request({}, [{ status: "review", completion: completion({ pr: recorded }) }]));
    ghReset(pr({ headRefOid: head }));
    writeFileSync(join(FAKE, "view-fails"), "");
    await assert.rejects(
      new c.CompletionRunner(store, new channel.WorkerChannel(store), () => {}).close(fakePaseo([], root, { cwd: worktree }), {
        requestId: "r1",
        taskNumber: 1,
        action: "merge",
        instruction: null,
      }),
      /비교하지 못했어요/,
    );
    assert.doesNotMatch(ghLog(), /pr merge/);
    assert.equal((await first(store)).tasks[0]!.status, "review");
  });

  test("GitHub 에서 닫힌 PR 의 카드는 머지 없이 닫고 워크스페이스와 브랜치를 남긴다", async () => {
    const { completion: c, channel } = await server();
    const { root, worktree, head } = repo();
    const recorded = recordedPr({ headRefOid: head });
    const store = storeWith(request({}, [{ status: "review", completion: completion({ pr: recorded }) }]));
    const calls: string[] = [];
    ghReset(pr({ headRefOid: head, state: "CLOSED" }));
    await new c.CompletionRunner(store, new channel.WorkerChannel(store), () => {}).close(fakePaseo(calls, root, { cwd: worktree }), {
      requestId: "r1",
      taskNumber: 1,
      action: "merge",
      instruction: null,
    });
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "done");
    assert.match(task.decisions.at(-1)!.summary, /closed without merging/);
    assert.doesNotMatch(ghLog(), /pr merge|api -X DELETE/);
    assert.ok(!calls.some((call) => call.startsWith("archive-ws")));
  });

  test("PR 없이 끝난 카드도 닫기 직전에 worktree 를 다시 보고, 그사이 생긴 변경이 있으면 지우지 않는다", async () => {
    const { completion: c, channel } = await server();
    const { root, worktree } = repo();
    git(root, "push", "origin", "coord/r1-1-x:main", "--force");
    const store = storeWith(request({}, [{ status: "review", completion: completion({ noPrSource: "noChanges" }) }]));
    writeFileSync(join(worktree, "late.txt"), "보고 뒤에 생긴 파일");
    const calls: string[] = [];
    await new c.CompletionRunner(store, new channel.WorkerChannel(store), () => {}).close(fakePaseo(calls, root, { cwd: worktree }), {
      requestId: "r1",
      taskNumber: 1,
      action: "merge",
      instruction: null,
    });
    assert.ok(!calls.some((call) => call.startsWith("archive-ws")), calls.join("\n"));
    assert.match((await first(store)).tasks[0]!.decisions.at(-1)!.summary, /kept the workspace/);
  });
});

describe("완료 보고 검사", () => {
  test("다른 원격 브랜치로 push 하고 PR 이 없으면 '바뀐 것 없음'으로 받지 않는다", async () => {
    const { completion: c } = await server();
    const { worktree } = repo();
    git(worktree, "commit", "--allow-empty", "-m", "more");
    git(worktree, "push", "origin", "HEAD:other");
    ghReset(null, []);
    const store = storeWith(request({}, [{}]));
    const result = await c.recordCompletion(store, { id: "w1", cwd: worktree }, reportInput);
    assert.equal(result.isError, true, result.text);
    assert.match(result.text, /without a pull request/);
  });

  test("worktree 가 작업 브랜치에 있지 않으면 받지 않는다", async () => {
    const { completion: c } = await server();
    const { worktree } = repo();
    git(worktree, "switch", "-c", "elsewhere");
    ghReset(null, []);
    const result = await c.recordCompletion(storeWith(request({}, [{}])), { id: "w1", cwd: worktree }, reportInput);
    assert.equal(result.isError, true);
    assert.match(result.text, /not on coord\/r1-1-x/);
  });

  test("PR 이 기준 브랜치가 아닌 곳을 대상으로 하면 받지 않는다", async () => {
    const { completion: c } = await server();
    const { worktree, head } = repo();
    ghReset(pr({ headRefOid: head, baseRefName: "dev" }), [pr({ headRefOid: head, baseRefName: "dev" })]);
    const result = await c.recordCompletion(storeWith(request({}, [{}])), { id: "w1", cwd: worktree }, reportInput);
    assert.equal(result.isError, true);
    assert.match(result.text, /targets dev/);
  });

  test("보고할 때 PR head 를 기록한다", async () => {
    const { completion: c } = await server();
    const { worktree, head } = repo();
    ghReset(pr({ headRefOid: head }), [pr({ headRefOid: head })]);
    const store = storeWith(request({}, [{}]));
    const result = await c.recordCompletion(store, { id: "w1", cwd: worktree }, reportInput);
    assert.notEqual(result.isError, true, result.text);
    const recorded = (await first(store)).tasks[0]!.completion!.pr!;
    assert.equal(recorded.headRefOid, head);
    assert.equal(recorded.headRepository, "o/r");
  });

  test("기존 워크스페이스에서 시작 커밋이 사라지면(reset·rebase) 받지 않는다", async () => {
    const { completion: c } = await server();
    const { worktree } = repo();
    const start = git(worktree, "rev-parse", "HEAD");
    git(worktree, "reset", "--hard", "HEAD~1");
    const store = storeWith(request({}, [{ existingWorkspaceId: "human", workspaceId: "human", startCommit: start }]));
    const result = await c.recordCompletion(store, { id: "w1", cwd: worktree }, reportInput);
    assert.equal(result.isError, true);
    assert.match(result.text, /history of coord\/r1-1-x changed/);
  });

  test("status.showUntrackedFiles=no 인 저장소에서도 새 파일을 커밋하지 않은 변경으로 본다", async () => {
    const { completion: c } = await server();
    const { worktree } = repo();
    git(worktree, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(worktree, "new.txt"), "x");
    assert.match((await c.uncommittedChanges(worktree)) ?? "", /new\.txt/);
  });

  test("취소된 작업의 늦은 보고는 받지 않는다", async () => {
    const { completion: c, tools } = await server();
    const { worktree } = repo();
    const store = storeWith(request({}, [{ status: "canceled" }]));
    const done = await c.recordCompletion(store, { id: "w1", cwd: worktree }, reportInput);
    assert.equal(done.isError, true);
    const blocker = await tools.recordBlocker(store, "w1", { kind: "question", summary: "s", facts: ["f"], options: [], recommendation: null });
    assert.equal(blocker, null);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "canceled");
    assert.equal(task.blocker, null);
  });
});

const settings: Fake = {
  read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false } }),
};

describe("배정기", () => {
  test("턴 처리 중에 작업이 취소되면 늦게 끝난 턴이 그 작업을 되살리지 않는다", async () => {
    const { dispatcher, channel } = await server();
    const store = storeWith(request({}, [{ completion: completion() }]));
    const paseo: Fake = {
      agents: {
        ref: () => ({
          refresh: async () => {
            await store.update((state) => ({
              state: { ...state, requests: state.requests.map((item) => ({ ...item, tasks: item.tasks.map((task) => ({ ...task, status: "canceled" as const })) })) },
              result: undefined,
            }));
            return { agent: { status: "idle", backgroundWork: { count: 0 } } };
          },
        }),
      },
    };
    await new dispatcher.Dispatcher(store, settings, new channel.WorkerChannel(store), () => {}).onWorkerTurn(paseo, "w1", { kind: "completed" }, false);
    assert.equal((await first(store)).tasks[0]!.status, "canceled");
  });

  test("닫히거나 archive 된 워커 세션의 작업은 '작업 중'에 남기지 않고 멈춘 작업으로 둔다", async () => {
    const { dispatcher, channel } = await server();
    const store = storeWith(request({}, [{}]));
    const paseo: Fake = { ...fakePaseo([], "/nonexistent", { status: "closed" }) };
    await new dispatcher.Dispatcher(store, settings, new channel.WorkerChannel(store), () => {}).run(paseo);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "blocked");
    assert.match(task.note ?? "", /세션이 닫혔어요/);
  });

  test("킥오프를 보내지 못하면 만든 워커를 정리하고 작업을 멈춘 작업으로 둔다", async () => {
    const { dispatcher, channel } = await server();
    const { root } = repo();
    const store = storeWith(request({}, [{ status: "waiting", agentId: null, workspaceId: null, branch: null, baseBranch: null }]));
    const calls: string[] = [];
    const paseo: Fake = {
      projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root }] }) },
      providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
      workspaces: { create: async () => ({ id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } }) },
      agents: {
        ref: (id: string) => ({
          send: async () => {
            throw new Error("connection lost");
          },
          archive: async () => (calls.push(`archive ${id}`), {}),
        }),
      },
    };
    await new dispatcher.Dispatcher(store, settings, new channel.WorkerChannel(store), () => {}).run(paseo);
    assert.ok(calls.includes("archive agentN"));
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "blocked");
    assert.equal(task.agentId, null);
  });

  test("다른 요청의 끝나지 않은 작업이 기존 워크스페이스를 쓰고 있으면 쉬고 있어도 기다린다", async () => {
    const { dispatcher, channel } = await server();
    const { root } = repo();
    const store = storeWith(
      request({ id: "r0" }, [{ status: "blocked", existingWorkspaceId: "human", workspaceId: "human" }]),
      request({}, [{ status: "waiting", agentId: null, workspaceId: null, branch: null, existingWorkspaceId: "human" }]),
    );
    const paseo: Fake = {
      ...fakePaseo([], root),
      workspaces: {
        list: async () => ({
          entries: [{ id: "human", projectId: "p", name: "main", title: "내 작업", workspaceKind: "local_checkout", workspaceDirectory: root, projectRootPath: root, archivingAt: null }],
        }),
      },
      agents: { list: async () => ({ entries: [] }), ref: () => ({ refresh: async () => null }) },
    };
    await new dispatcher.Dispatcher(store, settings, new channel.WorkerChannel(store), () => {}).run(paseo);
    const task = (await store.read()).requests[1]!.tasks[0]!;
    assert.equal(task.status, "waiting");
    assert.match(task.note ?? "", /r0 의 작업 1/);
  });

  for (const human of [false, true]) {
    test(human ? "사람이 직접 고른 워크스페이스는 기본 브랜치여도 시작한다" : "코디네이터가 고른 워크스페이스가 기본 브랜치에 있으면 코드 작업을 시작하지 않는다", async () => {
      const { dispatcher, channel } = await server();
      const { root } = repo();
      const store = storeWith(
        request(human ? { workspaces: { p: "human" } } : {}, [{ status: "waiting", agentId: null, workspaceId: null, branch: null, existingWorkspaceId: "human" }]),
      );
      const paseo: Fake = {
        projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root }] }) },
        providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
        workspaces: {
          list: async () => ({
            entries: [{ id: "human", projectId: "p", name: "main", title: "메인 체크아웃", workspaceKind: "local_checkout", workspaceDirectory: root, projectRootPath: root, archivingAt: null }],
          }),
          ref: (id: string) => ({ id, agents: { create: async () => ({ id: "agentN" }) } }),
        },
        agents: { list: async () => ({ entries: [] }), ref: () => ({ send: async () => undefined, refresh: async () => ({ agent: { status: "running" } }) }) },
      };
      await new dispatcher.Dispatcher(store, settings, new channel.WorkerChannel(store), () => {}).run(paseo);
      const task = (await first(store)).tasks[0]!;
      if (human) {
        assert.equal(task.status, "running", task.note ?? "");
        assert.equal(task.branch, "main");
      } else {
        assert.equal(task.status, "blocked");
        assert.match(task.note ?? "", /기본 브랜치 main/);
      }
    });
  }
});

describe("요청 취소", () => {
  test("결정을 기다리는 머지 카드가 있으면 요청을 취소하지 않는다", async () => {
    const { requests } = await server();
    const recorded = recordedPr();
    const store = storeWith(request({}, [{ status: "review", completion: completion({ pr: recorded }) }, { status: "running" }]));
    await assert.rejects(requests.cancelRequest({ id: "r1" }, store), /PR #7/);
    assert.equal((await first(store)).status, "running");
    const plain = storeWith(request({}, [{ status: "review", completion: completion({ noPrSource: "operation" }) }]));
    await requests.cancelRequest({ id: "r1" }, plain);
    assert.equal((await first(plain)).status, "canceled");
  });
});
