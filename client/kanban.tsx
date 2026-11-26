import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgents, useWorkspace } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { useCoordinatorState } from "./coordinator-state";
import { CompactRequest, FinishedRequests, RequestRow, isActiveRequest, requestCells } from "./request-rows";
import { Text, View } from "react-native";
import { AgentCard } from "./agent-card";
import { COLUMN_KEYS, type ColumnKey, columnColor, columnRank } from "./agent-state";
import { useClassifier } from "./pending-store";
import { formatAgo } from "./time";
import { ProjectTag, type ViewContext } from "./ui";
import { WorkspacePlace } from "./workspace-place";

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
  return COLUMN_KEYS.find((key) => (cells.get(key)?.length ?? 0) > 0) ?? "waiting";
}

function WorkspaceCell({ workspaceId, ctx }: { workspaceId: string; ctx: ViewContext }) {
  const workspace = useWorkspace(workspaceId, (w) => ({
    project: w.projectDisplayName,
    name: w.title ?? w.name,
    enteredAt: w.statusEnteredAt ?? w.lastPromptAt,
  }));
  if (!workspace) return null;
  return (
    <View style={{ gap: 4 }}>
      <ProjectTag label={workspace.project} theme={ctx.theme} />
      <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
        {workspace.name}
      </Text>
      <WorkspacePlace workspaceId={workspaceId} showDiff ctx={ctx} />
      {workspace.enteredAt ? (
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {formatAgo(workspace.enteredAt, ctx.now, ctx.t)}
        </Text>
      ) : null}
    </View>
  );
}

function HeaderRow({ totals, ctx }: { totals: Map<ColumnKey, number>; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
      <View style={{ width: WORKSPACE_COLUMN_WIDTH, padding: 10, justifyContent: "flex-end" }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("board.requestOrWorkspace")}</Text>
      </View>
      {COLUMN_KEYS.map((key) => (
        <View key={key} style={{ flex: 1, padding: 10, gap: 2 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: columnColor(key, ctx.theme), fontSize: ctx.fonts.meta, fontWeight: "600" }}>
              {ctx.t(`columns.${key}.label`)}
            </Text>
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
              {String(totals.get(key) ?? 0)}
            </Text>
          </View>
          <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
            {ctx.t(`columns.${key}.hint`)}
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
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{detail}</Text>
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
      {COLUMN_KEYS.map((key) => (
        <View
          key={key}
          style={{ flex: 1, minWidth: 0, padding: 8, gap: 8, borderLeftWidth: 1, borderColor: ctx.theme.colors.border }}
        >
          {(cells.get(key) ?? []).map((ref) => (
            <AgentCard key={ref.key} agentRef={ref} ctx={ctx} />
          ))}
        </View>
      ))}
    </View>
  );
}

function CompactCard({ agentRef, workspaceId, ctx }: { agentRef: AgentRef; workspaceId: string; ctx: ViewContext }) {
  const label = useWorkspace(workspaceId, (w) => w.title ?? w.name);
  return <AgentCard agentRef={agentRef} ctx={ctx} workspaceLabel={label} />;
}

/** 좁은 화면에서는 컬럼을 위아래로 쌓고, 카드마다 워크스페이스를 적는다. */
function CompactBoard({ board, rows, totals, ctx }: { board: Board; rows: readonly string[]; totals: Map<ColumnKey, number>; ctx: ViewContext }) {
  return (
    <View style={{ gap: 16 }}>
      {COLUMN_KEYS.map((key) => (
        <View key={key} style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: columnColor(key, ctx.theme), fontSize: ctx.fonts.body, fontWeight: "600" }}>
              {ctx.t(`columns.${key}.label`)}
            </Text>
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.body }}>
              {`${totals.get(key) ?? 0} · ${ctx.t(`columns.${key}.hint`)}`}
            </Text>
          </View>
          {rows.flatMap((workspaceId) =>
            (board.get(workspaceId)?.get(key) ?? []).map((ref) => (
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
  const { board, rows, totals: agentTotals } = useBoard(ctx.hostId);
  const { state } = useCoordinatorState();
  const requests = state?.requests ?? [];
  const active = requests.filter(isActiveRequest).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const finished = requests.filter((request) => !isActiveRequest(request)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // 헤더 숫자는 요청 카드와 직접 띄운 에이전트 카드를 합쳐 센다.
  const totals = new Map(agentTotals);
  for (const request of active) {
    for (const [column, items] of requestCells(request)) totals.set(column, (totals.get(column) ?? 0) + items.length);
  }
  if (ctx.compact) {
    return (
      <View style={{ gap: 16 }}>
        {active.map((request) => (
          <CompactRequest key={request.id} request={request} ctx={ctx} />
        ))}
        <CompactBoard board={board} rows={rows} totals={agentTotals} ctx={ctx} />
        <FinishedRequests requests={finished} ctx={ctx} />
      </View>
    );
  }
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
      <SectionRow title={ctx.t("board.requests")} detail={String(active.length)} ctx={ctx} />
      {active.length === 0 ? (
        <View style={{ padding: 12, borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("board.noRequests")}</Text>
        </View>
      ) : (
        active.map((request) => (
          <RequestRow key={request.id} request={request} ctx={ctx} firstColumnWidth={WORKSPACE_COLUMN_WIDTH} />
        ))
      )}
      <SectionRow title={ctx.t("board.direct")} detail={ctx.t("board.workspaces", { count: rows.length })} ctx={ctx} />
      {rows.length === 0 ? (
        <View style={{ padding: 12 }}>
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("board.noAgents")}</Text>
        </View>
      ) : (
        rows.map((workspaceId) => (
          <BoardRow key={workspaceId} workspaceId={workspaceId} cells={board.get(workspaceId)!} ctx={ctx} />
        ))
      )}
      <FinishedRequests requests={finished} ctx={ctx} />
    </View>
  );
}
