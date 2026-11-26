import type { PaseoApi } from "./paseo-api";
import type { Task } from "../shared/model";
import type { StateStore } from "./store";

/**
 * 워커에게 메시지를 보내는 길. 워커가 일하는 중이거나 권한을 기다리는 중에 보내면 진행 중인 턴이 끊기고
 * 대기 중인 권한 요청이 거절된다 (RULES.md §13). 그래서 그때는 작업의 outbox 에 쌓아 두고, 워커의 턴이 끝나면 보낸다.
 * 플러그인이 보내는 메시지라 Paseo 가 감싸지 않는다.
 */
export class WorkerChannel {
  constructor(private readonly store: StateStore) {}

  async deliver(paseo: PaseoApi, requestId: string, taskNumber: number, text: string): Promise<"sent" | "queued"> {
    const task = await this.task(requestId, taskNumber);
    if (!task?.agentId) throw new Error(`Task ${requestId}/${taskNumber} has no worker yet.`);
    const snapshot = await paseo.agents.ref(task.agentId).refresh().catch(() => null);
    const busy =
      !snapshot || snapshot.agent.status === "running" || (snapshot.agent.pendingPermissions?.length ?? 0) > 0;
    if (busy) {
      await this.patch(requestId, taskNumber, (current) => ({
        outbox: [...current.outbox, { text, at: new Date().toISOString() }],
      }));
      return "queued";
    }
    await paseo.agents.ref(task.agentId).send(text);
    return "sent";
  }

  /** 워커의 턴이 끝났을 때 쌓인 메시지를 한 번에 보낸다. 보냈으면 true. */
  async flush(paseo: PaseoApi, requestId: string, taskNumber: number): Promise<boolean> {
    const task = await this.task(requestId, taskNumber);
    if (!task?.agentId || task.outbox.length === 0) return false;
    const text = task.outbox.map((item) => item.text).join("\n\n---\n\n");
    await this.patch(requestId, taskNumber, () => ({ outbox: [] }));
    await paseo.agents.ref(task.agentId).send(text);
    return true;
  }

  private async task(requestId: string, taskNumber: number): Promise<Task | null> {
    const request = (await this.store.read()).requests.find((item) => item.id === requestId);
    return request?.tasks.find((task) => task.number === taskNumber) ?? null;
  }

  private patch(requestId: string, taskNumber: number, change: (task: Task) => Partial<Task>): Promise<void> {
    return this.store.update((state) => ({
      state: {
        ...state,
        requests: state.requests.map((request) =>
          request.id === requestId
            ? {
                ...request,
                tasks: request.tasks.map((task) => (task.number === taskNumber ? { ...task, ...change(task) } : task)),
              }
            : request,
        ),
      },
      result: undefined,
    }));
  }
}
