import type { AgentToolContext } from "@getpaseo/plugin/server";

/**
 * Paseo API 타입. `@getpaseo/client` 에서 직접 가져오면 GitHub 에서 설치할 때 빌드가 실패한다.
 * 설치한 플러그인에는 node_modules 가 없고, 호스트는 `@getpaseo/plugin` 같은 제공 모듈만 풀어 주기 때문이다
 * (`paseo plugin install git:…` 이 "Could not resolve type dependency" 로 실패한다). 그래서 SDK 가 export 하는 타입에서 꺼낸다.
 */
export type PaseoApi = AgentToolContext["paseo"];
