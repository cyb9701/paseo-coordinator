/// <reference types="node" />

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { describeSentMessage } from "../shared/messages";
import { type CoordinatorSettings, type Language, outputLanguage } from "../shared/settings";
import { type CoordinatorState, type Decision, type Summary, summaryResultSchema } from "../shared/model";
import type { PaseoApi } from "./paseo-api";
import { type StateStore, dataDirectory, nextId } from "./store";
import { mergeRuns, recentExchanges } from "./timeline";
import type { WorkspaceStatusReader } from "./workspace-status";
import type { WorkspaceDirectory } from "./workspaces";

export const ROLE_LABEL = "paseo-coordinator.role";
const SUMMARIZER = "summarizer";
const TIMEOUT_MS = 4 * 60_000;
/** 동시에 도는 요약 수. provider 장애로 여러 에이전트가 한꺼번에 실패해도 요약 에이전트가 줄줄이 뜨지 않게 한다. */
const MAX_PARALLEL = 2;
/** 같은 에이전트의 실패 요약 간격. 실패가 반복되면 같은 원인일 가능성이 커서 매번 요약하지 않는다. */
const ERROR_SUMMARY_GAP_MS = 10 * 60_000;

/** 요약 에이전트는 만들 때 라벨과 metadata 에 표시한다. 권한·턴 hook 이 받는 에이전트에는 라벨이 없어서 metadata 로 알아본다. */
export function isSummarizer(source: { labels?: Readonly<Record<string, string>>; metadata?: Readonly<Record<string, unknown>> }): boolean {
  return source.labels?.[ROLE_LABEL] === SUMMARIZER || source.metadata?.[ROLE_LABEL] === SUMMARIZER;
}

/**
 * 요약 에이전트는 받은 글만 정리한다. 파일을 읽거나 명령을 돌리거나 다른 에이전트를 움직이면 안 되고, 그럴 필요도 없다.
 * Claude 에서는 도구를 빼고, 그래도 오는 권한 요청은 index.server.ts 의 권한 hook 이 거절한다.
 */
const SUMMARIZER_BLOCKED_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
  "mcp__paseo",
];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * 사람이 정할 일이 생겼을 때만(멈춘 결정, 실패한 턴, 사람이 누른 요약) 작은 모델로 앞뒤 상황을 정리한다.
 * 에이전트 하나에 한 번에 하나만 돈다. 도는 중에 새 일이 생기면 끝난 뒤 한 번 더 돈다.
 */
export class Summarizer {
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Map<string, { trigger: Summary["trigger"]; language: Language | null }>();
  private active = 0;
  private readonly waitingForSlot: (() => void)[] = [];

  constructor(
    private readonly store: StateStore,
    private readonly readSettings: () => Promise<CoordinatorSettings>,
    private readonly directory: WorkspaceDirectory,
    private readonly statuses: WorkspaceStatusReader,
    /** 요약 에이전트의 작업 폴더. 테스트는 임시 폴더를 넘긴다. */
    private readonly home = join(dataDirectory(), "summarizer"),
  ) {}

  request(paseo: PaseoApi, agentId: string, workspaceId: string, trigger: Summary["trigger"], language: Language | null): void {
    if (this.running.has(agentId)) {
      this.again.set(agentId, { trigger, language });
      return;
    }
    const job = this.run(paseo, agentId, workspaceId, trigger, language)
      .catch((error) => console.error(`[coordinator] summary for ${agentId} failed`, error))
      .finally(() => {
        this.running.delete(agentId);
        const next = this.again.get(agentId);
        if (next) {
          this.again.delete(agentId);
          this.request(paseo, agentId, workspaceId, next.trigger, next.language);
        }
      });
    this.running.set(agentId, job);
  }

  /** 아직 요약하지 않은 멈춘 결정이 있으면 요약한다. 턴이 끝날 때 부른다. 한 턴에 멈춘 결정 여러 개를 요약 하나로 묶는다. */
  async afterTurn(
    paseo: PaseoApi,
    agentId: string,
    workspaceId: string,
    failed: boolean,
    language: Language | null,
    settings: CoordinatorSettings,
  ): Promise<void> {
    if (!settings.summary.enabled) return;
    const state = await this.store.read();
    const mine = state.summaries.filter((item) => item.agentId === agentId);
    const covered = new Set(mine.flatMap((item) => item.decisionIds));
    const fresh = state.decisions.some((item) => item.agentId === agentId && item.status === "waiting" && !covered.has(item.id));
    if (fresh) {
      this.request(paseo, agentId, workspaceId, "decision", language);
      return;
    }
    if (!failed) return;
    const lastError = [...mine].reverse().find((item) => item.trigger === "error");
    if (lastError && Date.now() - Date.parse(lastError.at) < ERROR_SUMMARY_GAP_MS) return;
    this.request(paseo, agentId, workspaceId, "error", language);
  }

  private async slot(): Promise<() => void> {
    if (this.active >= MAX_PARALLEL) await new Promise<void>((resolve) => this.waitingForSlot.push(resolve));
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waitingForSlot.shift()?.();
    };
  }

  private async run(paseo: PaseoApi, agentId: string, workspaceId: string, trigger: Summary["trigger"], language: Language | null) {
    const settings = await this.readSettings();
    const state = await this.store.read();
    const waiting = state.decisions.filter((item) => item.agentId === agentId && item.status === "waiting");
    const id = await this.store.update((current) => {
      const { state: next, id } = nextId(current, "s");
      const summary: Summary = {
        id,
        agentId,
        workspaceId,
        trigger,
        decisionIds: waiting.map((item) => item.id),
        status: "running",
        at: new Date().toISOString(),
        result: null,
        error: null,
      };
      return { state: { ...next, summaries: [...next.summaries, summary] }, result: id };
    });
    const finish = (patch: Partial<Summary>) =>
      this.store.update((current) => ({
        state: { ...current, summaries: current.summaries.map((item) => (item.id === id ? { ...item, ...patch } : item)) },
        result: undefined,
      }));
    const release = await this.slot();
    try {
      // 에이전트 생성이 응답하지 않아도 요약이 running 으로 남지 않게 전체에 시간 제한을 둔다.
      const result = await withTimeout(
        (async () => this.ask(paseo, settings, await this.material(paseo, state, agentId, workspaceId, waiting, trigger, outputLanguage(settings, language))))(),
        TIMEOUT_MS + 60_000,
      );
      await finish({ status: "done", result });
    } catch (error) {
      await finish({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      release();
    }
  }

  private async material(
    paseo: PaseoApi,
    state: CoordinatorState,
    agentId: string,
    workspaceId: string,
    waiting: readonly Decision[],
    trigger: Summary["trigger"],
    language: Language | null,
  ): Promise<string> {
    const [exchanges, entry, snapshot] = await Promise.all([
      recentExchanges(paseo, agentId).then(mergeRuns).catch(() => []),
      this.directory.find(paseo, workspaceId).catch(() => null),
      paseo.agents.ref(agentId).refresh().catch(() => null),
    ]);
    // 보드와 같은 묶음(지켜보는 프로젝트 전체)으로 읽어 캐시를 함께 쓴다. 한 프로젝트만 읽으면 git 을 한 번 더 돌린다.
    const statuses = entry ? await this.statuses.read(paseo, settingsProjects(await this.readSettings().catch(() => null), entry.projectId)).catch(() => []) : [];
    const status = statuses.find((item) => item.workspaceId === workspaceId);
    // 플러그인이 사람 대신 보낸 메시지도 사람 메시지로 남는다. 원문은 길고 에이전트용이라, 사람이 한 일만 한 줄로 줄여 넣는다.
    const users = exchanges.filter((item) => item.role === "user").map((item) => ({ ...item, text: describeSentMessage(item.text) }));
    const lastAgent = [...exchanges].reverse().find((item) => item.role === "agent");
    const errors = exchanges.filter((item) => item.role === "error").slice(-2);
    const earlier = state.decisions.filter((item) => item.workspaceId === workspaceId && item.status !== "waiting").slice(-15);
    const names = new Map((await this.directory.list(paseo).catch(() => [])).map((item) => [item.id, item.title ?? item.name]));
    const sections = [
      // 앱 언어를 한 번도 듣지 못했으면 영어로 가정하지 않고 사람이 에이전트에게 쓴 언어를 따른다.
      `Write every field in ${language === "ko" ? "Korean" : language === "en" ? "English" : "the language the person writes to the agent in"}. Keep code identifiers, file paths and commands as they are.`,
      `Trigger: ${trigger === "decision" ? "the agent stopped and waits for the person's decision" : trigger === "error" ? "the agent's turn failed" : "the person asked for a summary"}.`,
      `Workspace: ${entry ? `${entry.title ?? entry.name} (project ${entry.projectDisplayName}, branch ${entry.gitRuntime?.currentBranch ?? "unknown"})` : workspaceId}`,
      `Agent: ${snapshot?.agent.title ?? agentId}, status ${snapshot?.agent.status ?? "unknown"}${snapshot?.agent.lastError ? `, last error: ${clip(snapshot.agent.lastError, 1000)}` : ""}`,
      users.length
        ? `What the person asked or did (the earliest message in the recent history, then the latest messages; [bracketed] lines are actions the person took in the coordinator):\n${[users[0]!, ...users.slice(1).slice(-3)].map((item) => `- ${clip(item.text, 2000)}`).join("\n")}`
        : "No request text was found.",
      lastAgent ? `The agent's last message:\n${clip(lastAgent.text, 4000)}` : "",
      errors.length ? `Errors:\n${errors.map((item) => `- ${clip(item.text, 1000)}`).join("\n")}` : "",
      waiting.length ? `Decisions waiting for the person (JSON):\n${JSON.stringify(waiting.map(decisionForPrompt), null, 1)}` : "",
      earlier.length
        ? `Earlier decisions in this workspace:\n${earlier.map((item) => `- #${item.number} [${item.status}] ${clip(item.decision, 200)}`).join("\n")}`
        : "",
      status?.changedFiles.length ? `Changed files (${status.changedFiles.length}): ${status.changedFiles.slice(0, 50).join(", ")}` : "",
      status?.overlaps.length
        ? `Files also changed in other workspaces of the same project:\n${status.overlaps.map((item) => `- ${names.get(item.workspaceId) ?? item.workspaceId}: ${item.files.slice(0, 20).join(", ")}`).join("\n")}`
        : "",
      status?.pullRequest
        ? `Pull request #${status.pullRequest.number}: ${status.pullRequest.state}, checks ${status.pullRequest.checks ?? "unknown"}, mergeable ${status.pullRequest.mergeable ?? "unknown"}`
        : "",
    ].filter(Boolean);
    return `${SUMMARY_INSTRUCTIONS}\n\n${sections.join("\n\n")}`;
  }

  private async ask(paseo: PaseoApi, settings: CoordinatorSettings, prompt: string) {
    const home = this.home;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "README.md"), "# Coordinator summaries\n\nWorking folder of the coordinator's summary agents. They only read the text they are given.\n", "utf8");
    const model = settings.summary.model;
    const provider = model.split("/")[0]!;
    const claude = provider === "claude";
    // 모드를 정하지 않으면 provider 기본 모드를 따르는데, 사용자 설정에 따라 권한을 묻지 않는 모드일 수 있다. 묻는 모드로 띄워야
    // 아래 도구 차단을 빠져나간 호출도 권한 hook 이 거절한다.
    const modes = (await paseo.providers.listModes(provider).catch(() => null))?.modes ?? [];
    const modeId = ["default", "plan", "read-only"].find((id) => modes.some((mode) => mode.id === id));
    const options = {
      background: true,
      title: "coordinator summary",
      labels: { [ROLE_LABEL]: SUMMARIZER },
      metadata: { [ROLE_LABEL]: SUMMARIZER },
      config: {
        provider: model,
        ...(modeId ? { modeId } : {}),
        ...(settings.summary.effort ? { thinkingOptionId: settings.summary.effort } : {}),
        ...(claude ? { options: { disallowedTools: SUMMARIZER_BLOCKED_TOOLS } } : {}),
      },
      outputSchema: z.toJSONSchema(summaryResultSchema, { io: "input" }) as Record<string, unknown>,
      prompt,
    };
    // 작업 폴더만 주고 만들면 요약마다 background 워크스페이스가 하나씩 생겨 쌓인다. 처음 한 번만 그렇게 만들고, 그다음부터는 그
    // 워크스페이스에 에이전트만 더한다. 에이전트는 끝나면 archive 하고 워크스페이스는 남겨 다시 쓴다.
    const workspace = (await this.directory.list(paseo, true).catch(() => [])).find(
      (entry) => entry.workspaceDirectory === home && !entry.archivingAt,
    );
    const agent = workspace ? await paseo.workspaces.ref(workspace.id).agents.create(options) : await paseo.agents.create({ cwd: home, ...options });
    try {
      const finished = await agent.waitForFinish(TIMEOUT_MS);
      if (finished.status !== "idle") throw new Error(finished.error ?? `summary agent ended as ${finished.status}`);
      return parseResult(finished.lastMessage);
    } finally {
      await agent.archive().catch(() => undefined);
    }
  }
}

function settingsProjects(settings: CoordinatorSettings | null, fallback: string): string[] {
  return settings?.projectIds.length ? settings.projectIds : [fallback];
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The summary took too long.")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function decisionForPrompt(item: Decision) {
  return {
    number: item.number,
    decision: item.decision,
    kind: item.kind,
    why: item.why,
    alternatives: item.alternatives,
    evidence: item.evidence,
    restsOnAssumption: item.restsOnAssumption,
    reversible: item.reversible,
    files: item.files,
  };
}

/** 구조화된 출력이 마지막 메시지로 온다. 코드 블록으로 감싸 오는 경우도 받는다. */
export function parseResult(text: string | null) {
  if (!text) throw new Error("The summary agent returned nothing.");
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The summary agent did not return JSON.");
  return summaryResultSchema.parse(JSON.parse(body.slice(start, end + 1)));
}

const SUMMARY_INSTRUCTIONS = `You prepare a briefing for a person who oversees many coding agents and must now decide or check something in one of them. They have not been watching this agent. Use only the material below; do not guess beyond it, and say when something is unknown.

Return JSON with:
- before: what led here, in 2-4 sentences: what was asked, what the agent has done so far, and earlier decisions that matter.
- ask: what the person must decide or check now, in 1-2 sentences. Name the options when there are any.
- after: one item per option or outcome: what happens next if the person picks it.
- watchOut: things they must not miss: assumptions the agent did not verify, files also changed in other workspaces, failing checks, work that is hard to undo. Empty when there is nothing.`;
