/// <reference types="node" />

import { mkdir, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { PaseoApi } from "./paseo-api";
import type { PluginSettings } from "@getpaseo/plugin/server";
import { type AgentToolDefinition, defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  AUTO_RULES,
  type CoordinatorRequest,
  type CoordinatorState,
  GRADES,
  type Task,
  cardQa,
  decisionBasisAt,
  dependentsOf,
  hasLiveTasks,
  hasStarted,
  humanAnsweredSince,
  unreadInstructionAt,
  withCardQa,
} from "../shared/model";
import { cleanupTaskWorkspaces } from "./cleanup";
import { cancelTasksIn } from "./requests";
import type { settingsSchema } from "../shared/settings";
import { type StateStore, dataDirectory } from "./store";
import type { ReviewRunner } from "./review";
import { type WorkerChannel, queued } from "./worker-channel";
import { preapprovedOptions } from "./preapprove";
import { listBranches, listTreeAt, readBlobAt, resolveBaseRef, treePath } from "./branches";
import { uncommittedChanges } from "./completion";
import { listExistingWorkspaces, pluginWorkspaceIds, readCheckout, workspaceProblem } from "./existing-workspace";

type Settings = PluginSettings<typeof settingsSchema>;

const HANGUL = /[가-힣]/;
const MAX_WORKSPACE_TITLE = 40;
const OVERVIEW_LIMIT = 4000;
const READ_LIMIT = 24_000;
const LIST_LIMIT = 200;

// RULES.md H2 의 비밀 파일. 코디네이터 읽기 도구로도 읽지 않는다.
// .git 아래(원격 URL 에 토큰이 든 config 등)와 흔한 비밀·자격 파일 이름도 막는다.
const SECRET_FILE =
  /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore|tfvars|tfstate)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.dev\.vars|secrets?\..*|service-account.*\.json)$/i;

function isSecretPath(root: string, target: string): boolean {
  const parts = relative(root, target).split(sep);
  return parts.includes(".git") || SECRET_FILE.test(basename(target));
}

/** 파일 앞부분만 읽는다. 큰 파일을 통째로 메모리에 올리지 않고, NUL 바이트가 있으면 바이너리로 본다. */
async function readHead(path: string, size: number): Promise<{ text: string; truncated: boolean } | "binary" | null> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return null;
  try {
    // UTF-8 한 글자는 최대 4바이트라, 글자 수 상한의 4배까지 읽으면 상한만큼 글자를 채울 수 있다.
    const buffer = Buffer.alloc(Math.min(size, READ_LIMIT * 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return "binary";
    const text = bytes.toString("utf8");
    return { text: text.slice(0, READ_LIMIT), truncated: size > bytesRead || text.length > READ_LIMIT };
  } finally {
    await handle.close();
  }
}

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
const MAX_FAILURES = 3;

/**
 * 코디네이터의 권한 요청에 답한다. 코디네이터 전용 도구는 허용하고, 그 밖은 거절한다. 코디네이터는 사람 화면에 보이지 않아서
 * 그 권한 요청은 아무도 볼 수 없는 곳에서 요청을 멈춰 세웠다 (2026-11-26 전수 검사). 권한 hook 과 알림이 같이 쓴다.
 */
export async function answerCoordinatorPermission(
  paseo: PaseoApi,
  agentId: string,
  permission: { id: string; kind: string; name: string },
): Promise<void> {
  const allowed = permission.kind === "tool" && permission.name.includes(COORDINATOR_TOOL_PREFIX);
  await paseo.agents
    .ref(agentId)
    .respondToPermission({
      requestId: permission.id,
      response: allowed
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Coordinators use only the coordinator_* tools. Continue with those, or ask the human with coordinator_ask_human." },
    })
    .catch((error: unknown) => console.error(`[coordinator] could not answer the coordinator permission ${permission.id}`, error));
}

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
  kind: "request" | "investigated" | "feedback" | "blocker" | "qa";
  requestId: string;
  taskNumber?: number;
  qaIndex?: number;
  freshness: Exclude<Freshness, null>;
}

/** 코디네이터가 처리해야 할 일. 코디네이터가 쉬고 있을 때만 부른다. */
function collectDue(state: CoordinatorState, now: number): DueItem[] {
  const items: DueItem[] = [];
  for (const request of state.requests) {
    // 멈춘 코디네이터에게는 다시 알리지 않는다. 사람이 '다시 시도'를 누르면 멈춤 기록이 지워지고 다시 알린다.
    if (request.stall) continue;
    const lastInstruction = request.feedback.at(-1)?.at;
    if (request.status === "planning") {
      // A 등급 변경 전 조사가 끝나 돌아온 요청은 사람의 새 지시가 없어도 다시 알린다. 조사 뒤에 지시가 왔으면 지시가 먼저다.
      const investigatedAt = request.investigation?.at;
      const investigated = Boolean(investigatedAt && (!lastInstruction || investigatedAt > lastInstruction));
      const fresh = freshness(request.notifiedAt, investigated ? investigatedAt : lastInstruction, now);
      if (fresh) {
        items.push({ key: `req:${request.id}`, kind: investigated ? "investigated" : "request", requestId: request.id, freshness: fresh });
      }
    }
    // 실행 중인 요청에 사람이 새 지시(또는 질문의 답)를 보냈다. 코디네이터가 그 뒤에 요청을 읽었으면 처리한 것으로 본다.
    // 읽지 않았으면 알림이 유실됐을 수 있어 다시 알린다 (예전에는 새 지시가 왔을 때 한 번만 알려, 유실되면 지시가 버려졌다).
    const unread = unreadInstructionAt(request);
    if (request.status === "running" && unread) {
      const fresh = freshness(request.notifiedAt, unread, now);
      if (fresh) items.push({ key: `fb:${request.id}:${unread}`, kind: "feedback", requestId: request.id, freshness: fresh });
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
  const investigated = of("investigated");
  if (investigated.length) lines.push(`- Investigations came back to you: ${investigated.join(", ")}. Read the report in "investigation" and any later feedback with coordinator_get_request. If the request was marked beforeChange, the human asked for a change: do not end with a report. For grade A or operation tasks, ask the human with coordinator_ask_human which changes to make (each item with what it changes, the evidence, the risk and your recommendation; one option may be to change nothing), then plan exactly what they chose; for grades B-D you may plan the change directly. If it was a read request that came back because the human wrote while it ran: when they asked you to act, plan that change; when they only asked a question, answer with coordinator_submit_answer.`);
  const blockers = of("blocker");
  if (blockers.length) lines.push(`- Worker blockers: ${blockers.join(", ")}. Read them with coordinator_get_request (and coordinator_read_worker if needed). If you can answer under W1, W5 or W7 with none of H1-H6, propose it with coordinator_propose_answer; otherwise write the decision card with coordinator_prepare_decision.`);
  const questions = of("qa");
  if (questions.length) lines.push(`- Human questions on decision or merge cards: ${questions.join(", ")}. Answer with coordinator_answer_question. For a merge card, the task's completion report and pull request are in coordinator_get_request, and coordinator_read_worker shows what the worker did.`);
  const feedback = of("feedback");
  if (feedback.length) lines.push(`- New instructions or answers on running requests: ${feedback.join(", ")}. Read them with coordinator_get_request. Pass what a working worker must change with coordinator_message_worker, add work with coordinator_add_tasks, drop work with coordinator_cancel_tasks, or ask the human if it is unclear or goes beyond the original request. On a read request still investigating, a request to act is handled when the investigation comes back to you.`);
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
  /** 요청마다 연달아 알리지 못한 횟수. MAX_FAILURES 에 닿으면 멈춤으로 기록한다. */
  private readonly failures = new Map<string, number>();
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
    /** 코디네이터가 작업을 취소한 뒤 부른다. 워커를 정리하고 요청을 마무리한다 (Dispatcher.afterCancel). */
    private readonly onTasksCanceled: (paseo: PaseoApi, requestId: string, agentIds: string[], requestCanceled: boolean) => void = () => {},
  ) {}

  /**
   * 코디네이터가 일을 이어 가지 못한다고 기록한다. 내 결정 필요에 카드로 보이고, 사람이 다시 시도할 때까지 알리지 않는다.
   * 코디네이터는 사람 화면에 보이지 않는 에이전트라 기록하지 않으면 보드에 '계획 세우는 중'만 계속 보인다.
   */
  private async markStalled(requestId: string, reason: string): Promise<void> {
    console.error(`[coordinator] ${requestId} stalled: ${reason}`);
    await this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((item) =>
          item.id === requestId && item.status !== "done" && item.status !== "canceled"
            ? { ...item, stall: { reason, at: new Date().toISOString() } }
            : item,
        ),
      },
      result: undefined,
    }));
  }

  /** 사람이 멈춘 코디네이터를 다시 시도한다. 멈춤 기록과 다시 알린 횟수를 지우고 알린다. */
  async retry(paseo: PaseoApi, requestId: string): Promise<void> {
    // 키는 '<종류>:<요청 id>[:…]' 이다. r1 을 지울 때 r12 까지 지우지 않게 자리로 비교한다.
    for (const key of [...this.renotified.keys()]) if (key.split(":")[1] === requestId) this.renotified.delete(key);
    await this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((item) => (item.id === requestId ? { ...item, stall: null, notifiedAt: null } : item)),
      },
      result: undefined,
    }));
    await this.notify(paseo);
  }

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
      // refresh 는 에이전트가 없으면 null 을 준다. 예외는 일시 오류라 그대로 던진다. 삼키면 코디네이터가 하나 더 생긴다.
      const snapshot = await paseo.agents.ref(request.coordinatorAgentId).refresh();
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
        config: {
          provider: values.coordinator.model,
          modeId,
          thinkingOptionId: values.coordinator.effort,
          options: preapprovedOptions(values.coordinator.model, this.tools().map((tool) => tool.name)),
        },
        title: `${request.id} · ${label}`,
        labels: { [COORDINATOR_LABEL]: "coordinator", "paseo-coordinator.request": request.id },
      });
    };
    const agent = await create().catch(async (error: unknown) => {
      // 사람이 코디네이터 워크스페이스를 archive 했을 때만 새로 만들고 한 번 더 시도한다. 모델 설정 오류처럼 다른 이유로
      // 실패할 때 워크스페이스를 새로 만들면, 알릴 때마다 워크스페이스가 하나씩 늘어난다.
      const workspaceId = (await this.store.read()).coordinator?.workspaceId;
      const listed = await paseo.workspaces.list().catch(() => null);
      if (!listed || (workspaceId && listed.entries.some((entry) => entry.id === workspaceId))) throw error;
      console.error("[coordinator] the coordinator workspace is gone; recreating it", error);
      await this.store.update((state) => ({
        state: state.coordinator?.workspaceId === workspaceId ? { ...state, coordinator: null } : state,
        result: undefined,
      }));
      return create();
    });
    // 만드는 사이에 요청이 끝났거나 취소됐으면 저장하지 않고 정리한다. 저장하면 retire 가 놓친 코디네이터가 남는다.
    const stillOpen = await this.store.update((state) => {
      const current = state.requests.find((item) => item.id === request.id);
      if (!current || current.status === "done" || current.status === "canceled") return { state, result: false };
      return {
        state: {
          ...state,
          requests: state.requests.map((item) => (item.id === request.id ? { ...item, coordinatorAgentId: agent.id } : item)),
        },
        result: true,
      };
    });
    if (!stillOpen) {
      await paseo.agents.ref(agent.id).archive().catch(() => undefined);
      throw new Error(`Request ${request.id} ended while its coordinator was being created.`);
    }
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
      // 한 요청의 실패(코디네이터 생성 실패 등)가 다른 요청의 알림을 막지 않게 요청마다 따로 처리한다.
      // 일시 오류 한 번으로 멈춤을 기록하지 않는다. 멈춘 요청은 알림을 모두 건너뛰므로, 짧은 연결 오류가 사람이 누를 때까지
      // 요청을 세웠다 (2026-11-26 최종 검사). 연달아 실패할 때만 멈춤으로 본다.
      await this.notifyRequest(paseo, requestId).then(
        () => this.failures.delete(requestId),
        async (error: unknown) => {
          console.error(`[coordinator] could not notify the coordinator of ${requestId}`, error);
          const count = (this.failures.get(requestId) ?? 0) + 1;
          this.failures.set(requestId, count);
          if (count >= MAX_FAILURES) {
            this.failures.delete(requestId);
            await this.markStalled(requestId, `Could not start or reach the coordinator ${count} times in a row: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      );
    }
  }

  private async notifyRequest(paseo: PaseoApi, requestId: string): Promise<void> {
    {
      const request = (await this.store.read()).requests.find((item) => item.id === requestId);
      if (!request) return;
      const agentId = await this.agentFor(paseo, request);
      const snapshot = await paseo.agents.ref(agentId).refresh();
      if (!snapshot) return;
      // 에러로 끝난 코디네이터도 새 메시지를 받으면 다시 일한다. 보내지 않고 멈춤으로 두면 '다시 시도'도 같은 이유로 다시 멈췄다
      // (2026-11-26 최종 검사). 다시 알려도 처리하지 않으면 아래의 다시 알리기 한도가 멈춤으로 기록한다.
      const pending = snapshot.agent.pendingPermissions ?? [];
      if (pending.length > 0) {
        // 권한 hook 이 유실돼 코디네이터가 기다리고 있다. hook 과 같은 규칙으로 답한다: 코디네이터 도구는 허용, 그 밖은 거절.
        for (const permission of pending) await answerCoordinatorPermission(paseo, agentId, permission);
        return;
      }
      if (snapshot.agent.status === "running") return;
      // 여기까지 왔으면 이 요청의 코디네이터는 쉬고 있다. 유실을 의심해 다시 알리는 것만 세고, 3번을 넘으면 멈춘다.
      const gaveUp: string[] = [];
      const items = collectDue(await this.store.read(), Date.now()).filter((item) => {
        if (item.requestId !== requestId) return false;
        if (item.freshness === "new") {
          this.renotified.delete(item.key);
          return true;
        }
        const count = this.renotified.get(item.key) ?? 0;
        if (count >= MAX_RENOTIFY) {
          gaveUp.push(item.key);
          return false;
        }
        this.renotified.set(item.key, count + 1);
        return true;
      });
      if (gaveUp.length > 0) {
        // 에러로 끝난 코디네이터면 그 에러를 함께 보여 준다. 사람이 원인(모델 설정 등)을 바로 알 수 있게 한다.
        const error = snapshot.agent.status === "error" && snapshot.agent.lastError ? ` Last error: ${snapshot.agent.lastError}` : "";
        await this.markStalled(requestId, `The coordinator did not handle ${gaveUp.join(", ")} after ${MAX_RENOTIFY} reminders.${error}`);
        return;
      }
      if (items.length === 0) return;
      // 보낸 뒤에 기록한다. 먼저 기록하고 보내기가 실패하면, 실행 중 요청의 새 지시처럼 다시 알리지 않는 항목이 묻힌다.
      // 시각은 보내기 전에 잡는다. 보내는 사이 새로 온 지시는 이 시각보다 늦어 다음에 다시 알린다.
      const at = new Date().toISOString();
      await paseo.agents.ref(agentId).send(describe(items));
      await this.markNotified(items, at);
    }
  }

  private async markNotified(items: readonly DueItem[], now: string): Promise<void> {
    await this.store.update((current) => ({
      state: {
        ...current,
        requests: current.requests.map((request) => {
          const mine = items.filter((item) => item.requestId === request.id);
          if (mine.length === 0) return request;
          const touchesRequest = mine.some((item) => item.kind === "request" || item.kind === "investigated" || item.kind === "feedback");
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
      this.readPastRequestTool(),
      this.addTasksTool(),
      this.cancelTasksTool(),
      this.projectOverviewTool(),
      this.listFilesTool(),
      this.readFileTool(),
      this.listBranchesTool(),
      this.listWorkspacesTool(),
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
        if (!(await readSettings(this.settings)).autoDecisions) {
          return { text: "The human switched automatic answers off in settings (RULES.md §8). Write the decision card with coordinator_prepare_decision.", isError: true };
        }
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
        // 머지했거나 끝난 작업의 워커는 정리됐다. 되살리면 요청이 끝나지 않는다. 새 작업이 필요하면 작업을 더하거나 사람에게 묻는다.
        if (found.task.status === "done" || found.task.completion?.closedAt) {
          return { text: `Task ${input.requestId}/${input.taskNumber} is finished and its workspace may be gone. Add a task with coordinator_add_tasks, or ask the human.`, isError: true };
        }
        if (found.task.status === "canceled") {
          return { text: `Task ${input.requestId}/${input.taskNumber} was canceled and its worker stopped.`, isError: true };
        }
        if (found.request.kind === "read") {
          return {
            text: "This is a read-only investigation; its worker cannot act on instructions. When the investigation comes back to you, plan what the human asked.",
            isError: true,
          };
        }
        const at = new Date().toISOString();
        await this.patchTask(input.requestId, input.taskNumber, (task) =>
          queued(
            {
              ...task,
              // 머지 카드를 기다리던 작업이면 다시 실행 중으로 돌리고 예전 완료 보고를 지운다. 워커가 다시 report_done 을 부른다.
              ...(task.status === "review" ? { status: "running" as const, completion: null, doneNudgedAt: null } : {}),
              decisions: [...task.decisions, { summary: `Coordinator → worker: ${input.message}`, by: "coordinator" as const, at, qa: [] }],
            },
            `[From the coordinator] ${input.message}`,
          ),
        );
        const sent = await this.channel.flush(paseo, input.requestId, input.taskNumber);
        if (sent) return { text: "Delivered to the worker." };
        // 결정 카드가 열린 작업에는 보내지 않는다(WorkerChannel.flush). 사람이 결정하면 그 결정과 함께 간다.
        return {
          text: found.task.blocker
            ? "The worker is waiting for the human's decision card; this message goes out together with that decision."
            : "The worker is busy; it will receive this after its current turn.",
        };
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
      description:
        "List files and folders in a directory of an allowed project. path is relative to the project root; use \".\" for the root. Without branch it reads the project folder as it is on disk; with branch it reads what is committed on that branch.",
      input: z.object({ projectId: z.string(), path: z.string().default("."), branch: z.string().trim().min(1).optional() }),
      execute: async ({ projectId, path, branch }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        if (branch) {
          const base = await resolveBaseRef(project.path, branch);
          if (!base) return { text: `Branch ${branch} does not exist in ${project.name}.`, isError: true };
          const inTree = treePath(path);
          const names = inTree === null ? null : await listTreeAt(project.path, base.refName, inTree).catch(() => null);
          if (!names) return { text: `${path} is not a directory on ${branch}.`, isError: true };
          const shown = names.filter((name) => name !== "node_modules/").sort().slice(0, LIST_LIMIT);
          return { text: shown.join("\n") + (names.length > shown.length ? `\n… ${names.length - shown.length} more` : "") };
        }
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

  /** 요청 대상 기능이 아직 기본 브랜치에 없는 브랜치에만 있는지 보려고 쓴다. 브랜치 이름과 worktree 경로만 읽는다. */
  private listBranchesTool() {
    return defineAgentTool({
      name: "coordinator_list_branches",
      title: "List project branches",
      description:
        "List an allowed project's recent branches (local and origin), the worktree each is checked out in (including worktrees made outside Paseo), the remote default branch, and the base branch configured in settings.",
      input: z.object({ projectId: z.string() }),
      execute: async ({ projectId }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        const list = await listBranches(project.path).catch(() => null);
        if (!list) return { text: `Could not read the branches of ${project.name}.`, isError: true };
        const configured = (await readSettings(this.settings)).baseBranches[projectId] ?? null;
        return {
          text: [
            `Remote default branch: ${list.defaultBranch ?? "(unknown)"}`,
            `Base branch in settings: ${configured ?? "(none; the remote default branch is used)"}`,
            "Branches, most recently committed first:",
            ...list.branches.map(
              (branch) =>
                `- ${branch.name} [${[branch.local ? "local" : null, branch.remote ? "origin" : "local only"].filter(Boolean).join(", ")}] ${branch.updatedAt}${branch.worktree ? ` worktree: ${branch.worktree}` : ""}`,
            ),
          ].join("\n"),
        };
      },
    });
  }

  /**
   * 사람이 이미 쓰는 워크스페이스를 찾는다. 요청이 그 워크스페이스의 일(아직 머지되지 않은 로컬 브랜치의 기능, 그 worktree 에서
   * 앱 실행)이면 새 worktree 대신 거기서 일하도록 계획한다 (작업의 workspaceId). 이 도구는 읽기만 한다.
   */
  private listWorkspacesTool() {
    return defineAgentTool({
      name: "coordinator_list_workspaces",
      title: "List project workspaces",
      description:
        "List the open Paseo workspaces of an allowed project: id, name, directory, checked-out branch, uncommitted changes and agents working there. Use it to plan a task in the human's existing workspace (workspaceId) instead of a new worktree.",
      input: z.object({ projectId: z.string() }),
      execute: async ({ projectId }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        const [workspaces, state, agents] = await Promise.all([
          listExistingWorkspaces(paseo, projectId).catch(() => null),
          this.store.read(),
          paseo.agents.list({ filter: { statuses: ["running", "initializing"] }, page: { limit: 200 } }).catch(() => null),
        ]);
        if (!workspaces) return { text: `Could not list the workspaces of ${project.name}.`, isError: true };
        const pluginIds = pluginWorkspaceIds(state);
        const lines = await Promise.all(
          workspaces
            .filter((workspace) => workspace.projectId === projectId)
            .map(async (workspace) => {
              const problem = workspaceProblem(workspace, workspace.id, projectId, pluginIds);
              const checkout = problem ? null : await readCheckout(workspace.directory).catch(() => null);
              const dirty = problem ? false : await uncommittedChanges(workspace.directory).then(Boolean, () => false);
              const working =
                agents?.entries.filter(
                  (entry) => !entry.agent.archivedAt && (entry.agent.workspaceId === workspace.id || entry.agent.cwd === workspace.directory),
                ).length ?? 0;
              const notes = [
                problem ? `not usable: ${problem}` : null,
                !problem && !checkout?.branch ? "detached HEAD, not usable" : null,
                dirty ? "uncommitted changes" : null,
                working ? `${working} agent(s) working` : null,
              ].filter(Boolean);
              return `- ${workspace.id} "${workspace.name}" directory: ${workspace.directory}${checkout?.branch ? ` branch: ${checkout.branch}` : ""}${notes.length ? ` [${notes.join("; ")}]` : ""}`;
            }),
        );
        return { text: lines.length ? ["Open workspaces:", ...lines].join("\n") : `No open workspaces in ${project.name}.` };
      },
    });
  }

  private readFileTool() {
    return defineAgentTool({
      name: "coordinator_read_file",
      title: "Read project file",
      description: `Read a text file in an allowed project. path is relative to the project root. Without branch it reads the file on disk; with branch it reads the version committed on that branch. Returns at most ${READ_LIMIT} characters; secrets such as .env files are refused.`,
      input: z.object({ projectId: z.string(), path: z.string().min(1), branch: z.string().trim().min(1).optional() }),
      execute: async ({ projectId, path, branch }, { paseo }) => {
        const project = (await allowedProjects(paseo, this.settings)).find((item) => item.id === projectId);
        if (!project) return { text: `Project ${projectId} is not allowed in coordinator settings.`, isError: true };
        if (branch) {
          const base = await resolveBaseRef(project.path, branch);
          if (!base) return { text: `Branch ${branch} does not exist in ${project.name}.`, isError: true };
          const inTree = treePath(path);
          if (!inTree) return { text: `${path} is not a path inside ${project.name}.`, isError: true };
          if (inTree.split("/").includes(".git") || SECRET_FILE.test(inTree.split("/").at(-1)!)) {
            return { text: `${path} may hold secrets and is not readable.`, isError: true };
          }
          const blob = await readBlobAt(project.path, base.refName, inTree, READ_LIMIT * 16).catch(() => null);
          if (blob === null) return { text: `${path} is not a file on ${branch}.`, isError: true };
          if (blob === "too-large") return { text: `${path} on ${branch} is too large to read.`, isError: true };
          if (blob.includes("\0")) return { text: `${path} looks like a binary file.`, isError: true };
          return { text: blob.length > READ_LIMIT ? `${blob.slice(0, READ_LIMIT)}\n… truncated` : blob };
        }
        const target = await resolveInside(project.path, path);
        if (!target) return { text: `${path} is not inside project ${project.name}.`, isError: true };
        if (isSecretPath(await realpath(project.path), target)) return { text: `${path} may hold secrets and is not readable.`, isError: true };
        const info = await stat(target).catch(() => null);
        if (!info?.isFile()) return { text: `${path} is not a file.`, isError: true };
        const head = await readHead(target, info.size);
        if (head === null) return { text: `${path} could not be read.`, isError: true };
        if (head === "binary") return { text: `${path} looks like a binary file.`, isError: true };
        return { text: head.truncated ? `${head.text}\n… truncated (${info.size} bytes total)` : head.text };
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
        // 코디네이터가 읽었다는 기록. 실행 중 요청에 온 지시를 처리했는지 이것으로 본다 (collectDue).
        // 코디네이터가 다시 일하므로 멈춤 기록도 지운다.
        const readAt = new Date().toISOString();
        await this.store.update((state) => ({
          state: {
            ...state,
            requests: state.requests.map((item) => (item.id === requestId ? { ...item, coordinatorReadAt: readAt, stall: null } : item)),
          },
          result: undefined,
        }));
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
              currentPlan: request.tasks.length > 0 ? { title: request.title, grade: request.grade, beforeChange: request.beforeChange, tasks: request.tasks } : null,
              // A 등급 변경 전 조사의 보고. 이것으로 질문 카드를 만든다.
              investigation: request.investigation,
              // 읽기 요청에 이미 준 답. 그 뒤의 feedback 은 이 답에 대한 추가 질문이나 지시다.
              previousAnswer: request.answer,
              projects: usable,
              // 사람이 고른 기준 브랜치. 있으면 그 프로젝트 작업은 이 브랜치에서 시작하고, 계획에서 바꿀 수 없다.
              humanBaseBranches: request.baseBranches,
              // 사람이 고른 기존 워크스페이스(projectId → workspaceId). 그 프로젝트 작업은 모두 이 워크스페이스에서 일한다.
              humanWorkspaces: request.workspaces,
            },
            null,
            2,
          ),
        };
      },
    });
  }

  /**
   * 끝났거나 다른 코디네이터가 맡은 이전 요청을 읽기만 한다. 사람이 'r13 결과를 토대로' 처럼 이전 요청을 가리키면 그 답과
   * 조사 보고가 필요하다. 이 도구가 없을 때 r14·r15 는 r13 을 읽지 못해 같은 조사를 처음부터 다시 했다 (2026-11-26).
   * 바꾸는 도구가 아니라서 소유 검사(requestId)를 받지 않도록 입력 이름을 pastRequestId 로 둔다.
   */
  private readPastRequestTool() {
    return defineAgentTool({
      name: "coordinator_read_past_request",
      title: "Read a past request",
      description:
        "Read another request (for example one the human refers to, like \"based on r13\"): its text, status, answer or investigation report, tasks with their reports, and decisions. Read-only.",
      input: z.object({ pastRequestId: z.string() }),
      execute: async ({ pastRequestId }) => {
        const past = (await this.store.read()).requests.find((item) => item.id === pastRequestId);
        if (!past) return { text: `Unknown request ${pastRequestId}`, isError: true };
        return {
          text: JSON.stringify(
            {
              id: past.id,
              status: past.status,
              kind: past.kind,
              text: past.text,
              feedback: past.feedback,
              title: past.title,
              grade: past.grade,
              answer: past.answer,
              investigation: past.investigation,
              unknowns: past.unknowns,
              tasks: past.tasks.map((task) => ({
                number: task.number,
                name: task.name,
                projectId: task.projectId,
                kind: task.kind,
                targets: task.targets,
                status: task.status,
                branch: task.branch,
                scope: task.scope,
                completion: task.completion
                  ? { summary: task.completion.summary, verification: task.completion.verification, left: task.completion.left, pr: task.completion.pr?.url ?? null }
                  : null,
                decisions: task.decisions.map((item) => `${item.by}: ${item.summary}`),
              })),
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
        // 심볼릭 링크로 프로젝트 밖 파일을 읽지 않게 read_file 과 같은 경계 검사를 거친다.
        const readInside = async (name: string) => {
          const target = await resolveInside(project.path, name).catch(() => null);
          if (!target) return null;
          const head = await readHead(target, (await stat(target).catch(() => null))?.size ?? 0);
          return head && head !== "binary" ? head.text : null;
        };
        const [readme, pkg, entries] = await Promise.all([
          readInside("README.md"),
          readInside("package.json"),
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
        // await 사이에 요청이 취소되거나 끝났을 수 있어 저장하는 순간에 상태를 다시 본다.
        // 워커가 이미 일하는 요청은 진행 중인 채로 질문만 붙인다. needs_input 으로 바꾸면 답을 받은 뒤 다시 계획하게 되어
        // 일하던 워커와 작업 기록이 버려진다.
        const saved = await this.store.update((current) => {
          const item = current.requests.find((entry) => entry.id === request.id);
          if (!item || (item.status !== "planning" && item.status !== "running")) return { state: current, result: false };
          const keepRunning = item.status === "running" && hasStarted(item);
          return {
            state: {
              ...current,
              requests: current.requests.map((entry) =>
                entry.id !== request.id
                  ? entry
                  : {
                      ...entry,
                      status: keepRunning ? entry.status : ("needs_input" as const),
                      title: entry.title ?? input.title,
                      question: {
                        context: input.context,
                        questions: input.questions,
                        projectIds,
                        at: now,
                      },
                    },
              ),
            },
            result: true,
          };
        });
        if (!saved) return { text: `Request ${request.id} changed while you were asking; read it again with coordinator_get_request.`, isError: true };
        return { text: `Question card sent for ${request.id}. Wait for the human's answer; the plugin will tell you.` };
      },
    });
  }

  /**
   * 읽기 요청에 직접 답한다. 등급도 계획 승인도 없다. 사람은 인박스 '확인 필요'의 답변 카드로 본다.
   * 변경을 위한 조사가 돌아온 요청은 사람이 그 결과를 보고 답하기 전에는 답변으로 끝낼 수 없다. 답변 카드의 확인은 요청을
   * 끝내므로, 사람이 바란 변경이 조용히 사라진다 (r13~r15). 사람이 '바꾸지 않음'을 골랐으면 그 뒤에는 답변으로 끝낼 수 있다.
   */
  private submitAnswerTool() {
    return defineAgentTool({
      name: "coordinator_submit_answer",
      title: "Submit answer",
      description:
        "Answer a read request (one that changes nothing) directly. Use this when your read-only tools were enough to answer. Not for requests that ask you to change something: plan those.",
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
        // 변경을 위한 조사(beforeChange)가 돌아온 요청만 막는다. 읽기 요청이 조사 중 지시 때문에 돌아왔으면, 그 지시가 질문이었는지
        // 코디네이터가 판단해 답할 수 있어야 한다 (2026-11-26 최종 검사).
        // 조사가 시작되기 전에 지시가 와서 계획 단계로 돌아온 경우에도 막는다. 조사 보고가 없으면 계획 시각을 기준으로 본다.
        if (request.beforeChange && !humanAnsweredSince(request, request.investigation?.at ?? request.plannedAt)) {
          return {
            text: "This request asked for a change, and its investigation came back to you. Do not end it with an answer: ask the human with coordinator_ask_human which changes to make (one option may be to change nothing), or plan the change.",
            isError: true,
          };
        }
        if (request.language === "ko" && !HANGUL.test(input.title)) {
          return { text: "title must be written in Korean (language is ko).", isError: true };
        }
        const now = new Date().toISOString();
        const projectIds = await this.knownProjects(paseo, input.projectIds);
        const saved = await this.store.update((current) => {
          const latest = current.requests.find((entry) => entry.id === request.id);
          if (latest?.status !== "planning" || hasLiveTasks(latest)) return { state: current, result: null };
          return {
            state: {
              ...current,
              requests: current.requests.map((item) =>
                item.id === request.id
                  ? {
                      ...item,
                      kind: "read" as const,
                      beforeChange: false,
                      status: "answered" as const,
                      title: input.title,
                      grade: null,
                      tasks: [],
                      answer: { text: input.answer, sources: input.sources, unknowns: input.unknowns, projectIds, at: now },
                    }
                  : item,
              ),
            },
            // 답이 대신하는 끝난 조사 작업. 기록에서 빠지면 워크스페이스를 찾을 길이 없어 아래에서 정리한다.
            result: latest.tasks,
          };
        });
        if (!saved) return { text: `Request ${request.id} changed while you were answering; read it again with coordinator_get_request.`, isError: true };
        await cleanupTaskWorkspaces(paseo, saved);
        return { text: `Answer stored for ${request.id}. The human reviews it in the inbox.` };
      },
    });
  }

  /**
   * 계획과 작업 추가가 같이 쓰는 검사: 기준 브랜치와 기존 워크스페이스. approvals 는 사람의 승인이 필요한 기존 워크스페이스의
   * 경로다. 사람이 고른 워크스페이스나 이 요청의 작업이 이미 쓰는 워크스페이스는 다시 묻지 않는다.
   */
  private async taskProblems(
    paseo: PaseoApi,
    request: CoordinatorRequest,
    tasks: readonly z.infer<typeof taskInput>[],
    projects: Awaited<ReturnType<typeof allowedProjects>>,
  ): Promise<{ problems: string[]; approvals: string[] }> {
    const problems: string[] = [];
    const approvals = new Set<string>();
    const wanted = tasks.some((task) => task.workspaceId || request.workspaces[task.projectId]);
    const workspaces = wanted ? await listExistingWorkspaces(paseo).catch(() => []) : [];
    const pluginIds = wanted ? pluginWorkspaceIds(await this.store.read()) : new Set<string>();
    for (const task of tasks) {
      const human = request.workspaces[task.projectId];
      if (human && task.workspaceId && task.workspaceId !== human) {
        problems.push(`Task ${task.number}: the human chose workspace ${human} for project ${task.projectId}; omit workspaceId or use ${human}.`);
        continue;
      }
      const workspaceId = human ?? task.workspaceId;
      if (workspaceId) {
        if (task.baseBranch) problems.push(`Task ${task.number}: a task in an existing workspace works on the branch checked out there; omit baseBranch.`);
        const workspace = workspaces.find((item) => item.id === workspaceId);
        const problem = workspaceProblem(workspace, workspaceId, task.projectId, pluginIds);
        if (problem) problems.push(`Task ${task.number}: ${problem}.`);
        else if (!human && !request.tasks.some((other) => other.status !== "canceled" && other.existingWorkspaceId === workspaceId)) {
          approvals.add(workspace!.directory);
        }
        continue;
      }
      // 사람이 새 요청 창에서 고른 기준 브랜치는 코디네이터가 바꾸지 못한다. 적은 브랜치는 저장소에 있어야 한다.
      const chosen = request.baseBranches[task.projectId];
      if (chosen && task.baseBranch && task.baseBranch !== chosen) {
        problems.push(`Task ${task.number}: the human chose base branch ${chosen} for project ${task.projectId}; omit baseBranch or use ${chosen}.`);
        continue;
      }
      const root = projects.find((project) => project.id === task.projectId)?.path;
      if (!chosen && task.baseBranch && root && !(await resolveBaseRef(root, task.baseBranch))) {
        problems.push(`Task ${task.number}: branch ${task.baseBranch} does not exist in project ${task.projectId}.`);
      }
    }
    return { problems, approvals: [...approvals] };
  }

  private submitPlanTool() {
    return defineAgentTool({
      name: "coordinator_submit_plan",
      title: "Submit plan",
      description:
        "Submit or replace the plan for a request in the planning state. For a change request set readOnly false and a grade. For a read request too large to answer yourself, set readOnly true and omit grade: read-only investigation workers start without approval and their report becomes an answer. For an investigation that comes before a change the human asked for, set readOnly true, beforeChange true and the grade of the change: the report comes back to you instead of the human. Tasks that act outside their worktree (cleaning up branches or worktrees, deleting remote branches, running an app) are kind \"operation\" with targets, and start only after the human approved those targets on a question card.",
      input: z.object({
        requestId: z.string(),
        readOnly: z.boolean().default(false),
        beforeChange: z
          .boolean()
          .default(false)
          .describe("readOnly only: this investigation is the first step of a change the human asked for, not an answer to a question. Give the grade of that change."),
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
        const checked = await this.taskProblems(paseo, request, input.tasks, projects);
        const problems = [...validatePlan(input, request.language, usable, [], request.workspaces), ...checked.problems];
        if (!input.readOnly && !input.grade) problems.push("A change request needs a grade.");
        if (input.beforeChange && !input.readOnly) problems.push("beforeChange is only for a readOnly investigation.");
        if (input.beforeChange && !input.grade) problems.push("beforeChange needs the grade of the change that follows the investigation.");
        if (input.readOnly && !input.beforeChange && input.grade) {
          problems.push("A read-only investigation has no grade. If it comes before a change, set beforeChange true.");
        }
        if (input.readOnly && input.tasks.some((task) => task.kind === "operation")) {
          problems.push("A read-only investigation cannot have operation tasks.");
        }
        // 변경을 위한 조사가 돌아온 요청을 다시 조사할 때도 변경 요청으로 남아야 한다. beforeChange 없이 다시 조사하면 그 보고가
        // 답변 카드가 되어, 확인 한 번으로 아무것도 바꾸지 않은 채 끝난다 (2026-11-26 최종 검사).
        if (
          request.beforeChange &&
          input.readOnly &&
          !input.beforeChange &&
          !humanAnsweredSince(request, request.investigation?.at ?? request.plannedAt)
        ) {
          problems.push("This request asked for a change. A further investigation must keep beforeChange true and the grade of the change.");
        }
        problems.push(
          ...humanGateProblems(request, input.tasks, input.readOnly ? null : (input.grade ?? null), decisionBasisAt(request), checked.approvals),
        );
        if (problems.length > 0) return { text: `Plan rejected:\n- ${problems.join("\n- ")}`, isError: true };
        // v3: 명확한 요청은 코디네이터 판단으로 바로 시작한다. 사람은 확인 필요의 시작 카드로 본다 (RULES.md §2.0).
        // 읽기 전용 조사 워커는 읽기 전용 모드로 띄운다 (3e).
        // 변경 전 조사는 카드에 그 변경의 등급으로 보이게 등급을 남긴다. 실제 변경 계획이 오면 그 등급으로 바뀐다.
        const grade = input.readOnly && !input.beforeChange ? null : (input.grade ?? null);
        const now = new Date().toISOString();
        const feedbackCount = request.feedback.length;
        // 검증하는 사이(await) 요청이 취소되거나 새 지시가 왔으면 저장하지 않는다. 취소한 요청이 되살아나 워커가 생긴다.
        const saved = await this.store.update((current) => {
          const latest = current.requests.find((entry) => entry.id === request.id);
          if (latest?.status !== "planning" || hasLiveTasks(latest) || latest.feedback.length !== feedbackCount) {
            return { state: current, result: null };
          }
          return {
            state: {
              ...current,
              requests: current.requests.map((item) =>
                item.id === request.id
                  ? {
                      ...item,
                      status: "running" as const,
                      kind: input.readOnly ? ("read" as const) : ("change" as const),
                      beforeChange: input.beforeChange,
                      title: input.title,
                      grade,
                      // 이전 답은 남긴다. 조사 보고(investigation)처럼 다음 결정의 근거이고, 코디네이터가 다시 읽는다.
                      gradeReasons: input.gradeReasons,
                      recommendation: input.recommendation,
                      risks: input.risks,
                      unknowns: input.unknowns,
                      plannedAt: now,
                      tasks: input.tasks.map((task) => newTask(request, task)),
                    }
                  : item,
              ),
            },
            // 새 계획이 대신하는 끝난 조사 작업. 기록에서 빠지면 그 워크스페이스를 찾을 길이 없어 아래에서 정리한다.
            result: latest.tasks,
          };
        });
        if (!saved) return { text: `Request ${request.id} changed while you were planning (canceled, or a new instruction arrived); read it again with coordinator_get_request.`, isError: true };
        // 조사 워커는 plan 모드라 worktree 에 남긴 변경이 없다. 보고는 investigation 과 answer 에 이미 옮겼다.
        await cleanupTaskWorkspaces(paseo, saved);
        this.onPlanStarted(paseo);
        return {
          text:
            `Plan stored for ${request.id} and started. The plugin creates the workers. The human sees it as a start card and can stop or redirect it.`,
        };
      },
    });
  }

  /**
   * 실행 중인 변경 요청에 작업을 더한다. 사람이 실행 중에 보낸 지시(예: '다른 프로젝트도 고쳐줘')를 실행할 길이 없어, 시작 카드가
   * '다시 계획해요'라고 안내하는데 지시가 버려졌다 (2026-11-26 사용자 결정: 작업 추가·취소 도구).
   * 원래 요청 범위를 넘으면 먼저 사람에게 묻는다. A 등급 요청과 운영 작업은 사람의 답이 있어야 더할 수 있다.
   */
  private addTasksTool() {
    return defineAgentTool({
      name: "coordinator_add_tasks",
      title: "Add tasks",
      description:
        "Add tasks to a running change request, for example to carry out a new instruction from the human. Number them after the existing tasks; dependsOn may list existing tasks. Use only for work inside the request or what the human just asked; ask the human first if it goes beyond. Grade A requests and operation tasks need the human's answer on a question card after the current plan.",
      input: z.object({
        requestId: z.string(),
        reason: z.string().trim().min(1).describe("Which instruction of the human this carries out, quoted."),
        tasks: z.array(taskInput).min(1),
      }),
      execute: async (input, { paseo }) => {
        const request = (await this.store.read()).requests.find((item) => item.id === input.requestId);
        if (!request) return { text: `Unknown request ${input.requestId}`, isError: true };
        if (request.status !== "running" || request.kind !== "change") {
          return {
            text:
              request.kind === "read" && request.status === "running"
                ? "This is a read-only investigation. When it comes back to you, plan the change with coordinator_submit_plan."
                : `Request ${request.id} is ${request.status}; tasks can only be added to a running change request.`,
            isError: true,
          };
        }
        const projects = await allowedProjects(paseo, this.settings);
        // 사람이 고른 프로젝트 밖의 작업은 사람이 지금 계획 뒤에 답했을 때만 더한다('B 프로젝트도 고쳐줘'를 확인받은 뒤).
        // 고른 프로젝트로만 막으면 실행 중에 받은 다른 프로젝트 지시를 실행할 길이 없었다 (2026-11-26 최종 검사).
        const usable = new Set(projects.map((p) => p.id));
        const outside = [...new Set(input.tasks.map((task) => task.projectId))].filter(
          (id) => request.projectIds.length > 0 && !request.projectIds.includes(id),
        );
        const checked = await this.taskProblems(paseo, request, input.tasks, projects);
        const problems = [
          ...validatePlan({ title: request.title ?? request.id, tasks: input.tasks }, request.language, usable, request.tasks, request.workspaces),
          ...(outside.length > 0 && !humanAnsweredSince(request, request.plannedAt)
            ? [`Project ${outside.join(", ")} is outside the projects the human chose. Ask the human with coordinator_ask_human first.`]
            : []),
          ...checked.problems,
          // 지금 계획 뒤에 받은 답이어야 한다. 계획을 세울 때 받은 답으로 새 작업까지 통과시키지 않는다.
          ...humanGateProblems(request, input.tasks, request.grade, request.plannedAt, checked.approvals),
        ];
        if (problems.length > 0) return { text: `Tasks rejected:\n- ${problems.join("\n- ")}`, isError: true };
        const now = new Date().toISOString();
        const count = request.tasks.length;
        const saved = await this.store.update((current) => {
          const latest = current.requests.find((entry) => entry.id === request.id);
          if (latest?.status !== "running" || latest.tasks.length !== count) return { state: current, result: false };
          return {
            state: {
              ...current,
              requests: current.requests.map((item) =>
                item.id === request.id
                  ? {
                      ...item,
                      // 시작 카드가 다시 확인 필요로 뜬다. 사람은 더해진 작업을 본다.
                      plannedAt: now,
                      projectIds: item.projectIds.length > 0 ? [...new Set([...item.projectIds, ...outside])] : item.projectIds,
                      tasks: [
                        ...item.tasks,
                        ...input.tasks.map((task) => ({
                          ...newTask(request, task),
                          decisions: [{ summary: `Added by the coordinator: ${input.reason}`, by: "coordinator" as const, at: now, qa: [] }],
                        })),
                      ],
                    }
                  : item,
              ),
            },
            result: true,
          };
        });
        if (!saved) return { text: `Request ${request.id} changed while you were adding tasks; read it again with coordinator_get_request.`, isError: true };
        this.onPlanStarted(paseo);
        return { text: `Added tasks ${input.tasks.map((task) => task.number).join(", ")} to ${request.id}. The human sees them on the start card.` };
      },
    });
  }

  /**
   * 실행 중인 요청의 작업을 취소한다. 사람이 '작업 2 는 하지 마' 처럼 지시했을 때 쓴다. 그 작업에 기대는 작업도 함께 취소된다.
   * 끝나서 머지를 기다리는 작업은 취소하지 않는다. 그 결과를 버릴지는 사람이 머지 카드에서 정한다.
   */
  private cancelTasksTool() {
    return defineAgentTool({
      name: "coordinator_cancel_tasks",
      title: "Cancel tasks",
      description:
        "Cancel tasks of a running request that have not finished, when the human told you to drop that work. Tasks that depend on them are canceled too, and their workers are stopped. Finished tasks waiting for the human's merge card cannot be canceled here. A pull request a canceled task already opened stays open on GitHub: tell the human so in your final note.",
      input: z.object({
        requestId: z.string(),
        taskNumbers: z.array(z.number().int().positive()).min(1),
        reason: z.string().trim().min(1).describe("The human's instruction this follows, quoted."),
      }),
      execute: async (input, { paseo }) => {
        type Outcome = { error: string } | ReturnType<typeof cancelTasksIn>;
        const outcome = await this.store.update<Outcome>((state) => {
          const request = state.requests.find((item) => item.id === input.requestId);
          if (!request || request.status !== "running") return { state, result: { error: `Request ${input.requestId} is not running.` } };
          for (const number of input.taskNumbers) {
            const task = request.tasks.find((item) => item.number === number);
            if (!task) return { state, result: { error: `Task ${number} does not exist.` } };
            if (task.status === "review" || task.status === "done" || task.status === "canceled") {
              return {
                state,
                result: { error: `Task ${number} is ${task.status}; only unfinished tasks can be canceled. Ask the human about finished work.` },
              };
            }
          }
          let result: ReturnType<typeof cancelTasksIn>;
          try {
            result = cancelTasksIn(request, input.taskNumbers, "coordinator", input.reason);
          } catch (error) {
            return { state, result: { error: error instanceof Error ? error.message : String(error) } };
          }
          return {
            state: { ...state, requests: state.requests.map((item) => (item.id === request.id ? result.request : item)) },
            result,
          };
        });
        if ("error" in outcome) return { text: outcome.error, isError: true };
        if (outcome.reviewerIds.length && this.reviews) {
          for (const number of outcome.canceled) await this.reviews.abandon(paseo, input.requestId, number, outcome.reviewerIds);
        }
        this.onTasksCanceled(paseo, input.requestId, outcome.agentIds, outcome.requestCanceled);
        return {
          text: outcome.requestCanceled
            ? `Canceled tasks ${outcome.canceled.join(", ")}; no task is left, so request ${input.requestId} is canceled.`
            : `Canceled tasks ${outcome.canceled.join(", ")}.`,
        };
      },
    });
  }
}

const taskInput = z.object({
  number: z.number().int().positive(),
  name: z.string().trim().min(1),
  projectId: z.string(),
  dependsOn: z.array(z.number().int().positive()).default([]),
  kind: z
    .enum(["code", "operation"])
    .default("code")
    .describe("code: change files in its own worktree and open a pull request. operation: act outside the worktree on the listed targets only, with no pull request."),
  targets: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("operation only: every path, branch, remote action or app it will act on, so the human can approve exactly these."),
  scope: z.string().trim().min(1),
  doneCriteria: z.string().trim().min(1),
  requestRefs: z.array(z.string().trim().min(1)).min(1),
  baseBranch: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Branch to cut this task's worktree from and open its pull request against. Set it only when the work builds on a branch that is not merged into the default branch yet (see coordinator_list_branches). Omit it to use the project's configured base.",
    ),
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Run this task in the human's existing Paseo workspace (see coordinator_list_workspaces) instead of a new worktree, on the branch checked out there. Use it when the work belongs to what the human is doing in that workspace: a feature on a branch that is not merged yet, an app to run from that worktree. Unless the human chose it (humanWorkspaces), ask the human first with coordinator_ask_human, writing the workspace directory word for word. Code tasks there commit on that branch and do not push or open a pull request. Tasks in one workspace must run one after another (chain them with dependsOn). Omit baseBranch when you set this.",
    ),
});

function newTask(request: CoordinatorRequest, task: z.infer<typeof taskInput>): Task {
  return {
    ...task,
    baseBranch: request.baseBranches[task.projectId] ?? task.baseBranch ?? null,
    existingWorkspaceId: request.workspaces[task.projectId] ?? task.workspaceId ?? null,
    startCommit: null,
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
  };
}

/**
 * 사람의 답이 있어야 시작하는 작업 (RULES.md H4, 운영 작업). since 뒤에 받은 답이어야 한다. 조사 전에 받은 해석 질문의 답이나
 * 계획을 세울 때 받은 답으로, 사람이 보지 않은 변경이 통과하지 않게 한다 (2026-11-26 전수 검사).
 */
export function humanGateProblems(
  request: CoordinatorRequest,
  tasks: readonly { kind: "code" | "operation"; targets?: readonly string[] }[],
  grade: CoordinatorRequest["grade"],
  since: string | null,
  /** 코디네이터가 고른 기존 워크스페이스의 경로. 사람의 작업 공간에 워커를 들이므로 사람이 그 경로를 보고 답해야 한다. */
  workspaceDirectories: readonly string[] = [],
): string[] {
  const answered = humanAnsweredSince(request, since);
  const problems: string[] = [];
  const shown = request.lastQuestion && (!since || request.lastQuestion.answeredAt > since) ? questionText(request.lastQuestion) : null;
  if (grade === "A" && !answered) {
    problems.push(
      "Grade A: investigate first (readOnly with beforeChange), then ask the human with coordinator_ask_human which changes to make. The human's answer must come after the investigation report or previous answer, and be the latest feedback.",
    );
  }
  const operations = tasks.filter((task) => task.kind === "operation");
  if (operations.length > 0) {
    // 답한 질문 카드에 대상이 그대로 적혀 있어야 사람이 그 대상을 승인한 것이다. '무언가에 답했다'만 보면 대상을 보여 주지 않은
    // 질문의 답으로도 통과했다 (2026-11-26 최종 검사).
    const missing = shown === null ? [] : operations.flatMap((task) => (task.targets ?? []).filter((target) => !shown.includes(normalize(target))));
    if (!answered || shown === null) {
      problems.push(
        "Operation tasks act outside their worktree: ask the human with coordinator_ask_human, listing each operation task's targets word for word in the context, and plan them after the answer.",
      );
    } else if (missing.length > 0) {
      problems.push(
        `The question the human answered did not list these operation targets word for word: ${missing.map((target) => `"${target}"`).join(", ")}. Ask again with each target in the context.`,
      );
    }
  }
  if (workspaceDirectories.length > 0) {
    const missing = shown === null ? [] : workspaceDirectories.filter((directory) => !shown.includes(normalize(directory)));
    if (!answered || shown === null) {
      problems.push(
        `Working in the human's existing workspace needs their approval: ask with coordinator_ask_human, writing each workspace directory word for word (${workspaceDirectories.join(", ")}), and plan after the answer.`,
      );
    } else if (missing.length > 0) {
      problems.push(`The question the human answered did not show these workspace directories word for word: ${missing.join(", ")}. Ask again with each directory in the context.`);
    }
  }
  return problems;
}

/** 공백 차이를 무시하고 비교한다. 대상 문자열이 질문에 그대로 들어 있는지 볼 때 쓴다. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function questionText(question: NonNullable<CoordinatorRequest["lastQuestion"]>): string {
  return normalize(
    [
      question.context,
      ...question.questions.flatMap((item) => [item.question, ...item.options.flatMap((option) => [option.label, option.description ?? ""])]),
    ].join(" "),
  );
}

/**
 * 계획의 형식과 규칙 검사. 실패하면 코디네이터에게 이유를 돌려줘 고치게 한다.
 * existing 은 실행 중인 요청에 작업을 더할 때 이미 있는 작업이다. 새 작업 번호는 그 뒤로 이어지고, 의존은 그 작업을 가리킬 수 있다.
 */
export function validatePlan(
  plan: {
    title: string;
    readOnly?: boolean;
    tasks: readonly {
      number: number;
      name: string;
      projectId: string;
      dependsOn: readonly number[];
      kind?: "code" | "operation";
      targets?: readonly string[];
      workspaceId?: string;
    }[];
  },
  language: "en" | "ko",
  usableProjects: ReadonlySet<string>,
  existing: readonly {
    number: number;
    projectId: string;
    dependsOn: readonly number[];
    kind?: "code" | "operation";
    status?: string;
    existingWorkspaceId?: string | null;
  }[] = [],
  /** 사람이 새 요청 창에서 고른 기존 워크스페이스(projectId → workspaceId). */
  humanWorkspaces: Readonly<Record<string, string>> = {},
): string[] {
  const problems: string[] = [];
  const numbers = plan.tasks.map((task) => task.number);
  const expected = plan.tasks.map((_, index) => existing.length + index + 1);
  if (numbers.join(",") !== expected.join(",")) problems.push(`Task numbers must be ${expected[0]}..${expected.at(-1)} in order.`);
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
    if (task.kind === "operation" && !(task.targets ?? []).length) {
      problems.push(`Task ${task.number}: an operation task must list its targets.`);
    }
  }
  // 같은 프로젝트의 앞 코드 작업에 이어지는 코드 작업은 그 worktree 를 이어 쓴다 (dispatcher). 두 작업이 같은 작업을 이어 쓰면
  // 두 워커가 한 worktree 에서 동시에 일하고, 한쪽을 머지할 때 다른 쪽의 worktree 가 지워진다.
  const all = [...existing.filter((task) => task.status !== "canceled"), ...plan.tasks];
  const isCode = (task: { kind?: string }) => task.kind !== "operation";
  const continuesFrom = (task: (typeof all)[number]) => {
    if (!isCode(task)) return null;
    const sameProject = all.filter((dep) => task.dependsOn.includes(dep.number) && dep.projectId === task.projectId && isCode(dep));
    return sameProject.length ? Math.max(...sameProject.map((dep) => dep.number)) : null;
  };
  const continuing = new Map<number, number[]>();
  for (const task of all) {
    const from = continuesFrom(task);
    if (from !== null) continuing.set(from, [...(continuing.get(from) ?? []), task.number]);
  }
  for (const [from, followers] of continuing) {
    if (followers.length > 1) {
      problems.push(
        `Tasks ${followers.join(", ")} all continue task ${from} in the same project, so they would share one worktree. Chain them (each after the previous one) or merge them into one task.`,
      );
    }
  }
  // 같은 프로젝트의 앞 코드 작업 여럿에 기대면, 이어 쓰는 것은 가장 늦은 작업의 worktree 하나뿐이다. 나머지가 그 사슬에 없으면
  // 그 변경은 보이지 않는다 (2026-11-26 전수 검사).
  const byNumber = new Map(all.map((task) => [task.number, task]));
  for (const task of plan.tasks) {
    const from = continuesFrom(task);
    if (from === null) continue;
    const chain = new Set<number>();
    for (let current: number | null = from; current !== null; current = continuesFrom(byNumber.get(current)!)) chain.add(current);
    const missing = task.dependsOn.filter((dep) => {
      const other = byNumber.get(dep);
      return other && other.projectId === task.projectId && isCode(other) && !chain.has(dep);
    });
    if (missing.length) {
      problems.push(
        `Task ${task.number} depends on tasks ${[from, ...missing].join(", ")} in the same project, but only continues task ${from}'s worktree, so the changes of task ${missing.join(", ")} would not be there. Chain them.`,
      );
    }
  }
  problems.push(...existingWorkspaceProblems(plan, all, existing, continuesFrom, humanWorkspaces));
  return problems;
}

type PlanTask = {
  number: number;
  projectId: string;
  dependsOn: readonly number[];
  kind?: "code" | "operation";
  status?: string;
  workspaceId?: string;
  existingWorkspaceId?: string | null;
};

/**
 * 기존 워크스페이스는 사람의 작업 트리 하나라 한 번에 한 워커만 쓴다. 두 워커가 동시에 고치면 서로의 변경이 커밋에 섞인다.
 * 그래서 같은 워크스페이스의 작업은 의존으로 앞뒤가 정해져야 한다. 앞 작업의 worktree 를 이어 쓰는 작업은 그 워크스페이스를
 * 물려받으므로 다른 워크스페이스를 적을 수 없다. 읽기 조사는 아무것도 바꾸지 않아 함께 돌아도 된다.
 */
function existingWorkspaceProblems(
  plan: { readOnly?: boolean; tasks: readonly PlanTask[] },
  all: readonly PlanTask[],
  existing: readonly PlanTask[],
  continuesFrom: (task: PlanTask) => number | null,
  humanWorkspaces: Readonly<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const byNumber = new Map(all.map((task) => [task.number, task]));
  const explicit = (task: PlanTask) => task.existingWorkspaceId ?? task.workspaceId ?? humanWorkspaces[task.projectId] ?? null;
  const effective = (task: PlanTask): string | null => {
    const own = explicit(task);
    if (own) return own;
    const from = continuesFrom(task);
    return from === null ? null : effective(byNumber.get(from)!);
  };
  for (const task of plan.tasks) {
    const own = explicit(task);
    const from = continuesFrom(task);
    const inherited = from === null ? null : effective(byNumber.get(from)!);
    if (own && from !== null && inherited !== own) {
      problems.push(
        `Task ${task.number} continues task ${from}'s ${inherited ? `workspace ${inherited}` : "new worktree"}, so it cannot run in workspace ${own}. Drop workspaceId, or do not make it depend on task ${from}.`,
      );
    }
  }
  if (plan.readOnly) return problems;
  const reaches = (from: number, target: number, seen = new Set<number>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    const task = byNumber.get(from);
    return Boolean(task?.dependsOn.some((dep) => dep === target || reaches(dep, target, seen)));
  };
  // 끝난 작업은 워크스페이스를 더 쓰지 않는다. 대기·실행·막힘인 작업과 새 작업만 순서를 본다.
  const active = [...existing.filter((task) => ["waiting", "running", "blocked"].includes(task.status ?? "")), ...plan.tasks];
  const groups = new Map<string, number[]>();
  for (const task of active) {
    const workspace = effective(task);
    if (workspace) groups.set(workspace, [...(groups.get(workspace) ?? []), task.number]);
  }
  for (const [workspace, numbers] of groups) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index += 1) {
      if (!reaches(sorted[index]!, sorted[index - 1]!)) {
        problems.push(
          `Tasks ${sorted[index - 1]} and ${sorted[index]} would both work in existing workspace ${workspace} at the same time. Make task ${sorted[index]} depend on task ${sorted[index - 1]}, or merge them.`,
        );
      }
    }
  }
  return problems;
}
