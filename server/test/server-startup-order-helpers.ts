/**
 * server-startup-order / -private-state / -omp-user / -preview 与 listener-shutdown 几个测试文件共用的启动夹具片段；
 * `startListenTraced` 另供各配置测试的入口拒绝用例与 server-startup-failure-reason / -layout 的启动失败用例。
 * 只放跨文件共用的；单文件自用的辅助留在各自文件里。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect as connectTcp, createServer, type Server } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { StartedServer } from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

export const MODEL_ID = "issue-102-tracer-model";
export const CONTINUE_LINE = "HTTP/1.1 100 Continue\r\n\r\n";
export const SQLITE_EXPERIMENTAL_WARNING =
  "ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";

/** 一次启动的监听留痕：用例分到的主端口，与该次 trace 里的监听行。 */
export interface ListenerTrace {
  port: number;
  /** trace 里的监听行（`listening:` / `listener-close:`），按写入次序；没有 trace 文件即没有。 */
  listenerLines(): string[];
}

/** 经 `startListenTraced` 起的一次启动：返回的那次尝试与它自己的 trace。 */
export interface ListenTracedStart extends ListenerTrace {
  server: StartedServer;
}

/** `startListenTraced` 的一次尝试：没有 `orderTrace`，由助手注入。 */
interface ListenLaunch {
  env: Record<string, string>;
  requireHook?: string;
  stdout?: number;
}

let traceSeq = 0;

/** `traceDir` 下一个从未用过的 trace 文件：`path` 交给 `orderTrace`，监听行事后读。 */
export function freshListenTrace(traceDir: string): {
  path: string;
  listenerLines(): string[];
} {
  traceSeq += 1;
  const path = join(traceDir, `listen-trace-${traceSeq}.log`);
  return { path, listenerLines: () => listenerLinesOf(path) };
}

/**
 * 入口拒绝类用例（#1821）与启动失败用例（#1825）的启动：包住 `startCompiledServerWithRetry`，由这里给
 * 每次尝试注入新的 `orderTrace`（`traceDir` 下、被测托管目录之外），调用方的 launch 没有这个参数，省不掉。
 * 「从未监听」「端口已释放」以子进程自己的 listen / close 留痕判定，不再事后 connect 或 bind 一个早已
 * 释放、整机都能占的端口。`launchFor` 每次尝试调用一次，可以异步（如每次新取 `PREVIEW_PORT`）；
 * `stdout` 同 `startCompiledServer`。调用方 env 里的 `NODE_OPTIONS` 会盖掉预加载、让「没有监听行」空过，直接抛错。
 */
export async function startListenTraced(
  entry: string,
  traceDir: string,
  launchFor: (port: number) => ListenLaunch | Promise<ListenLaunch>,
): Promise<ListenTracedStart> {
  let lines = (): string[] => [];
  const { server, port } = await startCompiledServerWithRetry(entry, async (port) => {
    const launch = await launchFor(port);
    if ("NODE_OPTIONS" in launch.env) {
      throw new Error(
        "SETUP: caller env sets NODE_OPTIONS, which replaces the listen-trace preload",
      );
    }
    const trace = freshListenTrace(traceDir);
    lines = trace.listenerLines;
    return { ...launch, orderTrace: trace.path };
  });
  return { server, port, listenerLines: () => lines() };
}

/** 失败在 `app.listen` 之前（config / db 等）：trace 里没有任何监听行。 */
export function expectNeverListened(started: ListenerTrace): void {
  expect(started.listenerLines()).toEqual([]);
}

/** 失败在主端口绑定之后、预览 listen 之前（state_layout / sandbox_root）：主端口恰一次绑定与关闭，预览从未绑定。 */
export function expectMainPortListenedOnce(started: ListenerTrace): void {
  expect(started.listenerLines()).toEqual([
    `listening:127.0.0.1:${started.port}`,
    `listener-close:${started.port}`,
  ]);
}

/** 失败在预览绑定（preview_listen）：主端口绑定，预览从未绑定（`-`）并先关，主端口随后关闭。 */
export function expectPreviewListenFailed(started: ListenerTrace): void {
  expect(started.listenerLines()).toEqual([
    `listening:127.0.0.1:${started.port}`,
    "listener-close:-",
    `listener-close:${started.port}`,
  ]);
}

/**
 * 失败在两次 listen 之后：两个端口各恰一次绑定与关闭，预览先关。`previewPort` 缺省（`PREVIEW_PORT`
 * 为 0，由系统分配）时从第二行取出，只要求是另一个正端口。
 */
export function expectBothPortsListenedOnce(started: ListenerTrace, previewPort?: number): void {
  const lines = started.listenerLines();
  const preview =
    previewPort ?? Number(/^listening:127\.0\.0\.1:(\d+)$/u.exec(lines[1] ?? "")?.[1]);
  expect(preview).toBeGreaterThan(0);
  expect(preview).not.toBe(started.port);
  expect(lines).toEqual([
    `listening:127.0.0.1:${started.port}`,
    `listening:127.0.0.1:${preview}`,
    `listener-close:${preview}`,
    `listener-close:${started.port}`,
  ]);
}

function listenerLinesOf(trace: string): string[] {
  if (!existsSync(trace)) {
    return [];
  }
  return readFileSync(trace, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("listening:") || line.startsWith("listener-close:"));
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

/** 后继进程能重新打开同一个库并读到迁移过的表：原进程已关闭它的句柄。 */
export function expectDbReopens(path: string): void {
  const db = new DatabaseSync(path);
  try {
    expect(db.prepare("SELECT id FROM accounts WHERE id = 'u1'").get()).toEqual({ id: "u1" });
  } finally {
    db.close();
  }
}

/**
 * 主监听器绑定成功之后、两个托管文件写出之前的状态目录（#1337）：托管布局的七个顶层目录都在
 * （`session-config` 由 s1d-experts-skills 加入，`mounts` 由 s1b-workspace-mounts 加入），`models.yml` 与 `host-overlay.yml` 还没有。
 */
export function expectLayoutWithoutManagedFiles(state: string): void {
  expect(readdirSync(state).toSorted()).toEqual([
    "home",
    "mounts",
    "session-config",
    "sessions",
    "snapshots",
    "trash",
    "xdg",
  ]);
  expect(readdirSync(join(state, "home", ".omp", "agent"))).toEqual([]);
}

/**
 * 预加载：扣住进程里第 `nth` 次 `net.Server#listen`（1 = 主监听器，2 = 预览监听器）。进入时先装
 * SIGTERM 监听（由它写 LISTEN_RELEASE）、再落 LISTEN_ENTERED 标记，轮询到放行后才调原生 listen；
 * 测试自己写 LISTEN_RELEASE 同样放行（那时 signal 没有中止，绑定照常完成）。
 * 入口自己的 SIGTERM 处理与本监听在同一次 emit 内同步执行，原生 listen 只在其后的定时器宏任务里
 * 才被调用：它拿到的 signal 若被入口中止，此刻必然已经中止。这是把「信号落在 listen 调用与实际
 * 绑定之间」拉宽成可确定复现的窗口，不是生产里会出现的调用次序。
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
