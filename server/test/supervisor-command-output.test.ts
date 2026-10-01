/**
 * Issue #554 local command output through the supervisor: production assembly (createApp →
 * registerSessions) over real fake-omp `slash` children (`--compact-silent` appended by a spawn
 * wrapper), real SQLite, prompts and stop through REST. Oracles are the recorded onEvent stream,
 * `chat_messages`/`chat_steps`/`chat_sessions` rows (the assistant row also read inside the
 * turn.end publication) and the child's stdout lines. The runtime's local-completion wait is the
 * only 120000 ms timer on the injected clock (stop grace 8000 ms, idle 10000 ms unless a case
 * overrides it); the command texts are omp v18.0.10's, copied, not imported.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { ofType, REAL, sessionEvents, settle, waitForEvent } from "./session-approval-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import { messageRow, sessionRow, stepRows } from "./session-store-helpers.js";
import {
  assistantIdFor,
  createRealFakeRuntime,
  openRecordingSession,
  type RecordingWorld,
  waitFor,
} from "./session-supervisor-helpers.js";
import { isLive, tapStdout, waitExited } from "./session-supervisor-pool-helpers.js";
import type { TestClock } from "./support/omp-runtime.js";

const TODO_OUTPUT = "No todos. Use /todo append <task> to start one.";
const COMPACT_OUTPUT = "Compaction complete.";
/** omp-runtime「每会话生命周期」: the bounded wait for a late command_output. */
const LOCAL_GRACE_MS = 120_000;
/** turn-control OMP_ABORT_GRACE_MS. */
const ABORT_GRACE_MS = 8_000;
/** Production default idle; above the local grace, so the silent compaction ends `done`. */
const PRODUCTION_IDLE_MS = 600_000;

interface SlashOptions {
  extraArgs?: string[];
  idleMs?: number;
}

interface SlashWorld extends RecordingWorld {
  clock: TestClock;
  children: ChildProcessWithoutNullStreams[];
  /** Complete stdout lines of the first child, parsed. */
  stdout(): OmpFrame[];
  /** Local-completion timers (120000 ms) armed so far on the injected clock. */
  graceArms(): number;
  /** The assistant row as read inside each turn.end publication. */
  atTurnEnd: Array<{ content: string; status: string }>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** Counts the 120000 ms timers armed on the clock every consumer shares; wrapped before the app opens. */
function countGraceArms(clock: TestClock): () => number {
  let arms = 0;
  const arm = clock.setTimeout.bind(clock);
  clock.setTimeout = (callback, ms) => {
    if (ms === LOCAL_GRACE_MS) {
      arms += 1;
    }
    return arm(callback, ms);
  };
  return () => arms;
}

async function openWorld(options: SlashOptions = {}): Promise<SlashWorld> {
  const { runtime, clock, children } = createRealFakeRuntime("slash");
  if (options.idleMs !== undefined) {
    runtime.idleMs = options.idleMs;
  }
  const texts = tapStdout(runtime);
  const inner = runtime.spawnImpl;
  runtime.spawnImpl = (command, args, spawnOptions) =>
    inner(command, [...args, ...(options.extraArgs ?? [])], spawnOptions);
  const graceArms = countGraceArms(clock);
  let db: DatabaseSync | undefined;
  const atTurnEnd: SlashWorld["atTurnEnd"] = [];
  const world = await openRecordingSession(runtime, {
    prepare(opened) {
      db = opened;
    },
    onEvent(_session, _epoch, event) {
      if (event.type === "turn.end" && db !== undefined) {
        const { content, status } = messageRow(db, event.data.messageId);
        atTurnEnd.push({ content, status });
      }
    },
  });
  cleanups.push(() => world.fixture.close());
  return {
    ...world,
    clock,
    children,
    stdout: () => completeLines(texts[0] ?? ""),
    graceArms,
    atTurnEnd,
  };
}

function completeLines(stdoutText: string): OmpFrame[] {
  return stdoutText
    .slice(0, stdoutText.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as OmpFrame);
}

function events(world: RecordingWorld): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

/** `POST …/prompt` with the command as the whole message; 202 means dispatched, not answered. */
async function command(world: SlashWorld, message: string): Promise<number> {
  const response = await postPrompt(
    world.fixture.app,
    world.session,
    world.cookie,
    JSON.stringify({ message }),
  );
  expect(response.statusCode).toBe(202);
  return assistantIdFor(world.fixture, world.session);
}

/** The runtime holds the turn open for a late command_output: its grace timer is armed. */
async function waitForLocalWait(world: SlashWorld): Promise<void> {
  await waitFor(
    () => (world.graceArms() > 0 ? true : undefined),
    "armed local-completion grace timer",
  );
}

async function postStop(world: SlashWorld): Promise<number> {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/stop`,
    headers: { cookie: world.cookie },
  });
  return response.statusCode;
}

function abortResponses(world: SlashWorld): OmpFrame[] {
  return world.stdout().filter((frame) => frame.type === "response" && frame.command === "abort");
}

function commandOutputs(world: SlashWorld): OmpFrame[] {
  return world.stdout().filter((frame) => frame.type === "command_output");
}

/** Waits for the turn's terminal publication and proves nothing follows it. */
async function settledTurn(world: SlashWorld): Promise<void> {
  await waitForEvent(world, "turn.end");
  const observed = events(world).length;
  await settle();
  expect(events(world)).toHaveLength(observed);
}

describe("local command output becomes the assistant body", () => {
  it("S1 /todo publishes turn.start, one text.delta and turn.end done", REAL, async () => {
    const world = await openWorld();
    const assistant = await command(world, "/todo");
    await settledTurn(world);

    expect(events(world)).toEqual([
      { type: "turn.start", data: { messageId: assistant } },
      { type: "text.delta", data: { messageId: assistant, delta: TODO_OUTPUT } },
      { type: "turn.end", data: { messageId: assistant, status: "done" } },
    ]);
    expect(world.atTurnEnd).toEqual([{ content: TODO_OUTPUT, status: "done" }]);
    const { db } = world.fixture;
    expect(messageRow(db, assistant)).toMatchObject({ content: TODO_OUTPUT, status: "done" });
    expect(stepRows(db)).toEqual([]);
    expect(sessionRow(db, world.session).status).toBe("done");
    expect(world.errors).toEqual([]);
  });

  it(
    "S2 /compact output arriving after the receipt is still stored before turn.end done",
    REAL,
    async () => {
      const world = await openWorld();
      const assistant = await command(world, "/compact");
      await settledTurn(world);

      expect(events(world)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "text.delta", data: { messageId: assistant, delta: COMPACT_OUTPUT } },
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      expect(world.atTurnEnd).toEqual([{ content: COMPACT_OUTPUT, status: "done" }]);
      const { db } = world.fixture;
      expect(messageRow(db, assistant)).toMatchObject({ content: COMPACT_OUTPUT, status: "done" });
      expect(stepRows(db)).toEqual([]);
      expect(sessionRow(db, world.session).status).toBe("done");
      expect(world.errors).toEqual([]);
      // The receipt preceded the output on the child's stdout: the turn waited for it.
      const types = world.stdout().map((frame) => frame.type);
      expect(types.lastIndexOf("response")).toBeLessThan(types.indexOf("command_output"));
    },
  );
});

describe("local command without output", () => {
  it(
    "S3 a silent /compact ends done with an empty body once the clock passes 120000 ms",
    REAL,
    async () => {
      const world = await openWorld({
        extraArgs: ["--compact-silent"],
        idleMs: PRODUCTION_IDLE_MS,
      });
      const assistant = await command(world, "/compact");
      await waitForLocalWait(world);
      await settle();
      const { db } = world.fixture;
      expect(events(world)).toEqual([]);
      expect(messageRow(db, assistant).status).toBe("running");
      expect(sessionRow(db, world.session).status).toBe("running");

      world.clock.advance(LOCAL_GRACE_MS);
      await settledTurn(world);
      expect(events(world)).toEqual([
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      expect(world.atTurnEnd).toEqual([{ content: "", status: "done" }]);
      expect(messageRow(db, assistant)).toMatchObject({ content: "", status: "done" });
      expect(sessionRow(db, world.session).status).toBe("done");
      expect(commandOutputs(world)).toEqual([]);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "S4 stop during the wait: abort answered, no output, one turn.end stopped after the grace",
    REAL,
    async () => {
      const world = await openWorld({ extraArgs: ["--compact-silent"] });
      const assistant = await command(world, "/compact");
      await waitForLocalWait(world);
      const child = world.children[0];
      if (child === undefined) {
        throw new Error("missing slash child");
      }
      const { db } = world.fixture;

      expect(await postStop(world)).toBe(202);
      const [answer] = await waitFor(() => {
        const found = abortResponses(world);
        return found.length > 0 ? found : undefined;
      }, "abort response on the child's stdout");
      // The real child answers only an `abort` frame it read, echoing that frame's id.
      expect(answer).toEqual({
        id: expect.any(String),
        type: "response",
        command: "abort",
        success: true,
      });
      await settle();
      expect(events(world)).toEqual([]);
      expect(sessionRow(db, world.session).status).toBe("running");
      expect(isLive(child)).toBe(true);

      world.clock.advance(ABORT_GRACE_MS);
      expect(child.stdin.writableEnded).toBe(true);
      await waitExited(child, "retired child");
      await settledTurn(world);
      expect(events(world)).toEqual([
        { type: "turn.end", data: { messageId: assistant, status: "stopped" } },
      ]);
      expect(ofType(sessionEvents(world), "error")).toEqual([]);
      expect(world.atTurnEnd).toEqual([{ content: "", status: "stopped" }]);
      expect(messageRow(db, assistant)).toMatchObject({ content: "", status: "stopped" });
      expect(sessionRow(db, world.session).status).toBe("stopped");
      expect(commandOutputs(world)).toEqual([]);
      expect(abortResponses(world)).toHaveLength(1);
      expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
      expect(world.errors).toEqual([]);
    },
  );
});
