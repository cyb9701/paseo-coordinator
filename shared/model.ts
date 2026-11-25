import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

// 요청 등급. A 가 가장 무겁고 D 가 가장 가볍다 (RULES.md §10).
export const GRADES = ["A", "B", "C", "D"] as const;

// needs_input: 코디네이터가 사람에게 질문 카드를 보냈고 답을 기다린다.
// answered: 코디네이터가 읽기 요청에 직접 답했고 사람의 확인을 기다린다.
// 계획 승인 대기(awaiting_approval)는 v3 에서 없앴다. 명확한 요청은 코디네이터가 바로 배정한다 (RULES.md §2.0).
export const REQUEST_STATUSES = ["planning", "needs_input", "running", "answered", "done", "canceled"] as const;

// v2 에 저장된 awaiting_approval 은 계획 단계로 돌려 새 흐름으로 다시 처리한다.
const requestStatus = z.preprocess(
  (value) => (value === "awaiting_approval" ? "planning" : value),
  z.enum(REQUEST_STATUSES),
);

export const questionSchema = z.object({
  question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  /** 코디네이터가 추천하는 선택지 label. 없으면 null. */
  recommended: z.string().nullable(),
});

/**
 * read: 아무것도 바꾸지 않고 답이나 보고만 원하는 요청. 등급과 계획 승인을 거치지 않는다.
 * change: 파일, 커밋, PR, DB, 외부 전송 중 하나라도 바꾸는 요청. 등급을 매기고 계획을 승인받는다.
 * (읽기만 하는 요청에 변경 요청의 등급 기준을 쓰자 '문서 파악' 요청이 A 등급이 됐다. 2026-11-25 사용자 피드백.)
 */
export const REQUEST_KINDS = ["read", "change"] as const;
export const TASK_STATUSES = ["waiting", "running", "blocked", "review", "done"] as const;

export const taskSchema = z.object({
  number: z.number().int().positive(),
  /** 작업 이름. 워크스페이스 제목 '<요청 이름> · <번호> <작업 이름>'에 그대로 쓴다 (DESIGN.md 이름 규칙). */
  name: z.string(),
  projectId: z.string(),
  dependsOn: z.array(z.number().int().positive()),
  /** 이 작업이 하는 일과 하지 않는 일. 워커 킥오프에 그대로 들어간다. */
  scope: z.string().default(""),
  doneCriteria: z.string().default(""),
  /** 이 작업이 원래 요청의 어느 문장에 해당하는지. W6 대응표와 검토자가 쓴다. */
  requestRefs: z.array(z.string()).default([]),
  status: z.enum(TASK_STATUSES),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  /** 워커가 일하는 브랜치. 배정할 때 플러그인이 정한다 (coord/<요청>-<번호>-…). */
  branch: z.string().nullable().default(null),
  /** 막힌 이유나 배정 실패 이유. 사람이 카드에서 읽는다. */
  note: z.string().nullable().default(null),
});

export const requestSchema = z.object({
  /** r1, r2 … 브랜치 이름(coord/r12-3-…)에도 쓴다. */
  id: z.string(),
  /** 사람이 쓴 원문. 검토자에게도 이 원문을 그대로 넘긴다 (RULES.md 원칙 5). 고치지 않는다. */
  text: z.string(),
  doneCriteria: z.string().nullable(),
  /** 사람이 고른 프로젝트. 비어 있으면 코디네이터가 허용 목록 안에서 고른다. */
  projectIds: z.array(z.string()),
  /** 코디네이터가 쓰는 워크스페이스 이름과 카드의 언어. 요청을 만들 때 정해진다. */
  language: z.enum(["en", "ko"]),
  createdAt: z.string(),
  status: requestStatus,
  /** 코디네이터가 분류한 뒤 채운다. */
  kind: z.enum(REQUEST_KINDS).nullable().default(null),
  /** 코디네이터가 계획을 세운 뒤 채운다. */
  title: z.string().nullable(),
  grade: z.enum(GRADES).nullable(),
  tasks: z.array(taskSchema),
  /** 코디네이터가 계획과 함께 쓰는 판단 근거. 계획 승인 카드에 그대로 나온다. */
  gradeReasons: z.array(z.string()).default([]),
  recommendation: z.string().nullable().default(null),
  risks: z.array(z.string()).default([]),
  unknowns: z.array(z.string()).default([]),
  /** 사람이 계획 승인 카드에서 보낸 수정 지시. 원래 요청과 함께 '원래 요청'의 일부로 본다 (RULES.md §1). */
  feedback: z
    .array(
      z.object({
        text: z.string(),
        at: z.string(),
        /** answer: 코디네이터의 질문 카드에 사람이 준 답. A 등급 실제 변경은 이 답이 있어야 시작한다. */
        kind: z.enum(["instruction", "answer"]).default("instruction"),
      }),
    )
    .default([]),
  /** 코디네이터에게 이 요청을 마지막으로 알린 시각. 수정 지시가 더 늦으면 다시 알린다. */
  notifiedAt: z.string().nullable().default(null),
  /** 계획을 마지막으로 제출받은 시각. */
  plannedAt: z.string().nullable().default(null),
  /** 코디네이터가 사람에게 묻는 질문 카드. 답을 받으면 비운다. */
  question: z
    .object({
      context: z.string(),
      questions: z.array(questionSchema).min(1),
      /** 질문이 어느 프로젝트 이야기인지. 카드에 프로젝트 이름을 보이기 위해 코디네이터가 남긴다. */
      projectIds: z.array(z.string()).default([]),
      at: z.string(),
    })
    .nullable()
    .default(null),
  /** 사람이 시작 카드나 답변 카드를 확인한 시각. 그 뒤에 새 계획이나 답이 오면 다시 확인 필요가 된다. */
  reviewedAt: z.string().nullable().default(null),
  /** 읽기 요청에 코디네이터가 직접 쓴 답. */
  answer: z
    .object({
      text: z.string(),
      sources: z.array(z.string()),
      unknowns: z.array(z.string()),
      /** 답이 어느 프로젝트를 보고 쓴 것인지. 카드에 프로젝트 이름을 보이기 위해 코디네이터가 남긴다. */
      projectIds: z.array(z.string()).default([]),
      at: z.string(),
    })
    .nullable()
    .default(null),
});

export const sentInstructionSchema = z.object({
  agentId: z.string(),
  text: z.string(),
  at: z.string(),
});

export const stateSchema = z.object({
  requests: z.array(requestSchema),
  /** 사람이 결정 카드에서 에이전트에게 보낸 지시. 화면을 닫아도 남도록 server 에 둔다. */
  sent: z.array(sentInstructionSchema),
  /** 이 host 의 코디네이터 에이전트. 처음 요청이 들어올 때 만든다. */
  coordinator: z.object({ agentId: z.string(), workspaceId: z.string() }).nullable().default(null),
});

export type Task = z.infer<typeof taskSchema>;
export type Question = z.infer<typeof questionSchema>;
export type CoordinatorRequest = z.infer<typeof requestSchema>;
export type SentInstruction = z.infer<typeof sentInstructionSchema>;
export type CoordinatorState = z.infer<typeof stateSchema>;

export const createRequestRpc = defineRpc({
  name: "requests.create",
  input: z.object({
    text: z.string().trim().min(1),
    doneCriteria: z.string().trim().nullable(),
    projectIds: z.array(z.string()),
    /** 요청을 보낸 앱의 언어. 출력 언어 설정이 auto 일 때 쓴다. */
    locale: z.string(),
  }),
  output: z.object({ id: z.string() }),
});

export const cancelRequestRpc = defineRpc({
  name: "requests.cancel",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

export const revisePlanRpc = defineRpc({
  name: "plans.revise",
  input: z.object({ id: z.string(), text: z.string().trim().min(1) }),
  output: z.object({}),
});

export const answerQuestionsRpc = defineRpc({
  name: "questions.answer",
  input: z.object({
    id: z.string(),
    answers: z.array(z.object({ question: z.string(), answer: z.string().trim().min(1) })).min(1),
  }),
  output: z.object({}),
});

/** 시작 카드나 답변 카드를 확인했다. 답변은 요청을 끝낸다. */
export const acknowledgeRpc = defineRpc({
  name: "requests.acknowledge",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

export const recordInstructionRpc = defineRpc({
  name: "instructions.record",
  input: z.object({ agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({}),
});

export const watchStateSubscription = defineSubscription({
  name: "state.watch",
  input: z.object({}),
  event: stateSchema,
});

/** 요청에 걸린 프로젝트. 사람이 고른 것, 작업의 프로젝트, 코디네이터가 답하거나 물을 때 본 프로젝트를 모은다. */
export function requestProjectIds(request: CoordinatorRequest): string[] {
  return [
    ...new Set([
      ...request.projectIds,
      ...request.tasks.map((task) => task.projectId),
      ...(request.answer?.projectIds ?? []),
      ...(request.question?.projectIds ?? []),
    ]),
  ];
}
