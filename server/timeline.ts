import type { PaseoApi } from "./paseo-api";

interface Entry {
  item?: { type?: string; text?: string; message?: string; name?: string; agentMessage?: { text?: string } };
  timestamp?: string;
  createdAt?: string;
}

/** 요약과 화면에 넣을 대화. 도구 호출과 생각은 길고 사람이 판단하는 데 덜 필요해서, 사람과 에이전트가 주고받은 말과 에러만 남긴다. */
export interface Exchange {
  role: "user" | "agent" | "error";
  text: string;
  at: string | null;
}

/** Paseo 가 사람 메시지에 붙이는 시스템 블록. 사람이 쓴 말이 아니라 결정의 앞 상황으로 보여 주지 않는다. */
const SYSTEM_BLOCK = /<paseo-system[\s\S]*?(<\/paseo-system>|$)/g;

export async function recentExchanges(paseo: PaseoApi, agentId: string, limit = 200): Promise<Exchange[]> {
  const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit });
  const entries = ((page as { entries?: readonly Entry[] }).entries ?? []) as readonly Entry[];
  const out: Exchange[] = [];
  for (const entry of entries) {
    const item = entry.item;
    const at = entry.timestamp ?? entry.createdAt ?? null;
    if (item?.type === "user_message" && item.text) {
      const text = item.text.replace(SYSTEM_BLOCK, "").trim();
      if (text) out.push({ role: "user", text, at });
    } else if (item?.type === "tool_call" && item.name === "agent_message" && item.agentMessage?.text?.trim()) {
      // 다른 에이전트(예: 사람이 쓰는 상위 에이전트)가 보낸 일감. 이 에이전트에게는 사람의 요청과 같은 자리다.
      out.push({ role: "user", text: item.agentMessage.text.trim(), at });
    } else if (item?.type === "assistant_message" && item.text?.trim()) {
      out.push({ role: "agent", text: item.text.trim(), at });
    } else if (item?.type === "error" && item.message) {
      out.push({ role: "error", text: item.message, at });
    }
  }
  return out;
}

/** 이어진 에이전트 메시지는 스트리밍 조각일 수 있어서 하나로 합친다. */
export function mergeRuns(exchanges: readonly Exchange[]): Exchange[] {
  const merged: Exchange[] = [];
  for (const item of exchanges) {
    const last = merged[merged.length - 1];
    if (last && last.role === item.role && item.role === "agent") last.text = `${last.text}\n${item.text}`;
    else merged.push({ ...item });
  }
  return merged;
}
