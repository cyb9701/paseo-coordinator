import type { AgentHandle } from "./permissions";

type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;

/** 실행 중인 에이전트는 lastActivityAt 이 계속 바뀐다. 바뀔 때마다 timeline 을 다시 읽지 않도록 30초 단위로 묶는다. */
export function previewBucket(lastActivityAt: string, running: boolean): string {
  if (!running) return lastActivityAt;
  return String(Math.floor(Date.parse(lastActivityAt) / 30_000));
}

/** 카드 본문에 보일 마지막 어시스턴트 응답 한 줄. 읽지 못한 페이지는 미리보기 없음으로 본다. */
export function lastAssistantText(page: Pick<TimelinePage, "entries" | "error">): string | null {
  if (page.error) return null;
  for (let index = page.entries.length - 1; index >= 0; index -= 1) {
    const item = page.entries[index]!.item;
    if (item.type === "assistant_message" && item.text.trim()) return item.text.replace(/\s+/g, " ").trim();
  }
  return null;
}
