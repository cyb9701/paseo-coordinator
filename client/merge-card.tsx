import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { type CoordinatorRequest, type Task, askCoordinatorRpc, chainEndingAt, closeCompletionRpc, completionNeedsDecision } from "../shared/model";
import { columnColor } from "./agent-state";
import { DecisionList } from "./decision-history";
import { ProjectChips } from "./project-chip";
import { formatAgo } from "./time";
import { Chip, CtaButton, Decide, Fold, GradeBadge, Lines, type ViewContext } from "./ui";
import { WorkspacePlace } from "./workspace-place";

/**
 * PR 머지 카드 (내 결정 필요, 7단계). 2026-11-27 부터 인박스에 따로 뜨지 않고 완료 보고서(report-card.tsx) 안에 놓인다. 워커가 report_done 으로 완료를 보고했고, 사람의 마지막 결정인 머지만 남았다.
 * 모든 등급에서 머지는 사람이 한다 (RULES.md H2). A·B 의 완료 판정도 이 카드가 맡는다. 워커가 스스로 고른 것도 여기서 본다.
 * 읽는 순서: 경고(충돌, 체크 실패, PR 에 없는 변경) → 결정할 것(PR 한 줄) → 버튼 → 자세히 보기(내 요청, 워커 보고, 남은 것, 문답,
 * 검증, 워커가 고른 것, 작업, 결정 기록). 카드 밖에는 정할 것과 버튼만 둔다 (2026-11-27 사용자 결정). 남은 것은 완료 보고서의
 * '내가 할 일'에 접지 않고 보인다.
 * 질문하기는 그 요청의 코디네이터에게만 묻는다. 워커는 건드리지 않는다.
 */
export function MergeCard({
  request,
  task,
  ctx,
  embedded = false,
}: {
  request: CoordinatorRequest;
  task: Task;
  ctx: ViewContext;
  /** 완료 보고서 안에 놓였다. 요청 원문과 등급은 보고서가 이미 보여서 되풀이하지 않는다. */
  embedded?: boolean;
}) {
  const close = useRpc(closeCompletionRpc);
  const ask = useRpc(askCoordinatorRpc);
  const [panel, setPanel] = useState<"none" | "revise" | "ask">("none");
  const [text, setText] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: (kind: "merge" | "revise" | "ask") =>
      kind === "ask"
        ? ask({ requestId: request.id, taskNumber: task.number, question: text })
        : close({ requestId: request.id, taskNumber: task.number, action: kind, instruction: kind === "revise" ? text : null }),
    onSuccess: () => {
      setText("");
      setPanel("none");
    },
  });
  const completion = task.completion;
  if (!completion) return null;
  const pr = completion.pr;
  // 같은 worktree 를 이어 쓴 앞 작업들도 이 PR 에 들어 있다. 그 작업들의 보고도 함께 보여준다.
  // 사람의 기존 워크스페이스는 사슬 밖의 작업도 쓰므로 이어 쓰기 사슬로 묶는다.
  const existing = Boolean(task.existingWorkspaceId);
  const chain = existing
    ? chainEndingAt(request, task).filter((item) => item.completion)
    : request.tasks.filter((item) => item.workspaceId && item.workspaceId === task.workspaceId && item.completion);
  const busy = action.isPending;
  const accent = columnColor(completionNeedsDecision(task) ? "react" : "review", ctx.theme);
  const operation = task.kind === "operation";
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  const body = { color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body } as const;
  const conflicting = pr?.mergeable === "CONFLICTING";
  // 플러그인이 만든 체크 요약('passed 3, failed 1, pending 0')에서 실패를 찾는다.
  const checksFailed = Boolean(pr?.checks && /failed [1-9]/.test(pr.checks));
  const warning = { color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta } as const;
  // 이어 쓴 작업이 여럿이면 어느 작업의 검증·선택인지 작업 번호로 묶어 보인다.
  const group = (pick: (report: NonNullable<Task["completion"]>) => string[]) =>
    chain
      .map((item) => ({ title: chain.length > 1 ? `${item.number} ${item.name}` : null, items: pick(item.completion!) }))
      .filter((entry) => entry.items.length > 0);
  const verifiedBy = group((report) => report.verification);
  const choseBy = group((report) => report.choices.map((choice) => `${choice.choice}: ${choice.why}`));
  const verification = verifiedBy.flatMap((entry) => entry.items);
  const choices = choseBy.flatMap((entry) => entry.items);
  const left = chain.flatMap((item) => item.completion!.left);
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
        <Chip
          label={
            pr
              ? ctx.t("mergeCard.kind")
              : operation
                ? ctx.t("mergeCard.kindOperation")
                : completion.noPrSource === "existingWorkspace"
                  ? ctx.t("mergeCard.kindExisting")
                  : ctx.t("mergeCard.kindNoPr")
          }
          color={accent}
          theme={ctx.theme}
        />
        {request.grade && !embedded ? <GradeBadge grade={request.grade} label={ctx.t("card.grade", { grade: request.grade })} theme={ctx.theme} /> : null}
        <ProjectChips projectIds={[task.projectId]} ctx={ctx} />
        <Text numberOfLines={1} style={{ ...body, fontWeight: "600", flexShrink: 1 }}>
          {embedded ? `${task.number} ${task.name}` : `${request.title ?? request.id} › ${task.number} ${task.name}`}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={muted}>{ctx.t("time.waiting", { ago: formatAgo(completion.at, ctx.now, ctx.t) })}</Text>
      </View>

      {/* 경고는 접지 않는다. 보지 않고 머지하면 안 되는 것들이다 (2026-11-27 사용자 결정의 예외). */}
      {conflicting ? <Text style={warning}>{`⚠ ${ctx.t("mergeCard.conflicting")}`}</Text> : null}
      {checksFailed ? <Text style={warning}>{`⚠ ${ctx.t("mergeCard.checks", { checks: pr!.checks! })}`}</Text> : null}
      {completion.unpublished ? (
        <View style={{ gap: 2 }}>
          <Text style={warning}>{`⚠ ${ctx.t("mergeCard.unpublished")}`}</Text>
          <Text selectable style={muted}>{completion.unpublished}</Text>
        </View>
      ) : null}
      <Decide
        question={
          pr
            ? ctx.t("mergeCard.decide", { base: pr.baseRefName })
            : existing
              ? ctx.t("mergeCard.decideExisting")
              : completion.unpublished
                ? ctx.t("mergeCard.decideKeep")
                : ctx.t("mergeCard.decideNoPr")
        }
        ctx={ctx}
      >
        {pr ? (
          <>
            <Text selectable style={{ ...body, fontWeight: "600" }}>{`#${pr.number} ${pr.title}`}</Text>
            <Text style={muted}>
              {`${ctx.t("mergeCard.stats", { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles, base: pr.baseRefName })} · ${
                pr.checks ? ctx.t("mergeCard.checks", { checks: pr.checks }) : ctx.t("mergeCard.noChecks")
              }`}
            </Text>
          </>
        ) : completion.noPrSource === "operation" || operation ? (
          // 이유의 출처를 구분한다. 코디네이터가 쓴 범위를 '요청대로'라고 보이면 사람이 하지 않은 말을 한 것처럼 된다 (r15).
          <>
            <Text style={body}>{ctx.t("mergeCard.noPrOperation")}</Text>
            <Lines items={task.targets} ctx={ctx} />
          </>
        ) : completion.noPrSource === "existingWorkspace" ? (
          <>
            <Text style={body}>{ctx.t("mergeCard.noPrExisting", { branch: task.branch ?? "" })}</Text>
            {task.workspaceId ? <WorkspacePlace workspaceId={task.workspaceId} ctx={ctx} /> : null}
          </>
        ) : completion.noPrSource === "localBase" ? (
          <Text style={body}>{ctx.t("mergeCard.noPrLocalBase")}</Text>
        ) : completion.noPrSource === "request" && completion.noPrReason ? (
          <Text style={body}>{ctx.t("mergeCard.noPrByRequest", { reason: completion.noPrReason })}</Text>
        ) : completion.noPrReason ? (
          <Text style={body}>{ctx.t("mergeCard.noPrWithReason", { reason: completion.noPrReason })}</Text>
        ) : completion.unpublished ? (
          // 이어 쓰던 뒤 작업이 취소돼 PR 을 기다리던 커밋이 남은 경우. '아무것도 바꾸지 않았다'와 함께 보이면 모순이다.
          <Text style={body}>{ctx.t("mergeCard.noPrYet")}</Text>
        ) : (
          <Text style={body}>{ctx.t("mergeCard.noPr")}</Text>
        )}
      </Decide>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          label={
            pr
              ? ctx.t("mergeCard.merge")
              : existing
                ? ctx.t("mergeCard.confirmExisting")
                : completion.unpublished
                  ? ctx.t("mergeCard.confirmKeep")
                  : ctx.t("mergeCard.confirm")
          }
          tone="primary"
          disabled={busy || conflicting}
          theme={ctx.theme}
          onPress={() => action.mutate("merge")}
        />
        <CtaButton
          label={panel === "revise" ? ctx.t("mergeCard.closeRevise") : ctx.t("mergeCard.revise")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setPanel((value) => (value === "revise" ? "none" : "revise"))}
        />
        <CtaButton
          label={panel === "ask" ? ctx.t("blockerCard.closeAsk") : ctx.t("blockerCard.ask")}
          disabled={busy}
          theme={ctx.theme}
          onPress={() => setPanel((value) => (value === "ask" ? "none" : "ask"))}
        />
        {pr ? (
          <CtaButton
            label={ctx.t("mergeCard.openPr")}
            theme={ctx.theme}
            onPress={() => openExternalUrl(pr.url).catch((error: unknown) => setOpenError(error instanceof Error ? error.message : String(error)))}
          />
        ) : null}
        {task.agentId && ctx.navigation ? (
          <CtaButton
            label={ctx.t("blockerCard.openWorker")}
            theme={ctx.theme}
            onPress={() => ctx.navigation?.openAgent({ agentId: task.agentId!, serverId: ctx.hostId })}
          />
        ) : null}
      </View>
      {panel !== "none" ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            placeholder={panel === "ask" ? ctx.t("mergeCard.askPlaceholder") : pr ? ctx.t("mergeCard.revisePlaceholder") : ctx.t("mergeCard.revisePlaceholderNoPr")}
            placeholderTextColor={ctx.theme.colors.foregroundMuted}
            accessibilityLabel={panel === "ask" ? ctx.t("mergeCard.askPlaceholder") : pr ? ctx.t("mergeCard.revisePlaceholder") : ctx.t("mergeCard.revisePlaceholderNoPr")}
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
              label={panel === "ask" ? ctx.t("blockerCard.sendAsk") : ctx.t("mergeCard.sendRevise")}
              tone="primary"
              disabled={busy || text.trim().length === 0}
              theme={ctx.theme}
              onPress={() => action.mutate(panel === "ask" ? "ask" : "revise")}
            />
          </View>
        </View>
      ) : null}
      {action.error || openError ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("inbox.failed", {
            message: action.error ? (action.error instanceof Error ? action.error.message : String(action.error)) : (openError ?? ""),
          })}
        </Text>
      ) : null}
      <Fold
        ctx={ctx}
        items={[
          embedded ? null : { label: ctx.t("mergeCard.request"), content: <Text selectable style={body}>{request.text}</Text> },
          {
            label: ctx.t("mergeCard.report"),
            content: chain.map((item) => (
              <Text key={item.number} selectable style={body}>
                {chain.length > 1 ? `${item.number} · ${item.completion!.summary}` : item.completion!.summary}
              </Text>
            )),
          },
          left.length > 0 ? { label: ctx.t("mergeCard.left"), count: left.length, content: <Lines items={left} ctx={ctx} /> } : null,
          completion.qa.length > 0
            ? {
                label: ctx.t("blockerCard.qa"),
                count: completion.qa.length,
                content: completion.qa.map((qa) => (
                  <View key={qa.at} style={{ gap: 2 }}>
                    <Text style={{ ...body, fontWeight: "600" }}>{`Q. ${qa.question}`}</Text>
                    <Text selectable style={qa.answer ? body : muted}>{qa.answer ? `A. ${qa.answer}` : ctx.t("blockerCard.waitingAnswer")}</Text>
                  </View>
                )),
              }
            : null,
          verification.length > 0
            ? { label: ctx.t("mergeCard.verification"), count: verification.length, content: <Grouped groups={verifiedBy} ctx={ctx} /> }
            : null,
          choices.length > 0
            ? { label: ctx.t("mergeCard.choices"), count: choices.length, content: <Grouped groups={choseBy} ctx={ctx} /> }
            : null,
          chain.length > 1 || task.poteto
            ? {
                label: ctx.t("mergeCard.tasks"),
                content: (
                  <>
                    {chain.map((item) => (
                      <Text key={item.number} style={body}>{`${item.number} ${item.name}`}</Text>
                    ))}
                    {task.poteto ? <Text style={muted}>{ctx.t("mergeCard.poteto")}</Text> : null}
                  </>
                ),
              }
            : null,
          task.decisions.length > 0
            ? { label: ctx.t("decisions.label"), count: task.decisions.length, content: <DecisionList task={task} ctx={ctx} /> }
            : null,
        ]}
      />
    </View>
  );
}

function Grouped({ groups, ctx }: { groups: readonly { title: string | null; items: readonly string[] }[]; ctx: ViewContext }) {
  return (
    <>
      {groups.map((entry, index) => (
        <View key={entry.title ?? index} style={{ gap: 2 }}>
          {entry.title ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{entry.title}</Text> : null}
          <Lines items={entry.items} ctx={ctx} />
        </View>
      ))}
    </>
  );
}
