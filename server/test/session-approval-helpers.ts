/**
 * Issue #464 approval-registration test plumbing. Every world runs the production assembly
 * (createApp → registerSessions) over real fake-omp children under the production argv
 * (`--approval-mode <the session's effective mode>`: `write` by default, so the approval scenarios
 * gate; `approval-write` gates its one `write` call under `always-ask` only, #1009).
 * The spawn wrapper records each child's stdin frames and can hold stdout lines (released as one
 * write, line boundaries and EOF preserved). Oracles are SQLite rows, stdin frames, the recorded
 * onEvent stream and real SSE bytes, never supervisor internals.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { expect } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  createSession,
  type ObservedEvent,
  type OpenSessionOptions,
  OWNER_ID,
  openRecordingSession,
  type RealFakeRuntime,
  type RecordingWorld,
  waitFor,
} from "./session-supervisor-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

export const T = 1_700_000_000_000;
export const TTL_MS = 60_000;
export const TITLE = "Allow tool: bash\nCommand: echo workbuddy-smoke";
export const TITLE_2 = "Allow tool: bash\nCommand: echo workbuddy-smoke-2";
export const DENIED_OUTPUT = "Tool call denied by user: bash";
export const REAL = { timeout: 20_000 };

type LineMatch = (line: string) => boolean;

/** Holds the first matching stdout line and every later line until `release()` (one write). */
interface StdoutGate {
  held(): string;
  release(): void;
}

export interface SpawnedChild {
  child: ChildProcessWithoutNullStreams;
  stdin: OmpFrame[];
  gate: StdoutGate;
}

export interface ApprovalWorld extends RecordingWorld {
  rt: RealFakeRuntime;
  clock: TestClock;
  spawned: SpawnedChild[];
  /** Injected-clock timers still armed (neither fired nor cleared) that fall due at `due`. */
  timersDueAt(due: number): number;
}

export interface ApprovalWorldOptions {
  idleMs?: number;
  /** Applied to the next spawned child's stdout only. */
  hold?: LineMatch;
  prepare?: (db: DatabaseSync) => void;
  onEvent?: (sessionId: string, epoch: number, event: ChatEvent<number>) => void;
  assembly?: OpenSessionOptions["assembly"];
  /** The live-process cap, set on the runtime object before the supervisor reads it. */
  maxProcesses?: number;
}

export interface ApprovalRow {
  id: number;
  message_id: number;
  request_id: string;
  tool: string;
  title: string;
  requested_at: number;
  expires_at: number;
  decision: string | null;
  decided_at: number | null;
}

export interface SseFrame {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

export async function openApprovalWorld(
  scenario: "approval" | "approval-parallel" | "approval-write",
  options: ApprovalWorldOptions = {},
): Promise<ApprovalWorld> {
  const rt = createRealFakeRuntime(scenario);
  rt.clock.nowMs = T;
  if (options.idleMs !== undefined) {
    rt.runtime.idleMs = options.idleMs;
  }
  if (options.maxProcesses !== undefined) {
    rt.runtime.maxProcesses = options.maxProcesses;
  }
  const spawned: SpawnedChild[] = [];
  let hold = options.hold;
  const inner = rt.runtime.spawnImpl;
  rt.runtime.spawnImpl = (command, args, spawnOptions) => {
    const child = inner(command, args, spawnOptions);
    const gate = gateStdout(child, hold);
    hold = undefined;
    spawned.push({ child, stdin: recordStdin(child), gate });
    return child;
  };
  const armed = trackTimers(rt.clock);
  const world = await openRecordingSession(rt.runtime, {
    ...(options.prepare === undefined ? {} : { prepare: options.prepare }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.assembly === undefined ? {} : { assembly: options.assembly }),
  });
  return {
    ...world,
    rt,
    clock: rt.clock,
    spawned,
    timersDueAt: (due) => [...armed.values()].filter((at) => at === due).length,
  };
}

/** Wraps the injected clock (same object every consumer holds) to know each armed timer's due. */
function trackTimers(clock: TestClock): Map<unknown, number> {
  const armed = new Map<unknown, number>();
  const set = clock.setTimeout.bind(clock);
  const clear = clock.clearTimeout.bind(clock);
  clock.setTimeout = (callback, ms) => {
    const id = set(() => {
      armed.delete(id);
      callback();
    }, ms);
    armed.set(id, clock.nowMs + ms);
    return id;
  };
  clock.clearTimeout = (id) => {
    armed.delete(id);
    clear(id);
  };
  return armed;
}

function recordStdin(child: ChildProcessWithoutNullStreams): OmpFrame[] {
  const sink: OmpFrame[] = [];
  const forward = child.stdin.write.bind(child.stdin) as (...args: unknown[]) => boolean;
  child.stdin.write = ((...args: unknown[]) => {
    const chunk = args[0];
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split("\n").filter((part) => part.length > 0)) {
      sink.push(JSON.parse(line) as OmpFrame);
    }
    return forward(...args);
  }) as typeof child.stdin.write;
  return sink;
}

/**
 * Replaces `child.stdout` (before OmpProcess attaches) with a line-preserving pass-through. Held
 * lines are written together with every line that arrived meanwhile, in one chunk; EOF releases.
 */
function gateStdout(
  child: ChildProcessWithoutNullStreams,
  hold: LineMatch | undefined,
): StdoutGate {
  const real = child.stdout;
  const gated = new PassThrough();
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let match = hold;
  let held: string[] | undefined;
  const gate: StdoutGate = {
    held: () => (held ?? []).join(""),
    release() {
      match = undefined;
      if (held !== undefined) {
        const text = held.join("");
        held = undefined;
        gated.write(text);
      }
    },
  };
  real.on("data", (chunk: Buffer | string) => {
    partial += typeof chunk === "string" ? chunk : decoder.write(chunk);
    const passed: string[] = [];
    for (let end = partial.indexOf("\n"); end !== -1; end = partial.indexOf("\n")) {
      const line = partial.slice(0, end + 1);
      partial = partial.slice(end + 1);
      if (held === undefined && match?.(line) === true) {
        held = [];
      }
      (held ?? passed).push(line);
    }
    if (passed.length > 0) {
      gated.write(passed.join(""));
    }
  });
  real.on("end", () => {
    gate.release();
    const rest = partial + decoder.end();
    if (rest.length > 0) {
      gated.write(rest);
    }
    gated.end();
  });
  real.on("error", (error) => {
    gated.destroy(error);
  });
  gated.on("close", () => {
    real.destroy();
  });
  Object.defineProperty(child, "stdout", { value: gated, configurable: true, writable: true });
  return gate;
}

export async function prompted(world: RecordingWorld, session = world.session): Promise<void> {
  const response = await postPrompt(
    world.fixture.app,
    session,
    world.cookie,
    JSON.stringify({ message: "run the tool" }),
  );
  expect(response.statusCode).toBe(202);
}

export async function extraSession(world: RecordingWorld): Promise<string> {
  return createSession(world.fixture.app, world.cookie);
}

export function approvalRows(db: DatabaseSync, session?: string): ApprovalRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.message_id, a.request_id, a.tool, a.title, a.requested_at, a.expires_at,
              a.decision, a.decided_at
         FROM chat_approvals AS a JOIN chat_messages AS m ON m.id = a.message_id
        WHERE ?1 IS NULL OR m.session_id = ?1
        ORDER BY a.id`,
    )
    .all(session ?? null) as unknown as ApprovalRow[];
  return rows.map((row) => ({ ...row }));
}

export function approvalRow(db: DatabaseSync, id: number): ApprovalRow {
  const found = approvalRows(db).find((row) => row.id === id);
  if (found === undefined) {
    throw new Error(`missing approval row ${String(id)}`);
  }
  return found;
}

export async function waitForRows(
  world: RecordingWorld,
  count: number,
  session = world.session,
): Promise<ApprovalRow[]> {
  return waitFor(
    () => {
      const rows = approvalRows(world.fixture.db, session);
      return rows.length >= count ? rows : undefined;
    },
    `${String(count)} approval rows`,
  );
}

export function approvalAuditCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE kind = 'session.approval'")
    .get() as { count: number };
  return Number(row.count);
}

export function auditCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
  return Number(row.count);
}

export function responses(spawned: SpawnedChild | undefined): OmpFrame[] {
  return (spawned?.stdin ?? []).filter((frame) => frame.type === "extension_ui_response");
}

export function spawnedAt(world: ApprovalWorld, index: number): SpawnedChild {
  const found = world.spawned[index];
  if (found === undefined) {
    throw new Error(`missing spawned child ${String(index)}`);
  }
  return found;
}

export function sessionEvents(world: RecordingWorld, session = world.session): ObservedEvent[] {
  return world.events.filter((entry) => entry.sessionId === session);
}

export function ofType<K extends ChatEvent<number>["type"]>(
  entries: readonly ObservedEvent[],
  type: K,
): Array<Extract<ChatEvent<number>, { type: K }>> {
  return entries
    .map((entry) => entry.event)
    .filter((event): event is Extract<ChatEvent<number>, { type: K }> => event.type === type);
}

export async function waitForEvent<K extends ChatEvent<number>["type"]>(
  world: RecordingWorld,
  type: K,
  count = 1,
  session = world.session,
): Promise<Array<Extract<ChatEvent<number>, { type: K }>>> {
  return waitFor(
    () => {
      const found = ofType(sessionEvents(world, session), type);
      return found.length >= count ? found : undefined;
    },
    `${String(count)} ${type} events`,
  );
}

export async function waitForResponses(spawned: SpawnedChild, count: number): Promise<OmpFrame[]> {
  return waitFor(
    () => {
      const found = responses(spawned);
      return found.length >= count ? found : undefined;
    },
    `${String(count)} extension_ui_response frames`,
  );
}

/** A few macrotasks: lets any wrongly scheduled write, event or row surface before asserting. */
export async function settle(turns = 10): Promise<void> {
  for (let n = 0; n < turns; n += 1) {
    await waitImmediate();
  }
}

export function assistantSteps(world: RecordingWorld, session = world.session) {
  const tree = world.fixture.store.getMessages(session, OWNER_ID);
  const assistant = tree?.messages.find((message) => message.role === "assistant");
  if (tree === null || tree === undefined || assistant === undefined) {
    throw new Error("missing assistant message");
  }
  return { session: tree.session, assistant, steps: assistant.steps };
}

export async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

export function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.split("\n\n")) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      const colon = line.indexOf(": ");
      if (colon > 0) {
        fields.set(line.slice(0, colon), line.slice(colon + 2));
      }
    }
    const id = fields.get("id");
    const event = fields.get("event");
    const data = fields.get("data");
    if (id !== undefined && id.length > 0 && event !== undefined && data !== undefined) {
      frames.push({ id, event, data: JSON.parse(data) as Record<string, unknown> });
    }
  }
  return frames;
}

export function seqOf(frame: SseFrame | undefined): number {
  if (frame === undefined) {
    throw new Error("missing SSE frame");
  }
  return Number(frame.id.slice(frame.id.indexOf(":") + 1));
}

/** The argv element right after `flag` (`--approval-mode`, `--model`); undefined when absent. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

export function isToolStart(line: string): boolean {
  return line.includes('"type":"tool_execution_start"');
}

export function isTextDeltaLine(line: string): boolean {
  return line.includes('"type":"text_delta"');
}

export function isSelect(requestId: string): LineMatch {
  return (line) =>
    line.includes('"type":"extension_ui_request"') && line.includes(`"id":"${requestId}"`);
}

/** "No side effects": no extension_ui_response frame, no session.approval audit, no resolved. */
export function expectQuiet(world: ApprovalWorld): void {
  for (const spawned of world.spawned) {
    expect(responses(spawned)).toEqual([]);
  }
  expect(approvalAuditCount(world.fixture.db)).toBe(0);
  expect(ofType(world.events, "approval.resolved")).toEqual([]);
}

/** Prompts `session` and waits for its first pending row and its published approval.request. */
export async function pendingApproval(
  world: RecordingWorld,
  session = world.session,
): Promise<ApprovalRow> {
  await prompted(world, session);
  const [row] = await waitForRows(world, 1, session);
  await waitForEvent(world, "approval.request", 1, session);
  if (row === undefined) {
    throw new Error("missing pending approval row");
  }
  return row;
}
