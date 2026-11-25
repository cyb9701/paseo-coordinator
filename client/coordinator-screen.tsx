import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { isVisibleAgent } from "./agent-state";
import { InboxView } from "./inbox";
import { KanbanBoard } from "./kanban";
import { PendingProvider, useClassifier } from "./pending-store";
import { useNow } from "./time";
import { CtaButton, TabBar, type ViewContext } from "./ui";

type Tab = "inbox" | "progress";

export function CoordinatorScreen(props: PluginScreenProps) {
  return (
    <PendingProvider>
      <ScreenBody {...props} />
    </PendingProvider>
  );
}

function ScreenBody({ theme, layout, host, navigation }: PluginScreenProps) {
  const classify = useClassifier();
  // 병목이 보이는 곳을 먼저 연다.
  const [tab, setTab] = useState<Tab>("inbox");
  const now = useNow();
  const ctx: ViewContext = { theme, compact: layout.compact, hostId: host.id, now, navigation };
  const waiting = useAgents({
    hosts: [host.id],
    where: (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "react",
  });
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: "inbox", label: waiting.length > 0 ? `결정 인박스 ${waiting.length}` : "결정 인박스" },
    { key: "progress", label: "진행 현황" },
  ];
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 16 }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <TabBar<Tab> tabs={tabs} active={tab} onChange={setTab} theme={theme} />
        <View style={{ width: 1, height: 24, backgroundColor: theme.colors.border, marginHorizontal: 4 }} />
        <CtaButton
          label="+ 새 요청"
          tone="primary"
          disabled
          accessibilityLabel="새 요청. 3단계에서 사용할 수 있어요"
          theme={theme}
          onPress={() => {}}
        />
      </View>
      {tab === "inbox" ? <InboxView ctx={ctx} /> : <KanbanBoard ctx={ctx} />}
    </ScrollView>
  );
}
