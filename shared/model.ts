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

const qaSchema = z.object({
  question: z.string(),
  answer: z.string().nullable(),
  at: z.string(),
  answeredAt: z.string().nullable().default(null),
  /** 코디네이터에게 알린 시각. */
  notifiedAt: z.string().nullable().default(null),
});

export const AUTO_RULES = ["W1", "W5", "W7"] as const;

export const proposalSchema = z.object({
  rule: z.enum(AUTO_RULES),
  /** 워커에게 그대로 보낼 지시. */
  answer: z.string(),
  evidence: z.array(z.object({ fact: z.string(), source: z.string() })),
  undo: z.string(),
  /** H1~H6 마다 해당하지 않는 이유. */
  selfCheck: z.array(z.string()),
  at: z.string(),
});

export const verdictSchema = z.object({
  agentId: z.string(),
  model: z.string(),
  ownAnswer: z.string().nullable(),
  verdict: z.enum(["PASS", "FAIL", "UNSURE"]).nullable(),
  checks: z.array(z.object({ name: z.string(), pass: z.boolean(), reason: z.string() })).default([]),
  objections: z.array(z.string()).default([]),
  at: z.string().nullable(),
});

export const reviewSchema = z.object({
  status: z.enum(["running", "passed", "failed"]),
  required: z.number().int().positive(),
  startedAt: z.string(),
  deadline: z.string(),
  reviewers: z.array(verdictSchema),
});

/**
 * 워커가 막혀서 보고한 것과, 그에 대한 코디네이터의 판단. 사람이 이것을 보고 결정한다 (4단계).
 * 6단계 전까지는 코디네이터가 직접 답하지 않고 항상 사람 카드로 올린다 (검토자 규칙, RULES.md §5).
 */
export const blockerSchema = z.object({
  kind: z.enum(["question", "change", "stuck"]),
  summary: z.string(),
  facts: z.array(z.string()),
  options: z.array(z.object({ label: z.string(), consequence: z.string() })),
  workerRecommendation: z.string().nullable(),
  at: z.string(),
  /** 코디네이터에게 알린 시각. */
  notifiedAt: z.string().nullable().default(null),
  coordinator: z
    .object({
      context: z.string(),
      options: z.array(
        z.object({ label: z.string(), result: z.string(), risk: z.string(), undo: z.string(), instruction: z.string() }),
      ),
      recommended: z.string().nullable(),
      reasons: z.array(z.string()),
      /** 해당하는 RULES.md 규칙 id (H1, H4, W5 …). */
      rules: z.array(z.string()),
      at: z.string(),
    })
    .nullable()
    .default(null),
  /** 사람이 카드에서 코디네이터에게 물은 것과 그 답. */
  qa: z.array(qaSchema).default([]),
  /** 코디네이터가 W 규칙으로 자동으로 답하려는 제안. 검토자 전원이 통과시켜야 워커에게 간다 (6단계). */
  proposal: proposalSchema.nullable().default(null),
  review: reviewSchema.nullable().default(null),
  /** 검토를 통과하지 못했을 때 검토자들이 남긴 우려. 카드의 '확인할 것'에 그대로 보인다. */
  objections: z.array(z.string()).default([]),
});

/** PR 정보. 플러그인이 gh 로 직접 읽은 값이다. 워커가 쓴 값을 믿지 않는다. */
export const pullRequestSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  /** MERGEABLE, CONFLICTING, UNKNOWN */
  mergeable: z.string(),
  /** 체크 요약. 'passed 3, failed 1, pending 0' 처럼 플러그인이 만든다. 체크가 없으면 null. */
  checks: z.string().nullable(),
  readAt: z.string(),
});

/**
 * 워커의 완료 보고 (7단계). 워커가 report_done 으로 보내고, PR 은 플러그인이 gh 로 확인해서 채운다.
 * 완료 = 검증 통과 + PR 생성 (RULES.md §11). 같은 worktree 를 다음 작업이 이어 쓰면 PR 은 마지막 작업이 만든다.
 */
export const completionSchema = z.object({
  summary: z.string(),
  verification: z.array(z.string()),
  /** 워커가 스스로 고른 되돌릴 수 있는 구현 선택. 사람은 머지 카드에서 본다. */
  choices: z.array(z.object({ choice: z.string(), why: z.string() })),
  left: z.array(z.string()),
  pr: pullRequestSchema.nullable(),
  /** 요청이 커밋·PR 을 하지 말라고 해서 PR 없이 끝낸 이유. 워커가 쓴다. */
  noPrReason: z.string().nullable().default(null),
  /**
   * PR 에 담기지 않은 채 worktree 에 남은 변경 (플러그인이 git 으로 확인). 있으면 확인해도 워크스페이스를 지우지 않는다.
   * 지우면 커밋하지 않은 작업이 사라지기 때문이다.
   */
  unpublished: z.string().nullable().default(null),
  /** 머지 카드에서 사람이 코디네이터에게 물은 것과 그 답. 닫으면 결정 기록으로 옮긴다. */
  qa: z.array(qaSchema).default([]),
  at: z.string(),
  /** 머지했거나(PR 있음) 확인한(PR 없음) 시각. */
  closedAt: z.string().nullable().default(null),
});

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
  blocker: blockerSchema.nullable().default(null),
  /** 워커가 일하는 중이라 아직 보내지 못한 메시지. 워커의 턴이 끝나면 보낸다 (send 는 진행 중인 턴을 끊는다). */
  outbox: z.array(z.object({ text: z.string(), at: z.string() })).default([]),
  /** 이 작업에서 내려진 결정 기록. 관련 결정과 자동 정지(RULES.md §5)에 쓴다. */
  decisions: z
    .array(
      z.object({
        summary: z.string(),
        by: z.enum(["human", "coordinator"]),
        at: z.string(),
        /** 결정 카드에서 사람이 코디네이터에게 물은 것과 답. 카드가 닫혀도 남도록 결정과 함께 옮긴다. */
        qa: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
      }),
    )
    .default([]),
  /** 워커 킥오프에 /poteto-mode 를 붙였는지. 붙이지 못한 이유는 note 에 남긴다. */
  poteto: z.boolean().default(false),
  completion: completionSchema.nullable().default(null),
  /** report_done 없이 턴을 끝낸 워커에게 다시 요청한 시각. 두 번째도 없으면 막힌 것으로 본다. */
  doneNudgedAt: z.string().nullable().default(null),
  /** 검토를 통과해 자동으로 워커에게 간 결정. 사람은 확인 필요의 자동 결정 카드로 본다. */
  autoDecisions: z
    .array(
      z.object({
        id: z.string(),
        rule: z.enum(AUTO_RULES),
        question: z.string(),
        answer: z.string(),
        evidence: z.array(z.object({ fact: z.string(), source: z.string() })),
        undo: z.string(),
        verdicts: z.array(z.object({ model: z.string(), verdict: z.string() })),
        at: z.string(),
        reviewedAt: z.string().nullable(),
        reverted: z.boolean(),
      }),
    )
    .default([]),
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
  /**
   * 이 요청을 맡은 코디네이터 에이전트. 요청마다 새 에이전트를 만들어 context 가 요청 하나에서 끝나게 한다
   * (2026-11-25 사용자 결정: 코디네이터 하나가 계속 쌓이면 context 가 커져 느려지고 판단이 흐려질 수 있다).
   */
  coordinatorAgentId: z.string().nullable().default(null),
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
  /**
   * 코디네이터 워크스페이스. 하나를 두고, 요청마다 그 안에 코디네이터 에이전트를 만든다.
   * agentId 는 요청마다 에이전트를 만들기 전(v3)의 단일 코디네이터다. 읽기만 하고 더는 쓰지 않는다.
   */
  coordinator: z.object({ agentId: z.string().optional(), workspaceId: z.string() }).nullable().default(null),
  /** 자동 정지로 꺼진 W 규칙 (RULES.md §5). 다시 켜는 것은 사람이 한다. */
  disabledRules: z.array(z.enum(AUTO_RULES)).default([]),
});

export type Task = z.infer<typeof taskSchema>;
type CardQa = z.infer<typeof qaSchema>;

/**
 * 지금 열린 카드(워커 질문 카드 또는 머지 카드)의 문답이 어디 있는지. 질문하기는 두 카드에서 같은 길로 코디네이터에게 간다.
 * 막힘이 있으면 워커 질문 카드가 먼저다. 머지 카드는 완료를 보고했고 아직 닫히지 않은 작업이다.
 */
export function openCard(task: Task): "blocker" | "completion" | null {
  if (task.blocker) return "blocker";
  if (task.status === "review" && task.completion && !task.completion.closedAt) return "completion";
  return null;
}

export function cardQa(task: Task): readonly CardQa[] {
  const card = openCard(task);
  return card === "blocker" ? task.blocker!.qa : card === "completion" ? task.completion!.qa : [];
}

export function withCardQa(task: Task, change: (qa: CardQa[]) => CardQa[]): Task {
  const card = openCard(task);
  if (card === "blocker") return { ...task, blocker: { ...task.blocker!, qa: change(task.blocker!.qa) } };
  if (card === "completion") return { ...task, completion: { ...task.completion!, qa: change(task.completion!.qa) } };
  return task;
}
export type Question = z.infer<typeof questionSchema>;
export type Blocker = z.infer<typeof blockerSchema>;
export type CoordinatorRequest = z.infer<typeof requestSchema>;

/**
 * 워커 배정이 시작됐는지. 배정기는 워커를 만들기 전에 작업을 running 으로 먼저 표시하고 agentId 는 킥오프 뒤에 남기므로,
 * agentId 만 보면 워커를 만드는 몇 초 사이를 놓친다. 시작된 요청은 다시 계획하면 안 된다 (같은 작업이 또 배정된다).
 */
export function hasStarted(request: CoordinatorRequest): boolean {
  return request.tasks.some((task) => task.status !== "waiting" || task.workspaceId !== null || task.agentId !== null);
}
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

/** 워커 질문 카드에서 사람이 결정했다. choice 는 코디네이터 선택지 label, 아니면 instruction 에 직접 쓴 지시. */
export const resolveBlockerRpc = defineRpc({
  name: "blockers.resolve",
  input: z.object({
    requestId: z.string(),
    taskNumber: z.number().int().positive(),
    choice: z.string().nullable(),
    instruction: z.string().trim().nullable(),
  }),
  output: z.object({}),
});

/** 카드에서 코디네이터에게 묻는다. 답은 카드의 문답에 쌓인다. 워커는 건드리지 않는다. */
export const askCoordinatorRpc = defineRpc({
  name: "blockers.ask",
  input: z.object({ requestId: z.string(), taskNumber: z.number().int().positive(), question: z.string().trim().min(1) }),
  output: z.object({}),
});

/** 자동 결정 카드에서 확인(revertText 없음) 또는 되돌리고 지시(revertText 있음). */
export const reviewAutoDecisionRpc = defineRpc({
  name: "decisions.review",
  input: z.object({
    requestId: z.string(),
    taskNumber: z.number().int().positive(),
    id: z.string(),
    revertText: z.string().trim().nullable(),
  }),
  output: z.object({}),
});

/** 자동 정지로 꺼진 규칙을 사람이 다시 켠다 (RULES.md §5). */
export const enableRuleRpc = defineRpc({
  name: "rules.enable",
  input: z.object({ rule: z.enum(AUTO_RULES) }),
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

/**
 * PR 머지 카드의 결정 (7단계). merge: PR 이 있으면 squash 머지하고 원격 브랜치와 워크스페이스를 정리한다.
 * PR 이 없는 완료(바뀐 것 없음)는 확인만 한다. revise: 지시를 워커에게 보내고 작업을 다시 실행 중으로 둔다.
 */
export const closeCompletionRpc = defineRpc({
  name: "completions.close",
  input: z.object({
    requestId: z.string(),
    taskNumber: z.number().int().positive(),
    action: z.enum(["merge", "revise"]),
    instruction: z.string().trim().nullable(),
  }),
  output: z.object({}),
});

/**
 * 막힌 작업(워커 질문 카드가 없는 것)을 다시 시작한다. 워커 시작 실패, 턴 에러, report_done 없이 두 번 끝남이 여기 해당한다.
 * 워커가 있으면 지시(없으면 기본 문장)를 보내 이어서 일하게 하고, 워커를 만들지 못했으면 대기로 돌려 다시 배정한다.
 */
export const retryTaskRpc = defineRpc({
  name: "tasks.retry",
  input: z.object({ requestId: z.string(), taskNumber: z.number().int().positive(), instruction: z.string().trim().nullable() }),
  output: z.object({}),
});
