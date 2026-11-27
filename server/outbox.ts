import { CoordinatorError } from "../shared/errors";
import { MESSAGE_SEPARATOR } from "../shared/messages";
import type { PaseoApi } from "./paseo-api";
import type { StateStore } from "./store";

export type Delivery = "sent" | "queued";

/** 받을 에이전트가 없다. 사람에게 알려야 한다. "대기 중"으로 보이고 사라지면 지시가 간 줄 안다. */
export class AgentGoneError extends CoordinatorError {
  constructor(agentId: string) {
    super("agentGone", `Agent ${agentId} is gone (archived or deleted). Nothing was sent.`);
  }
}

/** 턴 끝에 아직 바빠 보일 때 다시 볼 간격. 합쳐서 5초 안쪽이라 사람이 기다리는 느낌은 거의 없다. */
const AFTER_TURN_RETRY_MS = [250, 1_000, 3_000];

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

  constructor(
    private readonly store: StateStore,
    /** 보낸 메시지 중 추가 요청의 id. 그 요청을 sent 로 바꾸는 데 쓴다. */
    private readonly onSent: (requestIds: string[]) => Promise<void> = async () => {},
  ) {}

  /** 받을 에이전트가 있는지 상태를 바꾸기 전에 확인한다. 없으면 AgentGoneError. */
  async ensureReachable(paseo: PaseoApi, agentId: string): Promise<Snapshot> {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot || snapshot.agent.archivedAt) throw new AgentGoneError(agentId);
    return snapshot;
  }

  async deliver(paseo: PaseoApi, agentId: string, text: string, requestId: string | null = null): Promise<Delivery> {
    const at = new Date().toISOString();
    await this.store.update((state) => ({
      state: { ...state, outbox: { ...state.outbox, [agentId]: [...(state.outbox[agentId] ?? []), { text, at, requestId }] } },
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
      await paseo.agents.ref(agentId).send(taken.map((item) => item.text).join(MESSAGE_SEPARATOR));
      const requestIds = taken.map((item) => item.requestId).filter((id): id is string => Boolean(id));
      if (requestIds.length) await this.onSent(requestIds).catch((error) => console.error("[coordinator] could not mark requests sent", error));
      return true;
    } catch (error) {
      await this.store.update((state) => ({
        state: { ...state, outbox: { ...state.outbox, [agentId]: [...taken, ...(state.outbox[agentId] ?? [])] } },
        result: undefined,
      }));
      throw error;
    }
  }

  /**
   * 턴이 끝났을 때 내보낸다. 턴 끝 hook 이 에이전트 상태가 idle 로 바뀌기 전에 올 수 있어서, 아직 바빠 보이면 잠깐씩 기다렸다가
   * 몇 번 더 본다. 그 사이 사람이 새 턴을 시작했으면 끝까지 바쁘고, 메시지는 그 턴이 끝날 때 나간다.
   */
  async flushAfterTurn(paseo: PaseoApi, agentId: string, delays: readonly number[] = AFTER_TURN_RETRY_MS): Promise<boolean> {
    for (const delay of [0, ...delays]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await this.flush(paseo, agentId)) return true;
      if (!(await this.store.read()).outbox[agentId]?.length) return false;
    }
    return false;
  }

  /** 아직 보내지 않은 추가 요청을 뺀다. 이미 보냈으면 false. */
  async withdraw(requestId: string): Promise<boolean> {
    return this.store.update((state) => {
      for (const [agentId, messages] of Object.entries(state.outbox)) {
        if (!messages.some((item) => item.requestId === requestId)) continue;
        const left = messages.filter((item) => item.requestId !== requestId);
        const { [agentId]: _old, ...rest } = state.outbox;
        return { state: { ...state, outbox: left.length ? { ...rest, [agentId]: left } : rest }, result: true };
      }
      return { state, result: false };
    });
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
