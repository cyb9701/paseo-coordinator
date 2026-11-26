import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { CoordinatorStateProvider, requestReactionCount, useCoordinatorState } from "./coordinator-state";
import { FontProvider, useFonts } from "./fonts";
import { useT } from "./i18n";
import { InboxView } from "./inbox";
import { KanbanBoard } from "./kanban";
import { NewRequestPanel } from "./new-request";
import { PendingProvider, cardCount, useClassifier, usePending } from "./pending-store";
import { SettingsView } from "./settings-view";
import { useNow } from "./time";
import { CtaButton, TabBar, type ViewContext } from "./ui";

type Tab = "inbox" | "progress" | "settings";

export function CoordinatorScreen(props: PluginScreenProps) {
  return (
    <FontProvider>
      <PendingProvider>
        <CoordinatorStateProvider>
          <ScreenBody {...props} />
        </CoordinatorStateProvider>
      </PendingProvider>
    </FontProvider>
  );
}

function ScreenBody({ theme, layout, host, navigation }: PluginScreenProps) {
  const { t, locale } = useT();
  const classify = useClassifier();
  const pending = usePending();
  const [composing, setComposing] = useState(false);
  // 병목이 보이는 곳을 먼저 연다.
  const [tab, setTab] = useState<Tab>("inbox");
  const now = useNow();
  const fonts = useFonts();
  const ctx: ViewContext = { theme, compact: layout.compact, hostId: host.id, now, navigation, t, fonts };
  const waiting = useAgents({
    hosts: [host.id],
    where: (agent: PluginAgentSnapshot) => classify.needsMyDecision(agent),
  });
  const { state } = useCoordinatorState();
  const blocked =
    cardCount(waiting.map((ref) => ref.id), pending) +
    requestReactionCount(state?.requests ?? []);
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: "inbox", label: blocked > 0 ? t("tabs.inboxCount", { count: blocked }) : t("tabs.inbox") },
    { key: "progress", label: t("tabs.progress") },
  ];
  // 설정은 자주 쓰지 않아서 일하는 탭과 떨어뜨려 맨 오른쪽 끝에 둔다 (2026-11-25 사용자 요청).
  const settingsTab: readonly { key: Tab; label: string }[] = [{ key: "settings", label: t("tabs.settings") }];
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
        <View style={{ flex: 1 }} />
        <TabBar<Tab> tabs={settingsTab} active={tab} onChange={setTab} theme={theme} />
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
      <ConnectionBanner ctx={ctx} />
      {tab === "inbox" ? <InboxView ctx={ctx} /> : null}
      {tab === "progress" ? <KanbanBoard ctx={ctx} /> : null}
      {tab === "settings" ? <SettingsView theme={theme} hostId={host.id} t={t} /> : null}
    </ScrollView>
  );
}

/**
 * 상태 구독이 끊겼다는 표시. 끊기면 인박스와 보드는 마지막 상태로 멈춰 있어서, 알리지 않으면 '막힌 것 없음'을 그대로 믿게 된다.
 */
function ConnectionBanner({ ctx }: { ctx: ViewContext }) {
  const { disconnected, reconnect } = useCoordinatorState();
  if (!disconnected) return null;
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: ctx.theme.colors.statusWarning,
      }}
    >
      <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.body, flex: 1 }}>
        {ctx.t("connection.lost", { reason: disconnected === "closed" ? ctx.t("connection.closed") : disconnected.message })}
      </Text>
      <CtaButton label={ctx.t("connection.retry")} theme={ctx.theme} onPress={reconnect} />
    </View>
  );
}

/** Paseo 설정 → 플러그인 화면. Coordinator 화면의 설정 탭과 같은 내용이다. 꺼진 규칙을 보이려면 상태 구독이 필요하다. */
export function CoordinatorSettingsScreen(props: PluginSurfaceProps) {
  return (
    <FontProvider>
      <CoordinatorStateProvider>
        <SettingsScreenBody {...props} />
      </CoordinatorStateProvider>
    </FontProvider>
  );
}

function SettingsScreenBody({ theme, layout, host }: PluginSurfaceProps) {
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
