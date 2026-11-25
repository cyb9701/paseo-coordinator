import type { PluginAgentSnapshot, PluginTheme } from "@getpaseo/plugin";

// 진행 현황 칸반, 인박스, 사이드바 배지가 같은 기준으로 상태를 세도록 한 곳에서 판정한다.
// 순서가 중요하다. 권한을 기다리는 에이전트는 status 가 아직 "running" 이라서,
// attentionReason 을 먼저 봐야 "실행 중"이 아니라 "결정 필요"로 보인다.
export type AgentStateKey =
  | "permission"
  | "error"
  | "finished"
  | "running"
  | "initializing"
  | "idle"
  | "closed";

/**
 * 진행 현황 컬럼. 왼쪽일수록 사람을 더 기다린다.
 * - react: 작업이 멈춰서 나를 기다린다 (RULES.md §12 반응 필요)
 * - review: 작업은 계속되고, 나중에 봐도 된다 (RULES.md §12 확인 필요)
 * - auto: 코디네이터와 검토자가 대신 판단하는 중이다 (RULES.md §2 ④~⑥). 3·6단계부터 채워진다
 * - running: 워커가 일하는 중이다
 * - waiting: 시작 전이거나 세션이 쉬는 중이다
 * 완료된 요청은 컬럼이 아니라 보드 아래에 접어 둔다. 끝난 일이 칸을 차지하면 멈춘 일이 덜 보인다.
 */
export type ColumnKey = "react" | "review" | "auto" | "running" | "waiting";

interface StateInfo {
  label: string;
  column: ColumnKey;
}

const STATES: Record<AgentStateKey, StateInfo> = {
  permission: { label: "결정 필요", column: "react" },
  error: { label: "에러", column: "react" },
  finished: { label: "결과 미확인", column: "review" },
  running: { label: "실행 중", column: "running" },
  initializing: { label: "시작 중", column: "running" },
  idle: { label: "대기", column: "waiting" },
  closed: { label: "세션 닫힘", column: "waiting" },
};

export const COLUMNS: readonly { key: ColumnKey; label: string; hint: string }[] = [
  { key: "react", label: "내 결정 필요", hint: "작업이 나를 기다림" },
  { key: "review", label: "확인 필요", hint: "진행 중, 나중에 봐도 됨" },
  { key: "auto", label: "코디네이터 처리 중", hint: "검토자가 대신 판단 중" },
  { key: "running", label: "작업 중", hint: "워커 실행 중" },
  { key: "waiting", label: "대기", hint: "시작 전·쉬는 중" },
];

type StateInput = Pick<PluginAgentSnapshot, "status" | "attentionReason" | "requiresAttention">;

/**
 * hasPending 은 daemon snapshot 의 pendingPermissions 가 비어 있지 않은지다 (pending-store.tsx).
 * attentionReason 만 보면 하위 에이전트의 권한 대기를 놓친다.
 */
export function agentState(agent: StateInput, hasPending = false): AgentStateKey {
  if (hasPending || agent.attentionReason === "permission") return "permission";
  if (agent.status === "error" || agent.attentionReason === "error") return "error";
  if (agent.requiresAttention && agent.attentionReason === "finished") return "finished";
  if (agent.status === "running") return "running";
  if (agent.status === "initializing") return "initializing";
  if (agent.status === "closed") return "closed";
  return "idle";
}

export function stateLabel(key: AgentStateKey): string {
  return STATES[key].label;
}

export function columnOf(key: AgentStateKey): ColumnKey {
  return STATES[key].column;
}

export function columnRank(key: ColumnKey): number {
  return COLUMNS.findIndex((column) => column.key === key);
}

// 컬럼마다 다른 색을 쓴다. accent 가 초록인 테마가 있어서 확인 필요를 statusSuccess 로 두면
// 코디네이터 처리 중과 구분되지 않았다 (2026-11-25 스크린샷). 내 결정 필요는 병목이라 가장 강한 색을 쓴다.
export function columnColor(key: ColumnKey, theme: PluginTheme): string {
  switch (key) {
    case "react":
      return theme.colors.statusDanger;
    case "review":
      return theme.colors.statusWarning;
    case "auto":
      return theme.colors.accent;
    case "running":
      return theme.colors.foreground;
    default:
      return theme.colors.foregroundMuted;
  }
}

export function stateColor(key: AgentStateKey, theme: PluginTheme): string {
  return columnColor(STATES[key].column, theme);
}

/** 검토자처럼 플러그인이 만드는 background 에이전트는 사람이 볼 대상이 아니라서 뺀다. */
export function isVisibleAgent(agent: Pick<PluginAgentSnapshot, "background">): boolean {
  return !agent.background;
}
