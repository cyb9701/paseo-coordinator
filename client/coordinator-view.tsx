import { useAgent, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type FactAnswer,
  type Judgment,
  type Report,
  coordinatorDigestRpc,
  coordinatorSendRpc,
  judgmentDismissRpc,
  judgmentReplyRpc,
  reportCloseRpc,
} from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { useCoordinatorState } from "./coordinator-state";
import { DiffToggle } from "./decision-view";
import { useT } from "./i18n";
import { type CardAgent, CardHead, OpenAgentButton } from "./permission-cards";
import { toAgentRef } from "./refs";
import { breakSentences } from "./sentences";
import { formatAgo } from "./time";
import { Card, CtaButton, ErrorLine, ExpandableText, Fold, InstructionBox, Lines, Muted, TextBox, type ViewContext } from "./ui";

/** 카드 머리에 쓸 에이전트. 판정과 보고는 에이전트 id 만 갖고 있어서 이름과 위치를 Paseo 에서 읽는다. */
function useCardAgent(agentId: string, workspaceId: string, since: string, ctx: ViewContext): CardAgent {
  const agent = useAgent(toAgentRef(ctx.hostId, agentId), (a) => ({ title: a.title, hostId: a.hostId, workspaceId: a.workspaceId }));
  return {
    agentId,
    hostId: agent?.hostId ?? ctx.hostId,
    title: agent?.title ?? ctx.t("common.untitledAgent"),
    workspaceId: agent?.workspaceId ?? workspaceId,
    since,
  };
}

/** 코디네이터가 대신 답한 사실 한 줄. 사람이 무엇이 오갔는지 확인할 수 있어야 한다. */
function FactLine({ fact, ctx }: { fact: FactAnswer; ctx: ViewContext }) {
  const title = useAgent(toAgentRef(ctx.hostId, fact.agentId), (a) => a.title);
  return (
    <View style={{ gap: 2 }}>
      <Muted text={`${title ?? ctx.t("common.untitledAgent")} · ${formatAgo(fact.at, ctx.now, ctx.t)}`} ctx={ctx} />
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
        {breakSentences(fact.answer)}
      </Text>
    </View>
  );
}

/**
 * 인박스 맨 위의 코디네이터 자리. 코디네이터는 사람이 누를 때만 일한다(다이제스트 요청, 메시지). 토큰을 쓰는 시점을 사람이 정하기 위해서다.
 * 세션은 따로 만들게 하지 않는다. 처음 다이제스트를 요청하거나 메시지를 보낼 때 서버가 워크스페이스와 세션을 만든다. 쓰지 않으면 생기지 않는다.
 */
export function CoordinatorBar({ ctx }: { ctx: ViewContext }) {
  const { language } = useT();
  const { state } = useCoordinatorState();
  const settings = useSettings(coordinatorSettings);
  const digestCall = useRpc(coordinatorDigestRpc);
  const sendCall = useRpc(coordinatorSendRpc);
  const digest = useMutation({ mutationFn: () => digestCall({ language }) });
  const send = useMutation({ mutationFn: (text: string) => sendCall({ text }) });
  const [writing, setWriting] = useState(false);
  const agentId = state?.coordinator.agentId ?? null;
  const agent = useAgent(toAgentRef(ctx.hostId, agentId ?? ""), (a) => ({ status: a.status, hostId: a.hostId }));
  const exists = Boolean(agentId && agent);
  // 코디네이터가 일하는 동안(다이제스트 처리, 사람의 질문에 답하기) 다이제스트를 또 누르면 같은 세션에 두 번 쌓인다. 끝날 때까지 막는다.
  // 누른 직후에는 세션이 아직 만들어지는 중이라 상태가 늦게 오므로, 요청이 끝날 때까지도 막는다.
  const busy = digest.isPending || agent?.status === "running" || agent?.status === "initializing";
  const hasProjects = settings.status === "ready" && settings.values.projectIds.length > 0;
  const cycle = state?.digest ?? null;
  const facts = cycle ? (state?.facts ?? []).filter((item) => item.cycleId === cycle.cycleId) : [];
  const queued = digest.data?.delivery === "queued" || send.data?.delivery === "queued";
  const box = {
    gap: 10,
    padding: ctx.compact ? 12 : 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ctx.theme.colors.border,
    backgroundColor: ctx.theme.colors.surface1,
  } as const;
  const title = <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{ctx.t("coordinator.title")}</Text>;

  const status = agent?.status as keyof typeof STATE_KEYS | undefined;
  return (
    <View style={box}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {title}
        {exists && status ? <Muted text={STATE_KEYS[status] ? ctx.t(`coordinator.state.${status}`) : status} ctx={ctx} /> : null}
        <View style={{ flex: 1 }} />
        <Muted text={cycle ? ctx.t("coordinator.lastDigest", { ago: formatAgo(cycle.at, ctx.now, ctx.t) }) : ctx.t("coordinator.noDigest")} ctx={ctx} />
      </View>
      {/* 처음 보는 사람에게만 무엇을 하는지 설명한다. 세션이 생긴 뒤에는 버튼만 남긴다. */}
      {exists ? null : (
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>{ctx.t("coordinator.intro")}</Text>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={busy ? ctx.t("coordinator.digestRunning") : ctx.t("coordinator.digest")}
          accessibilityLabel={busy ? ctx.t("coordinator.digestRunning") : `${ctx.t("coordinator.digest")}: ${ctx.t("coordinator.digestHint")}`}
          tone="primary"
          disabled={busy || !hasProjects}
          theme={ctx.theme}
          onPress={() => digest.mutate()}
        />
        <CtaButton label={writing ? ctx.t("common.closeInstruct") : ctx.t("coordinator.write")} disabled={!hasProjects} theme={ctx.theme} onPress={() => setWriting((value) => !value)} />
        {ctx.navigation && agentId && agent ? (
          <CtaButton label={ctx.t("coordinator.open")} theme={ctx.theme} onPress={() => ctx.navigation?.openAgent({ agentId, serverId: agent.hostId })} />
        ) : null}
      </View>
      {hasProjects ? null : <Muted text={ctx.t("coordinator.noProjects")} ctx={ctx} />}
      {writing ? (
        <InstructionBox
          placeholder={ctx.t("coordinator.writePlaceholder")}
          submitLabel={ctx.t("common.send")}
          busy={send.isPending}
          ctx={ctx}
          onSubmit={(text) => send.mutateAsync(text).then(() => setWriting(false))}
        />
      ) : null}
      {queued ? <Muted text={ctx.t("common.queued")} ctx={ctx} /> : null}
      <ErrorLine error={digest.error ?? send.error} ctx={ctx} />
      {facts.length ? (
        <Fold ctx={ctx} items={[{ label: ctx.t("coordinator.facts", { count: facts.length }), content: facts.map((fact) => <FactLine key={fact.id} fact={fact} ctx={ctx} />) }]} />
      ) : null}
    </View>
  );
}

const STATE_KEYS = { running: true, idle: true, initializing: true, error: true, closed: true } as const;

function OptionButton({ label, onPress, ctx }: { label: string; onPress(): void; ctx: ViewContext }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={ctx.t("judgment.option", { option: label })}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        backgroundColor: pressed ? ctx.theme.colors.surface2 : ctx.theme.colors.surface0,
        maxWidth: "100%",
      })}
    >
      <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * 코디네이터가 '사람이 답할 일'로 판정한 세션. 한 문장 질문과 추천 답장이 보이고, 답장은 고쳐서 보낼 수 있다.
 * 보내는 글은 사람의 답장이라 그대로 간다. 추천의 근거와 부족한 정보는 그 아래에 둔다.
 */
export function QuestionJudgmentCard({ judgment, ctx }: { judgment: Judgment; ctx: ViewContext }) {
  const replyCall = useRpc(judgmentReplyRpc);
  const dismissCall = useRpc(judgmentDismissRpc);
  const reply = useMutation({ mutationFn: (text: string) => replyCall({ agentId: judgment.agentId, text }) });
  const dismiss = useMutation({ mutationFn: () => dismissCall({ agentId: judgment.agentId }) });
  const recommended = judgment.recommendation ?? "";
  const [text, setText] = useState(recommended);
  const agent = useCardAgent(judgment.agentId, judgment.workspaceId, judgment.at, ctx);
  const done = reply.isSuccess || dismiss.isSuccess;
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t("judgment.kindQuestion")} color={ctx.theme.colors.statusDanger} agent={agent} ctx={ctx} />
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600", lineHeight: Math.round(ctx.fonts.heading * 1.35) }}>
        {judgment.question ?? ""}
      </Text>
      {judgment.needsInput ? (
        <Text selectable style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
          {`${ctx.t("judgment.needsInput")} ${breakSentences(judgment.needsInput)}`}
        </Text>
      ) : null}
      {judgment.options.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {judgment.options.map((option) => (
            <OptionButton key={option} label={option} onPress={() => setText(option)} ctx={ctx} />
          ))}
        </View>
      ) : null}
      <TextBox value={text} onChange={setText} placeholder={ctx.t("judgment.replyPlaceholder")} ctx={ctx} minHeight={56} />
      {judgment.reason ? (
        <ExpandableText
          text={breakSentences(judgment.reason)}
          lines={2}
          ctx={ctx}
          style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}
        >
          {`${ctx.t("judgment.reason")} ${breakSentences(judgment.reason)}`}
        </ExpandableText>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={recommended && text.trim() === recommended.trim() ? ctx.t("judgment.sendRecommended") : ctx.t("judgment.sendReply")}
          tone="primary"
          // 보낸 뒤 상태가 다시 오기 전까지 카드가 남아 있다. 그동안 다시 눌러 같은 답장이 두 번 가지 않게 막는다.
          disabled={!text.trim() || reply.isPending || done}
          theme={ctx.theme}
          onPress={() => reply.mutate(text.trim())}
        />
        <CtaButton label={ctx.t("judgment.dismiss")} disabled={dismiss.isPending || done} theme={ctx.theme} onPress={() => dismiss.mutate()} />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      {reply.data?.delivery === "queued" ? <Muted text={ctx.t("common.queued")} ctx={ctx} /> : null}
      <ErrorLine error={reply.error ?? dismiss.error} ctx={ctx} />
    </Card>
  );
}

/** 코디네이터가 '사람이 확인할 결과'로 판정한 세션. 무엇을 볼지만 보이고, 확인은 에이전트를 열어서 한다. */
export function ReviewJudgmentCard({ judgment, ctx }: { judgment: Judgment; ctx: ViewContext }) {
  const dismissCall = useRpc(judgmentDismissRpc);
  const dismiss = useMutation({ mutationFn: () => dismissCall({ agentId: judgment.agentId }) });
  const agent = useCardAgent(judgment.agentId, judgment.workspaceId, judgment.at, ctx);
  return (
    <Card color={ctx.theme.colors.statusWarning} ctx={ctx}>
      <CardHead kind={ctx.t("judgment.kindReview")} color={ctx.theme.colors.statusWarning} agent={agent} ctx={ctx} />
      <ExpandableText
        text={breakSentences(judgment.check ?? "")}
        lines={3}
        ctx={ctx}
        style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}
      >
        {breakSentences(judgment.check ?? "")}
      </ExpandableText>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("judgment.checked")} tone="primary" disabled={dismiss.isPending || dismiss.isSuccess} theme={ctx.theme} onPress={() => dismiss.mutate()} />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      <ErrorLine error={dismiss.error} ctx={ctx} />
    </Card>
  );
}

/**
 * 에이전트가 report_work 로 남긴 보고. 코디네이터가 확인하지 못했거나(needsPerson) 아직 확인하지 않은 보고만 여기에 남는다.
 * 확인된 보고는 코디네이터가 닫는다.
 */
export function ReportCard({ report, ctx }: { report: Report; ctx: ViewContext }) {
  const closeCall = useRpc(reportCloseRpc);
  const close = useMutation({ mutationFn: () => closeCall({ id: report.id }) });
  const agent = useCardAgent(report.agentId, report.workspaceId, report.at, ctx);
  const color = report.status === "blocked" ? ctx.theme.colors.statusDanger : ctx.theme.colors.statusWarning;
  const review = report.review;
  const verdict = !review
    ? ctx.t("report.notReviewed")
    : review.note
      ? ctx.t("report.needsPerson", { note: review.note })
      : ctx.t("report.needsPersonNoNote");
  return (
    <Card color={color} ctx={ctx}>
      <CardHead kind={ctx.t(`report.kind.${report.status}`)} color={color} agent={agent} ctx={ctx} />
      <ExpandableText
        text={breakSentences(report.summary)}
        lines={3}
        ctx={ctx}
        style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}
      >
        {breakSentences(report.summary)}
      </ExpandableText>
      <Text selectable style={{ color: review ? ctx.theme.colors.statusWarning : ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
        {breakSentences(verdict)}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("report.close")} tone="primary" disabled={close.isPending || close.isSuccess} theme={ctx.theme} onPress={() => close.mutate()} />
        <OpenAgentButton agent={agent} ctx={ctx} />
      </View>
      <ErrorLine error={close.error} ctx={ctx} />
      <Fold
        ctx={ctx}
        items={[
          {
            label: ctx.t("report.evidence"),
            count: report.evidence.length,
            content: <Lines items={report.evidence.map((item) => `${item.basis === "verified" ? "✓" : "?"} ${item.text}`)} ctx={ctx} />,
          },
          report.files.length
            ? {
                label: ctx.t("report.files"),
                count: report.files.length,
                content: (
                  <View style={{ gap: 6 }}>
                    <Muted text={report.files.join(", ")} ctx={ctx} />
                    <DiffToggle workspaceId={report.workspaceId} files={report.files.slice(0, 40)} ctx={ctx} />
                  </View>
                ),
              }
            : null,
        ]}
      />
    </Card>
  );
}
