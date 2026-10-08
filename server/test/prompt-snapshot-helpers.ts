/**
 * The world of the per-turn snapshot tests (#945, #946): production `createApp`, real SQLite, real
 * fake-omp children, a real workspace directory and a real managed snapshots directory, plus the
 * probes those tests read (frames written to each child's stdin, registration rows read raw).
 * Shared by prompt-snapshot.test.ts and message-undo-state.test.ts.
 */
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { TurnSnapshotService } from "../src/sessions/turn-snapshot.js";
import { removeSnapshot, take } from "../src/workspaces/snapshots.js";
import { settle } from "./session-approval-helpers.js";
import { deferred, postPrompt } from "./session-rest-helpers.js";
import { collectRejections, type RejectionLog } from "./session-stop-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RealFakeRuntime,
  type RecordingWorld,
  waitFor,
} from "./session-supervisor-helpers.js";
import { workspaceOf } from "./support/temporary-workspace.js";

interface Settings {
  snapshotMaxFileBytes?: number;
  snapshotMaxTotalBytes?: number;
  snapshotMaxEntries?: number;
  snapshotExcludeNames?: readonly string[];
}

export interface World extends RecordingWorld {
  rt: RealFakeRuntime;
  db: DatabaseSync;
  /** Per spawned child, the frames written to its stdin. */
  stdin: OmpFrame[][];
  /** At each `prompt` frame written to a child: the snapshot directories complete right then. */
  completeAtPrompt: string[][];
  workspaceId: string;
  /** The session's workspace directory. */
  root: string;
  /** `<state dir>/snapshots/<workspaceId>`. */
  snapshots: string;
}

interface OpenOptions {
  scenario?: string;
  settings?: Settings;
  /** Builds the replacement service over a real one; omitted → the service createApp builds. */
  service?: (real: TurnSnapshotService) => TurnSnapshotService;
}

interface Row {
  message_id: number;
  workspace_id: string;
  outcome: string;
  skipped: string | null;
  todo_type: string;
  /** `hex()` of SQL NULL is the empty string; `todo_type` tells NULL from empty text. */
  todo_hex: string;
  created_at: number;
}

/** The 202 body of the prompt route. */
interface Accepted {
  userMessageId: number;
  assistantMessageId: number;
  undo: string;
}

const worlds: World[] = [];

/**
 * Registers the hooks of a file that opens worlds: every world is closed after each test, and a
 * test that left an unhandled rejection behind fails.
 */
export function closeWorldsAfterEach(): void {
  let rejections: RejectionLog | undefined;
  beforeEach(() => {
    rejections = collectRejections();
  });
  afterEach(async () => {
    try {
      for (const world of worlds.splice(0)) {
        await world.fixture.close().catch(() => undefined);
      }
      await settle();
      expect(rejections?.reasons).toEqual([]);
    } finally {
      rejections?.dispose();
      vi.restoreAllMocks();
    }
  });
}

/**
 * `take` and `removeSnapshot` over the world's snapshots directory, with roomy limits; the total
 * limit is the world's own when it sets one. `restore` is the port's third method and unused here.
 */
function realService(stateDir: string, settings: Settings): TurnSnapshotService {
  const snapshotsRoot = join(stateDir, "snapshots");
  return {
    take: (workspaceRoot, workspaceId, userMessageId, previousMessageId) =>
      take({
        workspaceRoot,
        snapshotsRoot,
        workspaceId,
        userMessageId,
        ...(previousMessageId === undefined ? {} : { previousMessageId }),
        excludeNames: [],
        maxFileBytes: 1_000_000,
        maxTotalBytes: settings.snapshotMaxTotalBytes ?? 10_000_000,
        maxEntries: 1_000,
      }),
    remove: (workspaceId, messageId) => removeSnapshot({ snapshotsRoot, workspaceId, messageId }),
    restore: () => Promise.reject(new Error("the snapshot worlds restore nothing")),
  };
}

/** The message ids under `dir` whose snapshot is complete (its manifest is written last). */
function completeSnapshots(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, "manifest.json")))
    .sort((left, right) => Number(left) - Number(right));
}

export async function open(options: OpenOptions = {}): Promise<World> {
  const rt = createRealFakeRuntime(options.scenario);
  const settings = options.settings ?? {};
  // The four snapshot settings travel in the runtime settings object, as `sessionRuntimeOf` puts them.
  Object.assign(rt.runtime, settings);
  const stdin: OmpFrame[][] = [];
  const completeAtPrompt: string[][] = [];
  const located = { snapshots: "" };
  const inner = rt.runtime.spawnImpl;
  rt.runtime.spawnImpl = (command, args, spawnOptions) => {
    const child = inner(command, args, spawnOptions);
    const frames: OmpFrame[] = [];
    stdin.push(frames);
    const forward = child.stdin.write.bind(child.stdin) as (...values: unknown[]) => boolean;
    child.stdin.write = ((...values: unknown[]) => {
      const chunk = values[0];
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
      for (const line of text.split("\n").filter((part) => part.length > 0)) {
        const frame = JSON.parse(line) as OmpFrame;
        frames.push(frame);
        if (frame.type === "prompt") {
          completeAtPrompt.push(completeSnapshots(located.snapshots));
        }
      }
      return forward(...values);
    }) as typeof child.stdin.write;
    return child;
  };
  const recording = await openRecordingSession(
    rt.runtime,
    options.service === undefined
      ? {}
      : { snapshots: options.service(realService(rt.runtime.stateDir, settings)) },
  );
  const db = recording.fixture.db;
  const workspaceId = workspaceOf(db, recording.session);
  located.snapshots = join(rt.runtime.stateDir, "snapshots", workspaceId);
  const world: World = {
    ...recording,
    rt,
    db,
    stdin,
    completeAtPrompt,
    workspaceId,
    root: realpathSync(join(rt.runtime.sandboxRoot, OWNER_ID, `tmp-${workspaceId}`)),
    snapshots: located.snapshots,
  };
  worlds.push(world);
  return world;
}

export function put(world: World, path: string, bytes: string): void {
  const target = join(world.root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, bytes);
}

export function send(world: World, message: string, session = world.session) {
  return postPrompt(world.fixture.app, session, world.cookie, JSON.stringify({ message }));
}

/** The 202 of the prompt route with its exact three keys, in order. */
export function accepted(response: LightMyRequestResponse): Accepted {
  expect(response.statusCode).toBe(202);
  const body = response.json() as Accepted;
  expect(Object.keys(body)).toEqual(["userMessageId", "assistantMessageId", "undo"]);
  return body;
}

export function statusOf(world: World, session = world.session): string | undefined {
  const row = world.db.prepare("SELECT status FROM chat_sessions WHERE id = ?").get(session) as
    | { status: string }
    | undefined;
  return row?.status;
}

/** Sends a prompt, expects its 202 and waits until the session left `running` with `status`. */
export async function turn(
  world: World,
  message: string,
  status = "done",
  session = world.session,
) {
  const { userMessageId } = accepted(await send(world, message, session));
  await waitFor(() => (statusOf(world, session) === status ? true : undefined), `turn ${status}`);
  return userMessageId;
}

/** Every registration row, columns read raw: `todo` as its storage class and its bytes in hex. */
export function rows(db: DatabaseSync): Row[] {
  return (
    db
      .prepare(
        "SELECT message_id, workspace_id, outcome, skipped, typeof(todo) AS todo_type, hex(CAST(todo AS BLOB)) AS todo_hex, created_at FROM chat_turn_snapshots ORDER BY message_id",
      )
      .all() as unknown as Row[]
  ).map((row) => ({ ...row }));
}

/** A row with no skipped entry and no task list; `created_at` is checked against the bounds. */
export function plainRow(world: World, messageId: number, outcome: string, since: number) {
  return {
    message_id: messageId,
    workspace_id: world.workspaceId,
    outcome,
    skipped: null,
    todo_type: "null",
    todo_hex: "",
    created_at: expect.toSatisfy(
      (at: unknown) => typeof at === "number" && at >= since && at <= Date.now(),
    ),
  };
}

export function framesOfType(world: World, type: string): number {
  return world.stdin.flat().filter((frame) => frame.type === type).length;
}

/** The status of every `turn.end` published, in order. */
export function turnEnds(world: World): string[] {
  return world.events.flatMap(({ event }) =>
    event.type === "turn.end" ? [event.data.status] : [],
  );
}

export function messageCount(db: DatabaseSync, session: string): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM chat_messages WHERE session_id = ?")
    .get(session) as { n: number };
  return Number(row.n);
}

/** A service whose `take` waits for `gate` before running the real one. */
export function heldService() {
  const entered = deferred();
  const gate = deferred();
  let released = false;
  const service = (real: TurnSnapshotService): TurnSnapshotService => ({
    ...real,
    async take(...args) {
      entered.resolve();
      await gate.promise;
      return real.take(...args);
    },
  });
  return {
    service,
    entered: entered.promise,
    release() {
      released = true;
      gate.resolve();
    },
    released: () => released,
  };
}
