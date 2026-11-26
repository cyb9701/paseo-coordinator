import type { PaseoApi } from "./paseo-api";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { StateStore } from "./store";

export const REPORT_BLOCKER_TOOL = "report_blocker";

/** 이 라벨로 워커 세션을 알아본다. 배정기가 워커를 만들 때 붙인다. */
export function isWorkerSession(labels: Readonly<Record<string, string>>): boolean {
  return labels["paseo-coordinator.role"] === "worker";
}

/**
 * 워커가 막혔을 때 쓰는 도구. 글로 "진행할까요?" 라고 묻고 턴을 끝내면 Paseo 는 그냥 턴 종료로 보고
 * 사람에게 '결과 미확인'으로만 보인다 (DESIGN.md 알려진 한계). 이 도구로 보고하면 코디네이터가 받아 결정 카드를 만든다.
 */
export function reportBlockerTool(
  store: StateStore,
  onReported: (paseo: PaseoApi) => void,
  /** 검토가 도는 중에 워커가 다시 보고해 블로커가 바뀌었다. 그 검토자들을 정리한다. */
  onReviewReplaced: (paseo: PaseoApi, requestId: string, taskNumber: number, reviewerIds: string[]) => void,
) {
  return defineAgentTool({
    name: REPORT_BLOCKER_TOOL,
    title: "Report a blocker",
    description:
      "Report that you need a decision before you can continue: a question the request and your scope do not settle, a change to your scope or approach, or something that stops you. Give the facts you checked, the options with what each leads to, and your recommendation. Then stop and wait: the reply arrives in this conversation.",
    input: z.object({
      kind: z.enum(["question", "change", "stuck"]),
      summary: z.string().trim().min(1),
      facts: z.array(z.string().trim().min(1)).min(1),
      options: z.array(z.object({ label: z.string().trim().min(1), consequence: z.string().trim().min(1) })).default([]),
      recommendation: z.string().nullable().default(null),
    }),
    execute: async (input, { agent, paseo }) => {
      const at = new Date().toISOString();
      const found = await store.update((state) => {
        let hit: { requestId: string; taskNumber: number; reviewers: string[] } | null = null;
        const requests = state.requests.map((request) => ({
          ...request,
          tasks: request.tasks.map((task) => {
            if (task.agentId !== agent.id) return task;
            const review = task.blocker?.review;
            hit = {
              requestId: request.id,
              taskNumber: task.number,
              reviewers: review?.status === "running" ? review.reviewers.map((item) => item.agentId) : [],
            };
            return {
              ...task,
              status: "blocked" as const,
              note: input.summary,
              blocker: {
                kind: input.kind,
                summary: input.summary,
                facts: input.facts,
                options: input.options,
                workerRecommendation: input.recommendation,
                at,
                notifiedAt: null,
                coordinator: null,
                qa: [],
                proposal: null,
                review: null,
                objections: [],
              },
            };
          }),
        }));
        return { state: { ...state, requests }, result: hit };
      });
      if (!found) return { text: "You are not a coordinator worker; nothing was reported.", isError: true };
      const { requestId, taskNumber, reviewers } = found as { requestId: string; taskNumber: number; reviewers: string[] };
      if (reviewers.length) onReviewReplaced(paseo, requestId, taskNumber, reviewers);
      onReported(paseo);
      return { text: "Reported to the coordinator. Stop now and end your turn; the decision will arrive in this conversation." };
    },
  });
}
