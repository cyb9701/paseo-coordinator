import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { type Fonts, useFonts } from "./fonts";
import type { T } from "./i18n";

export interface ViewContext {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  now: number;
  navigation: PluginScreenProps["navigation"];
  t: T;
  fonts: Fonts;
}

type Tone = "primary" | "neutral";

/**
 * 클릭 영역이 분명한 박스형 버튼. 글자만 있는 버튼은 눌리는 곳인지 알기 어렵다는 피드백(2026-11-25)에 따라
 * 플러그인의 모든 동작 버튼은 이것을 쓴다.
 */
export function CtaButton({
  label,
  onPress,
  theme,
  tone = "neutral",
  disabled = false,
  accessibilityLabel,
  size = "md",
}: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  tone?: Tone;
  disabled?: boolean;
  accessibilityLabel?: string;
  size?: "sm" | "md";
}) {
  const fonts = useFonts();
  const primary = tone === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: size === "sm" ? 28 : 36,
        paddingHorizontal: size === "sm" ? 10 : 14,
        justifyContent: "center",
        alignItems: "center",
        borderRadius: 8,
        borderWidth: 1,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : pressed ? theme.colors.surface1 : theme.colors.surface2,
        opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          color: primary ? theme.colors.accentForeground : theme.colors.foreground,
          fontSize: size === "sm" ? fonts.meta : fonts.label,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** 탭바. 각 탭이 박스로 보이고, 선택된 탭은 테두리와 배경으로 구분한다. */
export function TabBar<Key extends string>({
  tabs,
  active,
  onChange,
  theme,
}: {
  tabs: readonly { key: Key; label: string }[];
  active: Key;
  onChange(key: Key): void;
  theme: PluginTheme;
}) {
  const fonts = useFonts();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 6 }}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => onChange(tab.key)}
            style={({ pressed }) => ({
              minHeight: 36,
              paddingHorizontal: 14,
              justifyContent: "center",
              borderRadius: 8,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: selected || pressed ? theme.colors.surface2 : theme.colors.surface1,
            })}
          >
            <Text
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                fontSize: fonts.label,
                fontWeight: selected ? "600" : "400",
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Chip({ label, color, theme }: { label: string; color: string; theme: PluginTheme }) {
  const fonts = useFonts();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        alignSelf: "flex-start",
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fonts.meta, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}

/** 선택 박스. 단일 선택(radio)과 여러 개 선택(checkbox)에 같이 쓴다. 선택되면 테두리와 표시로 구분한다. */
export function ChoiceBox({
  label,
  detail,
  selected,
  multiple = false,
  disabled = false,
  onPress,
  theme,
}: {
  label: string;
  detail?: string | null;
  selected: boolean;
  multiple?: boolean;
  disabled?: boolean;
  onPress(): void;
  theme: PluginTheme;
}) {
  const fonts = useFonts();
  const mark = multiple ? (selected ? "☑" : "☐") : selected ? "●" : "○";
  return (
    <Pressable
      accessibilityRole={multiple ? "checkbox" : "radio"}
      accessibilityState={{ checked: selected, disabled }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accent : theme.colors.border,
        backgroundColor: selected || pressed ? theme.colors.surface2 : theme.colors.surface0,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      <Text style={{ color: selected ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: fonts.label }}>{mark}</Text>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: fonts.label, fontWeight: selected ? "600" : "400" }}>{label}</Text>
        {detail ? (
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * 프로젝트 표시. 위치 정보라서 경로처럼 조용하게 보인다: 폴더 아이콘 + 이름, 테두리와 배경 없음.
 * 등급·종류 칩과 모양이 겹쳐 구분이 안 된다는 피드백(2026-11-25)으로 칩에서 분리했다.
 */
export function ProjectTag({ label, theme }: { label: string; theme: PluginTheme }) {
  const fonts = useFonts();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", maxWidth: "100%" }}>
      <Icon name="Folder" size={fonts.meta + 1} color={theme.colors.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta, fontWeight: "600", flexShrink: 1 }}>
        {label}
      </Text>
    </View>
  );
}

export type Grade = "A" | "B" | "C" | "D";

function gradeColor(grade: Grade, theme: PluginTheme): string {
  switch (grade) {
    case "A":
      return theme.colors.statusDanger;
    case "B":
      return theme.colors.statusWarning;
    case "C":
      return theme.colors.accent;
    default:
      return theme.colors.foregroundMuted;
  }
}

/**
 * 등급 배지. 작업의 무게를 한눈에 알 수 있게 색을 꽉 채운 둥근 배지로 보인다. A 가 가장 무겁다 (RULES.md §10).
 * grade 가 없으면(읽기 요청, 등급 전) 테두리만 있는 배지로 label 을 보인다.
 */
export function GradeBadge({ grade, label, theme }: { grade: Grade | null; label: string; theme: PluginTheme }) {
  const fonts = useFonts();
  const filled = grade !== null;
  const color = grade ? gradeColor(grade, theme) : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 9,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: filled ? color : "transparent",
      }}
    >
      <Text style={{ color: filled ? theme.colors.surface0 : color, fontSize: fonts.meta, fontWeight: "700" }}>{label}</Text>
    </View>
  );
}

/** 카드의 한 구역. 왼쪽에 이름, 오른쪽에 내용. 좁은 화면에서는 이름이 위로 간다. */
export function Row({ label, children, ctx }: { label: string; children: ReactNode; ctx: ViewContext }) {
  // 이름은 본문보다 작은 글자라 위쪽에 붙어 보였다. 본문 첫 줄과 같은 줄 높이를 주어 같은 높이에서 읽히게 한다.
  return (
    <View style={{ flexDirection: ctx.compact ? "column" : "row", gap: ctx.compact ? 4 : 12 }}>
      <Text
        style={{
          color: ctx.theme.colors.foregroundMuted,
          fontSize: ctx.fonts.meta,
          lineHeight: ctx.compact ? undefined : Math.round(ctx.fonts.body * 1.35),
          width: ctx.compact ? undefined : 84,
        }}
      >
        {label}
      </Text>
      <View style={{ flex: 1, gap: 6 }}>{children}</View>
    </View>
  );
}

export function Lines({ items, ctx, muted = false }: { items: readonly string[]; ctx: ViewContext; muted?: boolean }) {
  const size = muted ? ctx.fonts.meta : ctx.fonts.body;
  const style = { color: muted ? ctx.theme.colors.foregroundMuted : ctx.theme.colors.foreground, fontSize: size, lineHeight: Math.round(size * 1.4) };
  // 항목이 여러 줄로 넘어갈 때 글머리 아래로 들여 써야 항목끼리 구분된다.
  return (
    <View style={{ gap: 4 }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", gap: 6 }}>
          <Text style={style}>•</Text>
          <Text selectable style={{ ...style, flex: 1 }}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

export interface FoldItem {
  label: string;
  /** 닫혀 있을 때 이름 옆에 보일 개수. 위험처럼 몇 개인지가 펼칠지 정하는 단서가 될 때 쓴다. */
  count?: number;
  content: ReactNode;
}

/**
 * 결정 카드의 펼침 층 (DESIGN.md 결정 카드). 카드는 처음에 상황, 결정할 것, 버튼만 보이고 근거와 원문은 여기에 접어 둔다.
 * 모든 항목을 펼쳐 두자 결정 하나에 읽을 것이 너무 많아 판단이 늦어졌다 (2026-11-26 사용자 피드백).
 * 지우지 않고 접는 이유는, 규칙이 카드에 보이라고 정한 정보(워커가 고른 것 RULES.md §10, 자동 결정의 판정 §8)가 있기 때문이다.
 * 닫혀 있어도 무엇이 들어 있는지 알 수 있게 구역 이름을 버튼 옆에 보인다.
 */
export function Fold({ items, ctx }: { items: readonly (FoldItem | null | false)[]; ctx: ViewContext }) {
  const [open, setOpen] = useState(false);
  const shown = items.filter((item): item is FoldItem => Boolean(item));
  if (shown.length === 0) return null;
  const hint = shown.map((item) => (item.count ? `${item.label} ${item.count}` : item.label)).join(" · ");
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <CtaButton
          size="sm"
          label={open ? `▾ ${ctx.t("fold.hide")}` : `▸ ${ctx.t("fold.show")}`}
          accessibilityLabel={`${open ? ctx.t("fold.hide") : ctx.t("fold.show")}: ${hint}`}
          theme={ctx.theme}
          onPress={() => setOpen((value) => !value)}
        />
        {open ? null : (
          <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta, flexShrink: 1 }}>{hint}</Text>
        )}
      </View>
      {open ? (
        <View
          style={{
            gap: 12,
            padding: 12,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: ctx.theme.colors.border,
            backgroundColor: ctx.theme.colors.surface0,
          }}
        >
          {shown.map((item) => (
            <Row key={item.label} label={item.label} ctx={ctx}>
              {item.content}
            </Row>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 카드의 결정 구역. 구분선 위는 상황, 아래는 결정이다. 결정할 것은 버튼 바로 위에 둔다. 위에서부터 읽으면 상황을 이해한 자리에서
 * 바로 고르고 누를 수 있게 하기 위해서다 (2026-11-25, 2026-11-26 사용자 피드백). question 에는 '선택지를 고르세요' 같은 안내가 아니라
 * 실제로 정할 것을 쓴다. 안내 문구를 가장 크게 보이자 진짜 질문이 카드 중간에 묻혔다.
 */
export function Decide({ question, children, ctx }: { question?: string | null; children?: ReactNode; ctx: ViewContext }) {
  return (
    <View style={{ borderTopWidth: 1, borderColor: ctx.theme.colors.border, paddingTop: 12 }}>
      <Row label={ctx.t("inbox.decide")} ctx={ctx}>
        <View style={{ gap: 8 }}>
          {question ? (
            <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>
              {question}
            </Text>
          ) : null}
          {children}
        </View>
      </Row>
    </View>
  );
}
