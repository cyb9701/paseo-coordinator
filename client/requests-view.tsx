import { useAgent, useAgents, useRpc, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type WorkRequest, addRequestRpc, dismissRequestRpc, sendSuggestionRpc } from "../shared/model";
import { isVisibleAgent } from "./agent-state";
import { useCoordinatorState } from "./coordinator-state";
import { formatAgo } from "./time";
import { Card, ChoiceBox, CtaButton, ErrorLine, Muted, SectionHeader, TextBox, type ViewContext } from "./ui";

/** 이 워크스페이스에서 요청을 받을 수 있는 에이전트. 최근에 일한 순서다. 닫힌 세션과 helper 는 뺀다. */
function useWorkspaceAgents(workspaceId: string, ctx: ViewContext) {
  return useAgents({
    hosts: [ctx.hostId],
    where: (a) => a.workspaceId === workspaceId && isVisibleAgent(a) && a.status !== "closed",
    orderBy: ["lastActivityAt", "desc"],
  });
}

function AgentChoice({ agentId, selected, onPress, ctx }: { agentId: string; selected: boolean; onPress(): void; ctx: ViewContext }) {
  const title = useAgent(agentId, (a) => a.title);
  return <ChoiceBox label={title ?? ctx.t("common.untitledAgent")} selected={selected} onPress={onPress} theme={ctx.theme} />;
}

/** 받을 에이전트 고르기. 하나면 고를 것 없이 그 에이전트다. */
function AgentPicker({ workspaceId, value, onChange, ctx }: { workspaceId: string; value: string | null; onChange(agentId: string): void; ctx: ViewContext }) {
  const agents = useWorkspaceAgents(workspaceId, ctx);
  const chosen = value ?? agents[0]?.id ?? null;
  if (!agents.length) return <Muted text={ctx.t("requests.noAgent")} ctx={ctx} />;
  // 하나뿐이면 고를 것이 없다. 보내기 버튼에 받을 에이전트 이름이 적힌다.
  if (agents.length === 1) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {agents.slice(0, 8).map((ref) => (
        <AgentChoice key={ref.key} agentId={ref.id} selected={chosen === ref.id} onPress={() => onChange(ref.id)} ctx={ctx} />
      ))}
    </View>
  );
}

/**
 * 진행 중인 워크스페이스에 일을 더 맡긴다. 받을 에이전트가 쉬면 바로, 일하는 중이면 턴이 끝난 뒤 순서대로 받는다.
 * 플러그인은 새 에이전트나 워크스페이스를 만들지 않는다. 이미 그 워크스페이스에서 일하는 에이전트에게만 보낸다.
 */
export function RequestComposer({ workspaceId, onDone, ctx }: { workspaceId: string; onDone?: () => void; ctx: ViewContext }) {
  const call = useRpc(addRequestRpc);
  const agents = useWorkspaceAgents(workspaceId, ctx);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const target = agentId ?? agents[0]?.id ?? null;
  const send = useMutation({
    mutationFn: () => call({ workspaceId, agentId: target!, text: text.trim() }),
    onSuccess: () => {
      setText("");
      onDone?.();
    },
  });
  const name = useAgent(target ?? "", (a) => a.title);
  return (
    <View style={{ gap: 8 }}>
      <AgentPicker workspaceId={workspaceId} value={agentId} onChange={setAgentId} ctx={ctx} />
      <TextBox value={text} onChange={setText} placeholder={ctx.t("requests.placeholder")} ctx={ctx} minHeight={56} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <CtaButton
          label={target ? ctx.t("requests.sendTo", { name: name ?? ctx.t("common.untitledAgent") }) : ctx.t("requests.send")}
          tone="primary"
          disabled={!target || !text.trim() || send.isPending}
          theme={ctx.theme}
          onPress={() => send.mutate()}
        />
        <Muted text={ctx.t("requests.whenIdle")} ctx={ctx} />
      </View>
      <ErrorLine error={send.error} ctx={ctx} />
    </View>
  );
}

function RequestRow({ request, ctx }: { request: WorkRequest; ctx: ViewContext }) {
  const dismissCall = useRpc(dismissRequestRpc);
  const sendCall = useRpc(sendSuggestionRpc);
  const dismiss = useMutation({ mutationFn: () => dismissCall({ id: request.id }) });
  const [picking, setPicking] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const agents = useWorkspaceAgents(request.workspaceId ?? "", ctx);
  const target = agentId ?? (agents.some((ref) => ref.id === request.agentId) ? request.agentId : agents[0]?.id) ?? null;
  const send = useMutation({ mutationFn: () => sendCall({ id: request.id, agentId: target! }) });
  const to = useAgent(request.agentId ?? "", (a) => a.title);
  const status =
    request.status === "queued"
      ? ctx.t("requests.queued", { name: to ?? ctx.t("common.untitledAgent") })
      : request.status === "sent"
        ? ctx.t("requests.sent", { ago: formatAgo(request.sentAt, ctx.now, ctx.t) })
        : request.status === "suggested"
          ? ctx.t("requests.suggested", { name: to ?? ctx.t("common.untitledAgent") })
          : ctx.t("requests.dismissed");
  const color =
    request.status === "queued" ? ctx.theme.colors.accent : request.status === "suggested" ? ctx.theme.colors.statusWarning : ctx.theme.colors.foregroundMuted;
  return (
    <View style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderColor: ctx.theme.colors.border }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{status}</Text>
        <View style={{ flex: 1 }} />
        <Muted text={formatAgo(request.at, ctx.now, ctx.t)} ctx={ctx} />
      </View>
      <Text selectable numberOfLines={request.status === "sent" ? 2 : undefined} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
        {request.text}
      </Text>
      {request.status === "queued" ? (
        <View style={{ flexDirection: "row" }}>
          <CtaButton label={ctx.t("requests.cancel")} disabled={dismiss.isPending} theme={ctx.theme} onPress={() => dismiss.mutate()} />
        </View>
      ) : null}
      {request.status === "suggested" ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <CtaButton label={ctx.t("requests.sendSuggestion")} tone="primary" disabled={!target || send.isPending} theme={ctx.theme} onPress={() => (agents.length > 1 && !picking ? setPicking(true) : send.mutate())} />
            <CtaButton label={ctx.t("requests.dismiss")} disabled={dismiss.isPending} theme={ctx.theme} onPress={() => dismiss.mutate()} />
          </View>
          {picking && request.workspaceId ? <AgentPicker workspaceId={request.workspaceId} value={target} onChange={setAgentId} ctx={ctx} /> : null}
          {!agents.length ? <Muted text={ctx.t("requests.noAgent")} ctx={ctx} /> : null}
        </View>
      ) : null}
      <ErrorLine error={dismiss.error ?? send.error} ctx={ctx} />
    </View>
  );
}

function WorkspaceRequests({ workspaceId, requests, ctx }: { workspaceId: string; requests: readonly WorkRequest[]; ctx: ViewContext }) {
  const workspace = useWorkspace(workspaceId, (w) => ({ name: w.title ?? w.name, project: w.projectDisplayName }));
  const [composing, setComposing] = useState(false);
  const [showSent, setShowSent] = useState(false);
  const open = requests.filter((item) => item.status === "queued" || item.status === "suggested");
  const sent = requests.filter((item) => item.status === "sent").slice(-10).reverse();
  return (
    <Card color={open.some((item) => item.status === "suggested") ? ctx.theme.colors.statusWarning : ctx.theme.colors.accent} ctx={ctx}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {workspace ? <Muted text={workspace.project} ctx={ctx} /> : null}
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>{workspace?.name ?? ctx.t("requests.closedWorkspace")}</Text>
        <View style={{ flex: 1 }} />
        {workspace ? <CtaButton size="sm" label={composing ? ctx.t("common.closeInstruct") : ctx.t("requests.add")} theme={ctx.theme} onPress={() => setComposing((value) => !value)} /> : null}
      </View>
      {composing ? <RequestComposer workspaceId={workspaceId} onDone={() => setComposing(false)} ctx={ctx} /> : null}
      <View>
        {open.map((item) => (
          <RequestRow key={item.id} request={item} ctx={ctx} />
        ))}
      </View>
      {sent.length ? (
        <View>
          <View style={{ flexDirection: "row" }}>
            <CtaButton size="sm" label={showSent ? `▾ ${ctx.t("requests.hideSent")}` : `▸ ${ctx.t("requests.showSent", { count: sent.length })}`} theme={ctx.theme} onPress={() => setShowSent((value) => !value)} />
          </View>
          {showSent ? sent.map((item) => <RequestRow key={item.id} request={item} ctx={ctx} />) : null}
        </View>
      ) : null}
    </Card>
  );
}

/** 새 요청을 받을 워크스페이스 고르기: 지금 에이전트가 있는 워크스페이스. */
function NewRequest({ ctx }: { ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <View style={{ flexDirection: "row" }}>
        <CtaButton label={ctx.t("requests.new")} theme={ctx.theme} onPress={() => setOpen(true)} />
      </View>
    );
  }
  return <WorkspacePickerComposer onClose={() => setOpen(false)} ctx={ctx} />;
}

/** 워크스페이스를 고르고 요청을 쓴다. 고를 목록이 길어서 '새 요청'을 눌렀을 때만 펼친다. */
function WorkspacePickerComposer({ onClose, ctx }: { onClose(): void; ctx: ViewContext }) {
  const workspaces = useWorkspaces({ hosts: [ctx.hostId], where: (w) => !w.background && !w.archivingAt, orderBy: ["lastPromptAt", "desc"] });
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row" }}>
        <CtaButton size="sm" label={ctx.t("common.closeInstruct")} theme={ctx.theme} onPress={onClose} />
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {workspaces.slice(0, 16).map((ref) => (
          <WorkspaceChoice key={ref.key} workspaceId={ref.id} selected={workspaceId === ref.id} onPress={() => setWorkspaceId(ref.id)} ctx={ctx} />
        ))}
      </View>
      {workspaceId ? <RequestComposer workspaceId={workspaceId} onDone={onClose} ctx={ctx} /> : <Muted text={ctx.t("requests.pickWorkspace")} ctx={ctx} />}
    </View>
  );
}

function WorkspaceChoice({ workspaceId, selected, onPress, ctx }: { workspaceId: string; selected: boolean; onPress(): void; ctx: ViewContext }) {
  const workspace = useWorkspace(workspaceId, (w) => ({ name: w.title ?? w.name, project: w.projectDisplayName }));
  if (!workspace) return null;
  return <ChoiceBox label={workspace.name} detail={workspace.project} selected={selected} onPress={onPress} theme={ctx.theme} />;
}

/**
 * 추가 요청. 진행 중인 워크스페이스에 맡길 일과, 에이전트가 범위 밖에서 발견해 남긴 제안이 워크스페이스마다 모인다.
 * 사람의 요청은 받을 에이전트가 쉴 때 순서대로 간다. 받기 전에는 취소할 수 있다. 제안은 보내거나 버린다.
 */
export function RequestsView({ ctx }: { ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const requests = (state?.requests ?? []).filter((item) => item.status !== "dismissed" && item.workspaceId);
  const open = requests.filter((item) => item.status === "queued" || item.status === "suggested");
  const byWorkspace = new Map<string, WorkRequest[]>();
  for (const item of requests) byWorkspace.set(item.workspaceId!, [...(byWorkspace.get(item.workspaceId!) ?? []), item]);
  // 열린 요청이 있는 워크스페이스가 먼저 온다.
  const order = [...byWorkspace.entries()].sort((a, b) => Number(b[1].some((item) => item.status !== "sent")) - Number(a[1].some((item) => item.status !== "sent")));
  return (
    <View style={{ gap: 16, maxWidth: 880 }}>
      <SectionHeader title={ctx.t("requests.title")} count={open.length} hint={ctx.t("requests.hint")} ctx={ctx} />
      <NewRequest ctx={ctx} />
      {order.length === 0 ? <Muted text={ctx.t("requests.empty")} ctx={ctx} /> : null}
      {order.map(([workspaceId, items]) => (
        <WorkspaceRequests key={workspaceId} workspaceId={workspaceId} requests={items} ctx={ctx} />
      ))}
    </View>
  );
}
