import type { PluginServerContext } from "@getpaseo/plugin/server";
import { COORDINATOR_TOOL_PREFIX, CoordinatorRuntime, isCoordinatorSession } from "./server/coordinator";
import { COORDINATOR_PROMPT } from "./server/prompt";
import { acknowledge, answerQuestions, cancelRequest, createRequest, recordInstruction, revisePlan } from "./server/requests";
import { StateStore } from "./server/store";
import {
  acknowledgeRpc,
  answerQuestionsRpc,
  cancelRequestRpc,
  createRequestRpc,
  recordInstructionRpc,
  revisePlanRpc,
  watchStateSubscription,
} from "./shared/model";
import { coordinatorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // 등록해야 클라이언트 useSettings 가 쓰는 읽기·쓰기 RPC 가 생긴다.
  const settings = server.registerSettings(coordinatorSettings);
  const store = new StateStore();
  const coordinator = new CoordinatorRuntime(store, settings);
  const logFailure = (what: string) => (error: unknown) => console.error(`[coordinator] ${what} failed`, error);

  server.handle(createRequestRpc, async (input, { paseo }) => {
    const result = await createRequest(input, store, settings);
    // 코디네이터 생성과 알림은 오래 걸릴 수 있어서 요청 저장과 떼어 놓는다. 실패하면 다음 턴 종료 때 다시 시도한다.
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(cancelRequestRpc, (input) => cancelRequest(input, store));
  server.handle(revisePlanRpc, async (input, { paseo }) => {
    const result = await revisePlan(input, store);
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(acknowledgeRpc, (input) => acknowledge(input, store));
  server.handle(answerQuestionsRpc, async (input, { paseo }) => {
    const result = await answerQuestions(input, store);
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(recordInstructionRpc, (input) => recordInstruction(input, store));

  // promise 를 반환하면 그 promise 가 끝날 때 구독이 닫힌다 (SDK 계약). 처음 상태만 보내고 닫혀서
  // 이후 변경이 화면에 안 갔던 버그가 있었다 (2026-11-25). 그래서 일반 함수로 두고 signal 로만 닫는다.
  server.handle(watchStateSubscription, (_input, { push, signal, paseo }) => {
    // 화면이 열릴 때마다 계획이 필요한 요청이 남아 있는지 보고 코디네이터에게 알린다.
    // 플러그인 재시작이나 실패로 알림을 놓쳐도 사람이 화면을 열면 다시 이어진다.
    coordinator.notify(paseo).catch(logFailure("notify on subscribe"));
    // 구독이 막 끊긴 순간에 보내면 실패할 수 있다. 다음 구독이 처음에 전체 상태를 받으므로 버려도 된다.
    const send = (state: Parameters<typeof push>[0]) => {
      push(state).catch(() => undefined);
    };
    const unsubscribe = store.subscribe(send);
    signal.addEventListener("abort", unsubscribe, { once: true });
    store.read().then(send, logFailure("read state"));
  });

  // 코디네이터 세션에만 전용 도구와 지침을 붙인다. 지침은 세션마다 붙고 에이전트에 저장되지 않는다.
  server.addHook("agent.open.before", async ({ request }) => {
    if (!isCoordinatorSession(request.labels)) return request;
    return {
      ...request,
      tools: [...request.tools, ...coordinator.tools()],
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), COORDINATOR_PROMPT],
    };
  });

  // 코디네이터가 일을 마치면, 그동안 쌓인 요청이 있는지 보고 알린다.
  server.addHook("agent.turn.after", async ({ agent }, { paseo }) => {
    if (agent.id !== (await coordinator.agentId())) return;
    await coordinator.notify(paseo).catch(logFailure("notify after turn"));
  });

  // 코디네이터가 자기 전용 도구를 부를 때 권한 확인이 뜨면 기계적으로 허용한다. 이 도구는 요청을 읽고
  // 계획을 저장할 뿐이다. 그 밖의 권한 요청은 손대지 않아서 사람의 인박스로 간다.
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    if (agent.id !== (await coordinator.agentId())) return;
    console.log(`[coordinator] coordinator permission request: kind=${request.kind} name=${request.name}`);
    if (request.kind !== "tool" || !request.name.includes(COORDINATOR_TOOL_PREFIX)) return;
    await paseo.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
      .catch(logFailure("allow coordinator tool"));
  });

  return () => {};
}
