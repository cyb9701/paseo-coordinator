import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 검토자는 근거 확인과 자기 답 도출을 건너뛰지 않도록 high 이상만 쓴다 (RULES.md §7, 2026-11-25 사용자 결정).
export const REVIEWER_EFFORTS = ["high", "xhigh", "max"] as const;

export const DEFAULT_COORDINATOR_MODEL = "claude/claude-opus-5-5";
export const DEFAULT_REVIEWER_MODELS = ["claude/claude-opus-5-5", "claude/claude-sonnet-5-5"];

const coordinatorSchema = z.object({
  /** provider/model 형식. Paseo 의 agents.create 가 이 형식을 요구한다. */
  model: z.string().min(3).default(DEFAULT_COORDINATOR_MODEL),
  effort: z.string().min(1).default("high"),
});

const reviewersSchema = z.object({
  models: z.array(z.string().min(3)).min(1).default(DEFAULT_REVIEWER_MODELS),
  effort: z.enum(REVIEWER_EFFORTS).default("high"),
});

export const settingsSchema = z.object({
  coordinator: coordinatorSchema.default({ model: DEFAULT_COORDINATOR_MODEL, effort: "high" }),
  reviewers: reviewersSchema.default({ models: DEFAULT_REVIEWER_MODELS, effort: "high" }),
  /** 코디네이터가 워커를 만들 수 있는 프로젝트. 비어 있으면 어디에도 만들지 않는다. */
  allowedProjectIds: z.array(z.string()).default([]),
});

export type CoordinatorSettings = z.output<typeof settingsSchema>;

export const coordinatorSettings = defineSettings({
  id: "coordinator",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
