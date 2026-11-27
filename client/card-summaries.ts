import { type Ask, type CoordinatorState, type Decision, type Summary, latestSummary } from "../shared/model";

/**
 * 멈춘 결정 카드에 보일 요약. 그 에이전트의 마지막 요약이 이 결정들을 다루거나 이 결정들보다 늦게 만들어졌을 때만 쓴다. 앞선 결정을
 * 다룬 예전 요약을 보이면 지금 정할 것과 다른 이야기를 읽게 된다.
 */
export function summaryForStopped(state: CoordinatorState | null, agentId: string, decisions: readonly Decision[]): Summary | null {
  const first = decisions[0];
  const summary = state && first ? latestSummary(state, agentId) : null;
  if (!summary || !first) return null;
  return summary.at >= first.at || decisions.some((item) => summary.decisionIds.includes(item.id)) ? summary : null;
}

/** 이 카드의 결정이 멈춘 뒤 사람이 '먼저 묻기'로 물은 것. 그 전의 질문은 앞선 결정에 대한 것이다. */
export function asksForStopped(state: CoordinatorState | null, agentId: string, decisions: readonly Decision[]): Ask[] {
  const first = decisions[0];
  if (!state || !first) return [];
  return state.asks.filter((item) => item.agentId === agentId && item.at >= first.at);
}

/** 에러 카드의 요약. 요약은 에러가 난 뒤에 만들어지므로, 에러 시각보다 조금(1분) 이른 것까지만 이 에러의 설명으로 본다. */
export function summaryForError(state: CoordinatorState | null, agentId: string, since: string): Summary | null {
  const summary = state ? latestSummary(state, agentId) : null;
  return summary && Date.parse(summary.at) >= Date.parse(since) - 60_000 ? summary : null;
}
