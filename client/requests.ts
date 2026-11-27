import type { WorkRequest } from "../shared/model";

/**
 * 요청을 받을 에이전트. 사람이 고른 에이전트가 아직 그 워크스페이스의 목록에 있으면 그것, 아니면 요청에 적힌 에이전트, 그것도 없으면
 * 가장 최근에 일한 에이전트다. 목록에 없는 에이전트(닫혔거나 다른 워크스페이스로 고른 채 남은 값)는 고르지 않는다.
 */
export function pickRecipient(available: readonly string[], chosen: string | null, preferred: string | null = null): string | null {
  if (chosen && available.includes(chosen)) return chosen;
  if (preferred && available.includes(preferred)) return preferred;
  return available[0] ?? null;
}

/** 요청 탭의 워크스페이스 묶음. 버린 요청과 워크스페이스가 없는 요청은 빼고, 아직 열린 요청이 있는 워크스페이스가 먼저 온다. */
export function requestsByWorkspace(requests: readonly WorkRequest[]): [string, WorkRequest[]][] {
  const groups = new Map<string, WorkRequest[]>();
  for (const item of requests) {
    if (item.status === "dismissed" || !item.workspaceId) continue;
    groups.set(item.workspaceId, [...(groups.get(item.workspaceId) ?? []), item]);
  }
  const hasOpen = (items: readonly WorkRequest[]) => items.some((item) => item.status !== "sent");
  return [...groups.entries()].sort((a, b) => Number(hasOpen(b[1])) - Number(hasOpen(a[1])));
}

export function isOpenRequest(item: Pick<WorkRequest, "status">): boolean {
  return item.status === "queued" || item.status === "suggested";
}

/** 진행 현황 행 머리에 붙는 워크스페이스별 열린 요청 수. */
export function openRequestCounts(requests: readonly WorkRequest[]): Map<string, { queued: number; suggested: number }> {
  const counts = new Map<string, { queued: number; suggested: number }>();
  for (const item of requests) {
    if (!item.workspaceId || !isOpenRequest(item)) continue;
    const current = counts.get(item.workspaceId) ?? { queued: 0, suggested: 0 };
    if (item.status === "queued") current.queued += 1;
    else current.suggested += 1;
    counts.set(item.workspaceId, current);
  }
  return counts;
}
