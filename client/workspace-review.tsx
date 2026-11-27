import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type Decision, type PullRequest, type WorkspaceStatus, agentRequestsRpc, reviewDecisionsRpc } from "../shared/model";
import { DecisionItem, DiffToggle } from "./decision-view";
import { formatAgo } from "./time";
import { Body, Chip, CtaButton, ErrorLine, Fold, InstructionBox, Muted, Row, type ViewContext } from "./ui";

/** PR 상태 한 줄. Paseo 가 워크스페이스에 붙여 준 GitHub 정보를 읽기만 한다. 머지는 사람이 GitHub 이나 Paseo 에서 한다. */
export function PullRequestLine({ pr, ctx }: { pr: PullRequest; ctx: ViewContext }) {
  const parts: { label: string; color: string }[] = [];
  // 머지 > 닫힘 > 초안 > 열림 순서다. 닫힌 초안을 '초안'으로 보이면 아직 진행 중인 것처럼 읽힌다.
  const raw = pr.state.toLowerCase();
  const state = pr.isMerged ? "merged" : raw === "closed" ? "closed" : pr.isDraft ? "draft" : raw;
  const open = !pr.isMerged && raw === "open";
  parts.push({ label: ctx.t(`pr.state.${state === "open" || state === "closed" || state === "merged" || state === "draft" ? state : "other"}`, { state: pr.state }), color: pr.isMerged ? ctx.theme.colors.statusSuccess : ctx.theme.colors.accent });
  if (open) {
    if (pr.checks === "failure") parts.push({ label: ctx.t("pr.checksFailed", { names: pr.failedChecks.slice(0, 3).join(", ") }), color: ctx.theme.colors.statusDanger });
    else if (pr.checks === "pending") parts.push({ label: ctx.t("pr.checksPending"), color: ctx.theme.colors.statusWarning });
    else if (pr.checks === "success") parts.push({ label: ctx.t("pr.checksPassed"), color: ctx.theme.colors.statusSuccess });
    if (pr.mergeable === "CONFLICTING") parts.push({ label: ctx.t("pr.conflicting"), color: ctx.theme.colors.statusDanger });
    if (pr.reviewDecision === "changes_requested") parts.push({ label: ctx.t("pr.changesRequested"), color: ctx.theme.colors.statusDanger });
    else if (pr.reviewDecision === "approved") parts.push({ label: ctx.t("pr.approved"), color: ctx.theme.colors.statusSuccess });
  }
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>
        {pr.number ? `PR #${pr.number}` : "PR"}
      </Text>
      {parts.map((part) => (
        <Chip key={part.label} label={part.label} color={part.color} theme={ctx.theme} />
      ))}
    </View>
  );
}

/** 어느 결정에도 적히지 않은 변경 파일. 에이전트가 기록하지 않고 내린 판단이 숨어 있을 수 있는 곳이다. */
export function unexplainedFiles(status: WorkspaceStatus | null, decisions: readonly Decision[]): string[] {
  if (!status) return [];
  // 답을 기다리는 결정은 아직 구현되지 않았다. 그 파일이 바뀌었다면 결정이 설명하는 변경이 아니다.
  const covered = new Set(decisions.filter((item) => item.status !== "dropped" && item.status !== "waiting").flatMap((item) => item.files));
  return status.changedFiles.filter((file) => !covered.has(file));
}

function AgentRequests({ agentId, ctx }: { agentId: string; ctx: ViewContext }) {
  const call = useRpc(agentRequestsRpc);
  const query = useQuery({ queryKey: ["coordinator", "requests", ctx.hostId, agentId], queryFn: () => call({ agentId }), staleTime: 60_000 });
  if (query.isPending) return <Muted text={ctx.t("common.loading")} ctx={ctx} />;
  if (query.error) return <ErrorLine error={query.error} ctx={ctx} />;
  const messages = query.data.messages;
  if (!messages.length) return <Muted text={ctx.t("review.noRequest")} ctx={ctx} />;
  // 첫 요청과 마지막 몇 개. 결정이 어떤 지시에서 나왔는지 보는 데는 그 둘이면 된다.
  const shown = messages.length > 4 ? [messages[0]!, ...messages.slice(-3)] : messages;
  return (
    <View style={{ gap: 6 }}>
      {shown.map((message, index) => (
        <View key={index} style={{ gap: 2 }}>
          {message.at ? <Muted text={formatAgo(message.at, ctx.now, ctx.t)} ctx={ctx} /> : null}
          <Text selectable numberOfLines={12} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
            {message.text}
          </Text>
        </View>
      ))}
      {messages.length > shown.length ? <Muted text={ctx.t("review.moreRequests", { count: messages.length - shown.length })} ctx={ctx} /> : null}
    </View>
  );
}

/** 확인 버튼. 이미 승인한 결정은 나중에 틀린 것을 알았을 때를 위해 되돌리기만 남긴다. */
function ReviewActions({ decisions, ctx, undoOnly = false }: { decisions: readonly Decision[]; ctx: ViewContext; undoOnly?: boolean }) {
  const call = useRpc(reviewDecisionsRpc);
  const review = useMutation({
    mutationFn: (input: { verdict: "approved" | "undo"; text: string | null }) => call({ decisionIds: decisions.map((item) => item.id), ...input }),
  });
  const [undoing, setUndoing] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {undoOnly ? null : (
          <CtaButton
            label={decisions.length > 1 ? ctx.t("review.approveAll", { count: decisions.length }) : ctx.t("review.approve")}
            tone="primary"
            disabled={review.isPending}
            theme={ctx.theme}
            onPress={() => review.mutate({ verdict: "approved", text: null })}
          />
        )}
        <CtaButton
          label={undoing ? ctx.t("common.closeInstruct") : ctx.t("review.undo")}
          disabled={review.isPending}
          theme={ctx.theme}
          onPress={() => setUndoing((value) => !value)}
        />
      </View>
      {undoing ? (
        <InstructionBox
          placeholder={ctx.t("review.undoPlaceholder")}
          submitLabel={ctx.t("review.sendUndo")}
          busy={review.isPending}
          ctx={ctx}
          onSubmit={(text) => review.mutateAsync({ verdict: "undo", text }).then(() => setUndoing(false))}
        />
      ) : null}
      {review.data?.delivery === "queued" ? <Muted text={ctx.t("common.queued")} ctx={ctx} /> : null}
      <ErrorLine error={review.error} ctx={ctx} />
    </View>
  );
}

/**
 * 한 워크스페이스의 판단 흐름: 무엇을 요청받았는지 → 에이전트가 내린 결정(근거, 가정, diff) → 어느 결정에도 없는 변경.
 * 사람은 이 순서로 읽으며 에이전트의 판단이 요청과 맞는지 확인한다. 확인하지 않은 결정은 여기서 승인하거나 되돌리게 한다.
 */
export function WorkspaceReview({
  workspaceId,
  decisions,
  status,
  ctx,
}: {
  workspaceId: string;
  decisions: readonly Decision[];
  status: WorkspaceStatus | null;
  ctx: ViewContext;
}) {
  const names = useWorkspace(workspaceId, (w) => ({ title: w.title ?? w.name }));
  const [showAll, setShowAll] = useState(false);
  const live = decisions.filter((item) => item.status !== "dropped");
  const unreviewed = live.filter((item) => item.status === "unreviewed");
  const settled = live.filter((item) => item.status !== "unreviewed" && item.status !== "waiting");
  const agentIds = [...new Set(live.map((item) => item.agentId))];
  const extra = unexplainedFiles(status, live);
  return (
    <View style={{ gap: 12 }}>
      {agentIds.length ? (
        <Fold
          ctx={ctx}
          items={[{ label: ctx.t("review.requests"), count: agentIds.length, content: agentIds.map((id) => <AgentRequests key={id} agentId={id} ctx={ctx} />) }]}
        />
      ) : null}
      {unreviewed.length ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.body, fontWeight: "600" }}>
            {ctx.t("review.unreviewed", { count: unreviewed.length })}
          </Text>
          {unreviewed.map((decision) => (
            <DecisionItem key={decision.id} decision={decision} ctx={ctx} actions={<ReviewActions decisions={[decision]} ctx={ctx} />} />
          ))}
          {unreviewed.length > 1 ? <ReviewActions decisions={unreviewed} ctx={ctx} /> : null}
        </View>
      ) : null}
      {extra.length ? (
        <Row label={ctx.t("review.unexplained")} ctx={ctx}>
          <Body text={ctx.t("review.unexplainedHint", { count: extra.length })} ctx={ctx} />
          <Muted text={extra.slice(0, 30).join(", ")} ctx={ctx} />
          <DiffToggle workspaceId={workspaceId} files={extra.slice(0, 40)} ctx={ctx} />
        </Row>
      ) : null}
      {status?.overlaps.length ? (
        <Row label={ctx.t("review.overlaps")} ctx={ctx}>
          {status.overlaps.map((item) => (
            <OverlapLine key={item.workspaceId} workspaceId={item.workspaceId} files={item.files} ctx={ctx} />
          ))}
        </Row>
      ) : null}
      {settled.length ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row" }}>
            <CtaButton
              size="sm"
              label={showAll ? `▾ ${ctx.t("review.hideSettled")}` : `▸ ${ctx.t("review.showSettled", { count: settled.length })}`}
              theme={ctx.theme}
              onPress={() => setShowAll((value) => !value)}
            />
          </View>
          {showAll ? settled.map((decision) => <DecisionItem key={decision.id} decision={decision} ctx={ctx} actions={decision.status === "approved" ? <ReviewActions decisions={[decision]} ctx={ctx} undoOnly /> : undefined} />) : null}
        </View>
      ) : null}
      {!live.length && !extra.length ? <Muted text={ctx.t("review.empty", { name: names?.title ?? "" })} ctx={ctx} /> : null}
    </View>
  );
}

function OverlapLine({ workspaceId, files, ctx }: { workspaceId: string; files: readonly string[]; ctx: ViewContext }) {
  const name = useWorkspace(workspaceId, (w) => w.title ?? w.name);
  return (
    <Text selectable style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
      {`⚠ ${name ?? workspaceId}: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` +${files.length - 10}` : ""}`}
    </Text>
  );
}
