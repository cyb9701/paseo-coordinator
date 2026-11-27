/// <reference types="node" />

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DecisionInput } from "../shared/model";
import { Actions, answerFromQuestion } from "../server/actions";
import { recordDecision, relativeTo, shouldStop } from "../server/agent-tools";
import { Outbox } from "../server/outbox";
import { replayLostCalls } from "../server/replay";
import type { PaseoApi } from "../server/paseo-api";
import { StateStore } from "../server/store";
import { Summarizer, parseResult } from "../server/summary";
import { WorkspaceStatusReader } from "../server/workspace-status";
import { WorkspaceDirectory } from "../server/workspaces";

const base: DecisionInput = {
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

test("follow-ups: add, hand to an agent once", async () => {
  const store = await tempStore();
  const { paseo, sent } = fakePaseo();
  const actions = new Actions(store, new Outbox(store));
  await actions.addFollowup({ text: "Add pagination", projectId: "p1", workspaceId: null });
  const [followup] = (await store.read()).followups;
  await actions.sendFollowup(paseo, followup!.id, "a3");
  assert.match(sent[0]!.text, /Add pagination/);
  const after = (await store.read()).followups[0]!;
  assert.equal(after.status, "done");
  assert.equal(after.sentTo, "a3");
  await assert.rejects(actions.sendFollowup(paseo, followup!.id, "a3"), /not open/);
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
  await actions.addFollowup({ text: "later", projectId: "p1", workspaceId: null });
  const followup = (await store.read()).followups[0]!;
  await assert.rejects(actions.sendFollowup(paseo, followup.id, "a1"), /gone/);
  const state = await store.read();
  assert.equal(state.decisions.find((item) => item.id === stopped.id)!.status, "waiting");
  assert.equal(state.decisions.find((item) => item.id === kept.id)!.status, "unreviewed");
  assert.equal(state.followups[0]!.status, "open");
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
  assert.deepEqual(state.followups.map((item) => [item.text, item.callId]), [["cursor pagination later", "c2"]]);
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
