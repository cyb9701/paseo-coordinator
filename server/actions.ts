import { answerMessage, askMessage, redoMessage, requestMessage, revertMessage } from "../shared/messages";
import { ANSWERED_IN_QUESTION_WINDOW, type Decision, REVIEWABLE_STATUSES, type WorkRequest } from "../shared/model";
import { CoordinatorError } from "../shared/errors";
import { AgentGoneError, type Outbox } from "./outbox";
import type { PaseoApi } from "./paseo-api";
import { type StateStore, nextId } from "./store";

// 에이전트에게 가는 문장은 shared/messages.ts 에서 만든다. 화면이 같은 파일로 그 문장을 다시 알아본다.

const REVIEWABLE = new Set<Decision["status"]>(REVIEWABLE_STATUSES);

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
    if (!answered.length) throw new CoordinatorError("noWaitingDecision", "This agent has no decision waiting for an answer.");
    return { delivery: await this.outbox.deliver(paseo, agentId, answerMessage(answered, text)) };
  }

  /**
   * 기록하고 진행한 결정을 확인한다. approved 는 그대로 둔다. revert 는 그 결정으로 바뀐 것을 원래대로 돌리라고 보내고,
   * undo 는 사람이 쓴 방식으로 바꿔서 다시 하라고 보낸다. 에이전트마다 메시지 하나로 간다.
   */
  async review(
    paseo: PaseoApi,
    input: { decisionIds: string[]; verdict: "approved" | "revert" | "undo"; text: string | null },
  ): Promise<{ delivery: "sent" | "queued" | "none" }> {
    const note = input.text?.trim() || null;
    if (input.verdict === "undo" && !note) throw new Error("Write what to do instead.");
    const at = new Date().toISOString();
    const wanted = new Set(input.decisionIds);
    if (input.verdict !== "approved") {
      const agents = new Set((await this.store.read()).decisions.filter((item) => wanted.has(item.id)).map((item) => item.agentId));
      for (const agentId of agents) await this.outbox.ensureReachable(paseo, agentId);
    }
    const changed = await this.store.update((state) => {
      const targets = state.decisions.filter((item) => wanted.has(item.id) && REVIEWABLE.has(item.status));
      if (!targets.length) return { state, result: [] as Decision[] };
      const ids = new Set(targets.map((item) => item.id));
      return {
        state: {
          ...state,
          decisions: state.decisions.map((item) =>
            ids.has(item.id) ? { ...item, status: input.verdict, reply: input.verdict === "approved" ? item.reply : { text: note ?? "", at } } : item,
          ),
        },
        result: targets,
      };
    });
    if (!changed.length) throw new CoordinatorError("notReviewable", "These decisions cannot be reviewed now.");
    if (input.verdict === "approved") return { delivery: "none" };
    const byAgent = new Map<string, Decision[]>();
    for (const item of changed) byAgent.set(item.agentId, [...(byAgent.get(item.agentId) ?? []), item]);
    let delivery: "sent" | "queued" = "sent";
    for (const [agentId, decisions] of byAgent) {
      const message = input.verdict === "revert" ? revertMessage(decisions, note) : redoMessage(decisions, note ?? "");
      if ((await this.outbox.deliver(paseo, agentId, message)) === "queued") delivery = "queued";
    }
    return { delivery };
  }

  /** 워크스페이스에 추가 요청을 넣는다. 에이전트가 쉬면 바로 받고, 일하는 중이면 턴이 끝난 뒤 순서대로 받는다. */
  async addRequest(paseo: PaseoApi, input: { workspaceId: string; agentId: string; text: string; projectId: string | null }) {
    // 화면이 고른 에이전트와 워크스페이스가 어긋나면 요청은 한 워크스페이스에 기록되고 다른 워크스페이스의 에이전트가 받는다.
    const snapshot = await this.outbox.ensureReachable(paseo, input.agentId);
    if (snapshot.agent.workspaceId !== input.workspaceId) {
      throw new CoordinatorError("agentNotInWorkspace", "This agent is not in the workspace the request is for. Nothing was sent.");
    }
    const id = await this.store.update((state) => {
      const { state: next, id } = nextId(state, "r");
      const request: WorkRequest = {
        id,
        text: input.text,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        source: "human",
        status: "queued",
        at: new Date().toISOString(),
        sentAt: null,
        callId: null,
      };
      return { state: { ...next, requests: [...next.requests, request] }, result: id };
    });
    return { delivery: await this.outbox.deliver(paseo, input.agentId, requestMessage(input.text), id) };
  }

  /** 에이전트가 남긴 제안을 사람이 고른 에이전트에게 추가 요청으로 보낸다. */
  async sendSuggestion(paseo: PaseoApi, id: string, agentId: string) {
    await this.outbox.ensureReachable(paseo, agentId);
    const request = await this.store.update((state) => {
      const found = state.requests.find((item) => item.id === id);
      if (!found || found.status !== "suggested") return { state, result: null };
      return {
        state: { ...state, requests: state.requests.map((item) => (item.id === id ? { ...item, status: "queued" as const, agentId } : item)) },
        result: found,
      };
    });
    if (!request) throw new CoordinatorError("suggestionClosed", "This suggestion is no longer open.");
    return { delivery: await this.outbox.deliver(paseo, agentId, requestMessage(request.text), id) };
  }

  /** 받기 전의 요청을 취소하거나 제안을 버린다. 이미 보낸 요청은 취소할 수 없다. */
  async dismissRequest(id: string): Promise<Record<string, never>> {
    const request = (await this.store.read()).requests.find((item) => item.id === id);
    if (!request || (request.status !== "queued" && request.status !== "suggested")) throw new CoordinatorError("requestClosed", "This request was already sent or closed.");
    if (request.status === "queued" && !(await this.outbox.withdraw(id))) throw new CoordinatorError("requestSent", "This request was already sent.");
    await this.store.update((state) => ({
      state: { ...state, requests: state.requests.map((item) => (item.id === id ? { ...item, status: "dismissed" as const } : item)) },
      result: undefined,
    }));
    return {};
  }

  async markSent(requestIds: readonly string[]): Promise<void> {
    const ids = new Set(requestIds);
    const at = new Date().toISOString();
    await this.store.update((state) => ({
      state: { ...state, requests: state.requests.map((item) => (ids.has(item.id) ? { ...item, status: "sent" as const, sentAt: at } : item)) },
      result: undefined,
    }));
  }

  /**
   * 결정하기 전에 에이전트에게 묻는다. 에이전트가 질문 창으로 묻는 중이면 그 질문 창을 이 질문으로 돌려보낸다(답하고 다시 물으라고).
   * 아니면 쉴 때 메시지로 보낸다. 에이전트의 다음 응답이 답으로 카드에 붙는다(index.server.ts 의 턴·권한 hook).
   */
  async ask(paseo: PaseoApi, agentId: string, text: string): Promise<Record<string, never>> {
    const snapshot = await paseo.agents.ref(agentId).refresh();
    if (!snapshot || snapshot.agent.archivedAt) throw new AgentGoneError(agentId);
    await this.store.update((state) => {
      const { state: next, id } = nextId(state, "q");
      return { state: { ...next, asks: [...next.asks, { id, agentId, text, at: new Date().toISOString(), answer: null, answeredAt: null }] }, result: undefined };
    });
    const message = askMessage(text);
    const question = (snapshot.agent.pendingPermissions ?? []).find((request) => request.kind === "question");
    if (question) {
      await paseo.agents.ref(agentId).respondToPermission({ requestId: question.id, response: { behavior: "deny", message } });
    } else {
      await this.outbox.deliver(paseo, agentId, message);
    }
    return {};
  }

  /** 답을 기다리는 질문에 에이전트의 응답을 붙인다. 에이전트가 턴을 끝내거나 다시 질문 창을 띄울 때 부른다. */
  async recordAskAnswer(agentId: string, answer: string | null): Promise<void> {
    if (!answer?.trim()) return;
    const at = new Date().toISOString();
    await this.store.update((state) => {
      const open = state.asks.filter((item) => item.agentId === agentId && !item.answer);
      if (!open.length) return { state, result: undefined };
      const ids = new Set(open.map((item) => item.id));
      return { state: { ...state, asks: state.asks.map((item) => (ids.has(item.id) ? { ...item, answer: answer.trim(), answeredAt: at } : item)) }, result: undefined };
    });
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
        decisions: state.decisions.map((item) => (ids.has(item.id) ? { ...item, status: "answered" as const, reply: { text: text || ANSWERED_IN_QUESTION_WINDOW, at } } : item)),
      },
      result: waiting.length,
    };
  });
}
