import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import { useAgents } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { Decision } from "../shared/model";
import { inboxGroups, questionJudgments, reactionCount } from "./attention";
import { CoordinatorBar, QuestionJudgmentCard, ReportCard, ReviewJudgmentCard } from "./coordinator-view";
import { statusOf, useCoordinatorState, useWorkspaceStatuses } from "./coordinator-state";
import { AgentAttention } from "./permission-cards";
import { useClassifier, usePending } from "./pending-store";
import { CardTop } from "./project-chip";
import { formatAgo } from "./time";
import { StoppedCard } from "./stopped-card";
import { WorkspaceReview } from "./workspace-review";
import { Card, Muted, SectionHeader, type ViewContext } from "./ui";

function oldestFirst(a: PluginAgentSnapshot, b: PluginAgentSnapshot): number {
  return Date.parse(a.lastActivityAt) - Date.parse(b.lastActivityAt);
}

/** 확인 필요 카드: 한 워크스페이스에서 에이전트가 기록하고 진행한 결정들. 판단 흐름을 그대로 펼쳐 보인다. */
function ReviewCard({ workspaceId, decisions, ctx }: { workspaceId: string; decisions: readonly Decision[]; ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const statuses = useWorkspaceStatuses(ctx.hostId);
  const all = (state?.decisions ?? []).filter((item) => item.workspaceId === workspaceId);
  // 결정마다 에이전트가 다를 수 있어 머리에 에이전트 줄은 두지 않는다. 시간은 가장 오래 기다린 결정 기준이다.
  const oldest = decisions.reduce((min, item) => (item.at < min ? item.at : min), decisions[0]?.at ?? new Date().toISOString());
  return (
    <Card color={ctx.theme.colors.statusWarning} ctx={ctx}>
      <CardTop
        kind={ctx.t("inbox.reviewCount", { count: decisions.length })}
        color={ctx.theme.colors.statusWarning}
        workspaceId={workspaceId}
        right={formatAgo(oldest, ctx.now, ctx.t)}
        ctx={ctx}
      />
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
  const { stopped, review, checks, reports } = inboxGroups(state);
  const stoppedAgents = new Set(stopped.map(([agentId]) => agentId));
  const reactingIds = reacting.map((ref) => ref.id);
  const reactCount = reactionCount(state, reactingIds, directory);
  const questions = state ? questionJudgments(state, new Set(reactingIds)) : [];
  const reviewCount = review.reduce((total, [, items]) => total + items.length, 0) + checks.length + reports.length;
  return (
    <View style={{ gap: 20, maxWidth: 880 }}>
      <CoordinatorBar ctx={ctx} />
      <View style={{ gap: 10 }}>
        <SectionHeader title={ctx.t("inbox.react")} count={reactCount} hint={ctx.t("inbox.reactHint")} color={ctx.theme.colors.statusDanger} ctx={ctx} />
        {reactCount === 0 ? <Muted text={ctx.t("inbox.nothingBlocked")} ctx={ctx} /> : null}
        {stopped.map(([agentId, decisions]) => (
          <StoppedCard key={agentId} agentId={agentId} decisions={decisions} ctx={ctx} />
        ))}
        {reacting.map((ref) => (
          <AgentAttention key={ref.key} agentRef={ref} folded={stoppedAgents.has(ref.id)} ctx={ctx} />
        ))}
        {questions.map((judgment) => (
          <QuestionJudgmentCard key={`${judgment.agentId}:${judgment.evidenceId}`} judgment={judgment} ctx={ctx} />
        ))}
      </View>
      <View style={{ gap: 10 }}>
        <SectionHeader title={ctx.t("inbox.review")} count={reviewCount} hint={ctx.t("inbox.reviewHint")} color={ctx.theme.colors.statusWarning} ctx={ctx} />
        {reviewCount === 0 ? <Muted text={ctx.t("inbox.nothingToReview")} ctx={ctx} /> : null}
        {reports.map((report) => (
          <ReportCard key={report.id} report={report} ctx={ctx} />
        ))}
        {checks.map((judgment) => (
          <ReviewJudgmentCard key={`${judgment.agentId}:${judgment.evidenceId}`} judgment={judgment} ctx={ctx} />
        ))}
        {review.map(([workspaceId, decisions]) => (
          <ReviewCard key={workspaceId} workspaceId={workspaceId} decisions={decisions} ctx={ctx} />
        ))}
      </View>
    </View>
  );
}
