import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type CoordinatorState, type WorkspaceStatus, watchStateSubscription, workspaceStatusRpc } from "../shared/model";
import { useT } from "./i18n";

interface StateContextValue {
  state: CoordinatorState | null;
  /** 구독이 실패했거나 닫혔다. 화면은 마지막 상태를 보여 주고 있으니 사람에게 알려야 한다. */
  disconnected: Error | "closed" | null;
  reconnect(): void;
}

const StateContext = createContext<StateContextValue>({ state: null, disconnected: null, reconnect: () => {} });

/**
 * server 의 결정·후속 작업 상태를 화면 하나가 구독 하나로 받는다. 구독은 server 플러그인이 다시 시작되면 닫힌다.
 * useSubscription 은 input 이 바뀔 때만 다시 구독하므로, 다시 연결은 구독 컴포넌트를 key 로 새로 만들어서 한다.
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

function Subscriber({ onState, onStatus }: { onState(state: CoordinatorState): void; onStatus(status: StateContextValue["disconnected"]): void }) {
  const { language } = useT();
  // 요약을 앱 언어로 쓰도록 server 에 앱 언어를 알린다.
  const input = useMemo(() => ({ language }), [language]);
  const subscription = useSubscription(watchStateSubscription, input, onState);
  const status = subscription.status === "error" ? subscription.error : subscription.status === "closed" ? "closed" : null;
  useEffect(() => onStatus(status), [onStatus, status]);
  return null;
}

export function useCoordinatorState(): StateContextValue {
  return useContext(StateContext);
}

/**
 * 워크스페이스의 바뀐 파일, PR, 겹침. git 을 돌리므로 1분마다만 다시 읽는다. refresh 는 사람이 누른 새로 읽기다. 서버 캐시를
 * 건너뛰지 않으면 20초 안에 누른 새로 읽기가 같은 값을 받는다.
 * 새로 읽기는 같은 query 로 가져온다. 결과를 따로 받아 덮어쓰면, 그 사이 돌던 정기 조회가 늦게 끝나 서버 캐시 값으로 다시 덮고,
 * 실패도 query 의 error 에 남지 않아 화면에 보이지 않는다. 돌던 정기 조회는 먼저 취소한다.
 */
export function useWorkspaceStatuses(hostId: string) {
  const call = useRpc(workspaceStatusRpc);
  const client = useQueryClient();
  const queryKey = useMemo(() => ["coordinator", "workspace-status", hostId], [hostId]);
  const query = useQuery({ queryKey, queryFn: () => call({ force: false }), refetchInterval: 60_000, staleTime: 20_000 });
  const refresh = useCallback(async () => {
    await client.cancelQueries({ queryKey });
    await client.fetchQuery({ queryKey, queryFn: () => call({ force: true }), staleTime: 0 });
  }, [client, call, queryKey]);
  return { ...query, refresh };
}

export function statusOf(statuses: readonly WorkspaceStatus[] | undefined, workspaceId: string): WorkspaceStatus | null {
  return statuses?.find((item) => item.workspaceId === workspaceId) ?? null;
}
