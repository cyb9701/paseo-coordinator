import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { usePaseo } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
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

function sameFacts(before: AgentFacts | undefined, after: AgentFacts): boolean {
  if (!before) return after.pending.length === 0 && !after.lastError;
  return (
    before.lastError === after.lastError &&
    before.pending.length === after.pending.length &&
    before.pending.every((request, index) => request.id === after.pending[index]?.id)
  );
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
          // 에이전트 갱신은 일하는 동안 계속 온다. 권한 대기나 에러가 실제로 바뀐 때만 다시 그린다. 그러지 않으면 화면 전체가
          // 다른 에이전트의 활동마다 다시 그려진다.
          update: (message) => {
            if (message.type !== "agent_update") return;
            const update = message.payload;
            if (update.kind === "upsert") {
              const next = factsOf(update.agent);
              if (sameFacts(facts.get(update.agent.id), next)) return;
              facts.set(update.agent.id, next);
            } else if (!facts.delete(update.agentId)) return;
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

/** 화면 하나가 구독 하나를 같이 쓰도록 내려 준다. */
export function PendingProvider({ children }: { children: ReactNode }) {
  const directory = usePendingDirectory();
  return <PendingContext.Provider value={directory}>{children}</PendingContext.Provider>;
}

export function usePending(): PendingDirectory {
  return useContext(PendingContext);
}

type StateFields = Pick<PluginAgentSnapshot, "id" | "status" | "attentionReason" | "requiresAttention">;

export interface Classifier {
  state(agent: StateFields): AgentStateKey;
  /** 권한 요청이나 에러로 멈춰 사람을 기다린다. */
  needsMyDecision(agent: PluginAgentSnapshot): boolean;
}

export function classifierFor(directory: PendingDirectory): Classifier {
  const state = (agent: StateFields) => agentState(agent, directory.pending.has(agent.id));
  return { state, needsMyDecision: (agent) => isVisibleAgent(agent) && needsPerson(state(agent)) };
}

export function useClassifier(): Classifier {
  const directory = usePending();
  return useMemo(() => classifierFor(directory), [directory]);
}

/**
 * 권한·에러 카드 수. 인박스는 대기 중인 권한 요청 하나당 카드 한 장을 그리므로, 에이전트 수가 아니라 요청 수로 센다.
 * 요청이 없는데 멈춘 에이전트(에러)는 한 장이다.
 */
export function cardCount(agentIds: readonly string[], directory: PendingDirectory): number {
  return agentIds.reduce((total, id) => total + Math.max(1, directory.pending.get(id)?.length ?? 0), 0);
}
