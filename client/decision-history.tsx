import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Task } from "../shared/model";
import { formatAgo } from "./time";
import type { ViewContext } from "./ui";

/**
 * 작업에서 내려진 결정과, 그 결정 카드에서 사람이 코디네이터와 나눈 문답.
 * 카드는 결정하면 닫히므로, 나중에 왜 그렇게 정했는지 되짚을 곳이 여기뿐이다.
 */
export function DecisionList({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const muted = { color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta } as const;
  return (
    <>
      {task.decisions.map((decision) => (
        <View key={decision.at} style={{ gap: 2 }}>
          <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta }}>
            {decision.summary}
          </Text>
          <Text style={muted}>{`${ctx.t(`decisions.by.${decision.by}`)} · ${formatAgo(decision.at, ctx.now, ctx.t)}`}</Text>
          {decision.qa.map((qa, index) => (
            <View key={index} style={{ gap: 1, paddingLeft: 8 }}>
              <Text selectable style={{ ...muted, fontWeight: "600" }}>{`Q. ${qa.question}`}</Text>
              <Text selectable style={muted}>{`A. ${qa.answer}`}</Text>
            </View>
          ))}
        </View>
      ))}
    </>
  );
}

/** 진행 현황의 작업 칸에 쓰는 접힌 결정 기록. 결정 카드에서는 카드의 '자세히 보기' 안에 DecisionList 를 바로 넣는다. */
export function DecisionHistory({ task, ctx }: { task: Task; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  if (task.decisions.length === 0) return null;
  const label = ctx.t("decisions.title", { count: task.decisions.length });
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => setOpen((value) => !value)}>
        <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{`${open ? "▾" : "▸"} ${label}`}</Text>
      </Pressable>
      {open ? (
        <View style={{ gap: 4, paddingLeft: 12 }}>
          <DecisionList task={task} ctx={ctx} />
        </View>
      ) : null}
    </View>
  );
}
