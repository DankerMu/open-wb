import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OmpFrame } from "./frame.js";
import type { OmpExit, OmpProcess } from "./process.js";
import type { FrameStream } from "./prompt-stream.js";
import type { PromptDispatchReceipt, SessionClock } from "./runtime.js";

interface NativeWaiter {
  promise: Promise<OmpExit>;
  resolve: (exit: OmpExit) => void;
}

interface SpawnWaiter {
  promise: Promise<ChildProcessWithoutNullStreams | undefined>;
  resolve: (child: ChildProcessWithoutNullStreams | undefined) => void;
}

interface ReceiptWaiter {
  promise: Promise<PromptDispatchReceipt>;
  resolve: (receipt: PromptDispatchReceipt) => void;
  reject: (error: Error) => void;
}

export interface Generation {
  id: number;
  proc: OmpProcess;
  child: ChildProcessWithoutNullStreams | undefined;
  native: OmpExit | undefined;
  nativeWait: NativeWaiter;
  spawnWait: SpawnWaiter;
  boot: Promise<{ sessionFile: string }>;
  acquired: boolean;
  spawnFailed: boolean;
  revoked: boolean;
  retiring: Promise<void> | undefined;
  drainTimer: unknown;
  graceTimer: unknown;
}

export interface Turn {
  genId: number;
  requestId: string;
  stream: FrameStream;
  sent: boolean;
  dispatched: ReceiptWaiter;
  receiptSettled: boolean;
}

// A child that never obtained a pid (spawn failed) is never live, whether or not
// Node has reported the failure yet; 'error' alone never means "dead" (#205).
export function liveChild(gen: Generation): ChildProcessWithoutNullStreams | undefined {
  const child = gen.child ?? gen.proc.child;
  if (
    child === undefined ||
    typeof child.pid !== "number" ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return undefined;
  }
  return child;
}

export function stdoutEnded(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.stdout.readableEnded || child.stdout.destroyed) {
      resolve();
      return;
    }
    child.stdout.once("end", resolve);
    child.stdout.once("close", resolve);
  });
}

export function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
}

export function raceDelay(
  clock: SessionClock,
  done: Promise<unknown>,
  ms: number,
): Promise<"exit" | "timeout"> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(() => {
      resolve("timeout");
    }, ms);
    void done.then(
      () => {
        clock.clearTimeout(timer);
        resolve("exit");
      },
      () => {
        clock.clearTimeout(timer);
        resolve("exit");
      },
    );
  });
}

export function deferredExit(): NativeWaiter {
  let resolve!: (exit: OmpExit) => void;
  const promise = new Promise<OmpExit>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function deferredSpawn(): SpawnWaiter {
  let resolve!: (child: ChildProcessWithoutNullStreams | undefined) => void;
  const promise = new Promise<ChildProcessWithoutNullStreams | undefined>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function deferredReceipt(): ReceiptWaiter {
  let resolve!: (receipt: PromptDispatchReceipt) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PromptDispatchReceipt>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function isTerminalEnd(frame: OmpFrame): boolean {
  return frame.type === "agent_end" && frame.isTerminal !== false;
}

export function isLocalComplete(frame: OmpFrame, requestId: string): boolean {
  if (frame.id !== requestId) {
    return false;
  }
  if (frame.type === "prompt_result") {
    return frame.agentInvoked === false;
  }
  if (frame.type !== "response" || frame.command !== "prompt" || frame.success !== true) {
    return false;
  }
  return asRecord(frame.data).agentInvoked === false;
}

export function isMatchingFailure(frame: OmpFrame, requestId: string): boolean {
  return (
    frame.type === "response" &&
    frame.id === requestId &&
    frame.command === "prompt" &&
    frame.success === false
  );
}

function asRecord(value: unknown): OmpFrame {
  return value !== null && typeof value === "object" ? (value as OmpFrame) : {};
}
