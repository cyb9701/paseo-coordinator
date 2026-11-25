import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useWorkspace } from "@getpaseo/plugin/client";
import { View } from "react-native";
import { ProjectTag, type ViewContext } from "./ui";

// 모든 카드에 어느 프로젝트 일인지 보인다 (2026-11-25 사용자 요청). 등급·종류 칩과 다른 모양(ProjectTag)을 쓴다.

function NamedProjectChip({ projectRef, ctx }: { projectRef: ProjectRef; ctx: ViewContext }) {
  const name = useProject(projectRef, (project) => project.displayName);
  return <ProjectTag label={name ?? projectRef.id} theme={ctx.theme} />;
}

/** 요청 기반 카드용. 프로젝트 id 목록을 이름 칩으로 보인다. 없으면 '프로젝트 미정'. */
export function ProjectChips({ projectIds, ctx }: { projectIds: readonly string[]; ctx: ViewContext }) {
  const refs = useProjects({ hosts: [ctx.hostId], where: (project) => projectIds.includes(project.ref.id) });
  if (projectIds.length === 0) {
    return <ProjectTag label={ctx.t("card.noProject")} theme={ctx.theme} />;
  }
  // 등록이 풀린 프로젝트는 id 로라도 보인다.
  const missing = projectIds.filter((id) => !refs.some((ref) => ref.id === id));
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 10, rowGap: 4 }}>
      {refs.map((ref) => (
        <NamedProjectChip key={ref.key} projectRef={ref} ctx={ctx} />
      ))}
      {missing.map((id) => (
        <ProjectTag key={id} label={id} theme={ctx.theme} />
      ))}
    </View>
  );
}

/** 에이전트 기반 카드용. 에이전트가 속한 워크스페이스의 프로젝트를 보인다. */
export function WorkspaceProjectChip({ workspaceId, ctx }: { workspaceId: string; ctx: ViewContext }) {
  const name = useWorkspace(workspaceId, (workspace) => workspace.projectDisplayName);
  return <ProjectTag label={name ?? ctx.t("card.noProject")} theme={ctx.theme} />;
}
