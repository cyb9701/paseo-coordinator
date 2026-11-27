import { run } from "./run";

/** 한 파일 diff 의 최대 길이. 카드에서 읽을 수 있는 만큼만 보낸다. */
const MAX_DIFF_CHARS = 20_000;

/**
 * git 은 기본으로 한글이나 따옴표가 든 경로를 "\355\225\234..." 처럼 바꿔 낸다(core.quotepath). 그러면 에이전트가 적은 경로와 짝이
 * 맞지 않는다. 목록은 -z 로 받아 바꾸지 않은 이름을 쓰고, 나머지 명령도 같은 설정으로 돌린다.
 */
function git(cwd: string, args: readonly string[], okExitCodes: readonly number[] = []): Promise<string> {
  return run("git", ["-c", "core.quotepath=false", ...args], cwd, okExitCodes);
}

const splitZ = (out: string) => out.split("\0").filter(Boolean);

/**
 * 워크스페이스의 변경을 잴 기준 커밋. PR 이 있으면 그 PR 의 대상 브랜치, 없으면 원격 기본 브랜치(origin/HEAD)와의 merge-base 다.
 * merge-base 를 쓰는 까닭: 기준 브랜치가 앞서 나가도 그쪽 변경이 이 워크스페이스의 변경으로 보이지 않게 하려고.
 * 후보는 앞에서부터 하나씩 시도한다. 대부분 첫 후보에서 끝나므로 origin/HEAD 는 필요할 때만 읽는다.
 */
export async function baseCommit(cwd: string, prBase: string | null): Promise<{ ref: string; commit: string } | null> {
  const tried = new Set<string>();
  const attempt = async (ref: string | null) => {
    if (!ref || tried.has(ref)) return null;
    tried.add(ref);
    const commit = await git(cwd, ["merge-base", "HEAD", ref]).then((out) => out.trim(), () => null);
    return commit ? { ref, commit } : null;
  };
  const fromPr = await attempt(prBase ? `origin/${prBase}` : null);
  if (fromPr) return fromPr;
  const head = await git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).then((out) => out.trim() || null, () => null);
  for (const ref of [head, "origin/main", "origin/master", "main", "master"]) {
    const found = await attempt(ref);
    if (found) return found;
  }
  return null;
}

/**
 * 기준 이후 바뀐 파일: 커밋한 것, 커밋하지 않은 것, 아직 추적하지 않는 새 파일. 경로는 워크스페이스 폴더 기준이다.
 * --relative 가 없으면 diff 는 저장소 루트 기준 경로를 내서, 모노레포 하위 폴더 워크스페이스에서 ls-files·diff 와 어긋난다.
 */
export async function changedFiles(cwd: string, base: string): Promise<{ files: string[]; untracked: Set<string> }> {
  const [tracked, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "--relative", "-z", base, "--"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const fresh = new Set(splitZ(untracked));
  return { files: [...new Set([...splitZ(tracked), ...fresh])].sort(), untracked: fresh };
}

export async function fileDiff(cwd: string, base: string, path: string, untracked: boolean): Promise<{ diff: string; truncated: boolean }> {
  // 새 파일은 git diff 에 나오지 않는다. 빈 파일과 비교하면 전체가 추가로 보인다. --no-index 는 차이가 있으면 1 로 끝난다.
  const diff = untracked
    ? await git(cwd, ["diff", "--no-index", "--", "/dev/null", path], [1])
    : await git(cwd, ["diff", "--relative", base, "--", path]);
  return diff.length > MAX_DIFF_CHARS ? { diff: diff.slice(0, MAX_DIFF_CHARS), truncated: true } : { diff, truncated: false };
}

/** 워크스페이스가 많을 때 git 프로세스가 한꺼번에 수십 개 뜨지 않게 동시에 도는 수를 묶는다. */
export async function mapLimited<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
