/// <reference types="node" />

/**
 * 사람의 기존 워크스페이스에서 워커가 일하는 흐름의 테스트 (2026-11-26 사용자 결정).
 * 지정은 사람이 새 요청 창에서 고르거나 코디네이터가 질문 카드로 승인받는다. 코드 작업은 커밋까지만 하고, 워크스페이스가 바쁘면
 * 기다리며, 플러그인은 사람의 워크스페이스와 브랜치를 지우지 않는다. 서버 코드를 그대로 부르고 Paseo API 만 가짜로 둔다.
 * 실행: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cleanupTaskWorkspaces } from "../server/cleanup";
import { CompletionRunner, recordCompletion } from "../server/completion";
import { CoordinatorRuntime, humanGateProblems, validatePlan } from "../server/coordinator";
import { Dispatcher } from "../server/dispatcher";
import { answerQuestions, createRequest, retryTask } from "../server/requests";
import { StateStore } from "../server/store";
import { WorkerChannel } from "../server/worker-channel";
import { type CoordinatorState, completionNeedsDecision, stateSchema } from "../shared/model";

type Fake = any;

const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" })
    .toString()
    .trim();

/** 사람이 feature 브랜치에서 일하는 저장소. 원격 없이 로컬에만 있는 브랜치다 (r17 의 orca/notification-settings 처럼). */
async function humanRepo(): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), "coordinator-existing-"));
  git(work, "init", "-b", "main");
  git(work, "commit", "--allow-empty", "-m", "init");
  git(work, "checkout", "-b", "feature");
  git(work, "commit", "--allow-empty", "-m", "human work");
  return work;
}

function request(extra: Record<string, unknown>, tasks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: "r1",
    text: "알림 설정 화면을 고쳐줘",
    doneCriteria: null,
    projectIds: ["p"],
    language: "ko",
    createdAt: ago(30),
    status: "running",
    kind: "change",
    grade: "C",
    title: "알림 설정",
    plannedAt: ago(20),
    coordinatorAgentId: "c1",
    ...extra,
    tasks: tasks.map((task, index) => ({
      number: index + 1,
      name: `작업${index + 1}`,
      projectId: "p",
      dependsOn: [],
      status: "running",
      workspaceId: "human",
      agentId: `w${index + 1}`,
      branch: "feature",
      existingWorkspaceId: "human",
      ...task,
    })),
  };
}

function state(...requests: Record<string, unknown>[]): CoordinatorState {
  return stateSchema.parse({ requests, sent: [] });
}

async function storeWith(value: CoordinatorState) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-existing-state-"));
  await writeFile(join(directory, "state.json"), JSON.stringify(value));
  const store = new StateStore(directory);
  return { store, channel: new WorkerChannel(store) };
}

const first = async (store: StateStore) => (await store.read()).requests[0]!;

const workerSettings: Fake = {
  read: async () => ({
    status: "ready",
    values: { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false },
  }),
};

/**
 * 가짜 Paseo. 사람의 워크스페이스 human(directory) 하나가 열려 있다. running 에 넣은 에이전트는 그 워크스페이스에서 일하는 중이다.
 * 새 워크스페이스를 만들거나 사람의 워크스페이스를 archive 하면 calls 에 남는다.
 */
function fakePaseo(calls: string[], directory: string, options: { running?: { id: string; workspaceId: string; title?: string }[] } = {}): Fake {
  return {
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: directory, projectDisplayName: "p" }] }) },
    providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
    workspaces: {
      list: async () => ({
        entries: [
          {
            id: "human",
            projectId: "p",
            name: "feature",
            title: "알림 수신 동의 앱",
            workspaceKind: "worktree",
            workspaceDirectory: directory,
            projectRootPath: directory,
            archivingAt: null,
          },
        ],
      }),
      ref: (id: string) => ({
        id,
        agents: {
          create: async (input: Fake) => {
            calls.push(`create-agent ${id} ${input.title}`);
            return { id: "agentN" };
          },
        },
        setTitle: async () => void calls.push(`set-title ${id}`),
        archive: async () => (calls.push(`archive-ws ${id}`), {}),
      }),
      create: async () => {
        calls.push("create-ws");
        return { id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } };
      },
    },
    agents: {
      list: async () => ({
        entries: (options.running ?? []).map((agent) => ({ agent: { ...agent, cwd: directory, archivedAt: null, status: "running" } })),
      }),
      ref: (id: string) => ({
        send: async (text: string) => void calls.push(`send ${id}: ${text}`),
        archive: async () => (calls.push(`archive ${id}`), {}),
        refresh: async () => ({ agent: { status: "running", cwd: directory } }),
      }),
    },
  };
}

describe("기존 워크스페이스 배정", () => {
  const waiting = { status: "waiting", agentId: null, workspaceId: null, branch: null };

  test("깨끗한 기존 워크스페이스에서는 새 worktree 없이 그 워크스페이스에 워커 세션을 만들고, 커밋까지만 하라고 한다", async () => {
    const directory = await humanRepo();
    const head = git(directory, "rev-parse", "HEAD");
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [waiting])));
    await new Dispatcher(store, workerSettings, channel, () => {}).run(fakePaseo(calls, directory));
    const task = (await first(store)).tasks[0]!;
    assert.ok(!calls.includes("create-ws"), calls.join("\n"));
    assert.ok(!calls.some((call) => call.startsWith("set-title")), "사람의 워크스페이스 제목을 바꾸면 안 된다");
    assert.ok(calls.some((call) => call.startsWith("create-agent human 알림 설정 · 1 작업1")));
    assert.equal(task.status, "running");
    assert.equal(task.workspaceId, "human");
    assert.equal(task.branch, "feature");
    assert.equal(task.baseBranch, null);
    assert.equal(task.startCommit, head);
    const kickoff = calls.find((call) => call.startsWith("send agentN"))!;
    assert.match(kickoff, /human's own workspace/);
    assert.match(kickoff, /Do not push and do not open a pull request/);
    assert.doesNotMatch(kickoff, /gh pr create/);
  });

  test("커밋하지 않은 변경이 있으면 워커를 만들지 않고 대기로 두며 이유를 남기고, 정리되면 시작한다", async () => {
    const directory = await humanRepo();
    await writeFile(join(directory, "wip.txt"), "사람이 하던 일");
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [waiting])));
    const dispatcher = new Dispatcher(store, workerSettings, channel, () => {});
    await dispatcher.run(fakePaseo(calls, directory));
    let task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "waiting");
    assert.match(task.note ?? "", /커밋하지 않은 변경/);
    assert.ok(!calls.some((call) => call.startsWith("create-agent")));
    git(directory, "add", "wip.txt");
    git(directory, "commit", "-m", "사람이 커밋");
    await dispatcher.run(fakePaseo(calls, directory));
    task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "running");
    assert.equal(task.note, null);
  });

  test("다른 에이전트가 그 워크스페이스에서 일하는 중이면 기다린다", async () => {
    const directory = await humanRepo();
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [waiting])));
    await new Dispatcher(store, workerSettings, channel, () => {}).run(
      fakePaseo(calls, directory, { running: [{ id: "a1", workspaceId: "human", title: "사람의 세션" }] }),
    );
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "waiting");
    assert.match(task.note ?? "", /다른 에이전트가 일하고 있어요 \(사람의 세션\)/);
    assert.ok(!calls.some((call) => call.startsWith("create-agent")));
  });

  test("읽기 조사는 아무것도 바꾸지 않아 커밋하지 않은 변경이 있어도 기다리지 않는다", async () => {
    const directory = await humanRepo();
    await writeFile(join(directory, "wip.txt"), "x");
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ kind: "read", grade: null }, [waiting])));
    await new Dispatcher(store, workerSettings, channel, () => {}).run(fakePaseo(calls, directory));
    assert.equal((await first(store)).tasks[0]!.status, "running");
  });

  test("워크스페이스가 닫혔거나 브랜치가 아니면(detached HEAD) 막힘으로 둔다", async () => {
    const directory = await humanRepo();
    git(directory, "checkout", "--detach");
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [waiting])));
    await new Dispatcher(store, workerSettings, channel, () => {}).run(fakePaseo(calls, directory));
    const detached = (await first(store)).tasks[0]!;
    assert.equal(detached.status, "blocked");
    assert.match(detached.note ?? "", /detached HEAD/);

    const { store: gone, channel: goneChannel } = await storeWith(state(request({}, [{ ...waiting, existingWorkspaceId: "closed" }])));
    await new Dispatcher(gone, workerSettings, goneChannel, () => {}).run(fakePaseo(calls, directory));
    const closed = (await first(gone)).tasks[0]!;
    assert.equal(closed.status, "blocked");
    assert.match(closed.note ?? "", /closed is not an active workspace/);
  });

  test("기존 워크스페이스의 앞 작업을 이어 쓰는 뒤 작업도 그 워크스페이스에서 일한다", async () => {
    const directory = await humanRepo();
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(
        request({}, [
          { status: "done", completion: null },
          { ...waiting, dependsOn: [1], existingWorkspaceId: null },
        ]),
      ),
    );
    await new Dispatcher(store, workerSettings, channel, () => {}).run(fakePaseo(calls, directory));
    const task = (await first(store)).tasks[1]!;
    assert.equal(task.existingWorkspaceId, "human");
    assert.equal(task.workspaceId, "human");
    assert.ok(!calls.includes("create-ws"));
  });
});

describe("기존 워크스페이스 완료와 정리", () => {
  const report = { summary: "고쳤어요", verification: ["테스트 통과"], choices: [], left: [], noPullRequestReason: null };

  test("코드 작업은 커밋을 남기면 PR 없이 확인 카드가 되고, 커밋하지 않은 변경이나 다른 브랜치면 받지 않는다", async () => {
    const directory = await humanRepo();
    const startCommit = git(directory, "rev-parse", "HEAD");
    const { store } = await storeWith(state(request({}, [{ startCommit }])));

    await writeFile(join(directory, "fix.txt"), "x");
    const dirty = await recordCompletion(store, { id: "w1", cwd: directory }, report);
    assert.equal(dirty.isError, true);
    assert.match(dirty.text, /Commit your changes on feature/);
    assert.match(dirty.text, /not yours, do not commit, undo or stash/);

    git(directory, "add", "fix.txt");
    git(directory, "commit", "-m", "fix");
    git(directory, "checkout", "-b", "other");
    const moved = await recordCompletion(store, { id: "w1", cwd: directory }, report);
    assert.equal(moved.isError, true);
    assert.match(moved.text, /Do not switch branches/);

    git(directory, "checkout", "feature");
    const recorded = await recordCompletion(store, { id: "w1", cwd: directory }, report);
    assert.notEqual(recorded.isError, true, recorded.text);
    assert.match(recorded.text, /do not push/);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.completion!.noPrSource, "existingWorkspace");
    assert.equal(task.completion!.pr, null);
    assert.equal(task.completion!.unpublished, null);
    assert.equal(completionNeedsDecision(task), false);
  });

  test("커밋 없이 끝나면 바뀐 것 없음으로 기록한다", async () => {
    const directory = await humanRepo();
    const startCommit = git(directory, "rev-parse", "HEAD");
    const { store } = await storeWith(state(request({}, [{ startCommit }])));
    const recorded = await recordCompletion(store, { id: "w1", cwd: directory }, report);
    assert.notEqual(recorded.isError, true, recorded.text);
    assert.equal((await first(store)).tasks[0]!.completion!.noPrSource, "noChanges");
  });

  test("운영 작업이 사람의 워크스페이스 파일이 바뀐 것을 보면 남의 변경은 건드리지 말라고 한다", async () => {
    const directory = await humanRepo();
    await writeFile(join(directory, "human.txt"), "x");
    const { store } = await storeWith(state(request({}, [{ kind: "operation", targets: ["앱 실행"] }])));
    const refused = await recordCompletion(store, { id: "w1", cwd: directory }, report);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /undo only your own changes/);
    assert.match(refused.text, /If you did not, leave them/);
  });

  test("카드를 닫으면 워커 세션만 닫고 사람의 워크스페이스와 브랜치는 그대로 두며, 사슬 밖의 작업은 끝내지 않는다", async () => {
    const directory = await humanRepo();
    const calls: string[] = [];
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, noPrSource: "existingWorkspace", at: now() };
    const { store, channel } = await storeWith(
      state(
        request({}, [
          { status: "done", completion: { ...completion, noPrSource: null } },
          { status: "review", dependsOn: [1], completion },
          { status: "waiting", dependsOn: [2], kind: "operation", targets: ["앱 실행"], agentId: null, workspaceId: null },
        ]),
      ),
    );
    await new CompletionRunner(store, channel, () => {}).close(fakePaseo(calls, directory), {
      requestId: "r1",
      taskNumber: 2,
      action: "merge",
      instruction: null,
    });
    assert.ok(!calls.some((call) => call.startsWith("archive-ws")), calls.join("\n"));
    assert.ok(calls.includes("archive w1") && calls.includes("archive w2"), calls.join("\n"));
    assert.equal(git(directory, "rev-parse", "--abbrev-ref", "HEAD"), "feature");
    const tasks = (await first(store)).tasks;
    assert.equal(tasks[1]!.status, "done");
    assert.match(tasks[1]!.decisions.at(-1)!.summary, /Confirmed the commits on feature/);
    assert.equal(tasks[2]!.status, "waiting", "같은 워크스페이스의 뒤 운영 작업은 함께 끝나면 안 된다");
  });

  test("조사 정리와 다시 시작은 사람의 워크스페이스를 archive 하지 않는다", async () => {
    const calls: string[] = [];
    const tasks = state(request({ kind: "read" }, [{ status: "done" }])).requests[0]!.tasks;
    await cleanupTaskWorkspaces(fakePaseo(calls, "/nonexistent"), tasks);
    assert.deepEqual(calls, ["archive w1"]);

    const { store } = await storeWith(state(request({}, [{ status: "blocked", agentId: null }])));
    const { orphanWorkspaceId } = await retryTask({ requestId: "r1", taskNumber: 1, instruction: null }, store);
    assert.equal(orphanWorkspaceId, null);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.existingWorkspaceId, "human");
    assert.equal(task.status, "waiting");
  });
});

describe("기존 워크스페이스 지정", () => {
  const settings: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"], outputLanguage: "ko" } }) };

  test("새 요청은 고른 프로젝트에만, 기준 브랜치와 겹치지 않게, 쓸 수 있는 워크스페이스만 받는다", async () => {
    const { store } = await storeWith(state());
    const base = { text: "고쳐줘", doneCriteria: null, projectIds: ["p"], baseBranches: {}, workspaces: {}, locale: "ko" };
    await assert.rejects(createRequest({ ...base, projectIds: [], workspaces: { p: "human" } }, store, settings), /요청에 없는 프로젝트/);
    await assert.rejects(createRequest({ ...base, baseBranches: { p: "dev" }, workspaces: { p: "human" } }, store, settings), /하나만/);
    await assert.rejects(
      createRequest({ ...base, workspaces: { p: "human" } }, store, settings, undefined, async () => "workspace human is not a git checkout"),
      /not a git checkout/,
    );
    const { id } = await createRequest({ ...base, workspaces: { p: "human" } }, store, settings);
    assert.deepEqual((await store.read()).requests.find((item) => item.id === id)!.workspaces, { p: "human" });
  });

  test("같은 기존 워크스페이스의 작업은 의존으로 앞뒤가 정해져야 하고, 읽기 조사는 함께 돌아도 된다", () => {
    const task = (number: number, dependsOn: number[] = [], extra: Record<string, unknown> = {}) => ({
      number,
      name: `작업${number}`,
      projectId: "p",
      dependsOn,
      ...extra,
    });
    const usable = new Set(["p"]);
    const human = { p: "human" };
    const parallel = validatePlan({ title: "알림 설정", tasks: [task(1), task(2)] }, "ko", usable, [], human);
    assert.ok(parallel.some((problem) => /both work in existing workspace human/.test(problem)), parallel.join("\n"));
    assert.deepEqual(validatePlan({ title: "알림 설정", tasks: [task(1), task(2, [1])] }, "ko", usable, [], human), []);
    assert.deepEqual(validatePlan({ title: "알림 설정", readOnly: true, tasks: [task(1), task(2)] }, "ko", usable, [], human), []);
    // 운영 작업은 이어 쓰지 않지만 같은 워크스페이스를 쓰므로 순서가 필요하다.
    const operation = validatePlan(
      { title: "알림 설정", tasks: [task(1, [], { workspaceId: "human" }), task(2, [], { kind: "operation", targets: ["x"], workspaceId: "human" })] },
      "ko",
      usable,
    );
    assert.ok(operation.some((problem) => /both work in existing workspace human/.test(problem)));
    // 새 worktree 를 이어 쓰는 작업에 다른 워크스페이스를 적으면 거절한다.
    const mismatch = validatePlan({ title: "알림 설정", tasks: [task(1), task(2, [1], { workspaceId: "human" })] }, "ko", usable);
    assert.ok(mismatch.some((problem) => /continues task 1's new worktree/.test(problem)), mismatch.join("\n"));
    // 이미 끝난 앞 작업과는 순서를 따지지 않는다.
    const existing = [{ number: 1, projectId: "p", dependsOn: [], status: "review", existingWorkspaceId: "human" }];
    assert.deepEqual(validatePlan({ title: "알림 설정", tasks: [task(2)] }, "ko", usable, existing, human), []);
  });

  test("코디네이터가 고른 워크스페이스는 사람이 그 경로를 본 질문에 답한 뒤에만 쓸 수 있다", async () => {
    const directory = await humanRepo();
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, plannedAt: null, grade: null, title: null }, [])));
    const runtime = new CoordinatorRuntime(
      store,
      { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"] } }) } as Fake,
      () => calls.push("dispatch"),
      channel,
    );
    const submit = runtime.tools().find((item) => item.name === "coordinator_submit_plan")!;
    const context: Fake = { paseo: fakePaseo(calls, directory), agent: { id: "c1" } };
    const plan = {
      requestId: "r1",
      readOnly: false,
      beforeChange: false,
      title: "알림 설정",
      grade: "C",
      gradeReasons: ["이유"],
      recommendation: "추천",
      risks: [],
      unknowns: [],
      tasks: [{ number: 1, name: "화면 수정", projectId: "p", dependsOn: [], kind: "code", targets: [], scope: "범위", doneCriteria: "기준", requestRefs: ["고쳐줘"], workspaceId: "human" }],
    };
    const early = await submit.execute(plan, context);
    assert.match(String(early.text), /needs their approval/);
    assert.match(String(early.text), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const ask = async (text: string) => {
      const question = { context: text, questions: [{ question: "q", options: [{ label: "예" }, { label: "아니오" }], recommended: null }], projectIds: [], at: now() };
      await store.update((value) => ({
        state: { ...value, requests: value.requests.map((item) => ({ ...item, status: "needs_input" as const, question })) },
        result: undefined,
      }));
      await answerQuestions({ id: "r1", answers: [{ question: "q", answer: "예" }] }, store);
      // 코디네이터는 알림을 받으면 요청을 다시 읽고 계획한다.
      await runtime.tools().find((item) => item.name === "coordinator_get_request")!.execute({ requestId: "r1" }, context);
    };
    await ask("기존 워크스페이스에서 할까요?");
    const unseen = await submit.execute(plan, context);
    assert.match(String(unseen.text), /did not show these workspace directories/);

    await ask(`워크스페이스 ${directory} 에서 일합니다`);
    const accepted = await submit.execute(plan, context);
    assert.notEqual(accepted.isError, true, String(accepted.text));
    assert.equal((await first(store)).tasks[0]!.existingWorkspaceId, "human");
  });

  test("사람이 고른 워크스페이스는 묻지 않고 그 프로젝트의 모든 작업에 쓰이며, 다른 워크스페이스나 기준 브랜치는 거절한다", async () => {
    const directory = await humanRepo();
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(request({ status: "planning", kind: null, plannedAt: null, grade: null, title: null, workspaces: { p: "human" } }, [])),
    );
    const runtime = new CoordinatorRuntime(
      store,
      { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"] } }) } as Fake,
      () => calls.push("dispatch"),
      channel,
    );
    const submit = runtime.tools().find((item) => item.name === "coordinator_submit_plan")!;
    const context: Fake = { paseo: fakePaseo(calls, directory), agent: { id: "c1" } };
    const plan = (task: Record<string, unknown>) => ({
      requestId: "r1",
      readOnly: false,
      beforeChange: false,
      risks: [],
      unknowns: [],
      title: "알림 설정",
      grade: "C",
      gradeReasons: ["이유"],
      recommendation: "추천",
      tasks: [{ number: 1, name: "화면 수정", projectId: "p", dependsOn: [], kind: "code", targets: [], scope: "범위", doneCriteria: "기준", requestRefs: ["고쳐줘"], ...task }],
    });
    assert.match(String((await submit.execute(plan({ workspaceId: "other" }), context)).text), /the human chose workspace human/);
    assert.match(String((await submit.execute(plan({ baseBranch: "main" }), context)).text), /omit baseBranch/);
    const accepted = await submit.execute(plan({}), context);
    assert.notEqual(accepted.isError, true, String(accepted.text));
    assert.equal((await first(store)).tasks[0]!.existingWorkspaceId, "human");
  });

  test("플러그인이 다른 작업에 만든 worktree 는 기존 워크스페이스로 고를 수 없다", async () => {
    const directory = await humanRepo();
    const { store, channel } = await storeWith(
      state(
        request({ id: "r0", status: "running" }, [{ workspaceId: "human", existingWorkspaceId: null, branch: "coord/r0-1-x" }]),
        { ...request({ status: "planning", kind: null, plannedAt: null, grade: null, title: null, workspaces: { p: "human" } }, []) },
      ),
    );
    const runtime = new CoordinatorRuntime(store, { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"] } }) } as Fake, () => {}, channel);
    const submit = runtime.tools().find((item) => item.name === "coordinator_submit_plan")!;
    const result = await submit.execute(
      {
        requestId: "r1",
        readOnly: false,
        beforeChange: false,
        risks: [],
        unknowns: [],
        title: "알림 설정",
        grade: "C",
        gradeReasons: ["이유"],
        recommendation: "추천",
        tasks: [{ number: 1, name: "화면 수정", projectId: "p", dependsOn: [], kind: "code", targets: [], scope: "범위", doneCriteria: "기준", requestRefs: ["고쳐줘"] }],
      },
      { paseo: fakePaseo([], directory), agent: { id: "c1" } } as Fake,
    );
    assert.match(String(result.text), /worktree the plugin made for another task/);
  });

  test("humanGateProblems 는 승인할 워크스페이스가 없으면 아무것도 막지 않는다", () => {
    const value = state(request({ feedback: [] }, [])).requests[0]!;
    assert.deepEqual(humanGateProblems(value, [{ kind: "code" }], "C", null, []), []);
  });
});
