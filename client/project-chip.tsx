import { useWorkspace } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { toWorkspaceRef } from "./refs";
import { Chip, type ViewContext } from "./ui";

/**
 * 카드가 어느 프로젝트의 어느 워크스페이스 일인지. 여러 프로젝트·워크스페이스의 카드가 한 인박스에 섞이므로 모든 카드 머리에서 제목처럼 보인다.
 * 프로젝트는 흐리게, 워크스페이스는 진하게 쓴다. 같은 프로젝트의 카드가 여럿일 때 가르는 것은 워크스페이스 이름이기 때문이다.
 */
export function WorkspaceLocation({ workspaceId, hostId, ctx }: { workspaceId: string; hostId?: string; ctx: ViewContext }) {
  const place = useWorkspace(toWorkspaceRef(hostId ?? ctx.hostId, workspaceId), (w) => ({ project: w.projectDisplayName, name: w.title ?? w.name }));
  const size = ctx.fonts.body;
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <View style={{ paddingTop: Math.round(size * 0.2) }}>
        <Icon name="Folder" size={size} color={ctx.theme.colors.foregroundMuted} />
      </View>
      <Text numberOfLines={2} style={{ flexShrink: 1, fontSize: size, lineHeight: Math.round(size * 1.4) }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted }}>{place?.project ?? ctx.t("card.noProject")}</Text>
        <Text style={{ color: ctx.theme.colors.foregroundMuted }}>{"  ›  "}</Text>
        <Text style={{ color: ctx.theme.colors.foreground, fontWeight: "600" }}>{place?.name ?? workspaceId}</Text>
      </Text>
    </View>
  );
}

/**
 * 인박스 카드 머리. 모든 카드가 같은 모양이라 어디를 보면 되는지 카드마다 다시 찾지 않는다.
 * 윗줄은 종류와 시간, 둘째 줄은 프로젝트 › 워크스페이스, 셋째 줄은 에이전트(있을 때). 아래에 선을 그어 머리와 본문을 가른다.
 */
export function CardTop({
  kind,
  color,
  workspaceId,
  hostId,
  right,
  subtitle,
  ctx,
}: {
  kind: string;
  color: string;
  workspaceId: string;
  hostId?: string;
  right?: string | null;
  subtitle?: string | null;
  ctx: ViewContext;
}) {
  return (
    <View style={{ gap: 6, paddingBottom: 12, borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Chip label={kind} color={color} theme={ctx.theme} />
        <View style={{ flex: 1 }} />
        {right ? (
          <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, flexShrink: 1 }}>
            {right}
          </Text>
        ) : null}
      </View>
      <WorkspaceLocation workspaceId={workspaceId} hostId={hostId} ctx={ctx} />
      {subtitle ? (
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
