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
  /** 한 줄 제목. 사람이 여러 결정을 한 줄씩 훑어볼 수 있어야 해서 따로 받는다. 자세한 내용은 decision 에 쓴다. */
  title: text(100),
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
 * approved: 사람이 확인했다(그대로 둔다).
 * revert: 사람이 되돌리라고 했다. 그 결정으로 바뀐 것을 원래대로 돌린다.
 * undo: 사람이 바꿔서 다시 하라고 했다. 사람이 쓴 방식으로 다시 한다.
 * dropped: 답하기 전에 에이전트나 워크스페이스가 archive 됐다. 받을 곳이 없어 내린다.
 */
export const DECISION_STATUSES = ["waiting", "answered", "unreviewed", "approved", "revert", "undo", "dropped"] as const;
/** 사람이 확인할 수 있는 상태. 멈춘 결정은 답으로 처리하고, 이미 확인한 결정은 다시 바꿀 수 있다. */
export const REVIEWABLE_STATUSES: readonly (typeof DECISION_STATUSES)[number][] = ["unreviewed", "approved", "revert", "undo"];

export const decisionSchema = decisionInputSchema.extend({
  /** 제목을 받기 전에 기록된 결정에는 없다. 화면은 decisionTitle 로 결정 문장의 앞부분을 대신 쓴다. */
  title: z.string().default(""),
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

/**
 * 워크스페이스 추가 요청.
 * queued: 사람이 쓴 요청. 그 워크스페이스의 에이전트가 쉬면 순서대로 받는다. 받기 전에는 취소할 수 있다.
 * sent: 에이전트에게 보냈다.
 * suggested: 에이전트가 add_followup 으로 남긴 범위 밖의 일. 사람이 보내기를 누르면 queued 가 된다.
 * dismissed: 사람이 취소하거나 버렸다.
 */
export const REQUEST_STATUSES = ["queued", "sent", "suggested", "dismissed"] as const;

export const requestSchema = z.object({
  id: z.string(),
  text: z.string(),
  projectId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  /** 받을 에이전트(사람의 요청) 또는 남긴 에이전트(제안). */
  agentId: z.string().nullable(),
  source: z.enum(["agent", "human"]),
  status: z.enum(REQUEST_STATUSES),
  at: z.string(),
  sentAt: z.string().nullable().default(null),
  callId: z.string().nullable().default(null),
});
export type WorkRequest = z.output<typeof requestSchema>;

/** 멈춘 결정 카드의 '질문하기'. 결정하기 전에 에이전트에게 묻고, 에이전트의 다음 응답을 답으로 붙인다. */
export const askSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  at: z.string(),
  answer: z.string().nullable().default(null),
  answeredAt: z.string().nullable().default(null),
});
export type Ask = z.output<typeof askSchema>;

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

/**
 * 코디네이터가 세션 대화를 읽고 남긴 판정. 세션마다 하나다. 사람이 다이제스트를 요청할 때만 코디네이터가 만든다.
 * question: 사람이 정하거나 답할 일이 있다. 한 문장 질문과 바로 보낼 수 있는 추천 답장(또는 부족한 정보)을 쓴다.
 * review: 사람이 확인할 결과가 있다(일을 마쳤다는 보고, 근거를 봐야 하는 결과).
 * idle: 사람이 할 일이 없다. 화면에는 보이지 않고, 다음 다이제스트에서 같은 대화를 다시 판정하지 않게 남긴다.
 * evidenceId 는 판정할 때 읽은 대화의 지문이다. 대화가 바뀐 뒤에 쓴 판정은 받지 않는다.
 */
export const JUDGMENT_KINDS = ["question", "review", "idle"] as const;

export const judgmentInputSchema = z.object({
  kind: z.enum(JUDGMENT_KINDS),
  /** 사람이 정할 것 한 문장. question 에만. */
  question: text(400).nullable().default(null),
  /** 고쳐서 바로 보낼 수 있는 완성된 답장. 근거가 있을 때만. */
  recommendation: text(2000).nullable().default(null),
  /** 추천 답장의 근거. 짧게. */
  reason: text(800).nullable().default(null),
  /** 추천할 근거가 부족하면 사람이 채워야 할 정보. */
  needsInput: text(600).nullable().default(null),
  /** review 에서 사람이 확인할 것. */
  check: text(800).nullable().default(null),
  /** 고를 수 있는 짧은 선택지. 사람이 누르면 답장 칸에 들어간다. */
  options: z.array(text(200)).max(4).default([]),
});

export const judgmentSchema = judgmentInputSchema.extend({
  agentId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  evidenceId: z.string(),
  at: z.string(),
});
export type Judgment = z.output<typeof judgmentSchema>;

/** 코디네이터가 사람이 요청한 다이제스트 동안 에이전트의 사실 질문에 대신 답한 기록. 사람이 무엇이 오갔는지 볼 수 있게 남긴다. */
export const factAnswerSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  answer: z.string(),
  cycleId: z.string(),
  at: z.string(),
});
export type FactAnswer = z.output<typeof factAnswerSchema>;

/**
 * 에이전트가 report_work 로 남긴 작업 보고. 일을 마쳤거나 더 갈 수 없을 때 한 번 쓴다.
 * 코디네이터가 다이제스트에서 대화와 대조해 verified(근거 확인, 닫음) 또는 needsPerson(사람이 봐야 함)으로 검토한다.
 * 검토하지 않았거나 needsPerson 인 보고는 사람이 확인할 때까지 인박스 '확인 필요'에 남는다.
 */
export const REPORT_STATUSES = ["done", "blocked"] as const;

export const reportInputSchema = z.object({
  status: z.enum(REPORT_STATUSES),
  summary: text(1500),
  evidence: z.array(evidenceSchema).min(1).max(10),
  files: z.array(text(500)).max(60).default([]),
});

export const reportSchema = reportInputSchema.extend({
  id: z.string(),
  agentId: z.string(),
  workspaceId: z.string(),
  projectId: z.string().nullable(),
  at: z.string(),
  review: z.object({ verdict: z.enum(["verified", "needsPerson"]), note: z.string().nullable(), at: z.string() }).nullable().default(null),
  /** 코디네이터가 verified 로 닫았거나 사람이 확인했다. */
  closed: z.boolean().default(false),
  callId: z.string().nullable().default(null),
});
export type Report = z.output<typeof reportSchema>;

/** 상주 코디네이터. 워크스페이스는 요약 에이전트도 쓰므로 코디네이터 세션보다 먼저 생길 수 있다. */
export const coordinatorSchema = z.object({
  workspaceId: z.string().nullable().default(null),
  agentId: z.string().nullable().default(null),
});

/** 사람이 누른 다이제스트. 사실 질문 대답은 이 주기 안에서만 받는다. 코디네이터가 스스로 에이전트에게 말을 걸지 못하게 하기 위해서다. */
export const digestSchema = z.object({ cycleId: z.string(), at: z.string(), agentId: z.string() });
export type Digest = z.output<typeof digestSchema>;

/** requestId 가 있으면 추가 요청이다. 보내면 그 요청이 sent 가 되고, 받기 전에 취소하면 여기서 뺀다. */
export const outboxMessageSchema = z.object({ text: z.string(), at: z.string(), requestId: z.string().nullable().default(null) });

export const stateSchema = z.object({
  version: z.literal(1),
  seq: z.number().int().default(0),
  decisions: z.array(decisionSchema).default([]),
  requests: z.array(requestSchema).default([]),
  asks: z.array(askSchema).default([]),
  summaries: z.array(summarySchema).default([]),
  /** agentId → 보낼 메시지. 에이전트가 일하는 중에 보내면 턴이 끊겨서, 쉴 때만 내보낸다. */
  outbox: z.record(z.string(), z.array(outboxMessageSchema)).default({}),
  /**
   * 마지막으로 화면이 알려 준 앱 언어. 서버는 화면이 구독할 때에야 앱 언어를 안다. 메모리에만 두면 플러그인이 다시 시작된 뒤 화면이
   * 다시 구독하기 전까지 언어를 몰라, 앱을 닫아 둔 동안 만든 요약이 영어가 된다.
   */
  appLanguage: z.enum(["en", "ko"]).nullable().default(null),
  coordinator: coordinatorSchema.default({ workspaceId: null, agentId: null }),
  judgments: z.array(judgmentSchema).default([]),
  facts: z.array(factAnswerSchema).default([]),
  reports: z.array(reportSchema).default([]),
  digest: digestSchema.nullable().default(null),
});
export type CoordinatorState = z.output<typeof stateSchema>;

export const EMPTY_STATE: CoordinatorState = {
  version: 1,
  seq: 0,
  decisions: [],
  requests: [],
  asks: [],
  summaries: [],
  outbox: {},
  appLanguage: null,
  coordinator: { workspaceId: null, agentId: null },
  judgments: [],
  facts: [],
  reports: [],
  digest: null,
};

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

/**
 * 진행한 결정을 확인한다. approved 는 그대로 둔다. revert 는 되돌리라고 보내고(text 는 덧붙일 말, 없어도 된다),
 * undo 는 text 로 쓴 방식으로 바꿔서 다시 하라고 보낸다(text 필요).
 */
export const reviewDecisionsRpc = defineRpc({
  name: "decisions.review",
  input: z.object({
    decisionIds: z.array(z.string()).min(1),
    verdict: z.enum(["approved", "revert", "undo"]),
    text: z.string().trim().nullable().default(null),
  }),
  output: z.object({ delivery: z.enum(["sent", "queued", "none"]) }),
});

/** 멈춘 결정 카드의 '질문하기'. 에이전트가 질문 창으로 물은 중이면 그 질문 창에 이 질문을 돌려보낸다. */
export const askAgentRpc = defineRpc({
  name: "agents.ask",
  input: z.object({ agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({}),
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

/** 워크스페이스에 추가 요청을 넣는다. 받을 에이전트가 쉬면 바로, 일하는 중이면 턴이 끝난 뒤 받는다. */
export const addRequestRpc = defineRpc({
  name: "requests.add",
  input: z.object({ workspaceId: z.string(), agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 제안을 보낸다(queued 로). 받을 에이전트는 사람이 고른다. */
export const sendSuggestionRpc = defineRpc({
  name: "requests.send-suggestion",
  input: z.object({ id: z.string(), agentId: z.string() }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 아직 받지 않은 요청을 취소하거나 제안을 버린다. */
export const dismissRequestRpc = defineRpc({
  name: "requests.dismiss",
  input: z.object({ id: z.string() }),
  output: z.object({}),
});

/**
 * 다이제스트를 요청한다. 코디네이터가 관리 세션을 읽고 판정하고, 사실 질문에 답하고, 보고를 검토한다. 사람이 누를 때만 돈다.
 * 코디네이터 세션이 없으면 이때 만든다. 코디네이터가 일하는 중이면 그 턴이 끝난 뒤 받는다.
 */
export const coordinatorDigestRpc = defineRpc({
  name: "coordinator.digest",
  input: z.object({ language }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 코디네이터에게 사람이 쓴 말을 보낸다. 세션이 없으면 이때 만든다. */
export const coordinatorSendRpc = defineRpc({
  name: "coordinator.send",
  input: z.object({ text: z.string().trim().min(1) }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 판정 카드에서 사람이 쓴(또는 추천을 고친) 답장을 그 에이전트에게 보낸다. 보내면 판정은 내린다. */
export const judgmentReplyRpc = defineRpc({
  name: "judgments.reply",
  input: z.object({ agentId: z.string(), text: z.string().trim().min(1) }),
  output: z.object({ delivery: z.enum(["sent", "queued"]) }),
});

/** 판정 카드를 내린다. 답장 없이 확인만 했거나 판정이 틀렸을 때. */
export const judgmentDismissRpc = defineRpc({
  name: "judgments.dismiss",
  input: z.object({ agentId: z.string() }),
  output: z.object({}),
});

/** 보고를 확인했다고 닫는다. */
export const reportCloseRpc = defineRpc({
  name: "reports.close",
  input: z.object({ id: z.string() }),
  output: z.object({}),
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

/** 질문 창에서 답했는데 답 내용이 비어 있을 때 남기는 답. 화면은 이 값을 알아보고 화면 언어로 바꿔 보여 준다. */
export const ANSWERED_IN_QUESTION_WINDOW = "(answered in the question window)";
/** 플러그인이 다시 시작한 뒤, 에이전트 대화에서 이미 답한 결정에 남기는 답. */
export const ANSWERED_IN_CONVERSATION = "(answered in the agent's conversation)";

const PROPOSED_SUFFIX = ": go ahead as you proposed.";
const CHOSEN_PATTERN = /: use "(.*)" instead of your proposal\.$/s;

/**
 * 카드에서 보내는 답. 에이전트가 읽으므로 영어로 쓰고, 같은 글이 멈춘 결정마다 reply 로 남는다. 화면은 readAnswer 로 이 글을 다시
 * 읽어 화면 언어로 보여 준다. 두 함수가 같은 형식을 써야 하므로 형식을 바꾸면 함께 바꾼다.
 */
export function composeAnswer(decisions: readonly Pick<Decision, "id" | "number" | "title" | "decision">[], choices: Record<string, string | null>, note: string): string {
  const lines = decisions.map((item) => {
    const choice = choices[item.id];
    return choice ? `#${item.number} ${decisionTitle(item)}: use "${choice}" instead of your proposal.` : `#${item.number} ${decisionTitle(item)}${PROPOSED_SUFFIX}`;
  });
  return note.trim() ? `${lines.join("\n")}\n\n${note.trim()}` : lines.join("\n");
}

/**
 * 결정에 남은 답을 화면에 보일 모양으로 읽는다. card 는 카드에서 보낸 답이고, choice 가 null 이면 제안대로다. 질문 창의 "질문: 답"이나
 * 형식을 알아볼 수 없는 글은 text 로 그대로 돌려준다.
 */
export type ReadAnswer =
  | { kind: "card"; choice: string | null; note: string }
  | { kind: "questionWindow" }
  | { kind: "conversation" }
  | { kind: "text"; text: string };

export function readAnswer(decision: Pick<Decision, "number">, text: string): ReadAnswer {
  if (text === ANSWERED_IN_QUESTION_WINDOW) return { kind: "questionWindow" };
  if (text === ANSWERED_IN_CONVERSATION) return { kind: "conversation" };
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const note = split < 0 ? "" : text.slice(split + 2).trim();
  const line = head.split("\n").find((item) => item.startsWith(`#${decision.number} `));
  if (!line) return { kind: "text", text };
  if (line.endsWith(PROPOSED_SUFFIX)) return { kind: "card", choice: null, note };
  const chosen = CHOSEN_PATTERN.exec(line);
  return chosen ? { kind: "card", choice: chosen[1]!, note } : { kind: "text", text };
}

/** 결정의 한 줄 제목. 제목이 없던 결정은 결정 문장의 첫 줄을 줄여 쓴다. */
export function decisionTitle(decision: Pick<Decision, "title" | "decision">): string {
  if (decision.title.trim()) return decision.title.trim();
  const first = decision.decision.split("\n")[0]!.trim();
  return first.length > 90 ? `${first.slice(0, 88)}…` : first;
}

/** 화면에 보일 판정. idle 은 사람이 할 일이 없어서 뺀다. */
export function visibleJudgments(state: CoordinatorState, kind: "question" | "review"): Judgment[] {
  return state.judgments.filter((item) => item.kind === kind);
}

/** 사람이 확인할 보고: 닫히지 않은 것. 코디네이터가 verified 로 검토한 보고는 닫혀서 빠진다. */
export function openReports(state: CoordinatorState): Report[] {
  return state.reports.filter((item) => !item.closed);
}
