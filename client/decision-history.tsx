import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Task } from "../shared/model";
import { formatAgo } from "./time";
import type { ViewContext } from "./ui";

/**
 * 작업에서 내려진 결정과, 그 결정 카드에서 사람이 코디네이터와 나눈 문답.
 * 카드는 결정하면 닫히므로, 나중에 왜 그렇게 정했는지 되짚을 곳이 여기뿐이다. 길어지므로 접어 둔다.
 */
export function DecisionHistory({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  if (task.decisions.length === 0) return null;
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  const label = ctx.t("decisions.title", { count: task.decisions.length });
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen((value) => !value)}>
        <Text style={muted}>{`${open ? "▾" : "▸"} ${label}`}</Text>
      </Pressable>
      {open
        ? task.decisions.map((decision) => (
            <View key={decision.at} style={{ gap: 2, paddingLeft: 12 }}>
              <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
                {decision.summary}
              </Text>
              <Text style={muted}>
                {`${ctx.t(`decisions.by.${decision.by}`)} · ${formatAgo(decision.at, ctx.now, ctx.t)}`}
              </Text>
              {decision.qa.map((qa, index) => (
                <View key={index} style={{ gap: 1, paddingLeft: 8 }}>
                  <Text selectable style={{ ...muted, fontWeight: "600" }}>{`Q. ${qa.question}`}</Text>
                  <Text selectable style={muted}>{`A. ${qa.answer}`}</Text>
                </View>
              ))}
            </View>
          ))
        : null}
    </View>
  );
}
