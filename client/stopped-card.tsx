import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, cancelTaskRpc, continuedBy, dependentsOf, retryTaskRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { DecisionHistory } from "./decision-history";
import { Row } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { Chip, CtaButton, type ViewContext } from "./ui";

/**
 * 멈춘 작업 카드 (내 결정 필요). 워커 질문 카드 없이 막힌 작업이다: 워커를 만들지 못했거나, 턴이 에러로 끝났거나,
 * 완료 보고 없이 두 번 끝났다. 사람이 원인을 보고 다시 시작하거나(지시를 붙일 수 있다) 워커를 열어 직접 본다.
 * 진행하지 않을 작업은 취소한다. 기대는 작업도 함께 취소되므로, 누르면 바로 취소하지 않고 함께 취소될 작업을 보여 준 뒤 확정받는다.
 * 읽는 순서: 내 요청 → 이 작업 → 멈춘 이유 → 결정할 것 → 버튼.
 */
export function StoppedCard({ request, task, ctx }: { request: CoordinatorRequest; task: Task; ctx: ViewContext }) {
  const retry = useRpc(retryTaskRpc);
  const cancelTask = useRpc(cancelTaskRpc);
  const [text, setText] = useState("");
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const action = useMutation({
    mutationFn: (kind: "retry" | "cancel") =>
      kind === "retry"
        ? retry({ requestId: request.id, taskNumber: task.number, instruction: text.trim() || null })
        : cancelTask({ requestId: request.id, taskNumber: task.number }),
    onSuccess: () => {
      setText("");
      setConfirmingCancel(false);
    },
  });
  const dependentTasks = dependentsOf(request, task.number)
    .map((number) => request.tasks.find((item) => item.number === number))
    .filter((item): item is Task => Boolean(item));
  const dependents = dependentTasks.map((item) => `${item.number} ${item.name}`);
  // 끝나서 카드를 기다리는 작업은 함께 취소하지 않는다(server cancelTasksIn 이 거절한다). 누르기 전에 이유를 보여 준다.
  const waitingCards = dependentTasks.filter((item) => item.status === "review").map((item) => item.number);
  // 이 작업이 앞 작업의 worktree 를 이어 쓰면, 앞 작업의 커밋은 이 작업이 PR 을 내기를 기다리는 중이다. 취소하면 그 커밋이
  // 카드로 다시 온다는 것을 미리 알린다 (server cancelTasksIn).
  const waitingPredecessors = request.tasks
    .filter((item) => item.status === "done" && item.completion && !item.completion.closedAt && continuedBy(request, item)?.number === task.number)
    .map((item) => item.number);
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
        <Chip label={ctx.t("stoppedCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {`${request.title ?? request.id} › ${task.number} ${task.name}`}
        </Text>
      </View>
      <Row label={ctx.t("blockerCard.request")} ctx={ctx}>
        <Text selectable style={body}>{request.text}</Text>
      </Row>
      <Row label={ctx.t("blockerCard.task")} ctx={ctx}>
        <Text style={{ ...body, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
        <DecisionHistory task={task} ctx={ctx} />
      </Row>
      <Row label={ctx.t("stoppedCard.reason")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.body }}>
          {task.note ?? ctx.t("stoppedCard.noReason")}
        </Text>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {task.agentId ? ctx.t("stoppedCard.withWorker") : ctx.t("stoppedCard.withoutWorker")}
        </Text>
      </Row>
      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12, gap: 8 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {ctx.t("stoppedCard.decide")}
          </Text>
        </Row>
        {task.agentId ? (
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ctx.t("stoppedCard.placeholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("stoppedCard.placeholder")}
            style={{
              minHeight: 56,
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
        ) : null}
      </View>
      {confirmingCancel ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{ctx.t("stoppedCard.cancelConfirm")}</Text>
          {dependents.length > 0 ? (
            <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
              {ctx.t("stoppedCard.cancelDependents", { tasks: dependents.join(", ") })}
            </Text>
          ) : null}
          {waitingCards.length > 0 ? (
            <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
              {ctx.t("stoppedCard.cancelBlocked", { tasks: waitingCards.join(", ") })}
            </Text>
          ) : null}
          {waitingPredecessors.length > 0 ? (
            <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
              {ctx.t("stoppedCard.cancelChain", { task: waitingPredecessors.join(", ") })}
            </Text>
          ) : null}
          {task.agentId ? (
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("stoppedCard.cancelWorker")}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <CtaButton
              label={ctx.t("stoppedCard.cancelYes")}
              tone="primary"
              disabled={action.isPending || waitingCards.length > 0}
              theme={ctx.theme}
              onPress={() => action.mutate("cancel")}
            />
            <CtaButton label={ctx.t("stoppedCard.cancelBack")} disabled={action.isPending} theme={ctx.theme} onPress={() => setConfirmingCancel(false)} />
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={ctx.t("stoppedCard.retry")}
          tone="primary"
          disabled={action.isPending || confirmingCancel}
          theme={ctx.theme}
          onPress={() => action.mutate("retry")}
        />
        <CtaButton
          label={ctx.t("stoppedCard.cancel")}
          disabled={action.isPending || confirmingCancel}
          theme={ctx.theme}
          onPress={() => setConfirmingCancel(true)}
        />
        {task.agentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("blockerCard.openWorker")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
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
