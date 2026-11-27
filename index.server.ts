import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addRequestRpc,
  askAgentRpc,
  dismissRequestRpc,
  agentRequestsRpc,
  answerDecisionsRpc,
  fileDiffRpc,
  reviewDecisionsRpc,
  sendSuggestionRpc,
  sendInstructionRpc,
  summarizeRpc,
  watchStateSubscription,
  workspaceStatusRpc,
} from "./shared/model";
import { type CoordinatorSettings, type Language, coordinatorSettings, outputLanguage } from "./shared/settings";
import { AGENT_TOOL_NAMES, agentInstructions, decisionTools } from "./server/agent-tools";
import { Actions, answerFromQuestion } from "./server/actions";
import { AgentGoneError, Outbox } from "./server/outbox";
import type { PaseoApi } from "./server/paseo-api";
import { replayLostCalls } from "./server/replay";
import { StateStore } from "./server/store";
import { Summarizer, isSummarizer } from "./server/summary";
import { mergeRuns, recentExchanges } from "./server/timeline";
import { WorkspaceStatusReader } from "./server/workspace-status";
import { WorkspaceDirectory, workspaceDirectoryPath } from "./server/workspaces";

/** hook 이 유실돼도 쌓인 메시지가 나가도록 도는 간격. */
const PERIODIC_MS = 60_000;

/** 플러그인 도구는 daemon 의 "paseo" MCP 서버로 나가서, Claude 에서는 이 접두사가 붙은 이름이 된다. */
const PLUGIN_MCP_PREFIX = "mcp__paseo__";

const OUR_TOOL_NAMES = new Set(AGENT_TOOL_NAMES.flatMap((name) => [name, `${PLUGIN_MCP_PREFIX}${name}`]));

/** 에이전트의 마지막 응답. 질문하기의 답으로 붙인다. */
async function lastAgentText(paseo: PaseoApi, agentId: string): Promise<string | null> {
  const exchanges = mergeRuns(await recentExchanges(paseo, agentId, 60).catch(() => []));
  return [...exchanges].reverse().find((item) => item.role === "agent")?.text ?? null;
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(coordinatorSettings);
  const readSettings = async (): Promise<CoordinatorSettings> => {
    const state = await settings.read();
    if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
    return state.values;
  };
  const store = new StateStore();
  const directory = new WorkspaceDirectory();
  const statuses = new WorkspaceStatusReader(directory);
  // 추가 요청을 보내면 그 요청을 sent 로 바꾼다. actions 는 outbox 를 받으므로 늦게 묶는다.
  const outbox: Outbox = new Outbox(store, (requestIds): Promise<void> => actions.markSent(requestIds));
  const summarizer = new Summarizer(store, readSettings, directory, statuses);
  const actions: Actions = new Actions(store, outbox);
  const logFailure = (what: string) => (error: unknown) => console.error(`[coordinator] ${what} failed`, error);

  // 앱 언어. 서버는 모르므로 화면이 구독할 때 알려 주고, 상태 파일에 남겨 재시작 뒤에도 쓴다. 요약과 결정 기록을 사람이 읽을 언어로
  // 쓰게 하는 데 쓴다. 한 번도 알려 준 적이 없으면 null 이다. 이때 en 으로 가정하면 한국어로 일하는 에이전트에게 결정을 영어로 쓰라고
  // 지시하게 된다.
  const appLanguage = async (): Promise<Language | null> => (await store.read()).appLanguage;
  let lastPaseo: PaseoApi | null = null;

  /**
   * 결정 기록 도구를 붙일 세션인지. 사람이 설정에서 고른 프로젝트의 워크스페이스에 있고, 사람이 보는 세션(background 가 아님)이어야 한다.
   * 요약 에이전트처럼 플러그인이 띄우는 helper 는 background 라 빠진다.
   */
  const watchedWorkspace = async (paseo: PaseoApi, workspaceId: string | null) => {
    if (!workspaceId) return null;
    const values = await readSettings();
    // 지켜보는 프로젝트가 없으면 daemon 에 묻지 않는다. 이 hook 은 모든 에이전트의 모든 세션 열기와 턴 끝에 돈다.
    if (!values.projectIds.length) return null;
    const entry = await directory.find(paseo, workspaceId);
    if (!entry || !values.projectIds.includes(entry.projectId)) return null;
    return { entry, values };
  };

  const tools = decisionTools(store, {
    locate: async (agent, paseo) => {
      const found = await watchedWorkspace(paseo, agent.workspaceId);
      return found ? { workspaceId: found.entry.id, projectId: found.entry.projectId, cwd: workspaceDirectoryPath(found.entry) } : null;
    },
  });

  server.addHook("agent.open.before", async ({ request }, { paseo }) => {
    lastPaseo = paseo;
    if (request.background || request.purpose !== "interactive" || isSummarizer(request)) return request;
    const found = await watchedWorkspace(paseo, request.workspaceId).catch((error) => {
      console.error("[coordinator] could not check the workspace of a session", error);
      return null;
    });
    if (!found) return request;
    return {
      ...request,
      tools: [...request.tools, ...tools],
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), agentInstructions(outputLanguage(found.values, await appLanguage()))],
    };
  });

  // 결정 기록 도구를 부를 때마다 권한 확인이 뜨지 않게 Claude 의 허용 목록에 넣는다. 권한 hook 으로 허용해도 Paseo 는 그 전에
  // "권한 필요" 알림을 보낸다. 이 값은 에이전트에 저장되므로 지켜보는 프로젝트의 폴더에서 만드는 에이전트에만 넣는다.
  server.addHook("agent.create.before", async ({ request }, { paseo }) => {
    if (request.config.provider !== "claude") return request;
    const values = await readSettings().catch(() => null);
    if (!values?.projectIds.length) return request;
    const cwd = request.config.cwd;
    const entries = await directory.list(paseo).catch(() => []);
    const watched = entries.some(
      (entry) => values.projectIds.includes(entry.projectId) && (workspaceDirectoryPath(entry) === cwd || entry.projectRootPath === cwd),
    );
    if (!watched) return request;
    const options = request.config.providerOptions ?? {};
    const allowed = Array.isArray(options.allowedTools) ? (options.allowedTools as string[]) : [];
    const ours = AGENT_TOOL_NAMES.map((name) => `${PLUGIN_MCP_PREFIX}${name}`).filter((name) => !allowed.includes(name));
    if (!ours.length) return request;
    return { ...request, config: { ...request.config, providerOptions: { ...options, allowedTools: [...allowed, ...ours] } } };
  });

  server.addHook("agent.permission.before", async ({ agent, request }, { paseo }) => {
    lastPaseo = paseo;
    if (request.kind === "question") {
      // 질문하기로 물었던 것이 있으면, 에이전트가 다시 질문 창을 띄우기 전에 쓴 응답이 그 답이다.
      await actions.recordAskAnswer(agent.id, await lastAgentText(paseo, agent.id)).catch(logFailure("record ask answer"));
      // 플러그인 재시작으로 잃은 결정이 있으면 질문 창이 뜨기 전에 되살린다. 그래야 결정 카드 안에 이 질문이 들어가고, 답하면 결정에 남는다.
      const found = await watchedWorkspace(paseo, agent.workspaceId).catch(() => null);
      if (found) {
        const where = { workspaceId: found.entry.id, projectId: found.entry.projectId, cwd: workspaceDirectoryPath(found.entry) };
        await replayLostCalls(paseo, store, agent.id, where).catch(logFailure("replay lost tool calls"));
        // 질문 창으로 물으면 답할 때까지 턴이 끝나지 않는다. 턴 끝을 기다리지 않고 지금 앞뒤 상황을 요약한다.
        await summarizer.afterTurn(paseo, agent.id, found.entry.id, false, await appLanguage(), found.values).catch(logFailure("summary on question"));
      }
    }
    const respond = (response: { behavior: "allow" } | { behavior: "deny"; message: string }) =>
      paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response }).catch(logFailure("answer permission"));
    // 요약 에이전트는 받은 글만 정리한다. 어떤 도구도 쓰지 않는다.
    if (isSummarizer(agent)) {
      await respond({ behavior: "deny", message: "You only summarize the text you were given. Answer with the JSON now." });
      return;
    }
    // 결정을 기록하는 일이 사람의 승인을 기다리면 안 된다. 기록은 상태 파일에만 쓴다.
    // 이름 끝만 비교하면 다른 MCP 서버의 같은 이름 도구도 허용된다. 이 플러그인 도구의 이름과 정확히 같을 때만 허용한다.
    if (request.kind === "tool" && OUR_TOOL_NAMES.has(request.name)) await respond({ behavior: "allow" });
  });

  // 에이전트의 질문 창(AskUserQuestion)에 사람이 답하면 그 에이전트의 멈춘 결정에 그 답을 남긴다. 질문 창의 답은 updatedInput.answers 로
  // 온다. 요청 종류를 기억해 두지 않고 답의 모양으로 가린다. 기억해 두면 플러그인이 다시 시작될 때 잃는다.
  // 건너뛰기(거절)면 결정은 그대로 답을 기다린다. 카드의 답 칸으로 다시 답할 수 있다.
  server.addHook("agent.permission.after", async ({ agent, resolution }) => {
    if (resolution.behavior !== "allow") return;
    const answers = (resolution.updatedInput as { answers?: unknown } | undefined)?.answers;
    if (!answers || typeof answers !== "object") return;
    await answerFromQuestion(store, agent.id, resolution.updatedInput).catch(logFailure("record question answer"));
  });

  server.addHook("agent.turn.after", async ({ agent, outcome }, { paseo }) => {
    lastPaseo = paseo;
    if (agent.background) return;
    if ((await store.read()).asks.some((item) => item.agentId === agent.id && !item.answer)) {
      await actions.recordAskAnswer(agent.id, await lastAgentText(paseo, agent.id)).catch(logFailure("record ask answer"));
    }
    await outbox.flush(paseo, agent.id).catch((error) => {
      if (!(error instanceof AgentGoneError)) logFailure("flush outbox")(error);
    });
    const found = await watchedWorkspace(paseo, agent.workspaceId).catch(() => null);
    if (!found) return;
    const where = { workspaceId: found.entry.id, projectId: found.entry.projectId, cwd: workspaceDirectoryPath(found.entry) };
    await replayLostCalls(paseo, store, agent.id, where).catch(logFailure("replay lost tool calls"));
    await summarizer
      .afterTurn(paseo, agent.id, found.entry.id, outcome.kind === "failed", await appLanguage(), found.values)
      .catch(logFailure("summary after turn"));
  });

  // 답을 기다리던 에이전트가 archive 되면 그 카드는 답할 곳이 없다. 사람의 인박스에 영영 남지 않게 내린다.
  server.addHook("agent.archive.after", async ({ agent }) => {
    await store.update((state) => {
      if (!state.decisions.some((item) => item.agentId === agent.id && item.status === "waiting")) return { state, result: undefined };
      return {
        state: {
          ...state,
          decisions: state.decisions.map((item) => (item.agentId === agent.id && item.status === "waiting" ? { ...item, status: "dropped" as const } : item)),
        },
        result: undefined,
      };
    });
  });

  // 워크스페이스가 archive 되면 그 안의 결정은 답하거나 확인할 곳이 없다(diff 도 볼 수 없고 받을 에이전트도 없다). 확인 필요에
  // 영영 남지 않게 내린다. 끝난 결정 기록은 그대로 둔다.
  // 받기 전의 추가 요청과 제안도 받을 곳이 없어지므로 닫는다. 보내지 않은 요청은 outbox 에서도 뺀다.
  server.addHook("workspace.archive.after", async ({ workspace }) => {
    const pending = (await store.read()).requests.filter((item) => item.workspaceId === workspace.id && item.status === "queued");
    for (const item of pending) await outbox.withdraw(item.id).catch(logFailure("withdraw request"));
    await store.update((state) => {
      const open = (item: (typeof state.decisions)[number]) => item.workspaceId === workspace.id && (item.status === "waiting" || item.status === "unreviewed");
      const waiting = (item: (typeof state.requests)[number]) => item.workspaceId === workspace.id && (item.status === "queued" || item.status === "suggested");
      if (!state.decisions.some(open) && !state.requests.some(waiting)) return { state, result: undefined };
      return {
        state: {
          ...state,
          decisions: state.decisions.map((item) => (open(item) ? { ...item, status: "dropped" as const } : item)),
          requests: state.requests.map((item) => (waiting(item) ? { ...item, status: "dismissed" as const } : item)),
        },
        result: undefined,
      };
    });
  });

  server.handle(watchStateSubscription, (input, { push, signal, paseo }) => {
    store
      .update((state) => (state.appLanguage === input.language ? { state, result: undefined } : { state: { ...state, appLanguage: input.language }, result: undefined }))
      .catch(logFailure("save app language"));
    lastPaseo = paseo;
    outbox.flushAll(paseo).catch(logFailure("flush on subscribe"));
    const send = (state: Parameters<typeof push>[0]) => {
      push(state).catch(() => undefined);
    };
    const unsubscribe = store.subscribe(send);
    signal.addEventListener("abort", unsubscribe, { once: true });
    store.read().then(send, logFailure("read state"));
  });

  server.handle(answerDecisionsRpc, (input, { paseo }) => actions.answer(paseo, input.agentId, input.text));
  server.handle(reviewDecisionsRpc, (input, { paseo }) => actions.review(paseo, input));
  server.handle(sendInstructionRpc, async (input, { paseo }) => {
    await outbox.ensureReachable(paseo, input.agentId);
    return { delivery: await outbox.deliver(paseo, input.agentId, input.text) };
  });
  server.handle(summarizeRpc, async (input, { paseo }) => {
    const snapshot = await paseo.agents.ref(input.agentId).refresh();
    const workspaceId = snapshot?.agent.workspaceId;
    if (!workspaceId) throw new Error("This agent is not in a workspace.");
    summarizer.request(paseo, input.agentId, workspaceId, "manual", input.language);
    return {};
  });
  server.handle(addRequestRpc, async (input, { paseo }) => {
    const entry = await directory.find(paseo, input.workspaceId);
    return actions.addRequest(paseo, { ...input, projectId: entry?.projectId ?? null });
  });
  server.handle(sendSuggestionRpc, (input, { paseo }) => actions.sendSuggestion(paseo, input.id, input.agentId));
  server.handle(dismissRequestRpc, (input) => actions.dismissRequest(input.id));
  server.handle(askAgentRpc, (input, { paseo }) => actions.ask(paseo, input.agentId, input.text));
  server.handle(workspaceStatusRpc, async (input, { paseo }) => {
    const values = await readSettings();
    return { workspaces: await statuses.read(paseo, values.projectIds, input.force), at: new Date().toISOString() };
  });
  server.handle(fileDiffRpc, (input, { paseo }) => statuses.diff(paseo, input.workspaceId, input.files));
  server.handle(agentRequestsRpc, async ({ agentId }, { paseo }) => {
    const exchanges = mergeRuns(await recentExchanges(paseo, agentId, 400));
    return { messages: exchanges.filter((item) => item.role === "user").map((item) => ({ text: item.text, at: item.at })) };
  });

  const timer = setInterval(() => {
    if (lastPaseo) outbox.flushAll(lastPaseo).catch(logFailure("periodic flush"));
  }, PERIODIC_MS);
  return () => clearInterval(timer);
}
