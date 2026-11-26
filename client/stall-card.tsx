import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { type CoordinatorRequest, requestProjectIds, retryCoordinatorRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, Decide, Row, type ViewContext } from "./ui";

/**
 * 코디네이터 멈춤 카드 (내 결정 필요). 코디네이터는 사람 화면에 보이지 않는 에이전트라, 만들기에 실패하거나 에러로 멈추거나
 * 알림을 받고도 처리하지 않으면 보드에 '계획 세우는 중'만 계속 보였다 (2026-11-26 전수 검사). 이유를 보여 주고 다시 시도하게 한다.
 * 읽는 순서: 내 요청 → 이유 → 결정할 것 → 버튼.
 */
export function StallCard({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const retry = useRpc(retryCoordinatorRpc);
  const action = useMutation({ mutationFn: () => retry({ id: request.id }) });
  const stall = request.stall;
  if (!stall) return null;
  const accent = columnColor("react", ctx.theme);
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
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
        <Chip label={ctx.t("stallCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {ctx.t("time.waiting", { ago: formatAgo(stall.at, ctx.now, ctx.t) })}
        </Text>
      </View>
      <Row label={ctx.t("questionCard.request")} ctx={ctx}>
        <Text selectable style={body}>{request.text}</Text>
      </Row>
      <Row label={ctx.t("stallCard.reason")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.body }}>{stall.reason}</Text>
      </Row>
      <Decide question={ctx.t("stallCard.decide")} ctx={ctx} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("stallCard.retry")} tone="primary" disabled={action.isPending} theme={ctx.theme} onPress={() => action.mutate()} />
        {request.coordinatorAgentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("stallCard.openCoordinator")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: request.coordinatorAgentId!, serverId: ctx.hostId })}
          />
        ) : null}
      </View>
      {action.error ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("inbox.failed", { message: action.error instanceof Error ? action.error.message : String(action.error) })}
        </Text>
      ) : null}
    </View>
  );
}
