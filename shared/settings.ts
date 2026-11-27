import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const OUTPUT_LANGUAGES = ["auto", "en", "ko"] as const;

/** 요약은 받은 글을 정리만 해서 작은 모델로 충분하다. 사람이 정할 일이 생길 때만 돈다. */
export const DEFAULT_SUMMARY_MODEL = "claude/claude-haiku-5-5";

export const settingsSchema = z.object({
  /**
   * 결정 기록 도구와 지침을 붙일 프로젝트. 붙이면 그 프로젝트의 모든 에이전트(사람이 띄운 것 포함)의 동작이 바뀌므로
   * 사람이 고른 프로젝트에만 붙인다. 비어 있으면 어디에도 붙이지 않는다.
   */
  projectIds: z.array(z.string()).default([]),
  summary: z
    .object({
      enabled: z.boolean().default(true),
      /** provider/model 형식. agents.create 가 이 형식을 요구한다. */
      model: z.string().min(3).default(DEFAULT_SUMMARY_MODEL),
      effort: z.string().min(1).nullable().default(null),
    })
    .default({ enabled: true, model: DEFAULT_SUMMARY_MODEL, effort: null }),
  /** 요약의 언어. auto 는 앱 언어를 따른다. server 는 앱 언어를 모르므로 클라이언트가 RPC 로 함께 보낸다. */
  outputLanguage: z.enum(OUTPUT_LANGUAGES).default("auto"),
});

export type CoordinatorSettings = z.output<typeof settingsSchema>;

export const coordinatorSettings = defineSettings({
  id: "coordinator-v1",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});
