/**
 * server-startup-order / -private-state / -omp-user 三个测试文件共用的启动夹具片段。
 * 只放跨文件共用的；单文件自用的辅助留在各自文件里。
 */

import { connect as connectTcp } from "node:net";

export const MODEL_ID = "issue-102-tracer-model";
export const SQLITE_EXPERIMENTAL_WARNING =
  "ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

export function expectRefused(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`unexpected listener on ${host}:${port}`));
    });
    socket.once("error", () => {
      socket.destroy();
      resolve();
    });
  });
}

/** 只去掉已知的 SQLite ExperimentalWarning。 */
export function applicationStderr(stderr: string): string {
  return stderr.replace(/^\(node:\d+\) /u, "").replace(SQLITE_EXPERIMENTAL_WARNING, "");
}
