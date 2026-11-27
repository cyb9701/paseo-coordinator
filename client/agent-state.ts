import type { PluginAgentSnapshot, PluginTheme } from "@getpaseo/plugin";

/**
 * 인박스, 워크스페이스 보드, 사이드바 배지가 같은 기준으로 세도록 상태를 한 곳에서 판정한다.
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
