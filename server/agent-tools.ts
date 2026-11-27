import { type AgentToolContext, defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type Decision, type DecisionInput, STOP_KINDS, type WorkRequest, decisionInputSchema } from "../shared/model";
import type { PaseoApi } from "./paseo-api";
import { type StateStore, nextId } from "./store";
import type { Language } from "../shared/settings";

export const RECORD_DECISION_TOOL = "record_decision";
export const ADD_FOLLOWUP_TOOL = "add_followup";
export const AGENT_TOOL_NAMES = [RECORD_DECISION_TOOL, ADD_FOLLOWUP_TOOL];

/** 플러그인 도구는 daemon 의 "paseo" MCP 서버로 나가서, Claude 에서는 이 접두사가 붙은 이름이 된다. */
export const PLUGIN_MCP_PREFIX = "mcp__paseo__";

/**
 * 이 플러그인 도구의 이름인지. 이름 끝만 비교하면 다른 MCP 서버의 같은 이름 도구도 걸린다. 권한 허용과 잃은 호출 되살리기가 같은
 * 기준을 쓴다.
 */
export function isPluginTool(name: string, tool: string): boolean {
  return name === tool || name === `${PLUGIN_MCP_PREFIX}${tool}`;
}

/**
 * 사람이 정할 결정. 범위, 데이터 구조, 공개 인터페이스, 사용자에게 보이는 동작은 종류만으로 멈춘다. 되돌리기 어렵거나 확인하지 않은
 * 가정에 기대는 결정도 멈춘다. 나머지는 기록하고 진행해서 나중에 몰아서 확인한다. 에이전트가 아니라 플러그인이 판정해서 기준이 흔들리지 않는다.
 */
export function shouldStop(input: Pick<DecisionInput, "kind" | "reversible" | "restsOnAssumption">): boolean {
  return STOP_KINDS.includes(input.kind) || input.reversible !== "easy" || input.restsOnAssumption;
}

/**
 * 에이전트 지침. 결정 기록 도구와 함께 붙는다. 이 문구로 claude opus·sonnet 은 결정을 구현하기 전에 기록하고, 멈출 결정은 모아서
 * 한 번에 묻고, 답을 받은 뒤 같은 결정을 다시 기록하지 않는다. 문구를 바꾸면 실제 에이전트로 이 세 가지를 다시 확인한다.
 */
export function agentInstructions(language: Language | null): string {
  return `${AGENT_INSTRUCTIONS}\n\n${decisionLanguageLine(language)}`;
}

/**
 * 결정 기록과 추가 요청 제안은 코디네이터 화면에 그대로 보인다. 언어를 정하지 않으면 에이전트는 영어 지침을 따라 영어로 쓰고, 사람의
 * 말에서 가져온 낱말만 그 언어로 남아 한 문장에 두 언어가 섞인다. 화면 언어를 아직 모르면 사람이 쓰는 언어를 따르게 한다.
 */
export function decisionLanguageLine(language: Language | null): string {
  const target = language === "ko" ? "Korean" : language === "en" ? "English" : "the language the user writes to you in";
  return `Write the text of ${RECORD_DECISION_TOOL} (title, decision, why, alternatives, evidence) and ${ADD_FOLLOWUP_TOOL} in ${target}; the person reads them on screen in that language. Keep code identifiers, file paths, commands and quoted output as they are.`;
}

const AGENT_INSTRUCTIONS = `## Decision log (Coordinator plugin)

The person who asked for this work reviews your decisions afterwards, often across many workspaces at once. Call ${RECORD_DECISION_TOOL} for each choice that the user's messages and the repository (code, docs, conventions, tests) do not already settle, before you act on it. Examples: what the change covers beyond what was asked, a data shape or storage format, a public interface or error format, user-visible behavior, adding a dependency, choosing between two reasonable designs.

Do not record steps the request or the repository already dictates, mechanical work (reading files, running tests, formatting), or a choice the user already answered.

Give each decision a short title (one line, under 80 characters) that names the choice, such as "Persist todos in a JSON file", and put the details in decision. In evidence, mark an item "verified" only if you checked it: cite file:line, a command and its output, or a doc. Anything you believe without checking is "assumption". Set restsOnAssumption to true when the choice would change if an assumption turned out wrong.

Record a decision before you ask the user about it, even when you would ask anyway; the user reviews decisions from this log. The tool answers "continue" or "stop". On "stop", do not implement that decision. Record the other decisions you need first, then ask the user about every stopped decision together, once: with your question tool if you have one (such as AskUserQuestion), otherwise in one short message at the end of your turn. Then wait.

When you notice work outside this request that should be done later, or the user mentions something for later, call ${ADD_FOLLOWUP_TOOL} instead of doing it.

Do not merge pull requests unless the user explicitly asks for it in this conversation.`;

export interface DecisionContext {
  /** 결정을 기록할 에이전트의 워크스페이스와 프로젝트. 도구를 붙일 때 이미 알고 있다. */
  locate(agent: AgentToolContext["agent"], paseo: PaseoApi): Promise<{ workspaceId: string; projectId: string | null; cwd: string } | null>;
}

type Where = { workspaceId: string; projectId: string | null; cwd: string };

/**
 * 결정을 기록한다. callId 가 있으면 같은 호출을 이미 기록했는지 저장하는 자리에서 확인하고, 이미 있으면 null 을 돌려준다. 확인을
 * 밖에서 미리 하면 턴 끝과 질문 창 hook 이 겹칠 때 같은 호출이 두 번 기록된다.
 */
export async function recordDecision(store: StateStore, agentId: string, where: Where, input: DecisionInput): Promise<Decision>;
export async function recordDecision(store: StateStore, agentId: string, where: Where, input: DecisionInput, callId: string): Promise<Decision | null>;
export async function recordDecision(store: StateStore, agentId: string, where: Where, input: DecisionInput, callId: string | null = null): Promise<Decision | null> {
  const stop = shouldStop(input);
  // 에이전트는 절대 경로나 ./ 로 시작하는 경로를 적기도 한다. git 이 내는 워크스페이스 기준 경로로 맞춰야 diff 와 짝지을 수 있다.
  const files = [...new Set(input.files.map((file) => relativeTo(where.cwd, file)))];
  return store.update((state) => {
    if (callId && state.decisions.some((item) => item.callId === callId)) return { state, result: null };
    const { state: next, id, number } = nextId(state, "d");
    const decision: Decision = {
      ...input,
      files,
      id,
      number,
      agentId,
      workspaceId: where.workspaceId,
      projectId: where.projectId,
      at: new Date().toISOString(),
      stop,
      status: stop ? "waiting" : "unreviewed",
      reply: null,
      callId,
    };
    return { state: { ...next, decisions: [...next.decisions, decision] }, result: decision };
  });
}

export function decisionTools(store: StateStore, context: DecisionContext) {
  const record = defineAgentTool({
    name: RECORD_DECISION_TOOL,
    title: "Record a decision",
    description:
      "Record a choice that the user's messages and the repository do not settle, before acting on it: a one-line title, what you chose, why, the alternatives, the evidence (verified or assumption), whether it rests on an assumption, how hard it is to undo and the files it touches. The result says whether to continue or stop and ask the user.",
    input: decisionInputSchema,
    execute: async (input, { agent, paseo }) => {
      const where = await context.locate(agent, paseo);
      if (!where) return { text: "Not recorded: this agent is not in a workspace the coordinator watches. Continue.", isError: true };
      const decision = await recordDecision(store, agent.id, where, input);
      return {
        text: decision.stop
          ? `stop (#${decision.number}): this decision needs the user. Do not implement it. Record any other decisions you need, then ask the user once about all stopped decisions (with your question tool if you have one, otherwise in one short message at the end of your turn) and wait for the answer.`
          : `continue (#${decision.number}): recorded for later review. Go on.`,
      };
    },
  });
  const followup = defineAgentTool({
    name: ADD_FOLLOWUP_TOOL,
    title: "Add a follow-up",
    description:
      "Save work that is outside the current request, or that the user wants done later, as a suggestion on the user's request list instead of doing it now. Write it so someone without this conversation can start it.",
    input: z.object({ text: z.string().trim().min(1) }),
    execute: async ({ text }, { agent, paseo }) => {
      await saveSuggestion(store, agent.id, await context.locate(agent, paseo), text);
      return { text: "Saved as a suggestion for the user. Do not do it now; continue with your task." };
    },
  });
  return [record, followup];
}

/** 에이전트가 남긴 범위 밖의 일. 사람이 추가 요청 목록에서 보내거나 버린다. 같은 callId 를 이미 저장했으면 false. */
export async function saveSuggestion(
  store: StateStore,
  agentId: string,
  where: { workspaceId: string; projectId: string | null } | null,
  text: string,
  callId: string | null = null,
): Promise<boolean> {
  return store.update((state) => {
    if (callId && state.requests.some((item) => item.callId === callId)) return { state, result: false };
    const { state: next, id } = nextId(state, "r");
    const request: WorkRequest = {
      id,
      text,
      projectId: where?.projectId ?? null,
      workspaceId: where?.workspaceId ?? null,
      agentId,
      source: "agent",
      status: "suggested",
      at: new Date().toISOString(),
      sentAt: null,
      callId,
    };
    return { state: { ...next, requests: [...next.requests, request] }, result: true };
  });
}

export function relativeTo(cwd: string, file: string): string {
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const trimmed = file.trim();
  if (trimmed.startsWith(root)) return trimmed.slice(root.length);
  return trimmed.replace(/^\.\//, "");
}
