/**
 * Issue #522 `files.changed` end to end: the production assembly (createApp → registerSessions)
 * over real fake-omp `edit-write` children, which really write `<cwd>/notes.md` and
 * `<cwd>/out/report.html` and report them as absolute paths. A workspace is created over
 * `POST /api/workspaces` and bound by a direct SQL write of `chat_sessions.workspace_id` (no
 * binding route yet). Oracles: the recorded onEvent stream, real SSE bytes, the raw
 * `chat_steps.changes` column (never the snapshot projection, except where F2 compares the two)
 * and the error sink.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import {
  ofType,
  parseSse,
  prompted,
  REAL,
  sessionEvents,
  settle,
} from "./session-approval-helpers.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import {
  assistantIdFor,
  closeAfterRetainedFault,
  containsMessage,
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";

/** fake-omp `edit-write` literals (support/fake-omp-thinking.mjs); copied, not imported. */
const THOUGHT = "先读需求，再列要点，最后作答。";
const ANSWER = ["Edited notes.md ", "and wrote out/report.html."];
const EDIT_OUTPUT = "Updated notes.md";
const WRITE_OUTPUT = "Successfully wrote 58 bytes to out/report.html";
/** turn-artifacts Scenario「edit 与 write 的推导」payloads and their stored text. */
const NOTES = [{ path: "notes.md", added: 2, removed: 1, kind: "edit" }];
const REPORT = [{ path: "out/report.html", added: null, removed: null, kind: "write" }];
const NOTES_TEXT = '[{"path":"notes.md","added":2,"removed":1,"kind":"edit"}]';
const REPORT_TEXT = '[{"path":"out/report.html","added":null,"removed":null,"kind":"write"}]';
const SENTINEL = "changes write sentinel";

interface StepRow {
  id: number;
  name: string;
  status: string;
  output: string | null;
  changes: string | null;
}

interface World extends RecordingWorld {
  sandboxRoot: string;
  /** The bound workspace's root as the workspace API answered it; null for an unbound session. */
  workspaceRoot: string | null;
}

interface WorldOptions {
  bound: boolean;
  /** Every child runs here instead of the cwd the supervisor chose. */
  childCwd?: string;
  prepare?: (db: DatabaseSync) => void;
  onEvent?: (event: ChatEvent<number>) => void;
  /** The world ends with a retained fault: closing the app rejects with it. */
  faulted?: boolean;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

/** A canonical directory outside every sandbox, removed after the test. */
function outsideDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-522-outside-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function openWorld(options: WorldOptions): Promise<World> {
  const { runtime } = createRealFakeRuntime("edit-write");
  // macOS tmpdir is a symlink (/var → /private/var): name the sandbox root canonically so the
  // owner root an unbound child runs in is itself canonical, as a production sandbox root is.
  runtime.sandboxRoot = join(realpathSync(dirname(runtime.sandboxRoot)), "sandbox");
  const { childCwd } = options;
  if (childCwd !== undefined) {
    const spawn = runtime.spawnImpl;
    runtime.spawnImpl = (command, args, spawnOptions) =>
      spawn(command, args, { ...spawnOptions, cwd: childCwd });
  }
  const { onEvent, prepare } = options;
  const world = await openRecordingSession(runtime, {
    ...(prepare === undefined ? {} : { prepare }),
    ...(onEvent === undefined ? {} : { onEvent: (_id, _epoch, event) => onEvent(event) }),
  });
  cleanups.push(() => closeAfterRetainedFault(world.fixture, options.faulted === true));
  const workspaceRoot = options.bound ? await bindWorkspace(world, runtime.sandboxRoot) : null;
  return { ...world, sandboxRoot: runtime.sandboxRoot, workspaceRoot };
}

/** Creates u1's workspace `proj` (the store realpaths the sandbox root) and binds the session. */
async function bindWorkspace(world: RecordingWorld, sandboxRoot: string): Promise<string> {
  mkdirSync(sandboxRoot, { recursive: true });
  const created = await world.fixture.app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ name: "proj", dir: "proj" }),
  });
  expect(created.statusCode).toBe(201);
  const workspace = created.json() as { id: string; root: string };
  const bound = world.fixture.db
    .prepare("UPDATE chat_sessions SET workspace_id = ? WHERE id = ?")
    .run(workspace.id, world.session);
  expect(Number(bound.changes)).toBe(1);
  expect(workspace.root).toBe(join(sandboxRoot, OWNER_ID, "proj"));
  return workspace.root;
}

async function runTurn(world: World): Promise<void> {
  await prompted(world);
  await waitForTurn(world.fixture, world.session, "done");
  await settle();
}

function events(world: World): ChatEvent<number>[] {
  return sessionEvents(world).map((entry) => entry.event);
}

function types(world: World): string[] {
  return events(world).map((event) => event.type);
}

/** The raw step rows of the world's session, oldest first. */
function stepRows(db: DatabaseSync): StepRow[] {
  const rows = db
    .prepare("SELECT id, name, status, output, changes FROM chat_steps ORDER BY id")
    .all() as unknown as StepRow[];
  return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

/** Neither the sandbox root (hence no owner or workspace root) nor `extra` appears in `value`. */
function expectNoHostPath(world: World, value: unknown, ...extra: string[]): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const hostPath of [world.sandboxRoot, tmpdir(), realpathSync(tmpdir()), ...extra]) {
    expect(text).not.toContain(hostPath);
  }
}

/** The turn without any files.changed: what an unbound or out-of-root turn publishes. */
function expectPlainTurn(world: World): void {
  expect(types(world)).toEqual([
    "turn.start",
    "thinking.delta",
    "step.start",
    "step.end",
    "step.start",
    "step.end",
    "text.delta",
    "text.delta",
    "turn.end",
  ]);
  expect(ofType(sessionEvents(world), "files.changed")).toEqual([]);
  expect(ofType(sessionEvents(world), "step.end").map((event) => event.data)).toEqual(
    stepRows(world.fixture.db).map((row, index) => ({
      messageId: assistantIdFor(world.fixture, world.session),
      stepId: row.id,
      status: "done",
      output: [EDIT_OUTPUT, WRITE_OUTPUT][index],
    })),
  );
  expect(
    stepRows(world.fixture.db).map(({ name, status, output, changes }) => [
      name,
      status,
      output,
      changes,
    ]),
  ).toEqual([
    ["edit", "done", EDIT_OUTPUT, null],
    ["write", "done", WRITE_OUTPUT, null],
  ]);
  expect(world.errors).toEqual([]);
}

describe("files.changed in a workspace-bound session", () => {
  it(
    "F1 each step publishes its owned files after the changes commit and before step.end",
    REAL,
    async () => {
      let db: DatabaseSync | undefined;
      /** The step row read inside the sink, the instant each files.changed / step.end arrives. */
      const atPublish: Array<[string, string | null, string]> = [];
      const world = await openWorld({
        bound: true,
        prepare(opened) {
          db = opened;
        },
        onEvent(event) {
          if (db !== undefined && (event.type === "files.changed" || event.type === "step.end")) {
            const row = stepRows(db).find((step) => step.id === event.data.stepId);
            atPublish.push([event.type, row?.changes ?? null, String(row?.status)]);
          }
        },
      });
      const root = String(world.workspaceRoot);
      expect(realpathSync(root)).toBe(root);
      await runTurn(world);

      const assistant = assistantIdFor(world.fixture, world.session);
      const [edit, write] = stepRows(world.fixture.db);
      expect([edit?.name, write?.name]).toEqual(["edit", "write"]);
      expect(events(world)).toEqual([
        { type: "turn.start", data: { messageId: assistant } },
        { type: "thinking.delta", data: { messageId: assistant, delta: THOUGHT } },
        {
          type: "step.start",
          data: {
            messageId: assistant,
            stepId: edit?.id,
            name: "edit",
            detail: expect.any(String),
          },
        },
        { type: "files.changed", data: { messageId: assistant, stepId: edit?.id, files: NOTES } },
        {
          type: "step.end",
          data: { messageId: assistant, stepId: edit?.id, status: "done", output: EDIT_OUTPUT },
        },
        {
          type: "step.start",
          data: {
            messageId: assistant,
            stepId: write?.id,
            name: "write",
            detail: expect.any(String),
          },
        },
        { type: "files.changed", data: { messageId: assistant, stepId: write?.id, files: REPORT } },
        {
          type: "step.end",
          data: { messageId: assistant, stepId: write?.id, status: "done", output: WRITE_OUTPUT },
        },
        ...ANSWER.map((delta) => ({ type: "text.delta", data: { messageId: assistant, delta } })),
        { type: "turn.end", data: { messageId: assistant, status: "done" } },
      ]);
      // Eleven events took eleven consecutive ring ids (F2 reads the ids off the SSE stream).
      expect(world.fixture.supervisor.streamCursor(world.session)).toEqual({
        epoch: sessionEvents(world)[0]?.epoch,
        seq: 11,
      });

      const published = ofType(sessionEvents(world), "files.changed");
      expect(published.map((event) => typeof event.data.stepId)).toEqual(["number", "number"]);
      for (const event of published) {
        for (const file of event.data.files) {
          expect(Object.keys(file)).toEqual(["path", "added", "removed", "kind"]);
        }
      }
      expect([edit?.changes, write?.changes]).toEqual([NOTES_TEXT, REPORT_TEXT]);
      expect(published.map((event) => JSON.stringify(event.data.files))).toEqual([
        edit?.changes,
        write?.changes,
      ]);
      expect([edit?.status, edit?.output, write?.status, write?.output]).toEqual([
        "done",
        EDIT_OUTPUT,
        "done",
        WRITE_OUTPUT,
      ]);
      // Committed before publication, while the step is still running; step.end keeps the text.
      expect(atPublish).toEqual([
        ["files.changed", NOTES_TEXT, "running"],
        ["step.end", NOTES_TEXT, "done"],
        ["files.changed", REPORT_TEXT, "running"],
        ["step.end", REPORT_TEXT, "done"],
      ]);

      expect(readdirSync(root).sort()).toEqual(["notes.md", "out"]);
      expectNoHostPath(world, events(world), root);
      expectNoHostPath(world, stepRows(world.fixture.db), root);
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "F2 a reconnect before thinking.delta replays each event once and the snapshot agrees",
    REAL,
    async () => {
      const world = await openWorld({ bound: true });
      await runTurn(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      const epoch = String(sessionEvents(world)[0]?.epoch);

      const stream = await openEventStream(
        world.fixture,
        world.session,
        world.cookie,
        `${epoch}:1`,
      );
      const bytes = await readUntil(stream, (text) => text.includes(`id: ${epoch}:11\n`));
      stream.abort();
      const frames = parseSse(bytes);

      expect(frames.map((frame) => frame.id)).toEqual(
        [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((seq) => `${epoch}:${String(seq)}`),
      );
      expect(frames.map((frame) => frame.event)).toEqual([
        "thinking.delta",
        "step.start",
        "files.changed",
        "step.end",
        "step.start",
        "files.changed",
        "step.end",
        "text.delta",
        "text.delta",
        "turn.end",
      ]);
      // Byte-for-value equal to what was published live, turn.start (id 1) excluded.
      expect(frames.map((frame) => frame.data)).toEqual(
        events(world)
          .slice(1)
          .map((event) => event.data),
      );
      const [edit, write] = stepRows(world.fixture.db);
      expect(frames[2]?.data).toEqual({ messageId: assistant, stepId: edit?.id, files: NOTES });
      expect(frames[5]?.data).toEqual({ messageId: assistant, stepId: write?.id, files: REPORT });
      expectNoHostPath(world, bytes, String(world.workspaceRoot));

      const history = await world.fixture.app.inject({
        method: "GET",
        url: `/api/sessions/${world.session}/messages`,
        headers: { cookie: world.cookie },
      });
      expect(history.statusCode).toBe(200);
      const snapshot = history.json() as {
        messages: Array<{
          role: string;
          thinking: string | null;
          steps: Array<{ id: number; changes: unknown }>;
        }>;
      };
      const answer = snapshot.messages.find((message) => message.role === "assistant");
      expect(answer?.thinking).toBe(THOUGHT);
      expect(answer?.thinking).toBe(frames[0]?.data.delta);
      expect(answer?.steps.map((step) => [step.id, step.changes])).toEqual([
        [frames[2]?.data.stepId, frames[2]?.data.files],
        [frames[5]?.data.stepId, frames[5]?.data.files],
      ]);
      expect(answer?.steps.map((step) => step.changes)).toEqual([NOTES, REPORT]);
      expectNoHostPath(world, history.body, String(world.workspaceRoot));
      expect(world.errors).toEqual([]);
    },
  );

  it(
    "F3 a child working outside the workspace root yields no files.changed and NULL changes",
    REAL,
    async () => {
      const outside = outsideDir();
      const world = await openWorld({ bound: true, childCwd: outside });
      await runTurn(world);

      // The child really edited and wrote, but under `outside`: both candidates are absolute
      // paths beyond the bound root.
      expect(existsSync(join(outside, "notes.md"))).toBe(true);
      expect(existsSync(join(outside, "out", "report.html"))).toBe(true);
      expect(readdirSync(String(world.workspaceRoot))).toEqual([]);
      expectPlainTurn(world);
      expectNoHostPath(world, events(world), outside);
    },
  );
});

describe("files.changed in an unbound session", () => {
  it("F4 nothing is judged, stored or published and step.end is unchanged", REAL, async () => {
    const world = await openWorld({ bound: false });
    const ownerRoot = join(world.sandboxRoot, OWNER_ID);
    await runTurn(world);

    // The owner root the child wrote into is a canonical directory: only the missing binding
    // keeps its files out.
    expect(realpathSync(ownerRoot)).toBe(ownerRoot);
    expect(existsSync(join(ownerRoot, "notes.md"))).toBe(true);
    expect(existsSync(join(ownerRoot, "out", "report.html"))).toBe(true);
    expect(world.fixture.store.runtimeState(world.session)?.workspaceId).toBeNull();
    expectPlainTurn(world);
    expectNoHostPath(world, events(world));
  });
});

describe("files.changed whose changes write fails", () => {
  it(
    "F5 the stream stops at step.start: no files.changed, no spent id, the error sink is taken",
    REAL,
    async () => {
      const world = await openWorld({
        bound: true,
        faulted: true,
        prepare(db) {
          db.exec(`CREATE TEMP TRIGGER reject_changes BEFORE UPDATE OF changes ON chat_steps
            BEGIN SELECT RAISE(ABORT, '${SENTINEL}'); END`);
        },
      });
      // Opened before the turn and flowing: it receives live exactly what the ring takes.
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();

      await prompted(world);
      await waitFor(
        () => (world.errors.some((error) => containsMessage(error, SENTINEL)) ? true : undefined),
        "changes write sentinel in the error sink",
      );
      const epoch = String(sessionEvents(world)[0]?.epoch);
      await readUntil(stream, (text) => text.includes(`id: ${epoch}:3\n`));
      await settle();

      const assistant = assistantIdFor(world.fixture, world.session);
      const [edit, ...later] = stepRows(world.fixture.db);
      expect(later).toEqual([]);
      expect([edit?.name, edit?.changes, edit?.output]).toEqual(["edit", null, null]);

      const frames = parseSse(await readUntil(stream, () => true));
      stream.abort();
      expect(frames.map((frame) => [frame.id, frame.event])).toEqual([
        [`${epoch}:1`, "turn.start"],
        [`${epoch}:2`, "thinking.delta"],
        [`${epoch}:3`, "step.start"],
      ]);
      expect(frames[2]?.data).toMatchObject({ messageId: assistant, stepId: edit?.id });
      expect(types(world)).toEqual(["turn.start", "thinking.delta", "step.start"]);
      expect(world.errors.filter((error) => containsMessage(error, SENTINEL))).toHaveLength(1);
    },
  );
});
