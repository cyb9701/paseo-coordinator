import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type CoordinatorRequest, type Task, cancelRequestRpc, requestProjectIds } from "../shared/model";
import { COLUMN_KEYS, type ColumnKey, columnColor } from "./agent-state";
import { DecisionHistory } from "./decision-history";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { CtaButton, GradeBadge, type ViewContext } from "./ui";

export type RequestItem = { kind: "planning" } | { kind: "question" } | { kind: "answer" } | { kind: "task"; task: Task };

/**
 * 작업이 놓일 컬럼. 워커가 막힘을 보고했으면, 코디네이터가 판단하는 동안은 '코디네이터 처리 중',
 * 결정 카드가 나오면 '내 결정 필요'다. 완료를 보고하고 머지를 기다리는 작업도 '내 결정 필요'다.
 */
function taskColumn(task: Task): ColumnKey | null {
  if (task.blocker) return task.blocker.coordinator ? "react" : "auto";
  // 완료를 보고한 작업은 사람의 머지를 기다린다 (PR 머지 카드).
  if (task.status === "review" && task.completion && !task.completion.closedAt) return "react";
  return TASK_COLUMNS[task.status];
}

// 작업 상태를 보드 컬럼에 놓는다. 막힌 작업은 사람을 기다리므로 가장 왼쪽(내 결정 필요)이다.
const TASK_COLUMNS: Record<Task["status"], ColumnKey | null> = {
  blocked: "react",
  review: "review",
  running: "running",
  waiting: "waiting",
  done: null,
};

/** 요청 하나를 (컬럼 → 카드) 로 나눈다. 헤더의 컬럼별 숫자도 이 결과로 센다. */
export function requestCells(request: CoordinatorRequest): Map<ColumnKey, RequestItem[]> {
  const cells = new Map<ColumnKey, RequestItem[]>();
  const add = (column: ColumnKey, item: RequestItem) => cells.set(column, [...(cells.get(column) ?? []), item]);
  if (request.status === "planning") add("auto", { kind: "planning" });
  if (request.status === "needs_input") add("react", { kind: "question" });
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
        : ctx.t("requestRow.answerCard");
  return <PlaceholderCard text={text} column={column} projectIds={requestProjectIds(request)} ctx={ctx} />;
}

function RequestCell({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const cancel = useRpc(cancelRequestRpc);
  const cancelMutation = useMutation({ mutationFn: () => cancel({ id: request.id }) });
  const done = request.tasks.filter((task) => task.status === "done").length;
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
          ? `${ctx.t(`requestRow.${request.status}`)} · ${ctx.t("requestRow.progress", { done, total: request.tasks.length })}`
          : ctx.t(`requestRow.${request.status}`)}
      </Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{formatAgo(request.createdAt, ctx.now, ctx.t)}</Text>
      {isActiveRequest(request) ? (
        <View style={{ flexDirection: "row", marginTop: 4 }}>
          <CtaButton
            size="sm"
            label={ctx.t("requestRow.cancel")}
            disabled={cancelMutation.isPending}
            theme={ctx.theme}
            onPress={() => cancelMutation.mutate()}
          />
        </View>
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
              {`${ctx.t(`requestRow.${request.status}`)} · ${requestTitle(request)}`}
            </Text>
          ))
        : null}
    </View>
  );
}
