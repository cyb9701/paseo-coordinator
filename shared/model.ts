import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 에이전트가 record_decision 으로 남기는 결정의 종류.
 * scope·data·api·ux 는 사람이 정한다(멈춤). dependency·approach 는 기록하고 진행해서 나중에 확인한다.
 */
export const DECISION_KINDS = ["scope", "data", "api", "ux", "dependency", "approach"] as const;
export const STOP_KINDS: readonly (typeof DECISION_KINDS)[number][] = ["scope", "data", "api", "ux"];
export const REVERSIBILITY = ["easy", "costly", "irreversible"] as const;

/**
 * 길이 상한. 결정은 상태 파일에 남고 요약 프롬프트에 그대로 들어간다. 사람이 카드에서 읽을 분량을 넘으면 도구가 거절해
 * 에이전트가 줄여 쓰게 한다.
 */
const text = (max: number) => z.string().trim().min(1).max(max);

export const evidenceSchema = z.object({
  /** verified 는 에이전트가 직접 확인한 것(파일:줄, 명령과 출력, 문서), assumption 은 확인하지 않고 믿는 것. */
  basis: z.enum(["verified", "assumption"]),
  text: text(1000),
});

export const decisionInputSchema = z.object({
  decision: text(1500),
  kind: z.enum(DECISION_KINDS),
  why: text(1500),
  alternatives: z.array(z.object({ option: text(500), whyNot: text(800) })).max(6).default([]),
  evidence: z.array(evidenceSchema).min(1).max(10),
  /** 가정이 틀리면 이 선택도 바뀌는지. 가정이 하나 있어도 선택과 상관없으면 false 다. */
  restsOnAssumption: z.boolean(),
  reversible: z.enum(REVERSIBILITY),
  files: z.array(text(500)).max(60).default([]),
});
export type DecisionInput = z.output<typeof decisionInputSchema>;

/**
 * waiting: 멈춘 결정. 사람의 답을 기다린다.
 * answered: 사람이 답해서 에이전트에게 보냈다(또는 보낼 차례다).
 * unreviewed: 기록하고 진행한 결정. 사람이 아직 확인하지 않았다.
 * approved: 사람이 확인했다. undo: 사람이 되돌리라고 지시했다.
 * dropped: 답하기 전에 에이전트가 archive 됐다. 받을 에이전트가 없어 카드에서 내린다.
 */
export const DECISION_STATUSES = ["waiting", "answered", "unreviewed", "approved", "undo", "dropped"] as const;

export const decisionSchema = decisionInputSchema.extend({
  id: z.string(),
  number: z.number().int(),
  agentId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  at: z.string(),
  stop: z.boolean(),
  status: z.enum(DECISION_STATUSES),
  /** 사람이 쓴 답이나 되돌리기 지시. */
  reply: z.object({ text: z.string(), at: z.string() }).nullable().default(null),
  /** 도구 호출 id. 플러그인 재시작으로 실패한 호출을 턴 끝에 다시 기록할 때 두 번 기록하지 않게 한다. */
  callId: z.string().nullable().default(null),
});
export type Decision = z.output<typeof decisionSchema>;

export const followupSchema = z.object({
  id: z.string(),
  text: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  agentId: z.string().nullable(),
  source: z.enum(["agent", "human"]),
  at: z.string(),
  status: z.enum(["open", "done", "dismissed"]),
  /** 사람이 이 일을 넘긴 에이전트. */
  sentTo: z.string().nullable().default(null),
  callId: z.string().nullable().default(null),
});
export type Followup = z.output<typeof followupSchema>;

export const summaryResultSchema = z.object({
  /** 여기까지 오게 된 앞 상황: 요청, 지금까지 한 일, 관련된 앞선 결정. */
  before: z.string(),
  /** 지금 사람이 정하거나 확인할 것. 한두 문장. */
  ask: z.string(),
  /** 답에 따라 뒤에 일어날 일. */
  after: z.array(z.string()).default([]),
  /** 놓치면 안 되는 것: 확인하지 않은 가정, 다른 워크스페이스와 겹침 등. */
  watchOut: z.array(z.string()).default([]),
});
export type SummaryResult = z.output<typeof summaryResultSchema>;

export const summarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  trigger: z.enum(["decision", "error", "manual"]),
  decisionIds: z.array(z.string()).default([]),
  status: z.enum(["running", "done", "failed"]),
  at: z.string(),
  result: summaryResultSchema.nullable().default(null),
  error: z.string().nullable().default(null),
});
export type Summary = z.output<typeof summarySchema>;

export const outboxMessageSchema = z.object({ text: z.string(), at: z.string() });

export const stateSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().default(0),
  decisions: z.array(decisionSchema).default([]),
  followups: z.array(followupSchema).default([]),
  summaries: z.array(summarySchema).default([]),
  /** agentId → 보낼 메시지. 에이전트가 일하는 중에 보내면 턴이 끊겨서, 쉴 때만 내보낸다. */
  outbox: z.record(z.string(), z.array(outboxMessageSchema)).default({}),
});
export type CoordinatorState = z.output<typeof stateSchema>;

export const EMPTY_STATE: CoordinatorState = { version: 1, seq: 0, decisions: [], followups: [], summaries: [], outbox: {} };

const language = z.enum(["en", "ko"]);

export const watchStateSubscription = defineSubscription({
  name: "state.watch",
  input: z.object({ language }),
  event: stateSchema,
});

/** 멈춘 결정에 답한다. 같은 에이전트의 멈춘 결정을 한 번에 답한다. 에이전트는 그 답을 한 메시지로 받는다. */
export const answerDecisionsRpc = defineRpc({
  name: "decisions.answer",
  input: z.object({ agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 진행한 결정을 확인한다. undo 면 text 를 되돌리기 지시로 에이전트에게 보낸다. */
export const reviewDecisionsRpc = defineRpc({
  name: "decisions.review",
  input: z.object({
    decisionIds: z.array(z.string()).min(1),
    verdict: z.enum(["approved", "undo"]),
    text: z.string().trim().nullable().default(null),
  }),
  output: z.object({ delivery: z.enum(["sent", "queued", "none"]) }),
});

export const sendInstructionRpc = defineRpc({
  name: "agents.instruct",
  input: z.object({ agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

export const summarizeRpc = defineRpc({
  name: "summaries.request",
  input: z.object({ agentId: z.string(), language }),
  output: z.object({}),
});

export const addFollowupRpc = defineRpc({
  name: "followups.add",
  input: z.object({ text: z.string().trim().min(1), projectId: z.string().nullable(), workspaceId: z.string().nullable() }),
  output: z.object({}),
});

export const updateFollowupRpc = defineRpc({
  name: "followups.update",
  input: z.object({ id: z.string(), status: z.enum(["open", "done", "dismissed"]) }),
  output: z.object({}),
});

export const sendFollowupRpc = defineRpc({
  name: "followups.send",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

export const pullRequestSchema = z.object({
  number: z.number().nullable(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  isMerged: z.boolean(),
  isDraft: z.boolean(),
  mergeable: z.enum(["UNKNOWN", "MERGEABLE", "CONFLICTING"]).nullable(),
  checks: z.enum(["success", "pending", "none", "failure"]).nullable(),
  failedChecks: z.array(z.string()),
  reviewDecision: z.enum(["pending", "approved", "changes_requested"]).nullable(),
});
export type PullRequest = z.output<typeof pullRequestSchema>;

export const workspaceStatusSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  branch: z.string().nullable(),
  /** 기준과 비교한 대상. 없으면 git 이 아니거나 기준을 찾지 못했다. */
  base: z.string().nullable(),
  changedFiles: z.array(z.string()),
  pullRequest: pullRequestSchema.nullable(),
  /** 같은 프로젝트의 다른 워크스페이스와 같이 고친 파일. */
  overlaps: z.array(z.object({ workspaceId: z.string(), files: z.array(z.string()) })),
  error: z.string().nullable(),
});
export type WorkspaceStatus = z.output<typeof workspaceStatusSchema>;

/** 워크스페이스마다 바뀐 파일, PR, 다른 워크스페이스와 겹침. git 과 Paseo 만 읽고 모델을 부르지 않는다. */
export const workspaceStatusRpc = defineRpc({
  name: "workspaces.status",
  /** force 는 사람이 새로 읽기를 눌렀을 때다. 서버 캐시를 건너뛴다. */
  input: z.object({ force: z.boolean().default(false) }),
  output: z.object({ workspaces: z.array(workspaceStatusSchema), at: z.string() }),
});

/** 한 워크스페이스의 파일 diff. 결정마다 고친 파일을 보여 준다. */
export const fileDiffRpc = defineRpc({
  name: "workspaces.diff",
  input: z.object({ workspaceId: z.string(), files: z.array(z.string()).min(1).max(40) }),
  output: z.object({ files: z.array(z.object({ path: z.string(), diff: z.string(), truncated: z.boolean() })), base: z.string().nullable() }),
});

/** 에이전트가 받은 사람의 메시지. 결정의 앞 상황(무엇을 요청받았는지)을 보여 준다. */
export const agentRequestsRpc = defineRpc({
  name: "agents.requests",
  input: z.object({ agentId: z.string() }),
  output: z.object({ messages: z.array(z.object({ text: z.string(), at: z.string().nullable() })) }),
});

export function openDecisions(state: CoordinatorState, agentId?: string): Decision[] {
  return state.decisions.filter((item) => item.status === "waiting" && (!agentId || item.agentId === agentId));
}

export function unreviewedDecisions(state: CoordinatorState, workspaceId?: string): Decision[] {
  return state.decisions.filter((item) => item.status === "unreviewed" && (!workspaceId || item.workspaceId === workspaceId));
}

export function latestSummary(state: CoordinatorState, agentId: string): Summary | null {
  for (let index = state.summaries.length - 1; index >= 0; index -= 1) {
    const item = state.summaries[index]!;
    if (item.agentId === agentId) return item;
  }
  return null;
}
