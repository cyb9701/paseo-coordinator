/// <reference types="node" />

import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CoordinatorState, stateSchema } from "../shared/model";

// 보낸 지시 기록은 화면 표시용이라 오래된 것은 버린다.
const MAX_SENT = 200;

const EMPTY: CoordinatorState = { requests: [], sent: [], coordinator: null, disabledRules: [] };

/**
 * 플러그인 데이터 폴더. Paseo 는 플러그인 전용 저장 경로를 주지 않아서 daemon 홈 아래에 직접 만든다.
 * daemon 홈은 PASEO_HOME 이 있으면 그것, 없으면 ~/.paseo 다. 플러그인 프로세스는 daemon 환경을 물려받는다.
 */
export function dataDirectory(): string {
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(home, "plugin-data", "paseo-coordinator");
}

type Listener = (state: CoordinatorState) => void;

/**
 * 요청과 기록을 파일 하나에 둔다. 변경은 한 줄로 세워서 처리하고(동시에 두 변경이 서로 덮어쓰지 않게),
 * 임시 파일에 쓴 뒤 rename 해서 쓰는 도중 멈춰도 파일이 깨지지 않게 한다.
 */
export class StateStore {
  private state: CoordinatorState = EMPTY;
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
        const raw = JSON.parse(await readFile(this.file, "utf8"));
        const parsed = stateSchema.safeParse(raw);
        if (parsed.success) this.state = parsed.data;
        else await this.setAside(`state.json is invalid: ${parsed.error.message}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.setAside(`could not read state.json: ${String(error)}`);
      }
    })();
    return this.loaded;
  }

  /**
   * 읽지 못한 state.json 을 옆에 남기고 빈 상태로 시작한다. 그대로 두면 다음 저장이 원본을 빈 상태로 덮어써
   * 요청과 결정 기록이 모두 사라진다 (예: 새 버전이 쓴 값을 옛 버전이 읽을 때).
   */
  private async setAside(reason: string): Promise<void> {
    const backup = join(this.directory, `state.json.bad-${Date.now()}`);
    await copyFile(this.file, backup).catch(() => undefined);
    console.error(`[coordinator] ${reason}; kept a copy at ${backup} and starting empty`);
  }

  async read(): Promise<CoordinatorState> {
    await this.load();
    return this.state;
  }

  /** change 는 현재 상태를 받아 새 상태를 돌려준다. 반환값을 저장하고 구독자에게 알린다. */
  update<Result>(change: (state: CoordinatorState) => { state: CoordinatorState; result: Result }): Promise<Result> {
    const run = this.queue.then(async () => {
      await this.load();
      const { state, result } = change(this.state);
      const next = { ...state, sent: state.sent.slice(-MAX_SENT) };
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

  private async persist(state: CoordinatorState) {
    await mkdir(this.directory, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
    await rename(temp, this.file);
  }
}
