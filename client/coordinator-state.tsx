import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import {
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
