/// <reference types="node" />

/**
 * 완료 보고서 판정 (2026-11-27 사용자 결정: 작업마다 카드를 띄우지 않고 요청에서 더 진행할 일이 없을 때 보고서 하나로 알린다).
 * 실행: npm test
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { requestReport, stateSchema } from "../shared/model";

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const pr = {
  number: 1,
  url: "https://github.com/o/r/pull/1",
  title: "t",
  state: "OPEN",
  baseRefName: "main",
  headRefName: "coord/r1-1-x",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  mergeable: "MERGEABLE",
  checks: null,
  readAt: ago(1),
};

const done = (extra: Record<string, unknown> = {}) => ({
  status: "review",
  completion: { summary: "끝", verification: ["테스트 통과"], choices: [], left: [], pr: null, at: ago(5), ...extra },
});

function parse(extra: Record<string, unknown>, tasks: Record<string, unknown>[]) {
  return stateSchema.parse({
    sent: [],
    requests: [
      {
        id: "r1",
        text: "고쳐줘",
        doneCriteria: null,
        projectIds: ["p"],
        language: "ko",
        createdAt: ago(30),
        status: "running",
        kind: "change",
        grade: "C",
        title: "고치기",
        plannedAt: ago(20),
        coordinatorReadAt: ago(19),
        ...extra,
        tasks: tasks.map((task, index) => ({
          number: index + 1,
          name: `작업${index + 1}`,
          projectId: "p",
          dependsOn: [],
          status: "running",
          workspaceId: `ws${index + 1}`,
          agentId: `w${index + 1}`,
          ...task,
        })),
      },
    ],
  }).requests[0]!;
}

describe("requestReport", () => {
  test("작업 하나가 끝나도 다른 작업이 일하는 중이면 보고서를 띄우지 않는다", () => {
    assert.equal(requestReport(parse({}, [done({ pr }), {}])), null);
  });

  test("곧 시작할 대기 작업이 있으면 보고서를 띄우지 않는다 (끝난 작업 직후 배정 전의 짧은 틈)", () => {
    const request = parse({}, [done({ pr }), { status: "waiting", dependsOn: [1], workspaceId: null, agentId: null }]);
    assert.equal(requestReport(request), null);
  });

  test("막힌 작업이 있으면 보고서를 띄우지 않는다. 막힘은 자기 카드로 바로 뜬다", () => {
    assert.equal(requestReport(parse({}, [done(), { status: "blocked" }])), null);
  });

  test("열린 질문이나 읽지 않은 지시가 있으면 띄우지 않는다", () => {
    const question = { context: "c", questions: [{ question: "q", options: [{ label: "a" }, { label: "b" }], recommended: null }], at: ago(1) };
    assert.equal(requestReport(parse({ question }, [done()])), null);
    assert.equal(requestReport(parse({ feedback: [{ text: "멈춰", at: ago(1) }] }, [done()])), null);
  });

  test("PR 이 있으면 내 결정 필요, PR 도 남은 변경도 없으면 확인 필요다", () => {
    const merge = requestReport(parse({}, [done({ pr }), done()]));
    assert.equal(merge?.needsDecision, true);
    assert.deepEqual(merge?.completions.map((task) => task.number), [1, 2]);
    assert.equal(requestReport(parse({}, [done(), { status: "canceled" }]))?.needsDecision, false);
  });

  test("머지를 기다리는 운영 작업이 있어도 보고서를 띄운다. 띄우지 않으면 머지할 길이 없어 멈춘다", () => {
    const request = parse({}, [
      done({ pr }),
      { status: "waiting", kind: "operation", targets: ["coord/r1-1-x 삭제"], dependsOn: [1], workspaceId: null, agentId: null },
    ]);
    assert.equal(requestReport(request)?.needsDecision, true);
  });

  test("읽기 요청은 답변 카드가 보고서라서 따로 만들지 않는다", () => {
    assert.equal(requestReport(parse({ kind: "read", grade: null }, [{ status: "done" }])), null);
  });
});
