/// <reference types="node" />

import { execFile } from "node:child_process";

// 플러그인 server 는 앱이 띄운 프로세스라 셸 프로필의 PATH 를 받지 못할 수 있다. Homebrew 위치를 덧붙인다.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean).join(":");

/** 셸을 거치지 않고 실행한다. 사람이나 코디네이터가 적은 브랜치 이름이 인자로 들어가도 셸 문법으로 해석되지 않는다. */
export function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: { ...process.env, PATH }, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim()}`));
      else resolve(stdout);
    });
  });
}
