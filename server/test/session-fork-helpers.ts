/**
 * Issue #466 fork test plumbing, composed over the #465 regenerate worlds (production createApp →
 * registerSessions, per-child stdin record and stdout hold) for real fake-omp `branch` children, and
 * over the scripted FakeChild runtime for exits, shutdown gaps, the pool and transaction faults.
 * Oracles are SQLite rows, the source file's bytes and mtime, stdin frames, spawn argv and the
 * public supervisor surface (`fork`, `regenerate`, `controlHeld`, `liveProcessCount`); never internals.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect } from "vitest";
import type { SessionSupervisor } from "../src/sessions/supervisor.js";
import { settle } from "./session-approval-helpers.js";
import {
  type ChildScript,
  held,
  heldLine,
  type LineMatch,
  openRegenWorld,
  QUESTION,
  type RegenWorldOptions,
  regenerate,
  regenWorlds,
  rejectedCode,
  scriptedRuntime,
  seedDone,
  sendPrompt,
  snapshot,
} from "./session-regenerate-helpers.js";
import { SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RealFakeRuntime,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { presetSessionFile, sampleSpawns } from "./session-supervisor-pool-helpers.js";

export const FIRST = "first question";

type Forked = Awaited<ReturnType<SessionSupervisor["fork"]>>;
type Worlds = ReturnType<typeof regenWorlds>;

/** regenWorlds plus removal of every real source file written by `realSource`. */
export function forkWorlds(): Worlds {
  const worlds = regenWorlds();
  afterEach(() => {
    for (const dir of sourceDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  return worlds;
}

const sourceDirs: string[] = [];

/** A real resume file (never under `/branch-`); `unchanged()` compares its bytes and mtime. */
export function realSource(): { file: string; unchanged(): void } {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-466-"));
  sourceDirs.push(dir);
  const file = join(dir, "source.jsonl");
  writeFileSync(file, '{"type":"session","id":"source"}\n');
  const bytes = readFileSync(file);
  const mtime = statSync(file).mtimeMs;
  return {
    file,
    unchanged() {
      expect(readFileSync(file)).toEqual(bytes);
      expect(statSync(file).mtimeMs).toBe(mtime);
    },
  };
}

export interface Seeded {
  u1: number;
  a1: number;
  u2: number;
  a2: number;
  /** Third user message (text QUESTION) when `extraTurn`. */
  u3: number;
  file: string;
  unchanged(): void;
}

/**
 * u1 (FIRST) → a1 → u2 (QUESTION) → a2, both answers settled, then the resume file preset to a
 * real file. Written through the store only: no spawn, so the fork's temporary child is child 0.
 */
export function seedTwoTurns(
  world: RecordingWorld,
  options: { a1?: "done" | "failed" | "stopped"; u2Text?: string; extraTurn?: boolean } = {},
  session = world.session,
): Seeded {
  const { store, db } = world.fixture;
  const first = store.acceptPrompt(session, OWNER_ID, FIRST);
  store.finishTurn(first.assistantMessageId, options.a1 ?? "done");
  const second = store.acceptPrompt(session, OWNER_ID, options.u2Text ?? QUESTION);
  store.finishTurn(second.assistantMessageId, "done");
  let u3 = -1;
  if (options.extraTurn === true) {
    const third = store.acceptPrompt(session, OWNER_ID, QUESTION);
    store.finishTurn(third.assistantMessageId, "done");
    u3 = third.userMessageId;
  }
  const source = realSource();
  presetSessionFile(db, session, source.file);
  return {
    u1: first.userMessageId,
    a1: first.assistantMessageId,
    u2: second.userMessageId,
    a2: second.assistantMessageId,
    u3,
    file: source.file,
    unchanged: source.unchanged,
  };
}

/** `supervisor.fork` asserted not to throw synchronously; every failure must be a rejection. */
export function forkAt(
  world: RecordingWorld,
  messageId: number,
  session = world.session,
  owner = OWNER_ID,
): Promise<Forked> {
  let work: Promise<Forked> | undefined;
  expect(() => {
    work = world.fixture.supervisor.fork(session, owner, messageId);
  }).not.toThrow();
  if (work === undefined) {
    throw new Error("fork returned nothing");
  }
  return work;
}

/** One REST turn of `message` to done, then a few macrotasks so its pump released the claim. */
export async function turn(world: RecordingWorld, message: string, session = world.session) {
  expect((await sendPrompt(world, message, session)).statusCode).toBe(202);
  const tree = await waitForTurn(world.fixture, session, "done");
  await settle();
  return tree;
}

export function rowCounts(db: DatabaseSync) {
  const one = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  return {
    sessions: one("chat_sessions"),
    messages: one("chat_messages"),
    steps: one("chat_steps"),
    approvals: one("chat_approvals"),
  };
}

export function sessionRowOf(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT owner_id, title, status, omp_session_file, stream_epoch, parent_session_id FROM chat_sessions WHERE id = ?",
    )
    .get(session) as Record<string, unknown> | undefined;
}

export function messagesOf(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT id, role, content, status, created_at FROM chat_messages WHERE session_id = ? ORDER BY created_at, id",
    )
    .all(session) as Array<{
    id: number;
    role: string;
    content: string;
    status: string;
    created_at: number;
  }>;
}

export function stepsOf(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      "SELECT ordinal, name, detail, output, status, started_at, ended_at FROM chat_steps WHERE message_id = ? ORDER BY ordinal, id",
    )
    .all(messageId);
}

export function approvalsOf(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      "SELECT request_id, tool, title, requested_at, expires_at, decision, decided_at FROM chat_approvals WHERE message_id = ? ORDER BY id",
    )
    .all(messageId);
}

export function insertApproval(
  db: DatabaseSync,
  messageId: number,
  requestId: string,
  decision: string,
  at: number,
): void {
  db.prepare(
    "INSERT INTO chat_approvals(message_id, request_id, tool, title, requested_at, expires_at, decision, decided_at) VALUES (?, ?, 'bash', ?, ?, ?, ?, ?)",
  ).run(messageId, requestId, `run ${requestId}`, at, at + 60_000, decision, at + 5);
}

export async function listedIds(world: RecordingWorld): Promise<string[]> {
  const response = await world.fixture.app.inject({
    method: "GET",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
}

/** A regenerate world (real fake-omp `branch`) with every spawn's live children sampled. */
export async function openForkWorld(options: RegenWorldOptions = {}) {
  const world = await openRegenWorld(options);
  const liveAtSpawn = sampleSpawns({ runtime: world.rt.runtime, children: world.rt.children });
  return { ...world, liveAtSpawn };
}

/**
 * `--resume` spawns run `branch`, the others `hang-prompt` (the base scenario is unset). The
 * wrapped spawnImpl is the one the supervisor reads at every runtime construction.
 */
function mixedScenarios(rt: RealFakeRuntime): void {
  const inner = rt.runtime.spawnImpl;
  rt.runtime.spawnImpl = (command, args, options) =>
    inner(
      command,
      [...args, "--scenario", args.includes("--resume") ? "branch" : "hang-prompt"],
      options,
    );
}

/** Real fake-omp capped at `cap`: the cap is set on the runtime object, never on a spread copy. */
export async function openCappedWorld(cap: number, mixed = false) {
  const rt = createRealFakeRuntime(mixed ? undefined : "branch");
  if (mixed) {
    mixedScenarios(rt);
  }
  const liveAtSpawn = sampleSpawns(rt);
  rt.runtime.maxProcesses = cap;
  const world = await openRecordingSession(rt.runtime);
  return { ...world, rt, liveAtSpawn };
}

/** Scripted FakeChild world; `cap` is set on the runtime object (no spread). */
export async function openForkScripted(worlds: Worlds, scripts: ChildScript[], cap?: number) {
  const { rt, scripted } = scriptedRuntime(scripts);
  if (cap !== undefined) {
    rt.runtime.maxProcesses = cap;
  }
  return worlds.track({ ...(await openRecordingSession(rt.runtime)), rt, scripted });
}

/** A seeded done session whose regenerate is pending with its first child's `hold` line held. */
export async function heldRegenerate(worlds: Worlds, hold: LineMatch) {
  const world = worlds.track(await openRegenWorld({ hold }));
  seedDone(world);
  const pending = { world, db: world.fixture.db, work: regenerate(world) };
  await heldLine(world);
  return pending;
}

/** The source's rows (epoch included) and every table's count, for "nothing changed" checks. */
export function baseline(world: RecordingWorld) {
  const { db } = world.fixture;
  return { before: snapshot(db, world.session, true), rows: rowCounts(db) };
}

/** A rejected fork: its code, no table's count changed and the source's claim released. */
export async function expectForkRejected(
  world: RecordingWorld,
  work: Promise<unknown>,
  code: string,
  rows: ReturnType<typeof rowCounts>,
): Promise<void> {
  expect(await rejectedCode(work)).toBe(code);
  expect(rowCounts(world.fixture.db)).toEqual(rows);
  expect(held(world)).toBe(false);
}

/** A held fork completes once let go: QUESTION drafted, one new session row, claim released. */
export async function expectForkDone(
  world: RecordingWorld,
  work: Promise<Forked>,
  sessions: number,
): Promise<Forked> {
  const done = await work;
  expect(done.draft).toBe(QUESTION);
  expect(rowCounts(world.fixture.db).sessions).toBe(sessions + 1);
  expect(held(world)).toBe(false);
  return done;
}

/** While the fork holds the source: REST prompt 409, regenerate and fork session_busy. */
export async function expectSourceClaimed(world: RecordingWorld, messageId: number) {
  const injected = await sendPrompt(world, "injected");
  expect([injected.statusCode, injected.json()]).toEqual([409, SESSION_BUSY_ENVELOPE]);
  expect(await rejectedCode(regenerate(world))).toBe("session_busy");
  expect(await rejectedCode(forkAt(world, messageId))).toBe("session_busy");
}

/** Resolves once `shutdown()` set its closed flag (it clears every subscriber synchronously). */
export async function shutdownStarted(world: RecordingWorld, session: string): Promise<void> {
  await waitFor(
    () => (world.fixture.supervisor.sessionStreamSubscriberCount(session) === 0 ? true : undefined),
    "shutdown started",
  );
}

export function subscribeQuietly(world: RecordingWorld, session = world.session): unknown[] {
  const received: unknown[] = [];
  world.fixture.supervisor.subscribe(session, null, (event) => {
    received.push(event);
  });
  expect(world.fixture.supervisor.sessionStreamSubscriberCount(session)).toBe(1);
  return received;
}
