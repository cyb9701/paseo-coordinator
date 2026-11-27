import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { type Summary, summarizeRpc } from "../shared/model";
import { useT } from "./i18n";
import { breakSentences } from "./sentences";
import { formatAgo } from "./time";
import { Body, CtaButton, ErrorLine, Lines, Muted, Row, type ViewContext } from "./ui";

const STUCK_MS = 7 * 60_000;

/**
 * 앞뒤 상황 요약. 사람이 이 에이전트를 지켜보지 않았어도 무엇이 이 질문까지 이끌었고 답에 따라 무엇이 일어나는지 알게 한다.
 * 요약은 받은 글만 정리한 것이라 원문(결정 기록, 에이전트 메시지)과 함께 보인다.
 */
export function SummaryBlock({ summary, agentId, ctx }: { summary: Summary | null; agentId: string; ctx: ViewContext }) {
  const { language } = useT();
  const call = useRpc(summarizeRpc);
  const request = useMutation({ mutationFn: () => call({ agentId, language }) });
  const again = (label: string) => (
    <CtaButton size="sm" label={label} disabled={request.isPending} theme={ctx.theme} onPress={() => request.mutate()} />
  );
  if (!summary) {
    return (
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {again(ctx.t("summary.request"))}
        <Muted text={ctx.t("summary.requestHint")} ctx={ctx} />
        <ErrorLine error={request.error} ctx={ctx} />
      </View>
    );
  }
  // 서버는 요약 하나에 5분 제한을 두고 재시작 때 실패로 바꾼다. 그래도 오래 running 이면 다시 요청할 수 있게 한다.
  if (summary.status === "running" && ctx.now - Date.parse(summary.at) < STUCK_MS) return <Muted text={ctx.t("summary.running")} ctx={ctx} />;
  if (summary.status === "running") {
    return (
      <View style={{ gap: 6 }}>
        <Muted text={ctx.t("summary.stuck")} ctx={ctx} />
        <View style={{ flexDirection: "row" }}>{again(ctx.t("summary.retry"))}</View>
      </View>
    );
  }
  if (summary.status === "failed" || !summary.result) {
    return (
      <View style={{ gap: 6 }}>
        <Muted text={ctx.t("summary.failed", { message: summary.error ?? "" })} ctx={ctx} />
        <View style={{ flexDirection: "row" }}>{again(ctx.t("summary.retry"))}</View>
        <ErrorLine error={request.error} ctx={ctx} />
      </View>
    );
  }
  const result = summary.result;
  return (
    <View
      style={{
        gap: 10,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("summary.title")}</Text>
        <Muted text={formatAgo(summary.at, ctx.now, ctx.t)} ctx={ctx} />
        <View style={{ flex: 1 }} />
        {again(ctx.t("summary.refresh"))}
      </View>
      <Row label={ctx.t("summary.before")} ctx={ctx}>
        <Body text={result.before} ctx={ctx} />
      </Row>
      <Row label={ctx.t("summary.ask")} ctx={ctx}>
        <Body text={result.ask} ctx={ctx} strong />
      </Row>
      {result.after.length ? (
        <Row label={ctx.t("summary.after")} ctx={ctx}>
          <Lines items={result.after} ctx={ctx} />
        </Row>
      ) : null}
      {result.watchOut.length ? (
        <Row label={ctx.t("summary.watchOut")} ctx={ctx}>
          <View style={{ gap: 4 }}>
            {result.watchOut.map((item, index) => (
              <Text key={index} selectable style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.body }}>
                {breakSentences(`⚠ ${item}`)}
              </Text>
            ))}
          </View>
        </Row>
      ) : null}
      <ErrorLine error={request.error} ctx={ctx} />
    </View>
  );
}
