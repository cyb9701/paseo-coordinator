import type { PluginTheme } from "@getpaseo/plugin";
import type { ProjectRef } from "@getpaseo/plugin/client";
import { useProject, useProjects, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import {
  type CoordinatorSettings,
  OUTPUT_LANGUAGES,
  REVIEWER_EFFORTS,
  coordinatorSettings,
} from "../shared/settings";
import { enableRuleRpc } from "../shared/model";
import { useCoordinatorState } from "./coordinator-state";
import type { T } from "./i18n";
import { DEFAULT_CONTENT_SIZE, DEFAULT_INTERFACE_SIZE, FONT_SIZE_RANGE, displaySettings, useFonts } from "./fonts";
import { BranchPicker } from "./branch-picker";
import { ChoiceBox, CtaButton } from "./ui";

// 검토자는 읽기 전용으로 띄워야 한다 (RULES.md §7). 지금 이 조건을 만족하는 모드는 claude 의 plan 뿐이다.
// 새 provider 가 읽기 전용 모드를 내놓으면 이 목록에 그 모드 id 를 더한다.
const READ_ONLY_MODE_IDS = ["plan"];

interface ModelOption {
  /** provider/model. agents.create 와 설정 값이 쓰는 형식이다. */
  value: string;
  provider: string;
  label: string;
  description: string | null;
  efforts: string[];
}

interface ProviderCatalog {
  models: ModelOption[];
  readOnlyProviders: Set<string>;
  failedProviders: string[];
}

/** 사용 가능한 provider 의 모델과 effort, 읽기 전용 모드 여부를 daemon 에서 읽는다. */
function useProviderCatalog(hostId: string) {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["coordinator", "provider-catalog", hostId],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ProviderCatalog> => {
      const available = await paseo.providers.listAvailable();
      const providers = available.providers.filter((entry) => entry.available).map((entry) => entry.provider);
      const models: ModelOption[] = [];
      const readOnlyProviders = new Set<string>();
      const failedProviders: string[] = [];
      await Promise.all(
        providers.map(async (provider) => {
          try {
            const [modelResult, modeResult] = await Promise.all([
              paseo.providers.listModels(provider),
              paseo.providers.listModes(provider),
            ]);
            if ((modeResult.modes ?? []).some((mode) => READ_ONLY_MODE_IDS.includes(mode.id))) {
              readOnlyProviders.add(provider);
            }
            for (const model of modelResult.models ?? []) {
              models.push({
                value: `${provider}/${model.id}`,
                provider,
                label: model.label ?? model.id,
                description: model.description ?? null,
                efforts: (model.thinkingOptions ?? []).map((option) => option.id),
              });
            }
          } catch {
            failedProviders.push(provider);
          }
        }),
      );
      return { models, readOnlyProviders, failedProviders };
    },
  });
}

function Block({ title, hint, children, theme }: { title: string; hint?: string; children: ReactNode; theme: PluginTheme }) {
  const fonts = useFonts();
  return (
    <View
      style={{
        gap: 10,
        padding: 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
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

function ProjectChoice({
  projectRef,
  selected,
  onToggle,
  theme,
}: {
  projectRef: ProjectRef;
  selected: boolean;
  onToggle(): void;
  theme: PluginTheme;
}) {
  const project = useProject(projectRef, (p) => ({ name: p.displayName, path: p.rootPath }));
  if (!project) return null;
  return <ChoiceBox label={project.name} detail={project.path} selected={selected} multiple onPress={onToggle} theme={theme} />;
}

function Stepper({
  name,
  hint,
  value,
  onChange,
  theme,
  t,
}: {
  name: string;
  hint: string;
  value: number;
  onChange(next: number): void;
  theme: PluginTheme;
  t: T;
}) {
  const fonts = useFonts();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <View style={{ minWidth: 160, gap: 2 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: fonts.label }}>{name}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{hint}</Text>
      </View>
      <CtaButton
        label="−"
        accessibilityLabel={t("settings.decrease", { name })}
        disabled={value <= FONT_SIZE_RANGE.min}
        theme={theme}
        onPress={() => onChange(value - 1)}
      />
      <Text style={{ color: theme.colors.foreground, fontSize: fonts.label, minWidth: 28, textAlign: "center" }}>{String(value)}</Text>
      <CtaButton
        label="+"
        accessibilityLabel={t("settings.increase", { name })}
        disabled={value >= FONT_SIZE_RANGE.max}
        theme={theme}
        onPress={() => onChange(value + 1)}
      />
    </View>
  );
}

/** 자동 정지로 꺼진 규칙. 다시 켜는 것은 사람이 한다 (RULES.md §5). 꺼진 규칙이 없으면 보이지 않는다. */
function DisabledRulesBlock({ theme, t }: { theme: PluginTheme; t: T }) {
  const { state } = useCoordinatorState();
  const enableRpc = useRpc(enableRuleRpc);
  const enable = useMutation({ mutationFn: (rule: (typeof rules)[number]) => enableRpc({ rule }) });
  const rules = state?.disabledRules ?? [];
  if (rules.length === 0) return null;
  return (
    <Block title={t("settings.disabledRules")} hint={t("settings.disabledRulesHint")} theme={theme}>
      <Wrap>
        {rules.map((rule) => (
          <CtaButton
            key={rule}
            label={t("settings.enableRule", { rule })}
            disabled={enable.isPending}
            theme={theme}
            onPress={() => enable.mutate(rule)}
          />
        ))}
      </Wrap>
      {enable.error ? (
        <Note text={t("inbox.failed", { message: enable.error instanceof Error ? enable.error.message : String(enable.error) })} color={theme.colors.statusDanger} />
      ) : null}
    </Block>
  );
}

/**
 * 글자 크기. 기기별 설정이라 코디네이터 설정과 따로 저장하고, 바꾸는 즉시 저장해 바로 보이게 한다.
 */
function FontSizeBlock({ theme, t }: { theme: PluginTheme; t: T }) {
  const display = useSettings(displaySettings);
  const values =
    display.status === "ready" ? display.values : { interfaceSize: DEFAULT_INTERFACE_SIZE, contentSize: DEFAULT_CONTENT_SIZE };
  // 저장 중에 또 누르면 같은 revision 으로 저장해 충돌한다. 저장이 끝날 때까지 받지 않는다.
  const save = (patch: Partial<typeof values>) => {
    if (display.status !== "ready" || display.saving) return;
    void display.save({ ...display.values, ...patch }, display.revision);
  };
  return (
    <Block title={t("settings.fonts")} hint={t("settings.fontsHint")} theme={theme}>
      <Stepper
        name={t("settings.interfaceSize")}
        hint={t("settings.interfaceSizeHint")}
        value={values.interfaceSize}
        onChange={(interfaceSize) => save({ interfaceSize })}
        theme={theme}
        t={t}
      />
      <Stepper
        name={t("settings.contentSize")}
        hint={t("settings.contentSizeHint")}
        value={values.contentSize}
        onChange={(contentSize) => save({ contentSize })}
        theme={theme}
        t={t}
      />
      {display.saveError ? <Note text={display.saveError} color={theme.colors.statusDanger} /> : null}
    </Block>
  );
}

/** 모델과 effort 고르기. 코디네이터와 워커가 같이 쓴다. 모델을 바꾸면 그 모델이 지원하는 effort 로 맞춘다. */
function ModelBlock({
  title,
  hint,
  value,
  models,
  loading,
  failedProviders,
  onChange,
  theme,
  t,
}: {
  title: string;
  hint: string;
  value: { model: string; effort: string };
  models: readonly ModelOption[];
  loading: boolean;
  failedProviders: readonly string[];
  onChange(next: { model: string; effort: string }): void;
  theme: PluginTheme;
  t: T;
}) {
  const fonts = useFonts();
  const current = models.find((model) => model.value === value.model);
  return (
    <Block title={title} hint={hint} theme={theme}>
      {loading ? <Note text={t("settings.loadingModels")} color={theme.colors.foregroundMuted} /> : null}
      {!loading && models.length > 0 && !current ? (
        <Note text={t("settings.modelMissing", { model: value.model })} color={theme.colors.statusWarning} />
      ) : null}
      {failedProviders.map((provider) => (
        <Note key={provider} text={t("settings.modelsFailed", { provider })} color={theme.colors.statusDanger} />
      ))}
      <Wrap>
        {models.map((model) => (
          <ChoiceBox
            key={model.value}
            label={model.label}
            detail={model.provider}
            selected={value.model === model.value}
            onPress={() =>
              onChange({
                model: model.value,
                effort: model.efforts.includes(value.effort)
                  ? value.effort
                  : (model.efforts.find((effort) => effort === "high") ?? model.efforts[0] ?? value.effort),
              })
            }
            theme={theme}
          />
        ))}
      </Wrap>
      {current && current.efforts.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>{t("settings.effort")}</Text>
          <Wrap>
            {current.efforts.map((effort) => (
              <ChoiceBox
                key={effort}
                label={effort}
                selected={value.effort === effort}
                onPress={() => onChange({ ...value, effort })}
                theme={theme}
              />
            ))}
          </Wrap>
        </View>
      ) : null}
    </Block>
  );
}

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * 코디네이터 설정. Paseo 설정의 플러그인 화면과 Coordinator 화면의 설정 탭에서 같이 쓴다.
 * 고친 값은 저장을 눌러야 반영된다. 저장은 읽어 온 revision 을 기준으로 해서, 다른 곳에서 먼저 바꿨으면 실패한다.
 */
function BaseBranchChoice({
  projectRef,
  hostId,
  value,
  onChange,
  theme,
  t,
}: {
  projectRef: ProjectRef;
  hostId: string;
  value: string | null;
  onChange(branch: string | null): void;
  theme: PluginTheme;
  t: T;
}) {
  const fonts = useFonts();
  const name = useProject(projectRef, (p) => p.displayName);
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fonts.label, fontWeight: "600" }}>{name ?? projectRef.id}</Text>
      <BranchPicker
        hostId={hostId}
        projectId={projectRef.id}
        value={value}
        onChange={onChange}
        autoLabel={(defaultBranch) =>
          defaultBranch ? t("settings.baseBranchDefault", { name: defaultBranch }) : t("settings.baseBranchDefaultUnknown")
        }
        theme={theme}
        t={t}
      />
    </View>
  );
}

export function SettingsView({ theme, hostId, t }: { theme: PluginTheme; hostId: string; t: T }) {
  const fonts = useFonts();
  const settings = useSettings(coordinatorSettings);
  const catalog = useProviderCatalog(hostId);
  const projects = useProjects({ hosts: [hostId], orderBy: "displayName" });
  const [draft, setDraft] = useState<CoordinatorSettings | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const ready = settings.status === "ready" ? settings : null;
  // 저장된 값이 바뀌면(처음 읽음, 저장, 다른 곳에서 변경) 편집 중인 값을 그 값으로 맞춘다.
  useEffect(() => {
    if (ready) setDraft(ready.values);
  }, [ready?.revision]);

  const dirty = useMemo(
    () => Boolean(ready && draft && JSON.stringify(ready.values) !== JSON.stringify(draft)),
    [ready, draft],
  );

  if (settings.status === "loading" || (ready && !draft)) {
    return <Note text={t("settings.loading")} color={theme.colors.foregroundMuted} />;
  }
  if (settings.status === "error") {
    return <Note text={t("settings.loadFailed", { message: settings.error })} color={theme.colors.statusDanger} />;
  }
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
  const reviewerModels = models.filter(
    (model) =>
      catalog.data?.readOnlyProviders.has(model.provider) &&
      REVIEWER_EFFORTS.some((effort) => model.efforts.includes(effort)),
  );
  const reviewerInvalid = draft.reviewers.models.length === 0;

  const save = async () => {
    const ok = await settings.save(draft, ready.revision);
    if (ok) setSavedAt(new Date().toISOString());
  };

  return (
    <View style={{ gap: 16, maxWidth: 880 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: fonts.title, fontWeight: "600" }}>{t("settings.title")}</Text>

      <ModelBlock
        title={t("settings.coordinator")}
        hint={t("settings.coordinatorHint")}
        value={draft.coordinator}
        models={models}
        loading={catalog.isPending}
        failedProviders={catalog.data?.failedProviders ?? []}
        onChange={(coordinator) => update((current) => ({ ...current, coordinator }))}
        theme={theme}
        t={t}
      />

      <ModelBlock
        title={t("settings.worker")}
        hint={t("settings.workerHint")}
        value={draft.worker}
        models={models}
        loading={catalog.isPending}
        failedProviders={[]}
        onChange={(worker) => update((current) => ({ ...current, worker }))}
        theme={theme}
        t={t}
      />

      <Block title={t("settings.poteto")} hint={t("settings.potetoHint")} theme={theme}>
        <Wrap>
          {[true, false].map((on) => (
            <ChoiceBox
              key={String(on)}
              label={on ? t("settings.potetoOn") : t("settings.potetoOff")}
              selected={draft.poteto === on}
              onPress={() => update((current) => ({ ...current, poteto: on }))}
              theme={theme}
            />
          ))}
        </Wrap>
      </Block>

      <Block title={t("settings.autoDecisions")} hint={t("settings.autoDecisionsHint")} theme={theme}>
        <Wrap>
          {[true, false].map((on) => (
            <ChoiceBox
              key={String(on)}
              label={on ? t("settings.autoDecisionsOn") : t("settings.autoDecisionsOff")}
              selected={draft.autoDecisions === on}
              onPress={() => update((current) => ({ ...current, autoDecisions: on }))}
              theme={theme}
            />
          ))}
        </Wrap>
      </Block>

      <Block title={t("settings.reviewers")} hint={t("settings.reviewersHint")} theme={theme}>
        {catalog.isError ? (
          <Note
            text={t("settings.catalogFailed", { message: catalog.error instanceof Error ? catalog.error.message : String(catalog.error) })}
            color={theme.colors.statusDanger}
          />
        ) : null}
        {catalog.data && catalog.data.readOnlyProviders.size === 0 ? (
          <Note text={t("settings.noReadOnlyProvider")} color={theme.colors.statusWarning} />
        ) : null}
        <Wrap>
          {reviewerModels.map((model) => (
            <ChoiceBox
              key={model.value}
              label={model.label}
              detail={model.provider}
              multiple
              selected={draft.reviewers.models.includes(model.value)}
              onPress={() =>
                update((current) => ({
                  ...current,
                  reviewers: { ...current.reviewers, models: toggle(current.reviewers.models, model.value) },
                }))
              }
              theme={theme}
            />
          ))}
          {/* 저장돼 있지만 지금 목록에 없는 모델. 보이지 않으면 해제할 수 없고 검토자 수 경고도 화면과 어긋난다. */}
          {catalog.data
            ? draft.reviewers.models
                .filter((value) => !reviewerModels.some((model) => model.value === value))
                .map((value) => (
                  <ChoiceBox
                    key={value}
                    label={value}
                    detail={t("settings.unavailable")}
                    multiple
                    selected
                    onPress={() =>
                      update((current) => ({ ...current, reviewers: { ...current.reviewers, models: toggle(current.reviewers.models, value) } }))
                    }
                    theme={theme}
                  />
                ))
            : null}
        </Wrap>
        {reviewerInvalid ? <Note text={t("settings.noReviewerModel")} color={theme.colors.statusDanger} /> : null}
        {draft.reviewers.models.length === 1 ? (
          <Note text={t("settings.oneModelWarning")} color={theme.colors.statusWarning} />
        ) : null}
        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: fonts.meta }}>
            {`${t("settings.reviewerEffort")} · ${t("settings.reviewerEffortHint")}`}
          </Text>
          <Wrap>
            {REVIEWER_EFFORTS.map((effort) => (
              <ChoiceBox
                key={effort}
                label={effort}
                selected={draft.reviewers.effort === effort}
                onPress={() => update((current) => ({ ...current, reviewers: { ...current.reviewers, effort } }))}
                theme={theme}
              />
            ))}
          </Wrap>
        </View>
      </Block>

      <Block title={t("settings.projects")} hint={t("settings.projectsHint")} theme={theme}>
        {projects.length === 0 ? <Note text={t("settings.noProjects")} color={theme.colors.foregroundMuted} /> : null}
        <View style={{ gap: 6 }}>
          {projects.map((ref) => (
            <ProjectChoice
              key={ref.key}
              projectRef={ref}
              selected={draft.allowedProjectIds.includes(ref.id)}
              onToggle={() =>
                update((current) => ({ ...current, allowedProjectIds: toggle(current.allowedProjectIds, ref.id) }))
              }
              theme={theme}
            />
          ))}
        </View>
      </Block>

      <Block title={t("settings.baseBranches")} hint={t("settings.baseBranchesHint")} theme={theme}>
        {draft.allowedProjectIds.length === 0 ? <Note text={t("settings.noAllowedForBase")} color={theme.colors.foregroundMuted} /> : null}
        <View style={{ gap: 12 }}>
          {projects
            .filter((ref) => draft.allowedProjectIds.includes(ref.id))
            .map((ref) => (
              <BaseBranchChoice
                key={ref.key}
                projectRef={ref}
                hostId={hostId}
                value={draft.baseBranches[ref.id] ?? null}
                onChange={(branch) =>
                  update((current) => {
                    const { [ref.id]: _removed, ...rest } = current.baseBranches;
                    return { ...current, baseBranches: branch ? { ...rest, [ref.id]: branch } : rest };
                  })
                }
                theme={theme}
                t={t}
              />
            ))}
        </View>
      </Block>

      <DisabledRulesBlock theme={theme} t={t} />

      <FontSizeBlock theme={theme} t={t} />

      <Block title={t("settings.language")} hint={t("settings.languageHint")} theme={theme}>
        <Wrap>
          {OUTPUT_LANGUAGES.map((language) => (
            <ChoiceBox
              key={language}
              label={
                language === "auto"
                  ? t("settings.languageAuto")
                  : language === "en"
                    ? t("settings.languageEn")
                    : t("settings.languageKo")
              }
              selected={draft.outputLanguage === language}
              onPress={() => update((current) => ({ ...current, outputLanguage: language }))}
              theme={theme}
            />
          ))}
        </Wrap>
      </Block>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <CtaButton
          label={settings.saving ? t("settings.saving") : t("settings.save")}
          tone="primary"
          disabled={!dirty || reviewerInvalid || settings.saving}
          theme={theme}
          onPress={() => void save()}
        />
        <CtaButton
          label={t("settings.revert")}
          disabled={!dirty || settings.saving}
          theme={theme}
          onPress={() => setDraft(ready.values)}
        />
        <CtaButton
          label={t("settings.reset")}
          disabled={settings.saving}
          theme={theme}
          onPress={() => void settings.reset()}
        />
        {savedAt && !dirty ? <Note text={`✓ ${t("settings.saved")}`} color={theme.colors.statusSuccess} /> : null}
      </View>
      {settings.saveError ? (
        <Note text={t("settings.saveFailed", { message: settings.saveError })} color={theme.colors.statusDanger} />
      ) : null}
    </View>
  );
}
