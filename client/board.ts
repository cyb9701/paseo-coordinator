import type { Decision, PullRequest, WorkspaceStatus } from "../shared/model";
import { COLUMN_KEYS, type ColumnKey } from "./agent-state";

export interface DecisionIndex {
  byWorkspace: Map<string, Decision[]>;
  byAgent: Map<string, { waiting: number; unreviewed: number }>;
}

export function indexDecisions(decisions: readonly Decision[]): DecisionIndex {
  const byWorkspace = new Map<string, Decision[]>();
  const byAgent = new Map<string, { waiting: number; unreviewed: number }>();
  for (const item of decisions) {
    byWorkspace.set(item.workspaceId, [...(byWorkspace.get(item.workspaceId) ?? []), item]);
    if (item.status !== "waiting" && item.status !== "unreviewed") continue;
    const counts = byAgent.get(item.agentId) ?? { waiting: 0, unreviewed: 0 };
    if (item.status === "waiting") counts.waiting += 1;
    else counts.unreviewed += 1;
    byAgent.set(item.agentId, counts);
  }
  return { byWorkspace, byAgent };
}

/** 어느 결정에도 적히지 않은 변경 파일. 에이전트가 기록하지 않고 내린 판단이 숨어 있을 수 있는 곳이다. */
export function unexplainedFiles(status: WorkspaceStatus | null, decisions: readonly Decision[]): string[] {
  if (!status) return [];
  // 답을 기다리는 결정은 아직 구현되지 않았다. 그 파일이 바뀌었다면 결정이 설명하는 변경이 아니다.
  const covered = new Set(decisions.filter((item) => item.status !== "dropped" && item.status !== "waiting").flatMap((item) => item.files));
  return status.changedFiles.filter((file) => !covered.has(file));
}

export function isOpenPullRequest(pr: Pick<PullRequest, "isMerged" | "state"> | null | undefined): boolean {
  return Boolean(pr && !pr.isMerged && pr.state.toLowerCase() === "open");
}

/** PR 상태 칩의 종류. 머지 > 닫힘 > 초안 > 열림 순서다. 닫힌 초안을 '초안'으로 보이면 아직 진행 중인 것처럼 읽힌다. */
export function pullRequestState(pr: Pick<PullRequest, "isMerged" | "isDraft" | "state">): "merged" | "closed" | "draft" | "open" | "other" {
  const raw = pr.state.toLowerCase();
  if (pr.isMerged) return "merged";
  if (raw === "closed") return "closed";
  if (pr.isDraft) return "draft";
  return raw === "open" ? "open" : "other";
}

export interface WorkspaceSignals {
  recorded: boolean;
  waiting: number;
  unreviewed: number;
  unexplained: number;
  overlaps: number;
  prTrouble: boolean;
}

/** 지켜보는 워크스페이스에서 사람이 봐야 할 신호. 행의 띠 색과 정렬에 쓴다. */
export function signals(status: WorkspaceStatus | null, decisions: readonly Decision[]): WorkspaceSignals {
  const pr = status?.pullRequest;
  // 결정이 하나도 없는 워크스페이스(플러그인을 켜기 전부터 하던 일)는 바뀐 파일이 모두 '결정에 없는 변경'이 된다. 경고로 세면
  // 정작 봐야 할 신호가 묻혀서, 결정이 기록된 워크스페이스에서만 센다.
  const recorded = decisions.some((item) => item.status !== "dropped");
  return {
    recorded,
    waiting: decisions.filter((item) => item.status === "waiting").length,
    unreviewed: decisions.filter((item) => item.status === "unreviewed").length,
    unexplained: recorded ? unexplainedFiles(status, decisions).length : 0,
    overlaps: status?.overlaps.length ?? 0,
    // 머지되거나 닫힌 PR 의 체크 실패와 충돌은 더 할 일이 없다.
    prTrouble: isOpenPullRequest(pr) && (pr?.checks === "failure" || pr?.mergeable === "CONFLICTING"),
  };
}

/** 행의 열(띠 색과 정렬). 결정 신호가 에이전트 상태보다 먼저다. 쉬는 에이전트라도 답을 기다리는 결정이 있으면 나를 기다린다. */
export function rowColumn(cells: ReadonlyMap<ColumnKey, readonly unknown[]> | undefined, flags: WorkspaceSignals | null): ColumnKey {
  if (flags && (flags.waiting > 0 || flags.prTrouble)) return "react";
  const fromAgents = COLUMN_KEYS.find((key) => (cells?.get(key)?.length ?? 0) > 0);
  if (fromAgents) return fromAgents;
  if (flags && (flags.unreviewed || flags.unexplained || flags.overlaps)) return "review";
  return "waiting";
}

/** 사람을 더 기다리는 행이 위로 온다. 같은 열 안에서는 받은 순서(최근 활동순)를 지킨다. */
export function sortRows(rows: Iterable<string>, column: (workspaceId: string) => ColumnKey): string[] {
  const rank = (workspaceId: string) => COLUMN_KEYS.indexOf(column(workspaceId));
  return [...new Set(rows)].sort((a, b) => rank(a) - rank(b));
}

/** useAgents 의 묶음 key(워크스페이스 + 열)를 행마다 열별 카드로 바꾸고, 열마다 카드 수를 센다. */
export function boardCells<Ref>(groups: readonly { key: string; items: readonly Ref[] }[], separator: string) {
  const board = new Map<string, Map<ColumnKey, readonly Ref[]>>();
  const totals = new Map<ColumnKey, number>();
  for (const group of groups) {
    const at = group.key.lastIndexOf(separator);
    const workspaceId = group.key.slice(0, at);
    const key = group.key.slice(at + separator.length) as ColumnKey;
    if (!board.has(workspaceId)) board.set(workspaceId, new Map());
    board.get(workspaceId)!.set(key, group.items);
    totals.set(key, (totals.get(key) ?? 0) + group.items.length);
  }
  return { board, totals };
}
