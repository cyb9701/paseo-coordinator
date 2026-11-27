import { type AgentToolContext, defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type Decision, type DecisionInput, type Followup, STOP_KINDS, decisionInputSchema } from "../shared/model";
import type { PaseoApi } from "./paseo-api";
import { type StateStore, nextId } from "./store";

export const RECORD_DECISION_TOOL = "record_decision";
export const ADD_FOLLOWUP_TOOL = "add_followup";
export const AGENT_TOOL_NAMES = [RECORD_DECISION_TOOL, ADD_FOLLOWUP_TOOL];

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
export const AGENT_INSTRUCTIONS = `## Decision log (Coordinator plugin)

The person who asked for this work reviews your decisions afterwards, often across many workspaces at once. Call ${RECORD_DECISION_TOOL} for each choice that the user's messages and the repository (code, docs, conventions, tests) do not already settle, before you act on it. Examples: what the change covers beyond what was asked, a data shape or storage format, a public interface or error format, user-visible behavior, adding a dependency, choosing between two reasonable designs.

Do not record steps the request or the repository already dictates, mechanical work (reading files, running tests, formatting), or a choice the user already answered.

In evidence, mark an item "verified" only if you checked it: cite file:line, a command and its output, or a doc. Anything you believe without checking is "assumption". Set restsOnAssumption to true when the choice would change if an assumption turned out wrong.

Record a decision before you ask the user about it, even when you would ask anyway; the user reviews decisions from this log. The tool answers "continue" or "stop". On "stop", do not implement that decision. Record the other decisions you need first, then ask the user about every stopped decision together, once: with your question tool if you have one (such as AskUserQuestion), otherwise in one short message at the end of your turn. Then wait.

When you notice work outside this request that should be done later, or the user mentions something for later, call ${ADD_FOLLOWUP_TOOL} instead of doing it.

Do not merge pull requests unless the user explicitly asks for it in this conversation.`;

export interface DecisionContext {
  /** 결정을 기록할 에이전트의 워크스페이스와 프로젝트. 도구를 붙일 때 이미 알고 있다. */
  locate(agent: AgentToolContext["agent"], paseo: PaseoApi): Promise<{ workspaceId: string; projectId: string | null; cwd: string } | null>;
}

export async function recordDecision(
  store: StateStore,
  agentId: string,
  where: { workspaceId: string; projectId: string | null; cwd: string },
  input: DecisionInput,
  callId: string | null = null,
): Promise<Decision> {
  const stop = shouldStop(input);
  // 에이전트는 절대 경로나 ./ 로 시작하는 경로를 적기도 한다. git 이 내는 워크스페이스 기준 경로로 맞춰야 diff 와 짝지을 수 있다.
  const files = [...new Set(input.files.map((file) => relativeTo(where.cwd, file)))];
  return store.update((state) => {
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
      "Record a choice that the user's messages and the repository do not settle, before acting on it: what you chose, why, the alternatives, the evidence (verified or assumption), whether it rests on an assumption, how hard it is to undo and the files it touches. The result says whether to continue or stop and ask the user.",
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
      "Save work that is outside the current request, or that the user wants done later, to the user's follow-up list instead of doing it now. Write it so someone without this conversation can start it.",
    input: z.object({ text: z.string().trim().min(1) }),
    execute: async ({ text }, { agent, paseo }) => {
      await saveFollowup(store, agent.id, await context.locate(agent, paseo), text);
      return { text: "Saved to the follow-up list. Do not do it now; continue with your task." };
    },
  });
  return [record, followup];
}

export async function saveFollowup(
  store: StateStore,
  agentId: string,
  where: { workspaceId: string; projectId: string | null } | null,
  text: string,
  callId: string | null = null,
): Promise<void> {
  await store.update((state) => {
    const { state: next, id } = nextId(state, "f");
    const followup: Followup = {
      id,
      text,
      projectId: where?.projectId ?? null,
      workspaceId: where?.workspaceId ?? null,
      agentId,
      source: "agent",
      at: new Date().toISOString(),
      status: "open",
      sentTo: null,
      callId,
    };
    return { state: { ...next, followups: [...next.followups, followup] }, result: undefined };
  });
}

export function relativeTo(cwd: string, file: string): string {
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const trimmed = file.trim();
  if (trimmed.startsWith(root)) return trimmed.slice(root.length);
  return trimmed.replace(/^\.\//, "");
}
