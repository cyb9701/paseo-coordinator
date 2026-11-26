/**
 * 사람이 화면에서 읽는 서버 문구(작업 메모, 카드 버튼의 오류)를 요청 언어로 고른다. 요청 언어는 요청을 만들 때 정해진다.
 * 워커·코디네이터·검토자에게 가는 메시지와 도구 결과는 에이전트가 읽으므로 영어로 둔다.
 */
export function say(language: "en" | "ko" | null | undefined, en: string, ko: string): string {
  return language === "ko" ? ko : en;
}
