/**
 * 홈 폴더를 ~ 로 줄인다. 클라이언트는 데몬의 홈 경로를 모르므로 macOS·Linux 의 홈 모양만 줄인다.
 * worktree 경로는 길고 끝부분이 서로를 가른다.
 */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}
