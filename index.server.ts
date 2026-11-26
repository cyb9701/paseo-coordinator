import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CompletionRunner, reportDoneTool } from "./server/completion";
import { COORDINATOR_TOOL_PREFIX, CoordinatorRuntime, isCoordinatorSession } from "./server/coordinator";
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
  revisePlan,
} from "./server/requests";
import { ReviewRunner, isReviewerSession } from "./server/review";
import { WorkerChannel } from "./server/worker-channel";
import { isWorkerSession, reportBlockerTool } from "./server/worker-tools";
import { StateStore } from "./server/store";
import {
  closeCompletionRpc,
  enableRuleRpc,
  reviewAutoDecisionRpc,
  acknowledgeRpc,
  answerQuestionsRpc,
  askCoordinatorRpc,
  resolveBlockerRpc,
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
  const logFailure = (what: string) => (error: unknown) => console.error(`[coordinator] ${what} failed`, error);
  const channel = new WorkerChannel(store);
  // 변경 요청은 마지막 PR 이 머지되면 끝난다. 그 요청의 코디네이터도 정리한다.
  const onRequestDone = (paseo: Parameters<typeof coordinator.retire>[0], requestId: string) => {
    coordinator.retire(paseo, requestId).catch(logFailure("retire coordinator"));
  };
  const dispatcher = new Dispatcher(store, settings, channel, onRequestDone);
  const completions = new CompletionRunner(store, channel, onRequestDone);
  const coordinator = new CoordinatorRuntime(
    store,
    settings,
    (paseo) => {
      dispatcher.run(paseo).catch(logFailure("dispatch"));
    },
    channel,
  );
  const tellCoordinator = (paseo: Parameters<typeof coordinator.notify>[0]) => {
    coordinator.notify(paseo).catch(logFailure("notify"));
  };
  const blockerTool = reportBlockerTool(store, tellCoordinator);
  const doneTool = reportDoneTool(store);
  const reviews = new ReviewRunner(store, settings, channel);
  coordinator.setReviewRunner(reviews);
  const reviewerTools = reviews.tools((paseo, requestId, taskNumber) => {
    reviews.finalize(paseo, requestId, taskNumber, "complete").catch(logFailure("finalize review"));
  });

  server.handle(createRequestRpc, async (input, { paseo }) => {
    const result = await createRequest(input, store, settings);
    // 코디네이터 생성과 알림은 오래 걸릴 수 있어서 요청 저장과 떼어 놓는다. 실패하면 다음 턴 종료 때 다시 시도한다.
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(cancelRequestRpc, async (input, { paseo }) => {
    const result = await cancelRequest(input, store);
    coordinator.retire(paseo, input.id).catch(logFailure("retire coordinator"));
    return result;
  });
  server.handle(revisePlanRpc, async (input, { paseo }) => {
    const result = await revisePlan(input, store);
    coordinator.notify(paseo).catch(logFailure("notify"));
    return result;
  });
  server.handle(acknowledgeRpc, async (input, { paseo }) => {
    const result = await acknowledge(input, store);
    // 답변을 확인하면 읽기 요청이 끝난다. 그 요청의 코디네이터도 정리한다.
    const request = (await store.read()).requests.find((item) => item.id === input.id);
    if (request?.status === "done") coordinator.retire(paseo, input.id).catch(logFailure("retire coordinator"));
    return result;
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
    const message = await resolveBlocker(input, store);
    await channel.deliver(paseo, input.requestId, input.taskNumber, message);
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

  // 코디네이터가 일을 마치면 그동안 쌓인 요청을 알린다. 워커가 일을 마치면 작업 상태를 바꾸고 다음 작업을 배정한다.
  server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    if (await coordinator.requestOf(agent.id)) {
      await coordinator.notify(paseo).catch(logFailure("notify after turn"));
      return;
    }
    await dispatcher.onWorkerTurn(paseo, agent.id, outcome).catch(logFailure("worker turn"));
  });

  // 코디네이터가 자기 전용 도구를 부를 때 권한 확인이 뜨면 기계적으로 허용한다. 이 도구는 요청을 읽고
  // 계획을 저장할 뿐이다. 그 밖의 권한 요청은 손대지 않아서 사람의 인박스로 간다.
  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
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
    if (request.kind !== "tool" || !request.name.includes(COORDINATOR_TOOL_PREFIX)) return;
    await paseo.agents
      .ref(agent.id)
      .respondToPermission({ requestId: request.id, response: { behavior: "allow" } })
      .catch(logFailure("allow coordinator tool"));
  });

  return () => {};
}
