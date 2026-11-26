import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Linking, Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, closeCompletionRpc } from "../shared/model";
import { columnColor } from "./agent-state";
import { DecisionHistory } from "./decision-history";
import { Lines, Row } from "./plan-card";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, GradeBadge, type ViewContext } from "./ui";

/**
 * PR 머지 카드 (반응 필요, 7단계). 워커가 report_done 으로 완료를 보고했고, 사람의 마지막 결정인 머지만 남았다.
 * 모든 등급에서 머지는 사람이 한다 (RULES.md H2). A·B 의 완료 판정도 이 카드가 맡는다. 워커가 스스로 고른 것도 여기서 본다.
 * 읽는 순서: 내 요청 → 이 PR 의 작업 → 워커 보고(검증, 고른 것, 남은 것) → PR → 결정할 것 → 버튼.
 */
export function MergeCard({ request, task, ctx }: { request: CoordinatorRequest; task: Task; ctx: ViewContext }) {
  const close = useRpc(closeCompletionRpc);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState("");
  const action = useMutation({
    mutationFn: (kind: "merge" | "revise") =>
      close({ requestId: request.id, taskNumber: task.number, action: kind, instruction: kind === "revise" ? text : null }),
    onSuccess: () => {
      setText("");
      setRevising(false);
    },
  });
  const completion = task.completion;
  if (!completion) return null;
  const pr = completion.pr;
  // 같은 worktree 를 이어 쓴 앞 작업들도 이 PR 에 들어 있다. 그 작업들의 보고도 함께 보여준다.
  const chain = request.tasks.filter((item) => item.workspaceId && item.workspaceId === task.workspaceId && item.completion);
  const busy = action.isPending;
  const accent = columnColor("react", ctx.theme);
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
  const conflicting = pr?.mergeable === "CONFLICTING";
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
        <Chip label={pr ? ctx.t("mergeCard.kind") : ctx.t("mergeCard.kindNoPr")} color={accent} theme={ctx.theme} />
        {request.grade ? <GradeBadge grade={request.grade} label={ctx.t("card.grade", { grade: request.grade })} theme={ctx.theme} /> : null}
        <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {`${request.title ?? request.id} › ${task.number} ${task.name}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={muted}>{ctx.t("time.waiting", { ago: formatAgo(completion.at, ctx.now, ctx.t) })}</Text>
      </View>

      <Row label={ctx.t("mergeCard.request")} ctx={ctx}>
        <Text selectable style={body}>{request.text}</Text>
      </Row>
      <Row label={ctx.t("mergeCard.tasks")} ctx={ctx}>
        {chain.map((item) => (
          <Text key={item.number} style={{ ...body, fontWeight: "600" }}>{`${item.number} ${item.name}`}</Text>
        ))}
        {task.poteto ? <Text style={muted}>{ctx.t("mergeCard.poteto")}</Text> : null}
        <DecisionHistory task={task} ctx={ctx} />
      </Row>
      {chain.map((item) => {
        const report = item.completion!;
        return (
          <Row key={item.number} label={chain.length > 1 ? `${ctx.t("mergeCard.report")} ${item.number}` : ctx.t("mergeCard.report")} ctx={ctx}>
            <Text selectable style={{ ...body, fontWeight: "600" }}>{report.summary}</Text>
            <Text style={muted}>{ctx.t("mergeCard.verification")}</Text>
            <Lines items={report.verification} ctx={ctx} />
            {report.choices.length > 0 ? (
              <>
                <Text style={muted}>{ctx.t("mergeCard.choices")}</Text>
                <Lines items={report.choices.map((choice) => `${choice.choice}: ${choice.why}`)} ctx={ctx} />
              </>
            ) : null}
            {report.left.length > 0 ? (
              <>
                <Text style={muted}>{ctx.t("mergeCard.left")}</Text>
                <Lines items={report.left} ctx={ctx} />
              </>
            ) : null}
          </Row>
        );
      })}
      <Row label={ctx.t("mergeCard.pr")} ctx={ctx}>
        {pr ? (
          <>
            <Text selectable style={{ ...body, fontWeight: "600" }}>{`#${pr.number} ${pr.title}`}</Text>
            <Text selectable style={muted}>{pr.url}</Text>
            <Text style={body}>
              {ctx.t("mergeCard.stats", { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles, base: pr.baseRefName })}
            </Text>
            <Text style={muted}>{pr.checks ? ctx.t("mergeCard.checks", { checks: pr.checks }) : ctx.t("mergeCard.noChecks")}</Text>
            {conflicting ? (
              <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("mergeCard.conflicting")}</Text>
            ) : null}
          </>
        ) : (
          <>
            <Text style={body}>
              {completion.noPrReason ? ctx.t("mergeCard.noPrByRequest", { reason: completion.noPrReason }) : ctx.t("mergeCard.noPr")}
            </Text>
            {completion.unpublished ? (
              <>
                <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("mergeCard.unpublished")}</Text>
                <Text selectable style={muted}>{completion.unpublished}</Text>
              </>
            ) : null}
          </>
        )}
      </Row>

      <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
        <Row label={ctx.t("inbox.decide")} ctx={ctx}>
          <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
            {pr
              ? ctx.t("mergeCard.decide", { base: pr.baseRefName })
              : completion.unpublished
                ? ctx.t("mergeCard.decideKeep")
                : ctx.t("mergeCard.decideNoPr")}
          </Text>
        </Row>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={pr ? ctx.t("mergeCard.merge") : ctx.t("mergeCard.confirm")}
          tone="primary"
          disabled={busy || conflicting}
          theme={ctx.theme}
          onPress={() => action.mutate("merge")}
        />
        <CtaButton
          label={revising ? ctx.t("mergeCard.closeRevise") : ctx.t("mergeCard.revise")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setRevising((value) => !value)}
        />
        {pr ? <CtaButton label={ctx.t("mergeCard.openPr")} theme={ctx.theme} onPress={() => void Linking.openURL(pr.url)} /> : null}
        {task.agentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("blockerCard.openWorker")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
          />
        ) : null}
      </View>
      {revising ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={ctx.t("mergeCard.revisePlaceholder")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={ctx.t("mergeCard.revisePlaceholder")}
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
              label={ctx.t("mergeCard.sendRevise")}
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
