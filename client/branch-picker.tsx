import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { listBranchesRpc } from "../shared/model";
import { useFonts } from "./fonts";
import type { T } from "./i18n";
import { ChoiceBox } from "./ui";

/** 검색어가 없을 때 보이는 브랜치 수. 최근 커밋 순이라 진행 중인 기능 브랜치가 위에 온다. */
const SHOWN = 8;

/**
 * 워커 worktree 를 딸 기준 브랜치를 고른다. value 가 null 이면 자동이고, 자동이 무엇인지는 autoLabel 로 보인다
 * (새 요청에서는 코디네이터가 정함, 설정에서는 원격 기본 브랜치). 원격에 없는 브랜치는 PR 을 열 수 없어서 따로 표시한다.
 */
export function BranchPicker({
  hostId,
  projectId,
  value,
  onChange,
  autoLabel,
  theme,
  t,
}: {
  hostId: string;
  projectId: string;
  value: string | null;
  onChange(branch: string | null): void;
  autoLabel(defaultBranch: string | null): string;
  theme: PluginTheme;
  t: T;
}) {
  const fonts = useFonts();
  const list = useRpc(listBranchesRpc);
  const [search, setSearch] = useState("");
  const branches = useQuery({
    queryKey: ["coordinator", "branches", hostId, projectId],
    staleTime: 30_000,
    queryFn: () => list({ projectId }),
  });
  if (branches.isPending) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{t("branch.loading")}</Text>;
  if (branches.isError) {
    return (
      <Text style={{ color: theme.colors.statusDanger, fontSize: fonts.meta }}>
        {t("branch.failed", { message: branches.error instanceof Error ? branches.error.message : String(branches.error) })}
      </Text>
    );
  }
  const query = search.trim().toLowerCase();
  const matches = branches.data.branches.filter((branch) => !query || branch.name.toLowerCase().includes(query)).slice(0, SHOWN);
  // 고른 브랜치는 검색 결과에 없어도 보여야 해제할 수 있다.
  const selected = value && !matches.some((branch) => branch.name === value) ? branches.data.branches.find((branch) => branch.name === value) : null;
  const shown = selected ? [selected, ...matches] : matches;
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder={t("branch.search")}
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel={t("branch.search")}
        style={{
          padding: 8,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface0,
          color: theme.colors.foreground,
          fontSize: fonts.meta,
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <ChoiceBox label={autoLabel(branches.data.defaultBranch)} selected={value === null} onPress={() => onChange(null)} theme={theme} />
        {shown.map((branch) => (
          <ChoiceBox
            key={branch.name}
            label={branch.name}
            detail={[
              branch.remote ? null : t("branch.localOnly"),
              branch.worktree ? t("branch.worktree", { path: branch.worktree }) : null,
            ]
              .filter(Boolean)
              .join(" · ") || null}
            selected={value === branch.name}
            onPress={() => onChange(branch.name)}
            theme={theme}
          />
        ))}
      </View>
      {shown.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{t("branch.none")}</Text> : null}
    </View>
  );
}
