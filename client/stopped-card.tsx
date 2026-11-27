import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Decision, answerDecisionsRpc, askAgentRpc, composeAnswer, decisionTitle } from "../shared/model";
import { useCoordinatorState } from "./coordinator-state";
import { DecisionDetails } from "./decision-view";
import { usePending } from "./pending-store";
import { toAgentRef } from "./refs";
import { asksForStopped, summaryForStopped } from "./card-summaries";
import { type CardAgent, CardHead, OpenAgentButton, PermissionBody } from "./permission-cards";
import { SummaryBlock } from "./summary-view";
import { formatAgo } from "./time";
import { Card, Chip, CtaButton, ErrorLine, ExpandableText, Fold, InstructionBox, Muted, TextBox, type ViewContext } from "./ui";

/** 결정마다 고른 답. null 은 에이전트 제안대로다. */
type Choices = Record<string, string | null>;

function OptionChip({ label, selected, onPress, ctx }: { label: string; selected: boolean; onPress(): void; ctx: ViewContext }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: selected ? ctx.theme.colors.accent : ctx.theme.colors.border,
        backgroundColor: selected || pressed ? ctx.theme.colors.surface2 : ctx.theme.colors.surface0,
        maxWidth: "100%",
      })}
    >
      <Text numberOfLines={1} style={{ color: selected ? ctx.theme.colors.foreground : ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, fontWeight: selected ? "600" : "400" }}>
        {selected ? `● ${label}` : label}
      </Text>
    </Pressable>
  );
}

/**
 * 멈춘 결정 한 줄 묶음: 제목, 에이전트 제안 두 줄, 가정이 있으면 경고 한 줄, 대안 칩. 근거는 카드 아래 '근거 보기'에 있다.
 * 칩은 에이전트가 메시지로 물었을 때만 보인다. 질문 창으로 물었으면 답은 그 질문 창의 선택지로 한다.
 */
function StoppedDecision({ decision, choice, onChoose, ctx }: { decision: Decision; choice: string | null | undefined; onChoose?: (choice: string | null) => void; ctx: ViewContext }) {
  const assumption = decision.evidence.find((item) => item.basis === "assumption");
  return (
    <View style={{ gap: 6, paddingTop: 10, borderTopWidth: 1, borderColor: ctx.theme.colors.border }}>
      {/* 번호와 종류는 윗줄, 제목은 그 아래 전체 너비다. 한 줄에 두면 좁은 화면에서 제목이 좁은 칸에 여러 줄로 접힌다. */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Muted text={`#${decision.number}`} ctx={ctx} />
        <Chip label={ctx.t(`decisionKinds.${decision.kind}`)} color={ctx.theme.colors.statusDanger} theme={ctx.theme} />
      </View>
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600", lineHeight: Math.round(ctx.fonts.heading * 1.35) }}>
        {decisionTitle(decision)}
      </Text>
      <ExpandableText text={decision.decision} lines={3} ctx={ctx} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted }}>{`${ctx.t("stopped.proposal")} `}</Text>
        {decision.decision}
      </ExpandableText>
      {assumption ? (
        <ExpandableText text={assumption.text} lines={2} ctx={ctx} style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
          {`⚠ ${ctx.t("stopped.assumption")} ${assumption.text}`}
        </ExpandableText>
      ) : null}
      {onChoose && decision.alternatives.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <OptionChip label={ctx.t("stopped.asProposed")} selected={!choice} onPress={() => onChoose(null)} ctx={ctx} />
          {decision.alternatives.map((item) => (
            <OptionChip key={item.option} label={item.option} selected={choice === item.option} onPress={() => onChoose(item.option)} ctx={ctx} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 에이전트가 멈추고 사람에게 넘긴 결정들. 에이전트마다 카드 하나다. 처음에는 '지금 정할 것' 한 줄과 결정마다 제목·제안·대안만
 * 보이고, 앞뒤 상황과 근거, diff 는 '근거 보기'에 접혀 있다. 더 알아야 하면 '질문하기'로 에이전트에게 묻고, 답이 카드에 쌓인다.
 */
export function StoppedCard({ agentId, decisions, ctx }: { agentId: string; decisions: readonly Decision[]; ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const answerCall = useRpc(answerDecisionsRpc);
  const askCall = useRpc(askAgentRpc);
  const answer = useMutation({ mutationFn: (text: string) => answerCall({ agentId, text }) });
  const ask = useMutation({ mutationFn: (text: string) => askCall({ agentId, text }) });
  const [choices, setChoices] = useState<Choices>({});
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const agent = useAgent(toAgentRef(ctx.hostId, agentId), (a) => ({ title: a.title, hostId: a.hostId, workspaceId: a.workspaceId }));
  const first = decisions[0]!;
  // 사용자 지침에 따라 에이전트가 질문 창(AskUserQuestion)으로 묻기도 한다. 그러면 답은 그 질문 창으로 해야 에이전트가 받는다.
  const question = (usePending().pending.get(agentId) ?? []).find((request) => request.kind === "question") ?? null;
  const covering = summaryForStopped(state, agentId, decisions);
  const asks = asksForStopped(state, agentId, decisions);
  const cardAgent: CardAgent = {
    agentId,
    hostId: agent?.hostId ?? ctx.hostId,
    title: agent?.title ?? ctx.t("common.untitledAgent"),
    workspaceId: agent?.workspaceId ?? first.workspaceId,
    since: first.at,
  };
  const changed = Object.values(choices).some(Boolean);
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t("kinds.decision", { count: decisions.length })} color={ctx.theme.colors.statusDanger} agent={cardAgent} ctx={ctx} />
      {covering?.status === "done" && covering.result ? (
        <ExpandableText text={covering.result.ask} lines={3} ctx={ctx} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontWeight: "600" }}>{`${ctx.t("summary.ask")}  `}</Text>
          {covering.result.ask}
        </ExpandableText>
      ) : null}
      <View style={{ gap: 4 }}>
        {decisions.map((decision) => (
          <StoppedDecision
            key={decision.id}
            decision={decision}
            choice={choices[decision.id]}
            onChoose={question ? undefined : (choice) => setChoices((current) => ({ ...current, [decision.id]: choice }))}
            ctx={ctx}
          />
        ))}
      </View>
      {question ? (
        <PermissionBody request={question} agent={cardAgent} ctx={ctx} />
      ) : (
        <View style={{ gap: 8 }}>
          <TextBox value={note} onChange={setNote} placeholder={ctx.t("stopped.notePlaceholder")} ctx={ctx} minHeight={48} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <CtaButton
              label={changed || note.trim() ? ctx.t("stopped.sendAnswer") : ctx.t("stopped.goAhead")}
              tone="primary"
              // 보낸 뒤 상태가 다시 오기 전까지 카드가 남아 있다. 그동안 다시 눌러 같은 답이 두 번 가지 않게 막는다.
              disabled={answer.isPending || answer.isSuccess}
              theme={ctx.theme}
              onPress={() => answer.mutate(composeAnswer(decisions, choices, note))}
            />
            <CtaButton label={asking ? ctx.t("common.closeInstruct") : ctx.t("stopped.ask")} theme={ctx.theme} onPress={() => setAsking((value) => !value)} />
            <OpenAgentButton agent={cardAgent} ctx={ctx} />
          </View>
          <ErrorLine error={answer.error} ctx={ctx} />
        </View>
      )}
      {question ? (
        <View style={{ flexDirection: "row" }}>
          <CtaButton label={asking ? ctx.t("common.closeInstruct") : ctx.t("stopped.ask")} theme={ctx.theme} onPress={() => setAsking((value) => !value)} />
        </View>
      ) : null}
      {asking ? (
        <InstructionBox
          placeholder={ctx.t("stopped.askPlaceholder")}
          submitLabel={ctx.t("stopped.sendAsk")}
          busy={ask.isPending}
          ctx={ctx}
          onSubmit={(text) => ask.mutateAsync(text).then(() => setAsking(false))}
        />
      ) : null}
      <ErrorLine error={ask.error} ctx={ctx} />
      {asks.length ? (
        <View style={{ gap: 6, padding: 10, borderRadius: 8, backgroundColor: ctx.theme.colors.surface0 }}>
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("stopped.qa")}</Text>
          {asks.map((item) => (
            <View key={item.id} style={{ gap: 2 }}>
              <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>{ctx.t("stopped.question", { text: item.text })}</Text>
              <Text selectable numberOfLines={8} style={{ color: item.answer ? ctx.theme.colors.foreground : ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
                {item.answer ? ctx.t("stopped.answer", { text: item.answer }) : ctx.t("stopped.waitingAnswer", { ago: formatAgo(item.at, ctx.now, ctx.t) })}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Fold
        ctx={ctx}
        items={[
          { label: ctx.t("stopped.context"), content: <SummaryBlock summary={covering} agentId={agentId} ctx={ctx} /> },
          {
            label: ctx.t("stopped.evidence"),
            count: decisions.length,
            content: (
              <View style={{ gap: 14 }}>
                {decisions.map((decision) => (
                  <View key={decision.id} style={{ gap: 6 }}>
                    <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{`#${decision.number} ${decisionTitle(decision)}`}</Text>
                    <DecisionDetails decision={decision} ctx={ctx} />
                  </View>
                ))}
              </View>
            ),
          },
        ]}
      />
    </Card>
  );
}
