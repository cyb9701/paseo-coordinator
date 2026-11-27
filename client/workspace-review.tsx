import { useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type Decision, type PullRequest, type WorkspaceStatus, agentRequestsRpc, reviewDecisionsRpc } from "../shared/model";
import { type SentPart, readSentMessage } from "../shared/messages";
import { DecisionRow, DiffToggle } from "./decision-view";
import { formatAgo } from "./time";
import { Chip, CtaButton, ErrorLine, Fold, Muted, TextBox, type ViewContext } from "./ui";

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

/**
 * '요청받은 것'의 한 덩어리. 플러그인이 에이전트에게 보낸 메시지는 에이전트가 읽도록 영어로 길게 쓰여 있다. 그대로 보이면 사람이 시킨
 * 일이 그 글에 밀리므로, 무엇을 했는지 화면 언어 한 줄로 쓰고 사람이 쓴 말만 원문으로 붙인다.
 */
function SentPartView({ part, ctx }: { part: SentPart; ctx: ViewContext }) {
  const body = (text: string) => (
    <Text selectable numberOfLines={12} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
      {text}
    </Text>
  );
  const numbers = (list: readonly number[]) => list.map((number) => `#${number}`).join(", ");
  if (part.kind === "text") return body(part.text);
  if (part.kind === "request") {
    return (
      <View style={{ gap: 2 }}>
        <Muted text={ctx.t("review.sent.request")} ctx={ctx} />
        {body(part.text)}
      </View>
    );
  }
  if (part.kind === "ask") {
    return (
      <View style={{ gap: 2 }}>
        <Muted text={ctx.t("review.sent.ask")} ctx={ctx} />
        {body(part.text)}
      </View>
    );
  }
  if (part.kind === "answer") {
    const lines = part.choices.map((item) => `#${item.number} ${item.choice ? ctx.t("decision.answerChose", { option: item.choice }) : ctx.t("decision.answerAsProposed")}`);
    return (
      <View style={{ gap: 2 }}>
        <Muted text={ctx.t("review.sent.answer")} ctx={ctx} />
        {body(part.note ? `${lines.join("\n")}\n${part.note}` : lines.join("\n"))}
      </View>
    );
  }
  return (
    <View style={{ gap: 2 }}>
      <Muted text={ctx.t(part.kind === "revert" ? "review.sent.revert" : "review.sent.redo", { numbers: numbers(part.numbers) })} ctx={ctx} />
      {part.note ? body(part.note) : null}
    </View>
  );
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
          {readSentMessage(message.text).map((part, partIndex) => (
            <SentPartView key={partIndex} part={part} ctx={ctx} />
          ))}
        </View>
      ))}
      {messages.length > shown.length ? <Muted text={ctx.t("review.moreRequests", { count: messages.length - shown.length })} ctx={ctx} /> : null}
    </View>
  );
}

type Verdict = "revert" | "undo";

/**
 * 결정 줄의 버튼. 맞음은 그대로 둔다. 되돌리기는 그 결정으로 바뀐 것을 원래대로 돌리라고 보낸다(덧붙일 말은 골라서).
 * 바꿔서 다시는 사람이 쓴 방식으로 다시 하라고 보낸다. 이미 맞음으로 둔 결정도 나중에 되돌리거나 바꿀 수 있다.
 */
function ReviewActions({ decisions, ctx }: { decisions: readonly Decision[]; ctx: ViewContext }) {
  const call = useRpc(reviewDecisionsRpc);
  const review = useMutation({
    mutationFn: (input: { verdict: "approved" | Verdict; text: string | null }) => call({ decisionIds: decisions.map((item) => item.id), ...input }),
  });
  const [mode, setMode] = useState<Verdict | null>(null);
  const [text, setText] = useState("");
  const approvable = decisions.some((item) => item.status === "unreviewed");
  const many = decisions.length > 1;
  const toggle = (next: Verdict) => setMode((current) => (current === next ? null : next));
  return (
    <View style={{ gap: 8, alignItems: "flex-end" }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
        {approvable ? (
          <CtaButton
            label={many ? ctx.t("review.approveAll", { count: decisions.length }) : ctx.t("review.approve")}
            tone="primary"
            disabled={review.isPending}
            theme={ctx.theme}
            onPress={() => review.mutate({ verdict: "approved", text: null })}
          />
        ) : null}
        {many ? null : (
          <>
            <CtaButton label={ctx.t("review.revert")} disabled={review.isPending} theme={ctx.theme} onPress={() => toggle("revert")} />
            <CtaButton label={ctx.t("review.undo")} disabled={review.isPending} theme={ctx.theme} onPress={() => toggle("undo")} />
          </>
        )}
      </View>
      {mode ? (
        <View style={{ gap: 6, alignSelf: "stretch" }}>
          <TextBox
            value={text}
            onChange={setText}
            placeholder={mode === "revert" ? ctx.t("review.revertPlaceholder") : ctx.t("review.undoPlaceholder")}
            ctx={ctx}
            minHeight={56}
          />
          <View style={{ flexDirection: "row", gap: 6, justifyContent: "flex-end" }}>
            <CtaButton label={ctx.t("common.closeInstruct")} theme={ctx.theme} onPress={() => setMode(null)} />
            <CtaButton
              label={mode === "revert" ? ctx.t("review.sendRevert") : ctx.t("review.sendUndo")}
              tone="primary"
              disabled={review.isPending || (mode === "undo" && !text.trim())}
              theme={ctx.theme}
              onPress={() => review.mutate({ verdict: mode, text: text.trim() || null }, { onSuccess: () => { setMode(null); setText(""); } })}
            />
          </View>
        </View>
      ) : null}
      {review.data?.delivery === "queued" ? <Muted text={ctx.t("common.queued")} ctx={ctx} /> : null}
      <ErrorLine error={review.error} ctx={ctx} />
    </View>
  );
}

/**
 * 한 워크스페이스의 결정. 결정 하나가 한 줄이라 많아도 훑어볼 수 있다. 확인할 결정이 위에 오고, 지난 결정은 접어 둔다.
 * 이상한 줄만 펼쳐 근거와 diff 를 보고, 그 자리에서 맞음, 되돌리기, 바꿔서 다시를 고른다.
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
  const [showSettled, setShowSettled] = useState(false);
  const live = decisions.filter((item) => item.status !== "dropped");
  const unreviewed = live.filter((item) => item.status === "unreviewed");
  const waiting = live.filter((item) => item.status === "waiting");
  const settled = live.filter((item) => item.status !== "unreviewed" && item.status !== "waiting").reverse();
  const agentIds = [...new Set(live.map((item) => item.agentId))];
  const extra = unexplainedFiles(status, live);
  const sectionTitle = (text: string, color: string) => <Text style={{ color, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{text}</Text>;
  return (
    <View style={{ gap: 12 }}>
      {waiting.length ? <Muted text={ctx.t("review.waitingInInbox", { count: waiting.length })} ctx={ctx} /> : null}
      {unreviewed.length ? (
        <View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 6 }}>
            {sectionTitle(ctx.t("review.unreviewed", { count: unreviewed.length }), ctx.theme.colors.statusWarning)}
            <View style={{ flex: 1 }} />
            {unreviewed.length > 1 ? <ReviewActions decisions={unreviewed} ctx={ctx} /> : null}
          </View>
          {unreviewed.map((decision) => (
            <DecisionRow key={decision.id} decision={decision} showStatus={false} ctx={ctx} actions={<ReviewActions decisions={[decision]} ctx={ctx} />} />
          ))}
        </View>
      ) : null}
      {extra.length ? (
        <View style={{ gap: 4 }}>
          {sectionTitle(ctx.t("review.unexplained"), ctx.theme.colors.statusWarning)}
          <Muted text={live.length ? ctx.t("review.unexplainedHint", { count: extra.length }) : ctx.t("review.noDecisionsHint", { count: extra.length })} ctx={ctx} />
          <Text numberOfLines={2} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
            {extra.slice(0, 30).join(", ")}
          </Text>
          <DiffToggle workspaceId={workspaceId} files={extra.slice(0, 40)} ctx={ctx} />
        </View>
      ) : null}
      {status?.overlaps.length ? (
        <View style={{ gap: 4 }}>
          {sectionTitle(ctx.t("review.overlaps"), ctx.theme.colors.statusWarning)}
          {status.overlaps.map((item) => (
            <OverlapLine key={item.workspaceId} workspaceId={item.workspaceId} files={item.files} ctx={ctx} />
          ))}
        </View>
      ) : null}
      {settled.length ? (
        <View>
          <View style={{ flexDirection: "row", paddingBottom: 6 }}>
            <CtaButton
              size="sm"
              label={showSettled ? `▾ ${ctx.t("review.hideSettled")}` : `▸ ${ctx.t("review.showSettled", { count: settled.length })}`}
              theme={ctx.theme}
              onPress={() => setShowSettled((value) => !value)}
            />
          </View>
          {showSettled
            ? settled.map((decision) => (
                <DecisionRow
                  key={decision.id}
                  decision={decision}
                  ctx={ctx}
                  actions={decision.status === "approved" ? <ReviewActions decisions={[decision]} ctx={ctx} /> : undefined}
                />
              ))
            : null}
        </View>
      ) : null}
      {agentIds.length ? <Fold ctx={ctx} items={[{ label: ctx.t("review.requests"), count: agentIds.length, content: agentIds.map((id) => <AgentRequests key={id} agentId={id} ctx={ctx} />) }]} /> : null}
      {!live.length && !extra.length ? <Muted text={ctx.t("review.empty")} ctx={ctx} /> : null}
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
