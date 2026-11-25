import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

// 요청 등급. A 가 가장 무겁고 D 가 가장 가볍다 (RULES.md §10).
export const GRADES = ["A", "B", "C", "D"] as const;

export const REQUEST_STATUSES = ["planning", "awaiting_approval", "running", "done", "canceled"] as const;
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
  status: z.enum(REQUEST_STATUSES),
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
  feedback: z.array(z.object({ text: z.string(), at: z.string() })).default([]),
  /** 코디네이터에게 이 요청을 마지막으로 알린 시각. 수정 지시가 더 늦으면 다시 알린다. */
  notifiedAt: z.string().nullable().default(null),
  /** 계획을 마지막으로 제출받은 시각. */
  plannedAt: z.string().nullable().default(null),
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

export const approvePlanRpc = defineRpc({
  name: "plans.approve",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

export const revisePlanRpc = defineRpc({
  name: "plans.revise",
  input: z.object({ id: z.string(), text: z.string().trim().min(1) }),
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
