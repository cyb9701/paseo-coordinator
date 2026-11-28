/// <reference types="node" />

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ANSWERED_IN_QUESTION_WINDOW, type DecisionInput, composeAnswer, openReports, readAnswer } from "../shared/model";
import { Actions, answerFromQuestion } from "../server/actions";
import { agentInstructions, recordDecision, relativeTo, saveReport, saveSuggestion, shouldStop } from "../server/agent-tools";
import { outputLanguage } from "../shared/settings";
import { readError } from "../shared/errors";
import { MESSAGE_SEPARATOR, answerMessage, describeSentMessage, askMessage, readSentMessage, redoMessage, requestMessage, revertMessage } from "../shared/messages";
import { AgentGoneError, Outbox } from "../server/outbox";
import { replayLostCalls } from "../server/replay";
import type { PaseoApi } from "../server/paseo-api";
import { StateStore } from "../server/store";
import { Summarizer, parseResult } from "../server/summary";
import { CoordinatorHome, coordinatorCharter, coordinatorTools, digestPrompt, requestDigest } from "../server/coordinator";
import { AutoJudge, parseJudgment } from "../server/judge";
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
function fakePaseo(options: { status?: Record<string, string>; workspaces?: unknown[]; gone?: string[]; workspaceOf?: Record<string, string> } = {}) {
  const sent: { agentId: string; text: string }[] = [];
  const created: { prompt?: string; config?: { modeId?: string }; cwd?: string }[] = [];
  const reused: string[] = [];
  const workspacesCreated: unknown[] = [];
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () =>
          options.gone?.includes(agentId)
            ? null
            : {
                agent: {
                  status: options.status?.[agentId] ?? "idle",
                  pendingPermissions: [],
                  archivedAt: null,
                  title: agentId,
                  lastError: null,
                  workspaceId: options.workspaceOf?.[agentId] ?? "w1",
                },
              },
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
      create: async (input: unknown) => {
        workspacesCreated.push(input);
        return { id: `wnew${workspacesCreated.length}` };
      },
      list: async () => ({ entries: options.workspaces ?? [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) },
  };
  return { paseo: paseo as unknown as PaseoApi, sent, created, reused, workspacesCreated };
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
  const settings = async () => ({ projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const });
  const directory = new WorkspaceDirectory();
  const summarizer = new Summarizer(store, settings, directory, new WorkspaceStatusReader(directory), new CoordinatorHome(store, directory, await mkdtemp(join(tmpdir(), "coord-home-"))));
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
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const };
  const directory = new WorkspaceDirectory();
  const summarizer = new Summarizer(store, async () => values, directory, new WorkspaceStatusReader(directory), new CoordinatorHome(store, directory, await mkdtemp(join(tmpdir(), "coord-home-"))));
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

test("summaries run in the coordinator workspace instead of a project of their own", async () => {
  const store = await tempStore();
  const folder = await mkdtemp(join(tmpdir(), "coord-home-"));
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const };
  // 지난 버전이 같은 폴더로 만든 워크스페이스가 있으면 그것을 쓴다.
  {
    const { paseo, created, reused, workspacesCreated } = fakePaseo({ workspaces: [{ id: "wold", projectId: "pc", workspaceDirectory: folder, projectRootPath: folder, archivingAt: null }] });
    const directory = new WorkspaceDirectory();
    const summarizer = new Summarizer(store, async () => values, directory, new WorkspaceStatusReader(directory), new CoordinatorHome(store, directory, folder));
    summarizer.request(paseo, "a1", "w1", "manual", "en");
    await waitFor(async () => (await store.read()).summaries[0]?.status === "done");
    assert.deepEqual(reused, ["wold"]);
    assert.equal(workspacesCreated.length, 0);
    assert.equal((created[0] as { background?: boolean }).background, true);
    assert.equal((await store.read()).coordinator.workspaceId, "wold");
  }
  // 없으면 코디네이터 워크스페이스를 한 번 만들고 그다음부터는 그것을 쓴다.
  {
    const fresh = await tempStore();
    const { paseo, reused, workspacesCreated } = fakePaseo({ workspaces: [{ id: "wnew1", projectId: "pc", workspaceDirectory: folder, projectRootPath: folder, archivingAt: null }] });
    const directory = new WorkspaceDirectory();
    const home = new CoordinatorHome(fresh, directory, join(folder, "other"));
    const summarizer = new Summarizer(fresh, async () => values, directory, new WorkspaceStatusReader(directory), home);
    summarizer.request(paseo, "a1", "w1", "manual", "en");
    await waitFor(async () => (await fresh.read()).summaries[0]?.status === "done");
    summarizer.request(paseo, "a2", "w1", "manual", "en");
    await waitFor(async () => (await fresh.read()).summaries[1]?.status === "done");
    assert.equal(workspacesCreated.length, 1);
    assert.deepEqual((workspacesCreated[0] as { source: unknown }).source, { kind: "directory", path: join(folder, "other") });
    assert.deepEqual(reused, ["wnew1", "wnew1"]);
  }
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

test("the summary sees what the person did, not the plugin's long message", () => {
  const decisions = [{ id: "d1", number: 26, title: "Box count", decision: "N before 박스 must be a standalone number." }];
  const sent = [answerMessage(decisions, composeAnswer(decisions, {}, "테스트 먼저")), requestMessage("README 에 적기")].join(MESSAGE_SEPARATOR);
  assert.equal(describeSentMessage(sent), "[answered stopped decisions] #26 go ahead as proposed. Note: 테스트 먼저\n[additional request] README 에 적기");
  assert.equal(describeSentMessage("박스 수량 고쳐 줘"), "박스 수량 고쳐 줘");
});

test("a request for one workspace is not sent to an agent of another workspace", async () => {
  const store = await tempStore();
  const { actions } = wired(store);
  const { paseo, sent } = fakePaseo({ workspaceOf: { a1: "w2" } });
  await assert.rejects(actions.addRequest(paseo, { workspaceId: "w1", agentId: "a1", text: "README", projectId: "p1" }), /not in the workspace/);
  assert.equal(sent.length, 0);
  assert.equal((await store.read()).requests.length, 0);
});

test("after a turn, an agent that still looks busy for a moment gets the message once it is idle", async () => {
  const store = await tempStore();
  const outbox = new Outbox(store);
  const sent: string[] = [];
  let checks = 0;
  const paseo = {
    agents: {
      ref: () => ({
        // 턴 끝 hook 이 idle 반영보다 먼저 오는 경우를 흉내 낸다. 처음 두 번은 아직 running 이다.
        refresh: async () => ({ agent: { status: (checks += 1) <= 2 ? "running" : "idle", pendingPermissions: [], archivedAt: null } }),
        send: async (text: string) => {
          sent.push(text);
        },
      }),
    },
  } as unknown as PaseoApi;
  assert.equal(await outbox.deliver(paseo, "a1", "hello"), "queued");
  assert.equal(await outbox.flushAfterTurn(paseo, "a1", [1, 1, 1]), true);
  assert.deepEqual(sent, ["hello"]);
  // 계속 바쁘면 몇 번만 보고 멈춘다. 메시지는 남아 다음 턴 끝에 나간다.
  const stuck = fakePaseo({ status: { a2: "running" } });
  await outbox.deliver(stuck.paseo, "a2", "later");
  assert.equal(await outbox.flushAfterTurn(stuck.paseo, "a2", [1, 1]), false);
  assert.equal((await store.read()).outbox.a2?.length, 1);
});

test("two hooks replaying the same lost calls at once record them once, and other servers' tools are left alone", async () => {
  const store = await tempStore();
  const entries = [
    { item: { type: "tool_call", callId: "c1", name: "mcp__paseo__record_decision", status: "failed", error: { content: "Tool record_decision not found" }, detail: { type: "unknown", input: { ...base, kind: "api" }, output: null } } },
    { item: { type: "tool_call", callId: "c2", name: "mcp__other__record_decision", status: "failed", error: { content: "Tool record_decision not found" }, detail: { type: "unknown", input: base, output: null } } },
  ];
  const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => ({ entries }) } }) } } as unknown as PaseoApi;
  const counts = await Promise.all([replayLostCalls(paseo, store, "a1", where), replayLostCalls(paseo, store, "a1", where)]);
  assert.deepEqual(counts.sort(), [0, 1]);
  assert.deepEqual((await store.read()).decisions.map((item) => item.callId), ["c1"]);
});

test("the state file is readable only by its owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "coord-mode-"));
  const store = new StateStore(directory);
  await store.update((state) => ({ state: { ...state, appLanguage: "en" as const }, result: undefined }));
  assert.equal((await stat(join(directory, "state.json"))).mode & 0o777, 0o600);
});

test("plugin messages read back even when the person's words look like the message format", () => {
  const decisions = [
    { id: "d1", number: 12, title: "Paging", decision: "page and limit" },
    { id: "d2", number: 120, title: "Sort", decision: "by id" },
  ];
  // 고른 대안에 따옴표와 마침표가 들어 있고, 메모가 여러 문단이며 플러그인 문구 일부를 담고 있어도 읽힌다.
  const note = "첫 문단\n\nAnswer:\n둘째 문단";
  const card = composeAnswer(decisions, { d2: 'name "asc".' }, note);
  assert.deepEqual(readAnswer({ number: 12 }, card), { kind: "card", choice: null, note });
  assert.deepEqual(readAnswer({ number: 120 }, card), { kind: "card", choice: 'name "asc".', note });
  assert.deepEqual(readSentMessage(answerMessage(decisions, card)), [
    { kind: "answer", choices: [{ number: 12, choice: null }, { number: 120, choice: 'name "asc".' }], note },
  ]);
  assert.deepEqual(readSentMessage(revertMessage(decisions, "줄 하나\n줄 둘")), [{ kind: "revert", numbers: [12, 120], note: "줄 하나\n줄 둘" }]);
  assert.deepEqual(readSentMessage(redoMessage(decisions, "Do it this way instead:\n다르게")), [{ kind: "redo", numbers: [12, 120], note: "Do it this way instead:\n다르게" }]);
  assert.deepEqual(readSentMessage(askMessage("여러\n줄 질문")), [{ kind: "ask", text: "여러\n줄 질문" }]);
});

/** 코디네이터 도구용 가짜 Paseo. 관리 세션 목록과 세션마다 대화가 있다. */
function boardPaseo(agents: { id: string; workspaceId: string; status?: string; text?: string; background?: boolean }[]) {
  const sent: { agentId: string; text: string }[] = [];
  const timeline: Record<string, string> = Object.fromEntries(agents.map((item) => [item.id, item.text ?? "Which branch should I base this on?"]));
  const snapshot = (item: (typeof agents)[number]) => ({
    id: item.id,
    title: item.id,
    status: item.status ?? "idle",
    workspaceId: item.workspaceId,
    archivedAt: null,
    pendingPermissions: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    background: item.background ?? false,
  });
  const paseo = {
    agents: {
      list: async () => ({ entries: agents.map((item) => ({ agent: snapshot(item) })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (agentId: string) => ({
        refresh: async () => {
          const item = agents.find((entry) => entry.id === agentId);
          return item ? { agent: snapshot(item) } : null;
        },
        send: async (text: string) => {
          sent.push({ agentId, text });
        },
        timeline: {
          refetch: async () => ({
            entries: [
              { item: { type: "user_message", text: "Add delete endpoints" }, timestamp: "t1" },
              { item: { type: "assistant_message", text: timeline[agentId] ?? "" }, timestamp: "t2" },
            ],
          }),
        },
      }),
    },
    workspaces: {
      list: async () => ({
        entries: [
          { id: "w1", projectId: "p1", projectDisplayName: "app", name: "feature", title: null, workspaceDirectory: "/repo", projectRootPath: "/repo", archivingAt: null },
          { id: "w9", projectId: "p9", projectDisplayName: "other", name: "x", title: null, workspaceDirectory: "/other", projectRootPath: "/other", archivingAt: null },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      }),
    },
  };
  return { paseo: paseo as unknown as PaseoApi, sent, timeline };
}

async function boardSetup(agents: Parameters<typeof boardPaseo>[0]) {
  const store = await tempStore();
  await store.update((state) => ({ state: { ...state, coordinator: { workspaceId: "wc", agentId: "coord" } }, result: undefined }));
  const fake = boardPaseo(agents);
  const directory = new WorkspaceDirectory();
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const };
  const deps = { store, outbox: new Outbox(store), directory, statuses: new WorkspaceStatusReader(directory), readSettings: async () => values };
  const [read, judge, fact, review] = coordinatorTools(deps);
  const ctx = (agentId = "coord") => ({ agent: { id: agentId, workspaceId: "wc" }, paseo: fake.paseo, signal: new AbortController().signal }) as never;
  const call = async (tool: typeof read, input: unknown, agentId?: string) => JSON.parse((await tool!.execute(input, ctx(agentId))).text ?? "null") as unknown;
  const run = async (tool: typeof read, input: unknown, agentId?: string) => (await tool!.execute(input, ctx(agentId))).text;
  return { store, deps, fake, read: read!, judge: judge!, fact: fact!, review: review!, call, run };
}

test("the coordinator lists only managed sessions and reads one with an evidence id", async () => {
  const { read, call, run } = await boardSetup([
    { id: "a1", workspaceId: "w1" },
    { id: "a2", workspaceId: "w1", status: "running" },
    { id: "a3", workspaceId: "w9" },
    { id: "a4", workspaceId: "w1", background: true },
  ]);
  const listing = (await call(read, {})) as { agentId: string; needsJudgment: boolean }[];
  assert.deepEqual(listing.map((item) => [item.agentId, item.needsJudgment]), [["a1", true], ["a2", false]]);
  const one = (await call(read, { agentId: "a1" })) as { evidenceId: string; turns: unknown[] };
  assert.equal(one.evidenceId.length, 16);
  assert.equal(one.turns.length, 2);
  await assert.rejects(run(read, { agentId: "a3" }), /not a managed session/);
  // 지정이 바뀐 뒤 이전 코디네이터 세션은 읽지 못한다.
  await assert.rejects(run(read, {}, "old-coordinator"), /no longer the coordinator/);
});

test("a judgment needs fresh evidence, an idle session and the fields of its kind", async () => {
  const { store, read, judge, call, run, fake } = await boardSetup([{ id: "a1", workspaceId: "w1" }]);
  const { evidenceId } = (await call(read, { agentId: "a1" })) as { evidenceId: string };
  await assert.rejects(run(judge, { agentId: "a1", evidenceId, kind: "question", question: "Which branch?" }), /recommendation or needsInput/);
  await assert.rejects(run(judge, { agentId: "a1", evidenceId, kind: "review" }), /needs check/);
  await run(judge, { agentId: "a1", evidenceId, kind: "question", question: "Which branch?", recommendation: "Use main.", reason: "Repo default" });
  assert.equal((await store.read()).judgments[0]!.recommendation, "Use main.");
  // 대화가 바뀐 뒤에 쓴 판정은 받지 않는다.
  fake.timeline.a1 = "Now I need the API key.";
  await assert.rejects(run(judge, { agentId: "a1", evidenceId, kind: "idle" }), /changed since you read it/);
  // 멈춘 결정이 있는 세션은 이미 카드가 있다.
  const fresh = (await call(read, { agentId: "a1" })) as { evidenceId: string };
  await recordDecision(store, "a1", where, { ...base, kind: "api" });
  await assert.rejects(run(judge, { agentId: "a1", evidenceId: fresh.evidenceId, kind: "idle" }), /already has a card/);
});

test("factual answers go out only inside a digest the person requested, once per session", async () => {
  const { store, read, fact, call, run, fake } = await boardSetup([{ id: "a1", workspaceId: "w1" }]);
  const { evidenceId } = (await call(read, { agentId: "a1" })) as { evidenceId: string };
  await assert.rejects(run(fact, { cycleId: "c1", agentId: "a1", evidenceId, answer: "main" }), /No digest/);
  await store.update((state) => ({ state: { ...state, digest: { cycleId: "c1", at: new Date().toISOString(), agentId: "coord" } }, result: undefined }));
  await run(fact, { cycleId: "c1", agentId: "a1", evidenceId, answer: "Base it on main." });
  assert.equal(fake.sent.length, 1);
  assert.equal(readSentMessage(fake.sent[0]!.text)[0]!.kind, "fact");
  assert.equal((await store.read()).facts[0]!.answer, "Base it on main.");
  await assert.rejects(run(fact, { cycleId: "c1", agentId: "a1", evidenceId, answer: "again" }), /already answered/);
  // 오래된 주기로는 답하지 못한다.
  await store.update((state) => ({ state: { ...state, digest: { cycleId: "c2", at: "2020-01-01T00:00:00.000Z", agentId: "coord" } }, result: undefined }));
  await assert.rejects(run(fact, { cycleId: "c2", agentId: "a1", evidenceId, answer: "x" }), /No digest/);
});

test("reports: verified ones close, needsPerson ones stay for the person, and the person can close them", async () => {
  const { store, deps, review, call, run } = await boardSetup([{ id: "a1", workspaceId: "w1" }]);
  const evidence = [{ basis: "verified" as const, text: "npm test passed" }];
  const r1 = await saveReport(store, "a1", where, { status: "done", summary: "Added endpoints", evidence, files: ["/repo/src/a.ts"] });
  const r2 = await saveReport(store, "a1", where, { status: "blocked", summary: "Need API key", evidence, files: [] });
  assert.deepEqual(r1!.files, ["src/a.ts"]);
  assert.equal(((await call(review, {})) as unknown[]).length, 2);
  await run(review, { reportId: r1!.id, verdict: "verified", note: "tests shown" });
  await run(review, { reportId: r2!.id, verdict: "needsPerson", note: "blocked" });
  const state = await store.read();
  assert.deepEqual(openReports(state).map((item) => item.id), [r2!.id]);
  assert.equal(((await call(review, {})) as unknown[]).length, 0);
  await new Actions(store, deps.outbox).closeReport(r2!.id);
  assert.equal(openReports(await store.read()).length, 0);
});

test("replying to a judgment sends the person's text as is and drops the card", async () => {
  const { store, deps, read, judge, call, run, fake } = await boardSetup([{ id: "a1", workspaceId: "w1" }]);
  const { evidenceId } = (await call(read, { agentId: "a1" })) as { evidenceId: string };
  await run(judge, { agentId: "a1", evidenceId, kind: "question", question: "Which branch?", recommendation: "Use main." });
  const actions = new Actions(store, deps.outbox);
  await actions.replyJudgment(fake.paseo, "a1", "Use develop.");
  assert.deepEqual(fake.sent, [{ agentId: "a1", text: "Use develop." }]);
  assert.equal((await store.read()).judgments.length, 0);
  await assert.rejects(actions.replyJudgment(fake.paseo, "a1", "again"), (error) => readError(error).code === "noJudgment");
});

test("the digest prompt and charter keep the coordinator to judging, answering facts and reviewing", () => {
  assert.match(digestPrompt("c9"), /cycleId: c9/);
  const charter = coordinatorCharter("ko");
  assert.match(charter, /in Korean/);
  assert.match(charter, /Never use it to approve/);
  assert.doesNotMatch(charter, /assign_|create_agent/);
});

test("the coordinator session is created without toolPolicy, with its tools allowed for Claude", async () => {
  const store = await tempStore();
  const { paseo, created } = fakePaseo({ workspaces: [{ id: "wc", projectId: "pc", workspaceDirectory: "/home", projectRootPath: "/home", archivingAt: null }] });
  const directory = new WorkspaceDirectory();
  const home = new CoordinatorHome(store, directory, "/home");
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const };
  await store.update((state) => ({ state: { ...state, coordinator: { workspaceId: "wc", agentId: null } }, result: undefined }));
  const fake = paseo as unknown as { workspaces: { ref: (id: string) => { agents: { create: (input: unknown) => Promise<{ id: string }> } } } };
  const inputs: unknown[] = [];
  fake.workspaces.ref = () => ({ agents: { create: async (input) => (inputs.push(input), { id: "coord-1" }) } });
  assert.equal(await home.agent(paseo, values, "ko"), "coord-1");
  const config = (inputs[0] as { config: Record<string, unknown> }).config;
  assert.equal(config.toolPolicy, undefined);
  assert.deepEqual((config.options as { allowedTools: string[] }).allowedTools, ["mcp__paseo__read_sessions", "mcp__paseo__record_judgment", "mcp__paseo__answer_fact", "mcp__paseo__review_reports"]);
  assert.equal((await store.read()).coordinator.agentId, "coord-1");
  assert.equal(created.length, 0);
});

/** 판정 에이전트를 흉내 낸다: 코디네이터 워크스페이스에 만들어지고, 정해 둔 JSON 을 돌려준다. */
function withJudge(fake: ReturnType<typeof boardPaseo>, answer: unknown, onCreate?: () => void) {
  const created: { background?: boolean; labels?: Record<string, string>; prompt?: string }[] = [];
  const paseo = fake.paseo as unknown as Record<string, unknown>;
  paseo.providers = { listModes: async () => ({ modes: [{ id: "default" }] }) };
  const workspaces = paseo.workspaces as Record<string, unknown>;
  workspaces.ref = () => ({
    agents: {
      create: async (input: (typeof created)[number]) => {
        created.push(input);
        onCreate?.();
        return { waitForFinish: async () => ({ status: "idle", error: null, lastMessage: JSON.stringify(answer) }), archive: async () => ({}) };
      },
    },
  });
  return created;
}

async function judgeSetup(agents: Parameters<typeof boardPaseo>[0], answer: unknown, onCreate?: (fake: ReturnType<typeof boardPaseo>) => void) {
  const setup = await boardSetup(agents);
  const created = withJudge(setup.fake, answer, () => onCreate?.(setup.fake));
  const home = new CoordinatorHome(setup.store, setup.deps.directory, "/home");
  await setup.store.update((state) => ({ state: { ...state, coordinator: { workspaceId: "wc", agentId: "coord" } }, result: undefined }));
  (setup.deps.directory as unknown as { find: () => Promise<unknown> }).find = async () => ({ id: "wc", archivingAt: null });
  const judge = new AutoJudge(setup.deps, home, async () => "ko");
  return { ...setup, created, judge };
}

test("a turn that ends with no card is judged by a one-off agent that only makes a card", async () => {
  const answer = { kind: "question", question: "어느 브랜치에서 할까요?", recommendation: "main 에서 하세요.", reason: "기본 브랜치", needsInput: null, check: null, options: ["main", "develop"] };
  const { store, created, judge, fake } = await judgeSetup([{ id: "a1", workspaceId: "w1" }], answer);
  judge.request(fake.paseo, "a1");
  await judge.idle();
  assert.equal(created.length, 1);
  assert.equal(created[0]!.background, true);
  assert.equal(created[0]!.labels?.["paseo-coordinator.role"], "judge");
  assert.match(created[0]!.prompt ?? "", /in Korean/);
  const [judgment] = (await store.read()).judgments;
  assert.equal(judgment!.recommendation, "main 에서 하세요.");
  assert.deepEqual(judgment!.options, ["main", "develop"]);
  // 판정은 에이전트에게 말을 걸지 않는다.
  assert.equal(fake.sent.length, 0);
});

test("auto judgment skips sessions with a card and drops a judgment the conversation outran", async () => {
  const answer = { kind: "review", question: null, recommendation: null, reason: null, needsInput: null, check: "PR 을 열어 보세요.", options: [] };
  // 멈춘 결정이 있으면 판정 에이전트를 띄우지도 않는다.
  {
    const { store, created, judge, fake } = await judgeSetup([{ id: "a1", workspaceId: "w1" }], answer);
    await recordDecision(store, "a1", where, { ...base, kind: "api" });
    judge.request(fake.paseo, "a1");
    await judge.idle();
    assert.equal(created.length, 0);
  }
  // 판정하는 동안 대화가 바뀌면 버린다.
  {
    const { store, created, judge, fake } = await judgeSetup([{ id: "a1", workspaceId: "w1" }], answer, (current) => {
      current.timeline.a1 = "다시 일하는 중입니다.";
    });
    judge.request(fake.paseo, "a1");
    await judge.idle();
    assert.equal(created.length, 1);
    assert.equal((await store.read()).judgments.length, 0);
  }
});

test("a judgment missing the fields of its kind is rejected", () => {
  assert.throws(() => parseJudgment(JSON.stringify({ kind: "question", question: "x" })), /recommendation or needsInput/);
  assert.throws(() => parseJudgment(JSON.stringify({ kind: "review" })), /needs check/);
  assert.equal(parseJudgment("```json\n" + JSON.stringify({ kind: "idle" }) + "\n```").kind, "idle");
});

test("each digest starts a fresh coordinator session and is refused while the previous one is still working", async () => {
  const values = { projectIds: ["p1"], summary: { enabled: true, model: "claude/claude-haiku-5-5", effort: null }, coordinator: { model: "claude/claude-sonnet-5-5", effort: null }, outputLanguage: "auto" as const };
  const run = async (previousStatus: string) => {
    const store = await tempStore();
    await store.update((state) => ({ state: { ...state, coordinator: { workspaceId: "wc", agentId: "old" } }, result: undefined }));
    const archived: string[] = [];
    const sent: { agentId: string; text: string }[] = [];
    let made = 0;
    const statusOf = (id: string) => (id === "old" ? previousStatus : "idle");
    const paseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => (archived.includes(id) ? { agent: { status: "closed", archivedAt: "now", pendingPermissions: [] } } : { agent: { status: statusOf(id), archivedAt: null, pendingPermissions: [] } }),
          archive: async () => {
            archived.push(id);
            return {};
          },
          send: async (text: string) => {
            sent.push({ agentId: id, text });
          },
        }),
      },
      providers: { listModes: async () => ({ modes: [] }) },
      workspaces: {
        ref: () => ({ agents: { create: async () => ({ id: `new${++made}` }) } }),
        list: async () => ({ entries: [{ id: "wc", projectId: "pc", workspaceDirectory: "/home", projectRootPath: "/home", archivingAt: null }], pageInfo: { hasMore: false } }),
      },
    } as unknown as PaseoApi;
    const directory = new WorkspaceDirectory();
    const deps = { store, outbox: new Outbox(store), directory, statuses: new WorkspaceStatusReader(directory), readSettings: async () => values };
    await requestDigest(paseo, deps, new CoordinatorHome(store, directory, "/home"), "ko");
    return { archived, sent, state: await store.read() };
  };
  const idle = await run("idle");
  assert.deepEqual(idle.archived, ["old"]);
  assert.equal(idle.state.coordinator.agentId, "new1");
  assert.equal(idle.state.digest?.agentId, "new1");
  assert.equal(idle.sent[0]!.agentId, "new1");
  // 이전 세션이 일하는 중이면 끊지도 쌓지도 않고 거절한다.
  await assert.rejects(run("running"), (error) => readError(error).code === "coordinatorBusy");
});
