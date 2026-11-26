import type { PaseoApi } from "./paseo-api";
import type { Task } from "../shared/model";
import { deleteBranchIfPublished } from "./completion";

/**
 * 읽기 조사처럼 끝난 뒤 남길 것이 없는 작업의 워크스페이스와 로컬 브랜치를 정리한다.
 * 조사 워커도 worktree 와 coord/* 브랜치를 만드는데, 답을 확인하거나 계획이 바뀐 뒤에도 남아 r13·r14·r15 의 조사 worktree 와
 * 브랜치가 쌓였다. 사람이 그 정리를 따로 요청해야 했다 (2026-11-26).
 * 브랜치는 원격에 없는 커밋이 없을 때만 지운다. 조사 워커는 plan 모드라 커밋하지 않지만, 혹시 남았으면 사람이 볼 수 있게 둔다.
 */
export async function cleanupTaskWorkspaces(paseo: PaseoApi, tasks: readonly Task[]): Promise<void> {
  const projects = (await paseo.projects.list().catch(() => null))?.projects ?? [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!task.workspaceId || seen.has(task.workspaceId)) continue;
    seen.add(task.workspaceId);
    const archived = await paseo.workspaces
      .ref(task.workspaceId)
      .archive()
      .then(() => true)
      .catch((error: unknown) => (console.error(`[coordinator] could not archive workspace ${task.workspaceId}`, error), false));
    const root = projects.find((project) => project.projectId === task.projectId)?.projectRootPath;
    if (archived && root && task.branch) await deleteBranchIfPublished(root, task.branch).catch(() => false);
  }
}
