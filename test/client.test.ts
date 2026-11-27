/// <reference types="node" />

import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_STATE, type CoordinatorState, type Decision, type WorkRequest, type WorkspaceStatus } from "../shared/model";
import { lastAssistantText, previewBucket } from "../client/agent-preview";
import { attentionCards, classifierFor, factsOf, inboxGroups, reactionCount, sameFacts, toDirectory } from "../client/attention";
import { boardCells, indexDecisions, pullRequestState, rowColumn, signals, sortRows, unexplainedFiles } from "../client/board";
import { asksForStopped, summaryForError, summaryForStopped } from "../client/card-summaries";
import { toAgentRef, toWorkspaceRef } from "../client/refs";
import { openRequestCounts, pickRecipient, requestsByWorkspace } from "../client/requests";
import type { PermissionRequest } from "../client/permissions";

// 화면 로직은 React 없이 시험한다. .tsx 는 이 파일들을 그리기만 한다.

let seq = 0;
function decision(patch: Partial<Decision>): Decision {
  seq += 1;
  return {
    title: `d${seq}`,
    decision: "x",
    kind: "approach",
    why: "w",
    alternatives: [],
    evidence: [{ basis: "verified", text: "e" }],
    restsOnAssumption: false,
    reversible: "easy",
    files: [],
    id: `d${seq}`,
    number: seq,
    agentId: "a1",
    workspaceId: "w1",
    projectId: "p1",
    at: `2026-11-27T00:00:${String(seq).padStart(2, "0")}Z`,
    stop: false,
    status: "unreviewed",
    reply: null,
    callId: null,
    ...patch,
  };
}

function request(patch: Partial<WorkRequest>): WorkRequest {
  seq += 1;
  return { id: `r${seq}`, text: "t", projectId: "p1", workspaceId: "w1", agentId: "a1", source: "human", status: "queued", at: "now", sentAt: null, callId: null, ...patch };
}

const permission = (id: string, kind: string) => ({ id, kind }) as unknown as PermissionRequest;

function directoryOf(entries: Record<string, { pending?: PermissionRequest[]; lastError?: string }>) {
  return toDirectory(new Map(Object.entries(entries).map(([id, fact]) => [id, factsOf({ pendingPermissions: fact.pending ?? [], lastError: fact.lastError ?? null })])));
}

function stateWith(patch: Partial<CoordinatorState>): CoordinatorState {
  return { ...EMPTY_STATE, ...patch };
}

test("badge: one card per agent with stopped decisions, one per permission request, and its question folded into the decision card", () => {
  const state = stateWith({ decisions: [decision({ agentId: "a1", status: "waiting" }), decision({ agentId: "a1", status: "waiting" })] });
  const directory = directoryOf({
    a1: { pending: [permission("q1", "question")] },
    a2: { pending: [permission("t1", "tool"), permission("t2", "tool")] },
    a3: { lastError: "boom" },
  });
  // a1: 결정 카드 한 장(질문은 그 안), a2: 요청 두 장, a3: 에러 한 장.
  assert.equal(reactionCount(state, ["a1", "a2", "a3"], directory), 4);
  assert.deepEqual(attentionCards(directory, "a1", true), { requests: [], hidden: true });
  assert.equal(attentionCards(directory, "a1", false).requests.length, 1);
  // 결정이 없는 에이전트의 질문은 따로 센다.
  assert.equal(reactionCount(EMPTY_STATE, ["a1"], directory), 1);
});

test("agent facts only change when a pending request or the error changes", () => {
  const before = factsOf({ pendingPermissions: [permission("t1", "tool")], lastError: null });
  assert.equal(sameFacts(before, factsOf({ pendingPermissions: [permission("t1", "tool")], lastError: null })), true);
  assert.equal(sameFacts(before, factsOf({ pendingPermissions: [permission("t2", "tool")], lastError: null })), false);
  assert.equal(sameFacts(undefined, factsOf({ pendingPermissions: [], lastError: null })), true);
  const classify = classifierFor(directoryOf({ a1: { pending: [permission("t1", "tool")] } }));
  const agent = { id: "a1", status: "running", attentionReason: null, requiresAttention: false, background: false } as const;
  assert.equal(classify.state(agent), "permission");
  assert.equal(classify.needsMyDecision({ ...agent, background: true }), false);
});

test("inbox groups: stopped decisions by agent, decisions to review by workspace, oldest first", () => {
  const late = decision({ agentId: "a2", status: "waiting", at: "2026-11-27T02:00:00Z" });
  const early = decision({ agentId: "a1", status: "waiting", at: "2026-11-27T01:00:00Z" });
  const review = decision({ workspaceId: "w9", status: "unreviewed" });
  const { stopped, review: toReview } = inboxGroups(stateWith({ decisions: [late, early, review, decision({ status: "approved" })] }));
  assert.deepEqual(stopped.map(([agentId]) => agentId), ["a1", "a2"]);
  assert.deepEqual(toReview.map(([workspaceId, items]) => [workspaceId, items.length]), [["w9", 1]]);
});

test("changed files no decision covers leave out waiting and dropped decisions", () => {
  const status = { changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"], overlaps: [], pullRequest: null } as unknown as WorkspaceStatus;
  const decisions = [
    decision({ files: ["a.ts"], status: "unreviewed" }),
    decision({ files: ["b.ts"], status: "waiting" }),
    decision({ files: ["c.ts"], status: "dropped" }),
  ];
  assert.deepEqual(unexplainedFiles(status, decisions), ["b.ts", "c.ts", "d.ts"]);
  assert.deepEqual(unexplainedFiles(null, decisions), []);
});

test("row signals: unexplained files count only once the workspace has recorded decisions; a closed PR is no trouble", () => {
  const failing = { changedFiles: ["a.ts"], overlaps: [], pullRequest: { state: "OPEN", isMerged: false, checks: "failure", mergeable: "MERGEABLE" } } as unknown as WorkspaceStatus;
  assert.equal(signals(failing, []).unexplained, 0);
  assert.equal(signals(failing, []).prTrouble, true);
  assert.equal(signals(failing, [decision({ files: [] })]).unexplained, 1);
  const closed = { ...failing, pullRequest: { ...failing.pullRequest!, state: "CLOSED" } } as WorkspaceStatus;
  assert.equal(signals(closed, []).prTrouble, false);
});

test("row column: a waiting decision beats agent state, then agents, then signals to review", () => {
  const flags = { recorded: true, waiting: 0, unreviewed: 0, unexplained: 0, overlaps: 0, prTrouble: false };
  const running = new Map([["running" as const, [1]]]);
  assert.equal(rowColumn(running, { ...flags, waiting: 1 }), "react");
  assert.equal(rowColumn(running, flags), "running");
  assert.equal(rowColumn(undefined, { ...flags, overlaps: 2 }), "review");
  assert.equal(rowColumn(undefined, null), "waiting");
  const columns: Record<string, "react" | "review" | "running" | "waiting"> = { w1: "waiting", w2: "react", w3: "running", w4: "react" };
  assert.deepEqual(sortRows(["w1", "w2", "w3", "w4", "w2"], (id) => columns[id]!), ["w2", "w4", "w3", "w1"]);
});

test("board cells split the group key into workspace and column and count each column", () => {
  const { board, totals } = boardCells(
    [
      { key: "w1::react", items: ["x"] },
      { key: "w1::running", items: ["y", "z"] },
      { key: "w2::running", items: ["q"] },
    ],
    "::",
  );
  assert.deepEqual(board.get("w1")?.get("running"), ["y", "z"]);
  assert.equal(totals.get("running"), 3);
  const index = indexDecisions([decision({ agentId: "a1", status: "waiting" }), decision({ agentId: "a1", status: "approved" })]);
  assert.deepEqual(index.byAgent.get("a1"), { waiting: 1, unreviewed: 0 });
  assert.equal(index.byWorkspace.get("w1")?.length, 2);
});

test("pull request state: merged, then closed, then draft, then open", () => {
  assert.equal(pullRequestState({ isMerged: true, isDraft: true, state: "CLOSED" }), "merged");
  assert.equal(pullRequestState({ isMerged: false, isDraft: true, state: "CLOSED" }), "closed");
  assert.equal(pullRequestState({ isMerged: false, isDraft: true, state: "OPEN" }), "draft");
  assert.equal(pullRequestState({ isMerged: false, isDraft: false, state: "OPEN" }), "open");
  assert.equal(pullRequestState({ isMerged: false, isDraft: false, state: "WEIRD" }), "other");
});

test("the request recipient must be an agent of that workspace", () => {
  // 다른 워크스페이스에서 고른 채 남은 a9 는 고르지 않는다.
  assert.equal(pickRecipient(["a1", "a2"], "a9"), "a1");
  assert.equal(pickRecipient(["a1", "a2"], "a2"), "a2");
  assert.equal(pickRecipient(["a1", "a2"], null, "a2"), "a2");
  assert.equal(pickRecipient(["a1"], null, "gone"), "a1");
  assert.equal(pickRecipient([], "a1"), null);
});

test("requests group by workspace with open ones first, and counts skip sent and dismissed", () => {
  const requests = [
    request({ workspaceId: "w1", status: "sent" }),
    request({ workspaceId: "w2", status: "suggested" }),
    request({ workspaceId: "w2", status: "queued" }),
    request({ workspaceId: "w3", status: "dismissed" }),
    request({ workspaceId: null, status: "suggested" }),
  ];
  assert.deepEqual(requestsByWorkspace(requests).map(([id, items]) => [id, items.length]), [["w2", 2], ["w1", 1]]);
  assert.deepEqual(openRequestCounts(requests).get("w2"), { queued: 1, suggested: 1 });
  assert.equal(openRequestCounts(requests).has("w1"), false);
});

test("a stopped card shows only the summary and questions that are about its decisions", () => {
  const first = decision({ status: "waiting", at: "2026-11-27T10:00:00Z" });
  const older = { id: "s1", agentId: "a1", workspaceId: "w1", trigger: "decision" as const, decisionIds: ["old"], status: "done" as const, at: "2026-11-27T09:00:00Z", result: null, error: null };
  assert.equal(summaryForStopped(stateWith({ summaries: [older] }), "a1", [first]), null);
  assert.equal(summaryForStopped(stateWith({ summaries: [{ ...older, decisionIds: [first.id] }] }), "a1", [first])?.id, "s1");
  assert.equal(summaryForStopped(stateWith({ summaries: [{ ...older, at: "2026-11-27T10:00:01Z" }] }), "a1", [first])?.id, "s1");
  const asks = [
    { id: "q1", agentId: "a1", text: "before", at: "2026-11-27T09:59:00Z", answer: null, answeredAt: null },
    { id: "q2", agentId: "a1", text: "after", at: "2026-11-27T10:01:00Z", answer: null, answeredAt: null },
  ];
  assert.deepEqual(asksForStopped(stateWith({ asks }), "a1", [first]).map((item) => item.id), ["q2"]);
  // 에러 카드는 에러보다 1분 넘게 앞선 요약을 쓰지 않는다.
  assert.equal(summaryForError(stateWith({ summaries: [older] }), "a1", "2026-11-27T09:00:30Z")?.id, "s1");
  assert.equal(summaryForError(stateWith({ summaries: [older] }), "a1", "2026-11-27T09:02:00Z"), null);
});

test("card preview: the last assistant reply on one line, and a running agent re-reads at most every 30 seconds", () => {
  const page = {
    error: null,
    entries: [
      { item: { type: "assistant_message", text: "first" } },
      { item: { type: "assistant_message", text: "  last\n reply " } },
      { item: { type: "user_message", text: "next" } },
    ],
  } as unknown as Parameters<typeof lastAssistantText>[0];
  assert.equal(lastAssistantText(page), "last reply");
  assert.equal(lastAssistantText({ ...page, error: "gone" } as typeof page), null);
  assert.equal(previewBucket("2026-11-27T10:00:01Z", true), previewBucket("2026-11-27T10:00:29Z", true));
  assert.equal(previewBucket("2026-11-27T10:00:01Z", false), "2026-11-27T10:00:01Z");
});

test("refs carry the host and are reused for the same entity", () => {
  const ref = toAgentRef("host-a", "a1");
  assert.deepEqual({ ...ref }, { kind: "agent", key: JSON.stringify(["host-a", "a1"]), hostId: "host-a", id: "a1" });
  assert.equal(toAgentRef("host-a", "a1"), ref);
  assert.notEqual(toAgentRef("host-b", "a1"), ref);
  assert.equal(toWorkspaceRef("host-a", "a1").kind, "workspace");
});
