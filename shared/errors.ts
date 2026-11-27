/**
 * 사람이 화면에서 마주칠 수 있는 서버 오류. 오류는 RPC 를 거치며 message 문자열만 남으므로, 문구 끝에 코드를 붙여 두고 화면이 그 코드로
 * 화면 언어 문구를 고른다. 코드가 없는 오류(git, Paseo SDK)는 원문 그대로 보인다.
 */
export const ERROR_CODES = ["agentGone", "noWaitingDecision", "notReviewable", "suggestionClosed", "requestClosed", "requestSent", "noBaseBranch", "agentNotInWorkspace"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const CODE_PATTERN = / ?\[coordinator:(\w+)\]/;

/** 영어 문구는 서버 로그와 코드를 모르는 화면을 위해 남긴다. */
export function codedMessage(code: ErrorCode, message: string): string {
  return `${message} [coordinator:${code}]`;
}

export class CoordinatorError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(codedMessage(code, message));
  }
}

/** 오류나 오류 문구에서 코드와 코드를 뺀 문구를 꺼낸다. 호스트가 문구 앞에 무언가를 덧붙여도 찾도록 끝에 고정하지 않는다. */
export function readError(error: unknown): { code: ErrorCode | null; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  const found = CODE_PATTERN.exec(text);
  const code = found && (ERROR_CODES as readonly string[]).includes(found[1]!) ? (found[1] as ErrorCode) : null;
  return { code, message: text.replace(CODE_PATTERN, "") };
}
