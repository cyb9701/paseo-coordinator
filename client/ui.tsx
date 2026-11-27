import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { readError } from "../shared/errors";
import { type Fonts, useFonts } from "./fonts";
import type { T } from "./i18n";
import { breakSentences } from "./sentences";

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
 * 클릭 영역이 분명한 박스형 버튼. 글자만 있는 버튼은 눌리는 곳인지 알기 어려워서 플러그인의 모든 동작 버튼은 이것을 쓴다.
 * 결정하는 버튼(허용, 답 보내기, 맞음, 바꾸기, 완료 등)은 모든 카드에서 기본 크기로 맞춘다. sm 은 펼치기·새로 읽기처럼 보기만 바꾸는 버튼에 쓴다.
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

/** 프로젝트 표시. 위치 정보라서 경로처럼 조용하게 보인다: 폴더 아이콘 + 이름, 테두리와 배경 없음. 종류 칩과 모양이 겹치지 않게 한다. */
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
            {breakSentences(item)}
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
 * 카드의 펼침 층. 카드는 처음에 결정할 것과 버튼만 보이고 근거와 원문은 여기에 접어 둔다. 모두 펼쳐 두면 읽을 것이 너무 많아
 * 판단이 늦어진다. 닫혀 있어도 무엇이 들어 있는지 알 수 있게 구역 이름을 버튼 옆에 보인다.
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

export function CodeBox({ text, ctx, maxHeight }: { text: string; ctx: ViewContext; maxHeight?: number }) {
  const body = (
    <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.meta, fontFamily: "monospace", lineHeight: Math.round(ctx.fonts.meta * 1.5) }}>
      {text}
    </Text>
  );
  return (
    <View style={{ padding: 10, borderRadius: 6, borderWidth: 1, borderColor: ctx.theme.colors.border, backgroundColor: ctx.theme.colors.surface0 }}>
      {maxHeight ? <ScrollView style={{ maxHeight }}>{body}</ScrollView> : body}
    </View>
  );
}

export function TextBox({
  value,
  onChange,
  placeholder,
  ctx,
  minHeight = 72,
}: {
  value: string;
  onChange(text: string): void;
  placeholder: string;
  ctx: ViewContext;
  minHeight?: number;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={ctx.theme.colors.foregroundMuted}
      multiline
      accessibilityLabel={placeholder}
      style={{
        minHeight,
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
  );
}

/** 글을 쓰고 보내는 상자. 보내면 비운다. */
export function InstructionBox({
  placeholder,
  submitLabel,
  onSubmit,
  busy,
  ctx,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit(text: string): Promise<unknown> | void;
  busy: boolean;
  ctx: ViewContext;
}) {
  const [text, setText] = useState("");
  return (
    <View style={{ gap: 8 }}>
      <TextBox value={text} onChange={setText} placeholder={placeholder} ctx={ctx} />
      <View style={{ flexDirection: "row" }}>
        <CtaButton
          label={submitLabel}
          tone="primary"
          disabled={busy || text.trim().length === 0}
          theme={ctx.theme}
          onPress={() => {
            const done = onSubmit(text.trim());
            if (done) void Promise.resolve(done).then(() => setText(""), () => undefined);
            else setText("");
          }}
        />
      </View>
    </View>
  );
}

/** 서버 오류를 화면 언어로. 코디네이터가 코드를 붙인 오류만 바꾸고, git·Paseo 오류는 원문 그대로 둔다. */
export function errorText(error: unknown, t: T): string {
  const { code, message } = readError(error);
  return code ? t(`errors.${code}`) : message;
}

export function ErrorLine({ error, ctx }: { error: unknown; ctx: ViewContext }) {
  if (!error) return null;
  return (
    <Text style={{ color: ctx.theme.colors.statusDanger, fontSize: ctx.fonts.meta }}>
      {ctx.t("common.failed", { message: errorText(error, ctx.t) })}
    </Text>
  );
}

/** 카드 틀. 왼쪽 띠 색으로 사람을 기다리는지(빨강), 확인할 것인지(노랑)를 가른다. */
export function Card({ color, ctx, children }: { color: string; ctx: ViewContext; children: ReactNode }) {
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: ctx.theme.colors.border,
        borderLeftWidth: 3,
        borderLeftColor: color,
        borderRadius: 10,
        backgroundColor: ctx.theme.colors.surface1,
        padding: ctx.compact ? 12 : 16,
        gap: 12,
      }}
    >
      {children}
    </View>
  );
}

export function SectionHeader({ title, count, hint, color, ctx }: { title: string; count?: number; hint?: string; color?: string; ctx: ViewContext }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
      <Text style={{ color: color ?? ctx.theme.colors.foreground, fontSize: ctx.fonts.heading, fontWeight: "600" }}>{title}</Text>
      {count !== undefined ? <Text style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.heading }}>{String(count)}</Text> : null}
      {hint ? <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{hint}</Text> : null}
    </View>
  );
}

export function Muted({ text, ctx }: { text: string; ctx: ViewContext }) {
  return <Text style={{ color: ctx.theme.colors.foregroundMuted, fontSize: ctx.fonts.meta }}>{text}</Text>;
}

export function Body({ text, ctx, strong = false }: { text: string; ctx: ViewContext; strong?: boolean }) {
  return (
    <Text selectable style={{ color: ctx.theme.colors.foreground, fontSize: ctx.fonts.body, lineHeight: Math.round(ctx.fonts.body * 1.45), fontWeight: strong ? "600" : "400" }}>
      {breakSentences(text)}
    </Text>
  );
}

/** 글의 대략적인 폭(px). 한글·한자처럼 넓은 글자는 글자 크기만큼, 영문·숫자·기호는 그 절반으로 센다. */
function textWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char) ? fontSize : fontSize * 0.5;
  return width;
}

/** 카드 안 글이 쓸 수 있는 대략적인 폭(px). 좁은 화면은 휴대폰 카드, 넓은 화면은 인박스 최대 폭 기준이다. */
const LINE_WIDTH = { compact: 340, wide: 820 };

/**
 * 접힌 글. lines 줄까지만 보이고, 넘치면 '더 보기'로 펼친다. 말줄임으로 잘린 채 끝나면 중요한 내용을 놓친다.
 * 넘치는지는 글자 수로 어림하고, 네이티브에서 줄 수를 알려 주면 그것도 쓴다(웹에는 onTextLayout 이 없다).
 */
export function ExpandableText({
  children,
  text,
  lines,
  style,
  ctx,
}: {
  children: ReactNode;
  /** 넘치는지 어림할 원문. 줄바꿈이 있으면 줄마다 따로 센다. */
  text: string;
  lines: number;
  style: object;
  ctx: ViewContext;
}) {
  const [open, setOpen] = useState(false);
  const [measured, setMeasured] = useState(false);
  const fontSize = (style as { fontSize?: number }).fontSize ?? ctx.fonts.body;
  const width = ctx.compact ? LINE_WIDTH.compact : LINE_WIDTH.wide;
  const estimated = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(textWidth(line, fontSize) / width)), 0);
  const overflow = measured || estimated > lines;
  return (
    <Pressable accessibilityRole={overflow ? "button" : undefined} disabled={!overflow} onPress={() => setOpen((value) => !value)} style={{ gap: 2 }}>
      <Text
        selectable={!overflow}
        numberOfLines={open ? undefined : lines}
        onTextLayout={(event) => {
          if (!open && event.nativeEvent.lines.length > lines) setMeasured(true);
        }}
        style={style}
      >
        {children}
      </Text>
      {overflow ? <Text style={{ color: ctx.theme.colors.accent, fontSize: ctx.fonts.meta }}>{open ? ctx.t("common.less") : ctx.t("common.more")}</Text> : null}
    </Pressable>
  );
}
