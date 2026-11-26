import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgent, useAgents, usePaseo } from "@getpaseo/plugin/client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type ColumnKey, columnOf, isVisibleAgent, stateColor } from "./agent-state";
import { useClassifier } from "./pending-store";
import { WorkspaceProjectChip } from "./project-chip";
import { formatAgo } from "./time";
import { CtaButton, type ViewContext } from "./ui";

// 실행 중인 에이전트는 lastActivityAt 이 계속 바뀐다. 바뀔 때마다 timeline 을 다시 읽지 않도록 30초 단위로 묶는다.
function previewBucket(lastActivityAt: string, running: boolean): string {
  if (!running) return lastActivityAt;
  return String(Math.floor(Date.parse(lastActivityAt) / 30_000));
}

/** 카드 본문에 보일 마지막 어시스턴트 응답. 사람이 카드만 보고 무슨 일이 있었는지 알 수 있게 한다. */
function useLastAssistantText(agentId: string, hostId: string, bucket: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["coordinator", "last-assistant-text", hostId, agentId, bucket],
    staleTime: Infinity,
    // 30초마다 key 가 바뀌는데, 이전 값을 유지하지 않으면 새로 읽는 동안 미리보기가 사라졌다 나타난다.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 20 });
      const entries = (page as { entries?: readonly { item?: { type?: string; text?: string } }[] }).entries ?? [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const item = entries[index]?.item;
        if (item?.type === "assistant_message" && item.text?.trim()) {
          return item.text.replace(/\s+/g, " ").trim();
        }
      }
      return null;
    },
  });
}

function ctaFor(column: ColumnKey, t: ViewContext["t"]): { label: string; primary: boolean } {
  switch (column) {
    case "react":
      return { label: t("card.openToHandle"), primary: true };
    case "review":
      return { label: t("card.openToReview"), primary: true };
    default:
      return { label: t("card.open"), primary: false };
  }
}

function SubSessions({ parentId, ctx }: { parentId: string; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  const classify = useClassifier();
  const children = useAgents({
    hosts: [ctx.hostId],
    where: (a) => isVisibleAgent(a) && a.parentAgentId === parentId,
    orderBy: ["lastActivityAt", "desc"],
  });
  const unread = useAgents({
    hosts: [ctx.hostId],
    where: (a) => isVisibleAgent(a) && a.parentAgentId === parentId && classify.column(a) === "review",
  });
  if (children.length === 0) return null;
  const summary =
    unread.length > 0
      ? ctx.t("card.subSessionsUnread", { count: children.length, unread: unread.length })
      : ctx.t("card.subSessions", { count: children.length });
  return (
    <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 6, gap: 4 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${summary} ${open ? ctx.t("card.collapse") : ctx.t("card.expand")}`}
        onPress={() => setOpen((value) => !value)}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}
      >
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{open ? "▾" : "▸"}</Text>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{summary}</Text>
      </Pressable>
      {open ? children.map((ref) => <SubSessionRow key={ref.key} agentRef={ref} ctx={ctx} />) : null}
    </View>
  );
}

function SubSessionRow({ agentRef, ctx }: { agentRef: AgentRef; ctx: ViewContext }) {
  const classify = useClassifier();
  const agent = useAgent(agentRef, (a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    attentionReason: a.attentionReason,
    requiresAttention: a.requiresAttention,
    hostId: a.hostId,
  }));
  if (!agent) return null;
  const state = classify.state(agent);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 16 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stateColor(state, ctx.theme) }} />
      <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, flex: 1 }}>
        {agent.title ?? ctx.t("card.untitledSubSession")}
      </Text>
      <Text style={{ color: stateColor(state, ctx.theme), fontSize: ctx.fonts.meta }}>{ctx.t(`states.${state}`)}</Text>
      {ctx.navigation ? (
        <CtaButton
          size="sm"
          label={ctx.t("card.open")}
          accessibilityLabel={ctx.t("card.openNamed", { name: agent.title ?? ctx.t("card.untitledSubSession") })}
          theme={ctx.theme}
          onPress={() => ctx.navigation?.openAgent({ agentId: agentRef.id, serverId: agent.hostId })}
        />
      ) : null}
    </View>
  );
}

export function AgentCard({
  agentRef,
  ctx,
  workspaceLabel,
}: {
  agentRef: AgentRef;
  ctx: ViewContext;
  /** 컬럼만 보이는 좁은 화면에서는 카드가 어느 워크스페이스 것인지 카드에 적는다. */
  workspaceLabel?: string | null;
}) {
  const classify = useClassifier();
  const agent = useAgent(agentRef, (a) => ({
    id: a.id,
    title: a.title,
    provider: a.provider,
    model: a.model,
    status: a.status,
    attentionReason: a.attentionReason,
    requiresAttention: a.requiresAttention,
    lastActivityAt: a.lastActivityAt,
    hostId: a.hostId,
    parentAgentId: a.parentAgentId,
    workspaceId: a.workspaceId,
  }));
  const running = agent?.status === "running";
  const preview = useLastAssistantText(
    agentRef.id,
    ctx.hostId,
    agent ? previewBucket(agent.lastActivityAt, running) : "",
  );
  if (!agent) return null;
  const state = classify.state(agent);
  const color = stateColor(state, ctx.theme);
  const cta = ctaFor(columnOf(state), ctx.t);
  const title = agent.title ?? ctx.t("card.untitledAgent");
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: color,
        borderRadius: 8,
        backgroundColor: ctx.theme.colors.surface1,
        padding: 10,
        gap: 6,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <WorkspaceProjectChip workspaceId={agent.workspaceId} ctx={ctx} />
        {workspaceLabel ? (
          <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, flexShrink: 1 }}>
            {workspaceLabel}
          </Text>
        ) : null}
      </View>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
        <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flex: 1 }}>
          {agent.parentAgentId ? `↳ ${title}` : title}
        </Text>
        <Text style={{ color, fontSize: ctx.fonts.meta }}>{ctx.t(`states.${state}`)}</Text>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {formatAgo(agent.lastActivityAt, ctx.now, ctx.t)}
        </Text>
      </View>
      {preview.data ? (
        <Text numberOfLines={2} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
          {preview.data}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, flex: 1 }}>
          {agent.model ? `${agent.provider} / ${agent.model}` : agent.provider}
        </Text>
        {ctx.navigation ? (
          <CtaButton
            size="sm"
            label={cta.label}
            tone={cta.primary ? "primary" : "neutral"}
            accessibilityLabel={`${title} ${cta.label}`}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: agentRef.id, serverId: agent.hostId })}
          />
        ) : null}
      </View>
      {agent.parentAgentId ? null : <SubSessions parentId={agentRef.id} ctx={ctx} />}
    </View>
  );
}
