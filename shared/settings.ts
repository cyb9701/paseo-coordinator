import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// 검토자는 근거 확인과 자기 답 도출을 건너뛰지 않도록 high 이상만 쓴다 (RULES.md §7, 2026-11-25 사용자 결정).
export const REVIEWER_EFFORTS = ["high", "xhigh", "max"] as const;

export const OUTPUT_LANGUAGES = ["auto", "en", "ko"] as const;

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
  /** 코디네이터가 배정하는 워커. 형식은 코디네이터와 같다. */
  worker: coordinatorSchema.default({ model: DEFAULT_COORDINATOR_MODEL, effort: "high" }),
  /**
   * A·B·C 등급 변경 작업 워커를 /poteto-mode 로 시작할지 (RULES.md §11). 켜져 있어도 워커 세션에 pstack 이 없으면 쓰지 않는다.
   * poteto 는 하위 에이전트를 높은 effort 로 띄워 비용과 시간이 늘어서, 끌 수 있게 둔다.
   */
  poteto: z.boolean().default(true),
  reviewers: reviewersSchema.default({ models: DEFAULT_REVIEWER_MODELS, effort: "high" }),
  /** 코디네이터가 워커를 만들 수 있는 프로젝트. 비어 있으면 어디에도 만들지 않는다. */
  allowedProjectIds: z.array(z.string()).default([]),
  /** projectId → 워커 worktree 의 기본 기준 브랜치. 없으면 원격 기본 브랜치(origin/HEAD)를 쓴다 (server/branches.ts). */
  baseBranches: z.record(z.string(), z.string().min(1)).default({}),
  /**
   * 코디네이터가 쓰는 워크스페이스 이름과 결정 카드의 언어.
   * auto 는 요청을 보낸 사람의 앱 언어를 따른다. server 는 앱 언어를 모르므로 요청을 만들 때 클라이언트가 함께 보낸다.
   */
  outputLanguage: z.enum(OUTPUT_LANGUAGES).default("auto"),
});

export type CoordinatorSettings = z.output<typeof settingsSchema>;

export const coordinatorSettings = defineSettings({
  id: "coordinator",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
