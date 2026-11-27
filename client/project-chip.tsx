import { useWorkspace } from "@getpaseo/plugin/client";
import { toWorkspaceRef } from "./refs";
import { ProjectTag, type ViewContext } from "./ui";

/** 카드가 어느 프로젝트 일인지. 여러 프로젝트의 카드가 한 인박스에 섞이기 때문에 모든 카드에 붙인다. */
export function WorkspaceProjectChip({ workspaceId, ctx }: { workspaceId: string; ctx: ViewContext }) {
  const name = useWorkspace(toWorkspaceRef(ctx.hostId, workspaceId), (workspace) => workspace.projectDisplayName);
  return <ProjectTag label={name ?? ctx.t("card.noProject")} theme={ctx.theme} />;
}
