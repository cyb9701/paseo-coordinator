import type { PaseoApi } from "./paseo-api";
import type { CoordinatorState } from "../shared/model";
import { uncommittedChanges } from "./completion";
import { run } from "./run";
import { say } from "./say";

export { pluginWorkspaceIds } from "../shared/model";

/**
 * 사람의 기존 Paseo 워크스페이스에서 워커를 띄우는 데 필요한 확인.
 *
 * 원래 워커는 항상 새 worktree 와 coord/* 브랜치에서 일했다. 사람이 이미 쓰는 워크스페이스의 일(아직 머지되지 않은 로컬 브랜치의
 * 기능, 커밋하지 않는 .env 가 있는 worktree)을 맡기면 쓰지도 않는 worktree 가 생기고, 보드에는 실제로 일한 곳이 아닌 브랜치가
 * 보였다 (r17, 2026-11-26). 사용자 결정(2026-11-26): 사람이 새 요청 창에서 고르거나 코디네이터가 찾아 질문 카드로 승인받은
 * 기존 워크스페이스에서 새 세션으로 일한다. 코드 작업은 그 브랜치에 커밋까지만 하고, 워크스페이스에 커밋하지 않은 변경이 있거나
 * 다른 에이전트가 일하는 중이면 기다린다. 사람의 변경이 워커의 커밋에 섞이지 않게 하기 위해서다.
 */

/** git 저장소를 가진 워크스페이스 종류. directory 는 git 이 아니라 브랜치도 커밋도 없다. */
const GIT_KINDS = new Set(["worktree", "local_checkout", "checkout"]);

export interface ExistingWorkspace {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  directory: string;
}

/** 이 host 의 활성 워크스페이스. archive 된 것은 목록에 없다. */
export async function listExistingWorkspaces(paseo: PaseoApi, projectId?: string): Promise<ExistingWorkspace[]> {
  const listed = await paseo.workspaces.list({ ...(projectId ? { filter: { projectId } } : {}), page: { limit: 200 } });
  return listed.entries
    .filter((entry) => !entry.archivingAt)
    .map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      name: entry.title ?? entry.name,
      kind: entry.workspaceKind,
      // 폴더가 없는 워크스페이스를 프로젝트 루트로 대신하면 엉뚱한 폴더의 브랜치와 변경을 확인한다. 비워 두고 쓸 수 없다고 본다.
      directory: entry.workspaceDirectory ?? "",
    }));
}

/** 워커를 띄울 수 없는 이유. 띄울 수 있으면 null. 코디네이터에게 주는 말이라 영어로 쓴다. */
export function workspaceProblem(
  workspace: ExistingWorkspace | undefined,
  workspaceId: string,
  projectId: string,
  pluginIds: ReadonlySet<string>,
): string | null {
  if (!workspace) return `workspace ${workspaceId} is not an active workspace on this host`;
  if (workspace.projectId !== projectId) return `workspace ${workspaceId} belongs to project ${workspace.projectId}, not ${projectId}`;
  if (!GIT_KINDS.has(workspace.kind)) return `workspace ${workspaceId} is not a git checkout`;
  if (!workspace.directory) return `workspace ${workspaceId} has no directory`;
  if (pluginIds.has(workspaceId)) return `workspace ${workspaceId} is a worktree the plugin made for another task`;
  return null;
}

export interface Checkout {
  /** checkout 한 브랜치. HEAD 가 브랜치가 아니면(detached) null. */
  branch: string | null;
  head: string;
}

export async function readCheckout(directory: string): Promise<Checkout> {
  const [branch, head] = await Promise.all([
    run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], directory).then(
      (out) => out.trim() || null,
      () => null,
    ),
    run("git", ["rev-parse", "HEAD"], directory).then((out) => out.trim()),
  ]);
  return { branch, head };
}

/**
 * 워크스페이스에서 지금 다른 누가 일하는지. 커밋하지 않은 변경이 있거나 다른 Paseo 에이전트가 일하는 중이면 그 이유를 사람의 말로
 * 돌려준다. Orca 터미널처럼 Paseo 밖의 에이전트는 알 수 없다. 그래서 커밋하지 않은 변경도 함께 본다.
 */
export async function busyReason(
  paseo: PaseoApi,
  workspace: ExistingWorkspace,
  language: "en" | "ko",
  state: Pick<CoordinatorState, "requests">,
  self: { requestId: string; taskNumber: number },
): Promise<string | null> {
  // 한 워크스페이스는 한 번에 한 워커만 쓴다. 지금 쉬고 있어도 막힘 카드나 완료 카드를 기다리는 작업은 사람이 답하면 다시 일한다.
  // 실행 중인 에이전트만 세면 그사이 다른 요청의 워커가 들어와 두 워커가 같은 작업 트리를 고쳤다 (2026-11-26 전수 검사).
  for (const request of state.requests) {
    if (request.status !== "running") continue;
    const holder = request.tasks.find(
      (task) =>
        (task.existingWorkspaceId === workspace.id || task.workspaceId === workspace.id) &&
        (task.status === "running" || task.status === "blocked" || (task.status === "review" && !task.completion?.closedAt)) &&
        !(request.id === self.requestId && task.number === self.taskNumber),
    );
    if (holder) {
      return say(
        language,
        `Waiting: task ${holder.number} (${holder.name}) of ${request.id} is still open in ${workspace.name}. This task starts when that one is finished or its card is closed.`,
        `기다리는 중: ${workspace.name} 에서 ${request.id} 의 작업 ${holder.number} (${holder.name}) 이 아직 끝나지 않았어요. 그 작업이 끝나거나 카드를 닫으면 시작해요.`,
      );
    }
  }
  // 확인하지 못했으면 시작하지 않고 기다린다. 막힘으로 두면 잠깐의 연결 문제로 사람이 다시 시작을 눌러야 한다.
  const listed = await paseo.agents.list({ filter: { statuses: ["running", "initializing"] }, page: { limit: 200 } }).catch(() => null);
  if (!listed) {
    return say(
      language,
      `Waiting: could not check whether another agent is working in ${workspace.name}. Checking again shortly.`,
      `기다리는 중: ${workspace.name} 에서 다른 에이전트가 일하는지 확인하지 못했어요. 곧 다시 확인해요.`,
    );
  }
  const working = listed.entries
    .map((entry) => entry.agent)
    .filter(
      (agent) =>
        !agent.archivedAt &&
        (agent.workspaceId === workspace.id || agent.cwd === workspace.directory || agent.cwd.startsWith(`${workspace.directory}/`)),
    );
  if (working.length > 0) {
    const names = working.map((agent) => agent.title ?? agent.id).join(", ");
    return say(
      language,
      `Waiting: another agent is working in ${workspace.name} (${names}). The task starts when it stops.`,
      `기다리는 중: ${workspace.name} 에서 다른 에이전트가 일하고 있어요 (${names}). 멈추면 시작해요.`,
    );
  }
  const dirty = await uncommittedChanges(workspace.directory);
  if (dirty) {
    return say(
      language,
      `Waiting: ${workspace.name} has uncommitted changes. Commit or stash them and the task starts.`,
      `기다리는 중: ${workspace.name} 에 커밋하지 않은 변경이 있어요. 커밋하거나 stash 하면 시작해요.`,
    );
  }
  return null;
}
