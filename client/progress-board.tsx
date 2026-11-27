import type { AgentRef } from "@getpaseo/plugin/client";
import { useAgents, useSettings, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { type ReactNode, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Decision, WorkspaceStatus } from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { AgentCard } from "./agent-card";
import { COLUMN_KEYS, type ColumnKey, columnColor, columnFor, isVisibleAgent, needsPerson } from "./agent-state";
import { type DecisionIndex, type WorkspaceSignals, boardCells, indexDecisions, rowColumn, signals, sortRows } from "./board";
import { statusOf, useCoordinatorState, useWorkspaceStatuses } from "./coordinator-state";
import { useClassifier } from "./pending-store";
import { formatAgo } from "./time";
import { CtaButton, ErrorLine, Muted, ProjectTag, type ViewContext, errorText } from "./ui";
import { shortPath } from "./workspace-place";
import { RequestComposer } from "./requests-view";
import { PullRequestLine, WorkspaceReview } from "./workspace-review";
import { openRequestCounts } from "./requests";
import { toWorkspaceRef } from "./refs";

const SEPARATOR = "::";
const WORKSPACE_COLUMN_WIDTH = 260;
const NO_DECISIONS: readonly Decision[] = [];
const NO_COUNTS = { waiting: 0, unreviewed: 0 };
const NO_REQUESTS = { queued: 0, suggested: 0 };

type Cells = Map<ColumnKey, readonly AgentRef[]>;
/** 행 아래에 펼치는 것: 결정 목록이나 추가 요청 작성. 한 번에 하나만 연다. */
type Panel = "review" | "request" | null;

/** 행 머리: 어느 프로젝트의 어느 워크스페이스인지, 어디서 도는지. 지켜보는 프로젝트면 PR 과 결정 신호를 더한다. */
function WorkspaceCell({
  workspaceId,
  status,
  flags,
  panel,
  onPanel,
  requests,
  ctx,
}: {
  workspaceId: string;
  status: WorkspaceStatus | null;
  flags: WorkspaceSignals | null;
  panel: Panel;
  onPanel(panel: Panel): void;
  requests: { queued: number; suggested: number };
  ctx: ViewContext;
}) {
  const workspace = useWorkspace(toWorkspaceRef(ctx.hostId, workspaceId), (w) => ({
    project: w.projectDisplayName,
    name: w.title ?? w.name,
    branch: w.branch,
    directory: w.directory,
    diff: w.diffStat,
    at: w.statusEnteredAt ?? w.lastPromptAt,
  }));
  if (!workspace) return null;
  const meta = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View style={{ gap: 4 }}>
      <ProjectTag label={workspace.project} theme={ctx.theme} />
      <Text numberOfLines={2} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>
        {workspace.name}
      </Text>
      {workspace.branch ? (
        <Text numberOfLines={1} style={meta}>
          {workspace.branch}
          {workspace.diff ? `  +${workspace.diff.additions} −${workspace.diff.deletions}` : ""}
        </Text>
      ) : null}
      {workspace.directory ? (
        <Text numberOfLines={1} ellipsizeMode="head" selectable style={meta}>
          {shortPath(workspace.directory)}
        </Text>
      ) : null}
      {workspace.at ? <Text style={meta}>{formatAgo(workspace.at, ctx.now, ctx.t)}</Text> : null}
      {status?.pullRequest ? <PullRequestLine pr={status.pullRequest} ctx={ctx} /> : null}
      {flags ? (
        <View style={{ gap: 2 }}>
          {flags.waiting ? <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("board.waiting", { count: flags.waiting })}</Text> : null}
          {flags.unreviewed ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t("board.unreviewed", { count: flags.unreviewed })}</Text> : null}
          {flags.unexplained ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("board.unexplained", { count: flags.unexplained })}</Text> : null}
          {flags.overlaps ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("board.overlaps", { count: flags.overlaps })}</Text> : null}
          {status?.changedFiles.length ? (
            <Muted text={flags.recorded ? ctx.t("board.changed", { count: status.changedFiles.length }) : ctx.t("board.changedNoDecisions", { count: status.changedFiles.length })} ctx={ctx} />
          ) : null}
          {status?.error ? <Muted text={errorText(status.error, ctx.t)} ctx={ctx} /> : null}
        </View>
      ) : null}
      {requests.queued ? <Text style={{ color: ctx.theme.colors.accent, fontSize: ctx.fonts.meta }}>{ctx.t("board.requestsQueued", { count: requests.queued })}</Text> : null}
      {requests.suggested ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("board.requestsSuggested", { count: requests.suggested })}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
        {flags ? (
          <CtaButton size="sm" label={panel === "review" ? `▾ ${ctx.t("board.review")}` : `▸ ${ctx.t("board.review")}`} theme={ctx.theme} onPress={() => onPanel(panel === "review" ? null : "review")} />
        ) : null}
        <CtaButton size="sm" label={panel === "request" ? `▾ ${ctx.t("board.addRequest")}` : `+ ${ctx.t("board.addRequest")}`} theme={ctx.theme} onPress={() => onPanel(panel === "request" ? null : "request")} />
      </View>
    </View>
  );
}

function CardsFor({ refs, index, column, ctx, label }: { refs: readonly AgentRef[]; index: DecisionIndex; column: ColumnKey; ctx: ViewContext; label?: string | null }) {
  return (
    <>
      {refs.map((ref) => (
        <AgentCard key={ref.key} agentRef={ref} column={column} decisions={index.byAgent.get(ref.id) ?? NO_COUNTS} workspaceLabel={label} ctx={ctx} />
      ))}
    </>
  );
}

/** 넓은 화면의 한 행. 행 머리 오른쪽에 열마다 에이전트 카드를 두고, 펼치면 아래에 판단 흐름을 행 너비로 연다. */
function BoardRow({
  workspaceId,
  cells,
  index,
  status,
  watched,
  requestCounts,
  ctx,
}: {
  workspaceId: string;
  cells: Cells | undefined;
  index: DecisionIndex;
  status: WorkspaceStatus | null;
  watched: boolean;
  requestCounts: Map<string, { queued: number; suggested: number }>;
  ctx: ViewContext;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const decisions = index.byWorkspace.get(workspaceId) ?? NO_DECISIONS;
  const flags = watched ? signals(status, decisions) : null;
  const requests = requestCounts.get(workspaceId) ?? NO_REQUESTS;
  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(rowColumn(cells, flags), ctx.theme),
      }}
    >
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: WORKSPACE_COLUMN_WIDTH - 3, padding: 10 }}>
          <WorkspaceCell workspaceId={workspaceId} status={status} flags={flags} panel={panel} onPanel={setPanel} requests={requests} ctx={ctx} />
        </View>
        {COLUMN_KEYS.map((key) => (
          <View key={key} style={{ flex: 1, minWidth: 0, padding: 8, gap: 8, borderLeftWidth: 1, borderColor: ctx.theme.colors.border }}>
            <CardsFor refs={cells?.get(key) ?? []} index={index} column={key} ctx={ctx} />
          </View>
        ))}
      </View>
      {panel ? (
        <View style={{ padding: 12, borderTopWidth: 1, borderColor: ctx.theme.colors.border, backgroundColor: ctx.theme.colors.surface1 }}>
          {panel === "review" ? (
            <WorkspaceReview workspaceId={workspaceId} decisions={decisions} status={status} ctx={ctx} />
          ) : (
            <RequestComposer workspaceId={workspaceId} onDone={() => setPanel(null)} ctx={ctx} />
          )}
        </View>
      ) : null}
    </View>
  );
}

/** 좁은 화면의 한 행. 열 대신 카드를 위아래로 쌓고, 카드마다 열 색 띠로 상태를 보인다. */
function CompactRow({
  workspaceId,
  cells,
  index,
  status,
  watched,
  requestCounts,
  ctx,
}: {
  workspaceId: string;
  cells: Cells | undefined;
  index: DecisionIndex;
  status: WorkspaceStatus | null;
  watched: boolean;
  requestCounts: Map<string, { queued: number; suggested: number }>;
  ctx: ViewContext;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const decisions = index.byWorkspace.get(workspaceId) ?? NO_DECISIONS;
  const flags = watched ? signals(status, decisions) : null;
  const requests = requestCounts.get(workspaceId) ?? NO_REQUESTS;
  return (
    <View
      style={{
        gap: 8,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: columnColor(rowColumn(cells, flags), ctx.theme),
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      <WorkspaceCell workspaceId={workspaceId} status={status} flags={flags} panel={panel} onPanel={setPanel} requests={requests} ctx={ctx} />
      {COLUMN_KEYS.map((key) => (
        <CardsFor key={key} refs={cells?.get(key) ?? []} index={index} column={key} ctx={ctx} />
      ))}
      {panel === "review" ? <WorkspaceReview workspaceId={workspaceId} decisions={decisions} status={status} ctx={ctx} /> : null}
      {panel === "request" ? <RequestComposer workspaceId={workspaceId} onDone={() => setPanel(null)} ctx={ctx} /> : null}
    </View>
  );
}

function HeaderRow({ totals, ctx }: { totals: Map<ColumnKey, number>; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderColor: ctx.theme.colors.border }}>
      <View style={{ width: WORKSPACE_COLUMN_WIDTH, padding: 10, justifyContent: "flex-end" }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("board.workspace")}</Text>
      </View>
      {COLUMN_KEYS.map((key) => (
        <View key={key} style={{ flex: 1, padding: 10, gap: 2 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ color: columnColor(key, ctx.theme), fontSize: ctx.fonts.meta, fontWeight: "600" }}>{ctx.t(`columns.${key}.label`)}</Text>
            <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{String(totals.get(key) ?? 0)}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
            {ctx.t(`columns.${key}.hint`)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Frame({ children, ctx }: { children: ReactNode; ctx: ViewContext }) {
  return (
    <View style={{ borderWidth: 1, borderColor: ctx.theme.colors.border, borderRadius: 10, overflow: "hidden", backgroundColor: ctx.theme.colors.surface0 }}>
      {children}
    </View>
  );
}

/**
 * 진행 현황 표. 행은 워크스페이스, 열은 사람을 얼마나 기다리는지다. 이 host 의 모든 에이전트를 보인다(상태만 읽어 비용이 없다).
 * 지켜보는 프로젝트의 워크스페이스는 에이전트가 없어도 행이 있고, 행 머리에 PR 상태와 결정 신호가 붙으며 판단 흐름을 펼칠 수 있다.
 * 사람을 더 기다리는 행이 위로 온다.
 */
export function ProgressBoard({ ctx }: { ctx: ViewContext }) {
  const settings = useSettings(coordinatorSettings);
  const projectIds = settings.status === "ready" ? settings.values.projectIds : [];
  const { state } = useCoordinatorState();
  const statuses = useWorkspaceStatuses(ctx.hostId);
  const classify = useClassifier();
  const index = useMemo(() => indexDecisions(state?.decisions ?? []), [state?.decisions]);
  const [refreshing, setRefreshing] = useState(false);
  const column = (agent: Parameters<typeof classify.state>[0]) => {
    const counts = index.byAgent.get(agent.id) ?? NO_COUNTS;
    return columnFor(classify.state(agent), { waiting: counts.waiting > 0, unreviewed: counts.unreviewed > 0 });
  };
  // 에이전트마다 워크스페이스. 하위 세션의 부모가 같은 워크스페이스에 있는지 가리는 데 쓴다.
  const byWorkspace = useAgents({ hosts: [ctx.hostId], where: (a) => isVisibleAgent(a), groupBy: (a) => a.workspaceId });
  const workspaceOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of byWorkspace) for (const ref of group.items) map.set(ref.id, group.key);
    return map;
  }, [byWorkspace]);
  // 하위 세션은 부모 카드 안에 접는다. 부모가 다른 워크스페이스에 있거나(다른 에이전트가 띄운 경우) 사람을 기다리면 따로 카드가 된다.
  const groups = useAgents({
    hosts: [ctx.hostId],
    where: (a) =>
      isVisibleAgent(a) &&
      (a.parentAgentId === null ||
        workspaceOf.get(a.parentAgentId) !== a.workspaceId ||
        needsPerson(classify.state(a)) ||
        (index.byAgent.get(a.id)?.waiting ?? 0) > 0),
    orderBy: ["lastActivityAt", "desc"],
    groupBy: (a) => `${a.workspaceId}${SEPARATOR}${column(a)}`,
  });
  const watched = useWorkspaces({
    hosts: [ctx.hostId],
    where: (w) => projectIds.includes(w.projectId) && !w.background && !w.archivingAt,
  });
  const { board, totals } = useMemo(() => boardCells(groups, SEPARATOR), [groups]);
  const watchedIds = new Set(watched.map((ref) => ref.id));
  const rows = sortRows([...board.keys(), ...watchedIds], (workspaceId) => {
    const flags = watchedIds.has(workspaceId) ? signals(statusOf(statuses.data?.workspaces, workspaceId), index.byWorkspace.get(workspaceId) ?? NO_DECISIONS) : null;
    return rowColumn(board.get(workspaceId), flags);
  });
  const refresh = async () => {
    setRefreshing(true);
    // 실패는 같은 query 의 error 로 남아 아래 ErrorLine 에 보인다(useWorkspaceStatuses). 여기서는 버튼만 되살린다.
    await statuses.refresh().catch(() => undefined);
    setRefreshing(false);
  };
  const requestCounts = useMemo(() => openRequestCounts(state?.requests ?? []), [state?.requests]);
  const rowProps = (workspaceId: string) => ({
    workspaceId,
    requestCounts,
    cells: board.get(workspaceId),
    index,
    status: statusOf(statuses.data?.workspaces, workspaceId),
    watched: watchedIds.has(workspaceId),
    ctx,
  });
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Muted text={projectIds.length ? ctx.t("board.hint") : ctx.t("board.noProjects")} ctx={ctx} />
        <View style={{ flex: 1 }} />
        {statuses.data && projectIds.length ? <Muted text={ctx.t("board.checked", { ago: formatAgo(statuses.data.at, ctx.now, ctx.t) })} ctx={ctx} /> : null}
        {projectIds.length ? <CtaButton size="sm" label={ctx.t("board.refresh")} disabled={refreshing} theme={ctx.theme} onPress={() => void refresh()} /> : null}
      </View>
      <ErrorLine error={statuses.error} ctx={ctx} />
      {rows.length === 0 ? <Muted text={ctx.t("board.empty")} ctx={ctx} /> : null}
      {ctx.compact ? (
        rows.map((workspaceId) => <CompactRow key={workspaceId} {...rowProps(workspaceId)} />)
      ) : rows.length ? (
        <Frame ctx={ctx}>
          <HeaderRow totals={totals} ctx={ctx} />
          {rows.map((workspaceId) => (
            <BoardRow key={workspaceId} {...rowProps(workspaceId)} />
          ))}
        </Frame>
      ) : null}
    </View>
  );
}
