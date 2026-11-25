import type { PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { cancelRequestRpc, createRequestRpc, recordInstructionRpc } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import type { StateStore } from "./store";

type Settings = PluginSettings<typeof settingsSchema>;

async function readSettings(settings: Settings) {
  const state = await settings.read();
  if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
  return state.values;
}

function resolveLanguage(setting: "auto" | "en" | "ko", locale: string): "en" | "ko" {
  if (setting !== "auto") return setting;
  return locale.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export async function createRequest(
  input: RpcInput<typeof createRequestRpc>,
  store: StateStore,
  settings: Settings,
): Promise<{ id: string }> {
  const values = await readSettings(settings);
  // 허용 목록 밖 프로젝트는 여기서 막는다. 화면은 허용된 프로젝트만 보여 주지만, RPC 는 다른 경로로도 불릴 수 있다.
  const outside = input.projectIds.filter((id) => !values.allowedProjectIds.includes(id));
  if (outside.length > 0) throw new Error(`Projects not allowed in coordinator settings: ${outside.join(", ")}`);
  if (values.allowedProjectIds.length === 0) {
    throw new Error("No projects are allowed. Choose projects in coordinator settings first.");
  }
  return store.update((state) => {
    const used = state.requests.map((request) => Number(request.id.slice(1))).filter(Number.isFinite);
    const id = `r${(used.length > 0 ? Math.max(...used) : 0) + 1}`;
    const request = {
      id,
      text: input.text,
      doneCriteria: input.doneCriteria || null,
      projectIds: input.projectIds,
      language: resolveLanguage(values.outputLanguage, input.locale),
      createdAt: new Date().toISOString(),
      status: "planning" as const,
      title: null,
      grade: null,
      tasks: [],
      gradeReasons: [],
      recommendation: null,
      risks: [],
      unknowns: [],
      feedback: [],
      notifiedAt: null,
      plannedAt: null,
      kind: null,
      answer: null,
      question: null,
      reviewedAt: null,
    };
    return { state: { ...state, requests: [...state.requests, request] }, result: { id } };
  });
}

export async function cancelRequest({ id }: RpcInput<typeof cancelRequestRpc>, store: StateStore) {
  await store.update((state) => {
    if (!state.requests.some((request) => request.id === id)) throw new Error(`Unknown request ${id}`);
    return {
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id === id && request.status !== "done" ? { ...request, status: "canceled" as const } : request,
        ),
      },
      result: undefined,
    };
  });
  return {};
}

export async function recordInstruction({ agentId, text }: RpcInput<typeof recordInstructionRpc>, store: StateStore) {
  await store.update((state) => ({
    state: { ...state, sent: [...state.sent, { agentId, text, at: new Date().toISOString() }] },
    result: undefined,
  }));
  return {};
}

/**
 * 사람의 추가 지시(시작 카드의 수정 지시, 답변 카드의 추가 질문, 질문 카드의 직접 지시).
 * 요청에 남기고 다시 계획 단계로 돌린다. 코디네이터에게는 호출한 쪽이 알린다.
 * 이미 일하는 워커에게 바뀐 내용을 전하는 일은 3e 배정 단계에서 코디네이터가 맡는다.
 */
export async function revisePlan({ id, text }: { id: string; text: string }, store: StateStore) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error(`Unknown request ${id}`);
    if (request.status === "done" || request.status === "canceled") {
      throw new Error(`Request ${id} is ${request.status}; it does not take instructions now.`);
    }
    const entry = { text, at: new Date().toISOString(), kind: "instruction" as const };
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id ? { ...item, status: "planning" as const, question: null, feedback: [...item.feedback, entry] } : item,
        ),
      },
      result: undefined,
    };
  });
  return {};
}

/** 코디네이터의 질문 카드에 사람이 답했다. 답을 요청에 남기고 코디네이터가 이어서 진행하게 계획 단계로 돌린다. */
export async function answerQuestions(
  { id, answers }: { id: string; answers: { question: string; answer: string }[] },
  store: StateStore,
) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error(`Unknown request ${id}`);
    if (request.status !== "needs_input") throw new Error(`Request ${id} is ${request.status}, not waiting for answers.`);
    const at = new Date().toISOString();
    const entries = answers.map(({ question, answer }) => ({ text: `${question} → ${answer}`, at, kind: "answer" as const }));
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id ? { ...item, status: "planning" as const, question: null, feedback: [...item.feedback, ...entries] } : item,
        ),
      },
      result: undefined,
    };
  });
  return {};
}

/** 시작 카드나 답변 카드를 확인했다. 답변은 요청을 끝내고, 시작한 요청은 계속 진행된다. */
export async function acknowledge({ id }: { id: string }, store: StateStore) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error(`Unknown request ${id}`);
    const reviewedAt = new Date().toISOString();
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id ? { ...item, reviewedAt, status: item.status === "answered" ? ("done" as const) : item.status } : item,
        ),
      },
      result: undefined,
    };
  });
  return {};
}
