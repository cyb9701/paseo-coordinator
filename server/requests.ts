import type { PluginSettings } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type { cancelRequestRpc, createRequestRpc, recordInstructionRpc } from "../shared/model";
import type { settingsSchema } from "../shared/settings";
import type { StateStore } from "./store";

type Settings = PluginSettings<typeof settingsSchema>;

async function readSettings(settings: Settings) {
  const state = await settings.read();
  if (state.status !== "ready") throw new Error(`Coordinator settings are invalid: ${state.error}`);
  return state.values;
}

function resolveLanguage(setting: "auto" | "en" | "ko", locale: string): "en" | "ko" {
  if (setting !== "auto") return setting;
  return locale.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export async function createRequest(
  input: RpcInput<typeof createRequestRpc>,
  store: StateStore,
  settings: Settings,
): Promise<{ id: string }> {
  const values = await readSettings(settings);
  // 허용 목록 밖 프로젝트는 여기서 막는다. 화면은 허용된 프로젝트만 보여 주지만, RPC 는 다른 경로로도 불릴 수 있다.
  const outside = input.projectIds.filter((id) => !values.allowedProjectIds.includes(id));
  if (outside.length > 0) throw new Error(`Projects not allowed in coordinator settings: ${outside.join(", ")}`);
  if (values.allowedProjectIds.length === 0) {
    throw new Error("No projects are allowed. Choose projects in coordinator settings first.");
  }
  return store.update((state) => {
    const used = state.requests.map((request) => Number(request.id.slice(1))).filter(Number.isFinite);
    const id = `r${(used.length > 0 ? Math.max(...used) : 0) + 1}`;
    const request = {
      id,
      text: input.text,
      doneCriteria: input.doneCriteria || null,
      projectIds: input.projectIds,
      language: resolveLanguage(values.outputLanguage, input.locale),
      createdAt: new Date().toISOString(),
      status: "planning" as const,
      title: null,
      grade: null,
      tasks: [],
    };
    return { state: { ...state, requests: [...state.requests, request] }, result: { id } };
  });
}

export async function cancelRequest({ id }: RpcInput<typeof cancelRequestRpc>, store: StateStore) {
  await store.update((state) => {
    if (!state.requests.some((request) => request.id === id)) throw new Error(`Unknown request ${id}`);
    return {
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id === id && request.status !== "done" ? { ...request, status: "canceled" as const } : request,
        ),
      },
      result: undefined,
    };
  });
  return {};
}

export async function recordInstruction({ agentId, text }: RpcInput<typeof recordInstructionRpc>, store: StateStore) {
  await store.update((state) => ({
    state: { ...state, sent: [...state.sent, { agentId, text, at: new Date().toISOString() }] },
    result: undefined,
  }));
  return {};
}
