import type { Decision, Followup } from "../shared/model";
import type { Outbox } from "./outbox";
import type { PaseoApi } from "./paseo-api";
import { type StateStore, nextId } from "./store";

// 에이전트에게 가는 문장은 화면 언어와 관계없이 영어로 둔다. 사람이 쓴 답은 그대로 붙인다.

const REVIEWABLE = new Set<Decision["status"]>(["unreviewed", "approved", "undo"]);

function list(decisions: readonly Decision[]): string {
  return decisions.map((item) => `#${item.number} ${item.decision}`).join("\n");
}

/** 사람이 카드에서 하는 일. 상태를 바꾸고, 에이전트에게 보낼 말이 있으면 outbox 로 보낸다. */
export class Actions {
  constructor(
    private readonly store: StateStore,
    private readonly outbox: Outbox,
  ) {}

  /** 에이전트의 멈춘 결정에 한 번에 답한다. 에이전트는 멈출 때 모든 결정을 한 메시지로 물었으므로 답도 한 메시지로 간다. */
  async answer(paseo: PaseoApi, agentId: string, text: string): Promise<{ delivery: "sent" | "queued" }> {
    await this.outbox.ensureReachable(paseo, agentId);
    const at = new Date().toISOString();
    const answered = await this.store.update((state) => {
      const waiting = state.decisions.filter((item) => item.agentId === agentId && item.status === "waiting");
      if (!waiting.length) return { state, result: [] as Decision[] };
      const ids = new Set(waiting.map((item) => item.id));
      return {
        state: {
          ...state,
          decisions: state.decisions.map((item) => (ids.has(item.id) ? { ...item, status: "answered" as const, reply: { text, at } } : item)),
        },
        result: waiting,
      };
    });
    if (!answered.length) throw new Error("This agent has no decision waiting for an answer.");
    const message = `The user answered the decisions you stopped on:\n${list(answered)}\n\nAnswer:\n${text}\n\nContinue with this answer. Do not record these decisions again.`;
    return { delivery: await this.outbox.deliver(paseo, agentId, message) };
  }

  /** 기록하고 진행한 결정을 확인한다. 되돌리라고 하면 에이전트마다 지시를 보낸다. */
  async review(
    paseo: PaseoApi,
    input: { decisionIds: string[]; verdict: "approved" | "undo"; text: string | null },
  ): Promise<{ delivery: "sent" | "queued" | "none" }> {
    if (input.verdict === "undo" && !input.text?.trim()) throw new Error("Write what to do instead.");
    const at = new Date().toISOString();
    const wanted = new Set(input.decisionIds);
    if (input.verdict === "undo") {
      const agents = new Set((await this.store.read()).decisions.filter((item) => wanted.has(item.id)).map((item) => item.agentId));
      for (const agentId of agents) await this.outbox.ensureReachable(paseo, agentId);
    }
    const changed = await this.store.update((state) => {
      // 멈춘 결정은 답으로 처리한다. 확인 전 결정과, 이미 확인한 결정을 다시 바꾸는 경우(승인을 되돌리기로)만 받는다.
      const targets = state.decisions.filter((item) => wanted.has(item.id) && REVIEWABLE.has(item.status));
      if (!targets.length) return { state, result: [] as Decision[] };
      const ids = new Set(targets.map((item) => item.id));
      return {
        state: {
          ...state,
          decisions: state.decisions.map((item) =>
            ids.has(item.id)
              ? { ...item, status: input.verdict, reply: input.verdict === "undo" ? { text: input.text!.trim(), at } : item.reply }
              : item,
          ),
        },
        result: targets,
      };
    });
    if (!changed.length) throw new Error("These decisions cannot be reviewed now.");
    if (input.verdict === "approved") return { delivery: "none" };
    const byAgent = new Map<string, Decision[]>();
    for (const item of changed) byAgent.set(item.agentId, [...(byAgent.get(item.agentId) ?? []), item]);
    let delivery: "sent" | "queued" = "sent";
    for (const [agentId, decisions] of byAgent) {
      const message = `The user reviewed decisions you made and wants them changed:\n${list(decisions)}\n\nInstead:\n${input.text!.trim()}\n\nChange your work accordingly. Record any new choice this needs with record_decision.`;
      if ((await this.outbox.deliver(paseo, agentId, message)) === "queued") delivery = "queued";
    }
    return { delivery };
  }

  async addFollowup(input: { text: string; projectId: string | null; workspaceId: string | null }): Promise<Record<string, never>> {
    await this.store.update((state) => {
      const { state: next, id } = nextId(state, "f");
      const followup: Followup = {
        id,
        text: input.text,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        agentId: null,
        source: "human",
        at: new Date().toISOString(),
        status: "open",
        sentTo: null,
        callId: null,
      };
      return { state: { ...next, followups: [...next.followups, followup] }, result: undefined };
    });
    return {};
  }

  async updateFollowup(id: string, status: Followup["status"]): Promise<Record<string, never>> {
    await this.store.update((state) => {
      if (!state.followups.some((item) => item.id === id)) return { state, result: undefined };
      return { state: { ...state, followups: state.followups.map((item) => (item.id === id ? { ...item, status } : item)) }, result: undefined };
    });
    return {};
  }

  /** 후속 작업을 사람이 고른 에이전트에게 맡긴다. 새 워크스페이스는 사람이 만든다. 플러그인은 일을 배정하지 않는다. */
  async sendFollowup(paseo: PaseoApi, id: string, agentId: string): Promise<{ delivery: "sent" | "queued" }> {
    await this.outbox.ensureReachable(paseo, agentId);
    // 먼저 닫고 보낸다. 보내기가 실패하면 다시 연다. 반대로 하면 전송 뒤 오류에서 열린 채로 남아 두 번 누르면 두 번 간다.
    const followup = await this.store.update((state) => {
      const found = state.followups.find((item) => item.id === id);
      if (!found || found.status !== "open") return { state, result: null };
      return {
        state: { ...state, followups: state.followups.map((item) => (item.id === id ? { ...item, status: "done" as const, sentTo: agentId } : item)) },
        result: found,
      };
    });
    if (!followup) throw new Error("This follow-up is not open.");
    try {
      return { delivery: await this.outbox.deliver(paseo, agentId, `A follow-up from the user's list:\n\n${followup.text}`) };
    } catch (error) {
      await this.store.update((state) => ({
        state: { ...state, followups: state.followups.map((item) => (item.id === id ? { ...item, status: "open" as const, sentTo: null } : item)) },
        result: undefined,
      }));
      throw error;
    }
  }
}

/**
 * 질문 창에서 받은 답을 멈춘 결정에 남긴다. 에이전트는 답을 질문 창으로 이미 받았으므로 따로 보내지 않는다. 답은 질문마다
 * "질문: 답" 으로 적는다. 질문 창에 어느 결정이 들어 있는지는 알 수 없어서, 그 에이전트의 멈춘 결정 모두에 같은 답을 남긴다.
 */
export async function answerFromQuestion(store: StateStore, agentId: string, updatedInput: unknown): Promise<number> {
  const answers = (updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers ?? {};
  const text = Object.entries(answers)
    .map(([question, answer]) => `${question}: ${String(answer)}`)
    .join("\n");
  const at = new Date().toISOString();
  return store.update((state) => {
    const waiting = state.decisions.filter((item) => item.agentId === agentId && item.status === "waiting");
    if (!waiting.length) return { state, result: 0 };
    const ids = new Set(waiting.map((item) => item.id));
    return {
      state: {
        ...state,
        decisions: state.decisions.map((item) => (ids.has(item.id) ? { ...item, status: "answered" as const, reply: { text: text || "(answered in the question window)", at } } : item)),
      },
      result: waiting.length,
    };
  });
}
