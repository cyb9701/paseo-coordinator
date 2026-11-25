import type { PluginServerContext } from "@getpaseo/plugin/server";
import { coordinatorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  // 등록해야 클라이언트 useSettings 가 쓰는 읽기·쓰기 RPC 가 생긴다. 3b 단계부터 코디네이터가 이 값을 읽는다.
  server.registerSettings(coordinatorSettings);
  return () => {};
}
