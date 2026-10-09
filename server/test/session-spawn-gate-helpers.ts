/**
 * Issue #652 spawn-gate plumbing: the production createApp → registerSessions assembly over real
 * fake-omp children, a per-spawn argv script, spawn and `ready` instants (performance.now) tapped
 * at spawn before the runtime attaches, and an optional hold on a child's `exit`/`close` events.
 * `spawnConcurrency` and `log` ride on plain assembly objects, so this file imports no #652 source.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import type { SpawnImpl } from "../src/sessions/omp/process.js";
import type { HandshakeTimeoutRecord } from "../src/sessions/omp/spawn-gate.js";
import type { SessionStore } from "../src/sessions/store.js";
import type { SessionSupervisor } from "../src/sessions/supervisor.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { settle } from "./session-approval-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor, postPrompt } from "./session-rest-helpers.js";
import { collectRejections, type RejectionLog } from "./session-stop-helpers.js";
import { messageRows } from "./session-store-helpers.js";
import {
  createRealFakeRuntime,
  createSession,
  OWNER_ID,
  waitFor,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

export interface SpawnRecord {
  child: ChildProcessWithoutNullStreams;
  /** performance.now() when spawnImpl was entered. */
  spawnAt: number;
  /** performance.now() when the child's stdout first carried its `ready` frame. */
  readyAt: number | undefined;
  /** Children spawned but not yet ready at this spawn, this one included. */
  unreadyAtSpawn: number;
}

interface ExitHold {
  held(): number;
  release(): void;
}

export interface GateWorldOptions {
  sessions: number;
  /** argv appended to the n-th spawn (0-based), e.g. `["--scenario", "no-ready"]`. */
  argv(ordinal: number): string[];
  spawnConcurrency?: number;
  maxProcesses?: number;
  handshakeTimeoutMs?: number;
  /** Omit the injected TestClock: the runtimes run on the system clock. */
  systemClock?: boolean;
  /** Spawn ordinals whose `exit`/`close` events are held until `holds[n].release()`. */
  holdExit?: readonly number[];
  tokens?: TokenRegistry;
  /** Every spawn execs this nonexistent path instead of fake-omp (ENOENT, no pid). */
  missingBinary?: string;
  log?: (record: HandshakeTimeoutRecord) => unknown;
}

export interface GateWorld {
  app: FastifyInstance;
  db: DatabaseSync;
  store: SessionStore;
  supervisor: SessionSupervisor;
  clock: TestClock;
  /** The supervisor's runtime settings object: each new runtime reads `handshakeTimeoutMs` here. */
  runtime: { handshakeTimeoutMs?: number | undefined };
  cookie: string;
  sessions: string[];
  spawns: SpawnRecord[];
  holds: Map<number, ExitHold>;
  errors: Error[];
}

const worlds = new Set<GateWorld>();

/** Per-file ownership: every world is closed after its case, with no unhandled rejection. */
export function gateWorlds(): { open(options: GateWorldOptions): Promise<GateWorld> } {
  let rejections: RejectionLog | undefined;
  beforeEach(() => {
    rejections = collectRejections();
  });
  afterEach(async () => {
    try {
      for (const world of worlds) {
        await closeWorld(world);
      }
      worlds.clear();
      await settle();
      expect(rejections?.reasons).toEqual([]);
    } finally {
      rejections?.dispose();
    }
  });
  return {
    async open(options) {
      const world = await openWorld(options);
      worlds.add(world);
      return world;
    },
  };
}

async function openWorld(options: GateWorldOptions): Promise<GateWorld> {
  const rt = createRealFakeRuntime();
  const spawns: SpawnRecord[] = [];
  const holds = new Map<number, ExitHold>();
  const inner = rt.runtime.spawnImpl;
  const spawnImpl: SpawnImpl = (command, args, spawnOptions) => {
    const ordinal = spawns.length;
    const spawnAt = performance.now();
    const unready = spawns.filter((s) => s.readyAt === undefined && isLive(s.child)).length;
    const child =
      options.missingBinary === undefined
        ? inner(command, [...args, ...options.argv(ordinal)], spawnOptions)
        : spawnMissing(options.missingBinary);
    const record: SpawnRecord = { child, spawnAt, readyAt: undefined, unreadyAtSpawn: unready + 1 };
    spawns.push(record);
    tapReady(record);
    if (options.holdExit?.includes(ordinal) === true) {
      holds.set(ordinal, holdExitEvents(child));
    }
    return child;
  };
  const { clock: _unused, ...systemRuntime } = rt.runtime;
  const runtime = {
    ...(options.systemClock === true ? systemRuntime : rt.runtime),
    spawnImpl,
    ...(options.spawnConcurrency === undefined
      ? {}
      : { spawnConcurrency: options.spawnConcurrency }),
    ...(options.maxProcesses === undefined ? {} : { maxProcesses: options.maxProcesses }),
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
  };
  const errors: Error[] = [];
  const db = openDb(":memory:");
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      tokens: options.tokens ?? new TokenRegistry(),
      runtime,
      onError: (error) => {
        errors.push(error);
      },
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  });
  const cookie = await cookieFor(app, "zhangsan");
  const sessions: string[] = [];
  for (let n = 0; n < options.sessions; n += 1) {
    sessions.push(await createSession(app, cookie));
  }
  const { store, supervisor } = app.sessions;
  return {
    app,
    db,
    store,
    supervisor,
    clock: rt.clock,
    runtime,
    cookie,
    sessions,
    spawns,
    holds,
    errors,
  };
}

function spawnMissing(bin: string): ChildProcessWithoutNullStreams {
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], shell: false });
  child.on("error", () => {});
  return child;
}

function tapReady(record: SpawnRecord): void {
  let text = "";
  const onData = (chunk: Buffer | string): void => {
    text += String(chunk);
    if (text.includes('"type":"ready"')) {
      record.readyAt = performance.now();
      record.child.stdout.off("data", onData);
    }
  };
  record.child.stdout.on("data", onData);
}

/**
 * Buffers the child's `exit`/`close` emissions (Node has already set exitCode/signalCode) so every
 * listener — the runtime's native-exit wait included — sees them only after `release()`.
 */
export function holdExitEvents(child: ChildProcessWithoutNullStreams): ExitHold {
  const emit = child.emit.bind(child);
  const buffered: Array<[string, unknown[]]> = [];
  let holding = true;
  child.emit = ((event: string | symbol, ...args: unknown[]) => {
    if (holding && (event === "exit" || event === "close")) {
      buffered.push([event, args]);
      return true;
    }
    return emit(event, ...args);
  }) as typeof child.emit;
  return {
    held: () => buffered.length,
    release() {
      holding = false;
      for (const [event, args] of buffered.splice(0)) {
        emit(event, ...args);
      }
    },
  };
}

async function closeWorld(world: GateWorld): Promise<void> {
  for (const hold of world.holds.values()) {
    hold.release();
  }
  for (const { child } of world.spawns) {
    if (isLive(child)) {
      child.kill("SIGKILL");
    }
  }
  try {
    await world.app.close();
  } finally {
    world.db.close();
  }
}

export function send(world: GateWorld, session: string, message: string) {
  return postPrompt(world.app, session, world.cookie, JSON.stringify({ message }));
}

export function spawnAt(world: GateWorld, ordinal: number): SpawnRecord {
  const record = world.spawns[ordinal];
  if (record === undefined) {
    throw new Error(`missing spawn ${String(ordinal)}`);
  }
  return record;
}

export function waitSpawns(world: GateWorld, count: number): Promise<true> {
  return waitFor(
    () => (world.spawns.length >= count ? true : undefined),
    `${String(count)} spawn(s)`,
  );
}

/** Owner stop over REST (202), then the assistant row of `session` reaches `stopped`. */
export async function stopTurn(world: GateWorld, session: string): Promise<void> {
  const response = await world.app.inject({
    method: "POST",
    url: `/api/sessions/${session}/stop`,
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(202);
  await waitFor(
    () =>
      messageRows(world.db).some(
        (row) => row.session_id === session && row.role === "assistant" && row.status === "stopped",
      )
        ? true
        : undefined,
    `${session} turn stopped`,
  );
}

export function turnDone(world: GateWorld, session: string): Promise<true> {
  return waitFor(
    () =>
      world.store.getMessages(session, OWNER_ID)?.session.status === "done" ? true : undefined,
    `${session} turn done`,
  );
}

/** Advances the injected clock in 1s steps (real macrotasks between) until `work` settles. */
export async function driveClock(world: GateWorld, work: Promise<unknown>): Promise<void> {
  let settled = false;
  void work.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitFor(() => {
    if (!settled) {
      world.clock.advance(1_000);
    }
    return settled ? true : undefined;
  }, "work to settle on the driven clock");
}
