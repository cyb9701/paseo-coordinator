import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { useMemo } from "react";
import { isVisibleAgent } from "./agent-state";
import { useT } from "./i18n";
import { classifierFor, usePendingDirectory } from "./pending-store";

export const SCREEN_ID = "main";

// 사이드바 숫자는 작업이 멈춰 있는 것(내 반응 필요: 권한·질문 대기, 에러)만 센다.
// 확인 필요(결과 미확인)는 멈춘 것이 아니라 끝난 것이라 세지 않는다. 숫자가 늘 떠 있으면 아무도 보지 않게 된다.
// 사이드바는 화면과 다른 트리에 그려져서 구독을 따로 갖는다.

export function CoordinatorSidebarItem({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { t } = useT();
  const directory = usePendingDirectory();
  const classify = useMemo(() => classifierFor(directory), [directory]);
  const blocked = useAgents({
    hosts: [host.id],
    where: (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "react",
  });
  return (
    <SidebarRow
      icon="LayoutDashboard"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={
        blocked.length > 0 ? (
          <View
            accessibilityLabel={t("states.permission") + ` ${blocked.length}`}
            style={{
              minWidth: 18,
              paddingHorizontal: 5,
              borderRadius: 9,
              backgroundColor: theme.colors.statusDanger,
              alignItems: "center",
            }}
          >
            <Text style={{ color: theme.colors.surface0, fontSize: 11, fontWeight: "600" }}>{blocked.length}</Text>
          </View>
        ) : undefined
      }
    />
  );
}
