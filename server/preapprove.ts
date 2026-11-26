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

/**
 * 다른 에이전트와 워크스페이스를 바꾸는 Paseo 도구. Paseo 는 모든 에이전트에 이 MCP 도구를 붙인다. 코디네이터와 검토자는
 * 이전에는 권한을 묻는 모드라 이 도구를 부르면 플러그인이 거절했다. Auto 모드에서는 Auto 가 허용한 호출이 플러그인에 오지 않아,
 * 도구 자체를 빼야 막힌다 (2026-11-27 사용자 결정으로 모든 에이전트를 Auto 로 바꿨다). 읽기만 하는 도구(list_*, get_*)는 둔다.
 */
const PASEO_MUTATING_TOOLS = [
  "archive_agent",
  "archive_workspace",
  "cancel_agent",
  "create_agent",
  "create_heartbeat",
  "create_schedule",
  "create_terminal",
  "create_workspace",
  "delete_heartbeat",
  "delete_schedule",
  "kill_agent",
  "kill_terminal",
  "pause_schedule",
  "rename_workspace",
  "respond_to_permission",
  "resume_schedule",
  "run_schedule_once",
  "send_agent_prompt",
  "send_terminal_keys",
  "set_agent_mode",
  "start_workspace_script",
  "stop_workspace_script",
  "update_agent",
  "update_schedule",
].map((name) => `${PLUGIN_MCP_PREFIX}${name}`);

/** 파일을 바꾸는 Claude 내장 도구. */
const EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/**
 * 코디네이터는 coordinator_* 도구로만 일한다. 그 도구는 비밀 파일과 .gitignore 대상을 걸러 읽는데, 내장 Read·Grep·Bash 는 그 거름을
 * 건너뛰고, Bash 와 쓰기 도구는 코디네이터가 하지 않기로 한 일(파일 수정, 명령 실행)을 할 수 있다. Auto 모드에서는 이것을 묻지 않고
 * 허용하므로 도구에서 뺀다. ToolSearch 는 지연 로딩되는 플러그인 도구를 불러오는 데 필요해서 둔다.
 */
export const COORDINATOR_BLOCKED_TOOLS = [
  ...EDIT_TOOLS,
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  ...PASEO_MUTATING_TOOLS,
];

/**
 * 검토자는 워커의 worktree 에서 근거를 확인한다. 그 worktree 의 코드가 머지되므로 검토자가 파일을 바꾸면 안 된다. 근거 확인에
 * 읽기 명령이 필요해 Bash 와 Read 는 둔다. Bash 로 쓰는 것은 검토 지침이 막는다 [판단].
 */
export const REVIEWER_BLOCKED_TOOLS = [...EDIT_TOOLS, "Agent", "Task", ...PASEO_MUTATING_TOOLS];

/**
 * agents.create 의 config.options 에 넣을 값. allowedTools·disallowedTools 는 Claude provider 옵션에만 있어서 다른 provider 면
 * 넣지 않는다. 다른 provider 는 플러그인의 권한 hook 만 남는다.
 */
export function preapprovedOptions(
  model: string,
  toolNames: readonly string[],
  blocked: readonly string[] = [],
): { allowedTools: string[]; disallowedTools?: string[] } | undefined {
  if (model.split("/")[0] !== "claude") return undefined;
  return {
    allowedTools: toolNames.map((name) => `${PLUGIN_MCP_PREFIX}${name}`),
    ...(blocked.length > 0 ? { disallowedTools: [...blocked] } : {}),
  };
}
