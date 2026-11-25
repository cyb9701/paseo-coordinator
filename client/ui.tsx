import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";

export interface ViewContext {
  theme: PluginTheme;
  compact: boolean;
  hostId: string;
  now: number;
  navigation: PluginScreenProps["navigation"];
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
          fontSize: size === "sm" ? 12 : 13,
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
                fontSize: 13,
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
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
        {label}
      </Text>
    </View>
  );
}
