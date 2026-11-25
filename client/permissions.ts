import type { usePaseo } from "@getpaseo/plugin/client";

// SDK 가 권한 요청 타입을 따로 내보내지 않아서, 플러그인이 받는 Paseo API 의 타입에서 끌어온다.
// 이렇게 하면 SDK 버전이 바뀌어도 타입이 그 버전의 실제 모양을 따른다.
type PaseoApi = ReturnType<typeof usePaseo>;
export type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
export type PermissionRequest = NonNullable<AgentHandle["pendingPermissions"]>[number];
export type PermissionResponse = Parameters<AgentHandle["respondToPermission"]>[0]["response"];
export type PermissionAction = NonNullable<PermissionRequest["actions"]>[number];

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export const KIND_LABELS: Record<PermissionRequest["kind"], string> = {
  tool: "권한 요청",
  plan: "계획 승인",
  question: "질문",
  mode: "모드 변경",
  other: "요청",
};

/** 카드 맨 위 '결정할 것' 한 문장. 무엇에 답해야 하는지 바로 보이게 한다. */
export function decisionPrompt(request: PermissionRequest): string {
  switch (request.kind) {
    case "tool":
      return `${request.title ?? request.name} 실행을 허용할까요?`;
    case "plan":
      return "이 계획대로 구현을 시작할까요?";
    case "question":
      return "에이전트가 답을 기다려요.";
    case "mode":
      return request.title ?? "모드를 바꿀까요?";
    default:
      return request.title ?? `${request.name} 요청을 처리해 주세요.`;
  }
}

/** 도구 권한 요청에서 사람이 판단해야 할 원문. 셸 명령이면 명령 그대로, 아니면 입력값을 줄 단위로. */
export function toolFacts(request: PermissionRequest): { command: string | null; inputs: [string, string][] } {
  const detail = request.detail as { type?: string; command?: string } | undefined;
  const input = (request.input ?? {}) as Record<string, unknown>;
  const command =
    detail?.type === "shell" && typeof detail.command === "string"
      ? detail.command
      : typeof input.command === "string"
        ? input.command
        : null;
  const inputs = Object.entries(input)
    .filter(([key]) => key !== "command" && key !== "description")
    .map(([key, value]): [string, string] => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  return { command, inputs };
}

export function planText(request: PermissionRequest): string | null {
  const metadata = (request.metadata ?? {}) as Record<string, unknown>;
  const input = (request.input ?? {}) as Record<string, unknown>;
  if (typeof metadata.planText === "string") return metadata.planText;
  if (typeof input.plan === "string") return input.plan;
  return null;
}

export function questionItems(request: PermissionRequest): QuestionItem[] {
  const input = (request.input ?? {}) as { questions?: unknown };
  if (!Array.isArray(input.questions)) return [];
  return input.questions.flatMap((raw): QuestionItem[] => {
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string") return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o): QuestionOption[] => {
          const option = o as Record<string, unknown>;
          return typeof option.label === "string"
            ? [{ label: option.label, description: typeof option.description === "string" ? option.description : undefined }]
            : [];
        })
      : [];
    return [
      {
        question: q.question,
        header: typeof q.header === "string" ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true,
        allowOther: q.allowOther !== false,
      },
    ];
  });
}

/**
 * 질문 답변. 0단계에서 실행으로 확인한 형식이다 (RULES.md §13).
 * answers 의 키는 질문 원문, 값은 고른 선택지 label 이다. 여러 개를 고르면 ", " 로 잇고, 직접 쓴 답은 끝에 붙인다.
 */
export function questionResponse(
  items: QuestionItem[],
  selected: Record<string, string[]>,
  typed: Record<string, string>,
): PermissionResponse {
  const answers: Record<string, string> = {};
  for (const item of items) {
    const parts = [...(selected[item.question] ?? [])];
    const other = typed[item.question]?.trim();
    if (other) parts.push(other);
    answers[item.question] = parts.join(", ");
  }
  return { behavior: "allow", updatedInput: { answers } };
}

export function isQuestionAnswered(item: QuestionItem, selected: Record<string, string[]>, typed: Record<string, string>) {
  return (selected[item.question]?.length ?? 0) > 0 || Boolean(typed[item.question]?.trim());
}

/** 요청이 직접 내놓은 동작(계획 승인의 implement/reject 등). 없으면 허용/거절 기본 동작을 쓴다. */
export function requestActions(request: PermissionRequest): PermissionAction[] {
  if (request.actions && request.actions.length > 0) return request.actions;
  return [
    { id: "allow", label: "허용", behavior: "allow", variant: "primary" },
    { id: "deny", label: "거절", behavior: "deny", variant: "secondary" },
  ];
}

export function actionResponse(request: PermissionRequest, action: PermissionAction, message?: string): PermissionResponse {
  const explicit = Boolean(request.actions && request.actions.length > 0);
  if (action.behavior === "allow") {
    return explicit ? { behavior: "allow", selectedActionId: action.id } : { behavior: "allow" };
  }
  return {
    behavior: "deny",
    ...(explicit ? { selectedActionId: action.id } : {}),
    message: message?.trim() || "사용자가 거절했습니다.",
  };
}

/** 직접 지시: 요청을 거절하면서 사람이 쓴 지시를 에이전트에게 그대로 전한다. */
export function instructionResponse(request: PermissionRequest, text: string): PermissionResponse {
  const deny = requestActions(request).find((action) => action.behavior === "deny");
  const explicit = Boolean(request.actions && request.actions.length > 0);
  return {
    behavior: "deny",
    ...(explicit && deny ? { selectedActionId: deny.id } : {}),
    message: text.trim(),
  };
}
