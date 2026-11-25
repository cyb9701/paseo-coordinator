import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, askCoordinatorRpc, resolveBlockerRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { Lines, Row } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, ChoiceBox, CtaButton, type ViewContext } from "./ui";

/**
 * 워커 질문 카드 (반응 필요, 4단계). 워커가 report_blocker 로 멈췄고 코디네이터가 판단을 채웠다.
 * 읽는 순서: 내 요청 → 이 작업 → 워커가 보고한 상황 → 코디네이터 판단 → 선택지 → 문답 → 결정할 것 → 버튼.
 * 사람이 고르면 플러그인이 선택지의 지시문을 워커에게 보낸다. 질문하기는 코디네이터에게만 묻고 워커는 건드리지 않는다.
 */
export function BlockerCard({ request, task, ctx }: { request: CoordinatorRequest; task: Task; ctx: ViewContext }) {
  const resolve = useRpc(resolveBlockerRpc);
  const ask = useRpc(askCoordinatorRpc);
  const blocker = task.blocker;
  const analysis = blocker?.coordinator ?? null;
  const [selected, setSelected] = useState<string | null>(analysis?.recommended ?? null);
  const [panel, setPanel] = useState<"none" | "instruct" | "ask">("none");
  const [text, setText] = useState("");
  const action = useMutation({
    mutationFn: async (kind: "resolve" | "instruct" | "ask") => {
      const base = { requestId: request.id, taskNumber: task.number };
      if (kind === "ask") return ask({ ...base, question: text });
      return resolve({ ...base, choice: kind === "resolve" ? selected : null, instruction: kind === "instruct" ? text : null });
    },
    onSuccess: () => {
      setText("");
      setPanel("none");
    },
  });
  if (!blocker || !analysis) return null;
  const busy = action.isPending;
  const accent = columnColor("react", ctx.theme);
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
  const inputStyle = {
    minHeight: 72,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ctx.theme.colors.border,
    backgroundColor: ctx.theme.colors.surface0,
    color: ctx.theme.colors.foreground,
    fontSize: ctx.fonts.body,
    textAlignVertical: "top" as const,
  };
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
        <Chip label={ctx.t("blockerCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {`${request.title ?? request.id} › ${task.number} ${task.name}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={muted}>{ctx.t("time.waiting", { ago: formatAgo(blocker.at, ctx.now, ctx.t) })}</Text>
      </View>

      <Row label={ctx.t("blockerCard.request")} ctx={ctx}>
        <Text selectable style={body}>{request.text}</Text>
      </Row>
      <Row label={ctx.t("blockerCard.task")} ctx={ctx}>
        <Text style={{ ...body, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
        {task.scope ? <Text style={muted}>{`${ctx.t("blockerCard.scope")}: ${task.scope}`}</Text> : null}
      </Row>
      <Row label={ctx.t("blockerCard.report")} ctx={ctx}>
        <Text selectable style={{ ...body, fontWeight: "600" }}>{blocker.summary}</Text>
        <Text style={muted}>{ctx.t("blockerCard.facts")}</Text>
        <Lines items={blocker.facts} ctx={ctx} />
        {blocker.options.length > 0 ? (
          <>
            <Text style={muted}>{ctx.t("blockerCard.workerOptions")}</Text>
            <Lines items={blocker.options.map((option) => `${option.label}: ${option.consequence}`)} ctx={ctx} />
          </>
        ) : null}
        {blocker.workerRecommendation ? (
          <Text style={muted}>{`${ctx.t("blockerCard.workerRecommendation")}: ${blocker.workerRecommendation}`}</Text>
        ) : null}
      </Row>
      <Row label={ctx.t("blockerCard.coordinator")} ctx={ctx}>
        <Text selectable style={body}>{analysis.context}</Text>
        <Lines items={analysis.reasons} ctx={ctx} />
        {analysis.rules.length > 0 ? <Text style={muted}>{`${ctx.t("blockerCard.rules")}: ${analysis.rules.join(", ")}`}</Text> : null}
      </Row>
      <Row label={ctx.t("blockerCard.options")} ctx={ctx}>
        {analysis.options.map((option) => (
          <ChoiceBox
            key={option.label}
            label={
              analysis.recommended === option.label ? `${option.label} · ${ctx.t("blockerCard.recommended")}` : option.label
            }
            detail={`${ctx.t("blockerCard.result")}: ${option.result} · ${ctx.t("blockerCard.risk")}: ${option.risk} · ${ctx.t("blockerCard.undo")}: ${option.undo}`}
            selected={selected === option.label}
            onPress={() => setSelected(option.label)}
            theme={ctx.theme}
          />
        ))}
      </Row>
      {blocker.qa.length > 0 ? (
        <Row label={ctx.t("blockerCard.qa")} ctx={ctx}>
          {blocker.qa.map((qa) => (
            <View key={qa.at} style={{ gap: 2 }}>
              <Text style={{ ...body, fontWeight: "600" }}>{`Q. ${qa.question}`}</Text>
              <Text selectable style={qa.answer ? body : muted}>{qa.answer ? `A. ${qa.answer}` : ctx.t("blockerCard.waitingAnswer")}</Text>
            </View>
          ))}
        </Row>
      ) : null}

      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {ctx.t("blockerCard.decide")}
          </Text>
        </Row>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={ctx.t("blockerCard.resolve")}
          tone="primary"
          disabled={busy || !selected}
          theme={ctx.theme}
          onPress={() => action.mutate("resolve")}
        />
        <CtaButton
          label={panel === "instruct" ? ctx.t("blockerCard.closeInstruct") : ctx.t("blockerCard.instruct")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setPanel((value) => (value === "instruct" ? "none" : "instruct"))}
        />
        <CtaButton
          label={panel === "ask" ? ctx.t("blockerCard.closeAsk") : ctx.t("blockerCard.ask")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setPanel((value) => (value === "ask" ? "none" : "ask"))}
        />
        {task.agentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("blockerCard.openWorker")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
          />
        ) : null}
      </View>
      {panel !== "none" ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={panel === "ask" ? ctx.t("blockerCard.askPlaceholder") : ctx.t("blockerCard.instructPlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={panel === "ask" ? ctx.t("blockerCard.askPlaceholder") : ctx.t("blockerCard.instructPlaceholder")}
            style={inputStyle}
          />
          <View style={{ flexDirection: "row" }}>
            <CtaButton
              label={panel === "ask" ? ctx.t("blockerCard.sendAsk") : ctx.t("blockerCard.sendInstruct")}
              tone="primary"
              disabled={busy || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => action.mutate(panel === "ask" ? "ask" : "instruct")}
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
