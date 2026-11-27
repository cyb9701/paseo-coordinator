import type { PullRequest, WorkspaceStatus } from "../shared/model";
import { baseCommit, changedFiles, fileDiff, mapLimited } from "./git";
import type { PaseoApi } from "./paseo-api";
import { type WorkspaceDirectory, type WorkspaceEntry, workspaceDirectoryPath } from "./workspaces";

/** 보드는 1분마다 읽는다. 인박스의 확인 카드와 워크스페이스 탭, 요약이 거의 같은 때에 불러도 git 을 한 번만 돌린다. */
const TTL_MS = 20_000;
/** 한 번에 git 을 돌리는 워크스페이스 수. 워크스페이스마다 git 프로세스가 서너 개 뜬다. */
const GIT_LANES = 4;

function prBase(entry: WorkspaceEntry): string | null {
  const pr = entry.githubRuntime?.pullRequest;
  return pr && !pr.isMerged && pr.state.toLowerCase() === "open" ? pr.baseRefName : null;
}

function pullRequestOf(entry: WorkspaceEntry): PullRequest | null {
  const pr = entry.githubRuntime?.pullRequest;
  if (!pr) return null;
  return {
    number: pr.number ?? null,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    isMerged: pr.isMerged,
    isDraft: pr.isDraft ?? false,
    mergeable: pr.mergeable ?? null,
    checks: pr.checksStatus ?? null,
    failedChecks: (pr.checks ?? []).filter((check) => check.status === "failure").map((check) => check.name),
    reviewDecision: pr.reviewDecision ?? null,
  };
}

/**
 * 지켜보는 프로젝트의 워크스페이스마다 바뀐 파일, PR 상태, 같은 프로젝트의 다른 워크스페이스와 겹치는 파일을 낸다.
 * PR 상태는 Paseo 가 워크스페이스에 붙여 주는 GitHub 정보를 읽기만 한다. 플러그인은 PR 을 만들거나 머지하지 않는다.
 * 캐시는 프로젝트 묶음마다 따로 둔다. 하나로 두면 요약이 한 프로젝트만 읽는 동안 보드가 그 결과를 받아 다른 프로젝트가 빈다.
 */
export class WorkspaceStatusReader {
  private readonly cached = new Map<string, { at: number; value: WorkspaceStatus[] }>();
  private readonly loading = new Map<string, Promise<WorkspaceStatus[]>>();

  constructor(private readonly directory: WorkspaceDirectory) {}

  async read(paseo: PaseoApi, projectIds: readonly string[], force = false): Promise<WorkspaceStatus[]> {
    const key = [...projectIds].sort().join(",");
    const hit = this.cached.get(key);
    if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const pending = this.loading.get(key);
    if (pending) return pending;
    const job = this.compute(paseo, projectIds, force)
      .then((value) => {
        this.cached.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, job);
    return job;
  }

  private async compute(paseo: PaseoApi, projectIds: readonly string[], fresh: boolean): Promise<WorkspaceStatus[]> {
    if (!projectIds.length) return [];
    const watched = new Set(projectIds);
    const entries = (await this.directory.list(paseo, fresh)).filter(
      (entry) => watched.has(entry.projectId) && !entry.archivingAt && !entry.background && entry.projectKind === "git",
    );
    const statuses = await mapLimited(entries, GIT_LANES, (entry) => this.one(entry));
    // 같은 파일을 고치는 워크스페이스. 머지할 때 충돌하거나 한쪽 결정이 다른 쪽을 덮을 수 있다.
    for (const status of statuses) {
      const mine = new Set(status.changedFiles);
      status.overlaps = statuses
        .filter((other) => other.workspaceId !== status.workspaceId && other.projectId === status.projectId)
        .map((other) => ({ workspaceId: other.workspaceId, files: other.changedFiles.filter((file) => mine.has(file)) }))
        .filter((item) => item.files.length > 0);
    }
    return statuses;
  }

  private async one(entry: WorkspaceEntry): Promise<WorkspaceStatus> {
    const base: WorkspaceStatus = {
      workspaceId: entry.id,
      projectId: entry.projectId,
      branch: entry.gitRuntime?.currentBranch ?? null,
      base: null,
      changedFiles: [],
      pullRequest: pullRequestOf(entry),
      overlaps: [],
      error: null,
    };
    try {
      const cwd = workspaceDirectoryPath(entry);
      const found = await baseCommit(cwd, prBase(entry));
      if (!found) return { ...base, error: "no base branch found" };
      return { ...base, base: found.ref, changedFiles: (await changedFiles(cwd, found.commit)).files };
    } catch (error) {
      return { ...base, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 바뀐 파일만 보여 준다. 에이전트가 적은 경로를 그대로 쓰면 worktree 밖의 파일도 읽을 수 있어서다. */
  async diff(paseo: PaseoApi, workspaceId: string, files: readonly string[]) {
    const entry = await this.directory.find(paseo, workspaceId);
    if (!entry) throw new Error(`Workspace ${workspaceId} was not found.`);
    const cwd = workspaceDirectoryPath(entry);
    const found = await baseCommit(cwd, prBase(entry));
    if (!found) return { files: [], base: null };
    const changed = await changedFiles(cwd, found.commit);
    const allowed = new Set(changed.files);
    const result = await mapLimited(files, GIT_LANES, async (path) =>
      allowed.has(path) ? { path, ...(await fileDiff(cwd, found.commit, path, changed.untracked.has(path))) } : { path, diff: "", truncated: false },
    );
    return { files: result, base: found.ref };
  }
}
