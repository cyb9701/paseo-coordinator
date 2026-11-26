import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import {
  type CoordinatorRequest,
  type RequestReport,
  closeCompletionRpc,
  completionNeedsDecision,
  requestProjectIds,
  reviewAutoDecisionRpc,
  revisePlanRpc,
} from "../shared/model";
import { columnColor } from "./agent-state";
import { AutoDecisionCard } from "./auto-decision-card";
import { MergeCard } from "./merge-card";
import { PlanDetails } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, Decide, Fold, GradeBadge, Lines, type ViewContext } from "./ui";

/**
 * 완료 보고서 (2026-11-27 사용자 결정). 코디네이터는 사람의 병목을 없애려고 쓰는데, 작업이 끝날 때마다 머지·확인 카드가 뜨고
 * 시작과 자동 결정까지 카드로 확인을 받아 사람이 계속 불려 왔다. 그래서 요청에서 더 진행할 일이 없을 때 이 카드 하나로 알린다.
 * 읽는 순서: 정할 것(요약 한 줄과 내가 할 일) → PR 마다 머지 카드 → 버튼 → 자세히 보기(내 요청, 결과, 워커가 고른 것, 자동 결정,
 * 검증, 계획). 카드 밖에는 정할 것과 버튼만 둔다 (2026-11-27 사용자 결정).
 * PR 머지는 모든 등급에서 사람이 한다 (RULES.md H2). 그래서 머지할 PR 마다 머지 카드를 이 안에 둔다. 나머지(PR 도 남은 변경도
 * 없이 끝난 작업, 확인하지 않은 자동 결정)는 버튼 하나로 끝낸다.
 */
export function ReportCard({ request, report, ctx }: { request: CoordinatorRequest; report: RequestReport; ctx: ViewContext }) {
  const close = useRpc(closeCompletionRpc);
  const review = useRpc(reviewAutoDecisionRpc);
  const revise = useRpc(revisePlanRpc);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const decisions = report.completions.filter(completionNeedsDecision);
  // 코디네이터에게 물은 것의 답이 아직 없으면 닫지 않는다. 닫으면 그 문답이 버려진다 (2026-11-26 전수 검사).
  const plain = report.completions.filter((task) => !completionNeedsDecision(task));
  const closable = plain.filter((task) => !task.completion!.qa.some((qa) => qa.answer === null));
  const autos = request.tasks.flatMap((task) =>
    task.autoDecisions.filter((decision) => !decision.reviewedAt && !decision.reverted).map((decision) => ({ task, decision })),
  );
  const finish = useMutation({
    mutationFn: async () => {
      // 하나가 실패해도 나머지는 처리한다. 실패한 것은 보고서에 남아 사람이 다시 누른다.
      const results = await Promise.allSettled([
        ...autos.map(({ task, decision }) => review({ requestId: request.id, taskNumber: task.number, id: decision.id, revertText: null })),
        ...closable.map((task) => close({ requestId: request.id, taskNumber: task.number, action: "merge", instruction: null })),
      ]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  });
  const redirect = useMutation({
    mutationFn: () => revise({ id: request.id, text }),
    onSuccess: () => {
      setText("");
      setRevising(false);
    },
  });

  // 이어 쓰기로 끝난 앞 작업(done)도 보고를 남겼다. 결과에는 보고한 작업 모두를 순서대로 보인다.
  const reported = request.tasks.filter((task) => task.completion);
  const canceled = request.tasks.filter((task) => task.status === "canceled");
  // 머지를 기다려야 시작하는 운영 작업. 머지하면 이어서 돈다는 것을 알려야 사람이 머지를 미루지 않는다.
  const afterMerge = request.tasks.filter((task) => task.status === "waiting");
  // 머지할 PR 과 PR 에 없는 변경은 바로 아래 머지 카드가 보인다. 여기에는 그 밖에 사람이 할 일만 둔다.
  const todo = [
    ...plain
      .filter((task) => task.completion!.noPrSource === "existingWorkspace")
      .map((task) => ctx.t("report.todoExisting", { task: `${task.number} ${task.name}`, branch: task.branch ?? "" })),
    ...afterMerge.map((task) => ctx.t("report.todoAfterMerge", { task: `${task.number} ${task.name}` })),
    ...reported.flatMap((task) => task.completion!.left.map((item) => `${task.number} · ${item}`)),
  ];
  const choices = reported.flatMap((task) => task.completion!.choices.map((choice) => `${task.number} · ${choice.choice}: ${choice.why}`));
  const verification = reported.flatMap((task) => task.completion!.verification.map((item) => `${task.number} · ${item}`));
  const accent = columnColor(report.needsDecision ? "react" : "review", ctx.theme);
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  const lastAt = report.completions.map((task) => task.completion!.at).sort().at(-1)!;
  const busy = finish.isPending || redirect.isPending;
  const failure = finish.error ?? redirect.error;
  const finishLabel = decisions.length > 0 ? ctx.t("report.finishRest", { count: closable.length + autos.length }) : ctx.t("report.finish");

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
        <Chip label={ctx.t("report.kind")} color={accent} theme={ctx.theme} />
        {request.grade ? <GradeBadge grade={request.grade} label={ctx.t("card.grade", { grade: request.grade })} theme={ctx.theme} /> : null}
        <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={muted}>{ctx.t("time.waiting", { ago: formatAgo(lastAt, ctx.now, ctx.t) })}</Text>
      </View>

      {/* 카드 밖에는 정할 것, 내가 할 일, 머지할 PR, 버튼만 둔다 (2026-11-27 사용자 결정). 결과와 근거는 자세히 보기에 있다. */}
      <Decide
        question={
          decisions.length > 0
            ? ctx.t("report.summaryMerge", { done: reported.length, count: decisions.length })
            : ctx.t("report.summaryDone", { done: reported.length })
        }
        ctx={ctx}
      >
        {todo.length > 0 ? <Lines items={todo} ctx={ctx} /> : null}
        <Text style={muted}>{decisions.length > 0 ? ctx.t("report.decideMerge") : ctx.t("report.decideFinish")}</Text>
      </Decide>
      {decisions.map((task) => (
        <MergeCard key={task.number} request={request} task={task} ctx={ctx} embedded />
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {closable.length + autos.length > 0 ? (
          <CtaButton
            label={finishLabel}
            tone={decisions.length > 0 ? undefined : "primary"}
            disabled={busy}
            theme={ctx.theme}
            onPress={() => finish.mutate()}
          />
        ) : null}
        <CtaButton
          label={revising ? ctx.t("planCard.closeRevise") : ctx.t("report.redirect")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setRevising((value) => !value)}
        />
      </View>
      {plain.length > closable.length ? (
        <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
          {ctx.t("report.waitingAnswer", { count: plain.length - closable.length })}
        </Text>
      ) : null}
      {revising ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ctx.t("report.redirectPlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("report.redirectPlaceholder")}
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
              label={ctx.t("planCard.sendRevise")}
              tone="primary"
              disabled={busy || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => redirect.mutate()}
            />
          </View>
        </View>
      ) : null}
      {failure ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("inbox.failed", { message: failure instanceof Error ? failure.message : String(failure) })}
        </Text>
      ) : null}
      <Fold
        ctx={ctx}
        items={[
          { label: ctx.t("mergeCard.request"), content: <Text selectable style={body}>{request.text}</Text> },
          {
            label: ctx.t("report.results"),
            count: reported.length,
            content: (
              <>
                {reported.map((task) => (
                  <Text key={task.number} selectable style={body}>{`${task.number} ${task.name} · ${task.completion!.summary}`}</Text>
                ))}
                {canceled.map((task) => (
                  <Text key={task.number} style={muted}>{ctx.t("report.canceled", { task: `${task.number} ${task.name}` })}</Text>
                ))}
              </>
            ),
          },
          choices.length > 0 ? { label: ctx.t("report.decided"), count: choices.length, content: <Lines items={choices} ctx={ctx} /> } : null,
          autos.length > 0
            ? {
                label: ctx.t("report.autoLabel"),
                count: autos.length,
                content: autos.map(({ task, decision }) => (
                  <AutoDecisionCard key={decision.id} request={request} task={task} decision={decision} ctx={ctx} />
                )),
              }
            : null,
          verification.length > 0
            ? { label: ctx.t("mergeCard.verification"), count: verification.length, content: <Lines items={verification} ctx={ctx} /> }
            : null,
          { label: ctx.t("report.plan"), content: <PlanDetails request={request} ctx={ctx} /> },
        ]}
      />
    </View>
  );
}
