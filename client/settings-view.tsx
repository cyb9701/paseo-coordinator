import type { PluginTheme } from "@getpaseo/plugin";
import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, usePaseo, useSettings } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { type CoordinatorSettings, OUTPUT_LANGUAGES, coordinatorSettings } from "../shared/settings";
import { DEFAULT_CONTENT_SIZE, DEFAULT_INTERFACE_SIZE, FONT_SIZE_RANGE, displaySettings, useFonts } from "./fonts";
import type { T } from "./i18n";
import { ChoiceBox, CtaButton } from "./ui";

interface ModelOption {
  /** provider/model. agents.create 와 설정 값이 쓰는 형식이다. */
  value: string;
  provider: string;
  label: string;
  efforts: string[];
}

/** 사용 가능한 provider 의 모델과 effort 를 daemon 에서 읽는다. */
function useModelCatalog(hostId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["coordinator", "model-catalog", hostId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const available = await paseo.providers.listAvailable();
      const providers = available.providers.filter((entry) => entry.available).map((entry) => entry.provider);
      const models: ModelOption[] = [];
      const failed: string[] = [];
      await Promise.all(
        providers.map(async (provider) => {
          try {
            const result = await paseo.providers.listModels(provider);
            for (const model of result.models ?? []) {
              models.push({
                value: `${provider}/${model.id}`,
                provider,
                label: model.label ?? model.id,
                efforts: (model.thinkingOptions ?? []).map((option) => option.id),
              });
            }
          } catch {
            failed.push(provider);
          }
        }),
      );
      return { models, failed };
    },
  });
}

function Block({ title, hint, children, theme }: { title: string; hint?: string; children: ReactNode; theme: PluginTheme }) {
  const fonts = useFonts();
  return (
    <View style={{ gap: 10, padding: 16, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <View style={{ gap: 4 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: fonts.heading, fontWeight: "600" }}>{title}</Text>
        {hint ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Wrap({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>;
}

function Note({ text, color }: { text: string; color: string }) {
  const fonts = useFonts();
  return <Text style={{ color, fontSize: fonts.meta }}>{text}</Text>;
}

function ProjectChoice({ projectRef, selected, onToggle, theme }: { projectRef: ProjectRef; selected: boolean; onToggle(): void; theme: PluginTheme }) {
  const project = useProject(projectRef, (p) => ({ name: p.displayName, path: p.rootPath }));
  if (!project) return null;
  return <ChoiceBox label={project.name} detail={project.path} selected={selected} multiple onPress={onToggle} theme={theme} />;
}

function Stepper({ name, hint, value, onChange, theme, t }: { name: string; hint: string; value: number; onChange(next: number): void; theme: PluginTheme; t: T }) {
  const fonts = useFonts();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <View style={{ minWidth: 160, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: fonts.label }}>{name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{hint}</Text>
      </View>
      <CtaButton label="−" accessibilityLabel={t("settings.decrease", { name })} disabled={value <= FONT_SIZE_RANGE.min} theme={theme} onPress={() => onChange(value - 1)} />
      <Text style={{ color: theme.colors.foreground, fontSize: fonts.label, minWidth: 28, textAlign: "center" }}>{String(value)}</Text>
      <CtaButton label="+" accessibilityLabel={t("settings.increase", { name })} disabled={value >= FONT_SIZE_RANGE.max} theme={theme} onPress={() => onChange(value + 1)} />
    </View>
  );
}

/** 모델과 추론 강도 고르기. 요약과 코디네이터가 같이 쓴다. 모델을 바꿀 때 그 모델에 없는 추론 강도는 기본값으로 돌린다. */
function ModelPicker({
  models,
  value,
  effort,
  onChange,
  theme,
  t,
}: {
  models: readonly ModelOption[];
  value: string;
  effort: string | null;
  onChange(next: { model: string; effort: string | null }): void;
  theme: PluginTheme;
  t: T;
}) {
  const fonts = useFonts();
  const current = models.find((model) => model.value === value);
  return (
    <View style={{ gap: 10 }}>
      {models.length > 0 && !current ? <Note text={t("settings.modelMissing", { model: value })} color={theme.colors.statusWarning} /> : null}
      <Wrap>
        {models.map((model) => (
          <ChoiceBox
            key={model.value}
            label={model.label}
            detail={model.provider}
            selected={value === model.value}
            onPress={() => onChange({ model: model.value, effort: effort && model.efforts.includes(effort) ? effort : null })}
            theme={theme}
          />
        ))}
      </Wrap>
      {current && current.efforts.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{t("settings.effort")}</Text>
          <Wrap>
            <ChoiceBox label={t("settings.effortDefault")} selected={effort === null} onPress={() => onChange({ model: value, effort: null })} theme={theme} />
            {current.efforts.map((option) => (
              <ChoiceBox key={option} label={option} selected={effort === option} onPress={() => onChange({ model: value, effort: option })} theme={theme} />
            ))}
          </Wrap>
        </View>
      ) : null}
    </View>
  );
}

function FontSizeBlock({ theme, t }: { theme: PluginTheme; t: T }) {
  const display = useSettings(displaySettings);
  const values = display.status === "ready" ? display.values : { interfaceSize: DEFAULT_INTERFACE_SIZE, contentSize: DEFAULT_CONTENT_SIZE };
  // 저장 중에 또 누르면 같은 revision 으로 저장해 충돌한다. 저장이 끝날 때까지 받지 않는다.
  const save = (patch: Partial<typeof values>) => {
    if (display.status !== "ready" || display.saving) return;
    void display.save({ ...display.values, ...patch }, display.revision);
  };
  return (
    <Block title={t("settings.fonts")} hint={t("settings.fontsHint")} theme={theme}>
      <Stepper name={t("settings.interfaceSize")} hint={t("settings.interfaceSizeHint")} value={values.interfaceSize} onChange={(interfaceSize) => save({ interfaceSize })} theme={theme} t={t} />
      <Stepper name={t("settings.contentSize")} hint={t("settings.contentSizeHint")} value={values.contentSize} onChange={(contentSize) => save({ contentSize })} theme={theme} t={t} />
      {display.saveError ? <Note text={display.saveError} color={theme.colors.statusDanger} /> : null}
    </Block>
  );
}

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function SettingsView({ theme, hostId, t }: { theme: PluginTheme; hostId: string; t: T }) {
  const fonts = useFonts();
  const settings = useSettings(coordinatorSettings);
  const catalog = useModelCatalog(hostId);
  // 이 플러그인의 작업 폴더(요약 에이전트)도 Paseo 에는 프로젝트로 잡힌다. 지켜볼 대상이 아니라 목록에서 뺀다.
  const projects = useProjects({ hosts: [hostId], where: (p) => !p.rootPath.includes("/plugin-data/paseo-coordinator/"), orderBy: "displayName" });
  const [draft, setDraft] = useState<CoordinatorSettings | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const ready = settings.status === "ready" ? settings : null;
  // 저장된 값이 바뀌면(처음 읽음, 저장, 다른 곳에서 변경) 편집 중인 값을 그 값으로 맞춘다.
  useEffect(() => {
    if (ready) setDraft(ready.values);
  }, [ready?.revision]);
  const dirty = useMemo(() => Boolean(ready && draft && JSON.stringify(ready.values) !== JSON.stringify(draft)), [ready, draft]);

  if (settings.status === "loading" || (ready && !draft)) return <Note text={t("settings.loading")} color={theme.colors.foregroundMuted} />;
  if (settings.status === "error") return <Note text={t("settings.loadFailed", { message: settings.error })} color={theme.colors.statusDanger} />;
  if (settings.status === "invalid") {
    return (
      <View style={{ gap: 12 }}>
        <Note text={t("settings.invalid", { message: settings.error })} color={theme.colors.statusDanger} />
        <View style={{ flexDirection: "row" }}>
          <CtaButton label={t("settings.reset")} tone="primary" theme={theme} onPress={() => void settings.reset()} />
        </View>
      </View>
    );
  }
  if (!ready || !draft) return null;

  const update = (patch: (current: CoordinatorSettings) => CoordinatorSettings) => {
    setSavedAt(null);
    setDraft((current) => (current ? patch(current) : current));
  };
  const models = catalog.data?.models ?? [];
  const save = async () => {
    const ok = await settings.save(draft, ready.revision);
    if (ok) setSavedAt(new Date().toISOString());
  };

  return (
    <View style={{ gap: 16, maxWidth: 880 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fonts.title, fontWeight: "600" }}>{t("settings.title")}</Text>

      <Block title={t("settings.projects")} hint={t("settings.projectsHint")} theme={theme}>
        {projects.length === 0 ? <Note text={t("settings.noProjects")} color={theme.colors.foregroundMuted} /> : null}
        <View style={{ gap: 6 }}>
          {projects.map((ref) => (
            <ProjectChoice
              key={ref.key}
              projectRef={ref}
              selected={draft.projectIds.includes(ref.id)}
              onToggle={() => update((value) => ({ ...value, projectIds: toggle(value.projectIds, ref.id) }))}
              theme={theme}
            />
          ))}
        </View>
      </Block>

      <Block title={t("settings.summary")} hint={t("settings.summaryHint")} theme={theme}>
        <Wrap>
          <ChoiceBox label={t("settings.summaryOn")} selected={draft.summary.enabled} onPress={() => update((value) => ({ ...value, summary: { ...value.summary, enabled: true } }))} theme={theme} />
          <ChoiceBox label={t("settings.summaryOff")} selected={!draft.summary.enabled} onPress={() => update((value) => ({ ...value, summary: { ...value.summary, enabled: false } }))} theme={theme} />
        </Wrap>
        {catalog.isPending ? <Note text={t("settings.loadingModels")} color={theme.colors.foregroundMuted} /> : null}
        {(catalog.data?.failed ?? []).map((provider) => (
          <Note key={provider} text={t("settings.modelsFailed", { provider })} color={theme.colors.statusDanger} />
        ))}
        <ModelPicker
          models={models}
          value={draft.summary.model}
          effort={draft.summary.effort}
          onChange={({ model, effort }) => update((value) => ({ ...value, summary: { ...value.summary, model, effort } }))}
          theme={theme}
          t={t}
        />
      </Block>

      <Block title={t("settings.coordinatorModel")} hint={t("settings.coordinatorModelHint")} theme={theme}>
        {catalog.isPending ? <Note text={t("settings.loadingModels")} color={theme.colors.foregroundMuted} /> : null}
        <ModelPicker
          models={models}
          value={draft.coordinator.model}
          effort={draft.coordinator.effort}
          onChange={({ model, effort }) => update((value) => ({ ...value, coordinator: { ...value.coordinator, model, effort } }))}
          theme={theme}
          t={t}
        />
      </Block>

      <Block title={t("settings.language")} hint={t("settings.languageHint")} theme={theme}>
        <Wrap>
          {OUTPUT_LANGUAGES.map((language) => (
            <ChoiceBox
              key={language}
              label={language === "auto" ? t("settings.languageAuto") : language === "en" ? t("settings.languageEn") : t("settings.languageKo")}
              selected={draft.outputLanguage === language}
              onPress={() => update((value) => ({ ...value, outputLanguage: language }))}
              theme={theme}
            />
          ))}
        </Wrap>
      </Block>

      <FontSizeBlock theme={theme} t={t} />

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <CtaButton label={settings.saving ? t("settings.saving") : t("settings.save")} tone="primary" disabled={!dirty || settings.saving} theme={theme} onPress={() => void save()} />
        <CtaButton label={t("settings.revert")} disabled={!dirty || settings.saving} theme={theme} onPress={() => setDraft(ready.values)} />
        <CtaButton label={t("settings.reset")} disabled={settings.saving} theme={theme} onPress={() => void settings.reset()} />
        {savedAt && !dirty ? <Note text={`✓ ${t("settings.saved")}`} color={theme.colors.statusSuccess} /> : null}
      </View>
      {settings.saveError ? <Note text={t("settings.saveFailed", { message: settings.saveError })} color={theme.colors.statusDanger} /> : null}
    </View>
  );
}
