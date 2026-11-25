import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cancelRequest, createRequest, recordInstruction } from "./server/requests";
import { StateStore } from "./server/store";
import {
  cancelRequestRpc,
  createRequestRpc,
  recordInstructionRpc,
  watchStateSubscription,
} from "./shared/model";
import { coordinatorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // 등록해야 클라이언트 useSettings 가 쓰는 읽기·쓰기 RPC 가 생긴다.
  const settings = server.registerSettings(coordinatorSettings);
  const store = new StateStore();

  server.handle(createRequestRpc, (input) => createRequest(input, store, settings));
  server.handle(cancelRequestRpc, (input) => cancelRequest(input, store));
  server.handle(recordInstructionRpc, (input) => recordInstruction(input, store));

  // promise 를 반환하면 그 promise 가 끝날 때 구독이 닫힌다 (SDK 계약). 처음 상태만 보내고 닫혀서
  // 이후 변경이 화면에 안 갔던 버그가 있었다 (2026-11-25). 그래서 일반 함수로 두고 signal 로만 닫는다.
  server.handle(watchStateSubscription, (_input, { push, signal }) => {
    // 구독이 막 끊긴 순간에 보내면 실패할 수 있다. 다음 구독이 처음에 전체 상태를 받으므로 버려도 된다.
    const send = (state: Parameters<typeof push>[0]) => {
      push(state).catch(() => undefined);
    };
    const unsubscribe = store.subscribe(send);
    signal.addEventListener("abort", unsubscribe, { once: true });
    store.read().then(send, (error) => console.error("[coordinator] could not read state", error));
  });

  return () => {};
}
