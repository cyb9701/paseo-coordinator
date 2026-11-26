import type { PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { CoordinatorRequest, cancelRequestRpc, createRequestRpc, recordInstructionRpc } from "../shared/model";
import { completionNeedsDecision, continuedBy, dependentsOf, hasStarted, openCard, withCardQa } from "../shared/model";
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
  /** 사람이 고른 기준 브랜치가 그 프로젝트 저장소에 있는지. 없는 이름을 받아 두면 배정할 때야 막힌다. */
  branchExists: (projectId: string, branch: string) => Promise<boolean> = async () => true,
  /** 사람이 고른 기존 워크스페이스에서 워커를 띄울 수 없는 이유. 띄울 수 있으면 null. */
  workspaceProblem: (projectId: string, workspaceId: string) => Promise<string | null> = async () => null,
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
  for (const [projectId, branch] of Object.entries(input.baseBranches)) {
    if (!input.projectIds.includes(projectId)) {
      throw new Error(say(language, `A base branch was chosen for ${projectId}, which is not in this request.`, `요청에 없는 프로젝트 ${projectId} 에 기준 브랜치를 골랐어요.`));
    }
    if (!(await branchExists(projectId, branch))) {
      throw new Error(say(language, `Branch ${branch} does not exist in project ${projectId}.`, `프로젝트 ${projectId} 에 ${branch} 브랜치가 없어요.`));
    }
  }
  for (const [projectId, workspaceId] of Object.entries(input.workspaces)) {
    if (!input.projectIds.includes(projectId)) {
      throw new Error(say(language, `A workspace was chosen for ${projectId}, which is not in this request.`, `요청에 없는 프로젝트 ${projectId} 에 워크스페이스를 골랐어요.`));
    }
    // 기존 워크스페이스는 이미 브랜치가 정해져 있다. 둘 다 받으면 어느 쪽을 따를지 사람이 모른다.
    if (input.baseBranches[projectId]) {
      throw new Error(
        say(language, `Choose either a base branch or an existing workspace for ${projectId}, not both.`, `프로젝트 ${projectId} 에는 기준 브랜치와 기존 워크스페이스 중 하나만 고를 수 있어요.`),
      );
    }
    const problem = await workspaceProblem(projectId, workspaceId);
    if (problem) throw new Error(say(language, `Cannot work in that workspace: ${problem}.`, `그 워크스페이스에서는 일할 수 없어요: ${problem}.`));
  }
  return store.update((state) => {
    const used = state.requests.map((request) => Number(request.id.slice(1))).filter(Number.isFinite);
    const id = `r${(used.length > 0 ? Math.max(...used) : 0) + 1}`;
    const request = {
      id,
      text: input.text,
      doneCriteria: input.doneCriteria || null,
      projectIds: input.projectIds,
      baseBranches: input.baseBranches,
      workspaces: input.workspaces,
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
      beforeChange: false,
      investigation: null,
      answer: null,
      question: null,
      reviewedAt: null,
      coordinatorAgentId: null,
      coordinatorReadAt: null,
      stall: null,
      lastQuestion: null,
    };
    return { state: { ...state, requests: [...state.requests, request] }, result: { id } };
  });
}

/**
 * 요청을 취소한다. 사람의 결정을 기다리는 완료 카드(PR 머지, PR 에 없는 변경)가 있으면 취소하지 않는다. 취소하면 카드가 화면에서
 * 사라지고 PR 은 GitHub 에 열린 채 남는다 (2026-11-26 전수 검사). 작업 취소(cancelTasksIn)와 같은 보호다.
 */
export async function cancelRequest({ id }: RpcInput<typeof cancelRequestRpc>, store: StateStore) {
  await store.update((state) => {
    const target = state.requests.find((request) => request.id === id);
    if (!target) throw new Error(`Unknown request ${id}`);
    const waiting = target.tasks.filter((task) => task.status === "review" && !task.completion?.closedAt && completionNeedsDecision(task));
    if (target.status === "running" && waiting.length > 0) {
      const names = waiting.map((task) => (task.completion?.pr ? `${task.number} (PR #${task.completion.pr.number})` : String(task.number))).join(", ");
      throw new Error(
        say(
          target.language,
          `Task ${names} has finished work waiting on your card. Merge it or close the pull request on GitHub and close the card first; canceling now would leave it out of sight.`,
          `작업 ${names} 의 끝난 결과가 카드에서 결정을 기다려요. 먼저 머지하거나, GitHub 에서 PR 을 닫고 카드를 정리해 주세요. 지금 취소하면 그 결과가 화면에서 사라져요.`,
        ),
      );
    }
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
 * 사람의 추가 지시(시작 카드·보드의 수정 지시, 답변 카드의 추가 질문, 질문 카드의 직접 지시).
 * 요청에 남기고, 워커가 아직 일하지 않으면 다시 계획 단계로 돌린다. 코디네이터에게는 호출한 쪽이 알린다.
 * 워커가 일하는 요청은 진행 중인 채로 두고, 코디네이터가 워커에게 전하거나 작업을 더하거나 뺀다.
 * 질문 카드의 직접 지시(answersQuestion)는 그 질문에 대한 사람의 답이다. 답으로 기록해야 A 등급 관문이 같은 질문을 다시 묻지
 * 않는다. 다른 곳에서 보낸 지시는 열린 질문을 닫지 않는다. 계획 전 요청에 질문이 열려 있으면 질문 카드에서 답하게 한다
 * (보드의 지시가 질문의 답이 되어 카드가 조용히 닫히고 관문이 열렸다, 2026-11-26 최종 검사).
 */
export async function revisePlan(
  { id, text, answersQuestion = false }: { id: string; text: string; answersQuestion?: boolean },
  store: StateStore,
) {
  await store.update((state) => {
    const request = state.requests.find((item) => item.id === id);
    if (!request) throw new Error(`Unknown request ${id}`);
    if (request.status === "done" || request.status === "canceled") {
      throw new Error(say(request.language, `Request ${id} is ${request.status}; it does not take instructions now.`, `요청 ${id} 은 이미 끝나서 지시를 받지 않아요.`));
    }
    if (answersQuestion && !request.question) {
      throw new Error(say(request.language, "This question card is no longer open.", "이 질문 카드는 이미 닫혔어요."));
    }
    if (!answersQuestion && request.question && request.status === "needs_input") {
      throw new Error(
        say(
          request.language,
          "The coordinator is waiting for your answer. Answer the question card, or use its instruction field.",
          "코디네이터가 내 답을 기다리고 있어요. 질문 카드에서 답하거나, 질문 카드의 직접 지시를 써 주세요.",
        ),
      );
    }
    const at = new Date().toISOString();
    const entry = { text, at, kind: answersQuestion ? ("answer" as const) : ("instruction" as const) };
    const answered = answersQuestion ? { question: null, lastQuestion: answeredQuestion(request.question!, at) } : {};
    // 이미 워커가 일하는 요청은 다시 계획하지 않는다(같은 작업이 또 배정된다). 요청은 진행 중인 채로 지시만 남기고,
    // 코디네이터가 읽어서 워커에게 전하거나 작업을 더하거나 뺀다.
    if (request.status === "running" && hasStarted(request)) {
      return {
        state: {
          ...state,
          requests: state.requests.map((item) => (item.id === id ? { ...item, ...answered, feedback: [...item.feedback, entry] } : item)),
        },
        result: undefined,
      };
    }
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id ? { ...item, ...answered, status: "planning" as const, feedback: [...item.feedback, entry] } : item,
        ),
      },
      result: undefined,
    };
  });
  return {};
}

/** 답한 질문 카드를 남긴다. 운영 작업 관문이 그 질문에 대상이 적혀 있었는지 본다. */
function answeredQuestion(question: NonNullable<CoordinatorRequest["question"]>, at: string): NonNullable<CoordinatorRequest["lastQuestion"]> {
  return { context: question.context, questions: question.questions, answeredAt: at };
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
    if ((request.status !== "needs_input" && !running) || !request.question) {
      throw new Error(say(request.language, `Request ${id} is ${request.status}, not waiting for answers.`, `요청 ${id} 은 답을 기다리고 있지 않아요.`));
    }
    const at = new Date().toISOString();
    const entries = answers.map(({ question, answer }) => ({ text: `${question} → ${answer}`, at, kind: "answer" as const }));
    const lastQuestion = answeredQuestion(request.question, at);
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === id
            ? { ...item, status: running ? item.status : ("planning" as const), question: null, lastQuestion, feedback: [...item.feedback, ...entries] }
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
): Promise<{ hasWorker: boolean; orphanWorkspaceId: string | null }> {
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
      : { ...task, status: "waiting" as const, note: null, branch: null, workspaceId: null, startCommit: null, decisions };
    return {
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id !== request.id ? item : { ...item, tasks: item.tasks.map((t) => (t.number === task.number ? next : t)) },
        ),
      },
      // 워커를 만들기 전에 실패한 작업은 워크스페이스만 남았을 수 있다. 새로 배정하면 새 worktree 를 만들므로 옛것은 정리한다.
      // 앞 작업의 worktree 를 이어 쓰던 작업이면 그 워크스페이스는 앞 작업의 것이다. 지우면 앞 작업의 변경이 사라진다
      // (2026-11-26 최종 검사). 사람의 기존 워크스페이스는 지우지 않는다.
      result: {
        hasWorker: Boolean(task.agentId),
        orphanWorkspaceId:
          task.agentId ||
          task.existingWorkspaceId ||
          request.tasks.some((other) => other.number !== task.number && other.workspaceId === task.workspaceId)
            ? null
            : task.workspaceId,
      },
    };
  });
}

/**
 * 요청에서 작업들을 취소한 결과를 만든다(저장하지 않는다). 그 작업에 기대는 작업도 함께 취소한다. 기대는 작업은
 * 앞 작업의 결과 위에서 일하도록 계획됐으므로, 혼자 돌면 계획과 다른 일을 한다. 모든 작업이 취소되면 요청도 취소한다.
 * 멈춘 작업 카드의 취소(사람)와 코디네이터의 작업 취소가 같이 쓴다.
 */
export function cancelTasksIn(
  request: CoordinatorRequest,
  numbers: readonly number[],
  by: "human" | "coordinator",
  reason: string | null,
): { request: CoordinatorRequest; agentIds: string[]; reviewerIds: string[]; requestCanceled: boolean; canceled: number[] } {
  const canceled = new Set<number>();
  for (const number of numbers) {
    canceled.add(number);
    for (const dependent of dependentsOf(request, number)) canceled.add(dependent);
  }
  // 끝나서 사람의 카드를 기다리는 작업은 취소하지 않는다. 취소하면 PR 이 GitHub 에 열린 채 카드가 사라진다.
  const finished = request.tasks.filter((item) => canceled.has(item.number) && item.status === "review").map((item) => item.number);
  if (finished.length > 0) {
    throw new Error(
      say(
        request.language,
        `Task ${finished.join(", ")} has finished work waiting on your card and would be canceled with this. Decide that card first.`,
        `작업 ${finished.join(", ")} 의 끝난 결과가 카드에서 내 결정을 기다리는데, 함께 취소돼요. 그 카드를 먼저 정해 주세요.`,
      ),
    );
  }
  const at = new Date().toISOString();
  const first = Math.min(...numbers);
  const tasks = request.tasks.map((item) => {
    if (!canceled.has(item.number)) return item;
    const summary = numbers.includes(item.number)
      ? `Canceled by the ${by}${reason ? `: ${reason}` : ""}`
      : `Canceled with task ${first}, which it depends on`;
    return {
      ...item,
      status: "canceled" as const,
      note: null,
      outbox: [],
      blocker: null,
      decisions: [...item.decisions, { summary, by, at, qa: [] }],
    };
  });
  // 취소한 작업이 앞 작업의 worktree 를 이어 쓰고 있었다면, 앞 작업은 '뒤 작업이 PR 을 낸다'는 이유로 PR 없이 done 이 됐다.
  // 그대로 두면 앞 작업의 커밋이 카드도 PR 도 없이 worktree 에만 남고 요청은 완료가 된다 (2026-11-26 전수 검사).
  // 앞 작업을 완료 카드로 되돌려 사람이 그 커밋을 어떻게 할지 정하게 한다. continuedBy 는 취소된 뒤 작업을 세지 않으므로
  // 원래 계획의 뒤 작업을 직접 찾는다.
  const reopened = tasks.map((item) => {
    if (item.status !== "done" || !item.completion || item.completion.closedAt || item.kind === "operation") return item;
    const next = continuedBy({ tasks: request.tasks }, item);
    if (!next || !canceled.has(next.number)) return item;
    return {
      ...item,
      status: "review" as const,
      completion: {
        ...item.completion,
        unpublished: say(
          request.language,
          `Task ${next.number}, which was to continue this work and open the pull request, was canceled. The commits of this task are only in its worktree.`,
          `이 작업을 이어서 PR 을 낼 작업 ${next.number} 가 취소됐어요. 이 작업의 커밋은 worktree 에만 있어요.`,
        ),
      },
    };
  });
  const requestCanceled = reopened.every((item) => item.status === "canceled");
  const agentIds = request.tasks.filter((item) => canceled.has(item.number) && item.agentId).map((item) => item.agentId!);
  const reviewerIds = request.tasks.flatMap((item) =>
    canceled.has(item.number) && item.blocker?.review?.status === "running" ? item.blocker.review.reviewers.map((reviewer) => reviewer.agentId) : [],
  );
  return {
    request: { ...request, tasks: reopened, status: requestCanceled ? ("canceled" as const) : request.status },
    agentIds,
    reviewerIds,
    requestCanceled,
    canceled: [...canceled].sort((a, b) => a - b),
  };
}

/**
 * 멈춘 작업(워커 질문 카드가 없는 것)을 진행하지 않고 취소한다 (멈춘 작업 카드). 워커를 멈추는 일은 호출한 쪽이
 * 돌려받은 agentIds 로 한다.
 */
export async function cancelTask(
  input: { requestId: string; taskNumber: number },
  store: StateStore,
): Promise<{ agentIds: string[]; requestCanceled: boolean }> {
  return store.update((state) => {
    const request = state.requests.find((item) => item.id === input.requestId);
    const task = request?.tasks.find((item) => item.number === input.taskNumber);
    if (!request || request.status !== "running" || !task || task.status !== "blocked" || task.blocker) {
      throw new Error(say(request?.language, "This task cannot be canceled now.", "이 작업은 지금 취소할 수 없어요."));
    }
    const result = cancelTasksIn(request, [task.number], "human", null);
    return {
      state: { ...state, requests: state.requests.map((item) => (item.id === request.id ? result.request : item)) },
      result: { agentIds: result.agentIds, requestCanceled: result.requestCanceled },
    };
  });
}
