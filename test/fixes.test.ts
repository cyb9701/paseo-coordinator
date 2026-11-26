/// <reference types="node" />

/**
 * 2026-11-26 두 번째 전수 검사에서 찾은 '사람의 의도와 다르게 흐르는' 경로의 회귀 테스트. 항목마다 한 번 실패했던 조건을 남긴다.
 * 서버 코드를 그대로 부르고 Paseo API 만 가짜로 둔다. git 이 필요한 경로는 임시 저장소를 만든다. 실행: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { cleanupTaskWorkspaces } from "../server/cleanup";
import { CompletionRunner, deleteBranchIfPublished, finishRequestIfDone, quotesRequest, recordCompletion, uncommittedChanges } from "../server/completion";
import { CoordinatorRuntime, humanGateProblems, validatePlan } from "../server/coordinator";
import { Dispatcher } from "../server/dispatcher";
import { answerQuestions, cancelTask, retryTask, revisePlan } from "../server/requests";
import { ReviewRunner } from "../server/review";
import { StateStore } from "../server/store";
import { WorkerChannel } from "../server/worker-channel";
import { type CoordinatorState, completionNeedsDecision, revertRoute, stateSchema } from "../shared/model";

type Fake = any;

const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function request(extra: Record<string, unknown>, tasks: Record<string, unknown>[]): Record<string, unknown> {
  return {
    id: "r1",
    text: "브랜치를 정리해줘. 커밋은 하지 마.",
    doneCriteria: null,
    projectIds: [],
    language: "ko",
    createdAt: ago(30),
    status: "running",
    kind: "change",
    grade: "C",
    title: "브랜치 정리",
    plannedAt: ago(20),
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
      branch: `coord/r1-${index + 1}-x`,
      ...task,
    })),
  };
}

function state(...requests: Record<string, unknown>[]): CoordinatorState {
  return stateSchema.parse({ requests, sent: [] });
}

async function storeWith(value: CoordinatorState) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-fix-"));
  await writeFile(join(directory, "state.json"), JSON.stringify(value));
  const store = new StateStore(directory);
  return { store, channel: new WorkerChannel(store) };
}

const first = async (store: StateStore) => (await store.read()).requests[0]!;

/** 가짜 Paseo. agents 의 상태, 백그라운드 작업, 타임라인을 에이전트마다 줄 수 있다. 호출은 calls 에 남긴다. */
function fakePaseo(
  calls: string[],
  options: {
    status?: string;
    background?: number;
    timeline?: Record<string, unknown[]>;
    cwd?: string;
    onRefetch?: () => Promise<void>;
  } = {},
): Fake {
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({
          agent: {
            status: options.status ?? "idle",
            pendingPermissions: [],
            archivedAt: null,
            cwd: options.cwd ?? "/nonexistent",
            backgroundWork: { count: options.background ?? 0 },
          },
        }),
        send: async (text: string) => void calls.push(`send ${id}: ${text}`),
        archive: async () => (calls.push(`archive ${id}`), {}),
        reload: async () => void calls.push(`reload ${id}`),
        timeline: {
          refetch: async () => {
            await options.onRefetch?.();
            return { entries: (options.timeline?.[id] ?? []).map((item) => ({ item })) };
          },
        },
      }),
    },
    workspaces: { ref: (id: string) => ({ archive: async () => (calls.push(`archive-ws ${id}`), {}) }) },
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: options.cwd ?? "/nonexistent", projectDisplayName: "p" }] }) },
    providers: { listModes: async () => ({ modes: [] }) },
  };
}

const ready: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"] } }) };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" }).toString();

/** origin 이 있는 임시 저장소. main 은 원격에 있고, 작업 브랜치 두 개를 만든다: pushed(커밋 없음), unpushed(원격에 없는 커밋). */
async function repo(): Promise<string> {
  const origin = await mkdtemp(join(tmpdir(), "coordinator-fix-origin-"));
  git(origin, "init", "--bare", "-b", "main");
  const work = await mkdtemp(join(tmpdir(), "coordinator-fix-work-"));
  git(work, "clone", origin, ".");
  git(work, "commit", "--allow-empty", "-m", "init");
  git(work, "push", "origin", "main");
  git(work, "branch", "pushed", "main");
  git(work, "checkout", "-b", "unpushed", "main");
  git(work, "commit", "--allow-empty", "-m", "local only");
  git(work, "checkout", "main");
  return work;
}

function coordinatorTools(store: StateStore, channel: WorkerChannel, calls: string[], canceled: unknown[] = []) {
  const runtime = new CoordinatorRuntime(store, ready, () => calls.push("dispatch"), channel, (_paseo, ...args) => canceled.push(args));
  const tool = (name: string) => runtime.tools().find((item) => item.name === name)!;
  return { runtime, tool };
}

const planTask = (extra: Record<string, unknown> = {}) => ({
  number: 1,
  name: "브랜치 삭제",
  projectId: "p",
  dependsOn: [],
  kind: "code",
  targets: [],
  scope: "범위",
  doneCriteria: "기준",
  requestRefs: ["정리해줘"],
  ...extra,
});

const plan = (extra: Record<string, unknown> = {}) => ({
  requestId: "r1",
  readOnly: false,
  beforeChange: false,
  title: "브랜치 정리",
  grade: "C",
  gradeReasons: ["이유"],
  recommendation: "추천",
  risks: [],
  unknowns: [],
  tasks: [planTask()],
  ...extra,
});

describe("사람의 지시가 버려지지 않는다", () => {
  test("읽기 조사가 도는 중에 온 지시는 조사가 끝나면 답변 카드가 아니라 코디네이터에게 돌아간다", async () => {
    const { store, channel } = await storeWith(
      state(request({ kind: "read", grade: null, feedback: [{ text: "끝나면 그대로 지워줘", at: ago(5), kind: "instruction" }] }, [{}])),
    );
    const returned: string[] = [];
    const dispatcher = new Dispatcher(store, ready, channel, () => {}, (_paseo, id) => returned.push(id));
    await dispatcher.onWorkerTurn(fakePaseo([], { timeline: { w1: [{ type: "assistant_message", text: "후보: a" }] } }), "w1", { kind: "completed" }, false);
    const after = await first(store);
    assert.equal(after.status, "planning");
    assert.equal(after.answer, null);
    assert.match(after.investigation?.text ?? "", /후보: a/);
    assert.deepEqual(returned, ["r1"]);
  });

  test("일반 읽기 조사의 답변에는 코디네이터의 해석과 가정이 옮겨진다", async () => {
    const { store, channel } = await storeWith(state(request({ kind: "read", grade: null, unknowns: ["실행은 후속 지시가 필요"] }, [{}])));
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(fakePaseo([]), "w1", { kind: "completed" }, false);
    const after = await first(store);
    assert.equal(after.status, "answered");
    assert.deepEqual(after.answer?.unknowns, ["실행은 후속 지시가 필요"]);
  });

  test("보고를 모으는 사이 요청이 취소되면 답변으로 되살리지 않는다", async () => {
    const { store, channel } = await storeWith(state(request({ kind: "read", grade: null }, [{}])));
    const paseo = fakePaseo([], {
      onRefetch: () =>
        store.update((value) => ({ state: { ...value, requests: value.requests.map((item) => ({ ...item, status: "canceled" as const })) }, result: undefined })),
    });
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(paseo, "w1", { kind: "completed" }, false);
    assert.equal((await first(store)).status, "canceled");
  });

  test("질문 카드가 열린 요청은 작업이 다 끝나도 끝내지 않고, 답을 코디네이터가 읽은 뒤에 끝낸다", async () => {
    const question = { context: "c", questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }], recommended: null }], projectIds: [], at: ago(2) };
    const { store, channel } = await storeWith(
      state(request({ question }, [{ status: "done", completion: { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(3), closedAt: ago(1) } }])),
    );
    assert.equal(await finishRequestIfDone(store, "r1"), false);
    await answerQuestions({ id: "r1", answers: [{ question: "q", answer: "a" }] }, store);
    // 답은 왔지만 코디네이터가 아직 읽지 않았다.
    assert.equal(await finishRequestIfDone(store, "r1"), false);
    await store.update((value) => ({ state: { ...value, requests: value.requests.map((item) => ({ ...item, coordinatorReadAt: now() })) }, result: undefined }));
    let done = 0;
    await new Dispatcher(store, ready, channel, () => done++).settleRequest(fakePaseo([]), "r1");
    assert.equal((await first(store)).status, "done");
    assert.equal(done, 1);
  });

  test("질문이 열린 채 읽기 조사가 끝나면 답변 카드 대신 답을 기다린다", async () => {
    const question = { context: "c", questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }], recommended: null }], projectIds: [], at: ago(2) };
    const { store, channel } = await storeWith(state(request({ kind: "read", grade: null, question }, [{}])));
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(fakePaseo([]), "w1", { kind: "completed" }, false);
    const after = await first(store);
    assert.equal(after.status, "needs_input");
    assert.ok(after.question);
  });

  test("질문 카드의 직접 지시는 그 질문의 답으로 기록되고, 다른 곳의 지시는 질문을 닫지 않는다", async () => {
    const question = { context: "c", questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }], recommended: null }], projectIds: [], at: ago(2) };
    const { store } = await storeWith(state(request({ status: "needs_input", question, tasks: [] }, [])));
    // 계획 전 질문이 열려 있으면 보드의 지시는 받지 않고 질문 카드로 안내한다.
    await assert.rejects(revisePlan({ id: "r1", text: "보고서는 한국어로" }, store), /질문 카드/);
    await revisePlan({ id: "r1", text: "추천대로 다 지우고 X 만 남겨", answersQuestion: true }, store);
    const after = await first(store);
    assert.equal(after.feedback.at(-1)?.kind, "answer");
    assert.equal(after.question, null);
    assert.equal(after.lastQuestion?.context, "c");
    assert.equal(humanGateProblems(after, [], "A", null).length, 0);
    // 실행 중 요청의 질문은 보드의 지시로 닫히지 않고, 그 지시는 답이 아니다.
    const running = await storeWith(state(request({ question }, [{}])));
    await revisePlan({ id: "r1", text: "보고서는 한국어로" }, running.store);
    const kept = await first(running.store);
    assert.ok(kept.question);
    assert.equal(kept.feedback.at(-1)?.kind, "instruction");
    assert.equal(humanGateProblems(kept, [], "A", null).length, 1);
  });

  test("조사가 돌아온 요청은 사람이 답하기 전에는 답변으로 끝낼 수 없다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(request({ status: "planning", kind: "read", beforeChange: true, grade: "A", investigation: { text: "후보", at: ago(1) } }, [{ status: "done" }])),
    );
    const { tool } = coordinatorTools(store, channel, calls);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    const input = { requestId: "r1", title: "브랜치 정리", answer: "후보는 a 입니다", sources: ["조사"], unknowns: [], projectIds: [] };
    const rejected = await tool("coordinator_submit_answer").execute(input, context);
    assert.equal(rejected.isError, true);
    await store.update((value) => ({
      state: { ...value, requests: value.requests.map((item) => ({ ...item, feedback: [{ text: "q → 지우지 않음", at: now(), kind: "answer" as const }] })) },
      result: undefined,
    }));
    const accepted = await tool("coordinator_submit_answer").execute(input, context);
    assert.notEqual(accepted.isError, true, String(accepted.text));
    // 답이 대신한 조사 작업의 워크스페이스는 정리한다.
    assert.ok(calls.includes("archive-ws ws1"));
  });

  test("A 등급 관문은 조사 보고보다 앞선 답으로는 열리지 않는다", () => {
    const parsed = stateSchema.parse({
      requests: [request({ feedback: [{ text: "해석 → a", at: ago(10), kind: "answer" }], investigation: { text: "보고", at: ago(5) } }, [])],
      sent: [],
    }).requests[0]!;
    assert.equal(humanGateProblems(parsed, [], "A", parsed.investigation!.at).length, 1);
    assert.equal(humanGateProblems(parsed, [{ kind: "operation" }], "C", parsed.investigation!.at).length, 1);
    assert.equal(humanGateProblems(parsed, [], "C", parsed.investigation!.at).length, 0);
  });

  test("B~D 등급도 변경 전 조사를 할 수 있고, 돌아오면 사람에게 묻지 않고 계획할 수 있다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, grade: null, plannedAt: null, tasks: [] }, [])));
    const { tool } = coordinatorTools(store, channel, calls);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    const investigate = await tool("coordinator_submit_plan").execute(plan({ readOnly: true, beforeChange: true, grade: "C" }), context);
    assert.notEqual(investigate.isError, true, String(investigate.text));
    assert.equal((await first(store)).grade, "C");
    // 조사가 돌아왔다고 치고 C 등급 변경 계획을 바로 낸다.
    await store.update((value) => ({
      state: {
        ...value,
        requests: value.requests.map((item) => ({
          ...item,
          status: "planning" as const,
          investigation: { text: "보고", at: now() },
          tasks: item.tasks.map((task) => ({ ...task, status: "done" as const })),
        })),
      },
      result: undefined,
    }));
    const change = await tool("coordinator_submit_plan").execute(plan(), context);
    assert.notEqual(change.isError, true, String(change.text));
    assert.equal((await first(store)).kind, "change");
  });
});

describe("실행 중 요청의 작업 추가와 취소", () => {
  test("작업을 더하면 번호가 이어지고 계획 시각이 갱신되며, 운영 작업은 사람의 답 없이 더할 수 없다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [{}])));
    const { tool } = coordinatorTools(store, channel, calls);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    const before = (await first(store)).plannedAt;
    const wrongNumber = await tool("coordinator_add_tasks").execute({ requestId: "r1", reason: "추가", tasks: [planTask()] }, context);
    assert.equal(wrongNumber.isError, true);
    const added = await tool("coordinator_add_tasks").execute(
      { requestId: "r1", reason: "\"B 도 고쳐줘\"", tasks: [planTask({ number: 2, name: "B 수정", dependsOn: [1] })] },
      context,
    );
    assert.notEqual(added.isError, true, String(added.text));
    const after = await first(store);
    assert.equal(after.tasks.length, 2);
    assert.equal(after.tasks[1]!.status, "waiting");
    assert.ok(after.plannedAt! > before!);
    assert.ok(calls.includes("dispatch"));
    const operation = await tool("coordinator_add_tasks").execute(
      { requestId: "r1", reason: "정리", tasks: [planTask({ number: 3, name: "브랜치 정리", kind: "operation", targets: ["branch x"] })] },
      context,
    );
    assert.equal(operation.isError, true);
    assert.match(String(operation.text), /Operation tasks/);
  });

  test("작업을 취소하면 기대는 작업도 취소되고 워커가 정리되며, 머지를 기다리는 작업은 취소하지 않는다", async () => {
    const calls: string[] = [];
    const canceled: unknown[] = [];
    const { store, channel } = await storeWith(
      state(
        request({}, [
          { status: "review", completion: { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: now() } },
          { status: "running" },
          { status: "waiting", dependsOn: [2], agentId: null, workspaceId: null },
        ]),
      ),
    );
    const { tool } = coordinatorTools(store, channel, calls, canceled);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    const refused = await tool("coordinator_cancel_tasks").execute({ requestId: "r1", taskNumbers: [1], reason: "x" }, context);
    assert.equal(refused.isError, true);
    const result = await tool("coordinator_cancel_tasks").execute({ requestId: "r1", taskNumbers: [2], reason: "\"2 는 하지 마\"" }, context);
    assert.notEqual(result.isError, true, String(result.text));
    const after = await first(store);
    assert.deepEqual(after.tasks.map((task) => task.status), ["review", "canceled", "canceled"]);
    assert.equal(after.status, "running");
    assert.deepEqual(canceled, [["r1", ["w2"], false]]);
  });

  test("같은 프로젝트의 앞 작업 여럿에 기대는데 그 작업들이 한 사슬이 아니면 계획을 거절한다", () => {
    const task = (number: number, dependsOn: number[]) => ({ number, name: "작업", projectId: "p", dependsOn });
    const broken = validatePlan({ title: "제목", tasks: [task(1, []), task(2, []), task(3, [1, 2])] }, "ko", new Set(["p"]));
    assert.ok(broken.some((problem) => problem.includes("would not be there")));
    assert.deepEqual(validatePlan({ title: "제목", tasks: [task(1, []), task(2, [1]), task(3, [1, 2])] }, "ko", new Set(["p"])), []);
  });
});

describe("운영 작업", () => {
  test("운영 작업이 든 계획은 사람이 대상을 승인한 뒤에만 시작하고, 대상이 없으면 거절한다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, plannedAt: null, tasks: [] }, [])));
    const { tool } = coordinatorTools(store, channel, calls);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    const noTargets = await tool("coordinator_submit_plan").execute(plan({ tasks: [planTask({ kind: "operation" })] }), context);
    assert.match(String(noTargets.text), /must list its targets/);
    const operation = plan({ tasks: [planTask({ kind: "operation", targets: ["로컬 브랜치 coord/r12-1-jgrq 삭제"] })] });
    const early = await tool("coordinator_submit_plan").execute(operation, context);
    assert.match(String(early.text), /Operation tasks/);
    // 대상을 보여 주지 않은 질문의 답으로는 시작하지 않는다.
    await answerQuestions({ id: "r1", answers: [{ question: "q", answer: "승인" }] }, await askAt(store, "브랜치를 정리할까요?"));
    await tool("coordinator_get_request").execute({ requestId: "r1" }, context);
    const unseen = await tool("coordinator_submit_plan").execute(operation, context);
    assert.match(String(unseen.text), /did not list these operation targets/);
    await answerQuestions({ id: "r1", answers: [{ question: "q", answer: "승인" }] }, await askAt(store, "지울 것: 로컬 브랜치 coord/r12-1-jgrq 삭제"));
    await tool("coordinator_get_request").execute({ requestId: "r1" }, context);
    const accepted = await tool("coordinator_submit_plan").execute(operation, context);
    assert.notEqual(accepted.isError, true, String(accepted.text));
    assert.equal((await first(store)).tasks[0]!.kind, "operation");
  });

  test("운영 작업 킥오프는 승인된 대상만 worktree 밖에서 허용하고 PR 을 요구하지 않는다", async () => {
    const sent: string[] = [];
    const { store, channel } = await storeWith(
      state(request({}, [{ status: "waiting", agentId: null, workspaceId: null, branch: null, kind: "operation", targets: ["원격 브랜치 old 삭제"] }])),
    );
    const values = { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: true };
    const paseo: Fake = {
      projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/repo" }] }) },
      providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
      workspaces: { create: async () => ({ id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } }) },
      agents: { ref: () => ({ send: async (text: string) => void sent.push(text), commands: async () => ({ commands: [{ name: "poteto-mode" }] }) }) },
    };
    await new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {}).run(paseo);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /only these: "원격 브랜치 old 삭제"/);
    assert.match(sent[0]!, /No pull request is needed/);
    assert.doesNotMatch(sent[0]!, /Work only inside this worktree/);
    assert.doesNotMatch(sent[0]!, /poteto-mode/);
  });

  test("운영 작업의 완료는 PR 없이 기록되고, worktree 파일을 바꿨으면 받지 않는다", async () => {
    const root = await repo();
    await writeFile(join(root, "paseo.json"), "{}");
    const { store } = await storeWith(state(request({}, [{ kind: "operation", targets: ["x"], branch: "main" }])));
    const report = { summary: "지웠어요", verification: ["x: 지움"], choices: [], left: [], noPullRequestReason: null };
    const recorded = await recordCompletion(store, { id: "w1", cwd: root }, report);
    assert.notEqual(recorded.isError, true, recorded.text);
    const completion = (await first(store)).tasks[0]!.completion!;
    assert.equal(completion.noPrSource, "operation");
    assert.equal(completion.pr, null);
    assert.equal(completionNeedsDecision((await first(store)).tasks[0]!), false);
    await writeFile(join(root, "changed.txt"), "x");
    const { store: second } = await storeWith(state(request({}, [{ kind: "operation", targets: ["x"], branch: "main" }])));
    const refused = await recordCompletion(second, { id: "w1", cwd: root }, report);
    assert.equal(refused.isError, true);
  });
});

/** 코디네이터가 이 context 로 질문 카드를 띄운 것처럼 만든다. 질문 카드에 답하는 흐름을 짧게 만들 때 쓴다. */
async function askAt(store: StateStore, context: string): Promise<StateStore> {
  // 카드는 배경을 접어 두므로 승인 관문은 질문과 선택지만 본다. 대상은 선택지 설명에 넣는다.
  const question = { context, questions: [{ question: "q", options: [{ label: "승인", description: context }, { label: "아니오" }], recommended: null }], projectIds: [], at: now() };
  await store.update((value) => ({
    state: { ...value, requests: value.requests.map((item) => ({ ...item, status: "needs_input" as const, question })) },
    result: undefined,
  }));
  return store;
}

describe("자동 결정 되돌리기와 워커 메시지", () => {
  const decision = (id: string, rule = "W5") => ({
    id,
    rule,
    question: "q",
    answer: "a",
    evidence: [],
    undo: "u",
    verdicts: [],
    at: ago(5),
    reviewedAt: null,
    reverted: false,
  });

  test("머지한 작업의 결정은 되돌리지 않고 잘못된 결정으로만 표시하며 아무에게도 보내지 않는다", async () => {
    const calls: string[] = [];
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(3), closedAt: ago(2) };
    const { store, channel } = await storeWith(state(request({}, [{ status: "done", completion, autoDecisions: [decision("d1")] }])));
    await new ReviewRunner(store, ready, channel).reviewAutoDecision(fakePaseo(calls), { requestId: "r1", taskNumber: 1, id: "d1", revertText: "틀렸어" });
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "done");
    assert.equal(task.outbox.length, 0);
    assert.ok(task.autoDecisions[0]!.reverted);
    assert.match(task.decisions.at(-1)!.summary, /^Marked wrong/);
    assert.equal(calls.filter((call) => call.startsWith("send")).length, 0);
  });

  test("이어 쓰기로 끝난 앞 작업의 결정을 되돌리면 지금 그 worktree 를 쓰는 뒤 작업의 워커에게 보낸다", async () => {
    const calls: string[] = [];
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(3) };
    const { store, channel } = await storeWith(
      state(request({}, [{ status: "done", completion, autoDecisions: [decision("d1")] }, { status: "running", dependsOn: [1], workspaceId: "ws1" }])),
    );
    const route = revertRoute((await first(store)), (await first(store)).tasks[0]!);
    assert.deepEqual(route, { kind: "successor", taskNumber: 2, waitsForDecision: false });
    await new ReviewRunner(store, ready, channel).reviewAutoDecision(fakePaseo(calls), { requestId: "r1", taskNumber: 1, id: "d1", revertText: "되돌려" });
    const after = await first(store);
    assert.equal(after.tasks[0]!.status, "done");
    assert.ok(calls.some((call) => call.startsWith("send w2: [From the human] The earlier automatic decision on task 1")));
    assert.ok(!calls.some((call) => call.startsWith("send w1")));
  });

  test("결정 카드가 열린 작업에는 메시지를 보내지 않고, 사람의 결정과 함께 보낸다", async () => {
    const calls: string[] = [];
    const blocker = { kind: "question", summary: "s", facts: ["f"], options: [], workerRecommendation: null, at: ago(1) };
    const { store, channel } = await storeWith(state(request({}, [{ status: "blocked", blocker, outbox: [{ text: "먼저 온 지시", at: ago(1) }] }])));
    assert.equal(await channel.flush(fakePaseo(calls), "r1", 1), false);
    assert.equal(calls.length, 0);
    assert.equal((await first(store)).tasks[0]!.outbox.length, 1);
  });

  test("이 요청에서 되돌린 규칙은 요청이 끝날 때까지 자동 처리하지 않는다 (RULES.md §8)", async () => {
    const reverted = { ...decision("d1", "W1"), reverted: true };
    const { store, channel } = await storeWith(state(request({}, [{ autoDecisions: [reverted] }, {}])));
    const current = await store.read();
    const runner = new ReviewRunner(store, ready, channel);
    assert.match(runner.precheck(current, current.requests[0]!, current.requests[0]!.tasks[1]!, "W1") ?? "", /§8/);
    assert.equal(runner.precheck(current, current.requests[0]!, current.requests[0]!.tasks[1]!, "W5"), null);
  });

  test("설정에서 자동 답변을 끄면 코디네이터의 자동 답 제안을 받지 않는다 (RULES.md §8)", async () => {
    const calls: string[] = [];
    const blocker = { kind: "question", summary: "s", facts: ["f"], options: [], workerRecommendation: null, at: ago(1) };
    const { store, channel } = await storeWith(state(request({}, [{ status: "blocked", blocker }])));
    const off: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"], autoDecisions: false } }) };
    const runtime = new CoordinatorRuntime(store, off, () => {}, channel);
    runtime.setReviewRunner(new ReviewRunner(store, off, channel));
    const propose = runtime.tools().find((item) => item.name === "coordinator_propose_answer")!;
    const result = await propose.execute(
      { requestId: "r1", taskNumber: 1, rule: "W1", answer: "a", evidence: [{ fact: "f", source: "s" }], undo: "u", selfCheck: ["1", "2", "3", "4", "5", "6"] },
      { paseo: fakePaseo(calls), agent: { id: "c1" } } as Fake,
    );
    assert.equal(result.isError, true);
    assert.match(String(result.text), /switched automatic answers off/);
    assert.equal((await first(store)).tasks[0]!.blocker?.proposal, null);
  });

  test("취소된 작업과 읽기 조사 워커에게는 코디네이터가 메시지를 보낼 수 없다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [{ status: "canceled" }]), { ...request({ kind: "read", grade: null }, [{}]), id: "r2", coordinatorAgentId: "c1" }));
    const { tool } = coordinatorTools(store, channel, calls);
    const context: Fake = { paseo: fakePaseo(calls), agent: { id: "c1" } };
    assert.equal((await tool("coordinator_message_worker").execute({ requestId: "r1", taskNumber: 1, message: "m" }, context)).isError, true);
    assert.equal((await tool("coordinator_message_worker").execute({ requestId: "r2", taskNumber: 1, message: "m" }, context)).isError, true);
  });

  test("PR 없이 끝내라는 요청의 머지 카드 수정 지시는 push 하라고 하지 않는다", async () => {
    const calls: string[] = [];
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, noPrReason: "커밋은 하지 마", noPrSource: "request", unpublished: "x", at: ago(1) };
    const { store, channel } = await storeWith(state(request({}, [{ status: "review", completion }])));
    await new CompletionRunner(store, channel, () => {}).close(fakePaseo(calls), { requestId: "r1", taskNumber: 1, action: "revise", instruction: "문구 고쳐" });
    const sent = calls.find((call) => call.startsWith("send w1"))!;
    assert.match(sent, /do not commit, push or open a pull request/);
    assert.doesNotMatch(sent, /verify it, push/);
  });

  test("검토를 마무리하기 전에 워커가 다시 보고했으면 자동 답을 보내지 않는다", async () => {
    const calls: string[] = [];
    const review = { status: "running", required: 1, startedAt: ago(2), deadline: ago(-5), reviewers: [{ agentId: "rv1", model: "m", ownAnswer: "a", verdict: "PASS", checks: [], objections: [], at: now() }] };
    const proposal = { rule: "W1", answer: "자동 답", evidence: [{ fact: "f", source: "s" }], undo: "u", selfCheck: [], at: ago(2) };
    const blocker = { kind: "question", summary: "옛 질문", facts: ["f"], options: [], workerRecommendation: null, at: ago(3), proposal, review };
    const { store, channel } = await storeWith(state(request({}, [{ status: "blocked", blocker }])));
    // 마무리가 읽은 뒤 저장하기 전에 워커가 새로 보고한 상황을 만든다.
    const original = store.update.bind(store);
    let raced = false;
    (store as Fake).update = async (change: Fake) => {
      if (!raced) {
        raced = true;
        await original((value) => ({
          state: {
            ...value,
            requests: value.requests.map((item) => ({
              ...item,
              tasks: item.tasks.map((task) => ({ ...task, blocker: { ...task.blocker!, summary: "새 질문", at: now(), proposal: null, review: null } })),
            })),
          },
          result: undefined,
        }));
      }
      return original(change);
    };
    await new ReviewRunner(store, ready, channel).finalize(fakePaseo(calls), "r1", 1, "complete");
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.blocker?.summary, "새 질문");
    assert.equal(task.outbox.length, 0);
    assert.equal(task.autoDecisions.length, 0);
  });
});

describe("완료 판정이 사실대로", () => {
  test("보고 도구가 없어 실패한 report_done 은 그 입력으로 처리하고 세션을 다시 연다 (r12)", async () => {
    const root = await repo();
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [{ kind: "operation", targets: ["시뮬레이터 실행"], branch: "main" }])));
    const input = { summary: "실행했어요", verification: ["앱 설치 확인"], choices: [], left: [], noPullRequestReason: null };
    const timeline = {
      w1: [
        { type: "tool_call", name: "mcp__paseo__report_done", status: "failed", callId: "c1", detail: { input, output: { content: "Tool report_done not found", is_error: true } } },
        { type: "assistant_message", text: "report_done 도구가 이 세션에 없어 보고를 여기에 씁니다." },
      ],
    };
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(fakePaseo(calls, { timeline, cwd: root }), "w1", { kind: "completed" }, false);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "review");
    assert.equal(task.completion?.summary, "실행했어요");
    assert.match(task.note ?? "", /보고 도구가 끊겨/);
    assert.ok(calls.includes("reload w1"));
    assert.equal(task.doneNudgedAt, null);
  });

  test("백그라운드 작업을 기다리며 끝난 턴은 재촉하지도 막힘으로 두지도 않는다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [{ doneNudgedAt: ago(1) }])));
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(fakePaseo(calls, { background: 1 }), "w1", { kind: "completed" }, false);
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.status, "running");
    assert.match(task.note ?? "", /백그라운드 작업 1개/);
    assert.equal(calls.filter((call) => call.startsWith("send")).length, 0);
  });

  test("Paseo 가 만든 빈 paseo.json 은 워커의 변경으로 세지 않는다", async () => {
    const root = await repo();
    await writeFile(join(root, "paseo.json"), "{}");
    assert.equal(await uncommittedChanges(root), null);
    await writeFile(join(root, "notes.md"), "x");
    assert.match((await uncommittedChanges(root)) ?? "", /notes\.md/);
  });

  test("이어 쓰기 사슬의 뒤 작업을 취소하면 앞 작업의 커밋이 카드로 돌아오고 요청은 끝나지 않는다", async () => {
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(3) };
    const { store } = await storeWith(
      state(request({}, [{ status: "done", completion }, { status: "blocked", dependsOn: [1], workspaceId: "ws1", note: "멈춤" }])),
    );
    const result = await cancelTask({ requestId: "r1", taskNumber: 2 }, store);
    assert.equal(result.requestCanceled, false);
    const after = await first(store);
    assert.equal(after.tasks[0]!.status, "review");
    assert.match(after.tasks[0]!.completion?.unpublished ?? "", /작업 2/);
    assert.equal(completionNeedsDecision(after.tasks[0]!), true);
    assert.equal(await finishRequestIfDone(store, "r1"), false);
  });

  test("PR 없이 끝낸 이유는 사람의 요청에 있는 문장이어야 한다", () => {
    const source = { text: "브랜치를 정리해줘. 커밋은 하지 마.", doneCriteria: null, feedback: [] };
    assert.equal(quotesRequest(source, "\"커밋은 하지 마.\""), true);
    assert.equal(quotesRequest(source, "작업 범위: 파일 수정, 커밋, PR은 하지 않습니다."), false);
  });

  test("PR 없이 끝난 작업의 브랜치는 원격에 없는 커밋이 없을 때만 지운다", async () => {
    const root = await repo();
    assert.equal(await deleteBranchIfPublished(root, "pushed"), true);
    assert.equal(await deleteBranchIfPublished(root, "unpushed"), false);
    assert.match(git(root, "branch", "--list", "unpushed"), /unpushed/);
  });
});

describe("코디네이터 멈춤, 이전 요청, 정리", () => {
  test("에러로 끝난 코디네이터에게도 알리고, 연달아 세 번 닿지 못할 때만 멈춤으로 기록하며, 다시 시도하면 지우고 알린다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, notifiedAt: null, tasks: [] }, [])));
    const { runtime } = coordinatorTools(store, channel, calls);
    // 에러 상태여도 새 메시지를 받으면 다시 일한다. 멈춤으로 두지 않고 보낸다.
    await runtime.notify(fakePaseo(calls, { status: "error" }));
    assert.equal((await first(store)).stall, null);
    assert.ok(calls.some((call) => call.startsWith("send c1:")));
    const broken: Fake = fakePaseo(calls);
    broken.agents.ref = () => ({ refresh: async () => Promise.reject(new Error("socket closed")) });
    await store.update((value) => ({ state: { ...value, requests: value.requests.map((item) => ({ ...item, notifiedAt: null })) }, result: undefined }));
    await runtime.notify(broken);
    await runtime.notify(broken);
    assert.equal((await first(store)).stall, null, "일시 오류 두 번은 멈춤이 아니다");
    await runtime.notify(broken);
    assert.match((await first(store)).stall?.reason ?? "", /3 times in a row/);
    calls.length = 0;
    await runtime.retry(fakePaseo(calls), "r1");
    assert.equal((await first(store)).stall, null);
    assert.ok(calls.some((call) => call.startsWith("send c1: [paseo-coordinator] Work waiting for you")));
  });

  test("코디네이터가 권한을 기다리고 있으면 코디네이터 도구는 허용하고 그 밖은 거절한다", async () => {
    const answers: unknown[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, notifiedAt: null, tasks: [] }, [])));
    const { runtime } = coordinatorTools(store, channel, []);
    const paseo: Fake = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: {
              status: "running",
              archivedAt: null,
              pendingPermissions: [
                { id: "p1", kind: "tool", name: "Bash" },
                { id: "p2", kind: "tool", name: "mcp__paseo__coordinator_submit_plan" },
              ],
            },
          }),
          respondToPermission: async (input: unknown) => void answers.push(input),
          send: async () => assert.fail("should not send while permissions are pending"),
        }),
      },
    };
    await runtime.notify(paseo);
    assert.deepEqual(
      (answers as { requestId: string; response: { behavior: string } }[]).map((item) => [item.requestId, item.response.behavior]),
      [["p1", "deny"], ["p2", "allow"]],
    );
  });

  test("실행 중 요청의 지시를 코디네이터가 읽지 않았으면 다시 알리고, 읽은 뒤에는 알리지 않는다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(request({ feedback: [{ text: "B 도 고쳐줘", at: ago(10), kind: "instruction" }], notifiedAt: ago(9), coordinatorReadAt: ago(15) }, [{}])),
    );
    const { runtime, tool } = coordinatorTools(store, channel, calls);
    await runtime.notify(fakePaseo(calls));
    assert.ok(calls.some((call) => call.includes("New instructions or answers on running requests: r1")));
    await tool("coordinator_get_request").execute({ requestId: "r1" }, { paseo: fakePaseo(calls), agent: { id: "c1" } } as Fake);
    calls.length = 0;
    await store.update((value) => ({ state: { ...value, requests: value.requests.map((item) => ({ ...item, notifiedAt: ago(9) })) }, result: undefined }));
    await runtime.notify(fakePaseo(calls));
    assert.equal(calls.filter((call) => call.startsWith("send")).length, 0);
  });

  test("다른 코디네이터가 맡았던 이전 요청도 읽기 전용 도구로 읽을 수 있다", async () => {
    const calls: string[] = [];
    const past = { ...request({ status: "done", kind: "read", grade: null, coordinatorAgentId: "c-old", answer: { text: "후보는 a", sources: ["x"], unknowns: [], projectIds: [], at: ago(60) } }, [{ status: "done" }]), id: "r13" };
    const { store, channel } = await storeWith(state(request({}, [{}]), past));
    const { tool } = coordinatorTools(store, channel, calls);
    const result = await tool("coordinator_read_past_request").execute({ pastRequestId: "r13" }, { paseo: fakePaseo(calls), agent: { id: "c1" } } as Fake);
    assert.notEqual(result.isError, true);
    assert.match(String(result.text), /후보는 a/);
  });

  test("다시 시작할 워커가 없는 작업은 먼저 만든 워크스페이스를 정리하도록 돌려준다", async () => {
    const { store } = await storeWith(state(request({}, [{ status: "blocked", agentId: null, workspaceId: "ws-old", note: "x" }])));
    const result = await retryTask({ requestId: "r1", taskNumber: 1, instruction: null }, store);
    assert.deepEqual(result, { hasWorker: false, orphanWorkspaceId: "ws-old" });
  });

  test("끝난 조사의 워크스페이스는 정리하고, 원격에 없는 커밋이 있는 브랜치는 남긴다", async () => {
    const root = await repo();
    const calls: string[] = [];
    const tasks = state(request({}, [{ status: "done", branch: "pushed" }, { status: "done", branch: "unpushed" }])).requests[0]!.tasks;
    await cleanupTaskWorkspaces(fakePaseo(calls, { cwd: root }), tasks);
    assert.ok(calls.includes("archive-ws ws1") && calls.includes("archive-ws ws2"));
    assert.doesNotMatch(git(root, "branch", "--list", "pushed"), /pushed/);
    assert.match(git(root, "branch", "--list", "unpushed"), /unpushed/);
  });
});

describe("인박스 분류", () => {
  test("PR 이나 남은 변경이 있는 완료만 내 결정 필요이고, 나머지 완료는 확인 필요다", () => {
    const tasks = state(
      request({}, [
        { status: "review", completion: { summary: "s", verification: ["v"], choices: [], left: [], pr: { number: 1, url: "u", title: "t", state: "OPEN", baseRefName: "main", headRefName: "h", additions: 1, deletions: 0, changedFiles: 1, mergeable: "MERGEABLE", checks: null, readAt: now() }, at: now() } },
        { status: "review", completion: { summary: "s", verification: ["v"], choices: [], left: [], pr: null, unpublished: "x", at: now() } },
        { status: "review", kind: "operation", targets: ["x"], completion: { summary: "s", verification: ["v"], choices: [], left: [], pr: null, noPrSource: "operation", at: now() } },
      ]),
    ).requests[0]!.tasks;
    assert.deepEqual(tasks.map(completionNeedsDecision), [true, true, false]);
  });
});

describe("최종 검사에서 찾은 문제", () => {
  test("앞 작업의 worktree 를 이어 쓰던 작업을 다시 시작해도 그 워크스페이스는 정리하지 않는다", async () => {
    const { store } = await storeWith(state(request({}, [{ status: "done" }, { status: "blocked", dependsOn: [1], agentId: null, workspaceId: "ws1", note: "x" }])));
    assert.deepEqual(await retryTask({ requestId: "r1", taskNumber: 2, instruction: null }, store), { hasWorker: false, orphanWorkspaceId: null });
  });

  test("변경 전 조사가 돌아온 요청을 beforeChange 없이 다시 조사하면 거절한다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(request({ status: "planning", kind: "read", beforeChange: true, grade: "A", investigation: { text: "보고", at: ago(1) } }, [{ status: "done" }])),
    );
    const { tool } = coordinatorTools(store, channel, calls);
    const result = await tool("coordinator_submit_plan").execute(plan({ readOnly: true, beforeChange: false, grade: undefined }), {
      paseo: fakePaseo(calls),
      agent: { id: "c1" },
    } as Fake);
    assert.match(String(result.text), /must keep beforeChange true/);
  });

  test("조사 중에 받은 질문의 답도 조사가 끝나면 코디네이터에게 돌아간다", async () => {
    const { store, channel } = await storeWith(
      state(request({ kind: "read", grade: null, feedback: [{ text: "끝나면 지울까요? → 예, 지워줘", at: ago(5), kind: "answer" }] }, [{}])),
    );
    const returned: string[] = [];
    await new Dispatcher(store, ready, channel, () => {}, (_paseo, id) => returned.push(id)).onWorkerTurn(fakePaseo([]), "w1", { kind: "completed" }, false);
    assert.equal((await first(store)).status, "planning");
    assert.deepEqual(returned, ["r1"]);
  });

  test("지시 때문에 돌아온 읽기 요청은 코디네이터가 답변으로 끝낼 수 있다 (변경 전 조사가 아니면)", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(
        request(
          { status: "planning", kind: "read", grade: null, investigation: { text: "보고", at: ago(1) }, feedback: [{ text: "X 도 알려줘", at: ago(5), kind: "instruction" }] },
          [{ status: "done" }],
        ),
      ),
    );
    const { tool } = coordinatorTools(store, channel, calls);
    const result = await tool("coordinator_submit_answer").execute(
      { requestId: "r1", title: "브랜치 정리", answer: "X 는 b 입니다", sources: ["조사"], unknowns: [], projectIds: [] },
      { paseo: fakePaseo(calls), agent: { id: "c1" } } as Fake,
    );
    assert.notEqual(result.isError, true, String(result.text));
  });

  test("끝나서 카드를 기다리는 작업이 함께 취소되면 취소하지 않는다", async () => {
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: now() };
    const { store, channel } = await storeWith(state(request({}, [{ status: "running" }, { status: "review", dependsOn: [1], completion }])));
    const { tool } = coordinatorTools(store, channel, []);
    const result = await tool("coordinator_cancel_tasks").execute({ requestId: "r1", taskNumbers: [1], reason: "x" }, { paseo: fakePaseo([]), agent: { id: "c1" } } as Fake);
    assert.equal(result.isError, true);
    assert.match(String(result.text), /작업 2/);
    assert.deepEqual((await first(store)).tasks.map((task) => task.status), ["running", "review"]);
  });

  test("운영 작업은 앞 코드 작업의 PR 이 머지된 뒤에 시작한다", async () => {
    const created: string[] = [];
    const pr = { number: 1, url: "u", title: "t", state: "OPEN", baseRefName: "main", headRefName: "h", additions: 1, deletions: 0, changedFiles: 1, mergeable: "MERGEABLE", checks: null, readAt: now() };
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr, at: now() };
    const { store, channel } = await storeWith(
      state(request({}, [{ status: "review", completion }, { status: "waiting", dependsOn: [1], agentId: null, workspaceId: null, branch: null, kind: "operation", targets: ["x"] }])),
    );
    const values = { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false };
    const paseo: Fake = {
      projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/repo" }] }) },
      providers: { listModes: async () => ({ modes: [] }) },
      workspaces: { create: async () => (created.push("ws"), { id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } }) },
      agents: { ref: () => ({ send: async () => {}, refresh: async () => ({ agent: { status: "idle", pendingPermissions: [] } }) }) },
    };
    const dispatcher = new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {});
    await dispatcher.run(paseo);
    assert.equal(created.length, 0);
    await store.update((value) => ({
      state: { ...value, requests: value.requests.map((item) => ({ ...item, tasks: item.tasks.map((task) => (task.number === 1 ? { ...task, status: "done" as const } : task)) })) },
      result: undefined,
    }));
    await dispatcher.run(paseo);
    assert.equal(created.length, 1);
  });

  test("백그라운드 작업을 30분 넘게 남긴 채 보고 없이 쉬면 다시 요청한다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({}, [{}])));
    const dispatcher = new Dispatcher(store, ready, channel, () => {});
    await dispatcher.onWorkerTurn(fakePaseo(calls, { background: 1 }), "w1", { kind: "completed" }, false);
    assert.equal(calls.filter((call) => call.startsWith("send")).length, 0);
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60_000;
    try {
      await dispatcher.onWorkerTurn(fakePaseo(calls, { background: 1 }), "w1", { kind: "completed" }, false);
    } finally {
      Date.now = realNow;
    }
    assert.ok(calls.some((call) => call.startsWith("send w1: [From the coordinator plugin] Your turn ended without report_done")));
  });

  test("요청 마무리는 주기 검사에서도 이어 간다", async () => {
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(3), closedAt: ago(2) };
    const { store, channel } = await storeWith(state(request({ coordinatorReadAt: now() }, [{ status: "done", completion }])));
    let done = 0;
    await new Dispatcher(store, ready, channel, () => done++).settleAll(fakePaseo([]));
    assert.equal((await first(store)).status, "done");
    assert.equal(done, 1);
  });

  test("사람이 고른 프로젝트 밖의 작업은 사람이 답한 뒤에만 더하고, 그 프로젝트를 요청에 더한다", async () => {
    const calls: string[] = [];
    const twoProjects: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p", "q"] } }) };
    const { store, channel } = await storeWith(state(request({ projectIds: ["p"] }, [{}])));
    const runtime = new CoordinatorRuntime(store, twoProjects, () => {}, channel);
    const add = runtime.tools().find((item) => item.name === "coordinator_add_tasks")!;
    const paseo = fakePaseo(calls);
    paseo.projects.list = async () => ({ projects: [{ projectId: "p", projectRootPath: "/a", projectDisplayName: "p" }, { projectId: "q", projectRootPath: "/b", projectDisplayName: "q" }] });
    const input = { requestId: "r1", reason: "\"q 도 고쳐줘\"", tasks: [planTask({ number: 2, name: "q 수정", projectId: "q" })] };
    const early = await add.execute(input, { paseo, agent: { id: "c1" } } as Fake);
    assert.match(String(early.text), /outside the projects the human chose/);
    await store.update((value) => ({
      state: { ...value, requests: value.requests.map((item) => ({ ...item, feedback: [{ text: "q 도? → 예", at: now(), kind: "answer" as const }] })) },
      result: undefined,
    }));
    await runtime.tools().find((item) => item.name === "coordinator_get_request")!.execute({ requestId: "r1" }, { paseo, agent: { id: "c1" } } as Fake);
    const added = await add.execute(input, { paseo, agent: { id: "c1" } } as Fake);
    assert.notEqual(added.isError, true, String(added.text));
    assert.deepEqual((await first(store)).projectIds, ["p", "q"]);
  });

  test("조사가 돌아와 계획 단계인 읽기 요청의 자동 결정은 '조사가 끝나서'로 표시된다", () => {
    const parsed = state(request({ status: "planning", kind: "read", grade: null }, [{ status: "done" }])).requests[0]!;
    assert.deepEqual(revertRoute(parsed, parsed.tasks[0]!), { kind: "markOnly", reason: "readFinished" });
  });
});

describe("재검사에서 찾은 문제", () => {
  const values = { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false };
  const startPaseo = (created: string[]): Fake => ({
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/repo" }] }) },
    providers: { listModes: async () => ({ modes: [] }) },
    workspaces: { create: async () => (created.push("ws"), { id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } }) },
    agents: { ref: () => ({ send: async () => {}, refresh: async () => ({ agent: { status: "idle", pendingPermissions: [] } }) }) },
  });
  const operation = { status: "waiting", agentId: null, workspaceId: null, branch: null, kind: "operation", targets: ["x"] };

  test("PR 도 남은 변경도 없이 끝난 앞 코드 작업에는 운영 작업이 바로 이어서 시작한다", async () => {
    const created: string[] = [];
    const completion = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, noPrSource: "noChanges", at: now() };
    const { store, channel } = await storeWith(state(request({}, [{ status: "review", completion }, { ...operation, dependsOn: [1] }])));
    await new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {}).run(startPaseo(created));
    assert.equal(created.length, 1);
  });

  test("이어 쓰기 사슬 중간 작업에 기대는 운영 작업은 사슬 끝 PR 이 머지될 때까지 기다린다", async () => {
    const created: string[] = [];
    const done = { summary: "s", verification: ["v"], choices: [], left: [], pr: null, at: ago(2) };
    const pr = { number: 1, url: "u", title: "t", state: "OPEN", baseRefName: "main", headRefName: "h", additions: 1, deletions: 0, changedFiles: 1, mergeable: "MERGEABLE", checks: null, readAt: now() };
    const { store, channel } = await storeWith(
      state(request({}, [{ status: "done", completion: done }, { status: "review", dependsOn: [1], workspaceId: "ws1", completion: { ...done, pr } }, { ...operation, dependsOn: [1] }])),
    );
    await new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {}).run(startPaseo(created));
    assert.equal(created.length, 0);
  });

  test("변경 전 조사가 시작되기 전에 지시가 와서 계획 단계로 돌아와도 답변으로 끝낼 수 없다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      state(request({ status: "planning", kind: "read", beforeChange: true, grade: "A", plannedAt: ago(3), feedback: [{ text: "그냥 목록만 줘", at: ago(1), kind: "instruction" }] }, [{ status: "waiting", agentId: null, workspaceId: null }])),
    );
    const { tool } = coordinatorTools(store, channel, calls);
    const context = { paseo: fakePaseo(calls), agent: { id: "c1" } } as Fake;
    const answer = await tool("coordinator_submit_answer").execute({ requestId: "r1", title: "브랜치 정리", answer: "a", sources: ["x"], unknowns: [], projectIds: [] }, context);
    assert.equal(answer.isError, true);
    const replan = await tool("coordinator_submit_plan").execute(plan({ readOnly: true, beforeChange: false, grade: undefined }), context);
    assert.match(String(replan.text), /must keep beforeChange true/);
  });

  test("계획 시각이 없는 옛 읽기 요청은 피드백이 있어도 예전처럼 답변이 된다", async () => {
    const { store, channel } = await storeWith(
      state(request({ kind: "read", grade: null, plannedAt: null, feedback: [{ text: "해석 → a", at: ago(25), kind: "answer" }] }, [{}])),
    );
    await new Dispatcher(store, ready, channel, () => {}).onWorkerTurn(fakePaseo([]), "w1", { kind: "completed" }, false);
    assert.equal((await first(store)).status, "answered");
  });

  test("다시 알려도 처리하지 않는 코디네이터가 에러 상태면 멈춤 이유에 그 에러를 보인다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(state(request({ status: "planning", kind: null, notifiedAt: ago(5), tasks: [] }, [])));
    const { runtime } = coordinatorTools(store, channel, calls);
    const paseo: Fake = fakePaseo(calls, { status: "error" });
    const ref = paseo.agents.ref;
    paseo.agents.ref = (id: string) => ({ ...ref(id), refresh: async () => ({ agent: { status: "error", lastError: "model not found", pendingPermissions: [], archivedAt: null } }) });
    for (let index = 0; index < 4; index += 1) {
      await runtime.notify(paseo);
      await store.update((value) => ({ state: { ...value, requests: value.requests.map((item) => ({ ...item, notifiedAt: ago(5) })) }, result: undefined }));
    }
    assert.match((await first(store)).stall?.reason ?? "", /Last error: model not found/);
  });
});
