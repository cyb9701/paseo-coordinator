import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, cancelRequestRpc, completionNeedsDecision, requestProjectIds, revisePlanRpc } from "../shared/model";
import { COLUMN_KEYS, type ColumnKey, columnColor } from "./agent-state";
import { DecisionHistory } from "./decision-history";
import { requestNeedsReaction } from "./coordinator-state";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { CtaButton, GradeBadge, type ViewContext } from "./ui";

export type RequestItem = { kind: "planning" } | { kind: "question" } | { kind: "answer" } | { kind: "stall" } | { kind: "task"; task: Task };

/**
 * 작업이 놓일 컬럼. 워커가 막힘을 보고했으면, 코디네이터가 판단하는 동안은 '코디네이터 처리 중',
 * 결정 카드가 나오면 '내 결정 필요'다. 완료를 보고하고 머지를 기다리는 작업도 '내 결정 필요'다.
 */
function taskColumn(task: Task): ColumnKey | null {
  if (task.blocker) return task.blocker.coordinator ? "react" : "auto";
  // 완료를 보고한 작업. PR 머지나 남은 변경 처리는 사람의 결정이고, PR 도 남은 변경도 없으면 나중에 확인하면 된다.
  if (task.status === "review" && task.completion && !task.completion.closedAt) return completionNeedsDecision(task) ? "react" : "review";
  return TASK_COLUMNS[task.status];
}

// 작업 상태를 보드 컬럼에 놓는다. 막힌 작업은 사람을 기다리므로 가장 왼쪽(내 결정 필요)이다.
const TASK_COLUMNS: Record<Task["status"], ColumnKey | null> = {
  blocked: "react",
  review: "review",
  running: "running",
  waiting: "waiting",
  done: null,
  canceled: null,
};

/** 요청 하나를 (컬럼 → 카드) 로 나눈다. 헤더의 컬럼별 숫자도 이 결과로 센다. */
export function requestCells(request: CoordinatorRequest): Map<ColumnKey, RequestItem[]> {
  const cells = new Map<ColumnKey, RequestItem[]>();
  const add = (column: ColumnKey, item: RequestItem) => cells.set(column, [...(cells.get(column) ?? []), item]);
  // 멈춘 코디네이터는 사람이 다시 시도해야 이어진다. '계획 중'으로 두면 일하는 것처럼 보인다.
  if (request.stall && isActiveRequest(request)) add("react", { kind: "stall" });
  else if (request.status === "planning") add("auto", { kind: "planning" });
  if (requestNeedsReaction(request)) add("react", { kind: "question" });
  if (request.status === "answered") add("review", { kind: "answer" });
  for (const task of request.tasks) {
    const column = taskColumn(task);
    if (column) add(column, { kind: "task", task });
  }
  return cells;
}

export function isActiveRequest(request: CoordinatorRequest): boolean {
  return request.status !== "done" && request.status !== "canceled";
}

function requestTitle(request: CoordinatorRequest): string {
  return request.title ?? request.text.split("\n")[0]!.slice(0, 80);
}

function PlaceholderCard({
  text,
  column,
  projectIds,
  ctx,
}: {
  text: string;
  column: ColumnKey;
  projectIds: readonly string[];
  ctx: ViewContext;
}) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(column, ctx.theme),
        borderRadius: 8,
        backgroundColor: ctx.theme.colors.surface1,
        padding: 10,
        gap: 6,
      }}
    >
      <ProjectChips projectIds={projectIds} ctx={ctx} />
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>{text}</Text>
    </View>
  );
}

function TaskCard({ task, column, ctx }: { task: Task; column: ColumnKey; ctx: ViewContext }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(column, ctx.theme),
        borderRadius: 8,
        backgroundColor: ctx.theme.colors.surface1,
        padding: 10,
        gap: 6,
      }}
    >
      <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flex: 1 }}>
          {`${task.number} ${task.name}`}
        </Text>
        <Text style={{ color: columnColor(column, ctx.theme), fontSize: ctx.fonts.meta }}>{ctx.t(`taskStatus.${task.status}`)}</Text>
      </View>
      {task.kind === "operation" ? (
        <Text numberOfLines={2} style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
          {`${ctx.t("requestRow.operation")} · ${task.targets.join(", ")}`}
        </Text>
      ) : null}
      {task.blocker?.review?.status === "running" ? (
        <Text style={{ color: ctx.theme.colors.accent, fontSize: ctx.fonts.meta }}>
          {ctx.t("reviewing", {
            done: task.blocker.review.reviewers.filter((item) => item.verdict).length,
            total: task.blocker.review.required,
          })}
        </Text>
      ) : null}
      {task.note ? (
        <Text numberOfLines={3} style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {task.note}
        </Text>
      ) : null}
      <DecisionHistory task={task} ctx={ctx} />
      {task.agentId && ctx.navigation ? (
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <CtaButton
            size="sm"
            label={ctx.t("card.open")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
          />
        </View>
      ) : null}
    </View>
  );
}

function ItemCard({
  item,
  request,
  column,
  ctx,
}: {
  item: RequestItem;
  request: CoordinatorRequest;
  column: ColumnKey;
  ctx: ViewContext;
}) {
  if (item.kind === "task") return <TaskCard task={item.task} column={column} ctx={ctx} />;
  const text =
    item.kind === "planning"
      ? ctx.t("requestRow.planningCard")
      : item.kind === "question"
        ? ctx.t("requestRow.questionCard")
        : item.kind === "stall"
          ? ctx.t("requestRow.stallCard")
          : ctx.t("requestRow.answerCard");
  return <PlaceholderCard text={text} column={column} projectIds={requestProjectIds(request)} ctx={ctx} />;
}

/**
 * 요청 칸. 시작 카드를 확인한 뒤에도 수정 지시를 보낼 곳이 있어야 한다. 시작 카드에만 있으면 확인을 누르는 순간 요청 단위로
 * 지시할 입구가 사라졌다 (2026-11-26 전수 검사).
 */
function RequestCell({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const cancel = useRpc(cancelRequestRpc);
  const revise = useRpc(revisePlanRpc);
  const cancelMutation = useMutation({ mutationFn: () => cancel({ id: request.id }) });
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const reviseMutation = useMutation({
    mutationFn: () => revise({ id: request.id, text }),
    onSuccess: () => {
      setText("");
      setRevising(false);
    },
  });
  const failure = reviseMutation.error ?? cancelMutation.error;
  // 조사 워커는 읽기 전용이라 지시를 실행하지 못한다. 조사가 끝나면 코디네이터가 그 지시로 계획한다는 것을 말한다.
  const placeholder =
    request.kind === "read" && request.status === "running" ? ctx.t("requestRow.revisePlaceholderRead") : ctx.t("requestRow.revisePlaceholder");
  const done = request.tasks.filter((task) => task.status === "done").length;
  // 취소한 작업은 할 일에서 빠진다. 세면 끝난 요청이 끝나지 않은 것처럼 보인다.
  const total = request.tasks.filter((task) => task.status !== "canceled").length;
  return (
    <View style={{ gap: 4 }}>
      <GradeBadge
        grade={request.grade}
        label={
          request.grade
            ? ctx.t("card.grade", { grade: request.grade })
            : request.kind === "read"
              ? ctx.t("requestRow.readKind")
              : ctx.t("requestRow.noGrade")
        }
        theme={ctx.theme}
      />
      <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
      <Text numberOfLines={3} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>
        {requestTitle(request)}
      </Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
        {request.tasks.length > 0
          ? `${ctx.t(`requestRow.${request.status}`)} · ${ctx.t("requestRow.progress", { done, total })}`
          : ctx.t(`requestRow.${request.status}`)}
      </Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{formatAgo(request.createdAt, ctx.now, ctx.t)}</Text>
      {isActiveRequest(request) ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
          {/* 계획 전 질문이 열려 있으면 지시는 질문 카드에서 보낸다. 여기서 보내면 질문과 따로 놀아 코디네이터가 처리할 수 없다. */}
          {request.status === "needs_input" ? null : (
          <CtaButton
            size="sm"
            label={revising ? ctx.t("requestRow.closeRevise") : ctx.t("requestRow.revise")}
            disabled={reviseMutation.isPending}
            theme={ctx.theme}
            onPress={() => setRevising((value) => !value)}
          />
          )}
          <CtaButton
            size="sm"
            label={ctx.t("requestRow.cancel")}
            disabled={cancelMutation.isPending}
            theme={ctx.theme}
            onPress={() => cancelMutation.mutate()}
          />
        </View>
      ) : null}
      {revising ? (
        <View style={{ gap: 6 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={placeholder}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={placeholder}
            style={{
              minHeight: 60,
              padding: 8,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: ctx.theme.colors.border,
              backgroundColor: ctx.theme.colors.surface0,
              color: ctx.theme.colors.foreground,
              fontSize: ctx.fonts.meta,
              textAlignVertical: "top",
            }}
          />
          <View style={{ flexDirection: "row" }}>
            <CtaButton
              size="sm"
              label={ctx.t("requestRow.sendRevise")}
              tone="primary"
              disabled={reviseMutation.isPending || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => reviseMutation.mutate()}
            />
          </View>
        </View>
      ) : null}
      {failure ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("inbox.failed", { message: failure instanceof Error ? failure.message : String(failure) })}
        </Text>
      ) : null}
    </View>
  );
}

/** 보드의 요청 한 줄. 왼쪽 칸은 요청, 나머지 칸은 상태 컬럼이다. */
export function RequestRow({ request, ctx, firstColumnWidth }: { request: CoordinatorRequest; ctx: ViewContext; firstColumnWidth: number }) {
  const cells = requestCells(request);
  const urgent = COLUMN_KEYS.find((key) => (cells.get(key)?.length ?? 0) > 0) ?? "waiting";
  return (
    <View
      style={{
        flexDirection: "row",
        borderBottomWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(urgent, ctx.theme),
      }}
    >
      <View style={{ width: firstColumnWidth - 3, padding: 10 }}>
        <RequestCell request={request} ctx={ctx} />
      </View>
      {COLUMN_KEYS.map((key) => (
        <View key={key} style={{ flex: 1, minWidth: 0, padding: 8, gap: 8, borderLeftWidth: 1, borderColor: ctx.theme.colors.border }}>
          {(cells.get(key) ?? []).map((item, index) => (
            <ItemCard key={item.kind === "task" ? `t${item.task.number}` : `${item.kind}${index}`} item={item} request={request} column={key} ctx={ctx} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** 좁은 화면용. 요청마다 상태와 카드를 위아래로 쌓는다. */
export function CompactRequest({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const cells = requestCells(request);
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: ctx.theme.colors.border }}>
      <RequestCell request={request} ctx={ctx} />
      {COLUMN_KEYS.flatMap((key) =>
        (cells.get(key) ?? []).map((item, index) => (
          <ItemCard key={`${key}${index}`} item={item} request={request} column={key} ctx={ctx} />
        )),
      )}
    </View>
  );
}

/** 끝난(완료·취소) 요청. 칸을 차지하지 않도록 접어 둔다. */
export function FinishedRequests({ requests, ctx }: { requests: readonly CoordinatorRequest[]; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  if (requests.length === 0) return null;
  return (
    <View style={{ padding: 10, gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={ctx.t("requestRow.finished", { count: requests.length })}
        onPress={() => setOpen((value) => !value)}
      >
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {`${open ? "▾" : "▸"} ${ctx.t("requestRow.finished", { count: requests.length })}`}
        </Text>
      </Pressable>
      {open
        ? requests.map((request) => (
            <Text key={request.id} numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, paddingLeft: 14 }}>
              {`${request.status === "done" && request.kind === "read" ? ctx.t("requestRow.answerConfirmed") : ctx.t(`requestRow.${request.status}`)} · ${requestTitle(request)}`}
            </Text>
          ))
        : null}
    </View>
  );
}
