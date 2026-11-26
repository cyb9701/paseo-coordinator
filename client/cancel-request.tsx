import { useState } from "react";
import { Text, View } from "react-native";
import { type CoordinatorRequest, completionNeedsDecision } from "../shared/model";
import { CtaButton, type ViewContext } from "./ui";

/**
 * 요청 취소 버튼. 한 번 누르면 무엇이 멈추는지 보여 주고, 확인을 눌러야 취소한다. 한 번 눌러 바로 취소되던 때에는 머지를 기다리던 PR 이
 * GitHub 에 열린 채 카드만 사라졌다 (2026-11-26 전수 검사). 결정을 기다리는 카드가 있으면 서버도 취소를 거절한다.
 */
export function CancelRequestButton({
  request,
  label,
  busy,
  size = "md",
  onConfirm,
  ctx,
}: {
  request: CoordinatorRequest;
  label: string;
  busy: boolean;
  size?: "sm" | "md";
  onConfirm(): void;
  ctx: ViewContext;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) return <CtaButton size={size} label={label} disabled={busy} theme={ctx.theme} onPress={() => setConfirming(true)} />;
  const workers = request.tasks.filter((task) => task.agentId && (task.status === "running" || task.status === "blocked")).length;
  const waiting = request.tasks.filter((task) => task.status === "review" && !task.completion?.closedAt && completionNeedsDecision(task));
  return (
    <View style={{ gap: 6, flexBasis: "100%" }}>
      <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, fontWeight: "600" }}>{ctx.t("cancelRequest.confirm")}</Text>
      {workers > 0 ? (
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{ctx.t("cancelRequest.workers", { count: workers })}</Text>
      ) : null}
      {waiting.length > 0 ? (
        <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
          {ctx.t("cancelRequest.blocked", { tasks: waiting.map((task) => task.number).join(", ") })}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <CtaButton
          size={size}
          label={ctx.t("cancelRequest.yes")}
          tone="primary"
          disabled={busy || waiting.length > 0}
          theme={ctx.theme}
          onPress={() => {
            setConfirming(false);
            onConfirm();
          }}
        />
        <CtaButton size={size} label={ctx.t("cancelRequest.back")} disabled={busy} theme={ctx.theme} onPress={() => setConfirming(false)} />
      </View>
    </View>
  );
}
