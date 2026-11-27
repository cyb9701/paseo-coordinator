/// <reference types="node" />

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CoordinatorState, EMPTY_STATE, stateSchema } from "../shared/model";

/** 끝난 결정과 요약은 화면에서 지난 기록으로만 보인다. 파일이 끝없이 커지지 않게 오래된 것부터 버린다. */
const MAX_DECISIONS = 600;
const MAX_SUMMARIES = 300;
const MAX_REQUESTS = 1000;
const MAX_ASKS = 300;

/**
 * 플러그인 데이터 폴더. Paseo 는 플러그인 전용 저장 경로를 주지 않아서 daemon 홈 아래에 만든다.
 * daemon 홈은 PASEO_HOME 이 있으면 그것, 없으면 ~/.paseo 다. 플러그인 프로세스는 daemon 환경을 물려받는다.
 */
export function dataDirectory(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-coordinator");
}

type Listener = (state: CoordinatorState) => void;

/** 오래된 것부터 버리되, 사람을 기다리는 것(멈춘 결정, 확인하지 않은 결정, 열린 후속 작업)은 남긴다. */
function trim(state: CoordinatorState): CoordinatorState {
  const keep = <T,>(items: T[], max: number, pinned: (item: T) => boolean) => {
    if (items.length <= max) return items;
    let drop = items.length - max;
    return items.filter((item) => {
      if (drop > 0 && !pinned(item)) {
        drop -= 1;
        return false;
      }
      return true;
    });
  };
  const waiting = new Set(state.decisions.filter((item) => item.status === "waiting").map((item) => item.id));
  return {
    ...state,
    decisions: keep(state.decisions, MAX_DECISIONS, (item) => item.status === "waiting" || item.status === "unreviewed"),
    // 답을 기다리는 결정을 설명하는 요약을 버리면 같은 결정을 다시 요약한다.
    summaries: keep(state.summaries, MAX_SUMMARIES, (item) => item.status === "running" || item.decisionIds.some((id) => waiting.has(id))),
    requests: keep(state.requests, MAX_REQUESTS, (item) => item.status === "queued" || item.status === "suggested"),
    asks: keep(state.asks, MAX_ASKS, (item) => !item.answer),
  };
}

/**
 * 상태를 파일 하나에 둔다. 변경은 한 줄로 세워서 처리하고(두 변경이 서로 덮어쓰지 않게), 임시 파일에 쓴 뒤 rename 해서
 * 쓰는 도중 멈춰도 파일이 깨지지 않게 한다.
 */
export class StateStore {
  private state: CoordinatorState = EMPTY_STATE;
  private readonly listeners = new Set<Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private loaded: Promise<void> | null = null;

  constructor(private readonly directory = dataDirectory()) {}

  private get file() {
    return join(this.directory, "state.json");
  }

  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const parsed = stateSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
        if (parsed.success) this.state = interrupted(parsed.data);
        else await this.setAside(`state.json is invalid: ${parsed.error.message}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.setAside(`could not read state.json: ${String(error)}`);
      }
    })();
    return this.loaded;
  }

  /** 읽지 못한 파일을 옆에 남기고 빈 상태로 시작한다. 그대로 두면 다음 저장이 원본을 빈 상태로 덮어쓴다. */
  private async setAside(reason: string): Promise<void> {
    const backup = join(this.directory, `state.json.bad-${Date.now()}`);
    await copyFile(this.file, backup).catch(() => undefined);
    console.error(`[coordinator] ${reason}; kept a copy at ${backup} and starting empty`);
  }

  async read(): Promise<CoordinatorState> {
    await this.load();
    return this.state;
  }

  /** change 는 현재 상태를 받아 새 상태와 결과를 돌려준다. 상태가 같은 객체면 저장하지 않는다. */
  update<Result>(change: (state: CoordinatorState) => { state: CoordinatorState; result: Result }): Promise<Result> {
    const run = this.queue.then(async () => {
      await this.load();
      const { state, result } = change(this.state);
      if (state === this.state) return result;
      const next = trim(state);
      await this.persist(next);
      this.state = next;
      for (const listener of this.listeners) listener(next);
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 사람의 답, 에이전트 대화에서 뽑은 요약, 결정 근거가 들어 있어서 같은 컴퓨터의 다른 사용자가 읽지 못하게 한다. */
  private async persist(state: CoordinatorState) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }
}

/**
 * 플러그인이 다시 시작되면 돌던 요약은 끝나지 않는다. running 으로 남으면 같은 결정을 다시 요약하지 않고, 카드에도 다시 요청할 버튼이
 * 보이지 않아 영영 막힌다. 읽을 때 실패로 바꿔 다시 요청할 수 있게 한다.
 */
function interrupted(state: CoordinatorState): CoordinatorState {
  if (!state.summaries.some((item) => item.status === "running")) return state;
  return {
    ...state,
    summaries: state.summaries.map((item) =>
      item.status === "running" ? { ...item, status: "failed" as const, error: "The plugin restarted before the summary finished." } : item,
    ),
  };
}

export function nextId(state: CoordinatorState, prefix: string): { state: CoordinatorState; id: string; number: number } {
  const number = state.seq + 1;
  return { state: { ...state, seq: number }, id: `${prefix}${number}`, number };
}
