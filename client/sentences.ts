/** 문장 끝으로 보지 않는 줄임말. "e.g. foo"를 두 줄로 나누지 않는다. */
const ABBREVIATION = /(?:^|[^\p{L}])(?:e\.g|i\.e|etc|vs|cf|approx)\.$/iu;

/**
 * 줄 맨 앞의 목록 번호("1. 첫째")는 문장 끝이 아니다. 줄 가운데 숫자 뒤의 점은 "gives 1. If", "#23. Matches" 처럼 대개 문장 끝이라
 * 나눈다.
 */
const LIST_NUMBER = /(?:^|\n)[ \t]*\p{N}{1,2}\.$/u;

/**
 * 문장마다 줄을 바꾼다. 에이전트와 요약 모델은 결정, 질문, 요약, 추가 요청을 줄바꿈 없는 한 문단으로 쓴다. 서너 문장이 이어지면 휴대폰
 * 카드에서 벽처럼 보여 읽기 어렵다. 모델에게 줄바꿈을 시키면 이미 쌓인 글에는 적용되지 않고 모델마다 따르는 정도가 달라서 화면에서 나눈다.
 *
 * 마침표·물음표·느낌표 뒤에 띄어쓰기가 올 때만 나눈다. `Catalog.cs`, `v1.2` 처럼 뒤에 바로 글자가 붙으면 문장 끝이 아니다. 백틱 안의
 * 코드와 이미 있는 줄바꿈은 그대로 둔다.
 */
export function breakSentences(text: string): string {
  return text.replace(/`[^`\n]*`|([.!?])(["'”’)\]]*)[ \t]+(?=\S)/g, (match: string, mark: string | undefined, closers: string, offset: number, whole: string) => {
    if (!mark) return match;
    const before = whole.slice(0, offset + 1);
    if (mark === "." && (before.endsWith("..") || LIST_NUMBER.test(before) || ABBREVIATION.test(before))) return match;
    return `${mark}${closers}\n`;
  });
}
