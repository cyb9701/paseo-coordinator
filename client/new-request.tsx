import type { ProjectRef, WorkspaceRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc, useSettings, useWorkspace, useWorkspaces } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { createRequestRpc, pluginWorkspaceIds } from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { useCoordinatorState } from "./coordinator-state";
import { ChoiceBox, CtaButton, type ViewContext } from "./ui";
import { shortPath } from "./workspace-place";

function ProjectToggle({
  projectRef,
  selected,
  onToggle,
  ctx,
}: {
  projectRef: ProjectRef;
  selected: boolean;
  onToggle(): void;
  ctx: ViewContext;
}) {
  const name = useProject(projectRef, (p) => p.displayName);
  return <ChoiceBox label={name ?? projectRef.id} selected={selected} multiple onPress={onToggle} theme={ctx.theme} />;
}

function WorkspaceChoice({
  workspaceRef,
  selected,
  onPress,
  ctx,
}: {
  workspaceRef: WorkspaceRef;
  selected: boolean;
  onPress(): void;
  ctx: ViewContext;
}) {
  const place = useWorkspace(workspaceRef, (w) => ({ name: w.title ?? w.name, branch: w.branch, directory: w.directory }));
  if (!place) return null;
  return (
    <ChoiceBox
      label={place.name}
      detail={[place.branch, shortPath(place.directory)].filter(Boolean).join(" · ")}
      selected={selected}
      onPress={onPress}
      theme={ctx.theme}
    />
  );
}

/**
 * 고른 프로젝트마다 워커가 일할 곳을 고른다. 기본은 새 worktree 와 새 브랜치다. 내 워크스페이스를 고르면 워커가 그 안에서 새 세션으로
 * 일한다 (2026-11-26 사용자 결정). worktree 와 브랜치는 1:1 이라, 새 worktree 를 고르면 새 브랜치를 만든다. 그래서 기준 브랜치는
 * 따로 고르지 않는다. 기준은 코디네이터 → 설정의 프로젝트별 기준 브랜치 → 원격 기본 브랜치 순으로 정한다 (2026-11-26 사용자 결정).
 * 플러그인이 다른 작업에 만든 worktree 와 코디네이터 워크스페이스는 보이지 않는다.
 */
function WorkspaceField({
  projectRef,
  value,
  onChange,
  ctx,
}: {
  projectRef: ProjectRef;
  value: string | null;
  onChange(workspaceId: string | null): void;
  ctx: ViewContext;
}) {
  const name = useProject(projectRef, (p) => p.displayName);
  const { state } = useCoordinatorState();
  const pluginIds = useMemo(() => (state ? pluginWorkspaceIds(state) : new Set<string>()), [state]);
  const refs = useWorkspaces({
    hosts: [ctx.hostId],
    where: (w) => w.projectId === projectRef.id && w.kind !== "directory" && !w.archivingAt && !w.background && !pluginIds.has(w.id),
    orderBy: ["lastPromptAt", "desc"],
  });
  // 고른 워크스페이스가 목록에서 사라지면(archive 등) 선택을 푼다. 그대로 두면 보이지 않는 id 가 전송돼 서버가 거절했다.
  const missing = value !== null && !refs.some((ref) => ref.id === value);
  useEffect(() => {
    if (missing) onChange(null);
  }, [missing, onChange]);
  return (
    <Field label={ctx.t("request.workspace", { project: name ?? projectRef.id })} hint={ctx.t("request.workspaceHint")} ctx={ctx}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ChoiceBox label={ctx.t("request.workspaceNew")} selected={value === null} onPress={() => onChange(null)} theme={ctx.theme} />
        {refs.map((ref) => (
          <WorkspaceChoice key={ref.key} workspaceRef={ref} selected={value === ref.id} onPress={() => onChange(ref.id)} ctx={ctx} />
        ))}
      </View>
    </Field>
  );
}

function Field({ label, hint, children, ctx }: { label: string; hint?: string; children: ReactNode; ctx: ViewContext }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{label}</Text>
      {hint ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{hint}</Text> : null}
      {children}
    </View>
  );
}

/**
 * 코디네이터에게 보내는 새 요청. 프로젝트는 설정의 허용 목록 안에서만 고를 수 있다 (server 도 다시 확인한다).
 * 요청을 보낸 앱의 언어를 같이 보내서, 출력 언어 설정이 auto 이면 그 언어로 워크스페이스 이름과 카드를 쓴다.
 */
export function NewRequestPanel({ ctx, locale, onClose }: { ctx: ViewContext; locale: string; onClose(sent: boolean): void }) {
  const settings = useSettings(coordinatorSettings);
  const create = useRpc(createRequestRpc);
  const [text, setText] = useState("");
  const [doneCriteria, setDoneCriteria] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [workspaces, setWorkspaces] = useState<Record<string, string>>({});
  const submit = useMutation({
    mutationFn: () =>
      create({
        text,
        doneCriteria: doneCriteria.trim() || null,
        projectIds,
        baseBranches: {},
        // 고른 뒤 해제한 프로젝트의 워크스페이스는 보내지 않는다. server 는 요청에 없는 프로젝트의 선택을 거절한다.
        workspaces: Object.fromEntries(Object.entries(workspaces).filter(([id]) => projectIds.includes(id))),
        locale,
      }),
    onSuccess: () => onClose(true),
  });
  const allowed = settings.status === "ready" ? settings.values.allowedProjectIds : [];
  // 설정에 남아 있어도 지금 host 에 없는 프로젝트(삭제됨)는 보이지 않는다.
  const allowedRefs = useProjects({
    hosts: [ctx.hostId],
    where: (project) => allowed.includes(project.ref.id),
    orderBy: "displayName",
  });
  const inputStyle = {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: ctx.theme.colors.border,
    backgroundColor: ctx.theme.colors.surface0,
    color: ctx.theme.colors.foreground,
    fontSize: ctx.fonts.body,
  } as const;
  return (
    <View
      style={{
        gap: 16,
        maxWidth: 880,
        padding: ctx.compact ? 12 : 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: ctx.theme.colors.accent,
        backgroundColor: ctx.theme.colors.surface1,
      }}
    >
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{ctx.t("request.title")}</Text>
      <Field label={ctx.t("request.what")} ctx={ctx}>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder={ctx.t("request.whatPlaceholder")}
          placeholderTextColor={ctx.theme.colors.foregroundMuted}
          accessibilityLabel={ctx.t("request.what")}
          style={{ ...inputStyle, minHeight: 110, textAlignVertical: "top" }}
        />
      </Field>
      <Field label={ctx.t("request.projects")} hint={ctx.t("request.projectsHint")} ctx={ctx}>
        {allowedRefs.length === 0 ? (
          <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("request.noAllowedProjects")}</Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {allowedRefs.map((ref) => (
              <ProjectToggle
                key={ref.key}
                projectRef={ref}
                selected={projectIds.includes(ref.id)}
                onToggle={() =>
                {
                  // 해제한 프로젝트의 작업 위치 선택은 지운다. 다시 골랐을 때 예전 선택이 남아 있지 않게 한다.
                  if (projectIds.includes(ref.id)) {
                    setWorkspaces(({ [ref.id]: _removed, ...rest }) => rest);
                  }
                  setProjectIds((current) =>
                    current.includes(ref.id) ? current.filter((id) => id !== ref.id) : [...current, ref.id],
                  );
                }}
                ctx={ctx}
              />
            ))}
          </View>
        )}
      </Field>
      {allowedRefs
        .filter((ref) => projectIds.includes(ref.id))
        .map((ref) => (
          <WorkspaceField
            key={ref.key}
            projectRef={ref}
            value={workspaces[ref.id] ?? null}
            onChange={(workspaceId) =>
              setWorkspaces((current) => {
                const { [ref.id]: _removed, ...rest } = current;
                return workspaceId ? { ...rest, [ref.id]: workspaceId } : rest;
              })
            }
            ctx={ctx}
          />
        ))}
      <Field label={ctx.t("request.doneCriteria")} ctx={ctx}>
        <TextInput
          value={doneCriteria}
          onChangeText={setDoneCriteria}
          placeholder={ctx.t("request.doneCriteriaPlaceholder")}
          placeholderTextColor={ctx.theme.colors.foregroundMuted}
          accessibilityLabel={ctx.t("request.doneCriteria")}
          style={inputStyle}
        />
      </Field>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={submit.isPending ? ctx.t("request.submitting") : ctx.t("request.submit")}
          tone="primary"
          disabled={submit.isPending || text.trim().length === 0 || allowedRefs.length === 0}
          theme={ctx.theme}
          onPress={() => submit.mutate()}
        />
        <CtaButton label={ctx.t("request.close")} disabled={submit.isPending} theme={ctx.theme} onPress={() => onClose(false)} />
      </View>
      {submit.error ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("request.failed", { message: submit.error instanceof Error ? submit.error.message : String(submit.error) })}
        </Text>
      ) : null}
    </View>
  );
}
