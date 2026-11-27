import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { classifierFor, reactionCount } from "./attention";
import { CoordinatorStateProvider, useCoordinatorState } from "./coordinator-state";
import { useT } from "./i18n";
import { usePendingDirectory } from "./pending-store";

export const SCREEN_ID = "main";

// 사이드바는 화면과 다른 트리에 그려져서 구독을 따로 갖는다. 숫자는 사람을 기다리는 카드만 센다.

export function CoordinatorSidebarItem(props: PluginSidebarItemProps) {
  return (
    <CoordinatorStateProvider>
      <SidebarItemBody {...props} />
    </CoordinatorStateProvider>
  );
}

function SidebarItemBody({ theme, host, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { t } = useT();
  const { state } = useCoordinatorState();
  const directory = usePendingDirectory();
  const classify = useMemo(() => classifierFor(directory), [directory]);
  const blocked = useAgents({ hosts: [host.id], where: (agent) => classify.needsMyDecision(agent) });
  const count = reactionCount(state, blocked.map((ref) => ref.id), directory);
  return (
    <SidebarRow
      icon="LayoutDashboard"
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
      trailing={
        count > 0 ? (
          <View
            accessibilityLabel={t("sidebar.badge", { count })}
            style={{ minWidth: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: theme.colors.statusDanger, alignItems: "center" }}
          >
            <Text style={{ color: theme.colors.surface0, fontSize: 11, fontWeight: "600" }}>{count}</Text>
          </View>
        ) : undefined
      }
    />
  );
}
