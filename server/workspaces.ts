import type { PaseoApi } from "./paseo-api";

type Listed = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>;
export type WorkspaceEntry = Listed["entries"][number];

/** hook 마다 목록을 다시 받지 않도록 잠깐 기억한다. 세션 열기와 도구 호출이 몰릴 때 daemon 을 덜 부른다. */
const TTL_MS = 15_000;

/** 목록에 없던 id. 없는 워크스페이스를 가리키는 에이전트가 턴마다 전체 목록을 다시 받지 않게 잠깐 기억한다. */
const MISSING_TTL_MS = 60_000;

export class WorkspaceDirectory {
  private cached: { at: number; entries: WorkspaceEntry[] } | null = null;
  private loading: Promise<WorkspaceEntry[]> | null = null;
  private readonly missing = new Map<string, number>();

  async list(paseo: PaseoApi, fresh = false): Promise<WorkspaceEntry[]> {
    if (!fresh && this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.entries;
    // 기본 목록은 background 워크스페이스를 빼고 한 페이지만 준다. 에이전트가 있는 워크스페이스를 하나라도 놓치면 그 에이전트에
    // 도구가 붙지 않으므로 모두 받는다. 보드에서는 background 를 따로 거른다.
    this.loading ??= listAll(paseo)
      .then((entries) => {
        this.cached = { at: Date.now(), entries };
        return entries;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async find(paseo: PaseoApi, workspaceId: string): Promise<WorkspaceEntry | null> {
    const hit = (await this.list(paseo)).find((entry) => entry.id === workspaceId);
    if (hit) return hit;
    const missedAt = this.missing.get(workspaceId);
    if (missedAt && Date.now() - missedAt < MISSING_TTL_MS) return null;
    // 방금 만든 워크스페이스는 기억한 목록에 없다.
    const fresh = (await this.list(paseo, true)).find((entry) => entry.id === workspaceId) ?? null;
    if (fresh) this.missing.delete(workspaceId);
    else this.missing.set(workspaceId, Date.now());
    return fresh;
  }
}

/** 한 페이지는 최대 200개다(Paseo 0.17.4). 다음 cursor 가 없을 때까지 받는다. */
const PAGE_LIMIT = 200;
const MAX_PAGES = 20;

async function listAll(paseo: PaseoApi): Promise<WorkspaceEntry[]> {
  const entries: WorkspaceEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // 기본 정렬(상태 우선순위)은 페이지를 넘기는 사이에 바뀔 수 있어 워크스페이스가 빠지거나 겹친다. 바뀌지 않는 키로 정렬한다.
    const listed = await paseo.workspaces.list({
      includeBackground: true,
      filter: { includeBackground: true },
      sort: [
        { key: "project_id", direction: "asc" },
        { key: "name", direction: "asc" },
      ],
      page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    entries.push(...listed.entries);
    if (!listed.pageInfo?.hasMore || !listed.pageInfo.nextCursor) break;
    cursor = listed.pageInfo.nextCursor;
  }
  // 정렬 키가 같은 항목이 페이지 경계에 걸리면 두 번 올 수 있다.
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

export function workspaceDirectoryPath(entry: WorkspaceEntry): string {
  return entry.workspaceDirectory ?? entry.projectRootPath;
}
