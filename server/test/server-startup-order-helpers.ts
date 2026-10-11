/**
 * server-startup-order / -private-state / -omp-user / -preview 与 listener-shutdown 几个测试文件共用的启动夹具片段。
 * 只放跨文件共用的；单文件自用的辅助留在各自文件里。
 */

import { connect as connectTcp, createServer, type Server } from "node:net";

export const MODEL_ID = "issue-102-tracer-model";
export const CONTINUE_LINE = "HTTP/1.1 100 Continue\r\n\r\n";
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

export interface PartialRequest {
  received(): string;
  closed: Promise<void>;
  destroy(): void;
}

/**
 * 发出头部完整、body 永不补齐的请求（Content-Length 大于已写字节）。
 * `Expect: 100-continue` 让服务端在解析完头部后回 100，作为请求已被接受的确定性信号。
 */
export async function openPartialRequest(port: number, target: string): Promise<PartialRequest> {
  const socket = connectTcp({ host: "127.0.0.1", port });
  let received = "";
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("error", () => undefined);
  socket.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const accepted = new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: string) => {
      received += chunk;
      if (received.includes(CONTINUE_LINE)) {
        resolve();
      }
    });
    socket.once("close", () => reject(new Error(`closed before 100 Continue: ${received}`)));
  });
  socket.write(
    `POST ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
      "Content-Length: 64\r\nExpect: 100-continue\r\n\r\n",
  );
  await accepted;
  socket.write('{"partial":');
  return { received: () => received, closed, destroy: () => socket.destroy() };
}

/** 占住 127.0.0.1 上的一个端口，直到调用方关掉返回的 server。 */
export function holdPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const holder = createServer();
    holder.once("error", reject);
    holder.listen(port, "127.0.0.1", () => resolve(holder));
  });
}

/**
 * 预加载：扣住进程里第 `nth` 次 `net.Server#listen`（1 = 预览监听器，2 = 主监听器）。进入时先装
 * SIGTERM 监听（由它写 LISTEN_RELEASE）、再落 LISTEN_ENTERED 标记，轮询到放行后才调原生 listen。
 * 入口自己的 SIGTERM 处理与本监听在同一次 emit 内同步执行，原生 listen 只在其后的定时器宏任务里
 * 才被调用：它拿到的 signal 必然已经中止。这是把「信号落在 listen 调用与实际绑定之间」拉宽成可
 * 确定复现的窗口，不是生产里会出现的调用次序。
 */
export function heldListenHook(nth: 1 | 2): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    "const nativeListen = net.Server.prototype.listen;",
    "let calls = 0;",
    "net.Server.prototype.listen = function heldListen(...args) {",
    "  calls += 1;",
    `  if (calls !== ${nth}) {`,
    "    return nativeListen.apply(this, args);",
    "  }",
    "  process.once('SIGTERM', () => fs.writeFileSync(process.env.LISTEN_RELEASE, ''));",
    "  fs.writeFileSync(process.env.LISTEN_ENTERED, '');",
    "  const poll = () => {",
    "    if (fs.existsSync(process.env.LISTEN_RELEASE)) {",
    "      nativeListen.apply(this, args);",
    "      return;",
    "    }",
    "    setTimeout(poll, 10);",
    "  };",
    "  poll();",
    "  return this;",
    "};",
    "",
  ].join("\n");
}
