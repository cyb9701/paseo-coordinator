import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { type AgentStateKey, type ColumnKey, agentState, columnOf, isVisibleAgent } from "./agent-state";
import type { PermissionRequest } from "./permissions";

/**
 * 에이전트마다 대기 중인 권한 요청과 마지막 에러.
 *
 * 플러그인 snapshot(useAgents)에는 pendingPermissions 가 없고, attentionReason 은 믿을 수 없다.
 * 2026-11-25 실행 확인: 하위 에이전트(paseo.parent-agent-id 라벨)는 권한 요청이 대기 중이어도
 * requiresAttention=false, attentionReason=null 이었다. 그래서 '멈춤' 판정은 daemon 의 전체 snapshot 에서
 * pendingPermissions 가 있는지로 직접 한다. agents.list 구독은 처음에 전체 목록을, 이후 변경을 보낸다.
 */
export interface PendingDirectory {
  readonly ready: boolean;
  readonly pending: ReadonlyMap<string, readonly PermissionRequest[]>;
  readonly errors: ReadonlyMap<string, string>;
}

interface AgentFacts {
  pending: readonly PermissionRequest[];
  lastError: string | null;
}

const EMPTY: PendingDirectory = { ready: false, pending: new Map(), errors: new Map() };

function factsOf(agent: { pendingPermissions?: unknown; lastError?: string | null }): AgentFacts {
  return {
    pending: (Array.isArray(agent.pendingPermissions) ? agent.pendingPermissions : []) as PermissionRequest[],
    lastError: agent.lastError ?? null,
  };
}

function toDirectory(facts: ReadonlyMap<string, AgentFacts>): PendingDirectory {
  const pending = new Map<string, readonly PermissionRequest[]>();
  const errors = new Map<string, string>();
  for (const [id, fact] of facts) {
    if (fact.pending.length > 0) pending.set(id, fact.pending);
    if (fact.lastError) errors.set(id, fact.lastError);
  }
  return { ready: true, pending, errors };
}

export function usePendingDirectory(): PendingDirectory {
  const paseo = usePaseo();
  const [directory, setDirectory] = useState<PendingDirectory>(EMPTY);
  useEffect(() => {
    const lifetime = new AbortController();
    const facts = new Map<string, AgentFacts>();
    const publish = () => setDirectory(toDirectory(facts));
    void paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            facts.clear();
            for (const { agent } of entries) facts.set(agent.id, factsOf(agent));
            publish();
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") facts.set(update.agent.id, factsOf(update.agent));
            else facts.delete(update.agentId);
            publish();
          },
        });
        return undefined;
      })
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error("[coordinator] agent list subscription failed", error);
      });
    return () => lifetime.abort();
  }, [paseo]);
  return directory;
}

const PendingContext = createContext<PendingDirectory>(EMPTY);

export interface SentInstruction {
  text: string;
  at: string;
}

interface SentLog {
  sent: ReadonlyMap<string, readonly SentInstruction[]>;
  record(agentId: string, text: string): void;
}

const SentContext = createContext<SentLog>({ sent: new Map(), record: () => {} });

/**
 * 화면 하나가 구독 하나를 같이 쓰도록 내려 준다.
 * 사람이 카드에서 보낸 지시도 여기에 남긴다. 에이전트가 실행되는 동안 카드가 사라졌다가 다시 나타나므로
 * 카드 안 state 에 두면 기록이 사라지고, 사람은 지시가 갔는지 몰라 같은 지시를 다시 보내게 된다 (2026-11-25 테스트).
 */
export function PendingProvider({ children }: { children: ReactNode }) {
  const directory = usePendingDirectory();
  const [sent, setSent] = useState<ReadonlyMap<string, readonly SentInstruction[]>>(new Map());
  const record = useCallback((agentId: string, text: string) => {
    setSent((current) => {
      const next = new Map(current);
      next.set(agentId, [...(current.get(agentId) ?? []), { text, at: new Date().toISOString() }]);
      return next;
    });
  }, []);
  const log = useMemo(() => ({ sent, record }), [sent, record]);
  return (
    <PendingContext.Provider value={directory}>
      <SentContext.Provider value={log}>{children}</SentContext.Provider>
    </PendingContext.Provider>
  );
}

export function useSentLog(): SentLog {
  return useContext(SentContext);
}

export function usePending(): PendingDirectory {
  return useContext(PendingContext);
}

export interface Classifier {
  state(agent: PluginAgentSnapshot | StateFields): AgentStateKey;
  column(agent: PluginAgentSnapshot | StateFields): ColumnKey;
  /** 칸반 카드로 올릴 에이전트. 하위 세션은 부모 카드 안에 접되, 반응이 필요하면 따로 꺼낸다. */
  isCard(agent: PluginAgentSnapshot): boolean;
}

type StateFields = Pick<PluginAgentSnapshot, "id" | "status" | "attentionReason" | "requiresAttention">;

export function classifierFor(directory: PendingDirectory): Classifier {
  const state = (agent: StateFields) => agentState(agent, directory.pending.has(agent.id));
  const column = (agent: StateFields) => columnOf(state(agent));
  return {
    state,
    column,
    isCard: (agent) => isVisibleAgent(agent) && (agent.parentAgentId === null || column(agent) === "react"),
  };
}

export function useClassifier(): Classifier {
  const directory = usePending();
  return useMemo(() => classifierFor(directory), [directory]);
}
