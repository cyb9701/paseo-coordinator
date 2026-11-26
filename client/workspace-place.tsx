import { useWorkspace } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { ViewContext } from "./ui";

/**
 * 홈 폴더를 ~ 로 줄인다. 클라이언트는 데몬의 홈 경로를 모르므로 macOS·Linux 의 홈 모양만 줄인다.
 * worktree 경로는 길고(~/.paseo/worktrees/<hash>/<slug>) 끝부분이 서로를 가른다.
 */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * 워크스페이스가 어느 브랜치, 어느 폴더에서 도는지. 브랜치만 보이면 워커가 어느 worktree 에서 일하는지 알 수 없었다
 * (r17, 2026-11-26: 앱 실행은 Orca worktree 에서 했는데 보드에는 쓰지 않은 coord/* 브랜치만 보였다).
 */
export function WorkspacePlace({ workspaceId, showDiff = false, ctx }: { workspaceId: string; showDiff?: boolean; ctx: ViewContext }) {
  const place = useWorkspace(workspaceId, (w) => ({ branch: w.branch, directory: w.directory, diff: w.diffStat }));
  if (!place) return null;
  const style = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View style={{ gap: 2 }}>
      {place.branch ? (
        <Text numberOfLines={1} style={style}>
          {place.branch}
          {showDiff && place.diff ? `  +${place.diff.additions} −${place.diff.deletions}` : ""}
        </Text>
      ) : null}
      {place.directory ? (
        <Text numberOfLines={2} ellipsizeMode="head" selectable style={style}>
          {shortPath(place.directory)}
        </Text>
      ) : null}
    </View>
  );
}
