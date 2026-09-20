/**
 * Shared Issue #96 SessionRuntime test doubles: injected clock, token book, frame drain.
 */
import type { OmpFrame } from "../../src/sessions/omp/frame.js";

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
