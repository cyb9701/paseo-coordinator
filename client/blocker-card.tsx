import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, askCoordinatorRpc, resolveBlockerRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { DecisionList } from "./decision-history";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, ChoiceBox, CtaButton, Decide, Fold, Lines, Row, type ViewContext } from "./ui";

/**
 * 워커 질문 카드 (내 결정 필요, 4단계). 워커가 report_blocker 로 멈췄고 코디네이터가 판단을 채웠다.
 * 읽는 순서: 내 요청 → 상황(코디네이터가 정리한 맥락) → 확인할 것 → 문답 → 자세히 보기 → 결정할 것(워커의 질문과 선택지) → 버튼.
 * 워커가 낸 선택지와 추천은 코디네이터의 선택지와 겹쳐서, 처음에는 코디네이터 선택지만 보이고 워커 보고는 접어 둔다.
 * 사람이 고르면 플러그인이 선택지의 지시문을 워커에게 보낸다. 질문하기는 코디네이터에게만 묻고 워커는 건드리지 않는다.
 */
export function BlockerCard({ request, task, ctx }: { request: CoordinatorRequest; task: Task; ctx: ViewContext }) {
  const resolve = useRpc(resolveBlockerRpc);
  const ask = useRpc(askCoordinatorRpc);
  const blocker = task.blocker;
  const analysis = blocker?.coordinator ?? null;
  // 사람이 직접 누른 선택만 기억한다. 처음부터 추천을 담아 두면, 코디네이터가 카드를 다시 써서 추천이 바뀌어도 예전 추천이 선택된
  // 채로 남아 그대로 워커에게 갔다 (2026-11-26 전수 검사). 카드를 다시 쓰면(analysis.at 이 바뀌면) 사람의 선택도 지운다.
  const [chosen, setChosen] = useState<{ label: string; at: string } | null>(null);
  const picked = chosen && chosen.at === analysis?.at ? chosen.label : null;
  const selected = analysis?.options.some((option) => option.label === picked) ? picked : (analysis?.recommended ?? null);
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
      <Row label={ctx.t("blockerCard.situation")} ctx={ctx}>
        <Text selectable style={body}>{analysis.context}</Text>
      </Row>
      {/* 검토자의 반대 의견은 접지 않는다. 사람에게 온 이유 자체다 (RULES.md §12 확인할 것). */}
      {blocker.objections.length > 0 ? (
        <Row label={ctx.t("objections")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("reviewFailed")}</Text>
          <Lines items={blocker.objections} ctx={ctx} />
        </Row>
      ) : null}
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
      <Fold
        ctx={ctx}
        items={[
          {
            label: ctx.t("blockerCard.report"),
            content: (
              <>
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
              </>
            ),
          },
          {
            label: ctx.t("blockerCard.optionDetails"),
            content: analysis.options.map((option) => (
              <View key={option.label} style={{ gap: 2 }}>
                <Text style={{ ...body, fontWeight: "600" }}>{option.label}</Text>
                <Text selectable style={muted}>{`${ctx.t("blockerCard.result")}: ${option.result}`}</Text>
                <Text selectable style={muted}>{`${ctx.t("blockerCard.undo")}: ${option.undo}`}</Text>
                {/* 이 선택지를 고르면 워커에게 그대로 가는 문장이다. 라벨과 다르면 사람이 알아챌 수 있어야 한다. */}
                <Text selectable style={muted}>{`${ctx.t("blockerCard.instruction")}: ${option.instruction}`}</Text>
              </View>
            )),
          },
          analysis.rules.length > 0
            ? { label: ctx.t("blockerCard.rules"), content: <Text style={body}>{analysis.rules.join(", ")}</Text> }
            : null,
          task.scope ? { label: ctx.t("blockerCard.scope"), content: <Text selectable style={body}>{task.scope}</Text> } : null,
          task.decisions.length > 0
            ? { label: ctx.t("decisions.label"), count: task.decisions.length, content: <DecisionList task={task} ctx={ctx} /> }
            : null,
        ]}
      />

      <Decide question={blocker.summary} ctx={ctx}>
        {analysis.options.map((option) => (
          <ChoiceBox
            key={option.label}
            label={
              analysis.recommended === option.label ? `${option.label} · ${ctx.t("blockerCard.recommended")}` : option.label
            }
            detail={`${ctx.t("blockerCard.risk")}: ${option.risk}`}
            selected={selected === option.label}
            onPress={() => setChosen({ label: option.label, at: analysis.at })}
            theme={ctx.theme}
          />
        ))}
        {analysis.reasons.length > 0 ? (
          <View style={{ gap: 2 }}>
            <Text style={muted}>{ctx.t("blockerCard.why")}</Text>
            <Lines items={analysis.reasons} ctx={ctx} muted />
          </View>
        ) : null}
      </Decide>
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
