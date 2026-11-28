import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { type CoordinatorState, type Decision, type Judgment, type Report, openDecisions, openReports, unreviewedDecisions, visibleJudgments } from "../shared/model";
import { type AgentStateKey, agentState, isVisibleAgent, needsPerson } from "./agent-state";
import type { PermissionRequest } from "./permissions";

/**
 * 에이전트마다 대기 중인 권한 요청과 마지막 에러.
 *
 * 플러그인 snapshot(useAgents)에는 pendingPermissions 가 없고, 하위 에이전트는 권한 요청이 대기 중이어도 requiresAttention=false,
 * attentionReason=null 로 온다. 그래서 '멈춤' 판정은 daemon 의 전체 snapshot 에서 pendingPermissions 가 있는지로 직접 한다.
 */
export interface PendingDirectory {
  readonly ready: boolean;
  readonly pending: ReadonlyMap<string, readonly PermissionRequest[]>;
  readonly errors: ReadonlyMap<string, string>;
  /** 목록 구독이 실패했다. 다시 붙을 때까지 권한 요청을 보지 못하므로 화면이 알린다. */
  readonly failure: string | null;
}

export interface AgentFacts {
  pending: readonly PermissionRequest[];
  lastError: string | null;
}

export const EMPTY_DIRECTORY: PendingDirectory = { ready: false, pending: new Map(), errors: new Map(), failure: null };

export function factsOf(agent: { pendingPermissions?: unknown; lastError?: string | null }): AgentFacts {
  return {
    pending: (Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : []) as PermissionRequest[],
    lastError: agent.lastError ?? null,
  };
}

/** 에이전트 갱신은 일하는 동안 계속 온다. 권한 대기나 에러가 실제로 바뀐 때만 다시 그리도록 비교한다. */
export function sameFacts(before: AgentFacts | undefined, after: AgentFacts): boolean {
  if (!before) return after.pending.length === 0 && !after.lastError;
  return (
    before.lastError === after.lastError &&
    before.pending.length === after.pending.length &&
    before.pending.every((request, index) => request.id === after.pending[index]?.id)
  );
}

export function toDirectory(facts: ReadonlyMap<string, AgentFacts>): PendingDirectory {
  const pending = new Map<string, readonly PermissionRequest[]>();
  const errors = new Map<string, string>();
  for (const [id, fact] of facts) {
    if (fact.pending.length > 0) pending.set(id, fact.pending);
    if (fact.lastError) errors.set(id, fact.lastError);
  }
  return { ready: true, pending, errors, failure: null };
}

type StateFields = Pick<PluginAgentSnapshot, "id" | "status" | "attentionReason" | "requiresAttention">;

export interface Classifier {
  state(agent: StateFields): AgentStateKey;
  /** 권한 요청이나 에러로 멈춰 사람을 기다린다. */
  needsMyDecision(agent: Pick<PluginAgentSnapshot, "background"> & StateFields): boolean;
}

export function classifierFor(directory: PendingDirectory): Classifier {
  const state = (agent: StateFields) => agentState(agent, directory.pending.has(agent.id));
  return { state, needsMyDecision: (agent) => isVisibleAgent(agent) && needsPerson(state(agent)) };
}

/**
 * 한 에이전트에 대해 인박스가 그릴 권한 카드. 멈춘 결정이 있는 에이전트(folded)의 질문 창은 그 결정 카드 안에 들어가므로 뺀다.
 * hidden 이면 그 에이전트는 권한·에러 카드를 그리지 않는다(질문만 있었고 결정 카드로 들어갔다).
 * 배지 숫자와 인박스 카드가 같은 기준을 쓰도록 둘 다 이 함수로 정한다.
 */
export function attentionCards(directory: PendingDirectory, agentId: string, folded: boolean): { requests: readonly PermissionRequest[]; hidden: boolean } {
  const all = directory.pending.get(agentId) ?? [];
  const requests = folded ? all.filter((request) => request.kind !== "question") : all;
  return { requests, hidden: requests.length === 0 && all.length > 0 };
}

/**
 * 사람을 기다리는 카드 수. 사이드바 배지, 인박스 탭, 인박스 머리가 같이 쓴다. 멈춘 결정은 에이전트마다 한 장, 권한 요청은 요청마다 한 장,
 * 에러는 에이전트마다 한 장이다. 멈춘 결정이 있는 에이전트의 질문 창은 그 결정 카드 안에 들어가므로 따로 세지 않는다.
 * 코디네이터가 '사람이 답할 일'로 판정한 세션도 한 장이다. 그 에이전트는 사람의 답을 기다리며 쉬고 있다. 다른 카드가 이미 있는 에이전트는
 * 판정하지 않지만, 판정 뒤에 생긴 카드와 겹치면 한 번만 센다.
 * 확인 필요(기록하고 진행한 결정, 확인할 결과, 보고)는 일이 멈춘 것이 아니라 세지 않는다. 숫자가 늘 떠 있으면 아무도 보지 않는다.
 */
export function reactionCount(state: CoordinatorState | null, reactingAgentIds: readonly string[], directory: PendingDirectory): number {
  const stopped = new Set(state ? openDecisions(state).map((item) => item.agentId) : []);
  let count = stopped.size;
  for (const agentId of reactingAgentIds) {
    const { requests, hidden } = attentionCards(directory, agentId, stopped.has(agentId));
    // 권한 요청이 없는데 사람을 기다리면 에러 카드(또는 요청을 읽는 중인 카드) 한 장이다.
    if (requests.length > 0) count += requests.length;
    else if (!hidden) count += 1;
  }
  const reacting = new Set(reactingAgentIds);
  if (state) count += questionJudgments(state, reacting).length;
  return count;
}

/** 인박스에 그릴 질문 판정. 멈춘 결정·권한·에러 카드가 있는 에이전트는 그 카드로 답하므로 뺀다. */
export function questionJudgments(state: CoordinatorState, reacting: ReadonlySet<string>): Judgment[] {
  const stopped = new Set(openDecisions(state).map((item) => item.agentId));
  return visibleJudgments(state, "question").filter((item) => !stopped.has(item.agentId) && !reacting.has(item.agentId));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.entries()];
}

const oldestFirst = (a: [string, readonly { at: string }[]], b: [string, readonly { at: string }[]]) => a[1][0]!.at.localeCompare(b[1][0]!.at);

/**
 * 인박스의 두 묶음. 멈춘 결정은 에이전트마다 카드 한 장(답이 한 메시지로 가기 때문), 확인할 결정은 워크스페이스마다 한 장이다.
 * 오래 기다린 것이 위로 온다.
 */
export function inboxGroups(state: CoordinatorState | null) {
  if (!state) return { stopped: [] as [string, Decision[]][], review: [] as [string, Decision[]][], checks: [] as Judgment[], reports: [] as Report[] };
  return {
    stopped: groupBy(openDecisions(state), (item) => item.agentId).sort(oldestFirst),
    review: groupBy(unreviewedDecisions(state), (item) => item.workspaceId).sort(oldestFirst),
    checks: visibleJudgments(state, "review"),
    reports: openReports(state),
  };
}
