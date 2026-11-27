import type { PaseoApi } from "./paseo-api";
import type { StateStore } from "./store";

export type Delivery = "sent" | "queued";

/** 받을 에이전트가 없다. 사람에게 알려야 한다. "대기 중"으로 보이고 사라지면 지시가 간 줄 안다. */
export class AgentGoneError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} is gone (archived or deleted). Nothing was sent.`);
  }
}

type Snapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>;

function busy(snapshot: Snapshot): boolean {
  const agent = snapshot.agent;
  return agent.status === "running" || agent.status === "initializing" || (agent.pendingPermissions?.length ?? 0) > 0;
}

/**
 * 에이전트에게 사람의 답과 지시를 보내는 길. 일하는 중이거나 권한을 기다리는 에이전트에게 보내면 진행 중인 턴이 끊기고 대기 중인
 * 권한 요청이 거절된다. 그래서 항상 outbox 에 넣고, 에이전트가 쉴 때만 한 번에 내보낸다. 턴이 끝날 때 다시 내보낸다.
 * 쉬는지 확인한 뒤 보내기까지 짧은 틈이 있다. 그 사이에 사람이 직접 보내 턴이 시작되면 그 턴에 합쳐진다. Paseo 에는 이를 막을
 * 조건부 전송이 없다.
 */
export class Outbox {
  private readonly flushing = new Map<string, Promise<boolean>>();

  constructor(private readonly store: StateStore) {}

  /** 받을 에이전트가 있는지 상태를 바꾸기 전에 확인한다. 없으면 AgentGoneError. */
  async ensureReachable(paseo: PaseoApi, agentId: string): Promise<void> {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot || snapshot.agent.archivedAt) throw new AgentGoneError(agentId);
  }

  async deliver(paseo: PaseoApi, agentId: string, text: string): Promise<Delivery> {
    const at = new Date().toISOString();
    await this.store.update((state) => ({
      state: { ...state, outbox: { ...state.outbox, [agentId]: [...(state.outbox[agentId] ?? []), { text, at }] } },
      result: undefined,
    }));
    // 이미 내보내는 중이면 그 전송이 이 메시지를 가져갔을 수 있다. 끝난 뒤 남은 것이 있는지 다시 본다.
    const running = this.flushing.get(agentId);
    if (running) await running.catch(() => false);
    if (!(await this.store.read()).outbox[agentId]?.length) return "sent";
    return (await this.flush(paseo, agentId)) ? "sent" : "queued";
  }

  /** 쌓인 메시지를 에이전트가 쉬고 있으면 보낸다. 보냈으면 true. 받을 에이전트가 없으면 버리고 AgentGoneError. */
  flush(paseo: PaseoApi, agentId: string): Promise<boolean> {
    const running = this.flushing.get(agentId);
    if (running) return running;
    const job = this.flushOnce(paseo, agentId).finally(() => this.flushing.delete(agentId));
    this.flushing.set(agentId, job);
    return job;
  }

  private async flushOnce(paseo: PaseoApi, agentId: string): Promise<boolean> {
    if (!(await this.store.read()).outbox[agentId]?.length) return false;
    // refresh 는 에이전트가 없으면 null 을 준다. 예외는 일시 오류라 다음에 다시 시도한다.
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot || snapshot.agent.archivedAt) {
      await this.drop(agentId);
      throw new AgentGoneError(agentId);
    }
    if (busy(snapshot)) return false;
    const taken = await this.store.update((state) => {
      const messages = state.outbox[agentId] ?? [];
      if (!messages.length) return { state, result: [] };
      const { [agentId]: _sent, ...rest } = state.outbox;
      return { state: { ...state, outbox: rest }, result: messages };
    });
    if (!taken.length) return false;
    try {
      await paseo.agents.ref(agentId).send(taken.map((item) => item.text).join("\n\n---\n\n"));
      return true;
    } catch (error) {
      await this.store.update((state) => ({
        state: { ...state, outbox: { ...state.outbox, [agentId]: [...taken, ...(state.outbox[agentId] ?? [])] } },
        result: undefined,
      }));
      throw error;
    }
  }

  private async drop(agentId: string): Promise<void> {
    await this.store.update((state) => {
      if (!state.outbox[agentId]) return { state, result: undefined };
      const { [agentId]: _gone, ...rest } = state.outbox;
      return { state: { ...state, outbox: rest }, result: undefined };
    });
  }

  /** hook 이 유실돼도 쌓인 메시지가 영영 남지 않게 주기적으로 부른다. */
  async flushAll(paseo: PaseoApi): Promise<void> {
    for (const agentId of Object.keys((await this.store.read()).outbox)) {
      await this.flush(paseo, agentId).catch((error) => {
        if (!(error instanceof AgentGoneError)) console.error(`[coordinator] flush ${agentId} failed`, error);
      });
    }
  }
}
