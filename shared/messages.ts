import { type Decision, decisionTitle, readAnswer } from "./model";

/**
 * 플러그인이 에이전트에게 보내는 메시지. 에이전트가 읽으므로 화면 언어와 관계없이 영어로 쓰고, 사람이 쓴 말은 그대로 붙인다.
 * 이 메시지는 에이전트 대화에 사람 메시지로 남아 '요청받은 것'에도 보인다. 화면은 readSentMessage 로 알아보고 화면 언어 한 줄로
 * 바꿔 보여 준다. 만드는 함수와 읽는 함수가 같은 형식을 써야 하므로 형식을 바꾸면 함께 바꾼다.
 */

/** 에이전트가 일하는 동안 쌓인 메시지는 쉴 때 이 구분선으로 이어 한 번에 보낸다. */
export const MESSAGE_SEPARATOR = "\n\n---\n\n";

type Listed = Pick<Decision, "number" | "title" | "decision">;

function list(decisions: readonly Listed[]): string {
  return decisions.map((item) => `#${item.number} ${decisionTitle(item)}: ${item.decision}`).join("\n");
}

const ANSWER_HEAD = "The user answered the decisions you stopped on:\n";
const ANSWER_MARK = "\n\nAnswer:\n";
const ANSWER_TAIL = "\n\nContinue with this answer. Do not record these decisions again.";
const REVERT_HEAD = "The user reviewed decisions you made and wants them reverted:\n";
const REVERT_BODY = "\n\nUndo the changes these decisions made and return that part to how it was before.";
const REVERT_NOTE = "\n\nNote from the user:\n";
const REVIEW_TAIL = "\nRecord any new choice this needs with record_decision.";
const REDO_HEAD = "The user reviewed decisions you made and wants them redone differently:\n";
const REDO_MARK = "\n\nDo it this way instead:\n";
const REDO_TAIL = "\n\nChange your work accordingly. Record any new choice this needs with record_decision.";
const REQUEST_HEAD = "An additional request from the user for this workspace:\n\n";
const ASK_HEAD = "Before deciding, the user asks about your stopped decisions:\n";
const ASK_TAIL = "\n\nAnswer this. Do not implement the stopped decisions yet; ask about them again when you have answered.";

export function answerMessage(decisions: readonly Listed[], answer: string): string {
  return `${ANSWER_HEAD}${list(decisions)}${ANSWER_MARK}${answer}${ANSWER_TAIL}`;
}

export function revertMessage(decisions: readonly Listed[], note: string | null): string {
  return `${REVERT_HEAD}${list(decisions)}${REVERT_BODY}${note ? `${REVERT_NOTE}${note}` : ""}${REVIEW_TAIL}`;
}

export function redoMessage(decisions: readonly Listed[], note: string): string {
  return `${REDO_HEAD}${list(decisions)}${REDO_MARK}${note}${REDO_TAIL}`;
}

export function requestMessage(text: string): string {
  return `${REQUEST_HEAD}${text}`;
}

export function askMessage(text: string): string {
  return `${ASK_HEAD}${text}${ASK_TAIL}`;
}

/**
 * '요청받은 것'에 보일 한 덩어리. text 는 사람이 에이전트 대화에 직접 쓴 말이나 알아보지 못한 글이다. 나머지는 플러그인이 보낸
 * 메시지에서 사람이 고르거나 쓴 것만 꺼낸 것이다.
 */
export type SentPart =
  | { kind: "text"; text: string }
  | { kind: "request"; text: string }
  | { kind: "answer"; choices: { number: number; choice: string | null }[]; note: string }
  | { kind: "revert"; numbers: number[]; note: string | null }
  | { kind: "redo"; numbers: number[]; note: string }
  | { kind: "ask"; text: string };

/**
 * 목록의 결정 번호. 목록 줄은 "#번호 제목: 결정 문장"이고 결정 문장은 여러 줄일 수 있다. 그 안의 줄이 "#7 "처럼 시작하면 번호로
 * 잘못 읽히지만, 화면에 보일 한 줄을 고르는 데만 쓰므로 받아들인다. 답은 이 목록이 아니라 한 줄짜리 답 문장에서 번호를 읽는다.
 */
function numbers(listed: string): number[] {
  return [...listed.matchAll(/^#(\d+) /gm)].map((match) => Number(match[1]));
}

function between(text: string, head: string, mark: string, tail: string): [string, string] | null {
  if (!text.startsWith(head) || !text.endsWith(tail)) return null;
  const body = text.slice(head.length, text.length - tail.length);
  const at = body.indexOf(mark);
  return at < 0 ? null : [body.slice(0, at), body.slice(at + mark.length)];
}

function readPart(text: string): SentPart {
  if (text.startsWith(REQUEST_HEAD)) return { kind: "request", text: text.slice(REQUEST_HEAD.length) };
  if (text.startsWith(ASK_HEAD) && text.endsWith(ASK_TAIL)) return { kind: "ask", text: text.slice(ASK_HEAD.length, text.length - ASK_TAIL.length) };
  const answered = between(text, ANSWER_HEAD, ANSWER_MARK, ANSWER_TAIL);
  if (answered) {
    const answer = answered[1];
    // 카드에서 만든 답은 결정마다 한 줄이고 제목도 한 줄이라, 목록보다 답의 윗부분에서 번호를 읽는 편이 정확하다.
    const head = answer.split("\n\n")[0]!;
    const choices = numbers(head).map((number) => {
      const read = readAnswer({ number }, answer);
      return { number, choice: read.kind === "card" ? read.choice : null, note: read.kind === "card" ? read.note : null };
    });
    // 카드가 아닌 곳에서 만든 답이면 고른 것을 알 수 없다. 사람이 쓴 답을 그대로 보인다.
    if (!choices.length || choices.some((item) => item.note === null)) return { kind: "text", text: answer };
    return { kind: "answer", choices: choices.map(({ number, choice }) => ({ number, choice })), note: choices[0]!.note ?? "" };
  }
  if (text.startsWith(REVERT_HEAD) && text.endsWith(REVIEW_TAIL)) {
    const body = text.slice(REVERT_HEAD.length, text.length - REVIEW_TAIL.length);
    const at = body.indexOf(REVERT_BODY);
    if (at >= 0) {
      const rest = body.slice(at + REVERT_BODY.length);
      return { kind: "revert", numbers: numbers(body.slice(0, at)), note: rest.startsWith(REVERT_NOTE) ? rest.slice(REVERT_NOTE.length) : null };
    }
  }
  const redone = between(text, REDO_HEAD, REDO_MARK, REDO_TAIL);
  if (redone) return { kind: "redo", numbers: numbers(redone[0]), note: redone[1] };
  return { kind: "text", text };
}

export function readSentMessage(text: string): SentPart[] {
  return text.split(MESSAGE_SEPARATOR).map(readPart);
}
