import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cleanupTaskWorkspaces } from "./server/cleanup";
import { CompletionRunner, reportDoneTool } from "./server/completion";
import { CoordinatorRuntime, answerCoordinatorPermission, isCoordinatorSession } from "./server/coordinator";
import { listBranches, resolveBaseRef } from "./server/branches";
import { Dispatcher } from "./server/dispatcher";
import { COORDINATOR_PROMPT } from "./server/prompt";
import {
  acknowledge,
  answerQuestions,
  askCoordinator,
  cancelRequest,
  createRequest,
  recordInstruction,
  resolveBlocker,
  retryTask,
  revisePlan,
  cancelTask,
} from "./server/requests";
import { ReviewRunner, isReviewerSession } from "./server/review";
import { WorkerChannel } from "./server/worker-channel";
import { isWorkerSession, reportBlockerTool } from "./server/worker-tools";
import { StateStore } from "./server/store";
import {
  closeCompletionRpc,
  retryTaskRpc,
  retryCoordinatorRpc,
  cancelTaskRpc,
  enableRuleRpc,
  reviewAutoDecisionRpc,
  acknowledgeRpc,
  answerQuestionsRpc,
  askCoordinatorRpc,
  resolveBlockerRpc,
  cancelRequestRpc,
  createRequestRpc,
  listBranchesRpc,
  recordInstructionRpc,
  revisePlanRpc,
  watchStateSubscription,
} from "./shared/model";
import { coordinatorSettings } from "./shared/settings";

/** 주기 검사 간격. 다시 알리기 기준(1분)과 보정 검사 간격(15초)보다 길게 둔다. */
const PERIODIC_CHECK_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  // 주기 검사가 쓸 Paseo API. hook 과 RPC 가 받을 때마다 기억한다.
  let lastPaseo: Parameters<typeof coordinator.notify>[0] | null = null;
  const remember = (paseo: Parameters<typeof coordinator.notify>[0]) => {
    lastPaseo = paseo;
  };
  // 등록해야 클라이언트 useSettings 가 쓰는 읽기·쓰기 RPC 가 생긴다.
  const settings = server.registerSettings(coordinatorSettings);
  const store = new StateStore();
  const logFailure = (what: string) => (error: unknown) => console.error(`[coordinator] ${what} failed`, error);
  const channel = new WorkerChannel(store);
  // 변경 요청은 마지막 PR 이 머지되면 끝난다. 그 요청의 코디네이터도 정리한다.
  const onRequestDone = (paseo: Parameters<typeof coordinator.retire>[0], requestId: string) => {
    coordinator.retire(paseo, requestId).catch(logFailure("retire coordinator"));
  };
  // 조사가 코디네이터에게 돌아왔거나 실패한 막힘 보고를 다시 처리하면 코디네이터가 할 일이 생긴다. 워커의 턴 종료는 코디네이터
  // 알림을 부르지 않으므로 여기서 알린다.
  const dispatcher = new Dispatcher(store, settings, channel, onRequestDone, (paseo) => tellCoordinator(paseo));
  const completions = new CompletionRunner(store, channel, onRequestDone);
  const coordinator = new CoordinatorRuntime(
    store,
    settings,
    (paseo) => {
      dispatcher.run(paseo).catch(logFailure("dispatch"));
    },
    channel,
    // 코디네이터가 작업을 취소했다. 워커를 정리하고 남은 작업으로 요청을 마무리한다. 모두 취소됐으면 코디네이터도 정리한다.
    (paseo, requestId, agentIds, requestCanceled) => {
      if (requestCanceled) coordinator.retire(paseo, requestId).catch(logFailure("retire coordinator"));
      dispatcher.afterCancel(paseo, requestId, agentIds).catch(logFailure("finish after coordinator cancel"));
    },
  );
  const tellCoordinator = (paseo: Parameters<typeof coordinator.notify>[0]) => {
    coordinator.notify(paseo).catch(logFailure("notify"));
  };
  const blockerTool = reportBlockerTool(store, tellCoordinator, (paseo, requestId, taskNumber, reviewerIds) => {
    reviews.abandon(paseo, requestId, taskNumber, reviewerIds).catch(logFailure("abandon review"));
  });
  const doneTool = reportDoneTool(store);
  const reviews = new ReviewRunner(store, settings, channel);
  coordinator.setReviewRunner(reviews);
  const reviewerTools = reviews.tools((paseo, requestId, taskNumber) => {
    reviews.finalize(paseo, requestId, taskNumber, "complete").catch(logFailure("finalize review"));
  });

  // 사람이 쓰는 화면에서만 부른다. 설정 화면에서 아직 저장하지 않은 프로젝트의 기준 브랜치도 고를 수 있게, 허용 목록이 아니라
  // 이 host 에 등록된 프로젝트면 읽는다. 브랜치 이름과 worktree 경로만 돌려준다.
  const projectRoot = async (paseo: Parameters<typeof coordinator.notify>[0], projectId: string) =>
    (await paseo.projects.list()).projects.find((project) => project.projectId === projectId)?.projectRootPath ?? null;
  server.handle(listBranchesRpc, async ({ projectId }, { paseo }) => {
    const root = await projectRoot(paseo, projectId);
    if (!root) throw new Error(`Project ${projectId} is not registered on this host.`);
    return listBranches(root);
  });
  server.handle(createRequestRpc, async (input, { paseo }) => {
    const result = await createRequest(input, store, settings, async (projectId, branch) => {
      const root = await projectRoot(paseo, projectId);
      return Boolean(root && (await resolveBaseRef(root, branch)));
    });
    // 코디네이터 생성과 알림은 오래 걸릴 수 있어서 요청 저장과 떼어 놓는다. 실패하면 다음 턴 종료 때 다시 시도한다.
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(cancelRequestRpc, async (input, { paseo }) => {
    const result = await cancelRequest(input, store);
    coordinator.retire(paseo, input.id).catch(logFailure("retire coordinator"));
    // 취소한 요청의 워커와 검토자도 멈춘다. 그대로 두면 계속 일해서 push 나 PR 까지 할 수 있다.
    // 워크스페이스는 남긴다. 워커가 만든 변경을 사람이 확인할 수 있어야 한다.
    const canceled = (await store.read()).requests.find((item) => item.id === input.id);
    if (canceled?.status === "canceled") {
      for (const task of canceled.tasks) {
        const review = task.blocker?.review;
        if (review?.status === "running") await reviews.abandon(paseo, canceled.id, task.number, review.reviewers.map((item) => item.agentId));
        if (task.agentId && task.status !== "done") await paseo.agents.ref(task.agentId).archive().catch(logFailure("archive worker"));
      }
    }
    return result;
  });
  server.handle(revisePlanRpc, async (input, { paseo }) => {
    const result = await revisePlan(input, store);
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(acknowledgeRpc, async (input, { paseo }) => {
    const result = await acknowledge(input, store);
    // 답변을 확인하면 읽기 요청이 끝난다. 그 요청의 코디네이터와 조사 워크스페이스·브랜치도 정리한다.
    const request = (await store.read()).requests.find((item) => item.id === input.id);
    if (request?.status === "done") {
      coordinator.retire(paseo, input.id).catch(logFailure("retire coordinator"));
      if (request.kind === "read") cleanupTaskWorkspaces(paseo, request.tasks).catch(logFailure("clean up investigations"));
    }
    return result;
  });
  server.handle(retryCoordinatorRpc, async (input, { paseo }) => {
    await coordinator.retry(paseo, input.id);
    return {};
  });
  server.handle(answerQuestionsRpc, async (input, { paseo }) => {
    const result = await answerQuestions(input, store);
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(recordInstructionRpc, (input) => recordInstruction(input, store));
  server.handle(enableRuleRpc, async ({ rule }) => {
    await store.update((state) => ({
      state: { ...state, disabledRules: state.disabledRules.filter((item) => item !== rule) },
      result: undefined,
    }));
    return {};
  });
  server.handle(reviewAutoDecisionRpc, async (input, { paseo }) => {
    await reviews.reviewAutoDecision(paseo, input);
    return {};
  });
  server.handle(resolveBlockerRpc, async (input, { paseo }) => {
    const { abandonedReviewers } = await resolveBlocker(input, store);
    if (abandonedReviewers.length) await reviews.abandon(paseo, input.requestId, input.taskNumber, abandonedReviewers);
    await channel.flush(paseo, input.requestId, input.taskNumber).catch(logFailure("send decision to worker"));
    return {};
  });
  server.handle(retryTaskRpc, async (input, { paseo }) => {
    const { hasWorker, orphanWorkspaceId } = await retryTask(input, store);
    if (hasWorker) await channel.flush(paseo, input.requestId, input.taskNumber).catch(logFailure("send retry to worker"));
    else {
      // 워커를 만들기 전에 실패한 작업의 worktree 는 새로 배정하면 아무도 쓰지 않는다. 고아로 남지 않게 정리한다.
      if (orphanWorkspaceId) await paseo.workspaces.ref(orphanWorkspaceId).archive().catch(logFailure("archive orphan workspace"));
      dispatcher.run(paseo).catch(logFailure("dispatch retry"));
    }
    return {};
  });
  server.handle(cancelTaskRpc, async (input, { paseo }) => {
    const { agentIds, requestCanceled } = await cancelTask(input, store);
    if (requestCanceled) coordinator.retire(paseo, input.requestId).catch(logFailure("retire coordinator"));
    await dispatcher.afterCancel(paseo, input.requestId, agentIds).catch(logFailure("finish after cancel"));
    return {};
  });
  server.handle(closeCompletionRpc, async (input, { paseo }) => {
    await completions.close(paseo, input);
    return {};
  });
  server.handle(askCoordinatorRpc, async (input, { paseo }) => {
    const result = await askCoordinator(input, store);
    tellCoordinator(paseo);
    return result;
  });

  // promise 를 반환하면 그 promise 가 끝날 때 구독이 닫힌다 (SDK 계약). 처음 상태만 보내고 닫혀서
  // 이후 변경이 화면에 안 갔던 버그가 있었다 (2026-11-25). 그래서 일반 함수로 두고 signal 로만 닫는다.
  server.handle(watchStateSubscription, (_input, { push, signal, paseo }) => {
    remember(paseo);
    // 화면이 열릴 때마다 계획이 필요한 요청이 남아 있는지 보고 코디네이터에게 알린다.
    // 플러그인 재시작이나 실패로 알림을 놓쳐도 사람이 화면을 열면 다시 이어진다.
    coordinator.notify(paseo).catch(logFailure("notify on subscribe"));
    reviews.reconcile(paseo).catch(logFailure("reconcile reviews"));
    dispatcher.run(paseo).catch(logFailure("dispatch on subscribe"));
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
    // 워커에게는 막힘·완료 보고 도구만, 검토자에게는 검토 도구 두 개만 붙인다.
    if (isWorkerSession(request.labels)) return { ...request, tools: [...request.tools, blockerTool, doneTool] };
    if (isReviewerSession(request.labels)) return { ...request, tools: [...request.tools, ...reviewerTools] };
    if (!isCoordinatorSession(request.labels)) return request;
    return {
      ...request,
      tools: [...request.tools, ...coordinator.tools()],
      appendSystemPrompt: [
        ...(request.appendSystemPrompt ?? []),
        COORDINATOR_PROMPT,
        `You coordinate request ${request.labels["paseo-coordinator.request"] ?? "(unknown)"} only. Its state lives in the plugin: always re-read it with coordinator_get_request instead of relying on earlier turns.`,
      ],
    };
  });

  // 코디네이터가 일을 마치면 그동안 쌓인 요청을 알린다. 열린 질문이나 읽지 않은 지시 때문에 미뤘던 요청 마무리도 이어 간다.
  // 워커가 일을 마치면 작업 상태를 바꾸고 다음 작업을 배정한다.
  server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    remember(paseo);
    const requestId = await coordinator.requestOf(agent.id);
    if (requestId) {
      await dispatcher.settleRequest(paseo, requestId).catch(logFailure("settle request after coordinator turn"));
      await coordinator.notify(paseo).catch(logFailure("notify after turn"));
      return;
    }
    await dispatcher.onWorkerTurn(paseo, agent.id, outcome).catch(logFailure("worker turn"));
  });

  // 코디네이터가 자기 전용 도구를 부를 때 권한 확인이 뜨면 기계적으로 허용한다. 이 도구는 요청을 읽고
  // 계획을 저장할 뿐이다. 그 밖의 권한 요청은 손대지 않아서 사람의 인박스로 간다.
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    remember(paseo);
    // 검토자는 읽기 전용이다. 검토 도구는 허용하고, 그 밖의 권한 요청은 모두 거절한다 (RULES.md §7).
    if (await reviews.findReview(agent.id)) {
      const allowed = request.kind === "tool" && request.name.includes("reviewer_");
      await paseo.agents
        .ref(agent.id)
        .respondToPermission({
          requestId: request.id,
          response: allowed
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Reviewers are read-only. Continue the review without this." },
        })
        .catch(logFailure("answer reviewer permission"));
      return;
    }
    // 워커가 보고 도구를 부를 때 권한 확인이 뜨면 허용한다. 보고하는 일 자체가 사람을 기다리면 안 된다.
    if (
      request.kind === "tool" &&
      (request.name.includes("report_blocker") || request.name.includes("report_done")) &&
      (await dispatcher.findWorker(agent.id))
    ) {
      await paseo.agents
        .ref(agent.id)
        .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
        .catch(logFailure("allow report_blocker"));
      return;
    }
    if (!(await coordinator.requestOf(agent.id))) return;
    console.log(`[coordinator] coordinator permission request: kind=${request.kind} name=${request.name}`);
    // 코디네이터는 자기 도구만 쓴다 (지침). 그 밖의 권한 요청은 거절해 코디네이터가 기다리며 멈추지 않게 한다.
    await answerCoordinatorPermission(paseo, agent.id, request);
  });

  // 알림형 hook 은 best-effort 라 유실될 수 있고, 다시 알리기와 보정 검사는 무언가가 불러야 돈다. 사람이 화면을 다시 열기 전까지
  // 아무 검사도 돌지 않던 문제를 막기 위해 주기적으로 돈다 (2026-11-26 전수 검사). Paseo API 는 hook·RPC 가 받은 것을 쓴다.
  const timer = setInterval(() => {
    if (!lastPaseo) return;
    coordinator.notify(lastPaseo).catch(logFailure("periodic notify"));
    // 코디네이터의 턴 종료 hook 이 유실돼도, 열린 질문이나 읽지 않은 지시 때문에 미뤘던 요청 마무리를 이어 간다.
    dispatcher.settleAll(lastPaseo).catch(logFailure("periodic settle"));
    reviews.reconcile(lastPaseo).catch(logFailure("periodic review reconcile"));
    dispatcher.run(lastPaseo).catch(logFailure("periodic dispatch"));
  }, PERIODIC_CHECK_MS);

  return () => clearInterval(timer);
}
