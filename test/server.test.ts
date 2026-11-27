/// <reference types="node" />

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANSWERED_IN_QUESTION_WINDOW, type DecisionInput, composeAnswer, readAnswer } from "../shared/model";
import { Actions, answerFromQuestion } from "../server/actions";
import { agentInstructions, recordDecision, relativeTo, saveSuggestion, shouldStop } from "../server/agent-tools";
import { outputLanguage } from "../shared/settings";
import { readError } from "../shared/errors";
import { MESSAGE_SEPARATOR, answerMessage, askMessage, readSentMessage, redoMessage, requestMessage, revertMessage } from "../shared/messages";
import { AgentGoneError, Outbox } from "../server/outbox";
import { replayLostCalls } from "../server/replay";
import type { PaseoApi } from "../server/paseo-api";
import { StateStore } from "../server/store";
import { Summarizer, parseResult } from "../server/summary";
import { WorkspaceStatusReader } from "../server/workspace-status";
import { WorkspaceDirectory } from "../server/workspaces";

const base: DecisionInput = {
  title: "Tests in test/",
  decision: "Put the test in test/store.test.js",
  kind: "approach",
  why: "No convention",
  alternatives: [],
  evidence: [{ basis: "verified", text: "git ls-files shows no tests" }],
  restsOnAssumption: false,
  reversible: "easy",
  files: ["test/store.test.js"],
};

async function tempStore() {
  return new StateStore(await mkdtemp(join(tmpdir(), "coord-state-")));
}

/** 에이전트 상태와 보낸 메시지를 흉내 내는 가짜 Paseo. 테스트가 필요한 부분만 있다. */
function fakePaseo(options: { status?: Record<string, string>; workspaces?: unknown[]; gone?: string[] } = {}) {
  const sent: { agentId: string; text: string }[] = [];
  const created: { prompt?: string; config?: { modeId?: string }; cwd?: string }[] = [];
  const reused: string[] = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () =>
          options.gone?.includes(agentId)
            ? null
            : { agent: { status: options.status?.[agentId] ?? "idle", pendingPermissions: [], archivedAt: null, title: agentId, lastError: null } },
        send: async (text: string) => {
          sent.push({ agentId, text });
        },
        timeline: { refetch: async () => ({ entries: [{ item: { type: "user_message", text: "Add delete endpoints" } }] }) },
      }),
      create: async (input: { prompt?: string; config?: { modeId?: string }; cwd?: string }) => {
        created.push(input);
        return {
          waitForFinish: async () => ({ status: "idle", error: null, lastMessage: JSON.stringify({ before: "b", ask: "a", after: [], watchOut: [] }) }),
          archive: async () => ({ archivedAt: "now" }),
        };
      },
    },
    providers: { listModes: async () => ({ modes: [{ id: "default" }, { id: "auto" }] }) },
    workspaces: {
      ref: (id: string) => ({
        agents: {
          create: async (input: { prompt?: string; config?: { modeId?: string } }) => {
            reused.push(id);
            return (paseo.agents as { create: (input: unknown) => Promise<unknown> }).create(input);
          },
        },
      }),
      list: async () => ({ entries: options.workspaces ?? [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) },
  };
  return { paseo: paseo as unknown as PaseoApi, sent, created, reused };
}

const where = { workspaceId: "w1", projectId: "p1", cwd: "/repo" };

test("stop rule: scope, data, api, ux, hard to undo, or resting on an assumption", () => {
  assert.equal(shouldStop(base), false);
  assert.equal(shouldStop({ ...base, kind: "dependency" }), false);
  for (const kind of ["scope", "data", "api", "ux"] as const) assert.equal(shouldStop({ ...base, kind }), true, kind);
  assert.equal(shouldStop({ ...base, reversible: "costly" }), true);
  assert.equal(shouldStop({ ...base, reversible: "irreversible" }), true);
  assert.equal(shouldStop({ ...base, restsOnAssumption: true }), true);
});

test("decision files are made relative to the workspace", () => {
  assert.equal(relativeTo("/repo", "/repo/src/a.ts"), "src/a.ts");
  assert.equal(relativeTo("/repo/", "./src/a.ts"), "src/a.ts");
  assert.equal(relativeTo("/repo", "src/a.ts"), "src/a.ts");
});

test("recorded decisions get numbers and a status from the stop rule", async () => {
  const store = await tempStore();
  const first = await recordDecision(store, "a1", where, { ...base, files: ["/repo/test/store.test.js"] });
  const second = await recordDecision(store, "a1", where, { ...base, kind: "api" });
  assert.equal(first.status, "unreviewed");
  assert.deepEqual(first.files, ["test/store.test.js"]);
  assert.equal(second.status, "waiting");
  assert.equal(second.number, first.number + 1);
});

test("answering sends every stopped decision of the agent in one message", async () => {
  const store = await tempStore();
  const { paseo, sent } = fakePaseo();
  await recordDecision(store, "a1", where, { ...base, kind: "api", decision: "DELETE /todos/:id" });
  await recordDecision(store, "a1", where, { ...base, kind: "data", decision: "JSON file" });
  await recordDecision(store, "a2", where, { ...base, kind: "ux" });
  const actions = new Actions(store, new Outbox(store));
  const result = await actions.answer(paseo, "a1", "Both as proposed");
  assert.equal(result.delivery, "sent");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /DELETE \/todos\/:id/);
  assert.match(sent[0]!.text, /JSON file/);
  assert.match(sent[0]!.text, /Both as proposed/);
  const state = await store.read();
  assert.deepEqual(
    state.decisions.map((item) => [item.agentId, item.status]),
    [
      ["a1", "answered"],
      ["a1", "answered"],
      ["a2", "waiting"],
    ],
  );
  await assert.rejects(actions.answer(paseo, "a1", "again"), /no decision waiting/);
});

test("a busy agent gets the message when it is idle again, a gone agent's messages are dropped", async () => {
  const store = await tempStore();
  const busy = fakePaseo({ status: { a1: "running" } });
  const outbox = new Outbox(store);
  assert.equal(await outbox.deliver(busy.paseo, "a1", "hello"), "queued");
  assert.equal(busy.sent.length, 0);
  const idle = fakePaseo();
  await outbox.flushAll(idle.paseo);
  assert.deepEqual(idle.sent, [{ agentId: "a1", text: "hello" }]);
  assert.deepEqual((await store.read()).outbox, {});
  await outbox.deliver(busy.paseo, "a9", "lost");
  await outbox.flushAll(fakePaseo({ gone: ["a9"] }).paseo);
  assert.deepEqual((await store.read()).outbox, {});
});

test("review: approve sends nothing, undo needs text and goes to each agent", async () => {
  const store = await tempStore();
  const { paseo, sent } = fakePaseo();
  const one = await recordDecision(store, "a1", where, base);
  const two = await recordDecision(store, "a2", where, base);
  const stopped = await recordDecision(store, "a2", where, { ...base, kind: "scope" });
  const actions = new Actions(store, new Outbox(store));
  assert.deepEqual(await actions.review(paseo, { decisionIds: [one.id], verdict: "approved", text: null }), { delivery: "none" });
  await assert.rejects(actions.review(paseo, { decisionIds: [two.id], verdict: "undo", text: " " }), /Write what to do/);
  // 멈춘 결정은 확인이 아니라 답으로 처리한다.
  await assert.rejects(actions.review(paseo, { decisionIds: [stopped.id], verdict: "approved", text: null }), /cannot be reviewed/);
  await actions.review(paseo, { decisionIds: [one.id, two.id], verdict: "undo", text: "Use src/ instead" });
  assert.equal(sent.length, 2);
  assert.deepEqual(new Set(sent.map((item) => item.agentId)), new Set(["a1", "a2"]));
  assert.equal(sent.length, 2);
  assert.equal(sent.every((item) => item.text.includes("Use src/ instead")), true);
});

/** 실제 서버처럼 보낸 요청을 sent 로 바꾸는 outbox 와 actions 를 묶는다. */
function wired(store: StateStore) {
  const outbox: Outbox = new Outbox(store, (ids): Promise<void> => actions.markSent(ids));
  const actions: Actions = new Actions(store, outbox);
  return { outbox, actions };
}

test("requests: an idle agent gets it at once, a busy agent when its turn ends, and a waiting one can be cancelled", async () => {
  const store = await tempStore();
  const { actions, outbox } = wired(store);
  const idle = fakePaseo();
  assert.deepEqual(await actions.addRequest(idle.paseo, { workspaceId: "w1", agentId: "a1", text: "Also add a README section", projectId: "p1" }), { delivery: "sent" });
  assert.match(idle.sent[0]!.text, /Also add a README section/);
  const busy = fakePaseo({ status: { a2: "running" } });
  await actions.addRequest(busy.paseo, { workspaceId: "w1", agentId: "a2", text: "first", projectId: "p1" });
  await actions.addRequest(busy.paseo, { workspaceId: "w1", agentId: "a2", text: "second", projectId: "p1" });
  let state = await store.read();
  assert.deepEqual(state.requests.map((item) => item.status), ["sent", "queued", "queued"]);
  await actions.dismissRequest(state.requests[2]!.id);
  const later = fakePaseo();
  await outbox.flushAll(later.paseo);
  state = await store.read();
  assert.deepEqual(state.requests.map((item) => item.status), ["sent", "sent", "dismissed"]);
  assert.equal(later.sent.length, 1);
  assert.match(later.sent[0]!.text, /first/);
  assert.doesNotMatch(later.sent[0]!.text, /second/);
  await assert.rejects(actions.dismissRequest(state.requests[1]!.id), /already sent/);
});

test("requests: an agent's suggestion is sent to the agent the person picks, or dismissed", async () => {
  const store = await tempStore();
  const { actions } = wired(store);
  const { paseo, sent } = fakePaseo();
  await saveSuggestion(store, "a1", where, "Add pagination later");
  const [suggestion] = (await store.read()).requests;
  assert.equal(suggestion!.status, "suggested");
  await actions.sendSuggestion(paseo, suggestion!.id, "a3");
  assert.equal(sent[0]!.agentId, "a3");
  assert.match(sent[0]!.text, /Add pagination later/);
  assert.equal((await store.read()).requests[0]!.status, "sent");
  await assert.rejects(actions.sendSuggestion(paseo, suggestion!.id, "a3"), /no longer open/);
});

test("review: revert asks to undo the change without needing a note", async () => {
  const store = await tempStore();
  const { paseo, sent } = fakePaseo();
  const decision = await recordDecision(store, "a1", where, base);
  const actions = new Actions(store, new Outbox(store));
  await actions.review(paseo, { decisionIds: [decision.id], verdict: "revert", text: null });
  assert.match(sent[0]!.text, /reverted/);
  assert.match(sent[0]!.text, /Tests in test\//);
  assert.equal((await store.read()).decisions[0]!.status, "revert");
});

test("ask first: a pending question window is sent back with the question; the agent's next reply is the answer", async () => {
  const store = await tempStore();
  const responded: unknown[] = [];
  const sent: string[] = [];
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { status: "running", archivedAt: null, pendingPermissions: [{ id: "perm1", kind: "question" }] } }),
        respondToPermission: async (input: unknown) => {
          responded.push(input);
        },
        send: async (text: string) => {
          sent.push(text);
        },
      }),
    },
  } as unknown as PaseoApi;
  const actions = new Actions(store, new Outbox(store));
  await actions.ask(paseo, "a1", "Why not cursor pagination?");
  assert.equal(sent.length, 0);
  assert.match(JSON.stringify(responded[0]), /perm1/);
  assert.match(JSON.stringify(responded[0]), /Why not cursor pagination/);
  await actions.recordAskAnswer("a1", "Cursor needs a stable sort key we do not have.");
  const [ask] = (await store.read()).asks;
  assert.equal(ask!.answer, "Cursor needs a stable sort key we do not have.");
});

test("summary JSON is parsed even inside a code block", () => {
  assert.deepEqual(parseResult('```json\n{"before":"b","ask":"a"}\n```'), { before: "b", ask: "a", after: [], watchOut: [] });
  assert.throws(() => parseResult("no json"), /did not return JSON/);
});

test("one summary covers the stopped decisions of a turn; nothing new means no second summary", async () => {
  const store = await tempStore();
  const { paseo, created } = fakePaseo();
  const settings = async () => ({ projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, outputLanguage: "auto" as const });
  const directory = new WorkspaceDirectory();
  const summarizer = new Summarizer(store, settings, directory, new WorkspaceStatusReader(directory), await mkdtemp(join(tmpdir(), "coord-summary-")));
  await recordDecision(store, "a1", where, { ...base, kind: "api" });
  await recordDecision(store, "a1", where, { ...base, kind: "data" });
  await summarizer.afterTurn(paseo, "a1", "w1", false, "ko", await settings());
  await waitFor(async () => (await store.read()).summaries[0]?.status === "done");
  const summary = (await store.read()).summaries[0]!;
  assert.equal(summary.decisionIds.length, 2);
  assert.equal(created.length, 1);
  assert.match(created[0]!.prompt!, /Korean/);
  assert.match(created[0]!.prompt!, /Add delete endpoints/);
  // 권한을 묻는 모드로 띄워야 도구 차단을 빠져나간 호출도 권한 hook 이 거절한다.
  assert.equal(created[0]!.config?.modeId, "default");
  await summarizer.afterTurn(paseo, "a1", "w1", false, "ko", await settings());
  assert.equal(created.length, 1);
});

async function waitFor(check: () => Promise<boolean>) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

test("workspace status: changed files against the base, overlaps, and no diff outside the changed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "coord-git-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "src/a.ts"), "a\n");
  await writeFile(join(repo, "src/b.ts"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const one = join(root, "one");
  const two = join(root, "two");
  git(repo, "worktree", "add", "-q", "-b", "one", one);
  git(repo, "worktree", "add", "-q", "-b", "two", two);
  await writeFile(join(one, "src/a.ts"), "a changed\n");
  git(one, "commit", "-qam", "one");
  await writeFile(join(one, "new.ts"), "new\n");
  await writeFile(join(two, "src/a.ts"), "a other\n");
  await writeFile(join(two, "src/b.ts"), "b other\n");
  const entry = (id: string, dir: string) => ({
    id,
    projectId: "p1",
    projectKind: "git",
    projectRootPath: repo,
    workspaceDirectory: dir,
    archivingAt: null,
    background: false,
    gitRuntime: { currentBranch: id },
    githubRuntime: { pullRequest: { number: 7, url: "u", title: "t", state: "OPEN", baseRefName: "main", headRefName: id, isMerged: false, checksStatus: "failure", checks: [{ name: "lint", status: "failure" }], mergeable: "MERGEABLE" } },
  });
  const { paseo } = fakePaseo({ workspaces: [entry("one", one), entry("two", two)] });
  const reader = new WorkspaceStatusReader(new WorkspaceDirectory());
  const statuses = await reader.read(paseo, ["p1"]);
  const first = statuses.find((item) => item.workspaceId === "one")!;
  const second = statuses.find((item) => item.workspaceId === "two")!;
  // origin 이 없으면 로컬 main 과의 merge-base 를 기준으로 쓴다.
  assert.equal(first.base, "main");
  assert.deepEqual(first.changedFiles, ["new.ts", "src/a.ts"]);
  assert.deepEqual(second.changedFiles, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(first.overlaps, [{ workspaceId: "two", files: ["src/a.ts"] }]);
  assert.equal(first.pullRequest?.checks, "failure");
  assert.deepEqual(first.pullRequest?.failedChecks, ["lint"]);
  const diff = await reader.diff(paseo, "one", ["src/a.ts", "new.ts", "../repo/src/b.ts", "/etc/hosts"]);
  assert.match(diff.files[0]!.diff, /\+a changed/);
  assert.match(diff.files[1]!.diff, /\+new/);
  assert.equal(diff.files[2]!.diff, "");
  assert.equal(diff.files[3]!.diff, "");
});

test("a failed turn is summarized at most once every 10 minutes per agent", async () => {
  const store = await tempStore();
  const { paseo, created } = fakePaseo();
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, outputLanguage: "auto" as const };
  const directory = new WorkspaceDirectory();
  const summarizer = new Summarizer(store, async () => values, directory, new WorkspaceStatusReader(directory), await mkdtemp(join(tmpdir(), "coord-summary-")));
  await summarizer.afterTurn(paseo, "a1", "w1", true, "en", values);
  await waitFor(async () => (await store.read()).summaries[0]?.status === "done");
  await summarizer.afterTurn(paseo, "a1", "w1", true, "en", values);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(created.length, 1);
});

test("a summary left running by a restart becomes failed when the state is read again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-state-"));
  const first = new StateStore(directory);
  await first.update((state) => ({
    state: { ...state, summaries: [{ id: "s1", agentId: "a1", workspaceId: "w1", trigger: "decision" as const, decisionIds: [], status: "running" as const, at: "now", result: null, error: null }] },
    result: undefined,
  }));
  const second = new StateStore(directory);
  assert.equal((await second.read()).summaries[0]!.status, "failed");
});

test("answers, undo and hand-offs to a gone agent fail and change nothing", async () => {
  const store = await tempStore();
  const { paseo, sent } = fakePaseo({ gone: ["a1"] });
  const stopped = await recordDecision(store, "a1", where, { ...base, kind: "api" });
  const kept = await recordDecision(store, "a1", where, base);
  const actions = new Actions(store, new Outbox(store));
  await assert.rejects(actions.answer(paseo, "a1", "ok"), /gone/);
  await assert.rejects(actions.review(paseo, { decisionIds: [kept.id], verdict: "undo", text: "change" }), /gone/);
  await assert.rejects(actions.addRequest(paseo, { workspaceId: "w1", agentId: "a1", text: "later", projectId: "p1" }), /gone/);
  const state = await store.read();
  assert.equal(state.decisions.find((item) => item.id === stopped.id)!.status, "waiting");
  assert.equal(state.decisions.find((item) => item.id === kept.id)!.status, "unreviewed");
  assert.equal(state.requests.length, 0);
  assert.equal(sent.length, 0);
});

test("non-ASCII file names and a workspace in a subfolder of the repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "coord-git-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "pkg"), { recursive: true });
  git(root, "init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "pkg/a.txt"), "a\n");
  await writeFile(join(repo, "top.txt"), "t\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  await writeFile(join(repo, "pkg/a.txt"), "a changed\n");
  await writeFile(join(repo, "pkg/한글 \"이름\".txt"), "new\n");
  await writeFile(join(repo, "top.txt"), "t changed\n");
  const cwd = join(repo, "pkg");
  const entry = { id: "sub", projectId: "p1", projectKind: "git", projectRootPath: repo, workspaceDirectory: cwd, archivingAt: null, background: false, gitRuntime: { currentBranch: "main" }, githubRuntime: null };
  const { paseo } = fakePaseo({ workspaces: [entry] });
  const reader = new WorkspaceStatusReader(new WorkspaceDirectory());
  const [status] = await reader.read(paseo, ["p1"]);
  // 워크스페이스 폴더 밖(top.txt)은 빠지고, 경로는 폴더 기준이며 한글과 따옴표가 바뀌지 않는다.
  assert.deepEqual(status!.changedFiles, ["a.txt", '한글 "이름".txt']);
  const diff = await reader.diff(paseo, "sub", ["a.txt", '한글 "이름".txt']);
  assert.match(diff.files[0]!.diff, /\+a changed/);
  assert.match(diff.files[1]!.diff, /\+new/);
});

test("status reads for different project sets do not share one result", async () => {
  const root = await mkdtemp(join(tmpdir(), "coord-git-"));
  const make = async (name: string) => {
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    git(root, "init", "-q", "-b", "main", repo);
    await writeFile(join(repo, "f.txt"), "f\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    await writeFile(join(repo, "f.txt"), "changed\n");
    return { id: name, projectId: name, projectKind: "git", projectRootPath: repo, workspaceDirectory: repo, archivingAt: null, background: false, gitRuntime: { currentBranch: "main" }, githubRuntime: null };
  };
  const { paseo } = fakePaseo({ workspaces: [await make("p1"), await make("p2")] });
  const reader = new WorkspaceStatusReader(new WorkspaceDirectory());
  const [one, both] = await Promise.all([reader.read(paseo, ["p1"]), reader.read(paseo, ["p1", "p2"])]);
  assert.deepEqual(one.map((item) => item.workspaceId), ["p1"]);
  assert.deepEqual(both.map((item) => item.workspaceId).sort(), ["p1", "p2"]);
});

test("an answer given in the agent's question window is recorded on its stopped decisions", async () => {
  const store = await tempStore();
  await recordDecision(store, "a1", where, { ...base, kind: "api" });
  await recordDecision(store, "a2", where, { ...base, kind: "api" });
  assert.equal(await answerFromQuestion(store, "a1", { answers: { "Page size?": "20, max 100" } }), 1);
  const [mine, other] = (await store.read()).decisions;
  assert.equal(mine!.status, "answered");
  assert.equal(mine!.reply?.text, "Page size?: 20, max 100");
  assert.equal(other!.status, "waiting");
});

test("tool calls lost to a plugin restart are recorded at the end of the turn, once", async () => {
  const store = await tempStore();
  const lost = (callId: string, name: string, input: unknown) => ({
    item: { type: "tool_call", callId, name, status: "failed", error: { content: `Tool ${name.replace("mcp__paseo__", "")} not found` }, detail: { input } },
  });
  const entries = [
    lost("c1", "mcp__paseo__record_decision", { ...base, kind: "api", decision: "page and limit" }),
    lost("c2", "mcp__paseo__add_followup", { text: "cursor pagination later" }),
    { item: { type: "tool_call", callId: "c3", name: "mcp__paseo__record_decision", status: "failed", error: { content: "validation failed" }, detail: { input: base } } },
  ];
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries }) } }) } } as unknown as PaseoApi;
  assert.equal(await replayLostCalls(paseo, store, "a1", where), 2);
  assert.equal(await replayLostCalls(paseo, store, "a1", where), 0);
  const state = await store.read();
  assert.deepEqual(state.decisions.map((item) => [item.decision, item.status, item.callId]), [["page and limit", "waiting", "c1"]]);
  assert.deepEqual(state.requests.map((item) => [item.text, item.status, item.callId]), [["cursor pagination later", "suggested", "c2"]]);
});

test("a lost stopped decision that the person already answered is not asked again", async () => {
  const store = await tempStore();
  const entries = [
    { item: { type: "tool_call", callId: "c1", name: "mcp__paseo__record_decision", status: "failed", error: { content: "Tool record_decision not found" }, detail: { input: { ...base, kind: "api" } } } },
    { item: { type: "tool_call", callId: "q1", name: "AskUserQuestion", status: "completed" } },
  ];
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries }) } }) } } as unknown as PaseoApi;
  await replayLostCalls(paseo, store, "a1", where);
  assert.equal((await store.read()).decisions[0]!.status, "answered");
});

test("summaries reuse one background workspace instead of creating one each time", async () => {
  const store = await tempStore();
  const home = await mkdtemp(join(tmpdir(), "coord-summary-"));
  const { paseo, created, reused } = fakePaseo({ workspaces: [{ id: "wsum", projectId: "psum", workspaceDirectory: home, projectRootPath: home, archivingAt: null, background: true }] });
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, outputLanguage: "auto" as const };
  const directory = new WorkspaceDirectory();
  const summarizer = new Summarizer(store, async () => values, directory, new WorkspaceStatusReader(directory), home);
  summarizer.request(paseo, "a1", "w1", "manual", "en");
  await waitFor(async () => (await store.read()).summaries[0]?.status === "done");
  assert.deepEqual(reused, ["wsum"]);
  assert.equal(created[0]!.cwd, undefined);
});

test("agent instructions name the language decisions are written in", () => {
  assert.match(agentInstructions(outputLanguage({ outputLanguage: "auto" }, "ko")), /record_decision.*in Korean/);
  assert.match(agentInstructions(outputLanguage({ outputLanguage: "en" }, "ko")), /record_decision.*in English/);
  // 화면이 아직 구독하지 않아 앱 언어를 모르면 영어로 가정하지 않고 사람이 쓰는 언어를 따르게 한다.
  assert.match(agentInstructions(outputLanguage({ outputLanguage: "auto" }, null)), /in the language the user writes to you in/);
});

test("the answer sent from a card reads back per decision", () => {
  const decisions = [
    { id: "d1", number: 3, title: "Persist todos: JSON file", decision: "x" },
    { id: "d2", number: 4, title: "Box count", decision: "y" },
  ];
  const text = composeAnswer(decisions, { d2: 'only "N 박스"' }, "  테스트 먼저  ");
  assert.deepEqual(readAnswer({ number: 3 }, text), { kind: "card", choice: null, note: "테스트 먼저" });
  assert.deepEqual(readAnswer({ number: 4 }, text), { kind: "card", choice: 'only "N 박스"', note: "테스트 먼저" });
  // #3 으로 시작하는 #30 을 #3 으로 잘못 읽지 않는다.
  assert.deepEqual(readAnswer({ number: 30 }, text), { kind: "text", text });
  assert.deepEqual(readAnswer({ number: 3 }, ANSWERED_IN_QUESTION_WINDOW), { kind: "questionWindow" });
  assert.deepEqual(readAnswer({ number: 3 }, "Which box rule?: pack count"), { kind: "text", text: "Which box rule?: pack count" });
});

test("the app language survives a plugin restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-lang-"));
  const first = new StateStore(directory);
  assert.equal((await first.read()).appLanguage, null);
  await first.update((state) => ({ state: { ...state, appLanguage: "ko" as const }, result: undefined }));
  assert.equal((await new StateStore(directory).read()).appLanguage, "ko");
});

test("messages the plugin sends read back as what the person did", () => {
  const decisions = [
    { id: "d1", number: 26, title: "Box count", decision: "N before 박스.\n#7 is not a decision line" },
    { id: "d2", number: 27, title: "Match by type", decision: "Look at Product Type" },
  ];
  const answer = answerMessage(decisions, composeAnswer(decisions, { d2: "name only" }, "테스트 먼저"));
  assert.deepEqual(readSentMessage(answer), [
    { kind: "answer", choices: [{ number: 26, choice: null }, { number: 27, choice: "name only" }], note: "테스트 먼저" },
  ]);
  const plain = [
    { number: 26, title: "Box count", decision: "N before 박스.\nCount packs." },
    { number: 27, title: "Match by type", decision: "Look at Product Type" },
  ];
  assert.deepEqual(readSentMessage(revertMessage(plain, null)), [{ kind: "revert", numbers: [26, 27], note: null }]);
  assert.deepEqual(readSentMessage(revertMessage(plain, "원래대로")), [{ kind: "revert", numbers: [26, 27], note: "원래대로" }]);
  assert.deepEqual(readSentMessage(redoMessage(plain.slice(0, 1), "팩 수로 세기")), [{ kind: "redo", numbers: [26], note: "팩 수로 세기" }]);
  // 일하는 동안 쌓인 메시지는 한 번에 간다.
  assert.deepEqual(readSentMessage([requestMessage("README 에 적기"), askMessage("왜 N 박스만?")].join(MESSAGE_SEPARATOR)), [
    { kind: "request", text: "README 에 적기" },
    { kind: "ask", text: "왜 N 박스만?" },
  ]);
  assert.deepEqual(readSentMessage("그냥 사람이 쓴 말"), [{ kind: "text", text: "그냥 사람이 쓴 말" }]);
  // 질문 창에서 온 답처럼 카드 형식이 아닌 답은 사람이 쓴 그대로 보인다.
  assert.deepEqual(readSentMessage(answerMessage(decisions, "Which rule?: pack count")), [{ kind: "text", text: "Which rule?: pack count" }]);
});

test("coded errors keep their code through a message string", () => {
  // RPC 를 거치면 message 만 남고, 호스트가 앞에 무언가를 붙일 수 있다.
  const sent = new Error(`Plugin RPC failed: ${new AgentGoneError("a1").message}`);
  assert.deepEqual(readError(sent), { code: "agentGone", message: "Plugin RPC failed: Agent a1 is gone (archived or deleted). Nothing was sent." });
  assert.deepEqual(readError(new Error("git diff: fatal: bad revision")), { code: null, message: "git diff: fatal: bad revision" });
  assert.deepEqual(readError("x [coordinator:unknownCode]"), { code: null, message: "x" });
});
