import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import { type Decision, fileDiffRpc } from "../shared/model";
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
 * 결정 하나. 무엇을 정했는지, 왜, 확인한 근거와 가정, 버린 대안, 되돌리는 비용, 고친 파일(diff)을 한 곳에 둔다.
 * 사람은 이것만 보고 에이전트의 판단이 맞는지 가릴 수 있어야 한다. 가정은 경고 색으로 보여 먼저 눈에 띄게 한다.
 */
export function DecisionItem({ decision, ctx, actions, showStatus = true }: { decision: Decision; ctx: ViewContext; actions?: ReactNode; showStatus?: boolean }) {
  const assumptions = decision.evidence.filter((item) => item.basis === "assumption");
  const verified = decision.evidence.filter((item) => item.basis === "verified");
  return (
    <View
      style={{
        gap: 10,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        backgroundColor: ctx.theme.colors.surface0,
      }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, fontWeight: "600" }}>{`#${decision.number}`}</Text>
        <Chip label={ctx.t(`decisionKinds.${decision.kind}`)} color={kindColor(decision, ctx)} theme={ctx.theme} />
        <Chip
          label={ctx.t(`reversible.${decision.reversible}`)}
          color={decision.reversible === "easy" ? ctx.theme.colors.foregroundMuted : ctx.theme.colors.statusDanger}
          theme={ctx.theme}
        />
        {decision.restsOnAssumption ? <Chip label={ctx.t("decision.restsOnAssumption")} color={ctx.theme.colors.statusWarning} theme={ctx.theme} /> : null}
        {showStatus ? <Chip label={ctx.t(`decisionStatus.${decision.status}`)} color={statusColor(decision.status, ctx)} theme={ctx.theme} /> : null}
        <View style={{ flex: 1 }} />
        <Muted text={formatAgo(decision.at, ctx.now, ctx.t)} ctx={ctx} />
      </View>
      <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600", lineHeight: Math.round(ctx.fonts.heading * 1.4) }}>
        {decision.decision}
      </Text>
      <Row label={ctx.t("decision.why")} ctx={ctx}>
        <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45) }}>
          {decision.why}
        </Text>
      </Row>
      {assumptions.length ? (
        <Row label={ctx.t("decision.assumptions")} ctx={ctx}>
          {assumptions.map((item, index) => (
            <Text key={index} selectable style={{ color: ctx.theme.colors.statusWarning, fontSize: ctx.fonts.body }}>
              {`? ${item.text}`}
            </Text>
          ))}
        </Row>
      ) : null}
      {verified.length ? (
        <Row label={ctx.t("decision.verified")} ctx={ctx}>
          {verified.map((item, index) => (
            <Text key={index} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
              {`✓ ${item.text}`}
            </Text>
          ))}
        </Row>
      ) : null}
      {decision.alternatives.length ? (
        <Row label={ctx.t("decision.alternatives")} ctx={ctx}>
          {decision.alternatives.map((item, index) => (
            <Text key={index} selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, lineHeight: Math.round(ctx.fonts.meta * 1.45) }}>
              {`✗ ${item.option} — ${item.whyNot}`}
            </Text>
          ))}
        </Row>
      ) : null}
      {decision.files.length ? (
        <Row label={ctx.t("decision.files")} ctx={ctx}>
          <Muted text={decision.files.join(", ")} ctx={ctx} />
          <DiffToggle workspaceId={decision.workspaceId} files={decision.files} ctx={ctx} />
        </Row>
      ) : null}
      {decision.reply ? (
        <Row label={decision.status === "undo" ? ctx.t("decision.undoReply") : ctx.t("decision.reply")} ctx={ctx}>
          <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body }}>
            {decision.reply.text}
          </Text>
        </Row>
      ) : null}
      {actions}
    </View>
  );
}
