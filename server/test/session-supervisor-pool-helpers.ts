/**
 * Issue #463 process-pool test plumbing: live-child sampling at every spawn, capped app
 * assembly, SQL-preset resume files, spawn-mode switching and real-child exit observation.
 * Oracles are Node's own child exit state and the recorded spawn argv, never pool internals.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { expect } from "vitest";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  closeOnEof,
  completeHeldTurn,
  emitAssistantDelta,
  openRecordingSession,
  type RuntimeOptions,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const CAPACITY_ENVELOPE = {
  error: { code: "agent_capacity", message: "Agent 容量已满，请稍后重试" },
} as const;
export const A_FILE = "/tmp/open-wb-463-a.jsonl";

interface Liveness {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

interface Observable<C extends Liveness> {
  runtime: RuntimeOptions;
  children: C[];
}

export function isLive(child: Liveness | undefined): boolean {
  return child !== undefined && child.exitCode === null && child.signalCode === null;
}

/**
 * Wraps the runtime's spawnImpl (before the app copies it): each spawn first records the indices
 * of the children still alive at that moment, as Node (or the FakeChild) reports them.
 */
export function sampleSpawns<C extends Liveness>(world: Observable<C>): number[][] {
  const liveAtSpawn: number[][] = [];
  const inner = world.runtime.spawnImpl;
  world.runtime.spawnImpl = (command, args, options) => {
    const live: number[] = [];
    world.children.forEach((child, index) => {
      if (isLive(child)) {
        live.push(index);
      }
    });
    liveAtSpawn.push(live);
    return inner(command, args, options);
  };
  return liveAtSpawn;
}

export function expectWithinCap(liveAtSpawn: readonly number[][], cap: number): void {
  expect(Math.max(0, ...liveAtSpawn.map((live) => live.length))).toBeLessThanOrEqual(cap - 1);
}

/** Every real spawn gets `--approval-mode write` appended (fake-omp: last occurrence wins). */
export function gateApprovals(runtime: RuntimeOptions): void {
  const inner = runtime.spawnImpl;
  runtime.spawnImpl = (command, args, options) =>
    inner(command, [...args, "--approval-mode", "write"], options);
}

type SpawnMode = "missing" | "throw" | "valid";

export interface SpawnModes {
  mode: SpawnMode;
  pids: Array<number | undefined>;
}

/** `missing` spawns a nonexistent absolute path (ENOENT, no pid); `throw` throws synchronously. */
export function switchSpawns(runtime: RuntimeOptions): SpawnModes {
  const state: SpawnModes = { mode: "valid", pids: [] };
  const inner = runtime.spawnImpl;
  const missing = join(runtime.sandboxRoot, "..", "missing-omp-463");
  runtime.spawnImpl = (command, args, options) => {
    if (state.mode === "throw") {
      state.pids.push(undefined);
      throw new Error("spawn threw synchronously");
    }
    const child =
      state.mode === "missing"
        ? spawnMissing(missing, args, options)
        : inner(command, args, options);
    state.pids.push(child.pid);
    return child;
  };
  return state;
}

const spawnMissing = (
  bin: string,
  args: readonly string[],
  options: Parameters<SpawnImpl>[2],
): ChildProcessWithoutNullStreams => {
  const child = spawn(bin, [...args], {
    cwd: typeof options.cwd === "string" ? options.cwd : undefined,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
  });
  child.on("error", () => {});
  return child;
};

export interface PoolWorld {
  fixture: SupervisorApp;
  cookie: string;
  sessions: string[];
  errors: Error[];
}

/** One app capped at `cap` with `count` sessions of the same owner. */
export async function openPool(
  runtime: RuntimeOptions,
  cap: number,
  count: number,
): Promise<PoolWorld> {
  const opened = await openRecordingSession({ ...runtime, maxProcesses: cap });
  const sessions = [opened.session];
  try {
    for (let n = 1; n < count; n += 1) {
      sessions.push(await createSessionFor(opened.fixture, opened.cookie));
    }
  } catch (error) {
    await opened.fixture.close().catch(() => undefined);
    throw error;
  }
  return { fixture: opened.fixture, cookie: opened.cookie, sessions, errors: opened.errors };
}

async function createSessionFor(fixture: SupervisorApp, cookie: string): Promise<string> {
  const response = await fixture.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

export function send(world: PoolWorld, session: string, message: string) {
  return postPrompt(world.fixture.app, session, world.cookie, JSON.stringify({ message }));
}

/** Store row is terminal, then one macrotask so the pump's finally has released its claim. */
export async function settledTurn(
  world: PoolWorld,
  session: string,
  status: "done" | "failed" = "done",
) {
  const tree = await waitForTurn(world.fixture, session, status);
  await waitImmediate();
  return tree;
}

export async function completed(world: PoolWorld, session: string, message: string) {
  const response = await send(world, session, message);
  expect(response.statusCode).toBe(202);
  return settledTurn(world, session);
}

export function presetSessionFile(db: DatabaseSync, session: string, file: string): void {
  db.prepare("UPDATE chat_sessions SET omp_session_file = ? WHERE id = ?").run(file, session);
}

export function expectCapacity(response: {
  statusCode: number;
  headers: Record<string, unknown>;
  json(): unknown;
}): void {
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual(CAPACITY_ENVELOPE);
  expect(response.headers["cache-control"]).toBe("no-store");
}

export function child<C>(children: readonly C[], index: number): C {
  const found = children[index];
  if (found === undefined) {
    throw new Error(`missing child ${String(index)}`);
  }
  return found;
}

export async function waitExited(target: Liveness, description: string): Promise<void> {
  await waitFor(() => (isLive(target) ? undefined : true), description);
}

/**
 * Registers after the runtime's own `exit` listener (attached at spawn), so the callback reads
 * the supervisor right after its onExit ran for this child.
 */
export function countAtExit(
  target: ChildProcessWithoutNullStreams,
  fixture: SupervisorApp,
): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("exit", () => {
      try {
        resolve(fixture.supervisor.liveProcessCount());
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Accumulates each spawned child's stdout text, tapped at spawn so no early frame is missed. */
export function tapStdout(runtime: RuntimeOptions): string[] {
  const texts: string[] = [];
  const inner = runtime.spawnImpl;
  runtime.spawnImpl = (command, args, options) => {
    const spawned = inner(command, args, options);
    const index = texts.length;
    texts.push("");
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      texts[index] += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    return spawned;
  };
  return texts;
}

/** FakeChild that ACK-less completes each prompt with one delta, exiting on stdin EOF. */
export function autoComplete(fake: FakeChild, eof = true): void {
  if (eof) {
    closeOnEof(fake);
  }
  fake.onCommand("prompt", () => {
    fake.emitLine({ type: "agent_start" });
    emitAssistantDelta(fake, "ok");
    completeHeldTurn(fake);
  });
}

/** FakeChild that starts a turn with `Hello` and holds it open. */
export function holdAfterHello(fake: FakeChild): void {
  fake.onCommand("prompt", () => {
    fake.emitLine({ type: "agent_start" });
    emitAssistantDelta(fake, "Hello");
  });
}
