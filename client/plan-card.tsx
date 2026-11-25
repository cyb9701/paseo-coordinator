import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, acknowledgeRpc, cancelRequestRpc, revisePlanRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { formatAgo } from "./time";
import { Chip, CtaButton, type ViewContext } from "./ui";

export function Row({ label, children, ctx }: { label: string; children: ReactNode; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: ctx.compact ? "column" : "row", gap: ctx.compact ? 4 : 12 }}>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, width: ctx.compact ? undefined : 84 }}>{label}</Text>
      <View style={{ flex: 1, gap: 4 }}>{children}</View>
    </View>
  );
}

export function Lines({ items, ctx }: { items: readonly string[]; ctx: ViewContext }) {
  return (
    <>
      {items.map((item, index) => (
        <Text key={index} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>
          {`• ${item}`}
        </Text>
      ))}
    </>
  );
}

function ProjectName({ projectRef }: { projectRef: ProjectRef }) {
  const name = useProject(projectRef, (project) => project.displayName);
  return <>{name ?? projectRef.id}</>;
}

function TaskBlock({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const projects = useProjects({ hosts: [ctx.hostId], where: (project) => project.ref.id === task.projectId });
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <View
      style={{
        gap: 4,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{`${task.number} ${task.name}`}</Text>
        <Text style={muted}>{projects[0] ? <ProjectName projectRef={projects[0]} /> : task.projectId}</Text>
        {task.dependsOn.length > 0 ? (
          <Text style={muted}>{ctx.t("planCard.dependsOn", { list: task.dependsOn.join(", ") })}</Text>
        ) : null}
      </View>
      {task.scope ? <Text style={muted}>{`${ctx.t("planCard.scope")}: ${task.scope}`}</Text> : null}
      {task.doneCriteria ? <Text style={muted}>{`${ctx.t("planCard.taskDone")}: ${task.doneCriteria}`}</Text> : null}
      {task.requestRefs.length > 0 ? (
        <Text style={muted}>{`${ctx.t("planCard.covers")}: ${task.requestRefs.map((ref) => `"${ref}"`).join(", ")}`}</Text>
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
        {request.grade ? (
          <Chip
            label={ctx.t("planCard.decideGrade", { grade: request.grade, count: request.tasks.length })}
            color={ctx.theme.colors.accent}
            theme={ctx.theme}
          />
        ) : null}
        <Text numberOfLines={1} style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600", flexShrink: 1 }}>
          {request.title ?? request.id}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>
          {formatAgo(request.plannedAt ?? request.createdAt, ctx.now, ctx.t)}
        </Text>
      </View>

      {/*
        위에서 아래로 읽으면 배경 → 이해 → 평가 → 결정 순서가 되게 놓는다 (2026-11-25 사용자 피드백).
        결정할 것과 추천은 버튼 바로 위에 두어, 다 읽은 자리에서 바로 누를 수 있게 한다.
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
      {request.grade ? (
        <Row label={ctx.t("planCard.gradeReasons")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>
            {ctx.t("planCard.decideGrade", { grade: request.grade, count: request.tasks.length })}
          </Text>
          <Lines items={request.gradeReasons} ctx={ctx} />
        </Row>
      ) : null}
      <Row label={ctx.t("planCard.tasks")} ctx={ctx}>
        {request.tasks.map((task) => (
          <TaskBlock key={task.number} task={task} ctx={ctx} />
        ))}
      </Row>
      {request.risks.length > 0 ? (
        <Row label={ctx.t("planCard.risks")} ctx={ctx}>
          <Lines items={request.risks} ctx={ctx} />
        </Row>
      ) : null}
      {request.recommendation ? (
        <Row label={ctx.t("planCard.recommendation")} ctx={ctx}>
          <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>{request.recommendation}</Text>
        </Row>
      ) : null}
      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{ctx.t("planCard.decide")}</Text>
        </Row>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton label={ctx.t("planCard.approve")} tone="primary" disabled={busy} theme={ctx.theme} onPress={() => action.mutate("approve")} />
        <CtaButton
          label={revising ? ctx.t("planCard.closeRevise") : ctx.t("planCard.revise")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setRevising((value) => !value)}
        />
        <CtaButton label={ctx.t("planCard.cancel")} disabled={busy} theme={ctx.theme} onPress={() => action.mutate("cancel")} />
      </View>
      {revising ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ctx.t("planCard.revisePlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("planCard.revisePlaceholder")}
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
