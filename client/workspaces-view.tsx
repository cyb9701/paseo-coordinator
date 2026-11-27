import type { WorkspaceRef } from "@getpaseo/plugin/client";
import { useAgent, useAgents, useSettings, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Decision, WorkspaceStatus } from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { isVisibleAgent, stateColor } from "./agent-state";
import { statusOf, useCoordinatorState, useWorkspaceStatuses } from "./coordinator-state";
import { useClassifier } from "./pending-store";
import { shortPath } from "./workspace-place";
import { PullRequestLine, WorkspaceReview, unexplainedFiles } from "./workspace-review";
import { formatAgo } from "./time";
import { Card, CtaButton, ErrorLine, Muted, ProjectTag, SectionHeader, type ViewContext } from "./ui";

const NO_DECISIONS: readonly Decision[] = [];

function AgentDot({ agentId, ctx }: { agentId: string; ctx: ViewContext }) {
  const classify = useClassifier();
  const agent = useAgent(agentId, (a) => ({ id: a.id, title: a.title, status: a.status, attentionReason: a.attentionReason, requiresAttention: a.requiresAttention, hostId: a.hostId }));
  if (!agent) return null;
  const state = classify.state(agent);
  const label = `${agent.title ?? ctx.t("common.untitledAgent")} · ${ctx.t(`states.${state}`)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={ctx.t("common.openNamed", { name: label })}
      disabled={!ctx.navigation}
      onPress={() => ctx.navigation?.openAgent({ agentId, serverId: agent.hostId })}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: stateColor(state, ctx.theme) }} />
      <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, flexShrink: 1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * 워크스페이스 한 줄. 사람이 여러 워크스페이스를 돌아보지 않아도 어디를 열어야 하는지 알 수 있게, 멈춘 결정, 확인하지 않은 결정,
 * 결정에 없는 변경, 다른 워크스페이스와 겹침, PR 상태를 한 줄에 모은다. 누르면 판단 흐름(WorkspaceReview)이 펼쳐진다.
 */
function WorkspaceRow({ workspaceRef, status, decisions, ctx }: { workspaceRef: WorkspaceRef; status: WorkspaceStatus | null; decisions: readonly Decision[]; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  const workspace = useWorkspace(workspaceRef, (w) => ({ title: w.title ?? w.name, branch: w.branch, directory: w.directory, diff: w.diffStat, lastPromptAt: w.lastPromptAt }));
  // 하위 에이전트는 부모가 같은 워크스페이스에 있으면 부모 줄로 충분하다. 다른 워크스페이스나 다른 에이전트가 띄운 경우에는 보인다.
  const inWorkspace = useAgents({ hosts: [ctx.hostId], where: (a) => a.workspaceId === workspaceRef.id && isVisibleAgent(a), orderBy: ["lastActivityAt", "desc"] });
  const ids = new Set(inWorkspace.map((ref) => ref.id));
  const agents = useAgents({
    hosts: [ctx.hostId],
    where: (a) => a.workspaceId === workspaceRef.id && isVisibleAgent(a) && (a.parentAgentId === null || !ids.has(a.parentAgentId)),
    orderBy: ["lastActivityAt", "desc"],
  });
  if (!workspace) return null;
  const mine = decisions;
  const waiting = mine.filter((item) => item.status === "waiting").length;
  const unreviewed = mine.filter((item) => item.status === "unreviewed").length;
  const extra = unexplainedFiles(status, mine).length;
  const overlaps = status?.overlaps ?? [];
  const pr = status?.pullRequest;
  // 머지되거나 닫힌 PR 의 체크 실패와 충돌은 더 할 일이 없다.
  const prOpen = Boolean(pr && !pr.isMerged && pr.state.toLowerCase() === "open");
  const attention = waiting > 0 || (prOpen && (pr?.checks === "failure" || pr?.mergeable === "CONFLICTING"));
  const color = attention ? ctx.theme.colors.statusDanger : unreviewed || extra || overlaps.length ? ctx.theme.colors.statusWarning : ctx.theme.colors.border;
  return (
    <Card color={color} ctx={ctx}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>{workspace.title}</Text>
        {workspace.branch ? <Muted text={workspace.branch} ctx={ctx} /> : null}
        {workspace.diff ? <Muted text={`+${workspace.diff.additions} −${workspace.diff.deletions}`} ctx={ctx} /> : null}
        <View style={{ flex: 1 }} />
        {workspace.lastPromptAt ? <Muted text={formatAgo(workspace.lastPromptAt, ctx.now, ctx.t)} ctx={ctx} /> : null}
      </View>
      {workspace.directory ? (
        <Text numberOfLines={1} ellipsizeMode="head" selectable style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {shortPath(workspace.directory)}
        </Text>
      ) : null}
      {agents.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4 }}>
          {agents.map((ref) => (
            <AgentDot key={ref.key} agentId={ref.id} ctx={ctx} />
          ))}
        </View>
      ) : null}
      {status?.pullRequest ? <PullRequestLine pr={status.pullRequest} ctx={ctx} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        {waiting ? <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("board.waiting", { count: waiting })}</Text> : null}
        {unreviewed ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("board.unreviewed", { count: unreviewed })}</Text> : null}
        {extra ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("board.unexplained", { count: extra })}</Text> : null}
        {overlaps.length ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("board.overlaps", { count: overlaps.length })}</Text> : null}
        {status?.changedFiles.length ? <Muted text={ctx.t("board.changed", { count: status.changedFiles.length })} ctx={ctx} /> : null}
        {status?.error ? <Muted text={status.error} ctx={ctx} /> : null}
        <View style={{ flex: 1 }} />
        <CtaButton size="sm" label={open ? `▾ ${ctx.t("board.close")}` : `▸ ${ctx.t("board.review")}`} theme={ctx.theme} onPress={() => setOpen((value) => !value)} />
      </View>
      {open ? <WorkspaceReview workspaceId={workspaceRef.id} decisions={mine} status={status} ctx={ctx} /> : null}
    </Card>
  );
}

/** 지켜보는 프로젝트의 워크스페이스. 프로젝트마다 묶는다. 겹침은 같은 프로젝트 안에서만 생기기 때문이다. */
export function WorkspacesView({ ctx }: { ctx: ViewContext }) {
  const settings = useSettings(coordinatorSettings);
  const projectIds = settings.status === "ready" ? settings.values.projectIds : [];
  const { state } = useCoordinatorState();
  const statuses = useWorkspaceStatuses(ctx.hostId);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await statuses.refresh().catch(() => undefined);
    setRefreshing(false);
  };
  // 줄마다 전체 결정을 거르지 않게 워크스페이스별로 한 번 묶는다.
  const byWorkspace = useMemo(() => {
    const groups = new Map<string, Decision[]>();
    for (const item of state?.decisions ?? []) groups.set(item.workspaceId, [...(groups.get(item.workspaceId) ?? []), item]);
    return groups;
  }, [state?.decisions]);
  const groups = useWorkspaces({
    hosts: [ctx.hostId],
    where: (w) => projectIds.includes(w.projectId) && !w.background && !w.archivingAt,
    orderBy: ["lastPromptAt", "desc"],
    groupBy: (w) => ({ key: w.projectId, title: w.projectDisplayName }),
  });
  const count = groups.reduce((total, group) => total + group.items.length, 0);
  if (settings.status === "ready" && projectIds.length === 0) return <Muted text={ctx.t("board.noProjects")} ctx={ctx} />;
  return (
    <View style={{ gap: 20, maxWidth: 960 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <SectionHeader title={ctx.t("board.title")} count={count} hint={ctx.t("board.hint")} ctx={ctx} />
        <View style={{ flex: 1 }} />
        {statuses.data ? <Muted text={ctx.t("board.checked", { ago: formatAgo(statuses.data.at, ctx.now, ctx.t) })} ctx={ctx} /> : null}
        <CtaButton size="sm" label={ctx.t("board.refresh")} disabled={refreshing} theme={ctx.theme} onPress={() => void refresh()} />
      </View>
      <ErrorLine error={statuses.error} ctx={ctx} />
      {count === 0 ? <Muted text={ctx.t("board.empty")} ctx={ctx} /> : null}
      {groups.map((group) => (
        <View key={group.key} style={{ gap: 8 }}>
          <ProjectTag label={group.title ?? group.key} theme={ctx.theme} />
          {group.items.map((ref) => (
            <WorkspaceRow key={ref.key} workspaceRef={ref} status={statusOf(statuses.data?.workspaces, ref.id)} decisions={byWorkspace.get(ref.id) ?? NO_DECISIONS} ctx={ctx} />
          ))}
        </View>
      ))}
    </View>
  );
}
