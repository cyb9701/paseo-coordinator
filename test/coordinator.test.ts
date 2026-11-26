/// <reference types="node" />

/**
 * 서버 흐름의 회귀 테스트. 서버 코드를 그대로 부르고, Paseo API 만 호출을 기록하는 가짜로 둔다.
 * 실제 에이전트로 만들기 어려운 경로(검토 실패, 시간 초과, 자동 정지)와 hook·보정 검사·배정이 겹치는 경쟁 상황을 다룬다.
 * 2026-11-26 전수 검사에서 찾은 결함마다 한 번 실패했던 조건을 그대로 남겼다. 실행: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { resolveBaseRef } from "../server/branches";
import { CompletionRunner } from "../server/completion";
import { validatePlan } from "../server/coordinator";
import { Dispatcher } from "../server/dispatcher";
import { answerQuestions, askCoordinator, cancelTask, resolveBlocker, retryTask } from "../server/requests";
import { ReviewRunner } from "../server/review";
import { StateStore } from "../server/store";
import { WorkerChannel } from "../server/worker-channel";
import { type CoordinatorState, stateSchema } from "../shared/model";

// 가짜 Paseo API 와 설정은 서버가 쓰는 메서드만 흉내 낸다. 실제 타입을 다 채우지 않으므로 any 로 넘긴다.
type Fake = any;

const now = () => new Date().toISOString();
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function fakePaseo(calls: string[], agentStatus = "idle"): Fake {
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => ({ agent: { status: agentStatus, pendingPermissions: [] } }),
        send: async (text: string) => void calls.push(`send ${id}: ${text.split("\n")[0]}`),
        archive: async () => {
          calls.push(`archive ${id}`);
          return { archivedAt: "" };
        },
      }),
    },
    workspaces: { ref: (id: string) => ({ archive: async () => (calls.push(`archive-ws ${id}`), {}) }) },
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/nonexistent" }] }) },
  };
}

const settings: Fake = { read: async () => ({ status: "ready", values: {} }) };

function baseState(task: Record<string, unknown>, request: Record<string, unknown> = {}): CoordinatorState {
  return stateSchema.parse({
    requests: [
      {
        id: "r1",
        text: "docs/intro.md 를 만들어줘",
        doneCriteria: null,
        projectIds: [],
        language: "ko",
        createdAt: now(),
        status: "running",
        kind: "change",
        grade: "C",
        title: "테스트",
        ...request,
        tasks: [{ number: 1, name: "작업", projectId: "p", dependsOn: [], status: "running", workspaceId: "ws1", agentId: "w1", ...task }],
      },
    ],
    sent: [],
  });
}

async function storeWith(state: CoordinatorState) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-test-"));
  await writeFile(join(directory, "state.json"), JSON.stringify(state));
  const store = new StateStore(directory);
  return { store, channel: new WorkerChannel(store) };
}

async function firstTask(store: StateStore) {
  return (await store.read()).requests[0]!.tasks[0]!;
}

const proposal = {
  rule: "W1",
  answer: "docs/intro.md 로 진행",
  evidence: [{ fact: "요청에 적힌 이름", source: "요청" }],
  undo: "파일 삭제",
  selfCheck: [],
  at: now(),
};

const blocker = (review: unknown) => ({
  kind: "question",
  summary: "파일 이름 확인",
  facts: ["사실"],
  options: [],
  workerRecommendation: null,
  at: now(),
  proposal,
  review,
});

const reviewer = (n: number, verdict: string | null, objections: string[] = []) => ({
  agentId: `rv${n}`,
  model: n === 1 ? "claude/claude-opus-5-5" : "claude/claude-sonnet-5-5",
  ownAnswer: "내 답",
  verdict,
  checks: [],
  objections,
  at: verdict ? now() : null,
});

const completion = (extra: Record<string, unknown> = {}) => ({
  summary: "끝",
  verification: ["ok"],
  choices: [],
  left: [],
  pr: null,
  at: now(),
  ...extra,
});

const autoDecision = (id: string, rule: string, at = now()) => ({
  id,
  rule,
  question: `q-${id}`,
  answer: "a",
  evidence: [],
  undo: "u",
  verdicts: [],
  at,
  reviewedAt: null,
  reverted: false,
});

describe("독립 검토", () => {
  test("검토 실패면 반대 의견이 든 사람 카드가 되고 워커에게는 아무것도 가지 않는다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      baseState({
        status: "blocked",
        blocker: blocker({
          status: "running",
          required: 2,
          startedAt: now(),
          deadline: later(5),
          reviewers: [reviewer(1, "PASS"), reviewer(2, "FAIL", ["요청 원문은 확인 단계를 사람이 하라는 뜻일 수 있다"])],
        }),
      }),
    );
    await new ReviewRunner(store, settings, channel).finalize(fakePaseo(calls), "r1", 1, "complete");
    const task = await firstTask(store);
    assert.equal(task.blocker?.review?.status, "failed");
    assert.ok(task.blocker?.coordinator, "사람 카드가 생겨야 한다");
    assert.equal(task.blocker?.coordinator?.recommended, null);
    assert.ok(task.blocker?.objections.some((item) => item.includes("FAIL") && item.includes("확인 단계")));
    assert.ok(!calls.some((call) => call.startsWith("send w1")));
    assert.equal(calls.filter((call) => call.startsWith("archive rv")).length, 2);
    assert.equal(task.autoDecisions.length, 0);
  });

  test("마감이 지난 검토는 보정 검사가 사람 카드로 돌린다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      baseState({
        status: "blocked",
        blocker: blocker({ status: "running", required: 2, startedAt: later(-10), deadline: later(-1), reviewers: [reviewer(1, "PASS"), reviewer(2, null)] }),
      }),
    );
    await new ReviewRunner(store, settings, channel).reconcile(fakePaseo(calls));
    const task = await firstTask(store);
    assert.equal(task.blocker?.review?.status, "failed");
    assert.ok(task.blocker?.objections.some((item) => item.includes("제한 시간")));
    assert.ok(!calls.some((call) => call.startsWith("send w1")));
  });

  test("동시에 두 번 마무리해도 결정은 한 번만 기록하고 워커에게 한 번만 보낸다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      baseState({
        status: "blocked",
        blocker: blocker({ status: "running", required: 2, startedAt: now(), deadline: later(5), reviewers: [reviewer(1, "PASS"), reviewer(2, "PASS")] }),
      }),
    );
    const runner = new ReviewRunner(store, settings, channel);
    const paseo = fakePaseo(calls);
    await Promise.all([runner.finalize(paseo, "r1", 1, "complete"), runner.finalize(paseo, "r1", 1, "complete")]);
    assert.equal((await firstTask(store)).autoDecisions.length, 1);
    assert.equal(calls.filter((call) => call.startsWith("send w1")).length, 1);
  });
});

describe("자동 결정 되돌리기와 자동 정지", () => {
  test("끝난 작업의 결정을 되돌리면 다시 실행 중이 되고, 같은 규칙에서 두 번 되돌리면 그 규칙이 꺼진다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(
      baseState({ status: "review", completion: completion(), autoDecisions: [autoDecision("d1", "W5", later(-3)), autoDecision("d2", "W5", later(-2))] }),
    );
    const runner = new ReviewRunner(store, settings, channel);
    const paseo = fakePaseo(calls);
    await runner.reviewAutoDecision(paseo, { requestId: "r1", taskNumber: 1, id: "d1", revertText: "docs/about.md 로 바꿔" });
    let state = await store.read();
    let task = state.requests[0]!.tasks[0]!;
    assert.ok(!state.disabledRules.includes("W5"), "한 번은 아직 켜져 있다");
    assert.equal(task.status, "running");
    assert.equal(task.completion, null);
    assert.ok(calls.some((call) => call.startsWith("send w1: [From the human] The earlier automatic decision is withdrawn")));
    assert.ok(task.decisions.some((item) => item.summary.startsWith("Reverted:")));

    await runner.reviewAutoDecision(paseo, { requestId: "r1", taskNumber: 1, id: "d2", revertText: "그것도 취소" });
    state = await store.read();
    task = state.requests[0]!.tasks[0]!;
    assert.ok(state.disabledRules.includes("W5"));
    assert.match(runner.precheck(state, state.requests[0]!, { ...task, autoDecisions: [] }, "W5") ?? "", /switched off/);
    assert.equal(runner.precheck(state, state.requests[0]!, { ...task, autoDecisions: [] }, "W1"), null);
  });

  test("확인만 하면 상태를 바꾸지 않고 워커에게 보내지 않는다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(baseState({ status: "review", autoDecisions: [autoDecision("d1", "W1")] }));
    await new ReviewRunner(store, settings, channel).reviewAutoDecision(fakePaseo(calls), { requestId: "r1", taskNumber: 1, id: "d1", revertText: null });
    const task = await firstTask(store);
    assert.ok(task.autoDecisions[0]!.reviewedAt);
    assert.equal(task.autoDecisions[0]!.reverted, false);
    assert.equal(task.status, "review");
    assert.equal(calls.length, 0);
  });
});

describe("카드 문답", () => {
  test("워커 질문 카드에서 결정하면 답이 달린 문답만 결정 기록으로 옮기고 결정은 같은 저장에서 outbox 로 간다", async () => {
    const { store } = await storeWith(
      baseState({
        status: "blocked",
        blocker: {
          ...blocker(null),
          proposal: null,
          coordinator: {
            context: "c",
            options: [{ label: "진행", result: "r", risk: "x", undo: "u", instruction: "진행해" }],
            recommended: "진행",
            reasons: [],
            rules: [],
            at: now(),
          },
        },
      }),
    );
    await askCoordinator({ requestId: "r1", taskNumber: 1, question: "되돌리기 쉬워?" }, store);
    await askCoordinator({ requestId: "r1", taskNumber: 1, question: "답이 안 달릴 질문" }, store);
    await answerFirstQuestion(store, "blocker", "파일 하나라 쉬워요");
    await resolveBlocker({ requestId: "r1", taskNumber: 1, choice: "진행", instruction: null }, store);
    const task = await firstTask(store);
    assert.equal(task.blocker, null);
    assert.equal(task.status, "running");
    assert.deepEqual(task.decisions.at(-1)?.qa, [{ question: "되돌리기 쉬워?", answer: "파일 하나라 쉬워요" }]);
    assert.ok(task.outbox.some((item) => item.text.includes("진행해")));
  });

  test("머지 카드의 질문은 완료 보고에 쌓이고, 수정 지시를 보내면 결정 기록으로 옮겨진다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(baseState({ branch: "coord/r1-1-x", completion: completion() }));
    const paseo = fakePaseo(calls);
    await new Dispatcher(store, settings, channel, () => {}).onWorkerTurn(paseo, "w1", { kind: "completed" }, false);
    assert.equal((await firstTask(store)).status, "review");
    await askCoordinator({ requestId: "r1", taskNumber: 1, question: "테스트는 무엇을 봤어?" }, store);
    assert.equal((await firstTask(store)).completion?.qa.length, 1);
    await answerFirstQuestion(store, "completion", "두 경우를 봤어요");
    await new CompletionRunner(store, channel, () => {}).close(paseo, { requestId: "r1", taskNumber: 1, action: "revise", instruction: "빈 문자열도 처리해" });
    const task = await firstTask(store);
    assert.equal(task.status, "running");
    assert.equal(task.completion, null);
    assert.equal(task.decisions.at(-1)?.qa[0]?.answer, "두 경우를 봤어요");
    assert.ok(calls.some((call) => call.startsWith("send w1: [Change request from the human before merging]")));
  });
});

/** 코디네이터가 답한 것처럼 첫 질문에 답을 단다. */
async function answerFirstQuestion(store: StateStore, card: "blocker" | "completion", answer: string) {
  await store.update((state) => ({
    state: {
      ...state,
      requests: state.requests.map((request) => ({
        ...request,
        tasks: request.tasks.map((task) => {
          const owner = card === "blocker" ? task.blocker : task.completion;
          if (!owner) return task;
          const qa = owner.qa.map((item, index) => (index === 0 ? { ...item, answer, answeredAt: now() } : item));
          return card === "blocker" ? { ...task, blocker: { ...task.blocker!, qa } } : { ...task, completion: { ...task.completion!, qa } };
        }),
      })),
    },
    result: undefined,
  }));
}

describe("워커 턴과 메시지", () => {
  test("완료 보고 없이 끝나면 한 번 다시 요청하고, 두 번째는 막힘으로 둔다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(baseState({ branch: "coord/r1-1-x" }));
    let done = 0;
    const dispatcher = new Dispatcher(store, settings, channel, () => done++);
    const paseo = fakePaseo(calls);
    await dispatcher.onWorkerTurn(paseo, "w1", { kind: "completed" }, false);
    let task = await firstTask(store);
    assert.equal(task.status, "running");
    assert.ok(task.doneNudgedAt);
    assert.ok(calls.some((call) => call.includes("ended without report_done")));
    await dispatcher.onWorkerTurn(paseo, "w1", { kind: "completed" }, false);
    task = await firstTask(store);
    assert.equal(task.status, "blocked");
    assert.match(task.note ?? "", /완료 보고 없이 두 번/);
    assert.equal(done, 0);
  });

  test("다시 요청을 처리 중인 워커는 막힘으로 두지 않는다", async () => {
    const { store, channel } = await storeWith(baseState({ branch: "b", doneNudgedAt: now() }));
    await new Dispatcher(store, settings, channel, () => {}).onWorkerTurn(fakePaseo([], "running"), "w1", { kind: "completed" }, false);
    assert.equal((await firstTask(store)).status, "running");
  });

  test("바쁜 워커에게는 보내지 않고, 보내기에 실패하면 outbox 로 되돌린다", async () => {
    const calls: string[] = [];
    const { store, channel } = await storeWith(baseState({ outbox: [{ text: "m1", at: now() }] }));
    assert.equal(await channel.flush(fakePaseo(calls, "running"), "r1", 1), false);
    assert.equal((await firstTask(store)).outbox.length, 1);
    assert.equal(calls.length, 0);
    const failing: Fake = {
      agents: {
        ref: () => ({
          refresh: async () => ({ agent: { status: "idle", pendingPermissions: [] } }),
          send: async () => {
            throw new Error("down");
          },
        }),
      },
    };
    await channel.flush(failing, "r1", 1).catch(() => undefined);
    assert.equal((await firstTask(store)).outbox.length, 1);
  });

  test("막힌 작업을 다시 시작하면 워커가 있으면 지시를 outbox 에, 없으면 대기로 돌린다", async () => {
    const withWorker = await storeWith(baseState({ status: "blocked", note: "x", doneNudgedAt: now() }));
    await retryTask({ requestId: "r1", taskNumber: 1, instruction: "테스트부터 고쳐" }, withWorker.store);
    let task = await firstTask(withWorker.store);
    assert.equal(task.status, "running");
    assert.ok(task.outbox[0]?.text.includes("테스트부터 고쳐"));
    assert.equal(task.doneNudgedAt, null);

    const withoutWorker = await storeWith(baseState({ status: "blocked", note: "start failed", agentId: null, workspaceId: null }));
    await retryTask({ requestId: "r1", taskNumber: 1, instruction: null }, withoutWorker.store);
    task = await firstTask(withoutWorker.store);
    assert.equal(task.status, "waiting");
    assert.equal(task.note, null);
  });
});

describe("PR 없는 완료", () => {
  for (const unpublished of [null, "uncommitted changes:\n?? docs/"]) {
    test(unpublished ? "남은 변경이 있으면 확인해도 워크스페이스를 지우지 않는다" : "남은 변경이 없으면 확인하면 워크스페이스를 정리한다", async () => {
      const calls: string[] = [];
      const { store, channel } = await storeWith(
        baseState({
          status: "review",
          branch: "coord/r1-1-x",
          completion: completion({ noPrReason: unpublished ? "커밋은 하지 마" : null, unpublished }),
        }),
      );
      let done = 0;
      await new CompletionRunner(store, channel, () => done++).close(fakePaseo(calls), { requestId: "r1", taskNumber: 1, action: "merge", instruction: null });
      const state = await store.read();
      assert.equal(state.requests[0]!.tasks[0]!.status, "done");
      assert.equal(state.requests[0]!.status, "done");
      assert.equal(done, 1);
      assert.equal(calls.includes("archive-ws ws1"), !unpublished);
    });
  }
});

describe("계획과 요청 상태", () => {
  test("같은 프로젝트에서 두 작업이 한 작업의 worktree 를 이어 쓰면 계획을 거절한다", () => {
    const task = (number: number, dependsOn: number[], projectId = "p") => ({ number, name: "작업", projectId, dependsOn });
    const fork = validatePlan({ title: "제목", tasks: [task(1, []), task(2, [1]), task(3, [1])] }, "ko", new Set(["p"]));
    assert.ok(fork.some((problem) => problem.includes("share one worktree")));
    assert.deepEqual(validatePlan({ title: "제목", tasks: [task(1, []), task(2, [1]), task(3, [2])] }, "ko", new Set(["p"])), []);
    assert.deepEqual(validatePlan({ title: "제목", tasks: [task(1, []), task(2, [1]), task(3, [1], "q")] }, "ko", new Set(["p", "q"])), []);
  });

  test("실행 중 요청의 질문에 답하면 다시 계획하지 않고 진행 중으로 둔다", async () => {
    const { store } = await storeWith(baseState({}));
    await store.update((state) => ({
      state: { ...state, requests: state.requests.map((request) => ({ ...request, question: { context: "c", questions: [], projectIds: [], at: now() } })) },
      result: undefined,
    }));
    await answerQuestions({ id: "r1", answers: [{ question: "q", answer: "a" }] }, store);
    const request = (await store.read()).requests[0]!;
    assert.equal(request.status, "running");
    assert.equal(request.tasks.length, 1);
    assert.equal(request.question, null);
    assert.equal(request.feedback.at(-1)?.kind, "answer");
  });

  test("사람이 읽는 오류는 요청 언어로 나온다", async () => {
    const korean = await storeWith(baseState({ status: "running" }));
    await assert.rejects(retryTask({ requestId: "r1", taskNumber: 1, instruction: null }, korean.store), /다시 시작할 상태가 아니에요/);
    const english = await storeWith(baseState({ status: "running" }, { language: "en" }));
    await assert.rejects(retryTask({ requestId: "r1", taskNumber: 1, instruction: null }, english.store), /not waiting to be restarted/);
  });
});

describe("배정", () => {
  for (const cancelMidway of [false, true]) {
    test(cancelMidway ? "워커를 만드는 사이 요청이 취소되면 그 워커를 정리하고 기록하지 않는다" : "대기 작업에 워커를 한 번만 배정한다", async () => {
      const calls: string[] = [];
      let createdOptions: unknown;
      const { store, channel } = await storeWith(baseState({ status: "waiting", agentId: null, workspaceId: null }));
      const values = { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false };
      const startSettings: Fake = { read: async () => ({ status: "ready", values }) };
      const paseo: Fake = {
        projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: "/repo" }] }) },
        providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
        workspaces: {
          create: async () => ({
            id: "wsN",
            archive: async () => (calls.push("archive-ws wsN"), {}),
            agents: {
              create: async (input: Fake) => {
                createdOptions = input.config.options;
                if (cancelMidway) {
                  await store.update((state) => ({
                    state: { ...state, requests: state.requests.map((request) => ({ ...request, status: "canceled" as const })) },
                    result: undefined,
                  }));
                }
                return { id: "agentN" };
              },
            },
          }),
        },
        agents: {
          ref: (id: string) => ({
            send: async (text: string) => void calls.push(`send ${id}: ${text.split("\n")[0]}`),
            archive: async () => (calls.push(`archive ${id}`), {}),
            refresh: async () => ({ agent: { status: "running" } }),
          }),
        },
      };
      const dispatcher = new Dispatcher(store, startSettings, channel, () => {});
      await dispatcher.run(paseo);
      const task = await firstTask(store);
      if (cancelMidway) {
        assert.equal(task.agentId, null);
        assert.ok(calls.includes("archive agentN"));
      } else {
        assert.equal(task.agentId, "agentN");
        assert.equal(task.workspaceId, "wsN");
        // 보고 도구를 미리 허용해야 권한 요청과 그 알림이 생기지 않는다.
        assert.deepEqual(createdOptions, { allowedTools: ["mcp__paseo__report_blocker", "mcp__paseo__report_done"] });
        await dispatcher.run(paseo);
        assert.equal(calls.filter((call) => call.startsWith("send agentN")).length, 1);
      }
    });
  }
});

/**
 * origin 이 있는 임시 저장소. 브랜치 상태: main(원격 기본), feature(원격과 같음), behind(로컬이 원격보다 뒤), ahead(로컬에만
 * 커밋이 더 있음), local-only(원격에 없음).
 */
async function gitFixture(): Promise<string> {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  const origin = await mkdtemp(join(tmpdir(), "coordinator-origin-"));
  git(origin, "init", "--bare", "-b", "main");
  const work = await mkdtemp(join(tmpdir(), "coordinator-work-"));
  git(work, "clone", origin, ".");
  const commit = (message: string) => git(work, "commit", "--allow-empty", "-m", message);
  commit("init");
  git(work, "push", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  for (const branch of ["feature", "behind", "ahead"]) {
    git(work, "checkout", "-b", branch, "main");
    commit(branch);
    commit(`${branch} 2`);
    git(work, "push", "origin", branch);
  }
  git(work, "branch", "-f", "behind", "behind~1");
  git(work, "checkout", "ahead");
  commit("ahead unpushed");
  git(work, "checkout", "-b", "local-only", "main");
  commit("local only");
  git(work, "checkout", "main");
  return work;
}

describe("기준 브랜치", () => {
  test("로컬이 원격에 들어 있으면 원격 최신을, 로컬에만 커밋이 있으면 로컬을, 원격에 없으면 로컬 전용으로 쓴다", async () => {
    const root = await gitFixture();
    assert.deepEqual(await resolveBaseRef(root, "feature"), { branch: "feature", refName: "origin/feature", remote: true });
    assert.deepEqual(await resolveBaseRef(root, "behind"), { branch: "behind", refName: "origin/behind", remote: true });
    assert.deepEqual(await resolveBaseRef(root, "ahead"), { branch: "ahead", refName: "refs/heads/ahead", remote: true });
    assert.deepEqual(await resolveBaseRef(root, "local-only"), { branch: "local-only", refName: "refs/heads/local-only", remote: false });
    assert.equal(await resolveBaseRef(root, "missing"), null);
    assert.equal(await resolveBaseRef(root, "--upload-pack=x"), null);
  });

  // 우선순위: 작업에 적힌 브랜치(사람 또는 코디네이터) > 설정 > 원격 기본 브랜치.
  for (const [label, taskBase, settingsBase, expected] of [
    ["작업에 적힌 브랜치를 설정보다 먼저 쓴다", "local-only", "feature", { refName: "refs/heads/local-only", base: "local-only" }],
    ["작업에 없으면 설정의 브랜치를 쓴다", null, "feature", { refName: "origin/feature", base: "feature" }],
    ["둘 다 없으면 원격 기본 브랜치의 최신을 쓴다", null, null, { refName: "origin/main", base: "main" }],
  ] as const) {
    test(label, async () => {
      const root = await gitFixture();
      const { store, channel } = await storeWith(baseState({ status: "waiting", agentId: null, workspaceId: null, baseBranch: taskBase }));
      const values = {
        allowedProjectIds: ["p"],
        baseBranches: settingsBase ? { p: settingsBase } : {},
        worker: { model: "claude/opus", effort: "high" },
        poteto: false,
      };
      let source: Fake = null;
      let kickoff = "";
      const paseo: Fake = {
        projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root }] }) },
        providers: { listModes: async () => ({ modes: [{ id: "auto" }] }) },
        workspaces: {
          create: async (input: Fake) => {
            source = input.source;
            return { id: "wsN", archive: async () => ({}), agents: { create: async () => ({ id: "agentN" }) } };
          },
        },
        agents: {
          ref: () => ({ send: async (text: string) => void (kickoff = text), archive: async () => ({}), refresh: async () => ({ agent: { status: "running" } }) }),
        },
      };
      await new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {}).run(paseo);
      assert.equal(source.refName, expected.refName);
      assert.equal((await firstTask(store)).baseBranch, expected.base);
      if (expected.base === "local-only") assert.match(kickoff, /Do not push or open a pull request: the base branch local-only exists only on this machine/);
      else assert.match(kickoff, new RegExp(`gh pr create --base ${expected.base}`));
    });
  }

  test("정한 기준 브랜치가 저장소에 없으면 워커를 만들지 않고 막힘으로 둔다", async () => {
    const root = await gitFixture();
    const { store, channel } = await storeWith(baseState({ status: "waiting", agentId: null, workspaceId: null, baseBranch: "gone" }));
    const values = { allowedProjectIds: ["p"], baseBranches: {}, worker: { model: "claude/opus", effort: "high" }, poteto: false };
    let created = false;
    const paseo: Fake = {
      projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root }] }) },
      workspaces: { create: async () => ((created = true), {}) },
    };
    await new Dispatcher(store, { read: async () => ({ status: "ready", values }) } as Fake, channel, () => {}).run(paseo);
    const task = await firstTask(store);
    assert.equal(created, false);
    assert.equal(task.status, "blocked");
    assert.match(task.note ?? "", /기준 브랜치 gone/);
  });
});

/** 작업 여러 개짜리 요청. 각 작업은 번호, 상태, 의존, 워커를 받는다. */
function multiTaskState(kind: "read" | "change", tasks: { number: number; status: string; dependsOn?: number[]; agentId?: string | null }[]) {
  return stateSchema.parse({
    requests: [
      {
        id: "r1",
        text: "정리",
        doneCriteria: null,
        projectIds: [],
        language: "ko",
        createdAt: now(),
        status: "running",
        kind,
        grade: kind === "read" ? null : "C",
        title: "정리",
        tasks: tasks.map((task) => ({
          name: `작업${task.number}`,
          projectId: "p",
          dependsOn: [],
          workspaceId: null,
          agentId: null,
          ...task,
        })),
      },
    ],
    sent: [],
  });
}

describe("작업 취소", () => {
  test("멈춘 작업과 그 작업에 기대는 작업만 취소하고, 워커를 돌려준다", async () => {
    const { store } = await storeWith(
      multiTaskState("change", [
        { number: 1, status: "done" },
        { number: 2, status: "blocked", agentId: "w2" },
        { number: 3, status: "waiting", dependsOn: [2] },
        { number: 4, status: "waiting", dependsOn: [3] },
        { number: 5, status: "waiting", dependsOn: [1] },
      ]),
    );
    const result = await cancelTask({ requestId: "r1", taskNumber: 2 }, store);
    const request = (await store.read()).requests[0]!;
    assert.deepEqual(request.tasks.map((task) => task.status), ["done", "canceled", "canceled", "canceled", "waiting"]);
    assert.deepEqual(result, { agentIds: ["w2"], requestCanceled: false });
    assert.equal(request.status, "running");
    assert.match(request.tasks[3]!.decisions.at(-1)!.summary, /Canceled with task 2/);
  });

  test("멈춘 작업이 아니면 취소하지 않는다", async () => {
    const { store } = await storeWith(multiTaskState("change", [{ number: 1, status: "running", agentId: "w1" }]));
    await assert.rejects(cancelTask({ requestId: "r1", taskNumber: 1 }, store), /취소할 수 없어요/);
  });

  test("모든 작업이 취소되면 요청도 취소된다", async () => {
    const { store } = await storeWith(multiTaskState("change", [{ number: 1, status: "blocked" }, { number: 2, status: "waiting", dependsOn: [1] }]));
    assert.equal((await cancelTask({ requestId: "r1", taskNumber: 1 }, store)).requestCanceled, true);
    assert.equal((await store.read()).requests[0]!.status, "canceled");
  });

  test("변경 요청은 남은 작업이 끝나 있으면 취소 뒤에 끝난다", async () => {
    const { store, channel } = await storeWith(multiTaskState("change", [{ number: 1, status: "done" }, { number: 2, status: "blocked" }]));
    const done: string[] = [];
    const settings: Fake = { read: async () => ({ status: "ready", values: {} }) };
    const { agentIds } = await cancelTask({ requestId: "r1", taskNumber: 2 }, store);
    await new Dispatcher(store, settings, channel, (_paseo, id) => done.push(id)).afterCancel(fakePaseo([]), "r1", agentIds);
    assert.equal((await store.read()).requests[0]!.status, "done");
    assert.deepEqual(done, ["r1"]);
  });

  test("읽기 요청은 취소한 조사를 빼고 답을 모으며, 빠진 조사를 답에 밝힌다", async () => {
    const { store, channel } = await storeWith(
      multiTaskState("read", [{ number: 1, status: "done", agentId: "w1" }, { number: 2, status: "blocked" }]),
    );
    const settings: Fake = { read: async () => ({ status: "ready", values: {} }) };
    const paseo: Fake = {
      agents: {
        ref: () => ({
          archive: async () => ({}),
          timeline: { refetch: async () => ({ entries: [{ item: { type: "assistant_message", text: "조사 결과" } }] }) },
        }),
      },
    };
    await cancelTask({ requestId: "r1", taskNumber: 2 }, store);
    await new Dispatcher(store, settings, channel, () => {}).afterCancel(paseo, "r1", []);
    const request = (await store.read()).requests[0]!;
    assert.equal(request.status, "answered");
    assert.match(request.answer!.text, /조사 결과/);
    assert.match(request.answer!.text, /## 2 작업2\n\n\(canceled by the human/);
    assert.deepEqual(request.answer!.sources, ["1 작업1"]);
  });

  test("취소한 작업의 워커 턴이 늦게 끝나도 작업을 되살리지 않는다", async () => {
    const { store, channel } = await storeWith(multiTaskState("change", [{ number: 1, status: "blocked", agentId: "w1" }, { number: 2, status: "waiting" }]));
    await cancelTask({ requestId: "r1", taskNumber: 1 }, store);
    const settings: Fake = { read: async () => ({ status: "ready", values: {} }) };
    await new Dispatcher(store, settings, channel, () => {}).onWorkerTurn(fakePaseo([]), "w1", { kind: "failed", error: { message: "x" } }, false);
    assert.equal((await firstTask(store)).status, "canceled");
  });
});
