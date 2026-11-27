import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type Decision, answerDecisionsRpc, latestSummary } from "../shared/model";
import { useCoordinatorState } from "./coordinator-state";
import { DecisionItem } from "./decision-view";
import { usePending } from "./pending-store";
import { type CardAgent, CardHead, OpenAgentButton, PermissionBody } from "./permission-cards";
import { SummaryBlock } from "./summary-view";
import { Card, CtaButton, ErrorLine, Muted, TextBox, type ViewContext } from "./ui";

/** 제안대로 진행할 때 에이전트에게 가는 답. 사람의 말이 아니라 버튼이라 고정 문장이다. */
const GO_AHEAD = "Go ahead with what you proposed for each of these decisions.";

/**
 * 에이전트가 멈추고 사람에게 넘긴 결정들. 에이전트는 멈출 결정을 모아 한 번에 물으므로 카드도 에이전트마다 하나다.
 * 위에서부터 앞뒤 상황 요약, 결정마다의 근거와 가정, 답 순서로 읽는다.
 */
export function StoppedCard({ agentId, decisions, ctx }: { agentId: string; decisions: readonly Decision[]; ctx: ViewContext }) {
  const { state } = useCoordinatorState();
  const call = useRpc(answerDecisionsRpc);
  const answer = useMutation({ mutationFn: (text: string) => call({ agentId, text }) });
  const [text, setText] = useState("");
  const agent = useAgent(agentId, (a) => ({ title: a.title, hostId: a.hostId, workspaceId: a.workspaceId }));
  const first = decisions[0]!;
  // 사용자 지침에 따라 에이전트가 질문 창(AskUserQuestion)으로 묻기도 한다. 그러면 답은 그 질문 창으로 해야 에이전트가 받는다.
  const question = (usePending().pending.get(agentId) ?? []).find((request) => request.kind === "question") ?? null;
  const summary = state ? latestSummary(state, agentId) : null;
  // 이 결정들보다 앞서 만든 요약은 다른 질문에 대한 것이다.
  const covering = summary && (summary.at >= first.at || decisions.some((item) => summary.decisionIds.includes(item.id))) ? summary : null;
  const cardAgent: CardAgent = {
    agentId,
    hostId: agent?.hostId ?? ctx.hostId,
    title: agent?.title ?? ctx.t("common.untitledAgent"),
    workspaceId: agent?.workspaceId ?? first.workspaceId,
    since: first.at,
  };
  return (
    <Card color={ctx.theme.colors.statusDanger} ctx={ctx}>
      <CardHead kind={ctx.t("kinds.decision", { count: decisions.length })} color={ctx.theme.colors.statusDanger} agent={cardAgent} ctx={ctx} />
      <SummaryBlock summary={covering} agentId={agentId} ctx={ctx} />
      <View style={{ gap: 8 }}>
        {decisions.map((decision) => (
          <DecisionItem key={decision.id} decision={decision} ctx={ctx} showStatus={false} />
        ))}
      </View>
      {question ? (
        <PermissionBody request={question} agent={cardAgent} ctx={ctx} />
      ) : (
      <View style={{ gap: 8 }}>
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{ctx.t("stopped.question")}</Text>
        <TextBox value={text} onChange={setText} placeholder={ctx.t("stopped.placeholder")} ctx={ctx} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <CtaButton
            label={ctx.t("stopped.goAhead")}
            tone={text.trim() ? "neutral" : "primary"}
            disabled={answer.isPending}
            theme={ctx.theme}
            onPress={() => answer.mutate(text.trim() ? `${GO_AHEAD}\n\n${text.trim()}` : GO_AHEAD)}
          />
          <CtaButton
            label={ctx.t("stopped.sendAnswer")}
            tone={text.trim() ? "primary" : "neutral"}
            disabled={answer.isPending || !text.trim()}
            theme={ctx.theme}
            onPress={() => answer.mutate(text.trim())}
          />
          <OpenAgentButton agent={cardAgent} ctx={ctx} />
        </View>
        <Muted text={ctx.t("stopped.hint")} ctx={ctx} />
        <ErrorLine error={answer.error} ctx={ctx} />
      </View>
      )}
    </Card>
  );
}
