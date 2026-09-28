/**
 * Issue #465 regenerate test plumbing, composed over the #464/#473 worlds (production createApp →
 * registerSessions, per-child stdin record, stdout hold) for real fake-omp `branch` children, and
 * over the controlled FakeChild runtime for exits, empty lists, the pool and dispatch windows.
 * Oracles are SQLite rows, stdin frames, spawn argv, published events and the public supervisor
 * surface (`regenerate`, `controlHeld`, `stop`, `streamCursor`, `liveProcessCount`); never internals.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  type ApprovalWorld,
  openApprovalWorld,
  rejection,
  settle,
} from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import { collectRejections, type RejectionLog } from "./session-stop-helpers.js";
import {
  createControlledRuntime,
  OWNER_ID,
  type RecordingWorld,
  requiredCall,
  resumePath,
  type SpawnCall,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive, presetSessionFile } from "./session-supervisor-pool-helpers.js";
import { DEFAULT_SESSION, type FakeChild } from "./support/omp-rpc.js";

/** The fake's fixed branch list ends with `fake-entry-2` / this text (fake-omp.mjs BRANCH_MESSAGES). */
export const QUESTION = "second question";
/** Resume path preset on seeded sessions; never contains `/branch-`. */
export const P = "/tmp/open-wb-465-p.jsonl";
/** Branch file the FakeChild reports from every `get_state` after its handshake. */
const BRANCHED = "/tmp/open-wb-465-branch-fake.jsonl";

export type LineMatch = (line: string) => boolean;

export const HOLD = {
  ready: (line: string) => line.includes('"type":"ready"'),
  messages: (line: string) => line.includes('"command":"get_branch_messages"'),
  branch: (line: string) => line.includes('"command":"branch"'),
  /** The handshake `get_state` answers the resume path; only the post-branch one names `/branch-`. */
  state: (line: string) => line.includes('"command":"get_state"') && line.includes("/branch-"),
} satisfies Record<string, LineMatch>;

/** A done session `user(QUESTION) → assistant(done)` resuming at P, written without any spawn. */
export function seedDone(world: RecordingWorld, session = world.session): number {
  const { store, db } = world.fixture;
  const admitted = store.acceptPrompt(session, OWNER_ID, QUESTION);
  store.finishTurn(admitted.assistantMessageId, "done");
  presetSessionFile(db, session, P);
  return admitted.assistantMessageId;
}

export function regenerate(world: RecordingWorld, session = world.session) {
  return world.fixture.supervisor.regenerate(session, OWNER_ID);
}

export function held(world: RecordingWorld, session = world.session): boolean {
  return world.fixture.supervisor.controlHeld(session);
}

export function sendPrompt(world: RecordingWorld, message = QUESTION, session = world.session) {
  return postPrompt(world.fixture.app, session, world.cookie, JSON.stringify({ message }));
}

/** One REST turn of QUESTION to done, then one macrotask so its pump released the turn claim. */
export async function answered(world: RecordingWorld): Promise<void> {
  expect((await sendPrompt(world)).statusCode).toBe(202);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
}

/** A later REST prompt is admitted: 202, spawn `index` resumes at `file`, the turn ends done. */
export async function promptsAgain(
  world: RecordingWorld & { rt: { calls: readonly SpawnCall[] } },
  message: string,
  file: string | null = P,
  index = 1,
): Promise<void> {
  expect((await sendPrompt(world, message)).statusCode).toBe(202);
  expect(resumePath(requiredCall(world.rt.calls, index).args)).toBe(file);
  await waitForTurn(world.fixture, world.session, "done");
}

/**
 * Every row the session owns, verbatim, for before/after equality. `stream_epoch` is left out
 * unless asked for: a failed acquisition may advance it independently of any row rollback.
 */
export function snapshot(db: DatabaseSync, session: string, withEpoch = false) {
  const columns = `id, owner_id, title, status, omp_session_file, created_at, updated_at, parent_session_id${
    withEpoch ? ", stream_epoch" : ""
  }`;
  return {
    session: db.prepare(`SELECT ${columns} FROM chat_sessions WHERE id = ?`).get(session),
    messages: db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id")
      .all(session),
    steps: db
      .prepare(
        "SELECT s.* FROM chat_steps AS s JOIN chat_messages AS m ON m.id = s.message_id WHERE m.session_id = ? ORDER BY s.id",
      )
      .all(session),
    approvals: db
      .prepare(
        "SELECT a.* FROM chat_approvals AS a JOIN chat_messages AS m ON m.id = a.message_id WHERE m.session_id = ? ORDER BY a.id",
      )
      .all(session),
  };
}

export function epochOf(db: DatabaseSync, session: string): number {
  const row = db.prepare("SELECT stream_epoch FROM chat_sessions WHERE id = ?").get(session) as {
    stream_epoch: number;
  };
  return Number(row.stream_epoch);
}

export function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { count: number }).count);
}

export function sessionFile(db: DatabaseSync, session: string): string | null {
  const row = db.prepare("SELECT omp_session_file FROM chat_sessions WHERE id = ?").get(session) as
    | { omp_session_file: string | null }
    | undefined;
  return row?.omp_session_file ?? null;
}

export function types(frames: readonly OmpFrame[]): string[] {
  return frames.map((frame) => String(frame.type));
}

/** The HttpError code a rejected regenerate carried. */
export async function rejectedCode(work: Promise<unknown>): Promise<string> {
  const error = await rejection(work);
  expect(error).toBeInstanceOf(HttpError);
  return (error as HttpError).code;
}

export interface RegenWorld extends ApprovalWorld {
  /** Parsed stdout lines of each spawned child (tapped on the gated stream, post-release). */
  replies: OmpFrame[][];
}

/**
 * Real fake-omp world: opened as `approval` (the helper's only scenarios), switched to `branch`
 * before any spawn. `hold` gates the first child's stdout; `entries` appends `--branch-entry`.
 */
export async function openRegenWorld(
  options: { hold?: LineMatch; entries?: string[]; scenario?: string } = {},
): Promise<RegenWorld> {
  const world = await openApprovalWorld(
    "approval",
    options.hold === undefined ? {} : { hold: options.hold },
  );
  world.rt.setScenario(options.scenario ?? "branch");
  const replies: OmpFrame[][] = [];
  const inner = world.rt.runtime.spawnImpl;
  const extra = (options.entries ?? []).flatMap((text) => ["--branch-entry", text]);
  world.rt.runtime.spawnImpl = (command, args, spawnOptions) => {
    const spawned = inner(command, [...args, ...extra], spawnOptions);
    const lines: OmpFrame[] = [];
    replies.push(lines);
    let partial = "";
    spawned.stdout.on("data", (chunk: Buffer | string) => {
      partial += String(chunk);
      for (let end = partial.indexOf("\n"); end !== -1; end = partial.indexOf("\n")) {
        lines.push(JSON.parse(partial.slice(0, end)) as OmpFrame);
        partial = partial.slice(end + 1);
      }
    });
    return spawned;
  };
  return { ...world, replies };
}

/** Waits until the first child's gate is holding its matching line. */
export async function heldLine(world: ApprovalWorld): Promise<void> {
  await waitFor(
    () => ((world.spawned[0]?.gate.held() ?? "") === "" ? undefined : true),
    "held line",
  );
}

export async function waitDead(world: ApprovalWorld, index: number): Promise<void> {
  await waitFor(
    () => (isLive(world.spawned[index]?.child) ? undefined : true),
    `child ${String(index)} exit`,
  );
}

/**
 * Per-test world ownership: every tracked world is closed after the case (live children are
 * SIGKILLed first), unless the case closed it itself; no unhandledRejection may surface.
 */
export function regenWorlds() {
  const worlds = new Map<RecordingWorld, { spawned: ApprovalWorld["spawned"]; closed: boolean }>();
  let rejections: RejectionLog | undefined;
  beforeEach(() => {
    rejections = collectRejections();
  });
  afterEach(async () => {
    try {
      for (const [world, owned] of worlds) {
        for (const { child } of owned.spawned) {
          if (isLive(child)) {
            child.kill("SIGKILL");
          }
        }
        if (!owned.closed) {
          await world.fixture.close();
        }
      }
      worlds.clear();
      await settle();
      expect(rejections?.reasons).toEqual([]);
    } finally {
      rejections?.dispose();
    }
  });
  return {
    track<W extends RecordingWorld & { spawned?: ApprovalWorld["spawned"] }>(world: W): W {
      worlds.set(world, { spawned: world.spawned ?? [], closed: false });
      return world;
    },
    /** The case closes this world itself (a second close would close the db twice). */
    closing(world: RecordingWorld): Promise<void> {
      const owned = worlds.get(world);
      if (owned !== undefined) {
        owned.closed = true;
      }
      return world.fixture.close();
    },
  };
}

export interface ScriptedChild {
  child: FakeChild;
  frames: OmpFrame[];
  /** Registered by the script of this child: replies the held command when called. */
  release?: () => void;
}

export interface ChildScript {
  /** `get_branch_messages` data; default the fixed two-entry tail ending at QUESTION. */
  messages?: unknown[];
  /** Hold this command's reply until `release()`. */
  hold?: "branch";
  /** Inside the post-branch `get_state` handler: exit(1) instead of replying. */
  exitOnState?: boolean;
  /** Inside the `branch` handler: reply, then nativeExit(1) + endStdout in the same segment. */
  exitAfterBranch?: boolean;
  /** Ignore stdin EOF: stdout stays open (retirement pending) until the test ends it. */
  keepStdout?: boolean;
  /** `prompt` behaviour: reply one delta and end (`complete`), or start and hold (`hold`). */
  prompt?: "complete" | "hold";
}

/** Reply frame helper: `{id, type:"response", command, success:true, data}`. */
function ok(frame: OmpFrame, data: unknown): OmpFrame {
  return { id: frame.id, type: "response", command: frame.type, success: true, data };
}

/**
 * FakeChild regenerate script (commands only; prompts per `prompt`). The first `get_state` is the
 * handshake (DEFAULT_SESSION); every later one reports BRANCHED. Stdin frames are recorded.
 */
function scriptChild(child: FakeChild, script: ChildScript): ScriptedChild {
  const scripted: ScriptedChild = { child, frames: [] };
  let partial = "";
  child.stdin.on("data", (chunk: Buffer | string) => {
    partial += String(chunk);
    for (let end = partial.indexOf("\n"); end !== -1; end = partial.indexOf("\n")) {
      scripted.frames.push(JSON.parse(partial.slice(0, end)) as OmpFrame);
      partial = partial.slice(end + 1);
    }
  });
  child.stdin.once("finish", () => {
    if (script.keepStdout === true) {
      return;
    }
    if (!child.stdout.writableEnded) {
      child.endStdout();
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.exit(0);
    }
  });
  let states = 0;
  child.onCommand("get_state", (frame) => {
    states += 1;
    if (states > 1 && script.exitOnState === true) {
      child.exit(1);
      return;
    }
    child.emitLine(ok(frame, { sessionFile: states === 1 ? DEFAULT_SESSION : BRANCHED }));
  });
  child.onCommand("get_branch_messages", (frame) => {
    child.emitLine(
      ok(frame, {
        messages: script.messages ?? [
          { entryId: "fake-entry-1", text: "first question" },
          { entryId: "fake-entry-2", text: QUESTION },
        ],
      }),
    );
  });
  child.onCommand("branch", (frame) => {
    const reply = () => {
      child.emitLine(ok(frame, { text: QUESTION, cancelled: false }));
      if (script.exitAfterBranch === true) {
        child.nativeExit(1);
        child.endStdout();
      }
    };
    if (script.hold === "branch") {
      scripted.release = reply;
      return;
    }
    reply();
  });
  child.onCommand("prompt", () => {
    child.emitLine({ type: "agent_start" });
    child.emitLine({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "again" },
      message: { role: "assistant", content: [] },
    });
    if (script.prompt !== "hold") {
      child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
    }
  });
  child.onCommand("abort", (frame) => {
    child.emitLine({ id: frame.id, type: "response", command: "abort", success: true });
    child.emitLine({
      type: "message_end",
      message: { role: "assistant", stopReason: "aborted" },
    });
    child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
  });
  return scripted;
}

/** Controlled runtime whose n-th child runs `scripts[n]` (last script repeats). */
export function scriptedRuntime(scripts: ChildScript[]) {
  const scripted: ScriptedChild[] = [];
  const rt = createControlledRuntime((child, _call, ordinal) => {
    const script = scripts[Math.min(ordinal, scripts.length - 1)] ?? {};
    scripted.push(scriptChild(child, script));
  });
  return { rt, scripted };
}

export function scriptedAt(scripted: readonly ScriptedChild[], index: number): ScriptedChild {
  const found = scripted[index];
  if (found === undefined) {
    throw new Error(`missing scripted child ${String(index)}`);
  }
  return found;
}
