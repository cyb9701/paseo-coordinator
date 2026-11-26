import type { PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { cancelRequestRpc, createRequestRpc, recordInstructionRpc } from "../shared/model";
import { hasStarted, openCard, withCardQa } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import type { StateStore } from "./store";
import { queued } from "./worker-channel";
import { say } from "./say";

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
  const language = resolveLanguage(values.outputLanguage, input.locale);
  const outside = input.projectIds.filter((id) => !values.allowedProjectIds.includes(id));
  if (outside.length > 0) {
    throw new Error(say(language, `Projects not allowed in coordinator settings: ${outside.join(", ")}`, `코디네이터 설정에서 허용되지 않은 프로젝트예요: ${outside.join(", ")}`));
  }
  if (values.allowedProjectIds.length === 0) {
    throw new Error(say(language, "No projects are allowed. Choose projects in coordinator settings first.", "허용된 프로젝트가 없어요. 먼저 코디네이터 설정에서 프로젝트를 골라 주세요."));
  }
  return store.update((state) => {
    const used = state.requests.map((request) => Number(request.id.slice(1))).filter(Number.isFinite);
    const id = `r${(used.length > 0 ? Math.max(...used) : 0) + 1}`;
    const request = {
      id,
      text: input.text,
      doneCriteria: input.doneCriteria || null,
      projectIds: input.projectIds,
      language,
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
      coordinatorAgentId: null,
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
      throw new Error(say(request.language, `Request ${id} is ${request.status}; it does not take instructions now.`, `요청 ${id} 은 이미 끝나서 지시를 받지 않아요.`));
    }
    const entry = { text, at: new Date().toISOString(), kind: "instruction" as const };
    // 이미 워커가 일하는 요청은 다시 계획하지 않는다(같은 작업이 또 배정된다). 요청은 진행 중인 채로 지시만 남기고,
    // 코디네이터가 읽어서 관련 워커에게 전한다 (coordinator_message_worker).
    // 질문 카드의 '직접 지시'로 왔으면 질문은 이 지시로 대신한다.
    if (request.status === "running" && hasStarted(request)) {
      return {
        state: {
          ...state,
          requests: state.requests.map((item) => (item.id === id ? { ...item, question: null, feedback: [...item.feedback, entry] } : item)),
        },
        result: undefined,
      };
    }
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

/**
 * 코디네이터의 질문 카드에 사람이 답했다. 답을 요청에 남긴다. 계획 전 질문이면 계획 단계로 돌리고,
 * 워커가 이미 일하는 요청의 질문이면 진행 중인 채로 둔다. 코디네이터는 새 지시로 알림을 받아 워커에게 전한다.
 */
export async function answerQuestions(
  { id, answers }: { id: string; answers: { question: string; answer: string }[] },
  store: StateStore,
) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error(`Unknown request ${id}`);
    const running = request.status === "running" && request.question !== null;
    if (request.status !== "needs_input" && !running) {
      throw new Error(say(request.language, `Request ${id} is ${request.status}, not waiting for answers.`, `요청 ${id} 은 답을 기다리고 있지 않아요.`));
    }
    const at = new Date().toISOString();
    const entries = answers.map(({ question, answer }) => ({ text: `${question} → ${answer}`, at, kind: "answer" as const }));
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id
            ? { ...item, status: running ? item.status : ("planning" as const), question: null, feedback: [...item.feedback, ...entries] }
            : item,
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

/** 답이 달린 문답만 결정 기록으로 옮긴다. 답을 기다리던 질문은 카드가 닫히면 의미가 없다. */
export function answeredQa(qa: readonly { question: string; answer: string | null }[]) {
  return qa.flatMap((item) => (item.answer ? [{ question: item.question, answer: item.answer }] : []));
}

/**
 * 워커 질문 카드에서 사람이 결정했다. 고른 선택지(또는 직접 쓴 지시)를 워커의 outbox 에 넣고,
 * 카드를 닫고 결정을 기록한다. 보내는 일은 호출한 쪽이 WorkerChannel.flush 로 한다.
 */
export async function resolveBlocker(
  input: { requestId: string; taskNumber: number; choice: string | null; instruction: string | null },
  store: StateStore,
): Promise<{ abandonedReviewers: string[] }> {
  return store.update((state) => {
    const request = state.requests.find((item) => item.id === input.requestId);
    const task = request?.tasks.find((item) => item.number === input.taskNumber);
    const blocker = task?.blocker;
    if (!request || !task || !blocker) throw new Error(say(request?.language, "This decision card is no longer open.", "이 결정 카드는 이미 닫혔어요."));
    const option = input.choice ? blocker.coordinator?.options.find((item) => item.label === input.choice) : undefined;
    if (input.choice && !option) throw new Error(say(request.language, `Unknown option ${input.choice}.`, `선택지 ${input.choice} 를 찾을 수 없어요. 카드가 바뀌었을 수 있어요.`));
    const instruction = input.instruction?.trim();
    if (!option && !instruction) throw new Error(say(request.language, "Choose an option or write an instruction.", "선택지를 고르거나 지시를 적어 주세요."));
    const message = option
      ? `[Decision from the human on what you reported: "${blocker.summary}"]\nChosen: ${option.label}\n${option.instruction}${instruction ? `\nAlso: ${instruction}` : ""}\nContinue your task with this decision.`
      : `[Instruction from the human on what you reported: "${blocker.summary}"]\n${instruction}\nContinue your task with this instruction.`;
    const at = new Date().toISOString();
    const summary = `${blocker.summary} → ${option ? option.label : instruction}`;
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id !== request.id
            ? item
            : {
                ...item,
                tasks: item.tasks.map((t) =>
                  t.number !== task.number
                    ? t
                    : // 메시지는 상태와 같은 update 에서 outbox 에 넣는다. 보내는 일은 호출한 쪽이 flush 로 한다.
                      queued(
                        {
                          ...t,
                          status: "running" as const,
                          note: null,
                          blocker: null,
                          doneNudgedAt: null,
                          decisions: [...t.decisions, { summary, by: "human" as const, at, qa: answeredQa(blocker.qa) }],
                        },
                        message,
                      ),
                ),
              },
        ),
      },
      // 검토가 도는 중에 사람이 먼저 정했으면 그 검토자들은 정리해야 한다.
      result: { abandonedReviewers: blocker.review?.status === "running" ? blocker.review.reviewers.map((item) => item.agentId) : [] },
    };
  });
}

/** 카드에서 코디네이터에게 묻는다. 답은 코디네이터가 coordinator_answer_question 으로 단다. */
export async function askCoordinator(input: { requestId: string; taskNumber: number; question: string }, store: StateStore) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === input.requestId);
    const task = request?.tasks.find((item) => item.number === input.taskNumber);
    if (!task || !openCard(task)) throw new Error(say(request?.language, "This card is no longer open.", "이 카드는 이미 닫혔어요."));
    const entry = { question: input.question, answer: null, at: new Date().toISOString(), answeredAt: null, notifiedAt: null };
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id !== input.requestId
            ? item
            : {
                ...item,
                tasks: item.tasks.map((t) => (t.number === input.taskNumber ? withCardQa(t, (qa) => [...qa, entry]) : t)),
              },
        ),
      },
      result: undefined,
    };
  });
  return {};
}

/** 막힌 작업을 다시 시작한다 (retryTaskRpc). 워커에게 보낼 메시지는 outbox 에 넣고, 보내는 일은 호출한 쪽이 flush 로 한다. */
export async function retryTask(
  input: { requestId: string; taskNumber: number; instruction: string | null },
  store: StateStore,
): Promise<{ hasWorker: boolean }> {
  return store.update((state) => {
    const request = state.requests.find((item) => item.id === input.requestId);
    const task = request?.tasks.find((item) => item.number === input.taskNumber);
    if (!request || request.status !== "running" || !task || task.status !== "blocked" || task.blocker) {
      throw new Error(say(request?.language, "This task is not waiting to be restarted.", "이 작업은 다시 시작할 상태가 아니에요."));
    }
    const at = new Date().toISOString();
    const text = input.instruction?.trim();
    const decisions = [...task.decisions, { summary: `Restarted${text ? `: ${text}` : ""}`, by: "human" as const, at, qa: [] }];
    const next = task.agentId
      ? queued(
          { ...task, status: "running" as const, note: null, doneNudgedAt: null, decisions },
          `[From the human] ${text ?? "Continue your task from where you stopped."}\nWhen it is finished and verified, call report_done; if you need a decision, call report_blocker.`,
        )
      : { ...task, status: "waiting" as const, note: null, branch: null, workspaceId: null, decisions };
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id !== request.id ? item : { ...item, tasks: item.tasks.map((t) => (t.number === task.number ? next : t)) },
        ),
      },
      result: { hasWorker: Boolean(task.agentId) },
    };
  });
}
