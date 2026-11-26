import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  type CoordinatorRequest,
  type Task,
  type CoordinatorState,
  type SentInstruction,
  type RequestReport,
  recordInstructionRpc,
  requestReport,
  watchStateSubscription,
} from "../shared/model";

interface StateContextValue {
  state: CoordinatorState | null;
  /** 구독이 실패했거나 닫혔다. 화면은 마지막 상태를 보여주고 있으니 사람에게 알려야 한다. */
  disconnected: Error | "closed" | null;
  reconnect(): void;
}

const StateContext = createContext<StateContextValue>({ state: null, disconnected: null, reconnect: () => {} });

// 입력이 없는 구독이라 고정값을 넘긴다. (useSubscription 은 input 을 얕게 비교한다.)
const NO_INPUT = {};

/**
 * server 의 요청·기록 상태를 화면 하나가 구독 하나로 받는다.
 * 구독은 server 플러그인이 다시 시작되거나 이벤트가 스키마 검사에 실패하면 닫힌다. useSubscription 은 input 이 바뀔 때만
 * 다시 구독하므로, 다시 연결은 구독하는 컴포넌트를 key 로 새로 만들어서 한다.
 */
export function CoordinatorStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CoordinatorState | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [status, setStatus] = useState<StateContextValue["disconnected"]>(null);
  const reconnect = useCallback(() => {
    setStatus(null);
    setEpoch((value) => value + 1);
  }, []);
  const value = useMemo(() => ({ state, disconnected: status, reconnect }), [state, status, reconnect]);
  return (
    <StateContext.Provider value={value}>
      <Subscriber key={epoch} onState={setState} onStatus={setStatus} />
      {children}
    </StateContext.Provider>
  );
}

function Subscriber({
  onState,
  onStatus,
}: {
  onState(state: CoordinatorState): void;
  onStatus(status: StateContextValue["disconnected"]): void;
}) {
  const subscription = useSubscription(watchStateSubscription, NO_INPUT, onState);
  const status = subscription.status === "error" ? subscription.error : subscription.status === "closed" ? "closed" : null;
  useEffect(() => onStatus(status), [onStatus, status]);
  return null;
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

/** 내 결정 필요: 코디네이터가 질문 카드를 보내고 내 답을 기다린다. */
export function requestNeedsReaction(request: CoordinatorRequest): boolean {
  // 워커가 이미 일하는 요청은 진행 중인 채로 질문을 받는다 (server ask_human).
  return request.question !== null && (request.status === "needs_input" || request.status === "running");
}

function isOpen(request: CoordinatorRequest): boolean {
  return request.status !== "done" && request.status !== "canceled";
}

/**
 * 확인 필요: 읽기 요청에 코디네이터가 답했다(답변 카드). 읽기 요청에서는 이 카드가 완료 보고서다.
 * 시작 카드는 없앴다 (2026-11-27 사용자 결정). 코디네이터가 시작 전에 물을 것을 묻고 정리되면 바로 일하므로, 시작했다는 확인을
 * 받는 것도 병목이었다. 계획은 진행 현황과 완료 보고서에서 본다.
 */
export function requestNeedsReview(request: CoordinatorRequest): boolean {
  return request.status === "answered" && request.answer !== null;
}

/** 내 결정 필요: 워커가 보고했고 코디네이터가 결정 카드를 다 쓴 것. 오래 기다린 순서. */
export function blockerCards(requests: readonly CoordinatorRequest[]): { request: CoordinatorRequest; task: Task }[] {
  return requests
    .filter(isOpen)
    .flatMap((request) => request.tasks.filter((task) => task.blocker?.coordinator).map((task) => ({ request, task })))
    .sort((a, b) => a.task.blocker!.at.localeCompare(b.task.blocker!.at));
}

/**
 * 완료 보고서 (2026-11-27 사용자 결정). 작업마다 머지·확인 카드를 띄우지 않고, 요청에서 더 진행할 일이 없을 때 요청마다 하나로
 * 보인다. PR 머지나 남은 변경이 있으면 내 결정 필요, 없으면 확인 필요다. 가장 늦게 끝난 작업이 위에 온다.
 */
export function reportCards(requests: readonly CoordinatorRequest[]): { request: CoordinatorRequest; report: RequestReport }[] {
  const lastAt = (report: RequestReport) => report.completions.map((task) => task.completion!.at).sort().at(-1) ?? "";
  return requests
    .flatMap((request) => {
      const report = requestReport(request);
      return report ? [{ request, report }] : [];
    })
    .sort((a, b) => lastAt(b.report).localeCompare(lastAt(a.report)));
}

/** 내 결정 필요: 코디네이터가 멈춰 요청을 이어 가지 못한다. 다시 시도는 사람만 할 수 있다. */
export function stalledRequests(requests: readonly CoordinatorRequest[]): CoordinatorRequest[] {
  return requests.filter((request) => isOpen(request) && request.stall);
}

/** 내 결정 필요에 들어가는 요청 카드 수. 사이드바, 탭, 인박스가 같은 수를 보여야 한다. */
export function requestReactionCount(requests: readonly CoordinatorRequest[]): number {
  return (
    requests.filter(requestNeedsReaction).length +
    blockerCards(requests).length +
    reportCards(requests).filter(({ report }) => report.needsDecision).length +
    stoppedCards(requests).length +
    stalledRequests(requests).length
  );
}

/**
 * 내 결정 필요: 워커 질문 카드 없이 막힌 작업. 워커 시작 실패, 턴 에러, report_done 없이 두 번 끝남이다.
 * 보드는 이 작업을 '내 결정 필요'에 두므로 인박스에도 카드가 있어야 수가 맞고, 다시 시작할 길이 생긴다.
 */
export function stoppedCards(requests: readonly CoordinatorRequest[]): { request: CoordinatorRequest; task: Task }[] {
  return requests
    .filter((request) => request.status === "running")
    .flatMap((request) => request.tasks.filter((task) => task.status === "blocked" && !task.blocker).map((task) => ({ request, task })));
}
