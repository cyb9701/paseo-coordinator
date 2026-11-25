import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { isVisibleAgent } from "./agent-state";
import { CoordinatorStateProvider } from "./coordinator-state";
import { useT } from "./i18n";
import { InboxView } from "./inbox";
import { KanbanBoard } from "./kanban";
import { NewRequestPanel } from "./new-request";
import { PendingProvider, useClassifier } from "./pending-store";
import { SettingsView } from "./settings-view";
import { useNow } from "./time";
import { CtaButton, TabBar, type ViewContext } from "./ui";

type Tab = "inbox" | "progress" | "settings";

export function CoordinatorScreen(props: PluginScreenProps) {
  return (
    <PendingProvider>
      <CoordinatorStateProvider>
        <ScreenBody {...props} />
      </CoordinatorStateProvider>
    </PendingProvider>
  );
}

function ScreenBody({ theme, layout, host, navigation }: PluginScreenProps) {
  const { t, locale } = useT();
  const classify = useClassifier();
  const [composing, setComposing] = useState(false);
  // 병목이 보이는 곳을 먼저 연다.
  const [tab, setTab] = useState<Tab>("inbox");
  const now = useNow();
  const ctx: ViewContext = { theme, compact: layout.compact, hostId: host.id, now, navigation, t };
  const waiting = useAgents({
    hosts: [host.id],
    where: (agent: PluginAgentSnapshot) => isVisibleAgent(agent) && classify.column(agent) === "react",
  });
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: "inbox", label: waiting.length > 0 ? t("tabs.inboxCount", { count: waiting.length }) : t("tabs.inbox") },
    { key: "progress", label: t("tabs.progress") },
    { key: "settings", label: t("tabs.settings") },
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
          label={t("newRequest.label")}
          tone="primary"
          disabled={composing}
          theme={theme}
          onPress={() => setComposing(true)}
        />
      </View>
      {composing ? (
        <NewRequestPanel
          ctx={ctx}
          locale={locale}
          onClose={(sent) => {
            setComposing(false);
            // 보낸 요청이 바로 보이도록 진행 현황으로 옮긴다.
            if (sent) setTab("progress");
          }}
        />
      ) : null}
      {tab === "inbox" ? <InboxView ctx={ctx} /> : null}
      {tab === "progress" ? <KanbanBoard ctx={ctx} /> : null}
      {tab === "settings" ? <SettingsView theme={theme} hostId={host.id} t={t} /> : null}
    </ScrollView>
  );
}

/** Paseo 설정 → 플러그인 화면. Coordinator 화면의 설정 탭과 같은 내용이다. */
export function CoordinatorSettingsScreen({ theme, layout, host }: PluginSurfaceProps) {
  const { t } = useT();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 12 : 24 }}
    >
      <SettingsView theme={theme} hostId={host.id} t={t} />
    </ScrollView>
  );
}
