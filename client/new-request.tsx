import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { createRequestRpc } from "../shared/model";
import { coordinatorSettings } from "../shared/settings";
import { ChoiceBox, CtaButton, type ViewContext } from "./ui";

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
  const submit = useMutation({
    mutationFn: () =>
      create({ text, doneCriteria: doneCriteria.trim() || null, projectIds, locale }),
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
                  setProjectIds((current) =>
                    current.includes(ref.id) ? current.filter((id) => id !== ref.id) : [...current, ref.id],
                  )
                }
                ctx={ctx}
              />
            ))}
          </View>
        )}
      </Field>
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
