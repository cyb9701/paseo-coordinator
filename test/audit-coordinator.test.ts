/// <reference types="node" />

/**
 * 2026-11-26 세 번째 전수 검사에서 찾은 코디네이터 도구·관문·검토자 결함의 회귀 테스트: 읽지 않은 지시, 승인 문자열 경계,
 * 취소·완료된 작업 의존, 사람이 고른 기준 브랜치, 승인 재사용, 기본 브랜치 워크스페이스, 워크스페이스 물려받기, 검토 적용 직전 재확인,
 * 점검표 중복, 비밀 파일, 소유 검사. 실행: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { CoordinatorRuntime, containsBounded, humanGateProblems, validatePlan } from "../server/coordinator";
import { ReviewRunner } from "../server/review";
import { StateStore } from "../server/store";
import { WorkerChannel } from "../server/worker-channel";
import { type CoordinatorState, stateSchema } from "../shared/model";

type Fake = any;

const now = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" })
    .toString()
    .trim();

function request(extra: Record<string, unknown>, tasks: Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id: "r1",
    text: "고쳐줘",
    doneCriteria: null,
    projectIds: ["p"],
    language: "ko",
    createdAt: ago(30),
    status: "running",
    kind: "change",
    grade: "C",
    title: "수정",
    plannedAt: ago(20),
    coordinatorAgentId: "c1",
    coordinatorReadAt: ago(19),
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

async function storeWith(...requests: Record<string, unknown>[]) {
  const directory = await mkdtemp(join(tmpdir(), "coordinator-audit-c-"));
  await writeFile(join(directory, "state.json"), JSON.stringify(stateSchema.parse({ requests, sent: [] }) satisfies CoordinatorState));
  const store = new StateStore(directory);
  return { store, channel: new WorkerChannel(store) };
}
const first = async (store: StateStore) => (await store.read()).requests[0]!;

const ready: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"] } }) };

function fakePaseo(root: string, workspaces: Record<string, unknown>[] = []): Fake {
  return {
    projects: { list: async () => ({ projects: [{ projectId: "p", projectRootPath: root, projectDisplayName: "p" }] }) },
    workspaces: { list: async () => ({ entries: workspaces }) },
    agents: { list: async () => ({ entries: [] }), ref: (id: string) => ({ archive: async () => ({ id }), send: async () => undefined }) },
  };
}

const planTask = (extra: Record<string, unknown> = {}) => ({
  number: 1,
  name: "화면 수정",
  projectId: "p",
  dependsOn: [],
  kind: "code",
  targets: [],
  scope: "범위",
  doneCriteria: "기준",
  requestRefs: ["고쳐줘"],
  ...extra,
});

const plan = (tasks: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  requestId: "r1",
  readOnly: false,
  beforeChange: false,
  title: "수정",
  grade: "C",
  gradeReasons: ["이유"],
  recommendation: "추천",
  risks: [],
  unknowns: [],
  tasks,
  ...extra,
});

function tools(store: StateStore, channel: WorkerChannel) {
  const runtime = new CoordinatorRuntime(store, ready, () => {}, channel);
  return (name: string) => runtime.tools().find((item) => item.name === name)!;
}

/** origin(main) 이 있는 저장소. 사람이 그 main 체크아웃을 워크스페이스로 열어 둔 상황이다. */
async function mainCheckout(): Promise<string> {
  const origin = await mkdtemp(join(tmpdir(), "coordinator-audit-c-origin-"));
  git(origin, "init", "--bare", "-b", "main");
  const root = await mkdtemp(join(tmpdir(), "coordinator-audit-c-root-"));
  git(root, "clone", origin, ".");
  git(root, "commit", "--allow-empty", "-m", "init");
  git(root, "push", "origin", "main");
  git(root, "remote", "set-head", "origin", "main");
  return root;
}

const workspace = (directory: string, extra: Record<string, unknown> = {}) => ({
  id: "human",
  projectId: "p",
  name: "main",
  title: "내 작업",
  workspaceKind: "local_checkout",
  workspaceDirectory: directory,
  projectRootPath: directory,
  archivingAt: null,
  ...extra,
});

describe("읽지 않은 지시", () => {
  test("코디네이터가 읽은 뒤에 온 지시가 있으면 작업 추가를 받지 않아 그 지시가 처리된 것으로 바뀌지 않는다", async () => {
    const { store, channel } = await storeWith(
      request({ feedback: [{ text: "결제 모듈은 건드리지 마", at: now(), kind: "instruction" }] }, [{ status: "running" }]),
    );
    const tool = tools(store, channel);
    const context: Fake = { paseo: fakePaseo("/nonexistent"), agent: { id: "c1" } };
    const input = { requestId: "r1", reason: "\"고쳐줘\"", tasks: [planTask({ number: 2, name: "추가 작업" })] };
    const early = await tool("coordinator_add_tasks").execute(input, context);
    assert.match(String(early.text), /arrived after you last read/);
    assert.equal((await first(store)).tasks.length, 1);
    await tool("coordinator_get_request").execute({ requestId: "r1" }, context);
    const added = await tool("coordinator_add_tasks").execute(input, context);
    assert.notEqual(added.isError, true, String(added.text));
  });

  test("코디네이터가 정해지지 않은 요청에는 어떤 코디네이터도 손댈 수 없다", async () => {
    const { store, channel } = await storeWith(request({ status: "planning", kind: null, coordinatorAgentId: null, plannedAt: null }));
    const result = await tools(store, channel)("coordinator_submit_answer").execute(
      { requestId: "r1", text: "답", sources: [], unknowns: [], projectIds: [] },
      { paseo: fakePaseo("/nonexistent"), agent: { id: "someone" } } as Fake,
    );
    assert.match(String(result.text), /belongs to another coordinator/);
  });
});

describe("승인 문자열 경계", () => {
  test("다른 경로나 이름의 일부로만 들어 있으면 승인으로 보지 않는다", () => {
    assert.equal(containsBounded("경로 /x/app-feature 에서 실행", "/x/app"), false);
    assert.equal(containsBounded("develop 브랜치 삭제", "dev"), false);
    assert.equal(containsBounded("coord/r15-10-ab 삭제", "coord/r15-1"), false);
    assert.equal(containsBounded("워크트리 /x/app 에서 실행합니다.", "/x/app"), true);
    assert.equal(containsBounded("경로: `/x/app`.", "/x/app"), true);
    assert.equal(containsBounded("로컬 브랜치 dev를 지웁니다", "dev"), true);
  });

  test("질문에 다른 경로만 보였으면 그 워크스페이스는 승인되지 않는다", () => {
    const value = stateSchema.parse({
      requests: [
        request({
          plannedAt: null,
          feedback: [{ text: "예", at: now(), kind: "answer" }],
          lastQuestion: { context: "", questions: [{ question: "워크스페이스 /x/app-feature 에서 할까요?", options: [], recommended: null }], answeredAt: now() },
        }),
      ],
      sent: [],
    }).requests[0]!;
    const problems = humanGateProblems(value, [{ kind: "code" }], "C", null, ["/x/app"]);
    assert.ok(problems.some((problem) => /did not show these workspace directories/.test(problem)), problems.join("\n"));
  });

  test("운영 대상이 접힌 배경에만 있으면 승인되지 않는다. 카드는 질문과 선택지만 밖에 둔다 (2026-11-27)", () => {
    const answered = (lastQuestion: unknown) =>
      stateSchema.parse({
        requests: [request({ plannedAt: null, feedback: [{ text: "예", at: now(), kind: "answer" }], lastQuestion })],
        sent: [],
      }).requests[0]!;
    const onlyContext = answered({ context: "로컬 브랜치 coord/r1-1-ab 를 지웁니다", questions: [{ question: "지울까요?", options: [{ label: "예" }], recommended: null }], answeredAt: now() });
    const inOption = answered({
      context: "",
      questions: [{ question: "지울까요?", options: [{ label: "예", description: "로컬 브랜치 coord/r1-1-ab 를 지웁니다" }], recommended: null }],
      answeredAt: now(),
    });
    const operation = [{ kind: "operation" as const, targets: ["coord/r1-1-ab"] }];
    assert.ok(humanGateProblems(onlyContext, operation, "C", null).some((problem) => /did not list these operation targets/.test(problem)));
    assert.deepEqual(humanGateProblems(inOption, operation, "C", null), []);
  });
});

describe("계획 검증", () => {
  const usable = new Set(["p"]);
  const task = (number: number, dependsOn: number[] = []) => ({ number, name: `작업${number}`, projectId: "p", dependsOn });

  test("취소된 작업에 기대는 작업은 받지 않는다", () => {
    const problems = validatePlan({ title: "수정", tasks: [task(2, [1])] }, "ko", usable, [{ number: 1, projectId: "p", dependsOn: [], status: "canceled" }]);
    assert.ok(problems.some((problem) => /task 1 was canceled/.test(problem)), problems.join("\n"));
  });

  for (const [label, existing] of [
    ["머지 카드가 열린 작업", { status: "review", completion: { closedAt: null } }],
    ["머지된 작업", { status: "done", completion: { closedAt: now() } }],
  ] as const) {
    test(`${label}의 worktree 를 이어 쓰는 새 작업은 받지 않는다`, () => {
      const problems = validatePlan({ title: "수정", tasks: [task(2, [1])] }, "ko", usable, [{ number: 1, projectId: "p", dependsOn: [], ...existing }]);
      assert.ok(problems.some((problem) => /already reported done/.test(problem)), problems.join("\n"));
    });
  }
});

describe("기존 워크스페이스 관문", () => {
  test("사람이 기준 브랜치를 고른 프로젝트에는 코디네이터가 워크스페이스를 적을 수 없다", async () => {
    const root = await mainCheckout();
    git(root, "switch", "-c", "feature");
    const { store, channel } = await storeWith(request({ status: "planning", kind: null, plannedAt: null, baseBranches: { p: "dev" } }));
    const result = await tools(store, channel)("coordinator_submit_plan").execute(plan([planTask({ workspaceId: "human" })]), {
      paseo: fakePaseo(root, [workspace(root)]),
      agent: { id: "c1" },
    } as Fake);
    assert.match(String(result.text), /the human chose base branch dev/);
  });

  test("코디네이터가 고른 워크스페이스가 기본 브랜치에 있으면 코드 작업 계획을 받지 않는다", async () => {
    const root = await mainCheckout();
    const { store, channel } = await storeWith(request({ status: "planning", kind: null, plannedAt: null }));
    const result = await tools(store, channel)("coordinator_submit_plan").execute(plan([planTask({ workspaceId: "human" })]), {
      paseo: fakePaseo(root, [workspace(root)]),
      agent: { id: "c1" },
    } as Fake);
    assert.match(String(result.text), /on the default branch main/);
  });

  test("이전 계획의 조사 작업이 쓰던 워크스페이스라도 새 계획에서는 다시 승인받아야 한다", async () => {
    const root = await mainCheckout();
    git(root, "switch", "-c", "feature");
    const { store, channel } = await storeWith(
      request({ status: "planning", kind: "read", plannedAt: ago(10) }, [{ status: "done", existingWorkspaceId: "human", workspaceId: "human" }]),
    );
    const result = await tools(store, channel)("coordinator_submit_plan").execute(plan([planTask({ workspaceId: "human" })]), {
      paseo: fakePaseo(root, [workspace(root)]),
      agent: { id: "c1" },
    } as Fake);
    assert.match(String(result.text), /needs their approval/);
  });

  test("앞 작업을 이어 쓰는 작업은 저장할 때 그 워크스페이스를 물려받아 시작 전에도 보인다", async () => {
    const root = await mainCheckout();
    git(root, "switch", "-c", "feature");
    // 작업 1 은 승인받은 기존 워크스페이스에서 일하는 중이다. 코디네이터가 그 뒤를 잇는 작업 2 를 워크스페이스 없이 더한다.
    const { store, channel } = await storeWith(request({}, [{ status: "running", existingWorkspaceId: "human", workspaceId: "human" }]));
    const added = await tools(store, channel)("coordinator_add_tasks").execute(
      { requestId: "r1", reason: "\"고쳐줘\"", tasks: [planTask({ number: 2, name: "이어서", dependsOn: [1] })] },
      { paseo: fakePaseo(root, [workspace(root)]), agent: { id: "c1" } } as Fake,
    );
    assert.notEqual(added.isError, true, String(added.text));
    assert.equal((await first(store)).tasks[1]!.existingWorkspaceId, "human");
  });
});

describe("독립 검토", () => {
  const blocker = {
    kind: "question",
    summary: "어디에 둘까요?",
    facts: ["사실"],
    options: [],
    workerRecommendation: null,
    at: ago(3),
    proposal: { rule: "W5", answer: "입력칸 아래에 둬", evidence: [{ fact: "f", source: "s" }], undo: "되돌림", selfCheck: [], at: ago(3) },
    review: {
      status: "running",
      required: 2,
      startedAt: ago(3),
      deadline: new Date(Date.now() + 300_000).toISOString(),
      reviewers: [1, 2].map((index) => ({ agentId: `rv${index}`, model: "m", ownAnswer: "a", verdict: "PASS", at: ago(1) })),
    },
  };
  const fake: Fake = {
    agents: { ref: (id: string) => ({ archive: async () => ({ id }), send: async () => undefined, refresh: async () => ({ agent: { status: "idle" } }) }) },
  };

  test("검토가 도는 사이 사람이 같은 규칙의 결정을 되돌렸으면 통과해도 적용하지 않고 사람 카드로 보낸다", async () => {
    const { store, channel } = await storeWith(
      request({}, [
        { status: "blocked", blocker },
        { status: "running", autoDecisions: [{ id: "d", rule: "W5", question: "q", answer: "a", evidence: [], undo: "u", verdicts: [], at: ago(5), reviewedAt: ago(4), reverted: true }] },
      ]),
    );
    await new ReviewRunner(store, ready, channel).finalize(fake, "r1", 1, "complete");
    const task = (await first(store)).tasks[0]!;
    assert.equal(task.autoDecisions.length, 0);
    assert.equal(task.blocker?.review?.status, "failed");
    assert.match(task.blocker?.objections[0] ?? "", /적용 직전 확인/);
  });

  test("설정에서 자동 답변을 껐으면 통과해도 적용하지 않는다", async () => {
    const { store, channel } = await storeWith(request({}, [{ status: "blocked", blocker }]));
    const off: Fake = { read: async () => ({ status: "ready", values: { allowedProjectIds: ["p"], autoDecisions: false } }) };
    await new ReviewRunner(store, off, channel).finalize(fake, "r1", 1, "complete");
    assert.equal((await first(store)).tasks[0]!.autoDecisions.length, 0);
  });

  test("점검표는 이름마다 한 번씩이어야 한다", async () => {
    const { store, channel } = await storeWith(request({}, []));
    const submit = new ReviewRunner(store, ready, channel).tools(() => {}).find((item) => item.name.includes("submit_verdict"))!;
    const checks = Array.from({ length: 6 }, () => ({ name: "scope", pass: true, reason: "r" }));
    const parsed = (submit.input as Fake).safeParse({ verdict: "PASS", checks, objections: [] });
    assert.equal(parsed.success, false);
  });
});

describe("비밀 파일", () => {
  test(".envrc 같은 비밀 파일과 git 이 무시하는 파일은 읽지 않고, README 심볼릭 링크로 .git/config 를 읽지 못한다", async () => {
    const root = await mainCheckout();
    await writeFile(join(root, ".envrc"), "export AWS_SECRET_ACCESS_KEY=secret");
    await writeFile(join(root, ".gitignore"), "local.conf\n");
    await writeFile(join(root, "local.conf"), "token=secret");
    await symlink(join(root, ".git", "config"), join(root, "README.md"));
    const { store, channel } = await storeWith(request({}));
    const tool = tools(store, channel);
    const context: Fake = { paseo: fakePaseo(root), agent: { id: "c1" } };
    assert.match(String((await tool("coordinator_read_file").execute({ projectId: "p", path: ".envrc" }, context)).text), /may hold secrets/);
    assert.match(String((await tool("coordinator_read_file").execute({ projectId: "p", path: "local.conf" }, context)).text), /ignored by git/);
    const overview = String((await tool("coordinator_project_overview").execute({ projectId: "p" }, context)).text);
    assert.doesNotMatch(overview, /\[remote|url =/);
  });
});
