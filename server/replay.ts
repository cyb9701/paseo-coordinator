import { decisionInputSchema } from "../shared/model";
import { ADD_FOLLOWUP_TOOL, RECORD_DECISION_TOOL, recordDecision, saveFollowup } from "./agent-tools";
import type { PaseoApi } from "./paseo-api";
import type { StateStore } from "./store";

interface ToolEntry {
  item?: {
    type?: string;
    callId?: string;
    name?: string;
    status?: string;
    error?: unknown;
    detail?: { input?: unknown; output?: unknown };
  };
}

/**
 * 플러그인이 다시 시작되면(업데이트, reload) 이미 열린 세션의 진행 중인 턴은 플러그인 도구를 잃는다. 도구 호출이
 * "Tool record_decision not found" 로 실패하고 세션은 다음 프롬프트 전에야 다시 열린다. 그 사이의 결정을 잃지 않게, 턴이 끝날 때
 * 그렇게 실패한 호출을 입력값 그대로 기록한다. 같은 호출은 callId 로 한 번만 기록한다.
 */
export async function replayLostCalls(
  paseo: PaseoApi,
  store: StateStore,
  agentId: string,
  where: { workspaceId: string; projectId: string | null; cwd: string },
): Promise<number> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 120 });
  const entries = ((page as { entries?: readonly ToolEntry[] }).entries ?? []) as readonly ToolEntry[];
  const state = await store.read();
  const seen = new Set([...state.decisions.map((item) => item.callId), ...state.followups.map((item) => item.callId)].filter(Boolean));
  // 호출 뒤에 질문 창이 이미 답을 받았으면 멈춤 결정이라도 답 대기로 되살리지 않는다. 되살리면 이미 답한 것을 다시 묻는다.
  // 사람 메시지는 답인지 새 지시인지 가를 수 없어서 세지 않는다. 그런 결정은 답 대기로 남고 사람이 카드에서 정리한다.
  const answeredAfter = (index: number) =>
    entries.slice(index + 1).some(({ item }) => item?.type === "tool_call" && /AskUserQuestion/i.test(item.name ?? "") && item.status === "completed");
  let replayed = 0;
  for (const [index, { item }] of entries.entries()) {
    if (item?.type !== "tool_call" || item.status !== "failed" || !item.callId || seen.has(item.callId)) continue;
    if (!/not found/i.test(JSON.stringify(item.error ?? item.detail?.output ?? ""))) continue;
    const name = item.name ?? "";
    if (name.endsWith(RECORD_DECISION_TOOL)) {
      const input = decisionInputSchema.safeParse(item.detail?.input);
      if (!input.success) continue;
      const decision = await recordDecision(store, agentId, where, input.data, item.callId);
      if (decision.stop && answeredAfter(index)) await markAnswered(store, decision.id);
    } else if (name.endsWith(ADD_FOLLOWUP_TOOL)) {
      const text = (item.detail?.input as { text?: unknown } | undefined)?.text;
      if (typeof text !== "string" || !text.trim()) continue;
      await saveFollowup(store, agentId, where, text.trim(), item.callId);
    } else continue;
    seen.add(item.callId);
    replayed += 1;
  }
  return replayed;
}

async function markAnswered(store: StateStore, id: string): Promise<void> {
  const at = new Date().toISOString();
  await store.update((state) => ({
    state: {
      ...state,
      decisions: state.decisions.map((item) =>
        item.id === id ? { ...item, status: "answered" as const, reply: { text: "(answered in the agent's conversation)", at } } : item,
      ),
    },
    result: undefined,
  }));
}
