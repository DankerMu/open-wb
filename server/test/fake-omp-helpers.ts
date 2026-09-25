/**
 * Issue #87 fake-omp 子进程夹具：真实 spawn + JSONL 帧收集 + 退出观察。
 * 由 fake-omp.test.ts 使用；不导入 fake-omp.mjs 本身。
 * 退出只在 'close'（stdio 已读尽）后记录（#191），帧等待与 waitExit 不会早于尾帧。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type ChildObserver, observeChild } from "./child-stdio-helpers.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const OMP_FLAGS = [
  "--mode",
  "rpc",
  "--cwd",
  "/tmp",
  "--session-dir",
  "/tmp/sessions",
  "--model",
  "workbuddy/deepseek-v4.1-flash",
  "--approval-mode",
  "yolo",
  "--no-extensions",
  "--no-lsp",
  "--no-pty",
  "--no-title",
];
export const HANDSHAKE = [
  { id: "protocol-1", type: "negotiate_protocol", protocolVersion: 2 },
  { id: "state-1", type: "get_state" },
];
export const PROMPT = { id: "req_1", type: "prompt", message: "Summarize this repo" };
/** 早于 vitest 缺省 5s 用例超时触发，超时诊断才可见。 */
const EXIT_MS = 4_000;

export type Frame = Record<string, unknown>;

const children: ChildProcessWithoutNullStreams[] = [];

/** afterEach 回收：仍存活的子进程一律 SIGKILL 并等待退出。 */
export async function stopFakeChildren(): Promise<void> {
  await Promise.all(children.splice(0).map(stopChild));
}

export interface Session {
  frames: Frame[];
  stdout: string;
  stderr: string;
  write(messages: Frame | Frame[]): void;
  wait(predicate: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  closeStdin(): void;
  waitExit(): Promise<number>;
}

export interface StartOptions {
  scenario?: string;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  prompt?: Frame;
}

const exitStatuses = new WeakMap<ChildProcessWithoutNullStreams, number>();
const observers = new WeakMap<ChildProcessWithoutNullStreams, ChildObserver>();

export function startFake(options: StartOptions = {}): Session {
  const args = [...OMP_FLAGS, ...(options.extraArgs ?? [])];
  if (options.scenario !== undefined) {
    args.push("--scenario", options.scenario);
  }
  const child = spawn(process.execPath, [FAKE, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "/usr/bin", ...options.env },
  });
  children.push(child);
  const frames: Frame[] = [];
  let stdout = "";
  let stderr = "";
  let pending = "";
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const recordExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    exitStatuses.set(child, exitStatus(code, signal));
    notify();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  observers.set(child, observeChild(child));
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        frames.push(JSON.parse(line) as Frame);
      }
      newline = pending.indexOf("\n");
    }
    notify();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    notify();
  });
  child.on("close", recordExit);
  return {
    frames,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    write(messages: Frame | Frame[]) {
      const list = Array.isArray(messages) ? messages : [messages];
      for (const message of list) {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    },
    wait(predicate, ms = 8_000) {
      return new Promise<Frame>((resolve, reject) => {
        const abort = AbortSignal.timeout(ms);
        const onAbort = (): void => {
          cleanup();
          reject(new Error(`timed out waiting for frame; got ${JSON.stringify(frames)}`));
        };
        const onChange = (): void => {
          const match = frames.find(predicate);
          if (match !== undefined) {
            cleanup();
            resolve(match);
            return;
          }
          if (observedExitStatus(child) !== undefined) {
            cleanup();
            reject(
              new Error(
                `child exited before frame; ${diagnosticOf(child)}; stdout=${stdout} stderr=${stderr}`,
              ),
            );
          }
        };
        const cleanup = (): void => {
          abort.removeEventListener("abort", onAbort);
          listeners.delete(onChange);
        };
        abort.addEventListener("abort", onAbort, { once: true });
        listeners.add(onChange);
        onChange();
      });
    },
    closeStdin() {
      child.stdin.end();
    },
    waitExit() {
      return waitExit(child);
    },
  };
}

export async function startPromptedSession(options: StartOptions = {}): Promise<Session> {
  const prompt = options.prompt ?? PROMPT;
  const session = startFake(options);
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("protocol-1", "negotiate_protocol"));
  await session.wait(response("state-1", "get_state"));
  session.write(prompt);
  await session.wait(response(String(prompt.id), "prompt"));
  return session;
}

export async function closeSession(session: Session): Promise<void> {
  session.closeStdin();
  await session.waitExit();
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (observedExitStatus(child) === undefined) {
    child.kill("SIGKILL");
  }
  await waitExit(child);
}

/** 仅 'close' 记录的状态算数：exitCode/signalCode 置位时 stdout 可能尚未读尽。 */
function observedExitStatus(child: ChildProcessWithoutNullStreams): number | undefined {
  return exitStatuses.get(child);
}

function diagnosticOf(child: ChildProcessWithoutNullStreams): string {
  return observers.get(child)?.diagnostic() ?? "unobserved child";
}

function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal === null ? 0 : 1);
}

async function waitExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  const observer = observers.get(child);
  if (observer === undefined) {
    throw new Error("fake omp child is not observed");
  }
  await observer.waitClose(EXIT_MS, "fake omp waitExit");
  return observedExitStatus(child) ?? exitStatus(child.exitCode, child.signalCode);
}

export function response(id: string, command: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "response" && frame.id === id && frame.command === command;
}

export function isTextDelta(frame: Frame): boolean {
  return (
    frame.type === "message_update" && asRecord(frame.assistantMessageEvent).type === "text_delta"
  );
}

export function asRecord(value: unknown): Frame {
  return value !== null && typeof value === "object" ? (value as Frame) : {};
}

/** OpenAI 兼容 SSE：每个 delta 一个事件，末尾 `[DONE]`。 */
export function sse(deltas: Frame[]): string {
  const events = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  return `${events.join("")}data: [DONE]\n\n`;
}

/** delta.tool_calls 分片：id/name 只在调用方给出时出现（首片）。 */
export function fragment(index: number, args: string, id?: string, name?: string): Frame {
  return {
    index,
    ...(id === undefined ? {} : { id, type: "function" }),
    function: { ...(name === undefined ? {} : { name }), arguments: args },
  };
}

/** 落在 `char` 的 UTF-8 编码内部的字节偏移，用于强制跨写入切开多字节字符。 */
export function splitInside(payload: Buffer, char: string, into: number): number {
  const start = payload.indexOf(Buffer.from(char, "utf8"));
  if (start < 0) {
    throw new Error(`missing ${char} in test payload`);
  }
  return start + into;
}
