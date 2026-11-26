import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { CancelRequestButton } from "./cancel-request";
import { type CoordinatorRequest, type Task, acknowledgeRpc, cancelRequestRpc, revisePlanRpc, requestProjectIds } from "../shared/model";
import { columnColor } from "./agent-state";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, Decide, Fold, GradeBadge, Lines, Row, type ViewContext } from "./ui";
import { shortPath } from "./workspace-place";

function ProjectName({ projectRef }: { projectRef: ProjectRef }) {
  const name = useProject(projectRef, (project) => project.displayName);
  return <>{name ?? projectRef.id}</>;
}

/** 계획의 작업 한 줄. 처음에는 무엇을 어느 프로젝트에서 어떤 순서로 하는지만 보인다. 범위와 완료 기준은 TaskDetail 로 접어 둔다. */
function TaskLine({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const projects = useProjects({ hosts: [ctx.hostId], where: (project) => project.ref.id === task.projectId });
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
        <Text style={muted}>{projects[0] ? <ProjectName projectRef={projects[0]} /> : task.projectId}</Text>
        {task.dependsOn.length > 0 ? <Text style={muted}>{ctx.t("planCard.dependsOn", { list: task.dependsOn.join(", ") })}</Text> : null}
      </View>
      {task.existingWorkspaceId ? <ExistingWorkspaceLine workspaceId={task.existingWorkspaceId} ctx={ctx} /> : null}
      {task.kind === "operation" ? (
        // 운영 작업은 worktree 밖을 건드린다. 사람이 승인한 대상이 무엇인지 접지 않고 계획에서 바로 보이게 한다 (RULES.md §2.0).
        <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>
          {ctx.t("planCard.operation", { targets: task.targets.join(", ") })}
        </Text>
      ) : null}
    </View>
  );
}

/** 사람의 워크스페이스에 워커가 들어간다는 것을 접지 않고 보인다. 새 worktree 와 달리 사람의 작업 트리와 브랜치에 커밋이 남는다. */
function ExistingWorkspaceLine({ workspaceId, ctx }: { workspaceId: string; ctx: ViewContext }) {
  const place = useWorkspace(workspaceId, (w) => ({ name: w.title ?? w.name, directory: w.directory }));
  return (
    <Text style={{ color: ctx.theme.colors.accent, fontSize: ctx.fonts.meta }}>
      {ctx.t("planCard.existingWorkspace", { name: place?.name ?? workspaceId, path: place?.directory ? shortPath(place.directory) : "?" })}
    </Text>
  );
}

function TaskDetail({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
      {task.scope ? <Text selectable style={muted}>{`${ctx.t("planCard.scope")}: ${task.scope}`}</Text> : null}
      {task.doneCriteria ? <Text selectable style={muted}>{`${ctx.t("planCard.taskDone")}: ${task.doneCriteria}`}</Text> : null}
      {task.requestRefs.length > 0 ? (
        <Text selectable style={muted}>{`${ctx.t("planCard.covers")}: ${task.requestRefs.map((ref) => `"${ref}"`).join(", ")}`}</Text>
      ) : null}
    </View>
  );
}

/**
 * 시작 카드 (확인 필요). 코디네이터가 계획해서 바로 시작한 요청을 사람이 확인하거나 방향을 바꾼다 (RULES.md §2.0).
 * v2 의 계획 승인 카드였다. 이제 승인을 기다리지 않고, 사람은 나중에 보고 멈추거나 수정 지시를 보낸다.
 * 원래 요청 원문을 함께 보여서, 계획이 요청과 어긋나는지 사람이 바로 비교할 수 있게 한다 (RULES.md H1).
 */
export function StartedCard({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const approve = useRpc(acknowledgeRpc);
  const revise = useRpc(revisePlanRpc);
  const cancel = useRpc(cancelRequestRpc);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const action = useMutation({
    mutationFn: async (kind: "approve" | "revise" | "cancel") => {
      if (kind === "approve") await approve({ id: request.id });
      else if (kind === "revise") await revise({ id: request.id, text });
      else await cancel({ id: request.id });
    },
    // 보낸 지시가 입력창에 남으면 성공했는지 모르고 다시 보내게 된다.
    onSuccess: () => {
      setText("");
      setRevising(false);
    },
  });
  const busy = action.isPending;
  const accent = columnColor("review", ctx.theme);
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
        <Chip label={ctx.t("planCard.kind")} color={accent} theme={ctx.theme} />
        <ProjectChips projectIds={requestProjectIds(request)} ctx={ctx} />
        {request.grade ? (
          <GradeBadge grade={request.grade} label={ctx.t("card.grade", { grade: request.grade })} theme={ctx.theme} />
        ) : null}
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {ctx.t("card.taskCount", { count: request.tasks.length })}
        </Text>
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {formatAgo(request.plannedAt ?? request.createdAt, ctx.now, ctx.t)}
        </Text>
      </View>

      {/*
        위에서 아래로 읽으면 내 요청 → 코디네이터가 읽은 방식 → 계획 → 결정 순서가 된다 (DESIGN.md 카드 읽는 순서).
        내 요청과 해석은 접지 않는다. 계획이 요청과 어긋나는지 비교하는 카드라서다 (RULES.md H1).
      */}
      <Row label={ctx.t("planCard.context")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{request.text}</Text>
        {request.doneCriteria ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
            {`${ctx.t("planCard.doneCriteria")}: ${request.doneCriteria}`}
          </Text>
        ) : null}
      </Row>
      {request.feedback.length > 0 ? (
        <Row label={ctx.t("planCard.feedback")} ctx={ctx}>
          <Lines items={request.feedback.map((item) => `${formatAgo(item.at, ctx.now, ctx.t)} · ${item.text}`)} ctx={ctx} />
        </Row>
      ) : null}
      {request.unknowns.length > 0 ? (
        <Row label={ctx.t("planCard.unknowns")} ctx={ctx}>
          <Lines items={request.unknowns} ctx={ctx} />
        </Row>
      ) : null}
      <Row label={ctx.t("planCard.tasks")} ctx={ctx}>
        {request.tasks.map((task) => (
          <TaskLine key={task.number} task={task} ctx={ctx} />
        ))}
        {request.beforeChange ? (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("planCard.beforeChange")}</Text>
        ) : null}
      </Row>
      <Fold
        ctx={ctx}
        items={[
          request.grade
            ? {
                label: ctx.t("planCard.gradeReasons"),
                content: (
                  <>
                    <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>
                      {ctx.t("planCard.decideGrade", { grade: request.grade, count: request.tasks.length })}
                    </Text>
                    <Lines items={request.gradeReasons} ctx={ctx} />
                  </>
                ),
              }
            : null,
          request.tasks.some((task) => task.scope || task.doneCriteria || task.requestRefs.length > 0)
            ? {
                label: ctx.t("planCard.taskDetails"),
                content: request.tasks.map((task) => <TaskDetail key={task.number} task={task} ctx={ctx} />),
              }
            : null,
          request.risks.length > 0
            ? { label: ctx.t("planCard.risks"), count: request.risks.length, content: <Lines items={request.risks} ctx={ctx} /> }
            : null,
          request.recommendation
            ? {
                label: ctx.t("planCard.recommendation"),
                content: <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{request.recommendation}</Text>,
              }
            : null,
        ]}
      />
      <Decide question={ctx.t("planCard.decide")} ctx={ctx} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("planCard.approve")} tone="primary" disabled={busy} theme={ctx.theme} onPress={() => action.mutate("approve")} />
        <CtaButton
          label={revising ? ctx.t("planCard.closeRevise") : ctx.t("planCard.revise")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setRevising((value) => !value)}
        />
        <CancelRequestButton request={request} label={ctx.t("planCard.cancel")} busy={busy} onConfirm={() => action.mutate("cancel")} ctx={ctx} />
      </View>
      {revising ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={request.kind === "read" ? ctx.t("requestRow.revisePlaceholderRead") : ctx.t("planCard.revisePlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={request.kind === "read" ? ctx.t("requestRow.revisePlaceholderRead") : ctx.t("planCard.revisePlaceholder")}
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
              onPress={() => action.mutate("revise")}
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
