/// <reference types="node" />

import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type CoordinatorRequest, GRADES, type Task } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import { type StateStore, dataDirectory } from "./store";

type Settings = PluginSettings<typeof settingsSchema>;

const HANGUL = /[가-힣]/;
const MAX_WORKSPACE_TITLE = 40;
const OVERVIEW_LIMIT = 4000;
const READ_LIMIT = 24_000;
const LIST_LIMIT = 200;

// RULES.md H2 의 비밀 파일. 코디네이터 읽기 도구로도 읽지 않는다.
const SECRET_FILE = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|\.npmrc|\.netrc)$/i;

/**
 * 허용된 프로젝트 안의 경로만 돌려준다. '..' 와 심볼릭 링크로 프로젝트 밖에 닿지 못하게 실제 경로로 비교한다.
 */
async function resolveInside(root: string, path: string): Promise<string | null> {
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, path)).catch(() => null);
  if (!target) return null;
  const rel = relative(realRoot, target);
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !rel.includes(`..${sep}`))) return target;
  return null;
}

/** 코디네이터 전용 도구 이름. 이 도구에 대한 권한 요청은 플러그인이 기계적으로 허용한다. */
export const COORDINATOR_TOOL_PREFIX = "coordinator_";

/**
 * 코디네이터 에이전트에 붙이는 라벨. 세션을 여는 hook 은 이 라벨로 코디네이터를 알아본다.
 * 저장된 agentId 로 알아보면, 에이전트를 만드는 순간 열리는 첫 세션에서는 id 가 아직 저장되기 전이라
 * 도구와 지침이 붙지 않았다 (2026-11-25 테스트. 코디네이터가 도구를 못 찾고 Bash 로 폴더를 뒤졌다).
 */
export const COORDINATOR_LABEL = "paseo-coordinator.role";

export function isCoordinatorSession(labels: Readonly<Record<string, string>>): boolean {
  return labels[COORDINATOR_LABEL] === "coordinator";
}

export function workspaceTitle(requestTitle: string, task: Pick<Task, "number" | "name">): string {
  return `${requestTitle} · ${task.number} ${task.name}`;
}

async function readSettings(settings: Settings) {
  const state = await settings.read();
  if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
  return state.values;
}

async function allowedProjects(paseo: PaseoApi, settings: Settings) {
  const { allowedProjectIds } = await readSettings(settings);
  const { projects } = await paseo.projects.list();
  return projects
    .filter((project) => allowedProjectIds.includes(project.projectId))
    .map((project) => ({ id: project.projectId, name: project.projectDisplayName, path: project.projectRootPath }));
}

// 알린 뒤 이만큼 지났는데 코디네이터가 쉬고 있고 요청이 아직 planning 이면 알림이 유실된 것으로 본다.
const RENOTIFY_AFTER_MS = 60_000;
const MAX_RENOTIFY = 3;

/**
 * 코디네이터에게 (다시) 알려야 하는 요청인가.
 * 알림 메시지는 코디네이터 세션이 다시 열리거나 턴이 끊기면 사라질 수 있다 (2026-11-25: 알림을 기록한 직후 세션을
 * 다시 열어 메시지가 사라졌고, 이미 알린 것으로 기록돼 요청이 planning 에 멈췄다). 그래서 쉬는 코디네이터가 처리하지
 * 않은 요청은 다시 알린다.
 */
function needsPlanning(request: CoordinatorRequest, coordinatorIdle: boolean, now: number): boolean {
  if (request.status !== "planning") return false;
  if (!request.notifiedAt) return true;
  const lastFeedback = request.feedback.at(-1)?.at;
  if (lastFeedback && lastFeedback > request.notifiedAt) return true;
  return coordinatorIdle && now - Date.parse(request.notifiedAt) > RENOTIFY_AFTER_MS;
}

/**
 * 코디네이터 에이전트를 만들고 알리는 일을 맡는다. 같은 시각에 두 요청이 와도 에이전트가 하나만 생기도록
 * 만드는 작업을 promise 하나로 묶는다.
 */
export class CoordinatorRuntime {
  private creating: Promise<string> | null = null;
  private notifying = false;
  /** 요청마다 다시 알린 횟수. 플러그인 프로세스 동안만 센다. */
  private readonly renotified = new Map<string, number>();

  constructor(
    private readonly store: StateStore,
    private readonly settings: Settings,
    /** 계획이 저장되어 시작된 직후 부른다. 배정기가 워커를 만든다. */
    private readonly onPlanStarted: (paseo: PaseoApi) => void = () => {},
  ) {}

  async agentId(): Promise<string | null> {
    return (await this.store.read()).coordinator?.agentId ?? null;
  }

  private async ensure(paseo: PaseoApi, language: "en" | "ko"): Promise<string> {
    const existing = (await this.store.read()).coordinator;
    if (existing) {
      const snapshot = await paseo.agents.ref(existing.agentId).refresh().catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) return existing.agentId;
    }
    this.creating ??= this.create(paseo, language).finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async create(paseo: PaseoApi, language: "en" | "ko"): Promise<string> {
    const values = await readSettings(this.settings);
    // Paseo 는 폴더 이름을 프로젝트 이름으로 쓴다. 사이드바에서 알아보기 쉽게 'coordinator' 로 둔다.
    const home = join(dataDirectory(), "coordinator");
    await mkdir(home, { recursive: true });
    await writeFile(
      join(home, "README.md"),
      "# Coordinator\n\nWorking folder of the paseo-coordinator plugin's coordinator agent. It plans requests and does not edit code here.\n",
      "utf8",
    );
    const title = language === "ko" ? "코디네이터" : "Coordinator";
    const workspace = await paseo.workspaces.create({ source: { kind: "directory", path: home }, title });
    const provider = values.coordinator.model.split("/")[0]!;
    const modes = await paseo.providers.listModes(provider).catch(() => null);
    // 권한을 묻는 기본 모드로 띄운다. 코디네이터가 자기 도구 밖의 일을 하려 하면 사람에게 올라가야 한다.
    const modeId = modes?.modes?.some((mode) => mode.id === "default") ? "default" : undefined;
    const agent = await workspace.agents.create({
      config: { provider: values.coordinator.model, modeId, thinkingOptionId: values.coordinator.effort },
      title,
      labels: { [COORDINATOR_LABEL]: "coordinator" },
    });
    await this.store.update((state) => ({
      state: { ...state, coordinator: { agentId: agent.id, workspaceId: workspace.id } },
      result: undefined,
    }));
    console.log(`[coordinator] created coordinator agent ${agent.id} in workspace ${workspace.id}`);
    return agent.id;
  }

  /**
   * 계획이 필요한 요청을 코디네이터에게 알린다. 코디네이터가 일하는 중이거나 권한을 기다리면 보내지 않는다.
   * (보내면 진행 중인 턴이 끊기고 대기 중인 권한 요청이 거절된다. RULES.md §13.) 그 경우 턴이 끝날 때 다시 부른다.
   */
  async notify(paseo: PaseoApi): Promise<void> {
    if (this.notifying) return;
    this.notifying = true;
    try {
      const state = await this.store.read();
      if (!state.requests.some((request) => needsPlanning(request, true, Date.now()))) return;
      const language = state.requests.find((request) => request.status === "planning")?.language ?? "en";
      const agentId = await this.ensure(paseo, language);
      const snapshot = await paseo.agents.ref(agentId).refresh();
      if (!snapshot) return;
      if (snapshot.agent.status === "running" || (snapshot.agent.pendingPermissions?.length ?? 0) > 0) return;
      // 여기까지 왔으면 코디네이터는 쉬고 있다.
      const waiting = state.requests.filter((request) => {
        if (!needsPlanning(request, true, Date.now())) return false;
        // 처음 알리거나 새 지시가 온 경우는 세지 않는다. 유실을 의심해 다시 알리는 경우만 센다.
        const lastFeedback = request.feedback.at(-1)?.at;
        if (!request.notifiedAt || (lastFeedback && lastFeedback > request.notifiedAt)) {
          this.renotified.delete(request.id);
          return true;
        }
        const count = this.renotified.get(request.id) ?? 0;
        if (count >= MAX_RENOTIFY) {
          console.error(`[coordinator] ${request.id} is still planning after ${count} reminders; not reminding again`);
          return false;
        }
        this.renotified.set(request.id, count + 1);
        return true;
      });
      if (waiting.length === 0) return;
      const now = new Date().toISOString();
      const ids = waiting.map((request) => request.id);
      await this.store.update((current) => ({
        state: {
          ...current,
          requests: current.requests.map((request) => (ids.includes(request.id) ? { ...request, notifiedAt: now } : request)),
        },
        result: undefined,
      }));
      await paseo.agents
        .ref(agentId)
        .send(
          `[paseo-coordinator] Requests waiting for you: ${ids.join(", ")}. For each one, call coordinator_get_request, classify it, then answer it (coordinator_submit_answer) or plan it (coordinator_submit_plan).`,
        );
    } finally {
      this.notifying = false;
    }
  }

  /** 코디네이터가 남긴 프로젝트 id 중 허용된 것만 남긴다. 카드에 보일 이름용이라 틀린 id 로 실패시키지 않는다. */
  private async knownProjects(paseo: PaseoApi, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const allowed = new Set((await allowedProjects(paseo, this.settings)).map((project) => project.id));
    return ids.filter((id) => allowed.has(id));
  }

  tools() {
    return [
      this.getRequestTool(),
      this.projectOverviewTool(),
      this.listFilesTool(),
      this.readFileTool(),
      this.askHumanTool(),
      this.submitAnswerTool(),
      this.submitPlanTool(),
    ];
  }

  /**
   * 코디네이터가 프로젝트 파일을 읽는 길. Claude 의 Read 는 코디네이터 작업 폴더 밖이라 매번 사람에게 권한을 물어
   * 병목이 됐다 (2026-11-25). 이 도구는 허용된 프로젝트 안, 비밀 파일 제외, 크기 상한으로만 읽고 자동 허용된다.
   */
  private listFilesTool() {
    return defineAgentTool({
      name: "coordinator_list_files",
      title: "List project files",
      description: "List files and folders in a directory of an allowed project. path is relative to the project root; use \".\" for the root.",
      input: z.object({ projectId: z.string(), path: z.string().default(".") }),
      execute: async ({ projectId, path }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        const target = await resolveInside(project.path, path);
        if (!target) return { text: `${path} is not inside project ${project.name}.`, isError: true };
        const entries = await readdir(target, { withFileTypes: true }).catch(() => null);
        if (!entries) return { text: `${path} is not a readable directory.`, isError: true };
        const names = entries
          .filter((entry) => entry.name !== ".git" && entry.name !== "node_modules")
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort();
        const shown = names.slice(0, LIST_LIMIT);
        return { text: shown.join("\n") + (names.length > shown.length ? `\n… ${names.length - shown.length} more` : "") };
      },
    });
  }

  private readFileTool() {
    return defineAgentTool({
      name: "coordinator_read_file",
      title: "Read project file",
      description: `Read a text file in an allowed project. path is relative to the project root. Returns at most ${READ_LIMIT} characters; secrets such as .env files are refused.`,
      input: z.object({ projectId: z.string(), path: z.string().min(1) }),
      execute: async ({ projectId, path }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        const target = await resolveInside(project.path, path);
        if (!target) return { text: `${path} is not inside project ${project.name}.`, isError: true };
        if (SECRET_FILE.test(basename(target))) return { text: `${path} may hold secrets and is not readable.`, isError: true };
        const info = await stat(target).catch(() => null);
        if (!info?.isFile()) return { text: `${path} is not a file.`, isError: true };
        const text = await readFile(target, "utf8").catch(() => null);
        if (text === null) return { text: `${path} could not be read as text.`, isError: true };
        return {
          text: text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n… truncated (${text.length} characters total)` : text,
        };
      },
    });
  }

  private getRequestTool() {
    return defineAgentTool({
      name: "coordinator_get_request",
      title: "Get request",
      description:
        "Read a request exactly as the human wrote it, with feedback, the current plan if any, and the projects you may use.",
      input: z.object({ requestId: z.string() }),
      execute: async ({ requestId }, { paseo }) => {
        const request = (await this.store.read()).requests.find((item) => item.id === requestId);
        if (!request) return { text: `Unknown request ${requestId}`, isError: true };
        const projects = await allowedProjects(paseo, this.settings);
        const usable = request.projectIds.length > 0 ? projects.filter((p) => request.projectIds.includes(p.id)) : projects;
        return {
          text: JSON.stringify(
            {
              id: request.id,
              status: request.status,
              language: request.language,
              text: request.text,
              doneCriteria: request.doneCriteria,
              feedback: request.feedback,
              currentPlan: request.tasks.length > 0 ? { title: request.title, grade: request.grade, tasks: request.tasks } : null,
              projects: usable,
            },
            null,
            2,
          ),
        };
      },
    });
  }

  private projectOverviewTool() {
    return defineAgentTool({
      name: "coordinator_project_overview",
      title: "Project overview",
      description: "Read the README, package.json summary and top-level files of an allowed project.",
      input: z.object({ projectId: z.string() }),
      execute: async ({ projectId }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        const [readme, pkg, entries] = await Promise.all([
          readFile(join(project.path, "README.md"), "utf8").catch(() => null),
          readFile(join(project.path, "package.json"), "utf8").catch(() => null),
          readdir(project.path).catch(() => [] as string[]),
        ]);
        let packageSummary: unknown = null;
        if (pkg) {
          try {
            const parsed = JSON.parse(pkg) as Record<string, unknown>;
            packageSummary = { name: parsed.name, description: parsed.description, scripts: parsed.scripts };
          } catch {
            packageSummary = "package.json is not valid JSON";
          }
        }
        return {
          text: JSON.stringify(
            {
              project,
              topLevel: entries.filter((name) => !name.startsWith(".")).slice(0, 80),
              packageJson: packageSummary,
              readme: readme ? readme.slice(0, OVERVIEW_LIMIT) : null,
            },
            null,
            2,
          ),
        };
      },
    });
  }

  /**
   * 사람에게 질문 카드를 보낸다. 요청을 두 가지 이상으로 읽을 수 있거나, 사람이 정할 선택(제품·UX 방향, 데이터 구조,
   * 라이브러리, 공개 API)이 있거나, A 등급의 실제 변경을 시작해야 할 때만 쓴다 (RULES.md §2.0).
   */
  private askHumanTool() {
    return defineAgentTool({
      name: "coordinator_ask_human",
      title: "Ask the human",
      description:
        "Send the human a question card when the request is ambiguous, needs a human choice (product or UX direction, data structure, library, public API), or is grade A and the real change must start. Give context, concrete questions, options and your recommendation. Do not ask about things you can decide yourself.",
      input: z.object({
        requestId: z.string(),
        title: z.string().trim().min(1),
        context: z.string().trim().min(1),
        questions: z
          .array(
            z.object({
              question: z.string().trim().min(1),
              options: z.array(z.object({ label: z.string().trim().min(1), description: z.string().optional() })).min(2),
              recommended: z.string().nullable().default(null),
            }),
          )
          .min(1)
          .max(4),
        projectIds: z.array(z.string()).default([]),
      }),
      execute: async (input, { paseo }) => {
        const request = (await this.store.read()).requests.find((item) => item.id === input.requestId);
        if (!request) return { text: `Unknown request ${input.requestId}`, isError: true };
        if (request.status !== "planning" && request.status !== "running") {
          return { text: `Request ${request.id} is ${request.status}; it does not take questions now.`, isError: true };
        }
        for (const question of input.questions) {
          if (question.recommended && !question.options.some((option) => option.label === question.recommended)) {
            return { text: `recommended "${question.recommended}" is not one of the option labels.`, isError: true };
          }
        }
        const now = new Date().toISOString();
        const projectIds = await this.knownProjects(paseo, input.projectIds);
        await this.store.update((current) => ({
          state: {
            ...current,
            requests: current.requests.map((item) =>
              item.id === request.id
                ? {
                    ...item,
                    status: "needs_input" as const,
                    title: item.title ?? input.title,
                    question: {
                      context: input.context,
                      questions: input.questions,
                      projectIds,
                      at: now,
                    },
                  }
                : item,
            ),
          },
          result: undefined,
        }));
        return { text: `Question card sent for ${request.id}. Wait for the human's answer; the plugin will tell you.` };
      },
    });
  }

  /** 읽기 요청에 직접 답한다. 등급도 계획 승인도 없다. 사람은 인박스 '확인 필요'의 답변 카드로 본다. */
  private submitAnswerTool() {
    return defineAgentTool({
      name: "coordinator_submit_answer",
      title: "Submit answer",
      description:
        "Answer a read request (one that changes nothing) directly. Use this when your read-only tools were enough to answer.",
      input: z.object({
        requestId: z.string(),
        title: z.string().trim().min(1),
        answer: z.string().trim().min(1),
        sources: z.array(z.string().trim().min(1)).min(1),
        unknowns: z.array(z.string()).default([]),
        projectIds: z.array(z.string()).default([]),
      }),
      execute: async (input, { paseo }) => {
        const request = (await this.store.read()).requests.find((item) => item.id === input.requestId);
        if (!request) return { text: `Unknown request ${input.requestId}`, isError: true };
        if (request.status !== "planning") {
          return { text: `Request ${request.id} is ${request.status}; it no longer takes an answer.`, isError: true };
        }
        if (request.language === "ko" && !HANGUL.test(input.title)) {
          return { text: "title must be written in Korean (language is ko).", isError: true };
        }
        const now = new Date().toISOString();
        const projectIds = await this.knownProjects(paseo, input.projectIds);
        await this.store.update((current) => ({
          state: {
            ...current,
            requests: current.requests.map((item) =>
              item.id === request.id
                ? {
                    ...item,
                    kind: "read" as const,
                    status: "answered" as const,
                    title: input.title,
                    grade: null,
                    tasks: [],
                    answer: { text: input.answer, sources: input.sources, unknowns: input.unknowns, projectIds, at: now },
                  }
                : item,
            ),
          },
          result: undefined,
        }));
        return { text: `Answer stored for ${request.id}. The human reviews it in the inbox.` };
      },
    });
  }

  private submitPlanTool() {
    const taskInput = z.object({
      number: z.number().int().positive(),
      name: z.string().trim().min(1),
      projectId: z.string(),
      dependsOn: z.array(z.number().int().positive()).default([]),
      scope: z.string().trim().min(1),
      doneCriteria: z.string().trim().min(1),
      requestRefs: z.array(z.string().trim().min(1)).min(1),
    });
    return defineAgentTool({
      name: "coordinator_submit_plan",
      title: "Submit plan",
      description:
        "Submit or replace the plan for a request in the planning state. For a change request set readOnly false and a grade. For a read request too large to answer yourself, set readOnly true and omit grade: read-only investigation workers start without approval.",
      input: z.object({
        requestId: z.string(),
        readOnly: z.boolean().default(false),
        title: z.string().trim().min(1),
        grade: z.enum(GRADES).optional(),
        gradeReasons: z.array(z.string().trim().min(1)).min(1),
        recommendation: z.string().trim().min(1),
        risks: z.array(z.string()).default([]),
        unknowns: z.array(z.string()).default([]),
        tasks: z.array(taskInput).min(1),
      }),
      execute: async (input, { paseo }) => {
        const state = await this.store.read();
        const request = state.requests.find((item) => item.id === input.requestId);
        if (!request) return { text: `Unknown request ${input.requestId}`, isError: true };
        if (request.status !== "planning") {
          return { text: `Request ${request.id} is ${request.status}; it no longer takes a plan.`, isError: true };
        }
        const projects = await allowedProjects(paseo, this.settings);
        const usable = new Set(
          (request.projectIds.length > 0 ? projects.filter((p) => request.projectIds.includes(p.id)) : projects).map((p) => p.id),
        );
        const problems = validatePlan(input, request.language, usable);
        if (!input.readOnly && !input.grade) problems.push("A change request needs a grade.");
        // A 등급의 실제 변경은 사람이 질문 카드에 답한 뒤에만 시작한다 (RULES.md §2.0, H4). 코드로 막는다.
        if (!input.readOnly && input.grade === "A" && request.feedback.at(-1)?.kind !== "answer") {
          problems.push(
            "Grade A: start with a readOnly investigation plan, or ask the human with coordinator_ask_human before planning the real change.",
          );
        }
        if (problems.length > 0) return { text: `Plan rejected:\n- ${problems.join("\n- ")}`, isError: true };
        // v3: 명확한 요청은 코디네이터 판단으로 바로 시작한다. 사람은 확인 필요의 시작 카드로 본다 (RULES.md §2.0).
        // 읽기 전용 조사 워커는 읽기 전용 모드로 띄운다 (3e).
        const status = "running" as const;
        const grade = input.readOnly ? null : (input.grade ?? null);
        const now = new Date().toISOString();
        await this.store.update((current) => ({
          state: {
            ...current,
            requests: current.requests.map((item) =>
              item.id === request.id
                ? {
                    ...item,
                    status,
                    kind: input.readOnly ? ("read" as const) : ("change" as const),
                    title: input.title,
                    grade,
                    answer: null,
                    gradeReasons: input.gradeReasons,
                    recommendation: input.recommendation,
                    risks: input.risks,
                    unknowns: input.unknowns,
                    plannedAt: now,
                    tasks: input.tasks.map((task) => ({
                      ...task,
                      status: "waiting" as const,
                      workspaceId: null,
                      agentId: null,
                      branch: null,
                      note: null,
                    })),
                  }
                : item,
            ),
          },
          result: undefined,
        }));
        this.onPlanStarted(paseo);
        return {
          text:
            `Plan stored for ${request.id} and started. The plugin creates the workers. The human sees it as a start card and can stop or redirect it.`,
        };
      },
    });
  }
}

/** 계획의 형식과 규칙 검사. 실패하면 코디네이터에게 이유를 돌려줘 고치게 한다. */
export function validatePlan(
  plan: {
    title: string;
    tasks: readonly { number: number; name: string; projectId: string; dependsOn: readonly number[] }[];
  },
  language: "en" | "ko",
  usableProjects: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const numbers = plan.tasks.map((task) => task.number);
  const expected = plan.tasks.map((_, index) => index + 1);
  if (numbers.join(",") !== expected.join(",")) problems.push(`Task numbers must be 1..${plan.tasks.length} in order.`);
  if (language === "ko" && !HANGUL.test(plan.title)) problems.push("title must be written in Korean (language is ko).");
  for (const task of plan.tasks) {
    if (!usableProjects.has(task.projectId)) problems.push(`Task ${task.number}: project ${task.projectId} is not allowed for this request.`);
    if (language === "ko" && !HANGUL.test(task.name)) problems.push(`Task ${task.number}: name must be written in Korean.`);
    if (/\n/.test(task.name) || /\n/.test(plan.title)) problems.push(`Task ${task.number}: names must be one line.`);
    const title = workspaceTitle(plan.title, task);
    if (title.length > MAX_WORKSPACE_TITLE) {
      problems.push(`Task ${task.number}: workspace title "${title}" is ${title.length} characters; keep it within ${MAX_WORKSPACE_TITLE}.`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency >= task.number) problems.push(`Task ${task.number}: dependsOn may only list earlier tasks (got ${dependency}).`);
    }
  }
  return problems;
}
