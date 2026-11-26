import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { CancelRequestButton } from "./cancel-request";
import { type CoordinatorRequest, answerQuestionsRpc, cancelRequestRpc, revisePlanRpc, requestProjectIds } from "../shared/model";
import { columnColor } from "./agent-state";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, ChoiceBox, CtaButton, Decide, Fold, Lines, Row, type ViewContext } from "./ui";

/**
 * 질문 카드 (내 결정 필요). 코디네이터가 스스로 정할 수 없는 것만 묻는다 (RULES.md §2.0):
 * 요청을 두 가지 이상으로 읽을 수 있을 때, 사람이 정할 선택이 있을 때, A 등급의 실제 변경을 시작할 때.
 * 읽는 순서: 내 요청 → 추가 지시 → 배경 → 자세히 보기(조사 보고) → 결정할 것(질문과 선택지) → 버튼 (DESIGN.md 카드 읽는 순서).
 * 내 요청은 접지 않는다. 요청을 어떻게 읽을지 묻는 카드라서 원문과 바로 비교해야 한다 (RULES.md H1).
 */
export function QuestionCard({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const answerRpc = useRpc(answerQuestionsRpc);
  const revise = useRpc(revisePlanRpc);
  const cancel = useRpc(cancelRequestRpc);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [instructing, setInstructing] = useState(false);
  const [instruction, setInstruction] = useState("");
  const question = request.question;
  const action = useMutation({
    mutationFn: async (kind: "answer" | "instruct" | "cancel") => {
      if (kind === "cancel") return cancel({ id: request.id });
      if (kind === "instruct") return revise({ id: request.id, text: instruction, answersQuestion: true });
      const answers = (question?.questions ?? []).map((item) => ({
        question: item.question,
        answer: typed[item.question]?.trim() || selected[item.question] || "",
      }));
      return answerRpc({ id: request.id, answers });
    },
  });
  if (!question) return null;
  const busy = action.isPending;
  const accent = columnColor("react", ctx.theme);
  const answered = question.questions.every((item) => Boolean(typed[item.question]?.trim() || selected[item.question]));
  const inputStyle = {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ctx.theme.colors.border,
    backgroundColor: ctx.theme.colors.surface0,
    color: ctx.theme.colors.foreground,
    fontSize: ctx.fonts.body,
  } as const;
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
        <Chip label={ctx.t("questionCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {ctx.t("time.waiting", { ago: formatAgo(question.at, ctx.now, ctx.t) })}
        </Text>
      </View>

      <Row label={ctx.t("questionCard.request")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{request.text}</Text>
      </Row>
      {request.feedback.length > 0 ? (
        <Row label={ctx.t("questionCard.feedback")} ctx={ctx}>
          <Lines items={request.feedback.map((item) => `${formatAgo(item.at, ctx.now, ctx.t)} · ${item.text}`)} ctx={ctx} />
        </Row>
      ) : null}
      <Row label={ctx.t("questionCard.context")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{question.context}</Text>
      </Row>
      {/* A 등급 변경 전 조사의 원문. 배경은 코디네이터의 요약이라, 근거를 직접 보고 고를 수 있게 원문을 접어 둔다. */}
      <Fold
        ctx={ctx}
        items={[
          request.investigation
            ? {
                label: ctx.t("questionCard.investigation"),
                content: (
                  <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.5) }}>
                    {request.investigation.text}
                  </Text>
                ),
              }
            : null,
        ]}
      />

      <Decide ctx={ctx}>
        {question.questions.map((item) => (
          <View key={item.question} style={{ gap: 8, marginBottom: 6 }}>
            <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{item.question}</Text>
            <View style={{ gap: 6 }}>
              {item.options.map((option) => (
                <ChoiceBox
                  key={option.label}
                  label={item.recommended === option.label ? `${option.label} · ${ctx.t("questionCard.recommended")}` : option.label}
                  detail={option.description ?? null}
                  selected={selected[item.question] === option.label && !typed[item.question]?.trim()}
                  onPress={() => setSelected((current) => ({ ...current, [item.question]: option.label }))}
                  theme={ctx.theme}
                />
              ))}
            </View>
            <TextInput
              value={typed[item.question] ?? ""}
              onChangeText={(text) => setTyped((current) => ({ ...current, [item.question]: text }))}
              placeholder={ctx.t("questionCard.answerYourself")}
              placeholderTextColor={ctx.theme.colors.foregroundMuted}
              accessibilityLabel={`${item.question} ${ctx.t("questionCard.answerYourself")}`}
              style={inputStyle}
            />
          </View>
        ))}
      </Decide>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={ctx.t("questionCard.send")}
          tone="primary"
          disabled={busy || !answered}
          theme={ctx.theme}
          onPress={() => action.mutate("answer")}
        />
        <CtaButton
          label={instructing ? ctx.t("questionCard.closeInstruct") : ctx.t("questionCard.instruct")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setInstructing((value) => !value)}
        />
        <CancelRequestButton request={request} label={ctx.t("questionCard.cancel")} busy={busy} onConfirm={() => action.mutate("cancel")} ctx={ctx} />
      </View>
      {instructing ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={instruction}
            onChangeText={setInstruction}
            multiline
            placeholder={ctx.t("questionCard.instructPlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("questionCard.instructPlaceholder")}
            style={{ ...inputStyle, minHeight: 72, textAlignVertical: "top" }}
          />
          <View style={{ flexDirection: "row" }}>
            <CtaButton
              label={ctx.t("questionCard.sendInstruct")}
              tone="primary"
              disabled={busy || instruction.trim().length === 0}
              theme={ctx.theme}
              onPress={() => action.mutate("instruct")}
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
