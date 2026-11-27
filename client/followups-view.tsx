import { useAgent, useAgents, useProject, useProjects, useRpc, useSettings, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import type { ProjectRef } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type Followup, addFollowupRpc, sendFollowupRpc, updateFollowupRpc } from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { isVisibleAgent } from "./agent-state";
import { useCoordinatorState } from "./coordinator-state";
import { formatAgo } from "./time";
import { Card, ChoiceBox, CtaButton, ErrorLine, Muted, ProjectTag, SectionHeader, TextBox, type ViewContext } from "./ui";

function ProjectLabel({ projectRef, ctx }: { projectRef: ProjectRef; ctx: ViewContext }) {
  const name = useProject(projectRef, (p) => p.displayName);
  return <ProjectTag label={name ?? projectRef.id} theme={ctx.theme} />;
}

function AgentName({ agentId, ctx }: { agentId: string; ctx: ViewContext }) {
  const title = useAgent(agentId, (a) => a.title);
  return <Muted text={title ?? ctx.t("common.untitledAgent")} ctx={ctx} />;
}

function AgentOption({ agentId, selected, onPress, ctx }: { agentId: string; selected: boolean; onPress(): void; ctx: ViewContext }) {
  const agent = useAgent(agentId, (a) => ({ title: a.title, workspaceId: a.workspaceId }));
  const workspace = useWorkspace(agent?.workspaceId ?? "", (w) => w.title ?? w.name);
  if (!agent) return null;
  return <ChoiceBox label={agent.title ?? ctx.t("common.untitledAgent")} detail={workspace} selected={selected} onPress={onPress} theme={ctx.theme} />;
}

/** 넘길 에이전트 고르기. 펼칠 때만 그린다. 카드마다 워크스페이스·에이전트 목록을 늘 구독하면 후속 작업이 많을 때 비싸다. */
function AgentPicker({ projectId, busy, onSend, ctx }: { projectId: string | null; busy: boolean; onSend(agentId: string): void; ctx: ViewContext }) {
  const [target, setTarget] = useState<string | null>(null);
  const workspaces = useWorkspaces({
    hosts: [ctx.hostId],
    where: (w) => !w.background && !w.archivingAt && (!projectId || w.projectId === projectId),
  });
  const workspaceIds = new Set(workspaces.map((ref) => ref.id));
  const candidates = useAgents({
    hosts: [ctx.hostId],
    where: (a) => isVisibleAgent(a) && a.parentAgentId === null && a.status !== "closed" && workspaceIds.has(a.workspaceId),
    orderBy: ["lastActivityAt", "desc"],
  });
  return (
    <View style={{ gap: 8 }}>
      <Muted text={ctx.t("followups.pickAgent")} ctx={ctx} />
      <View style={{ gap: 6 }}>
        {candidates.slice(0, 12).map((ref) => (
          <AgentOption key={ref.key} agentId={ref.id} selected={target === ref.id} onPress={() => setTarget(ref.id)} ctx={ctx} />
        ))}
      </View>
      <View style={{ flexDirection: "row" }}>
        <CtaButton label={ctx.t("followups.send")} tone="primary" disabled={!target || busy} theme={ctx.theme} onPress={() => target && onSend(target)} />
      </View>
    </View>
  );
}

/**
 * 후속 작업 하나. 플러그인은 일을 배정하지 않는다. 사람이 고른 에이전트에게 넘기거나, 사람이 새 워크스페이스를 만들어 시작한다.
 * 넘길 에이전트는 같은 프로젝트에서 고른다. 다른 프로젝트의 에이전트는 그 저장소를 모른다.
 */
function FollowupCard({ followup, ctx }: { followup: Followup; ctx: ViewContext }) {
  const update = useRpc(updateFollowupRpc);
  const send = useRpc(sendFollowupRpc);
  const change = useMutation({ mutationFn: (status: Followup["status"]) => update({ id: followup.id, status }) });
  const handOff = useMutation({ mutationFn: (agentId: string) => send({ id: followup.id, agentId }) });
  const [picking, setPicking] = useState(false);
  const workspace = useWorkspace(followup.workspaceId ?? "", (w) => w.title ?? w.name);
  return (
    <Card color={ctx.theme.colors.accent} ctx={ctx}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Muted text={followup.source === "agent" ? ctx.t("followups.fromAgent") : ctx.t("followups.fromYou")} ctx={ctx} />
        {followup.agentId ? <AgentName agentId={followup.agentId} ctx={ctx} /> : null}
        {workspace ? <Muted text={`· ${workspace}`} ctx={ctx} /> : null}
        <View style={{ flex: 1 }} />
        <Muted text={formatAgo(followup.at, ctx.now, ctx.t)} ctx={ctx} />
      </View>
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
        {followup.text}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={picking ? ctx.t("common.closeInstruct") : ctx.t("followups.handOff")} theme={ctx.theme} onPress={() => setPicking((value) => !value)} />
        <CtaButton label={ctx.t("followups.done")} disabled={change.isPending} theme={ctx.theme} onPress={() => change.mutate("done")} />
        <CtaButton label={ctx.t("followups.dismiss")} disabled={change.isPending} theme={ctx.theme} onPress={() => change.mutate("dismissed")} />
      </View>
      {picking ? <AgentPicker projectId={followup.projectId} busy={handOff.isPending} onSend={(agentId) => handOff.mutate(agentId)} ctx={ctx} /> : null}
      <ErrorLine error={change.error ?? handOff.error} ctx={ctx} />
    </Card>
  );
}

function AddFollowup({ ctx }: { ctx: ViewContext }) {
  const add = useRpc(addFollowupRpc);
  const settings = useSettings(coordinatorSettings);
  const projectIds = settings.status === "ready" ? settings.values.projectIds : [];
  const projects = useProjects({ hosts: [ctx.hostId], where: (p) => projectIds.includes(p.ref.id), orderBy: "displayName" });
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const save = useMutation({ mutationFn: () => add({ text: text.trim(), projectId, workspaceId: null }), onSuccess: () => setText("") });
  return (
    <View style={{ gap: 8 }}>
      <TextBox value={text} onChange={setText} placeholder={ctx.t("followups.placeholder")} ctx={ctx} minHeight={56} />
      {projects.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {projects.map((ref) => (
            <ProjectPick key={ref.key} projectRef={ref} selected={projectId === ref.id} onPress={() => setProjectId(projectId === ref.id ? null : ref.id)} ctx={ctx} />
          ))}
        </View>
      ) : null}
      <View style={{ flexDirection: "row" }}>
        <CtaButton label={ctx.t("followups.add")} tone="primary" disabled={!text.trim() || save.isPending} theme={ctx.theme} onPress={() => save.mutate()} />
      </View>
      <ErrorLine error={save.error} ctx={ctx} />
    </View>
  );
}

function ProjectPick({ projectRef, selected, onPress, ctx }: { projectRef: ProjectRef; selected: boolean; onPress(): void; ctx: ViewContext }) {
  const name = useProject(projectRef, (p) => p.displayName);
  return <ChoiceBox label={name ?? projectRef.id} selected={selected} onPress={onPress} theme={ctx.theme} />;
}

/** 에이전트가 add_followup 으로 남긴 일과 사람이 적은 일. 프로젝트마다 묶어 다음에 무엇을 시작할지 고르게 한다. */
export function FollowupsView({ ctx }: { ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const open = (state?.followups ?? []).filter((item) => item.status === "open").sort((a, b) => b.at.localeCompare(a.at));
  const projects = useProjects({ hosts: [ctx.hostId] });
  const byProject = new Map<string, Followup[]>();
  for (const item of open) byProject.set(item.projectId ?? "", [...(byProject.get(item.projectId ?? "") ?? []), item]);
  return (
    <View style={{ gap: 16, maxWidth: 880 }}>
      <SectionHeader title={ctx.t("followups.title")} count={open.length} hint={ctx.t("followups.hint")} ctx={ctx} />
      <AddFollowup ctx={ctx} />
      {open.length === 0 ? <Muted text={ctx.t("followups.empty")} ctx={ctx} /> : null}
      {[...byProject.entries()].map(([projectId, items]) => {
        const ref = projects.find((item) => item.id === projectId);
        return (
          <View key={projectId || "none"} style={{ gap: 8 }}>
            {ref ? <ProjectLabel projectRef={ref} ctx={ctx} /> : <ProjectTag label={ctx.t("followups.noProject")} theme={ctx.theme} />}
            {items.map((item) => (
              <FollowupCard key={item.id} followup={item} ctx={ctx} />
            ))}
          </View>
        );
      })}
    </View>
  );
}
