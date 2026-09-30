import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { OmpFrame } from "./frame.js";
import type { LocalSignal } from "./local-command.js";
import { AgentUnavailableError, type OmpExit, type OmpProcess } from "./process.js";
import type { FrameStream } from "./prompt-stream.js";
import type { PromptDispatchReceipt, SessionClock } from "./runtime.js";

export const TERM_GRACE_MS = 5_000;
export const KILL_GRACE_MS = 3_000;
const SHUTDOWN_BUDGET_MS = TERM_GRACE_MS + KILL_GRACE_MS;

export function nonempty(value: string | null): string | undefined {
  return value !== null && value.length > 0 ? value : undefined;
}

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

interface AbortWaiter {
  promise: Promise<OmpFrame>;
  resolve: (response: Promise<OmpFrame>) => void;
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
  /** Owner-marked pending approval ids; non-empty suspends idle; dropped with the generation. */
  pending: Set<string | number>;
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
  /** Dispatched wire text starts with `/` (local-command.ts). */
  slashText: boolean;
  /** A `command_output` frame arrived since this prompt was written. */
  commandOutputSeen: boolean;
  /** `agent_start` or the local-only outcome arrived: an `abort` may be written (#650). */
  started: boolean;
  /** `abort()` after the receipt but before the start: written at the start, else rejected. */
  deferredAbort: AbortWaiter | undefined;
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

function stdoutEnded(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    if (child.stdout.readableEnded || child.stdout.destroyed) {
      resolve();
      return;
    }
    child.stdout.once("end", resolve);
    child.stdout.once("close", resolve);
  });
}

function destroyStdio(child: ChildProcessWithoutNullStreams): void {
  child.stdout.destroy();
  child.stderr.destroy();
  child.stdin.destroy();
}

function raceDelay(
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

export async function awaitChild(
  gen: Generation,
): Promise<ChildProcessWithoutNullStreams | undefined> {
  if (gen.spawnFailed) {
    return undefined;
  }
  if (gen.child !== undefined || gen.native !== undefined) {
    return liveChild(gen) ?? gen.child;
  }
  const spawned = await gen.spawnWait.promise;
  if (gen.spawnFailed) {
    return undefined;
  }
  return liveChild(gen) ?? spawned ?? gen.child;
}

export function closeStdin(gen: Generation): void {
  (gen.child ?? gen.proc.child)?.stdin.end();
}

export function signalLive(gen: Generation, signal: NodeJS.Signals): void {
  if (liveChild(gen) === undefined) {
    return;
  }
  gen.proc.kill(signal);
}

export async function drainHeld(
  clock: SessionClock,
  gen: Generation,
  started: number,
): Promise<void> {
  const child = gen.child;
  if (child === undefined || child.stdout.readableEnded || child.stdout.destroyed) {
    return;
  }
  const remaining = SHUTDOWN_BUDGET_MS - Math.max(0, clock.now() - started);
  if (remaining <= 0) {
    destroyStdio(child);
    return;
  }
  const ended = stdoutEnded(child);
  if ((await raceDelay(clock, ended, remaining)) === "timeout") {
    destroyStdio(child);
  }
}

export function watchHeldPipe(
  clock: SessionClock,
  gen: Generation,
  isCurrent: () => boolean,
): void {
  const child = gen.child;
  if (child === undefined || child.stdout.readableEnded || child.stdout.destroyed) {
    return;
  }
  clearDrain(clock, gen);
  gen.drainTimer = clock.setTimeout(() => {
    if (isCurrent() && !child.stdout.readableEnded && !child.stdout.destroyed) {
      destroyStdio(child);
    }
  }, SHUTDOWN_BUDGET_MS);
}

export function clearDrain(clock: SessionClock, gen: Generation): void {
  if (gen.drainTimer !== undefined) {
    clock.clearTimeout(gen.drainTimer);
    gen.drainTimer = undefined;
  }
}

export function clearGrace(clock: SessionClock, gen: Generation): void {
  if (gen.graceTimer !== undefined) {
    clock.clearTimeout(gen.graceTimer);
    gen.graceTimer = undefined;
  }
}

export async function waitNative(
  clock: SessionClock,
  gen: Generation,
  ms: number,
): Promise<"exit" | "timeout"> {
  if (gen.native !== undefined) {
    return "exit";
  }
  return new Promise((resolve) => {
    gen.graceTimer = clock.setTimeout(() => {
      gen.graceTimer = undefined;
      resolve("timeout");
    }, ms);
    void gen.nativeWait.promise.then(
      () => {
        clearGrace(clock, gen);
        resolve("exit");
      },
      () => {
        clearGrace(clock, gen);
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

/**
 * omp v18.0.10 drops a prompt still pre-processing when `abort` arrives (generation bail, #650):
 * the turn has started once its `agent_start` or its local-only outcome reached the runtime.
 */
export function isTurnStart(frame: OmpFrame, requestId: string): boolean {
  return frame.type === "agent_start" || isLocalComplete(frame, requestId);
}

/** The turn's one deferred abort; a repeated call before the start gets the same Promise. */
export function deferAbort(turn: Turn): Promise<OmpFrame> {
  if (turn.deferredAbort === undefined) {
    let resolve!: (response: Promise<OmpFrame>) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<OmpFrame>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    void promise.catch(() => {});
    turn.deferredAbort = { promise, resolve, reject };
  }
  return turn.deferredAbort.promise;
}

/**
 * Settles the deferred abort at most once: with the response of the one frame `write` sends, or,
 * when `write` is absent (the gate closed), with `AgentUnavailableError` and no frame.
 */
export function openDeferredAbort(turn: Turn, write: (() => Promise<OmpFrame>) | undefined): void {
  const waiter = turn.deferredAbort;
  turn.deferredAbort = undefined;
  if (waiter !== undefined && write !== undefined) {
    waiter.resolve(write());
  } else {
    waiter?.reject(new AgentUnavailableError("turn ended before it started"));
  }
}

/** The turn can no longer start on a live generation: reject the deferred abort, write nothing. */
export function dropDeferredAbort(turn: Turn): void {
  openDeferredAbort(turn, undefined);
}

/** `abort()`'s gate, re-checked at the start frame: the turn's own live, non-retiring generation. */
export function canAbort(gen: Generation | undefined, turn: Turn): gen is Generation {
  return (
    gen !== undefined &&
    gen.id === turn.genId &&
    gen.retiring === undefined &&
    liveChild(gen) !== undefined
  );
}

export function isTerminalEnd(frame: OmpFrame): boolean {
  return frame.type === "agent_end" && frame.isTerminal !== false;
}

export function localSignal(frame: OmpFrame, requestId: string): LocalSignal {
  if (isLocalComplete(frame, requestId)) {
    return "local-outcome";
  }
  return frame.type === "command_output" ? "command-output" : "other";
}

function isLocalComplete(frame: OmpFrame, requestId: string): boolean {
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

/** A `get_state` response's nonempty `sessionFile`; undefined for any other command. */
export function stateSessionFile(request: OmpFrame, response: OmpFrame): string | undefined {
  const file = request.type === "get_state" ? asRecord(response.data).sessionFile : undefined;
  return typeof file === "string" && file.length > 0 ? file : undefined;
}

function asRecord(value: unknown): OmpFrame {
  return value !== null && typeof value === "object" ? (value as OmpFrame) : {};
}
