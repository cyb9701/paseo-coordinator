import { useRpc, useSubscription } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type CoordinatorState, type WorkspaceStatus, openDecisions, watchStateSubscription, workspaceStatusRpc } from "../shared/model";
import type { PendingDirectory } from "./pending-store";
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
 */
export function useWorkspaceStatuses(hostId: string) {
  const call = useRpc(workspaceStatusRpc);
  const client = useQueryClient();
  const queryKey = ["coordinator", "workspace-status", hostId];
  const query = useQuery({ queryKey, queryFn: () => call({ force: false }), refetchInterval: 60_000, staleTime: 20_000 });
  const refresh = useCallback(async () => {
    client.setQueryData(queryKey, await call({ force: true }));
  }, [client, call, hostId]);
  return { ...query, refresh };
}

export function statusOf(statuses: readonly WorkspaceStatus[] | undefined, workspaceId: string): WorkspaceStatus | null {
  return statuses?.find((item) => item.workspaceId === workspaceId) ?? null;
}

/**
 * 사람을 기다리는 카드 수. 사이드바 배지, 인박스 탭, 인박스 머리가 같이 쓴다. 멈춘 결정은 에이전트마다 한 장, 권한 요청은 요청마다 한 장,
 * 에러는 에이전트마다 한 장이다. 멈춘 결정이 있는 에이전트의 질문 창은 그 결정 카드 안에 들어가므로 따로 세지 않는다.
 * 확인 필요(기록하고 진행한 결정)는 일이 멈춘 것이 아니라 세지 않는다. 숫자가 늘 떠 있으면 아무도 보지 않는다.
 */
export function reactionCount(state: CoordinatorState | null, reactingAgentIds: readonly string[], directory: PendingDirectory): number {
  const stopped = new Set(state ? openDecisions(state).map((item) => item.agentId) : []);
  let count = stopped.size;
  for (const agentId of reactingAgentIds) {
    const folded = stopped.has(agentId);
    const all = directory.pending.get(agentId) ?? [];
    const requests = all.filter((request) => !(folded && request.kind === "question"));
    if (requests.length > 0) count += requests.length;
    // 권한 요청이 없는데 사람을 기다리면 에러 카드(또는 요청을 읽는 중인 카드) 한 장이다. 질문만 있고 그 질문이 결정 카드에
    // 들어간 경우는 따로 세지 않는다. AgentAttention 의 folded 처리와 같은 기준이다.
    else if (all.length === 0) count += 1;
  }
  return count;
}
