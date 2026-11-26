import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, revertRoute, reviewAutoDecisionRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { Lines, Row } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, type ViewContext } from "./ui";

type AutoDecision = Task["autoDecisions"][number];

/**
 * 자동 결정 카드 (확인 필요, 6단계). 검토자 전원이 통과시켜 사람 없이 워커에게 간 결정이다.
 * 사람은 나중에 보고 확인하거나, 되돌리고 다른 지시를 보낸다. 되돌린 기록이 쌓이면 그 규칙이 꺼진다 (RULES.md §5).
 * 작업이 끝나 지시를 보낼 워커가 없으면 되돌리기 대신 '잘못된 결정으로 표시'만 보인다. 되돌린 것처럼 보이면 안 된다
 * (2026-11-26 전수 검사: 머지한 작업의 되돌리기가 정리된 워커에게 가고 카드는 닫혔다). 서버와 같은 revertRoute 로 판단한다.
 * 읽는 순서: 내 요청 → 이 작업 → 워커 질문 → 코디네이터 답 → 근거 → 검토 → 되돌리는 법 → 결정할 것 → 버튼.
 */
export function AutoDecisionCard({
  request,
  task,
  decision,
  ctx,
}: {
  request: CoordinatorRequest;
  task: Task;
  decision: AutoDecision;
  ctx: ViewContext;
}) {
  const review = useRpc(reviewAutoDecisionRpc);
  const [reverting, setReverting] = useState(false);
  const [text, setText] = useState("");
  const action = useMutation({
    mutationFn: (revertText: string | null) =>
      review({ requestId: request.id, taskNumber: task.number, id: decision.id, revertText }),
  });
  const busy = action.isPending;
  const accent = columnColor("review", ctx.theme);
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
  const passed = decision.verdicts.filter((item) => item.verdict === "PASS").length;
  const route = revertRoute(request, task);
  const markOnly = route.kind === "markOnly";
  const routeNote =
    route.kind === "markOnly"
      ? ctx.t("autoCard.markOnly", { reason: ctx.t(`autoCard.reasons.${route.reason}`) })
      : route.waitsForDecision
        ? ctx.t("autoCard.waitsForDecision")
        : route.kind === "successor"
          ? ctx.t("autoCard.toSuccessor", { task: route.taskNumber })
          : null;
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
        <Chip label={ctx.t("autoCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {`${request.title ?? request.id} › ${task.number} ${task.name}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{formatAgo(decision.at, ctx.now, ctx.t)}</Text>
      </View>

      <Row label={ctx.t("autoCard.request")} ctx={ctx}>
        <Text selectable style={body}>{request.text}</Text>
      </Row>
      <Row label={ctx.t("autoCard.task")} ctx={ctx}>
        <Text style={{ ...body, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
      </Row>
      <Row label={ctx.t("autoCard.question")} ctx={ctx}>
        <Text selectable style={body}>{decision.question}</Text>
      </Row>
      <Row label={ctx.t("autoCard.answer")} ctx={ctx}>
        <Text selectable style={{ ...body, fontWeight: "600" }}>{decision.answer}</Text>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("autoCard.rule", { rule: decision.rule })}</Text>
      </Row>
      <Row label={ctx.t("autoCard.evidence")} ctx={ctx}>
        <Lines items={decision.evidence.map((item) => `${item.fact} (${item.source})`)} ctx={ctx} />
      </Row>
      <Row label={ctx.t("autoCard.review")} ctx={ctx}>
        <Text style={body}>{`PASS ${passed}/${decision.verdicts.length}`}</Text>
        <Lines items={decision.verdicts.map((item) => `${item.model}: ${item.verdict}`)} ctx={ctx} />
      </Row>
      <Row label={ctx.t("autoCard.undo")} ctx={ctx}>
        <Text selectable style={body}>{decision.undo}</Text>
      </Row>

      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {ctx.t("autoCard.decide")}
          </Text>
        </Row>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("autoCard.acknowledge")} tone="primary" disabled={busy} theme={ctx.theme} onPress={() => action.mutate(null)} />
        <CtaButton
          label={reverting ? ctx.t("autoCard.closeRevert") : markOnly ? ctx.t("autoCard.markWrong") : ctx.t("autoCard.revert")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setReverting((value) => !value)}
        />
        {task.agentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("blockerCard.openWorker")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
          />
        ) : null}
      </View>
      {routeNote ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{routeNote}</Text> : null}
      {reverting ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={markOnly ? ctx.t("autoCard.markWrongPlaceholder") : ctx.t("autoCard.revertPlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={markOnly ? ctx.t("autoCard.markWrongPlaceholder") : ctx.t("autoCard.revertPlaceholder")}
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
              label={markOnly ? ctx.t("autoCard.sendMarkWrong") : ctx.t("autoCard.sendRevert")}
              tone="primary"
              disabled={busy || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => action.mutate(text)}
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
