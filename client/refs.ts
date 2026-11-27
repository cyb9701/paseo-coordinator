import type { AgentRef, WorkspaceRef } from "@getpaseo/plugin/client";

/**
 * 상태 파일에 남은 id(결정의 agentId, 요청의 workspaceId)로 useAgent·useWorkspace 를 부를 때 쓰는 ref.
 * 문자열 id 를 바로 넘기는 방식은 SDK 가 호환용으로만 남겨 두었고(COMPAT plugin-entity-id, 2027-03 제거 예정), 문자열이면 호스트가
 * '지금 고른 호스트'로 ref 를 만들어 다른 호스트의 에이전트를 놓칠 수 있다. 화면의 hostId 를 붙여 ref 를 직접 만든다.
 * 호스트는 ref 의 hostId 와 id 로 찾는다(Paseo 0.17.4 앱의 getAgent). key 는 SDK 의 createEntityRefs 와 같은 모양으로 둔다.
 * 같은 ref 객체를 다시 쓰도록 모아 두어서, 그리기마다 새 객체가 생겨 구독 선택자가 다시 만들어지지 않게 한다.
 */
const interned = new Map<string, AgentRef | WorkspaceRef>();

function intern<Ref extends AgentRef | WorkspaceRef>(kind: Ref["kind"], hostId: string, id: string): Ref {
  const key = JSON.stringify([hostId, id]);
  const cacheKey = `${kind}:${key}`;
  let ref = interned.get(cacheKey);
  if (!ref) {
    ref = Object.freeze({ kind, key, hostId, id }) as Ref;
    interned.set(cacheKey, ref);
  }
  return ref as Ref;
}

export function toAgentRef(hostId: string, id: string): AgentRef {
  return intern<AgentRef>("agent", hostId, id);
}

export function toWorkspaceRef(hostId: string, id: string): WorkspaceRef {
  return intern<WorkspaceRef>("workspace", hostId, id);
}
