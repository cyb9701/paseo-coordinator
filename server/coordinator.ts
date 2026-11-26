/// <reference types="node" />

import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "./paseo-api";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { type AgentToolDefinition, defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { AUTO_RULES, type CoordinatorRequest, type CoordinatorState, GRADES, type Task, cardQa, withCardQa } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import { type StateStore, dataDirectory } from "./store";
import type { ReviewRunner } from "./review";
import type { WorkerChannel } from "./worker-channel";

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

type Freshness = "new" | "reminder" | null;

/**
 * 코디네이터에게 (다시) 알려야 하는가. 처음이거나 새 계기(사람의 지시)가 알린 뒤에 왔으면 new,
 * 알린 지 RENOTIFY_AFTER_MS 가 지나도 처리되지 않았으면 reminder 다.
 * 알림 메시지는 코디네이터 세션이 다시 열리거나 턴이 끊기면 사라질 수 있다 (2026-11-25: 알림을 기록한 직후 세션을
 * 다시 열어 메시지가 사라졌고, 이미 알린 것으로 기록돼 요청이 planning 에 멈췄다).
 */
function freshness(notifiedAt: string | null, triggerAt: string | null | undefined, now: number): Freshness {
  if (!notifiedAt) return "new";
  if (triggerAt && triggerAt > notifiedAt) return "new";
  return now - Date.parse(notifiedAt) > RENOTIFY_AFTER_MS ? "reminder" : null;
}

interface DueItem {
  key: string;
  kind: "request" | "feedback" | "blocker" | "qa";
  requestId: string;
  taskNumber?: number;
  qaIndex?: number;
  freshness: Exclude<Freshness, null>;
}

/** 코디네이터가 처리해야 할 일. 코디네이터가 쉬고 있을 때만 부른다. */
function collectDue(state: CoordinatorState, now: number): DueItem[] {
  const items: DueItem[] = [];
  for (const request of state.requests) {
    const lastInstruction = request.feedback.at(-1)?.at;
    if (request.status === "planning") {
      const fresh = freshness(request.notifiedAt, lastInstruction, now);
      if (fresh) items.push({ key: `req:${request.id}`, kind: "request", requestId: request.id, freshness: fresh });
    }
    // 실행 중인 요청에 사람이 새 지시를 보냈다. 처리 여부를 알 수 없으니 새 지시가 왔을 때만 알린다.
    if (request.status === "running" && lastInstruction && (!request.notifiedAt || lastInstruction > request.notifiedAt)) {
      items.push({ key: `fb:${request.id}`, kind: "feedback", requestId: request.id, freshness: "new" });
    }
    if (request.status !== "running") continue;
    for (const task of request.tasks) {
      const blocker = task.blocker;
      // 결정 카드도 검토 중인 제안도 없는 보고만 코디네이터의 일이다.
      if (blocker && !blocker.coordinator && !blocker.proposal) {
        const fresh = freshness(blocker.notifiedAt, null, now);
        if (fresh) {
          items.push({ key: `blk:${request.id}:${task.number}:${blocker.at}`, kind: "blocker", requestId: request.id, taskNumber: task.number, freshness: fresh });
        }
      }
      // 워커 질문 카드와 머지 카드의 질문하기.
      cardQa(task).forEach((qa, index) => {
        if (qa.answer !== null) return;
        const fresh = freshness(qa.notifiedAt, null, now);
        if (fresh) {
          items.push({ key: `qa:${request.id}:${task.number}:${qa.at}`, kind: "qa", requestId: request.id, taskNumber: task.number, qaIndex: index, freshness: fresh });
        }
      });
    }
  }
  return items;
}

function describe(items: readonly DueItem[]): string {
  const ref = (item: DueItem) => (item.taskNumber ? `${item.requestId} task ${item.taskNumber}` : item.requestId);
  const of = (kind: DueItem["kind"]) => items.filter((item) => item.kind === kind).map(ref);
  const lines = ["[paseo-coordinator] Work waiting for you:"];
  const requests = of("request");
  if (requests.length) lines.push(`- Requests: ${requests.join(", ")}. Call coordinator_get_request, classify, then answer (coordinator_submit_answer), plan (coordinator_submit_plan), or ask the human (coordinator_ask_human).`);
  const blockers = of("blocker");
  if (blockers.length) lines.push(`- Worker blockers: ${blockers.join(", ")}. Read them with coordinator_get_request (and coordinator_read_worker if needed). If you can answer under W1, W5 or W7 with none of H1-H6, propose it with coordinator_propose_answer; otherwise write the decision card with coordinator_prepare_decision.`);
  const questions = of("qa");
  if (questions.length) lines.push(`- Human questions on decision or merge cards: ${questions.join(", ")}. Answer with coordinator_answer_question. For a merge card, the task's completion report and pull request are in coordinator_get_request, and coordinator_read_worker shows what the worker did.`);
  const feedback = of("feedback");
  if (feedback.length) lines.push(`- New instructions on running requests: ${feedback.join(", ")}. Read them with coordinator_get_request and pass what each affected worker must change with coordinator_message_worker, or ask the human if unclear.`);
  return lines.join("\n");
}

/**
 * 코디네이터 에이전트를 만들고 알리는 일을 맡는다. 같은 시각에 두 요청이 와도 에이전트가 하나만 생기도록
 * 만드는 작업을 promise 하나로 묶는다.
 */
export class CoordinatorRuntime {
  private workspaceCreating: Promise<string> | null = null;
  /** 요청마다 에이전트를 만드는 중인 promise. 같은 요청에 두 에이전트가 생기지 않게 한다. */
  private readonly agentCreating = new Map<string, Promise<string>>();
  private notifying = false;
  private again = false;
  /** 할 일마다 다시 알린 횟수. 플러그인 프로세스 동안만 센다. */
  private readonly renotified = new Map<string, number>();
  private reviews: ReviewRunner | null = null;

  /** 독립 검토를 붙인다. 검토자가 없으면 자동 답은 받지 않는다. */
  setReviewRunner(reviews: ReviewRunner): void {
    this.reviews = reviews;
  }

  constructor(
    private readonly store: StateStore,
    private readonly settings: Settings,
    /** 계획이 저장되어 시작된 직후 부른다. 배정기가 워커를 만든다. */
    private readonly onPlanStarted: (paseo: PaseoApi) => void,
    /** 코디네이터가 워커에게 지시를 보내는 길. */
    private readonly channel: WorkerChannel,
  ) {}

  /** 이 에이전트가 맡은 요청 id. 코디네이터가 아니면 null. */
  async requestOf(agentId: string): Promise<string | null> {
    return (await this.store.read()).requests.find((request) => request.coordinatorAgentId === agentId)?.id ?? null;
  }

  /** 코디네이터 워크스페이스. 하나만 만들고 계속 쓴다. */
  private async ensureWorkspace(paseo: PaseoApi, language: "en" | "ko"): Promise<string> {
    const existing = (await this.store.read()).coordinator?.workspaceId;
    if (existing) return existing;
    this.workspaceCreating ??= (async () => {
      const home = join(dataDirectory(), "coordinator");
      await mkdir(home, { recursive: true });
      await writeFile(
        join(home, "README.md"),
        "# Coordinator\n\nWorking folder of the paseo-coordinator plugin's coordinator agents. They plan requests and do not edit code here.\n",
        "utf8",
      );
      const workspace = await paseo.workspaces.create({
        source: { kind: "directory", path: home },
        title: language === "ko" ? "코디네이터" : "Coordinator",
      });
      await this.store.update((state) => ({ state: { ...state, coordinator: { workspaceId: workspace.id } }, result: undefined }));
      return workspace.id;
    })().finally(() => {
      this.workspaceCreating = null;
    });
    return this.workspaceCreating;
  }

  /** 요청을 맡을 코디네이터 에이전트. 없거나 archive 됐으면 새로 만든다. */
  private async agentFor(paseo: PaseoApi, request: CoordinatorRequest): Promise<string> {
    if (request.coordinatorAgentId) {
      const snapshot = await paseo.agents.ref(request.coordinatorAgentId).refresh().catch(() => null);
      if (snapshot && !snapshot.agent.archivedAt) return request.coordinatorAgentId;
    }
    const pending = this.agentCreating.get(request.id);
    if (pending) return pending;
    const creating = this.createAgent(paseo, request).finally(() => this.agentCreating.delete(request.id));
    this.agentCreating.set(request.id, creating);
    return creating;
  }

  private async createAgent(paseo: PaseoApi, request: CoordinatorRequest): Promise<string> {
    const values = await readSettings(this.settings);
    const provider = values.coordinator.model.split("/")[0]!;
    const modes = await paseo.providers.listModes(provider).catch(() => null);
    // 권한을 묻는 기본 모드로 띄운다. 코디네이터가 자기 도구 밖의 일을 하려 하면 사람에게 올라가야 한다.
    const modeId = modes?.modes?.some((mode) => mode.id === "default") ? "default" : undefined;
    const label = request.title ?? request.text.split("\n")[0]!.slice(0, 30);
    const create = async () => {
      const workspaceId = await this.ensureWorkspace(paseo, request.language);
      return paseo.workspaces.ref(workspaceId).agents.create({
        config: { provider: values.coordinator.model, modeId, thinkingOptionId: values.coordinator.effort },
        title: `${request.id} · ${label}`,
        labels: { [COORDINATOR_LABEL]: "coordinator", "paseo-coordinator.request": request.id },
      });
    };
    const agent = await create().catch(async (error) => {
      // 사람이 코디네이터 워크스페이스를 archive 했으면 새로 만들고 한 번 더 시도한다.
      console.error("[coordinator] could not create the coordinator agent; recreating the workspace", error);
      await this.store.update((state) => ({ state: { ...state, coordinator: null }, result: undefined }));
      return create();
    });
    await this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((item) => (item.id === request.id ? { ...item, coordinatorAgentId: agent.id } : item)),
      },
      result: undefined,
    }));
    console.log(`[coordinator] created coordinator agent ${agent.id} for ${request.id}`);
    return agent.id;
  }

  /** 끝나거나 취소된 요청의 코디네이터를 정리한다. 사이드바에 코디네이터가 쌓이지 않게 한다. */
  async retire(paseo: PaseoApi, requestId: string): Promise<void> {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    if (!request?.coordinatorAgentId) return;
    await paseo.agents.ref(request.coordinatorAgentId).archive().catch(() => undefined);
  }

  /**
   * 코디네이터에게 할 일을 알린다. 할 일을 요청별로 묶어 그 요청의 코디네이터에게 보낸다.
   * 코디네이터가 일하는 중이거나 권한을 기다리면 보내지 않는다 (보내면 진행 중인 턴이 끊기고 대기 중인 권한 요청이
   * 거절된다. RULES.md §13). 그 경우 그 코디네이터의 턴이 끝날 때 다시 부른다.
   */
  async notify(paseo: PaseoApi): Promise<void> {
    if (this.notifying) {
      this.again = true;
      return;
    }
    this.notifying = true;
    try {
      do {
        this.again = false;
        await this.notifyOnce(paseo);
      } while (this.again);
    } finally {
      this.notifying = false;
    }
  }

  private async notifyOnce(paseo: PaseoApi): Promise<void> {
    const due = collectDue(await this.store.read(), Date.now());
    const requestIds = [...new Set(due.map((item) => item.requestId))];
    for (const requestId of requestIds) {
      const request = (await this.store.read()).requests.find((item) => item.id === requestId);
      if (!request) continue;
      const agentId = await this.agentFor(paseo, request);
      const snapshot = await paseo.agents.ref(agentId).refresh();
      if (!snapshot) continue;
      if (snapshot.agent.status === "running" || (snapshot.agent.pendingPermissions?.length ?? 0) > 0) continue;
      // 여기까지 왔으면 이 요청의 코디네이터는 쉬고 있다. 유실을 의심해 다시 알리는 것만 세고, 3번을 넘으면 멈춘다.
      const items = collectDue(await this.store.read(), Date.now()).filter((item) => {
        if (item.requestId !== requestId) return false;
        if (item.freshness === "new") {
          this.renotified.delete(item.key);
          return true;
        }
        const count = this.renotified.get(item.key) ?? 0;
        if (count >= MAX_RENOTIFY) {
          console.error(`[coordinator] ${item.key} is still unhandled after ${count} reminders; not reminding again`);
          return false;
        }
        this.renotified.set(item.key, count + 1);
        return true;
      });
      if (items.length === 0) continue;
      await this.markNotified(items);
      await paseo.agents.ref(agentId).send(describe(items));
    }
  }

  private async markNotified(items: readonly DueItem[]): Promise<void> {
    const now = new Date().toISOString();
    await this.store.update((current) => ({
      state: {
        ...current,
        requests: current.requests.map((request) => {
          const mine = items.filter((item) => item.requestId === request.id);
          if (mine.length === 0) return request;
          const touchesRequest = mine.some((item) => item.kind === "request" || item.kind === "feedback");
          return {
            ...request,
            notifiedAt: touchesRequest ? now : request.notifiedAt,
            tasks: request.tasks.map((task) => {
              const forTask = mine.filter((item) => item.taskNumber === task.number);
              if (forTask.length === 0) return task;
              const marked = withCardQa(task, (qa) =>
                qa.map((entry, index) => (forTask.some((item) => item.kind === "qa" && item.qaIndex === index) ? { ...entry, notifiedAt: now } : entry)),
              );
              if (!marked.blocker || !forTask.some((item) => item.kind === "blocker")) return marked;
              return { ...marked, blocker: { ...marked.blocker, notifiedAt: now } };
            }),
          };
        }),
      },
      result: undefined,
    }));
  }

  /** 코디네이터가 남긴 프로젝트 id 중 허용된 것만 남긴다. 카드에 보일 이름용이라 틀린 id 로 실패시키지 않는다. */
  private async knownProjects(paseo: PaseoApi, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const allowed = new Set((await allowedProjects(paseo, this.settings)).map((project) => project.id));
    return ids.filter((id) => allowed.has(id));
  }

  /**
   * 요청마다 코디네이터가 따로 있으므로, 도구는 자기 요청에만 쓸 수 있게 막는다. 다른 요청을 건드리면 거부한다.
   * 프로젝트를 읽는 도구처럼 requestId 가 없는 도구는 그대로 둔다.
   */
  private owned(tool: AgentToolDefinition): AgentToolDefinition {
    return {
      ...tool,
      execute: async (input, context) => {
        const requestId = (input as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId === "string") {
          const owner = (await this.store.read()).requests.find((request) => request.id === requestId)?.coordinatorAgentId;
          if (owner && owner !== context.agent.id) {
            return { text: `Request ${requestId} belongs to another coordinator. Work only on your own request.`, isError: true };
          }
        }
        return tool.execute(input, context);
      },
    };
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
      this.readWorkerTool(),
      this.proposeAnswerTool(),
      this.prepareDecisionTool(),
      this.answerQuestionTool(),
      this.messageWorkerTool(),
    ].map((tool) => this.owned(tool));
  }

  private async findTask(requestId: string, taskNumber: number) {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    const task = request?.tasks.find((item) => item.number === taskNumber);
    return request && task ? { request, task } : null;
  }

  private patchTask(requestId: string, taskNumber: number, change: (task: Task) => Task): Promise<void> {
    return this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id === requestId
            ? { ...request, tasks: request.tasks.map((task) => (task.number === taskNumber ? change(task) : task)) }
            : request,
        ),
      },
      result: undefined,
    }));
  }

  /** 워커의 최근 보고를 읽는다. 결정 카드에 쓸 맥락이 워커의 말에만 있을 때 쓴다. */
  private readWorkerTool() {
    return defineAgentTool({
      name: "coordinator_read_worker",
      title: "Read worker messages",
      description: "Read the latest assistant messages of a task's worker.",
      input: z.object({ requestId: z.string(), taskNumber: z.number().int().positive(), limit: z.number().int().min(1).max(10).default(3) }),
      execute: async ({ requestId, taskNumber, limit }, { paseo }) => {
        const found = await this.findTask(requestId, taskNumber);
        if (!found?.task.agentId) return { text: `Task ${requestId}/${taskNumber} has no worker.`, isError: true };
        const page = await paseo.agents.ref(found.task.agentId).timeline.refetch({ direction: "tail", limit: 60 }).catch(() => null);
        const entries = (page as { entries?: readonly { item?: { type?: string; text?: string } }[] } | null)?.entries ?? [];
        const messages = entries
          .map((entry) => entry.item)
          .filter((item) => item?.type === "assistant_message" && item.text?.trim())
          .slice(-limit)
          .map((item) => item!.text!.trim());
        return { text: messages.length ? messages.join("\n\n---\n\n") : "(no messages yet)" };
      },
    });
  }

  /**
   * 워커 질문에 코디네이터가 W 규칙으로 답하려는 제안. 기계 사전 검사를 통과하면 독립 검토로 보내고,
   * 검토자 전원이 통과시키면 플러그인이 워커에게 보낸다. 아니면 사람 카드가 된다 (RULES.md §5, §7).
   */
  private proposeAnswerTool() {
    return defineAgentTool({
      name: "coordinator_propose_answer",
      title: "Propose an automatic answer",
      description:
        "Answer a worker's blocker yourself when it fits W1 (the answer is written in the request, plan or an earlier human decision: quote it), W5 (an implementation detail inside the task's scope that follows the repository's conventions: cite them) or W7 (a change of scope or approach that stays inside the original request), and none of H1-H6 apply. Independent reviewers check it before it reaches the worker; if any does not pass, it becomes the human's decision card. Use coordinator_prepare_decision instead when it does not fit.",
      input: z.object({
        requestId: z.string(),
        taskNumber: z.number().int().positive(),
        rule: z.enum(AUTO_RULES),
        answer: z.string().trim().min(1),
        evidence: z.array(z.object({ fact: z.string().trim().min(1), source: z.string().trim().min(1) })).min(1),
        undo: z.string().trim().min(1),
        selfCheck: z.array(z.string().trim().min(1)).min(6),
      }),
      execute: async (input, { paseo }) => {
        if (!this.reviews) return { text: "Automatic answers are not available; use coordinator_prepare_decision.", isError: true };
        const state = await this.store.read();
        const request = state.requests.find((item) => item.id === input.requestId);
        const task = request?.tasks.find((item) => item.number === input.taskNumber);
        const blocker = task?.blocker;
        if (!request || !task || !blocker) return { text: `Task ${input.requestId}/${input.taskNumber} has no open blocker.`, isError: true };
        if (blocker.coordinator || blocker.proposal) {
          return { text: "This blocker already has a decision card or a proposal under review.", isError: true };
        }
        const reason = this.reviews.precheck(state, request, task, input.rule);
        if (reason) {
          return { text: `Not eligible for an automatic answer: ${reason} Write the decision card with coordinator_prepare_decision.`, isError: true };
        }
        await this.reviews.start(paseo, input.requestId, input.taskNumber, {
          rule: input.rule,
          answer: input.answer,
          evidence: input.evidence,
          undo: input.undo,
          selfCheck: input.selfCheck,
          at: new Date().toISOString(),
        });
        return {
          text: "Sent to independent reviewers. If all pass, the plugin sends your answer to the worker; otherwise it becomes the human's decision card. Nothing more to do for this blocker.",
        };
      },
    });
  }

  /**
   * 워커의 보고로 결정 카드를 쓴다. 사람은 이 카드를 보고 고른다.
   * 6단계(독립 검토) 전에는 코디네이터가 워커에게 직접 답하지 않는다. 검토자 규칙(RULES.md §5)을 지키기 위해서다.
   */
  private prepareDecisionTool() {
    return defineAgentTool({
      name: "coordinator_prepare_decision",
      title: "Prepare decision card",
      description:
        "Write the decision card for a worker's blocker. Give the context the human needs, 2+ options each with its result, risk, how to undo it, and the exact instruction the worker will receive if chosen, your recommended option, your reasons, and the RULES ids that apply (for example H1, H4, W5). The human decides; you do not answer the worker yourself.",
      input: z.object({
        requestId: z.string(),
        taskNumber: z.number().int().positive(),
        context: z.string().trim().min(1),
        options: z
          .array(
            z.object({
              label: z.string().trim().min(1),
              result: z.string().trim().min(1),
              risk: z.string().trim().min(1),
              undo: z.string().trim().min(1),
              instruction: z.string().trim().min(1),
            }),
          )
          .min(1)
          .max(4),
        recommended: z.string().nullable().default(null),
        reasons: z.array(z.string().trim().min(1)).min(1),
        rules: z.array(z.string()).default([]),
      }),
      execute: async (input) => {
        const found = await this.findTask(input.requestId, input.taskNumber);
        if (!found?.task.blocker) return { text: `Task ${input.requestId}/${input.taskNumber} has no open blocker.`, isError: true };
        if (input.recommended && !input.options.some((option) => option.label === input.recommended)) {
          return { text: `recommended "${input.recommended}" is not one of the option labels.`, isError: true };
        }
        const at = new Date().toISOString();
        await this.patchTask(input.requestId, input.taskNumber, (task) => ({
          ...task,
          blocker: task.blocker
            ? {
                ...task.blocker,
                coordinator: {
                  context: input.context,
                  options: input.options,
                  recommended: input.recommended,
                  reasons: input.reasons,
                  rules: input.rules,
                  at,
                },
              }
            : task.blocker,
        }));
        return { text: "Decision card stored. The human decides in the inbox; the plugin sends the choice to the worker." };
      },
    });
  }

  /** 사람이 결정 카드에서 물은 것에 답한다. 답은 카드의 문답에 쌓인다. */
  private answerQuestionTool() {
    return defineAgentTool({
      name: "coordinator_answer_question",
      title: "Answer the human's question",
      description: "Answer the oldest unanswered question the human asked on a task's decision card or merge card. Base it on facts you can cite.",
      input: z.object({ requestId: z.string(), taskNumber: z.number().int().positive(), answer: z.string().trim().min(1) }),
      execute: async (input) => {
        const found = await this.findTask(input.requestId, input.taskNumber);
        const index = found ? cardQa(found.task).findIndex((qa) => qa.answer === null) : -1;
        if (index < 0) return { text: "There is no unanswered question on this card.", isError: true };
        const at = new Date().toISOString();
        await this.patchTask(input.requestId, input.taskNumber, (task) =>
          withCardQa(task, (qa) => qa.map((entry, i) => (i === index ? { ...entry, answer: input.answer, answeredAt: at } : entry))),
        );
        return { text: "Answer added to the card." };
      },
    });
  }

  /**
   * 워커에게 지시를 보낸다. 실행 중인 요청에 사람이 새 지시를 보냈을 때 쓴다. 워커가 일하는 중이면 턴이 끝난 뒤에 간다.
   * 원래 요청을 벗어나는 지시는 보내지 않고 사람에게 묻는다 (RULES.md H1).
   */
  private messageWorkerTool() {
    return defineAgentTool({
      name: "coordinator_message_worker",
      title: "Message a worker",
      description:
        "Send an instruction to a task's worker, for example to pass on a new instruction the human gave on a running request. It is delivered now if the worker is idle, or after its current turn.",
      input: z.object({ requestId: z.string(), taskNumber: z.number().int().positive(), message: z.string().trim().min(1) }),
      execute: async (input, { paseo }) => {
        const found = await this.findTask(input.requestId, input.taskNumber);
        if (!found?.task.agentId) return { text: `Task ${input.requestId}/${input.taskNumber} has no worker yet.`, isError: true };
        const result = await this.channel.deliver(
          paseo,
          input.requestId,
          input.taskNumber,
          `[From the coordinator] ${input.message}`,
        );
        const at = new Date().toISOString();
        await this.patchTask(input.requestId, input.taskNumber, (task) => ({
          ...task,
          status: task.status === "review" || task.status === "done" ? ("running" as const) : task.status,
          decisions: [...task.decisions, { summary: `Coordinator → worker: ${input.message}`, by: "coordinator" as const, at, qa: [] }],
        }));
        return { text: result === "sent" ? "Delivered to the worker." : "The worker is busy; it will receive this after its current turn." };
      },
    });
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
                      blocker: null,
                      outbox: [],
                      decisions: [],
                      autoDecisions: [],
                      poteto: false,
                      completion: null,
                      doneNudgedAt: null,
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
