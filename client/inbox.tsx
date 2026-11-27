import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { useAgents, useWorkspace } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { type Decision, openDecisions, unreviewedDecisions } from "../shared/model";
import { reactionCount, statusOf, useCoordinatorState, useWorkspaceStatuses } from "./coordinator-state";
import { AgentAttention } from "./permission-cards";
import { useClassifier, usePending } from "./pending-store";
import { WorkspaceProjectChip } from "./project-chip";
import { StoppedCard } from "./stopped-card";
import { WorkspaceReview } from "./workspace-review";
import { Card, Muted, SectionHeader, type ViewContext } from "./ui";

function oldestFirst(a: PluginAgentSnapshot, b: PluginAgentSnapshot): number {
  return Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.entries()];
}

/** 확인 필요 카드: 한 워크스페이스에서 에이전트가 기록하고 진행한 결정들. 판단 흐름을 그대로 펼쳐 보인다. */
function ReviewCard({ workspaceId, decisions, ctx }: { workspaceId: string; decisions: readonly Decision[]; ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const statuses = useWorkspaceStatuses(ctx.hostId);
  const name = useWorkspace(workspaceId, (w) => w.title ?? w.name);
  const all = (state?.decisions ?? []).filter((item) => item.workspaceId === workspaceId);
  return (
    <Card color={ctx.theme.colors.statusWarning} ctx={ctx}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <WorkspaceProjectChip workspaceId={workspaceId} ctx={ctx} />
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>{name ?? workspaceId}</Text>
        <View style={{ flex: 1 }} />
        <Muted text={ctx.t("inbox.reviewCount", { count: decisions.length })} ctx={ctx} />
      </View>
      <WorkspaceReview workspaceId={workspaceId} decisions={all} status={statusOf(statuses.data?.workspaces, workspaceId)} ctx={ctx} />
    </Card>
  );
}

/**
 * 인박스. 내 결정 필요는 일이 멈춰 사람을 기다리는 것(멈춘 결정, 권한 요청, 질문, 에러)이고 카드에서 바로 답한다.
 * 확인 필요는 에이전트가 기록하고 진행한 결정이라 일은 멈추지 않았다. 워크스페이스마다 몰아서 확인한다.
 */
export function InboxView({ ctx }: { ctx: ViewContext }) {
  const classify = useClassifier();
  const directory = usePending();
  const reacting = useAgents({ hosts: [ctx.hostId], where: (agent) => classify.needsMyDecision(agent), orderBy: oldestFirst });
  const { state } = useCoordinatorState();
  const stopped = state ? groupBy(openDecisions(state), (item) => item.agentId).sort((a, b) => a[1][0]!.at.localeCompare(b[1][0]!.at)) : [];
  const review = state ? groupBy(unreviewedDecisions(state), (item) => item.workspaceId).sort((a, b) => a[1][0]!.at.localeCompare(b[1][0]!.at)) : [];
  const stoppedAgents = new Set(stopped.map(([agentId]) => agentId));
  const reactCount = reactionCount(state, reacting.map((ref) => ref.id), directory);
  const reviewCount = review.reduce((total, [, items]) => total + items.length, 0);
  return (
    <View style={{ gap: 20, maxWidth: 880 }}>
      <View style={{ gap: 10 }}>
        <SectionHeader title={ctx.t("inbox.react")} count={reactCount} hint={ctx.t("inbox.reactHint")} color={ctx.theme.colors.statusDanger} ctx={ctx} />
        {reactCount === 0 ? <Muted text={ctx.t("inbox.nothingBlocked")} ctx={ctx} /> : null}
        {stopped.map(([agentId, decisions]) => (
          <StoppedCard key={agentId} agentId={agentId} decisions={decisions} ctx={ctx} />
        ))}
        {reacting.map((ref) => (
          <AgentAttention key={ref.key} agentRef={ref} folded={stoppedAgents.has(ref.id)} ctx={ctx} />
        ))}
      </View>
      <View style={{ gap: 10 }}>
        <SectionHeader title={ctx.t("inbox.review")} count={reviewCount} hint={ctx.t("inbox.reviewHint")} color={ctx.theme.colors.statusWarning} ctx={ctx} />
        {reviewCount === 0 ? <Muted text={ctx.t("inbox.nothingToReview")} ctx={ctx} /> : null}
        {review.map(([workspaceId, decisions]) => (
          <ReviewCard key={workspaceId} workspaceId={workspaceId} decisions={decisions} ctx={ctx} />
        ))}
      </View>
    </View>
  );
}
