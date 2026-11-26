import { run } from "./run";

/**
 * 워커 worktree 를 어느 브랜치에서 딸지 정한다.
 *
 * Paseo 는 기준을 주지 않으면 저장소 기본 브랜치의 로컬 ref(refs/heads/dev 등)에서 딴다. 로컬이 원격보다 뒤처져 있으면
 * 낡은 코드에서 시작한다. 또 요청 대상 기능이 아직 기본 브랜치에 없는 브랜치에만 있으면 워커가 그 기능을 보지 못한다.
 * r12(2026-11-26)에서 알림 설정 기능은 Orca worktree 의 로컬 전용 브랜치 orca/notification-settings 에만 있었고,
 * dev 에서 시작한 워커가 그 브랜치를 detached 로 checkout 하다 두 번 멈췄다.
 *
 * 기준 브랜치는 다음 순서로 정한다 (2026-11-26 사용자 결정): 사람이 새 요청 창에서 고른 브랜치 > 코디네이터가 계획에 적은
 * 브랜치 > 설정의 프로젝트별 기준 브랜치 > 원격 기본 브랜치(origin/HEAD). 기본으로는 사람이 쓰는 워크스페이스를 그대로
 * 쓰지 않고 새 worktree 를 딴다. 같은 작업 트리를 사람과 워커가 동시에 고치면 서로의 변경이 커밋에 섞이기 때문이다.
 * 사람이 기존 워크스페이스를 지정하면(2026-11-26 사용자 결정) 기준 브랜치 없이 거기서 일한다. 섞임은 그 워크스페이스가
 * 깨끗하고 다른 에이전트가 없을 때만 시작해서 막고, 정리가 사람의 워크스페이스를 지우지 않게 한다 (server/existing-workspace.ts).
 */

export interface BranchInfo {
  name: string;
  local: boolean;
  /** origin 에 같은 이름의 브랜치가 있는지. 없으면 PR 의 대상이 될 수 없다. */
  remote: boolean;
  /** 이 브랜치를 checkout 한 worktree 경로. Paseo 밖(Orca 등)에서 만든 worktree 도 git 이 알면 나온다. */
  worktree: string | null;
  updatedAt: string;
}

export interface BranchList {
  defaultBranch: string | null;
  branches: BranchInfo[];
}

/** 목록이 길면 화면과 코디네이터 모두 고르기 어렵다. 최근에 커밋된 순으로 이만큼만 보인다. */
const BRANCH_LIMIT = 40;

/** 사람과 코디네이터가 적은 브랜치 이름을 git 인자로 넘기기 전에 거른다. '-' 로 시작하면 옵션으로 읽힌다. */
export async function isBranchName(root: string, name: string): Promise<boolean> {
  if (!name || name.startsWith("-")) return false;
  return run("git", ["check-ref-format", "--branch", name], root).then(
    () => true,
    () => false,
  );
}

async function refExists(root: string, ref: string): Promise<boolean> {
  return run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root).then(
    () => true,
    () => false,
  );
}

/** origin/HEAD 가 가리키는 브랜치 이름. 원격이 없거나 origin/HEAD 가 설정되지 않았으면 null. */
export async function remoteDefaultBranch(root: string): Promise<string | null> {
  const out = await run("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root).catch(() => "");
  const name = out.trim().replace(/^origin\//, "");
  return name || null;
}

export async function listBranches(root: string): Promise<BranchList> {
  const [refs, worktrees, defaultBranch] = await Promise.all([
    run("git", ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%09%(committerdate:iso-strict)", "refs/heads", "refs/remotes/origin"], root),
    run("git", ["worktree", "list", "--porcelain"], root).catch(() => ""),
    remoteDefaultBranch(root),
  ]);
  const checkedOut = new Map<string, string>();
  let path: string | null = null;
  for (const line of worktrees.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path) checkedOut.set(line.slice("branch refs/heads/".length), path);
  }
  const byName = new Map<string, BranchInfo>();
  for (const line of refs.split("\n")) {
    const [ref, updatedAt] = line.split("\t");
    if (!ref || !updatedAt) continue;
    const local = ref.startsWith("refs/heads/");
    const name = local ? ref.slice("refs/heads/".length) : ref.slice("refs/remotes/origin/".length);
    if (!name || name === "HEAD") continue;
    const entry = byName.get(name) ?? { name, local: false, remote: false, worktree: checkedOut.get(name) ?? null, updatedAt };
    if (local) entry.local = true;
    else entry.remote = true;
    byName.set(name, entry);
  }
  return { defaultBranch, branches: [...byName.values()].slice(0, BRANCH_LIMIT) };
}

export interface BaseRef {
  /** 기준 브랜치 이름. PR 의 대상이고 킥오프에 쓴다. */
  branch: string;
  /** workspaces.create 의 refName. origin/… 이면 데몬이 그 브랜치를 fetch 한 최신 커밋에서 딴다. */
  refName: string;
  /** origin 에 있는지. 없으면 PR 을 열 수 없어 워커는 커밋만 하고 PR 없이 끝낸다. */
  remote: boolean;
}

/**
 * 브랜치 이름을 worktree 를 딸 ref 로 바꾼다.
 * 로컬이 원격에 이미 들어 있으면(뒤처졌거나 같으면) 원격을 써서 최신에서 시작한다. 로컬에만 있는 커밋이 있으면
 * 그 커밋이 사람이 진행 중인 일이므로 로컬을 쓴다. 이름이 어디에도 없으면 null.
 */
export async function resolveBaseRef(root: string, branch: string): Promise<BaseRef | null> {
  if (!(await isBranchName(root, branch))) return null;
  const [local, remote] = await Promise.all([refExists(root, `refs/heads/${branch}`), refExists(root, `refs/remotes/origin/${branch}`)]);
  if (!local && !remote) return null;
  if (!remote) return { branch, refName: `refs/heads/${branch}`, remote: false };
  if (!local) return { branch, refName: `origin/${branch}`, remote: true };
  const localInRemote = await run("git", ["merge-base", "--is-ancestor", `refs/heads/${branch}`, `refs/remotes/origin/${branch}`], root).then(
    () => true,
    () => false,
  );
  return { branch, refName: localInRemote ? `origin/${branch}` : `refs/heads/${branch}`, remote: true };
}

/**
 * 커밋된 브랜치 안의 경로를 정규화한다. 저장소 루트 기준 상대 경로만 받는다. '..' 나 절대 경로는 null.
 * git 트리 안에서만 읽으므로 디스크 경로처럼 심볼릭 링크로 밖에 닿지는 않지만, 같은 입력 규칙을 지킨다.
 */
export function treePath(path: string): string | null {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (path.startsWith("/") || parts.includes("..")) return null;
  return parts.join("/");
}

/** 브랜치에 커밋된 디렉터리의 항목. 디렉터리는 이름 뒤에 '/' 를 붙인다. 경로가 디렉터리가 아니면 null. */
export async function listTreeAt(root: string, ref: string, path: string): Promise<string[] | null> {
  const spec = path ? `${ref}:${path}` : `${ref}:`;
  const type = (await run("git", ["cat-file", "-t", spec], root).catch(() => "")).trim();
  if (type !== "tree") return null;
  const out = await run("git", ["ls-tree", spec], root);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [meta, name] = line.split("\t");
      return meta?.split(" ")[1] === "tree" ? `${name}/` : name!;
    });
}

/** 브랜치에 커밋된 파일. 크기가 limit 바이트를 넘으면 앞부분만 읽지 못하므로 too-large 를 돌려준다. */
export async function readBlobAt(root: string, ref: string, path: string, limit: number): Promise<string | "too-large" | null> {
  const spec = `${ref}:${path}`;
  const type = (await run("git", ["cat-file", "-t", spec], root).catch(() => "")).trim();
  if (type !== "blob") return null;
  const size = Number((await run("git", ["cat-file", "-s", spec], root)).trim());
  if (!Number.isFinite(size) || size > limit) return "too-large";
  return run("git", ["cat-file", "blob", spec], root);
}
