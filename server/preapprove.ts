/**
 * 에이전트를 만들 때 이 플러그인의 도구를 Claude 의 allowedTools 로 넘겨, 권한 확인 없이 쓰게 한다.
 *
 * agent.permission.before 훅으로 허용해도 알림은 막지 못한다. Paseo 는 이 훅을 기다리지 않고(waits: false) 권한 요청이
 * 생기는 즉시 "Agent needs permission" 알림을 보낸다. 코디네이터가 coordinator_list_files 로 폴더를 훑을 때마다 알림이
 * 하나씩 떠서 수십 개가 쌓였다 (2026-11-26). 그래서 권한 요청 자체가 생기지 않게 한다. 훅은 이 옵션이 없는 에이전트
 * (이 변경 전에 만든 에이전트, Claude 밖의 provider)를 위해 그대로 둔다.
 *
 * config.toolPolicy.preapproved 는 쓸 수 없다. 데몬은 같은 요청의 mcpServers 에 그 서버가 있어야 한다고 검사하는데,
 * 플러그인 도구를 내보내는 "paseo" 서버는 그 검사 뒤에 데몬이 붙이고 이름도 예약돼 있다 (Paseo 0.17.4 에서 확인).
 */

/** 플러그인 도구는 데몬의 "paseo" MCP 서버로 나가서, Claude 에서는 이 접두사가 붙은 이름이 된다. */
const PLUGIN_MCP_PREFIX = "mcp__paseo__";

/** agents.create 의 config.options 에 넣을 값. allowedTools 는 Claude provider 옵션에만 있어서 다른 provider 면 넣지 않는다. */
export function preapprovedOptions(model: string, toolNames: readonly string[]): { allowedTools: string[] } | undefined {
  if (model.split("/")[0] !== "claude") return undefined;
  return { allowedTools: toolNames.map((name) => `${PLUGIN_MCP_PREFIX}${name}`) };
}
