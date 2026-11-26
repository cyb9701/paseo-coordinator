import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useWorkspace } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { CoordinatorRequest, Task } from "../shared/model";
import { Lines, type ViewContext } from "./ui";
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
 * 코디네이터가 세운 계획. 완료 보고서의 '계획'에 접어 둔다. 시작 카드(확인 필요)였는데, 시작했다는 확인을 받는 것도
 * 병목이라 없앴다 (2026-11-27 사용자 결정). 코디네이터가 어떻게 읽었는지(unknowns)는 결과와 함께 볼 때 의미가 있다.
 */
export function PlanDetails({ request, ctx }: { request: CoordinatorRequest; ctx: ViewContext }) {
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View style={{ gap: 8 }}>
      {request.tasks.map((task) => (
        <View key={task.number} style={{ gap: 2 }}>
          <TaskLine task={task} ctx={ctx} />
          {task.scope || task.doneCriteria || task.requestRefs.length > 0 ? <TaskDetail task={task} ctx={ctx} /> : null}
        </View>
      ))}
      {request.grade ? (
        <View style={{ gap: 2 }}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>
            {ctx.t("planCard.decideGrade", { grade: request.grade, count: request.tasks.length })}
          </Text>
          <Lines items={request.gradeReasons} ctx={ctx} muted />
        </View>
      ) : null}
      {request.unknowns.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={muted}>{ctx.t("planCard.unknowns")}</Text>
          <Lines items={request.unknowns} ctx={ctx} muted />
        </View>
      ) : null}
      {request.risks.length > 0 ? (
        <View style={{ gap: 2 }}>
          <Text style={muted}>{ctx.t("planCard.risks")}</Text>
          <Lines items={request.risks} ctx={ctx} muted />
        </View>
      ) : null}
    </View>
  );
}
