/**
 * Shared Issue #96 SessionRuntime test doubles: injected clock, token book, frame drain,
 * real-child observation.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as waitTimeout } from "node:timers/promises";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import type { OmpExit } from "../../src/sessions/omp/process.js";

export type IteratorOutcome = "pending" | "done" | "frame" | "rejected";

export interface TokenBook {
  issued: string[];
  revoked: string[];
  live: Map<string, string>;
  issue(sessionId: string): string;
  revoke(sessionId: string): void;
}

export interface TestClock {
  nowMs: number;
  now(): number;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(id: unknown): void;
  advance(ms: number): void;
  pending(): number;
}

interface PendingTimer {
  id: number;
  due: number;
  callback: () => void;
}

export function createTokens(prefix: string): TokenBook {
  const issued: string[] = [];
  const revoked: string[] = [];
  const live = new Map<string, string>();
  let next = 0;
  return {
    issued,
    revoked,
    live,
    issue(sessionId) {
      next += 1;
      const token = `${prefix}-${next}`;
      issued.push(token);
      live.set(sessionId, token);
      return token;
    },
    revoke(sessionId) {
      const token = live.get(sessionId);
      if (token === undefined) {
        return;
      }
      live.delete(sessionId);
      revoked.push(token);
    },
  };
}

export function createClock(): TestClock {
  const timers = new Map<number, PendingTimer>();
  let nextId = 0;
  const clock: TestClock = {
    nowMs: 0,
    now() {
      return clock.nowMs;
    },
    setTimeout(callback, ms) {
      nextId += 1;
      timers.set(nextId, { id: nextId, due: clock.nowMs + ms, callback });
      return nextId;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
    advance(ms) {
      const target = clock.nowMs + ms;
      for (let timer = earliestDue(timers, target); timer !== undefined; ) {
        timers.delete(timer.id);
        clock.nowMs = timer.due;
        timer.callback();
        timer = earliestDue(timers, target);
      }
      clock.nowMs = target;
    },
    pending() {
      return timers.size;
    },
  };
  return clock;
}

export async function collectPrompt(iterable: AsyncIterable<OmpFrame>): Promise<OmpFrame[]> {
  const frames: OmpFrame[] = [];
  for await (const frame of iterable) {
    frames.push(frame);
  }
  return frames;
}

export async function collectUntilError(
  iterable: AsyncIterable<OmpFrame>,
): Promise<{ frames: OmpFrame[]; error: unknown }> {
  const frames: OmpFrame[] = [];
  try {
    for await (const frame of iterable) {
      frames.push(frame);
    }
    return { frames, error: undefined };
  } catch (error) {
    return { frames, error };
  }
}

export function observeIteratorResult(pending: Promise<IteratorResult<OmpFrame>>): {
  outcome: IteratorOutcome;
  result?: IteratorResult<OmpFrame>;
  error?: unknown;
} {
  const observation: {
    outcome: IteratorOutcome;
    result?: IteratorResult<OmpFrame>;
    error?: unknown;
  } = { outcome: "pending" };
  void pending.then(
    (result) => {
      observation.result = result;
      observation.outcome = result.done === true ? "done" : "frame";
    },
    (error: unknown) => {
      observation.error = error;
      observation.outcome = "rejected";
    },
  );
  return observation;
}

function earliestDue(timers: Map<number, PendingTimer>, limit: number): PendingTimer | undefined {
  let chosen: PendingTimer | undefined;
  for (const timer of timers.values()) {
    if (timer.due > limit) {
      continue;
    }
    if (chosen === undefined || timer.due < chosen.due) {
      chosen = timer;
    }
  }
  return chosen;
}

export interface ChildObservation {
  child: ChildProcessWithoutNullStreams;
  signals: NodeJS.Signals[];
  exits: OmpExit[];
  exit: Promise<OmpExit>;
  ready: Promise<void>;
  agentEnd: Promise<void>;
  stdinEnded: boolean;
}

export function requireIteratorReturn<T>(
  iterator: AsyncIterator<T>,
): () => Promise<IteratorResult<T>> {
  const cancel = iterator.return;
  if (cancel === undefined) {
    throw new Error("async iterator return is required for cancellation");
  }
  return () => cancel.call(iterator);
}

export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let waited = 0; waited < ms && !settled; waited += 5) {
    await waitTimeout(5);
  }
  return settled;
}

export function capturePromptWrites(
  child: ChildProcessWithoutNullStreams,
  prompts: string[],
): void {
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const frame = JSON.parse(line) as { type?: string; message?: string };
      if (frame.type === "prompt" && typeof frame.message === "string") {
        prompts.push(frame.message);
      }
    }
    return originalWrite(chunk, ...(rest as []));
  }) as typeof child.stdin.write;
}

export function observeChild(child: ChildProcessWithoutNullStreams): ChildObservation {
  const signals: NodeJS.Signals[] = [];
  const exits: OmpExit[] = [];
  const originalKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals) => {
    signals.push(signal ?? "SIGTERM");
    return originalKill(signal);
  }) as typeof child.kill;
  const exit = new Promise<OmpExit>((resolve) => {
    child.once("exit", (code, signal) => {
      const seen = { code, signal };
      exits.push(seen);
      resolve(seen);
    });
  });
  const watch: ChildObservation = {
    child,
    signals,
    exits,
    exit,
    ready: Promise.resolve(),
    agentEnd: Promise.resolve(),
    stdinEnded: false,
  };
  child.stdin.on("finish", () => {
    watch.stdinEnded = true;
  });
  child.stdin.on("close", () => {
    watch.stdinEnded = true;
  });
  const marker = Buffer.from("no-ready-hang:handlers-ready");
  watch.ready = new Promise<void>((resolve) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.includes(marker)) {
        child.stderr.off("data", onData);
        resolve();
      }
    };
    child.stderr.on("data", onData);
  });
  const agentEndMarker = Buffer.from('"type":"agent_end"');
  watch.agentEnd = new Promise<void>((resolve) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.includes(agentEndMarker)) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
  });
  return watch;
}
