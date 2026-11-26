import type { PaseoApi } from "./paseo-api";
import type { CoordinatorState, Task } from "../shared/model";
import type { StateStore } from "./store";

/** 작업의 outbox 에 메시지를 더한다. 상태를 바꾸는 같은 store.update 안에서 쓴다 (아래 WorkerChannel 설명). */
export function queued(task: Task, text: string): Task {
  return { ...task, outbox: [...task.outbox, { text, at: new Date().toISOString() }] };
}

/**
 * 워커에게 메시지를 보내는 길. 워커가 일하는 중이거나 권한을 기다리는 중에 보내면 진행 중인 턴이 끊기고
 * 대기 중인 권한 요청이 거절된다 (RULES.md §13). 그래서 메시지는 항상 작업의 outbox 를 거쳐, 워커가 쉴 때만 나간다.
 * 플러그인이 보내는 메시지라 Paseo 가 감싸지 않는다.
 *
 * 상태를 running 으로 바꾸는 쪽은 같은 store.update 안에서 outbox 에 메시지를 넣어야 한다. 상태를 먼저 바꾸고 나중에
 * 보내면, 그 사이에 보정 검사(Dispatcher.reconcile)가 쉬고 있는 워커를 '턴이 끝났다'고 판정한다.
 */
export class WorkerChannel {
  constructor(private readonly store: StateStore) {}

  /** outbox 에 넣고 바로 내보내 본다. 워커가 바쁘면 쌓인 채로 두고, 턴이 끝날 때 나간다. */
  async deliver(paseo: PaseoApi, requestId: string, taskNumber: number, text: string): Promise<"sent" | "queued"> {
    await this.store.update((state) => ({ state: patchTask(state, requestId, taskNumber, (task) => queued(task, text)), result: undefined }));
    return (await this.flush(paseo, requestId, taskNumber)) ? "sent" : "queued";
  }

  /**
   * 쌓인 메시지를 워커가 쉬고 있으면 한 번에 보낸다. 보냈으면 true.
   * 꺼내기와 비우기를 한 번의 update 로 해서 그 사이에 더해진 메시지를 잃지 않고, 보내기가 실패하면 되돌려 넣는다.
   * 결정 카드가 열린 작업(blocker)에는 보내지 않는다. 보내면 카드가 열린 채 워커가 다시 일하고, 그사이 끝내도 머지 카드가
   * 뜨지 않으며, 사람이 나중에 고른 결정이 또 간다 (2026-11-26 전수 검사). 쌓인 메시지는 사람의 결정과 함께 나간다.
   * 취소된 작업에도 보내지 않는다. 그 워커는 정리됐다.
   */
  async flush(paseo: PaseoApi, requestId: string, taskNumber: number): Promise<boolean> {
    const before = await this.task(requestId, taskNumber);
    if (!before?.agentId || before.outbox.length === 0 || before.blocker || before.status === "canceled") return false;
    const snapshot = await paseo.agents.ref(before.agentId).refresh().catch(() => null);
    if (!snapshot || snapshot.agent.status === "running" || (snapshot.agent.pendingPermissions?.length ?? 0) > 0) return false;
    const taken = await this.store.update((state) => {
      const task = findTask(state, requestId, taskNumber);
      if (!task?.agentId || task.outbox.length === 0 || task.blocker || task.status === "canceled") return { state, result: null };
      return { state: patchTask(state, requestId, taskNumber, (current) => ({ ...current, outbox: [] })), result: { agentId: task.agentId, outbox: task.outbox } };
    });
    if (!taken) return false;
    try {
      await paseo.agents.ref(taken.agentId).send(taken.outbox.map((item) => item.text).join("\n\n---\n\n"));
      return true;
    } catch (error) {
      await this.store.update((state) => ({
        state: patchTask(state, requestId, taskNumber, (task) => ({ ...task, outbox: [...taken.outbox, ...task.outbox] })),
        result: undefined,
      }));
      throw error;
    }
  }

  private async task(requestId: string, taskNumber: number): Promise<Task | null> {
    return findTask(await this.store.read(), requestId, taskNumber);
  }
}

function findTask(state: CoordinatorState, requestId: string, taskNumber: number): Task | null {
  return state.requests.find((item) => item.id === requestId)?.tasks.find((task) => task.number === taskNumber) ?? null;
}

function patchTask(state: CoordinatorState, requestId: string, taskNumber: number, change: (task: Task) => Task): CoordinatorState {
  return {
    ...state,
    requests: state.requests.map((request) =>
      request.id === requestId
        ? { ...request, tasks: request.tasks.map((task) => (task.number === taskNumber ? change(task) : task)) }
        : request,
    ),
  };
}
