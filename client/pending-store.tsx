import { usePaseo } from "@getpaseo/plugin/client";
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { type AgentFacts, type Classifier, EMPTY_DIRECTORY, type PendingDirectory, classifierFor, factsOf, sameFacts, toDirectory } from "./attention";

/** 목록 구독이 실패하거나 끊겼을 때 다시 붙기까지 기다리는 시간. */
const RETRY_MS = 10_000;

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function usePendingDirectory(): PendingDirectory {
  const paseo = usePaseo();
  const [directory, setDirectory] = useState<PendingDirectory>(EMPTY_DIRECTORY);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const lifetime = new AbortController();
    const facts = new Map<string, AgentFacts>();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const publish = () => setDirectory(toDirectory(facts));
    // 실패하면 마지막으로 받은 요청은 그대로 보이되 실패를 알리고, 잠시 뒤 구독을 새로 만든다.
    const fail = (error: unknown) => {
      if (lifetime.signal.aborted) return;
      console.error("[coordinator] agent list subscription failed", error);
      setDirectory((current) => ({ ...current, failure: describe(error) }));
      retry ??= setTimeout(() => setAttempt((value) => value + 1), RETRY_MS);
    };
    void paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        subscription.subscribe({
          snapshot: ({ entries }) => {
            facts.clear();
            for (const { agent } of entries) facts.set(agent.id, factsOf(agent));
            publish();
          },
          // 권한 대기나 에러가 실제로 바뀐 때만 다시 그린다. 그러지 않으면 화면 전체가 다른 에이전트의 활동마다 다시 그려진다.
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
          error: fail,
        });
      })
      .catch(fail);
    return () => {
      lifetime.abort();
      clearTimeout(retry);
    };
  }, [paseo, attempt]);
  return directory;
}

const PendingContext = createContext<PendingDirectory>(EMPTY_DIRECTORY);

/** 화면 하나가 구독 하나를 같이 쓰도록 내려 준다. */
export function PendingProvider({ children }: { children: ReactNode }) {
  const directory = usePendingDirectory();
  return <PendingContext.Provider value={directory}>{children}</PendingContext.Provider>;
}

export function usePending(): PendingDirectory {
  return useContext(PendingContext);
}

export function useClassifier(): Classifier {
  const directory = usePending();
  return useMemo(() => classifierFor(directory), [directory]);
}
