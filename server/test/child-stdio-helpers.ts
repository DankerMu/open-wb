/**
 * Issue #191 真实子进程 stdio 观察：输出只在 'close'（stdio 已关闭）之后才算完整，
 * 'exit' 或已置位的 exitCode 不代表管道已读尽。等待有界；超时与失败信息携带
 * 退出码、信号、字节数与 data/exit/close 事件顺序。调用方须先 setEncoding 再观察。
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

export interface ChildObserver {
  /** `code=… signal=… stdoutBytes=… stderrBytes=… events=…` */
  diagnostic(): string;
  /** 等到子进程 'close'；超时或 'error' 以带诊断的 Error 拒绝。 */
  waitClose(ms: number, label: string): Promise<void>;
}

export function observeChild(child: ChildProcessWithoutNullStreams): ChildObserver {
  const events: Array<{ name: string; count: number }> = [];
  const bytes = { stdout: 0, stderr: 0 };
  let closed = false;
  const record = (name: string): void => {
    const last = events.at(-1);
    if (last?.name === name) {
      last.count += 1;
    } else {
      events.push({ name, count: 1 });
    }
  };
  const counter =
    (stream: "stdout" | "stderr") =>
    (chunk: string | Buffer): void => {
      bytes[stream] += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      record(`${stream}-data`);
    };
  if (child.exitCode !== null || child.signalCode !== null) {
    record("exited-before-observe");
  }
  child.stdout.on("data", counter("stdout"));
  child.stderr.on("data", counter("stderr"));
  child.on("exit", () => record("exit"));
  child.on("close", () => {
    closed = true;
    record("close");
  });
  const diagnostic = (): string => {
    const order = events.map(({ name, count }) => (count > 1 ? `${name}x${count}` : name));
    return (
      `code=${child.exitCode} signal=${child.signalCode} stdoutBytes=${bytes.stdout} ` +
      `stderrBytes=${bytes.stderr} events=${order.length > 0 ? order.join(">") : "none"}`
    );
  };
  return {
    diagnostic,
    async waitClose(ms, label) {
      if (closed) {
        return;
      }
      try {
        await once(child, "close", { signal: AbortSignal.timeout(ms) });
      } catch (error) {
        const reason =
          error instanceof Error && error.name === "AbortError"
            ? `no close within ${ms}ms`
            : String(error);
        throw new Error(`${label}: ${reason}; ${diagnostic()}`, { cause: error });
      }
    },
  };
}
