import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgents, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { AgentCard } from "./agent-card";
import { COLUMNS, type ColumnKey, columnColor, columnRank } from "./agent-state";
import { useClassifier } from "./pending-store";
import { formatAgo } from "./time";
import { Chip, type ViewContext } from "./ui";

type Board = Map<string, Map<ColumnKey, readonly AgentRef[]>>;

const SEPARATOR = "::";
const WORKSPACE_COLUMN_WIDTH = 220;

/**
 * 한 번의 쿼리로 에이전트를 (워크스페이스, 컬럼) 칸에 나눈다. 행 정렬에 각 워크스페이스의 가장 급한 컬럼이
 * 필요한데, 칸 단위로 묶어 두면 snapshot 을 따로 읽지 않고도 그 값을 알 수 있다.
 */
function useBoard(hostId: string): { board: Board; rows: readonly string[]; totals: Map<ColumnKey, number> } {
  const classify = useClassifier();
  const groups = useAgents({
    hosts: [hostId],
    where: classify.isCard,
    orderBy: ["lastActivityAt", "desc"],
    groupBy: (a) => `${a.workspaceId}${SEPARATOR}${classify.column(a)}`,
  });
  return useMemo(() => {
    const board: Board = new Map();
    const totals = new Map<ColumnKey, number>();
    for (const group of groups) {
      const [workspaceId, column] = group.key.split(SEPARATOR) as [string, ColumnKey];
      if (!board.has(workspaceId)) board.set(workspaceId, new Map());
      board.get(workspaceId)!.set(column, group.items);
      totals.set(column, (totals.get(column) ?? 0) + group.items.length);
    }
    const urgency = (workspaceId: string) =>
      Math.min(...[...board.get(workspaceId)!.keys()].map(columnRank));
    const rows = [...board.keys()].sort((a, b) => urgency(a) - urgency(b));
    return { board, rows, totals };
  }, [groups]);
}

function mostUrgent(cells: Map<ColumnKey, readonly AgentRef[]>): ColumnKey {
  return COLUMNS.find((column) => (cells.get(column.key)?.length ?? 0) > 0)?.key ?? "waiting";
}

function WorkspaceCell({ workspaceId, ctx }: { workspaceId: string; ctx: ViewContext }) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    project: w.projectDisplayName,
    name: w.title ?? w.name,
    branch: w.branch,
    diff: w.diffStat,
    enteredAt: w.statusEnteredAt ?? w.lastPromptAt,
  }));
  if (!workspace) return null;
  return (
    <View style={{ gap: 4 }}>
      <Chip label={workspace.project} color={ctx.theme.colors.accent} theme={ctx.theme} />
      <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: 12 }}>
        {workspace.name}
      </Text>
      {workspace.branch ? (
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 11 }}>
          {workspace.branch}
          {workspace.diff ? `  +${workspace.diff.additions} −${workspace.diff.deletions}` : ""}
        </Text>
      ) : null}
      {workspace.enteredAt ? (
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 11 }}>
          {formatAgo(workspace.enteredAt, ctx.now)}
        </Text>
      ) : null}
    </View>
  );
}

function HeaderRow({ totals, ctx }: { totals: Map<ColumnKey, number>; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
      <View style={{ width: WORKSPACE_COLUMN_WIDTH, padding: 10, justifyContent: "flex-end" }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>요청 · 워크스페이스</Text>
      </View>
      {COLUMNS.map((column) => (
        <View key={column.key} style={{ flex: 1, padding: 10, gap: 2 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: columnColor(column.key, ctx.theme), fontSize: 12, fontWeight: "600" }}>
              {column.label}
            </Text>
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>
              {String(totals.get(column.key) ?? 0)}
            </Text>
          </View>
          <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 11 }}>
            {column.hint}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** 보드를 가로지르는 구역 제목 줄. */
function SectionRow({ title, detail, ctx }: { title: string; detail: string; ctx: ViewContext }) {
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 6,
        backgroundColor: ctx.theme.colors.surface1,
        borderBottomWidth: 1,
        borderColor: ctx.theme.colors.border,
      }}
    >
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text>
    </View>
  );
}

// 3단계에서 코디네이터 요청 저장소가 생기면 요청마다 한 행씩 그린다. 그 전에는 자리만 보여 준다.
function RequestRowsPlaceholder({ ctx }: { ctx: ViewContext }) {
  return (
    <View style={{ padding: 12, borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>
        코디네이터에게 보낸 요청이 아직 없어요. 요청을 보내면 요청마다 한 줄씩, 작업 카드가 상태 칸에 놓여요.
      </Text>
    </View>
  );
}

function BoardRow({
  workspaceId,
  cells,
  ctx,
}: {
  workspaceId: string;
  cells: Map<ColumnKey, readonly AgentRef[]>;
  ctx: ViewContext;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        borderBottomWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(mostUrgent(cells), ctx.theme),
      }}
    >
      <View style={{ width: WORKSPACE_COLUMN_WIDTH - 3, padding: 10 }}>
        <WorkspaceCell workspaceId={workspaceId} ctx={ctx} />
      </View>
      {COLUMNS.map((column) => (
        <View
          key={column.key}
          style={{ flex: 1, minWidth: 0, padding: 8, gap: 8, borderLeftWidth: 1, borderColor: ctx.theme.colors.border }}
        >
          {(cells.get(column.key) ?? []).map((ref) => (
            <AgentCard key={ref.key} agentRef={ref} ctx={ctx} />
          ))}
        </View>
      ))}
    </View>
  );
}

function CompactCard({ agentRef, workspaceId, ctx }: { agentRef: AgentRef; workspaceId: string; ctx: ViewContext }) {
  const label = useWorkspace(workspaceId, (w) => `${w.projectDisplayName} · ${w.title ?? w.name}`);
  return <AgentCard agentRef={agentRef} ctx={ctx} workspaceLabel={label} />;
}

/** 좁은 화면에서는 컬럼을 위아래로 쌓고, 카드마다 워크스페이스를 적는다. */
function CompactBoard({ board, rows, totals, ctx }: { board: Board; rows: readonly string[]; totals: Map<ColumnKey, number>; ctx: ViewContext }) {
  return (
    <View style={{ gap: 16 }}>
      {COLUMNS.map((column) => (
        <View key={column.key} style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: columnColor(column.key, ctx.theme), fontSize: 13, fontWeight: "600" }}>
              {column.label}
            </Text>
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 13 }}>
              {`${totals.get(column.key) ?? 0} · ${column.hint}`}
            </Text>
          </View>
          {rows.flatMap((workspaceId) =>
            (board.get(workspaceId)?.get(column.key) ?? []).map((ref) => (
              <CompactCard key={ref.key} agentRef={ref} workspaceId={workspaceId} ctx={ctx} />
            )),
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * 진행 현황 보드. 행은 요청(3단계부터)과, 코디네이터를 거치지 않고 직접 띄운 에이전트의 워크스페이스다.
 * 요청 하나는 여러 프로젝트에 걸치므로, 워크스페이스가 아니라 요청을 행으로 써야 "어느 요청이 어디서 막혔나"가 한 줄에 보인다.
 */
export function KanbanBoard({ ctx }: { ctx: ViewContext }) {
  const { board, rows, totals } = useBoard(ctx.hostId);
  if (ctx.compact) return <CompactBoard board={board} rows={rows} totals={totals} ctx={ctx} />;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      <HeaderRow totals={totals} ctx={ctx} />
      <SectionRow title="요청" detail="0" ctx={ctx} />
      <RequestRowsPlaceholder ctx={ctx} />
      <SectionRow title="직접 띄운 에이전트" detail={`워크스페이스 ${rows.length}`} ctx={ctx} />
      {rows.length === 0 ? (
        <View style={{ padding: 12 }}>
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: 12 }}>이 host에 에이전트가 없어요.</Text>
        </View>
      ) : (
        rows.map((workspaceId) => (
          <BoardRow key={workspaceId} workspaceId={workspaceId} cells={board.get(workspaceId)!} ctx={ctx} />
        ))
      )}
    </View>
  );
}
