import type { PaseoApi } from "./paseo-api";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { CoordinatorRequest, CoordinatorState, Task } from "../shared/model";
import { AUTO_RULES } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import type { StateStore } from "./store";
import { type WorkerChannel, queued } from "./worker-channel";
import { say } from "./say";

type Settings = PluginSettings<typeof settingsSchema>;
type Proposal = NonNullable<NonNullable<Task["blocker"]>["proposal"]>;

const ROLE_LABEL = "paseo-coordinator.role";

/** 등급별 검토자 수 (RULES.md §7). A 는 자동 처리하지 않는다. 등급이 없는 읽기 요청은 기본값 2. */
const REVIEWERS_BY_GRADE: Record<"A" | "B" | "C" | "D", number> = { A: 0, B: 3, C: 2, D: 2 };

/** effort 별 제한 시간 (RULES.md §7). 넘기면 FAIL 이다. */
const TIMEOUT_MINUTES: Record<string, number> = { high: 5, xhigh: 8, max: 12 };

/** 같은 작업에서 자동 결정이 이만큼 넘으면 사람에게 간다 (RULES.md H6). */
const MAX_AUTO_PER_TASK = 3;

/** 자동 정지: 한 규칙의 최근 자동 결정 10건 중 2건 이상을 사람이 되돌리면 그 규칙을 끈다 (RULES.md §5). */
const AUTO_STOP_WINDOW = 10;
const AUTO_STOP_REVERTS = 2;

const CHECKS = ["scope", "side_effects", "undo", "evidence", "decider", "alternative"] as const;

export function isReviewerSession(labels: Readonly<Record<string, string>>): boolean {
  return labels[ROLE_LABEL] === "reviewer";
}

async function readSettings(settings: Settings) {
  const state = await settings.read();
  if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
  return state.values;
}

/**
 * 검토 패킷 중 제안을 뺀 부분. 원문은 플러그인이 저장소에서 꺼내 넣는다. 코디네이터가 요약하거나 고칠 수 없다 (RULES.md 원칙 5).
 * 검토자는 이것만 보고 먼저 자기 답을 쓴다. 제안은 자기 답을 기록한 뒤에 도구 결과로 공개된다 (RULES.md §7 검토 순서 1).
 */
function packet(request: CoordinatorRequest, task: Task): string {
  const blocker = task.blocker!;
  return [
    "You are an independent reviewer for the Paseo Coordinator. You have not seen the coordinator's reasoning and must decide on your own.",
    "You are read-only: do not change any file. You may read files in this worktree to check facts.",
    "",
    "The human's request, verbatim:",
    "<<<",
    request.text,
    ...(request.doneCriteria ? [`Done when: ${request.doneCriteria}`] : []),
    ...request.feedback.map((item) => `Later from the human: ${item.text}`),
    ">>>",
    "",
    `Task ${task.number}: ${task.name}`,
    `Scope: ${task.scope}`,
    `Done when: ${task.doneCriteria}`,
    ...(task.decisions.length ? ["Earlier decisions on this task:", ...task.decisions.flatMap((item) => [`- ${item.summary}`, ...item.qa.map((qa) => `  Q: ${qa.question} / A: ${qa.answer}`)])] : []),
    "",
    "The worker stopped and reported:",
    `- Summary: ${blocker.summary}`,
    ...blocker.facts.map((fact) => `- Fact: ${fact}`),
    ...blocker.options.map((option) => `- Option ${option.label}: ${option.consequence}`),
    ...(blocker.workerRecommendation ? [`- Worker recommends: ${blocker.workerRecommendation}`] : []),
    "",
    "Step 1: decide what the worker should be told, using only the above and read-only checks of this worktree.",
    "Call reviewer_record_own_answer with that answer. Only then you will see the coordinator's proposal and the checklist.",
  ].join("\n");
}

function revealProposal(proposal: Proposal): string {
  return [
    "Recorded. Now the coordinator's proposal:",
    `Rule: ${proposal.rule}`,
    `Answer to the worker: ${proposal.answer}`,
    "Evidence:",
    ...proposal.evidence.map((item) => `- ${item.fact} (source: ${item.source})`),
    `How to undo: ${proposal.undo}`,
    "Self-check against H1–H6:",
    ...proposal.selfCheck.map((line) => `- ${line}`),
    "",
    "Step 2: if your own answer and the proposal differ in substance, the verdict is FAIL.",
    "Step 3: verify every evidence item yourself in this worktree. If any cannot be confirmed, FAIL.",
    "Step 4: fill the checklist. PASS only if every check passes:",
    "- scope: you can quote the sentence of the request the answer stays within",
    "- side_effects: nothing outside this worktree and branch is affected",
    "- undo: the undo really works",
    "- evidence: every evidence item is confirmed",
    "- decider: it is not a human's call (product or UX direction, data structure, library, public API, irreversible)",
    "- alternative: there is no safer alternative with the same result",
    "If you are not sure, answer UNSURE (it counts as FAIL). Then call reviewer_submit_verdict.",
  ].join("\n");
}

/**
 * 독립 검토 (6단계). 코디네이터가 W 규칙으로 워커 질문에 답하려 하면, 새 context 의 검토자 N 명이 각자 확인하고
 * 전원 PASS 일 때만 워커에게 보낸다. 하나라도 PASS 가 아니면 사람 카드가 된다 (RULES.md §7).
 */
export class ReviewRunner {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 마무리 중인 검토. 검토자 두 명이 거의 동시에 제출하거나 마감 타이머와 겹쳐도 한 번만 마무리한다. */
  private readonly finalizing = new Set<string>();

  private clearTimer(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
  }

  /**
   * 마무리 전에 블로커가 닫히거나 바뀐 검토를 버린다. 검토자를 정리하지 않으면 남아서 권한 요청이 사람에게 간다.
   * 사람이 카드에서 먼저 정했거나, 워커가 다시 보고했거나, 요청이 취소된 경우다.
   */
  async abandon(paseo: PaseoApi, requestId: string, taskNumber: number, reviewerIds: readonly string[]): Promise<void> {
    this.clearTimer(`${requestId}:${taskNumber}`);
    await Promise.all(reviewerIds.map((id) => paseo.agents.ref(id).archive().catch(() => undefined)));
  }

  constructor(
    private readonly store: StateStore,
    private readonly settings: Settings,
    private readonly channel: WorkerChannel,
  ) {}

  private async find(requestId: string, taskNumber: number) {
    const state = await this.store.read();
    const request = state.requests.find((item) => item.id === requestId);
    const task = request?.tasks.find((item) => item.number === taskNumber);
    return request && task ? { state, request, task } : null;
  }

  /** 검토자 에이전트로 자기 검토를 찾는다. */
  async findReview(agentId: string) {
    const state = await this.store.read();
    for (const request of state.requests) {
      for (const task of request.tasks) {
        const reviewer = task.blocker?.review?.reviewers.find((item) => item.agentId === agentId);
        if (reviewer) return { request, task, reviewer };
      }
    }
    return null;
  }

  /**
   * 기계 사전 검사. 걸리면 그 이유를 돌려주고, 코디네이터는 사람 카드(coordinator_prepare_decision)를 써야 한다.
   */
  precheck(state: CoordinatorState, request: CoordinatorRequest, task: Task, rule: (typeof AUTO_RULES)[number]): string | null {
    if (request.grade === "A") return "Grade A requests are never decided automatically (RULES.md H4).";
    if (state.disabledRules.includes(rule)) return `Rule ${rule} is switched off after the human reverted its decisions (RULES.md §5).`;
    if (task.autoDecisions.length >= MAX_AUTO_PER_TASK) {
      return `This task already had ${task.autoDecisions.length} automatic decisions (RULES.md H6).`;
    }
    const summary = task.blocker?.summary.trim();
    if (summary && task.autoDecisions.some((item) => item.question.trim() === summary)) {
      return "The worker asked the same question again, so the earlier automatic answer did not work (RULES.md H6).";
    }
    const required = request.grade ? REVIEWERS_BY_GRADE[request.grade] : 2;
    if (required === 0) return "This grade has no automatic decisions.";
    return null;
  }

  async start(paseo: PaseoApi, requestId: string, taskNumber: number, proposal: Proposal): Promise<void> {
    const found = await this.find(requestId, taskNumber);
    const blocker = found?.task.blocker;
    const workspaceId = found?.task.workspaceId;
    if (!found || !blocker || !workspaceId) throw new Error("This task has no open blocker.");
    const { request, task } = found;
    const values = await readSettings(this.settings);
    const required = request.grade ? REVIEWERS_BY_GRADE[request.grade] : 2;
    const effort = values.reviewers.effort;
    const startedAt = new Date();
    const deadline = new Date(startedAt.getTime() + (TIMEOUT_MINUTES[effort] ?? 5) * 60_000);
    await this.patchBlocker(requestId, taskNumber, (blocker) => ({
      ...blocker,
      proposal,
      objections: [],
      review: { status: "running", required, startedAt: startedAt.toISOString(), deadline: deadline.toISOString(), reviewers: [] },
    }));
    const prompt = packet(request, { ...task, blocker: { ...blocker, proposal } });
    const workspace = paseo.workspaces.ref(workspaceId);
    const reviewers: NonNullable<NonNullable<Task["blocker"]>["review"]>["reviewers"] = [];
    for (let index = 0; index < required; index += 1) {
      const model = values.reviewers.models[index % values.reviewers.models.length]!;
      const provider = model.split("/")[0]!;
      const modes = (await paseo.providers.listModes(provider).catch(() => null))?.modes ?? [];
      // 프롬프트 없이 만들고 모두 기록한 뒤에 보낸다. 먼저 일을 시작한 검토자는 기록되기 전이라 도구 호출과 권한이
      // 검토자로 인식되지 않았다.
      const agent = await workspace.agents
        .create({
          // plan 모드라 파일을 바꿀 수 없다. 그래도 오는 쓰기 권한 요청은 플러그인이 거절한다 (index.server.ts).
          config: { provider: model, modeId: modes.some((mode) => mode.id === "plan") ? "plan" : undefined, thinkingOptionId: effort },
          title: `review ${requestId}-${taskNumber} #${index + 1}`,
          labels: { [ROLE_LABEL]: "reviewer", "paseo-coordinator.request": requestId, "paseo-coordinator.task": String(taskNumber) },
        })
        .catch((error: unknown) => {
          console.error(`[coordinator] could not create reviewer ${index + 1} for ${requestId}:${taskNumber}`, error);
          return null;
        });
      if (!agent) break;
      reviewers.push({ agentId: agent.id, model, ownAnswer: null, verdict: null, checks: [], objections: [], at: null });
    }
    await this.patchBlocker(requestId, taskNumber, (blocker) =>
      blocker.review ? { ...blocker, review: { ...blocker.review, reviewers } } : blocker,
    );
    const key = `${requestId}:${taskNumber}`;
    if (reviewers.length < required) {
      // 검토자를 다 만들지 못하면 통과할 수 없다. 만든 검토자를 정리하고 바로 사람 카드로 돌린다.
      await this.finalize(paseo, requestId, taskNumber, "complete");
      return;
    }
    await Promise.all(reviewers.map((reviewer) => paseo.agents.ref(reviewer.agentId).send(prompt)));
    this.clearTimer(key);
    this.timers.set(
      key,
      setTimeout(() => {
        this.finalize(paseo, requestId, taskNumber, "timeout").catch((error) => console.error("[coordinator] review timeout failed", error));
      }, deadline.getTime() - Date.now()),
    );
    console.log(`[coordinator] review started for ${key} with ${required} reviewers (${proposal.rule})`);
  }

  /** 플러그인이 다시 시작돼 타이머가 사라졌어도, 마감이 지난 검토를 마무리한다. */
  async reconcile(paseo: PaseoApi): Promise<void> {
    const state = await this.store.read();
    for (const request of state.requests) {
      for (const task of request.tasks) {
        const review = task.blocker?.review;
        if (review?.status === "running" && Date.parse(review.deadline) < Date.now()) {
          await this.finalize(paseo, request.id, task.number, "timeout");
        }
      }
    }
  }

  /** 검토가 끝났다(전원 제출 또는 시간 초과). 전원 PASS 면 워커에게 보내고, 아니면 사람 카드로 돌린다. */
  async finalize(paseo: PaseoApi, requestId: string, taskNumber: number, reason: "complete" | "timeout"): Promise<void> {
    const key = `${requestId}:${taskNumber}`;
    if (this.finalizing.has(key)) return;
    this.finalizing.add(key);
    try {
      await this.finalizeOnce(paseo, requestId, taskNumber, reason);
    } finally {
      this.finalizing.delete(key);
    }
  }

  private async finalizeOnce(paseo: PaseoApi, requestId: string, taskNumber: number, reason: "complete" | "timeout"): Promise<void> {
    const found = await this.find(requestId, taskNumber);
    const blocker = found?.task.blocker;
    const review = blocker?.review;
    const proposal = blocker?.proposal;
    if (!found || !blocker || !review || review.status !== "running" || !proposal) return;
    this.clearTimer(`${requestId}:${taskNumber}`);
    const passed = review.reviewers.length === review.required && review.reviewers.every((item) => item.verdict === "PASS");
    const at = new Date().toISOString();
    if (passed) {
      const message = `[Decision from the coordinator, verified by ${review.required} independent reviewers, on what you reported: "${blocker.summary}"]\n${proposal.answer}\nContinue your task with this decision.`;
      await this.store.update((state) => ({
        state: {
          ...state,
          requests: state.requests.map((request) =>
            request.id !== requestId
              ? request
              : {
                  ...request,
                  tasks: request.tasks.map((task) =>
                    task.number !== taskNumber
                      ? task
                      : queued({
                          ...task,
                          status: "running" as const,
                          note: null,
                          blocker: null,
                          doneNudgedAt: null,
                          decisions: [...task.decisions, { summary: `${blocker.summary} → ${proposal.answer}`, by: "coordinator" as const, at, qa: [] }],
                          autoDecisions: [
                            ...task.autoDecisions,
                            {
                              id: `${requestId}-${taskNumber}-${task.autoDecisions.length + 1}`,
                              rule: proposal.rule,
                              question: blocker.summary,
                              answer: proposal.answer,
                              evidence: proposal.evidence,
                              undo: proposal.undo,
                              verdicts: review.reviewers.map((item) => ({ model: item.model, verdict: item.verdict ?? "NONE" })),
                              at,
                              reviewedAt: null,
                              reverted: false,
                            },
                          ],
                        }, message),
                  ),
                },
          ),
        },
        result: undefined,
      }));
      await this.channel.flush(paseo, requestId, taskNumber).catch((error: unknown) =>
        console.error(`[coordinator] could not send the reviewed answer for ${requestId}:${taskNumber}; it stays queued`, error),
      );
    } else {
      // 사람 카드로 돌린다. 코디네이터의 제안을 선택지 하나로 두고, 검토자의 우려를 '확인할 것'에 그대로 넣는다.
      // 사람이 읽는 카드 문구는 요청 언어를 따른다. 검토자의 우려 원문은 검토자가 쓴 그대로 둔다.
      const ko = found.request.language === "ko";
      const objections = review.reviewers.flatMap((item, index) => {
        const label = `#${index + 1} ${item.model}`;
        if (!item.verdict) {
          return [ko ? `${label}: ${reason === "timeout" ? "제한 시간 안에 끝내지 못함" : "판정 없음"} (FAIL 로 봄)` : `${label}: ${reason === "timeout" ? "did not finish in time" : "no verdict"} (counts as FAIL)`];
        }
        if (item.verdict === "PASS") return [];
        return item.objections.length ? item.objections.map((text) => `${label} ${item.verdict}: ${text}`) : [`${label}: ${item.verdict}`];
      });
      await this.patchBlocker(requestId, taskNumber, (current) => ({
        ...current,
        objections,
        review: current.review ? { ...current.review, status: "failed" } : current.review,
        coordinator: current.coordinator ?? {
          context: ko
            ? `코디네이터가 ${proposal.rule} 규칙으로 직접 답하려 했지만 독립 검토를 통과하지 못해 사람이 정해야 해요.`
            : `The coordinator proposed answering this under ${proposal.rule}, but the independent review did not pass, so it is your call.`,
          options: [
            {
              label: ko ? "코디네이터 제안대로" : "Coordinator's proposal",
              result: proposal.answer,
              risk: objections.join(" / ") || (ko ? "검토자의 우려를 보세요." : "See the reviewers' concerns."),
              undo: proposal.undo,
              instruction: proposal.answer,
            },
          ],
          recommended: null,
          reasons: proposal.evidence.map((item) => `${item.fact} (${item.source})`),
          rules: [proposal.rule],
          at,
        },
      }));
    }
    for (const reviewer of review.reviewers) {
      await paseo.agents.ref(reviewer.agentId).archive().catch(() => undefined);
    }
    console.log(`[coordinator] review for ${requestId}:${taskNumber} ${passed ? "passed" : "failed"} (${reason})`);
  }

  tools(onAllSubmitted: (paseo: PaseoApi, requestId: string, taskNumber: number) => void) {
    const recordOwn = defineAgentTool({
      name: "reviewer_record_own_answer",
      title: "Record your own answer",
      description: "Record what you would tell the worker, before seeing the coordinator's proposal.",
      input: z.object({ answer: z.string().trim().min(1) }),
      execute: async ({ answer }, { agent }) => {
        const found = await this.findReview(agent.id);
        if (!found?.task.blocker?.proposal) return { text: "There is no review assigned to you.", isError: true };
        await this.patchReviewer(found.request.id, found.task.number, agent.id, (item) => ({ ...item, ownAnswer: item.ownAnswer ?? answer }));
        return { text: revealProposal(found.task.blocker.proposal) };
      },
    });
    const submit = defineAgentTool({
      name: "reviewer_submit_verdict",
      title: "Submit verdict",
      description: "Submit your verdict after recording your own answer and checking the evidence.",
      input: z.object({
        verdict: z.enum(["PASS", "FAIL", "UNSURE"]),
        checks: z.array(z.object({ name: z.enum(CHECKS), pass: z.boolean(), reason: z.string().trim().min(1) })).length(CHECKS.length),
        objections: z.array(z.string().trim().min(1)).default([]),
      }),
      execute: async (input, { agent, paseo }) => {
        const found = await this.findReview(agent.id);
        if (!found) return { text: "There is no review assigned to you.", isError: true };
        if (!found.reviewer.ownAnswer) return { text: "Call reviewer_record_own_answer first.", isError: true };
        if (input.verdict !== "PASS" && input.objections.length === 0) {
          return { text: "FAIL and UNSURE need at least one objection the human should read.", isError: true };
        }
        // 점검표에 하나라도 실패가 있으면 PASS 로 보지 않는다.
        const verdict = input.verdict === "PASS" && input.checks.some((check) => !check.pass) ? "FAIL" : input.verdict;
        await this.patchReviewer(found.request.id, found.task.number, agent.id, (item) => ({
          ...item,
          verdict,
          checks: input.checks,
          objections: input.objections,
          at: new Date().toISOString(),
        }));
        const after = await this.findReview(agent.id);
        const review = after?.task.blocker?.review;
        if (review && review.reviewers.length === review.required && review.reviewers.every((item) => item.verdict)) {
          onAllSubmitted(paseo, found.request.id, found.task.number);
        }
        return { text: "Verdict recorded. You are done; end your turn." };
      },
    });
    return [recordOwn, submit];
  }

  /**
   * 자동 결정 카드. 확인하거나, 되돌리고 지시한다. 되돌리면 워커에게 바로잡는 지시를 보내고,
   * 같은 규칙의 최근 자동 결정 중 되돌린 것이 기준을 넘으면 그 규칙을 끈다 (RULES.md §5 자동 정지).
   */
  async reviewAutoDecision(
    paseo: PaseoApi,
    input: { requestId: string; taskNumber: number; id: string; revertText: string | null },
  ): Promise<void> {
    const found = await this.find(input.requestId, input.taskNumber);
    const decision = found?.task.autoDecisions.find((item) => item.id === input.id);
    if (!found || !decision) throw new Error(say(found?.request.language, "This automatic decision no longer exists.", "이 자동 결정은 더 이상 없어요."));
    const revert = Boolean(input.revertText?.trim());
    const at = new Date().toISOString();
    const revertMessage = `[From the human] The earlier automatic decision is withdrawn: "${decision.answer}"\n${input.revertText}\nUndo what that decision changed if needed (${decision.undo}), then continue with this instruction.`;
    await this.store.update((state) => {
      const requests = state.requests.map((request) =>
        request.id !== input.requestId
          ? request
          : {
              ...request,
              tasks: request.tasks.map((task) =>
                task.number !== input.taskNumber
                  ? task
                  : (() => {
                      const updated = {
                      ...task,
                      autoDecisions: task.autoDecisions.map((item) =>
                        item.id === input.id ? { ...item, reviewedAt: at, reverted: item.reverted || revert } : item,
                      ),
                      decisions: revert
                        ? [...task.decisions, { summary: `Reverted: ${decision.answer} → ${input.revertText}`, by: "human" as const, at, qa: [] }]
                        : task.decisions,
                      // 이미 끝난 작업이면 다시 실행 중으로 돌린다. 예전 완료 보고가 남으면 머지 카드가 바뀌기 전 내용을 보여준다.
                      ...(revert && (task.status === "review" || task.status === "done") && !task.completion?.closedAt
                        ? { status: "running" as const, completion: null, doneNudgedAt: null }
                        : {}),
                    };
                      // 되돌린 지시는 상태 변경과 같은 update 에서 outbox 에 넣는다 (WorkerChannel 설명).
                      return revert ? queued(updated, revertMessage) : updated;
                    })(),
              ),
            },
      );
      const recent = requests
        .flatMap((request) => request.tasks.flatMap((task) => task.autoDecisions))
        .filter((item) => item.rule === decision.rule)
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, AUTO_STOP_WINDOW);
      const reverts = recent.filter((item) => item.reverted).length;
      const disabledRules =
        reverts >= AUTO_STOP_REVERTS && !state.disabledRules.includes(decision.rule)
          ? [...state.disabledRules, decision.rule]
          : state.disabledRules;
      return { state: { ...state, requests, disabledRules }, result: undefined };
    });
    if (revert) {
      await this.channel.flush(paseo, input.requestId, input.taskNumber).catch((error: unknown) =>
        console.error(`[coordinator] could not send the revert for ${input.requestId}:${input.taskNumber}; it stays queued`, error),
      );
    }
  }

  private patchBlocker(
    requestId: string,
    taskNumber: number,
    change: (blocker: NonNullable<Task["blocker"]>) => NonNullable<Task["blocker"]>,
  ): Promise<void> {
    return this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id !== requestId
            ? request
            : {
                ...request,
                tasks: request.tasks.map((task) =>
                  task.number === taskNumber && task.blocker ? { ...task, blocker: change(task.blocker) } : task,
                ),
              },
        ),
      },
      result: undefined,
    }));
  }

  private patchReviewer(
    requestId: string,
    taskNumber: number,
    agentId: string,
    change: (reviewer: NonNullable<NonNullable<Task["blocker"]>["review"]>["reviewers"][number]) => NonNullable<
      NonNullable<Task["blocker"]>["review"]
    >["reviewers"][number],
  ): Promise<void> {
    return this.patchBlocker(requestId, taskNumber, (blocker) =>
      blocker.review
        ? {
            ...blocker,
            review: {
              ...blocker.review,
              reviewers: blocker.review.reviewers.map((item) => (item.agentId === agentId ? change(item) : item)),
            },
          }
        : blocker,
    );
  }
}
