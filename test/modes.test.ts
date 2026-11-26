/// <reference types="node" />

/**
 * 모든 에이전트를 Auto 모드로 띄운다 (2026-11-27 사용자 결정). Auto 가 허용한 호출은 플러그인의 권한 hook 에 오지 않으므로,
 * 코디네이터와 검토자가 하면 안 되는 일은 도구에서 빼서 막는다. 실행: npm test
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { COORDINATOR_BLOCKED_TOOLS, REVIEWER_BLOCKED_TOOLS, preapprovedOptions } from "../server/preapprove";

describe("Auto 모드의 도구 제한", () => {
  test("코디네이터는 파일·명령·내장 읽기·Paseo 변경 도구를 쓸 수 없고, 플러그인 도구를 불러오는 ToolSearch 는 남는다", () => {
    const options = preapprovedOptions("claude/claude-opus-5-5", ["coordinator_get_request"], COORDINATOR_BLOCKED_TOOLS)!;
    assert.deepEqual(options.allowedTools, ["mcp__paseo__coordinator_get_request"]);
    for (const tool of ["Bash", "Read", "Write", "Edit", "Grep", "mcp__paseo__create_agent", "mcp__paseo__archive_workspace"]) {
      assert.ok(options.disallowedTools?.includes(tool), tool);
    }
    assert.ok(!options.disallowedTools?.includes("ToolSearch"));
    assert.ok(!options.disallowedTools?.some((tool) => tool.includes("coordinator_")));
  });

  test("검토자는 근거 확인에 필요한 Bash·Read 는 쓰고, 워커의 worktree 를 바꾸는 쓰기 도구는 쓸 수 없다", () => {
    const options = preapprovedOptions("claude/claude-sonnet-5-5", ["reviewer_submit_verdict"], REVIEWER_BLOCKED_TOOLS)!;
    for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "mcp__paseo__send_agent_prompt"]) assert.ok(options.disallowedTools?.includes(tool), tool);
    for (const tool of ["Bash", "Read", "Grep"]) assert.ok(!options.disallowedTools?.includes(tool), tool);
  });

  test("워커는 막는 도구 없이 플러그인 도구만 미리 허용한다. 운영 작업이 승인된 worktree 를 archive_workspace 로 지운다 (r15)", () => {
    assert.deepEqual(preapprovedOptions("claude/opus", ["report_done"]), { allowedTools: ["mcp__paseo__report_done"] });
  });

  test("Claude 밖의 provider 에는 Claude 옵션을 넣지 않는다", () => {
    assert.equal(preapprovedOptions("codex/gpt-5.5", ["report_done"], COORDINATOR_BLOCKED_TOOLS), undefined);
  });
});
