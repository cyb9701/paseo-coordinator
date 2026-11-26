import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  type CoordinatorRequest,
  type Task,
  type CoordinatorState,
  type SentInstruction,
  recordInstructionRpc,
  watchStateSubscription,
} from "../shared/model";

interface StateContextValue {
  state: CoordinatorState | null;
  error: Error | null;
}

const StateContext = createContext<StateContextValue>({ state: null, error: null });

// 입력이 없는 구독이라 고정값을 넘긴다. (useSubscription 은 input 을 얕게 비교한다.)
const NO_INPUT = {};

/** server 의 요청·기록 상태를 화면 하나가 구독 하나로 받는다. */
export function CoordinatorStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CoordinatorState | null>(null);
  const subscription = useSubscription(watchStateSubscription, NO_INPUT, setState);
  const value = useMemo(
    () => ({ state, error: subscription.status === "error" ? subscription.error : null }),
    [state, subscription],
  );
  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

export function useCoordinatorState(): StateContextValue {
  return useContext(StateContext);
}

interface SentLog {
  sent: ReadonlyMap<string, readonly SentInstruction[]>;
  record(agentId: string, text: string): Promise<void>;
}

/**
 * 사람이 카드에서 보낸 지시. server 에 저장해서 화면을 닫거나 테마를 바꿔도 남는다.
 * (2단계에서는 화면 state 에 두었다가 화면이 다시 그려지면 사라졌다.)
 */
export function useSentLog(): SentLog {
  const { state } = useCoordinatorState();
  const recordRpc = useRpc(recordInstructionRpc);
  const sent = useMemo(() => {
    const byAgent = new Map<string, SentInstruction[]>();
    for (const item of state?.sent ?? []) {
      byAgent.set(item.agentId, [...(byAgent.get(item.agentId) ?? []), item]);
    }
    return byAgent;
  }, [state?.sent]);
  const record = useCallback(
    async (agentId: string, text: string) => {
      await recordRpc({ agentId, text });
    },
    [recordRpc],
  );
  return { sent, record };
}

/** 반응 필요: 코디네이터가 질문 카드를 보내고 내 답을 기다린다. */
export function requestNeedsReaction(request: CoordinatorRequest): boolean {
  return request.status === "needs_input" && request.question !== null;
}

/**
 * 확인 필요: 코디네이터가 답했거나(답변 카드), 계획해서 시작한 뒤 내가 아직 보지 않았다(시작 카드).
 * 확인한 뒤 새 계획이 오면 다시 확인 필요가 된다.
 */
export function requestNeedsReview(request: CoordinatorRequest): boolean {
  if (request.status === "answered") return request.answer !== null;
  if (request.status !== "running" || !request.plannedAt) return false;
  return !request.reviewedAt || request.reviewedAt < request.plannedAt;
}

/** 반응 필요: 워커가 보고했고 코디네이터가 결정 카드를 다 쓴 것. 오래 기다린 순서. */
export function blockerCards(requests: readonly CoordinatorRequest[]): { request: CoordinatorRequest; task: Task }[] {
  return requests
    .filter((request) => request.status === "running")
    .flatMap((request) => request.tasks.filter((task) => task.blocker?.coordinator).map((task) => ({ request, task })))
    .sort((a, b) => a.task.blocker!.at.localeCompare(b.task.blocker!.at));
}

/** 확인 필요: 검토를 통과해 자동으로 처리했고 아직 사람이 보지 않은 결정. 최근 순서. */
export function autoDecisionCards(requests: readonly CoordinatorRequest[]) {
  return requests
    .flatMap((request) =>
      request.tasks.flatMap((task) =>
        task.autoDecisions.filter((decision) => !decision.reviewedAt).map((decision) => ({ request, task, decision })),
      ),
    )
    .sort((a, b) => b.decision.at.localeCompare(a.decision.at));
}

/**
 * 반응 필요: 워커가 완료를 보고했고 머지(또는 변경 없음 확인)를 기다리는 작업 (7단계). 오래 기다린 순서.
 * 모든 등급에서 PR 머지는 사람이 한다 (RULES.md H2). A·B 의 완료 판정도 이 카드에서 함께 한다.
 */
export function completionCards(requests: readonly CoordinatorRequest[]): { request: CoordinatorRequest; task: Task }[] {
  return requests
    .filter((request) => request.status === "running")
    .flatMap((request) =>
      request.tasks
        .filter((task) => task.status === "review" && task.completion && !task.completion.closedAt && !task.blocker)
        .map((task) => ({ request, task })),
    )
    .sort((a, b) => a.task.completion!.at.localeCompare(b.task.completion!.at));
}

/** 반응 필요에 들어가는 요청 카드 수 (질문, 워커 질문, PR 머지). 사이드바, 탭, 인박스가 같은 수를 보여야 한다. */
export function requestReactionCount(requests: readonly CoordinatorRequest[]): number {
  return requests.filter(requestNeedsReaction).length + blockerCards(requests).length + completionCards(requests).length;
}
