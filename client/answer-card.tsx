import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, acknowledgeRpc, revisePlanRpc, requestProjectIds } from "../shared/model";
import { columnColor } from "./agent-state";
import { Lines, Row } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, type ViewContext } from "./ui";

/**
 * 답변 카드 (확인 필요). 읽기 요청에 코디네이터가 직접 쓴 답이다. 등급도 승인도 없다 (RULES.md §2.0).
 * 읽는 순서: 내 요청 → 추가 질문 → 답변 → 읽은 파일 → 해석과 가정 → 결정할 것 → 버튼.
 */
export function AnswerCard({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const acknowledge = useRpc(acknowledgeRpc);
  const revise = useRpc(revisePlanRpc);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState("");
  const action = useMutation({
    mutationFn: async (kind: "ack" | "ask") =>
      kind === "ack" ? acknowledge({ id: request.id }) : revise({ id: request.id, text }),
    onSuccess: () => {
      setText("");
      setAsking(false);
    },
  });
  const answer = request.answer;
  if (!answer) return null;
  const busy = action.isPending;
  const accent = columnColor("review", ctx.theme);
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: accent,
        borderRadius: 10,
        backgroundColor: ctx.theme.colors.surface1,
        padding: ctx.compact ? 12 : 16,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Chip label={ctx.t("answerCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{formatAgo(answer.at, ctx.now, ctx.t)}</Text>
      </View>

      <Row label={ctx.t("answerCard.request")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{request.text}</Text>
      </Row>
      {request.feedback.length > 0 ? (
        <Row label={ctx.t("answerCard.followUps")} ctx={ctx}>
          <Lines items={request.feedback.map((item) => `${formatAgo(item.at, ctx.now, ctx.t)} · ${item.text}`)} ctx={ctx} />
        </Row>
      ) : null}
      <Row label={ctx.t("answerCard.answer")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.5) }}>
          {answer.text}
        </Text>
      </Row>
      {answer.sources.length > 0 ? (
        <Row label={ctx.t("answerCard.sources")} ctx={ctx}>
          <Lines items={answer.sources} ctx={ctx} />
        </Row>
      ) : null}
      {answer.unknowns.length > 0 ? (
        <Row label={ctx.t("answerCard.unknowns")} ctx={ctx}>
          <Lines items={answer.unknowns} ctx={ctx} />
        </Row>
      ) : null}

      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {ctx.t("answerCard.decide")}
          </Text>
        </Row>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("answerCard.acknowledge")} tone="primary" disabled={busy} theme={ctx.theme} onPress={() => action.mutate("ack")} />
        <CtaButton
          label={asking ? ctx.t("answerCard.closeFollowUp") : ctx.t("answerCard.followUp")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setAsking((value) => !value)}
        />
      </View>
      {asking ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ctx.t("answerCard.followUpPlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("answerCard.followUpPlaceholder")}
            style={{
              minHeight: 72,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: ctx.theme.colors.border,
              backgroundColor: ctx.theme.colors.surface0,
              color: ctx.theme.colors.foreground,
              fontSize: ctx.fonts.body,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row" }}>
            <CtaButton
              label={ctx.t("answerCard.sendFollowUp")}
              tone="primary"
              disabled={busy || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => action.mutate("ask")}
            />
          </View>
        </View>
      ) : null}
      {action.error ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("inbox.failed", { message: action.error instanceof Error ? action.error.message : String(action.error) })}
        </Text>
      ) : null}
    </View>
  );
}
