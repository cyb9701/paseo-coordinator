import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Decision, decisionTitle, fileDiffRpc, readAnswer } from "../shared/model";
import { breakSentences } from "./sentences";
import { formatAgo } from "./time";
import { Chip, CodeBox, CtaButton, ErrorLine, Muted, Row, type ViewContext } from "./ui";

function kindColor(decision: Decision, ctx: ViewContext): string {
  if (decision.stop) return ctx.theme.colors.statusDanger;
  return ctx.theme.colors.accent;
}

function statusColor(status: Decision["status"], ctx: ViewContext): string {
  switch (status) {
    case "waiting":
      return ctx.theme.colors.statusDanger;
    case "unreviewed":
      return ctx.theme.colors.statusWarning;
    case "undo":
    case "revert":
      return ctx.theme.colors.statusDanger;
    case "approved":
    case "answered":
      return ctx.theme.colors.statusSuccess;
    default:
      return ctx.theme.colors.foregroundMuted;
  }
}

/** 결정이 고친 파일의 diff. 펼칠 때만 읽는다. 파일마다 git 을 돌리기 때문이다. */
export function FileDiffs({ workspaceId, files, ctx }: { workspaceId: string; files: readonly string[]; ctx: ViewContext }) {
  const call = useRpc(fileDiffRpc);
  const query = useQuery({
    queryKey: ["coordinator", "diff", ctx.hostId, workspaceId, files.join("\n")],
    queryFn: () => call({ workspaceId, files: [...files].slice(0, 40) }),
    staleTime: 30_000,
  });
  if (query.isPending) return <Muted text={ctx.t("common.loading")} ctx={ctx} />;
  if (query.error) return <ErrorLine error={query.error} ctx={ctx} />;
  return (
    <View style={{ gap: 8 }}>
      {query.data.base ? <Muted text={ctx.t("decision.diffBase", { base: query.data.base })} ctx={ctx} /> : null}
      {query.data.files.map((file) => (
        <View key={file.path} style={{ gap: 4 }}>
          <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontWeight: "600" }}>
            {file.path}
          </Text>
          {file.diff ? (
            <CodeBox text={file.truncated ? `${file.diff}\n…` : file.diff} ctx={ctx} maxHeight={320} />
          ) : (
            <Muted text={ctx.t("decision.noDiff")} ctx={ctx} />
          )}
        </View>
      ))}
    </View>
  );
}

/** 접었다 펴는 diff. 결정 카드와 '결정에 없는 변경'이 같이 쓴다. */
export function DiffToggle({ workspaceId, files, ctx }: { workspaceId: string; files: readonly string[]; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row" }}>
        <CtaButton
          size="sm"
          label={open ? `▾ ${ctx.t("decision.hideDiff")}` : `▸ ${ctx.t("decision.showDiff", { count: files.length })}`}
          theme={ctx.theme}
          onPress={() => setOpen((value) => !value)}
        />
      </View>
      {open ? <FileDiffs workspaceId={workspaceId} files={files} ctx={ctx} /> : null}
    </View>
  );
}

/**
 * 사람의 답을 화면 언어로 보인다. 카드에서 보낸 답은 에이전트가 읽도록 영어로 저장되므로, 이 결정에 고른 것과 덧붙인 말만 꺼내 다시 쓴다.
 * 질문 창의 "질문: 답"은 에이전트가 쓴 질문이라 그대로 둔다.
 */
function answerText(decision: Decision, text: string, ctx: ViewContext): string {
  const answer = readAnswer(decision, text);
  if (answer.kind === "questionWindow") return ctx.t("decision.answerInQuestionWindow");
  if (answer.kind === "conversation") return ctx.t("decision.answerInConversation");
  if (answer.kind === "text") return answer.text;
  const choice = answer.choice ? ctx.t("decision.answerChose", { option: answer.choice }) : ctx.t("decision.answerAsProposed");
  return answer.note ? `${choice}\n${answer.note}` : choice;
}

/** 결정의 근거. 한 줄을 펼쳤을 때와 멈춘 결정 카드의 '근거 보기'에서 보인다. */
export function DecisionDetails({ decision, ctx }: { decision: Decision; ctx: ViewContext }) {
  const assumptions = decision.evidence.filter((item) => item.basis === "assumption");
  const verified = decision.evidence.filter((item) => item.basis === "verified");
  const line = (text: string, color = ctx.theme.colors.foreground) => (
    <Text selectable style={{ color, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
      {text}
    </Text>
  );
  return (
    <View style={{ gap: 8 }}>
      <Row label={ctx.t("decision.what")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
          {breakSentences(decision.decision)}
        </Text>
      </Row>
      <Row label={ctx.t("decision.why")} ctx={ctx}>
        {line(breakSentences(decision.why))}
      </Row>
      {assumptions.length ? <Row label={ctx.t("decision.assumptions")} ctx={ctx}>{assumptions.map((item, index) => <View key={index}>{line(`? ${breakSentences(item.text)}`, ctx.theme.colors.statusWarning)}</View>)}</Row> : null}
      {verified.length ? <Row label={ctx.t("decision.verified")} ctx={ctx}>{verified.map((item, index) => <View key={index}>{line(`✓ ${breakSentences(item.text)}`)}</View>)}</Row> : null}
      {decision.alternatives.length ? (
        <Row label={ctx.t("decision.alternatives")} ctx={ctx}>
          {decision.alternatives.map((item, index) => <View key={index}>{line(`✗ ${item.option} — ${breakSentences(item.whyNot)}`)}</View>)}
        </Row>
      ) : null}
      <Row label={ctx.t("decision.undoCost")} ctx={ctx}>
        {line(ctx.t(`reversible.${decision.reversible}`), decision.reversible === "easy" ? ctx.theme.colors.foreground : ctx.theme.colors.statusDanger)}
      </Row>
      {decision.files.length ? (
        <Row label={ctx.t("decision.files")} ctx={ctx}>
          <Muted text={decision.files.join(", ")} ctx={ctx} />
          <DiffToggle workspaceId={decision.workspaceId} files={decision.files} ctx={ctx} />
        </Row>
      ) : null}
      {decision.reply?.text ? (
        decision.status === "revert" || decision.status === "undo" ? (
          <Row label={ctx.t(`decision.replyLabel.${decision.status}`)} ctx={ctx}>
            {line(decision.reply.text)}
          </Row>
        ) : (
          <Row label={ctx.t("decision.replyLabel.answer")} ctx={ctx}>
            {line(answerText(decision, decision.reply.text, ctx))}
          </Row>
        )
      ) : null}
    </View>
  );
}

/**
 * 결정 한 줄. 상태, 종류, 제목, 가정 표시, 파일 수, 시간만 보인다. 여러 결정을 훑어보다가 이상한 것만 펼쳐 근거와 diff 를 본다.
 * actions 는 줄 오른쪽 버튼(맞음, 되돌리기, 바꿔서 다시)이다. 줄을 누르면 근거가 펼쳐진다.
 * 좁은 화면에서는 칩과 시간을 윗줄에, 제목을 그 아래 전체 너비로, 버튼을 다음 줄에 둔다.
 * 한 행에 두면 버튼 셋이 폭을 다 차지해 제목 칸이 0 으로 줄고, 줄지 않는 칩과 제목이 버튼 밑으로 넘쳐 겹치기 때문이다.
 */
export function DecisionRow({ decision, ctx, actions, showStatus = true }: { decision: Decision; ctx: ViewContext; actions?: ReactNode; showStatus?: boolean }) {
  const [open, setOpen] = useState(false);
  const assumed = decision.restsOnAssumption || decision.evidence.some((item) => item.basis === "assumption");
  const title = (
    <Text numberOfLines={open ? undefined : ctx.compact ? 2 : 1} style={{ flex: ctx.compact ? undefined : 1, minWidth: 0, color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>
      {decisionTitle(decision)}
    </Text>
  );
  const chips = (
    <>
      <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{open ? "▾" : "▸"}</Text>
      {showStatus ? <Chip label={ctx.t(`decisionStatus.${decision.status}`)} color={statusColor(decision.status, ctx)} theme={ctx.theme} /> : null}
      <Chip label={ctx.t(`decisionKinds.${decision.kind}`)} color={kindColor(decision, ctx)} theme={ctx.theme} />
    </>
  );
  const meta = (
    <>
      {assumed ? <Text style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.meta }}>{ctx.t("decision.assumedShort")}</Text> : null}
      {decision.files.length ? <Muted text={ctx.t("decision.fileCount", { count: decision.files.length })} ctx={ctx} /> : null}
      <Muted text={formatAgo(decision.at, ctx.now, ctx.t)} ctx={ctx} />
    </>
  );
  const pressProps = {
    accessibilityRole: "button" as const,
    accessibilityLabel: `${decisionTitle(decision)} ${open ? ctx.t("card.collapse") : ctx.t("card.expand")}`,
    onPress: () => setOpen((value) => !value),
  };
  return (
    <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingVertical: 8, gap: 8 }}>
      {ctx.compact ? (
        <View style={{ gap: 8 }}>
          <Pressable {...pressProps} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {chips}
              {meta}
            </View>
            {title}
          </Pressable>
          {actions}
        </View>
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable {...pressProps} style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
            {chips}
            {title}
            {meta}
          </Pressable>
          {actions}
        </View>
      )}
      {open ? (
        <View style={{ paddingLeft: ctx.compact ? 0 : 20 }}>
          <DecisionDetails decision={decision} ctx={ctx} />
        </View>
      ) : null}
    </View>
  );
}
