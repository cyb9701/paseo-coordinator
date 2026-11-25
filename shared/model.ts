import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

// 요청 등급. A 가 가장 무겁고 D 가 가장 가볍다 (RULES.md §10).
export const GRADES = ["A", "B", "C", "D"] as const;

export const REQUEST_STATUSES = ["planning", "awaiting_approval", "running", "done", "canceled"] as const;
export const TASK_STATUSES = ["waiting", "running", "blocked", "review", "done"] as const;

export const taskSchema = z.object({
  number: z.number().int().positive(),
  name: z.string(),
  projectId: z.string(),
  dependsOn: z.array(z.number().int().positive()),
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
