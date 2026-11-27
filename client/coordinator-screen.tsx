import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useAgents } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { reactionCount } from "./attention";
import { CoordinatorStateProvider, useCoordinatorState } from "./coordinator-state";
import { FontProvider, useFonts } from "./fonts";
import { useT } from "./i18n";
import { InboxView } from "./inbox";
import { PendingProvider, useClassifier, usePending } from "./pending-store";
import { ProgressBoard } from "./progress-board";
import { RequestsView } from "./requests-view";
import { SettingsView } from "./settings-view";
import { useNow } from "./time";
import { CtaButton, TabBar, type ViewContext } from "./ui";


type Tab = "inbox" | "progress" | "requests" | "settings";

/**
 * 화면은 한 호스트의 것이다. 호스트를 바꾸면 key 로 트리를 새로 만들어, 앞 호스트의 탭·입력·구독이 다음 호스트에 남지 않게 한다.
 */
export function CoordinatorScreen(props: PluginScreenProps) {
  return (
    <FontProvider key={props.host.id}>
      <PendingProvider>
        <CoordinatorStateProvider>
          <ScreenBody {...props} />
        </CoordinatorStateProvider>
      </PendingProvider>
    </FontProvider>
  );
}

function ScreenBody({ theme, layout, host, navigation }: PluginScreenProps) {
  const { t } = useT();
  const classify = useClassifier();
  const pending = usePending();
  const [tab, setTab] = useState<Tab>("inbox");
  const now = useNow();
  const fonts = useFonts();
  const ctx: ViewContext = { theme, compact: layout.compact, hostId: host.id, now, navigation, t, fonts };
  const waiting = useAgents({ hosts: [host.id], where: (agent) => classify.needsMyDecision(agent) });
  const { state } = useCoordinatorState();
  const blocked = reactionCount(state, waiting.map((ref) => ref.id), pending);
  // 추가 요청 탭의 숫자는 사람이 볼 것(에이전트의 제안)만 센다. 대기 중인 요청은 알아서 나간다.
  const suggestions = (state?.requests ?? []).filter((item) => item.status === "suggested").length;
  const tabs: readonly { key: Tab; label: string }[] = [
    { key: "inbox", label: blocked > 0 ? t("tabs.inboxCount", { count: blocked }) : t("tabs.inbox") },
    { key: "progress", label: t("tabs.progress") },
    { key: "requests", label: suggestions > 0 ? t("tabs.requestsCount", { count: suggestions }) : t("tabs.requests") },
  ];
  // 설정은 자주 쓰지 않아서 일하는 탭과 떨어뜨려 오른쪽 끝에 둔다.
  const settingsTab: readonly { key: Tab; label: string }[] = [{ key: "settings", label: t("tabs.settings") }];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <TabBar<Tab> tabs={tabs} active={tab} onChange={setTab} theme={theme} />
        <View style={{ flex: 1 }} />
        <TabBar<Tab> tabs={settingsTab} active={tab} onChange={setTab} theme={theme} />
      </View>
      <ConnectionBanner ctx={ctx} />
      {tab === "inbox" ? <InboxView ctx={ctx} /> : null}
      {tab === "progress" ? <ProgressBoard ctx={ctx} /> : null}
      {tab === "requests" ? <RequestsView ctx={ctx} /> : null}
      {tab === "settings" ? <SettingsView theme={theme} hostId={host.id} t={t} /> : null}
    </ScrollView>
  );
}

/** 상태 구독이 끊겼다는 표시. 끊기면 인박스는 마지막 상태로 멈춰 있어서, 알리지 않으면 '막힌 것 없음'을 그대로 믿게 된다. */
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

/** Paseo 설정 → 플러그인 화면. Coordinator 화면의 설정 탭과 같은 내용이다. */
export function CoordinatorSettingsScreen({ theme, layout, host }: PluginSurfaceProps) {
  return (
    <FontProvider>
      <SettingsScreenBody theme={theme} compact={layout.compact} hostId={host.id} />
    </FontProvider>
  );
}

function SettingsScreenBody({ theme, compact, hostId }: { theme: PluginSurfaceProps["theme"]; compact: boolean; hostId: string }) {
  const { t } = useT();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: compact ? 12 : 24 }}>
      <SettingsView theme={theme} hostId={hostId} t={t} />
    </ScrollView>
  );
}
