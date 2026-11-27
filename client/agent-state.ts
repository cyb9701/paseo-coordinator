import type { PluginAgentSnapshot, PluginTheme } from "@getpaseo/plugin";

/**
 * 인박스, 진행 현황 표, 사이드바 배지가 같은 기준으로 세도록 상태를 한 곳에서 판정한다.
 * 순서가 중요하다. 권한을 기다리는 에이전트는 status 가 아직 "running" 이라서 권한 대기를 먼저 봐야 한다.
 */
export type AgentStateKey = "permission" | "error" | "finished" | "running" | "initializing" | "idle" | "closed";

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

/** 사람을 기다리는 상태. 인박스 '내 결정 필요'에 카드로 오르고 배지에 센다. */
export function needsPerson(key: AgentStateKey): boolean {
  return key === "permission" || key === "error";
}

export function stateColor(key: AgentStateKey, theme: PluginTheme): string {
  switch (key) {
    case "permission":
    case "error":
      return theme.colors.statusDanger;
    case "finished":
      return theme.colors.statusWarning;
    case "running":
    case "initializing":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/** 사람이 볼 에이전트. 요약 에이전트처럼 플러그인이 띄우는 helper 는 background 라 빠진다. */
export function isVisibleAgent(agent: Pick<PluginAgentSnapshot, "background">): boolean {
  return !agent.background;
}

/**
 * 진행 현황 표의 열. 왼쪽일수록 사람을 더 기다린다.
 * - react: 일이 멈춰 나를 기다린다(권한 요청, 질문, 에러, 답을 기다리는 결정)
 * - review: 끝났거나 스스로 정하고 진행한 결정이 있어 나중에 봐도 된다
 * - running: 일하는 중이다
 * - waiting: 시작 전이거나 쉬는 중이다
 */
export type ColumnKey = "react" | "review" | "running" | "waiting";
export const COLUMN_KEYS: readonly ColumnKey[] = ["react", "review", "running", "waiting"];

/** 결정 기록도 열을 정한다. 답을 기다리는 결정이 있는 에이전트는 턴을 끝내 쉬고 있어도 나를 기다리는 중이다. */
export function columnFor(state: AgentStateKey, decisions: { waiting: boolean; unreviewed: boolean }): ColumnKey {
  if (needsPerson(state) || decisions.waiting) return "react";
  if (state === "finished" || decisions.unreviewed) return "review";
  if (state === "running" || state === "initializing") return "running";
  return "waiting";
}

export function columnColor(key: ColumnKey, theme: PluginTheme): string {
  switch (key) {
    case "react":
      return theme.colors.statusDanger;
    case "review":
      return theme.colors.statusWarning;
    case "running":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}
