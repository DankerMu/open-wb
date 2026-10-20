/**
 * Issue #1569 (omp-pin-18-12 design D8) turn-artifacts「浏览器截图进入文件变更」 and the eval half of
 * 「未绑定会话」 through the production assembly (createApp → registerSessions → SessionSupervisor,
 * in-memory SQLite) with a scripted controlled child (session-approval-script.ts). The session made
 * over `POST /api/sessions` is bound to its temporary workspace `tmp-<id>` (#930), whose root `<ws>`
 * is rebuilt from the row the way the workspace store answers it. Each step's start frame is sent
 * only once the previous step's step.end is published, the step's files are written when its own
 * step.start is published, and only then its end frame is sent, so every write lands after the
 * turn's baseline and inside the step that is running. Oracles: the recorded onEvent stream, SSE
 * bytes, the raw `chat_steps.changes` column, the snapshot, and `screenshotFs.opendirSync` calls.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/sessions/events.js";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { screenshotFs } from "../src/sessions/screenshot-diff.js";
import { parseSse, prompted, REAL, sessionEvents, settle } from "./session-approval-helpers.js";
import { AGENT_END, closeScripted, openScripted } from "./session-approval-script.js";
import { openEventStream, readUntil } from "./session-sse-helpers.js";
import {
  OWNER_ID,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";
import { seedUnboundSession } from "./support/temporary-workspace.js";

const UNBOUND = "9".repeat(32);
const restores: Array<() => void> = [];

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  vi.restoreAllMocks();
  await closeScripted();
});

interface Step {
  call: string;
  tool: "eval" | "bash";
  failed?: boolean;
  /** Runs when this step's step.start is published, before its end frame is sent. */
  during?(): void;
  /** Runs when this step's step.end is published, before the next start frame is sent. */
  after?(): void;
}

interface Driven {
  world: RecordingWorld;
  /** `<ws>`: the bound temporary workspace's root. */
  ws: string;
  ownerRoot: string;
  run(steps: Step[], session?: string): Promise<void>;
}

function startFrame(step: Step): OmpFrame {
  const args = step.tool === "eval" ? { language: "js", code: "await tab.screenshot()" } : {};
  return { type: "tool_execution_start", toolCallId: step.call, toolName: step.tool, args };
}

function endFrame(step: Step): OmpFrame {
  return {
    type: "tool_execution_end",
    toolCallId: step.call,
    toolName: step.tool,
    isError: step.failed === true,
    result: { content: [{ type: "text", text: `${step.call} out` }], details: {} },
  };
}

async function drive(): Promise<Driven> {
  const queue: Step[][] = [];
  let child: FakeChild | undefined;
  let steps: Step[] = [];
  let index = 0;
  const { world, sandboxRoot } = await openScripted({
    prompt(kept) {
      child = kept;
      steps = queue.shift() ?? [];
      index = 0;
      const first = steps[0];
      kept.emitLine(first === undefined ? AGENT_END : startFrame(first));
    },
    onEvent(_world, event) {
      const step = steps[index];
      if (step === undefined || child === undefined) return;
      if (event.type === "step.start") {
        step.during?.();
        child.emitLine(endFrame(step));
      } else if (event.type === "step.end") {
        step.after?.();
        index += 1;
        const next = steps[index];
        child.emitLine(next === undefined ? AGENT_END : startFrame(next));
      }
    },
  });
  const row = world.fixture.db
    .prepare("SELECT workspace_id FROM chat_sessions WHERE id = ?")
    .get(world.session) as { workspace_id: string };
  const ownerRoot = realpathSync(join(sandboxRoot, OWNER_ID));
  const ws = join(ownerRoot, `tmp-${row.workspace_id}`);
  expect(existsSync(ws)).toBe(true);
  vi.spyOn(screenshotFs, "opendirSync");
  return {
    world,
    ws,
    ownerRoot,
    async run(turn, session = world.session) {
      const ended = turnEnds(world, session);
      queue.push(turn);
      await prompted(world, session);
      await waitFor(
        () => (turnEnds(world, session) > ended ? true : undefined),
        "the scripted turn's turn.end",
      );
      await waitForTurn(world.fixture, session, "done");
      await settle();
    },
  };
}

function turnEnds(world: RecordingWorld, session: string): number {
  return sessionEvents(world, session).filter((entry) => entry.event.type === "turn.end").length;
}

function reads(): number {
  return vi.mocked(screenshotFs.opendirSync).mock.calls.length;
}

function writeIn(dir: string, ...names: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) writeFileSync(join(dir, name), "png");
}

function fillers(dir: string, count: number): string[] {
  const names = Array.from({ length: count }, (_, i) => `f-${String(i).padStart(4, "0")}.png`);
  writeIn(dir, ...names);
  return names;
}

/** chmod 000 a directory, restored by afterEach even when an assertion fails first. */
function lock(dir: string): void {
  chmodSync(dir, 0o000);
  restores.push(() => chmodSync(dir, 0o755));
}

function outsideDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-1569-outside-")));
  restores.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function shot(...names: string[]) {
  return names.map((name) => ({
    path: `screenshots/${name}`,
    added: null,
    removed: null,
    kind: "write",
  }));
}

function shotText(...names: string[]): string {
  return JSON.stringify(shot(...names));
}

/** The n-th (0-based) assistant message of the session and its raw step rows by ordinal. */
function turnRows(world: RecordingWorld, n: number, session = world.session) {
  const { db } = world.fixture;
  const messages = db
    .prepare("SELECT id FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id")
    .all(session) as Array<{ id: number }>;
  const messageId = Number(messages[n]?.id);
  const steps = db
    .prepare(
      "SELECT id, name, status, changes FROM chat_steps WHERE message_id = ? ORDER BY ordinal",
    )
    .all(messageId)
    .map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      status: String(row.status),
      changes: row.changes === null ? null : String(row.changes),
    }));
  return { messageId, steps };
}

/** The n-th (0-based) turn's events, turn.start through turn.end. */
function turnEvents(world: RecordingWorld, n: number, session = world.session) {
  const turns: ChatEvent<number>[][] = [];
  for (const { event } of sessionEvents(world, session)) {
    if (event.type === "turn.start") turns.push([]);
    turns.at(-1)?.push(event);
  }
  return turns[n] ?? [];
}

function typesOf(events: ChatEvent<number>[]): string[] {
  return events.map((event) => event.type);
}

/** One eval step and its turn: no files.changed, the step.end published done, changes null. */
function expectNoChange(world: RecordingWorld, n: number, session = world.session): void {
  const { steps } = turnRows(world, n, session);
  expect(typesOf(turnEvents(world, n, session))).toEqual([
    "turn.start",
    "step.start",
    "step.end",
    "turn.end",
  ]);
  expect(steps.map(({ name, status, changes }) => [name, status, changes])).toEqual([
    ["eval", "done", null],
  ]);
  expect(world.errors).toEqual([]);
}

/** One eval step whose files.changed carries exactly `names`, right before its step.end. */
function expectShots(world: RecordingWorld, n: number, ...names: string[]): void {
  const { messageId, steps } = turnRows(world, n);
  const stepId = steps[0]?.id;
  expect(turnEvents(world, n)).toEqual([
    { type: "turn.start", data: { messageId } },
    expect.objectContaining({ type: "step.start" }),
    { type: "files.changed", data: { messageId, stepId, files: shot(...names) } },
    { type: "step.end", data: { messageId, stepId, status: "done", output: "e1 out" } },
    { type: "turn.end", data: { messageId, status: "done" } },
  ]);
  expect(steps.map(({ name, changes }) => [name, changes])).toEqual([["eval", shotText(...names)]]);
  expect(world.errors).toEqual([]);
}

describe("turn-artifacts「浏览器截图进入文件变更」", () => {
  it(
    "baseline, a subdirectory, an escaping link, a failed eval, a bash step; the next turn adds none",
    REAL,
    async () => {
      const { world, ws, run } = await drive();
      const shots = join(ws, "screenshots");
      const outside = outsideDir();
      writeFileSync(join(outside, "secret.png"), "x");
      writeIn(shots, "old.png");
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await run([
        {
          call: "e1",
          tool: "eval",
          during() {
            writeIn(shots, "screenshot-1.png");
            writeIn(join(shots, "d"), "x.png");
            symlinkSync(join(outside, "secret.png"), join(shots, "l.png"));
          },
        },
        {
          call: "e2",
          tool: "eval",
          failed: true,
          during: () => writeIn(shots, "screenshot-2.png"),
        },
        { call: "c3", tool: "bash", during: () => writeIn(shots, "screenshot-3.png") },
      ]);
      expect(reads()).toBe(3);
      const sseText = await readUntil(stream, (text) => text.includes("event: turn.end"));
      stream.abort();

      const { messageId, steps } = turnRows(world, 0);
      const [first, second, bash] = steps;
      const firstId = first?.id;
      const secondId = second?.id;
      const events = turnEvents(world, 0);
      expect(typesOf(events)).toEqual([
        "turn.start",
        "step.start",
        "files.changed",
        "step.end",
        "step.start",
        "files.changed",
        "step.end",
        "step.start",
        "step.end",
        "turn.end",
      ]);
      expect(events.filter((event) => event.type === "files.changed")).toEqual([
        {
          type: "files.changed",
          data: { messageId, stepId: firstId, files: shot("screenshot-1.png") },
        },
        {
          type: "files.changed",
          data: { messageId, stepId: secondId, files: shot("screenshot-2.png") },
        },
      ]);
      expect(
        events.filter((event) => event.type === "step.end").map((event) => event.data),
      ).toEqual([
        { messageId, stepId: firstId, status: "done", output: "e1 out" },
        { messageId, stepId: secondId, status: "failed", output: "e2 out" },
        { messageId, stepId: bash?.id, status: "done", output: "c3 out" },
      ]);
      expect(steps.map(({ name, status, changes }) => [name, status, changes])).toEqual([
        ["eval", "done", shotText("screenshot-1.png")],
        ["eval", "failed", shotText("screenshot-2.png")],
        ["bash", "done", null],
      ]);

      const sse = parseSse(sseText);
      expect(sse.map((frame) => frame.event)).toEqual(typesOf(events));
      const fileFrames = sse.flatMap((frame, i) => (frame.event === "files.changed" ? [i] : []));
      for (const i of fileFrames) {
        expect(sse[i + 1]?.event).toBe("step.end");
        expect(sse[i + 1]?.data.stepId).toBe(sse[i]?.data.stepId);
      }
      expect(fileFrames.map((i) => sse[i]?.data)).toEqual([
        { messageId, stepId: firstId, files: shot("screenshot-1.png") },
        { messageId, stepId: secondId, files: shot("screenshot-2.png") },
      ]);

      const snapshot = world.fixture.store
        .getMessages(world.session, OWNER_ID)
        ?.messages.find((message) => message.id === messageId);
      expect(snapshot?.steps.map((step) => [step.id, step.changes])).toEqual([
        [firstId, JSON.parse(String(first?.changes))],
        [secondId, JSON.parse(String(second?.changes))],
        [bash?.id, null],
      ]);
      const stored = steps.map((step) => step.changes).join("\n");
      for (const hostPath of [ws, outside, tmpdir(), realpathSync(tmpdir())]) {
        expect(sseText).not.toContain(hostPath);
        expect(stored).not.toContain(hostPath);
      }
      expect(world.errors).toEqual([]);

      await run([{ call: "e1", tool: "eval" }]);
      expectNoChange(world, 1);
      expect(reads()).toBe(5);
    },
  );

  it(
    "absent then created; a regular file then a directory; unreadable and 4097 entries at turn start",
    REAL,
    async () => {
      const { world, ws, run } = await drive();
      const shots = join(ws, "screenshots");
      expect(existsSync(shots)).toBe(false);
      await run([{ call: "e1", tool: "eval", during: () => writeIn(shots, "screenshot-9.png") }]);
      expectShots(world, 0, "screenshot-9.png");
      expect(reads()).toBe(2);

      rmSync(shots, { recursive: true });
      writeFileSync(shots, "a file");
      await run([
        {
          call: "e1",
          tool: "eval",
          during() {
            rmSync(shots);
            writeIn(shots, "screenshot-7.png");
          },
        },
      ]);
      expectShots(world, 1, "screenshot-7.png");
      expect(reads()).toBe(4);

      lock(shots);
      await run([
        {
          call: "e1",
          tool: "eval",
          during() {
            chmodSync(shots, 0o755);
            writeIn(shots, "screenshot-10.png");
          },
        },
      ]);
      expectNoChange(world, 2);
      expect(reads()).toBe(5);

      const names = fillers(shots, 4095);
      await run([
        {
          call: "e1",
          tool: "eval",
          during() {
            for (const name of names.slice(0, 2)) rmSync(join(shots, name));
            writeIn(shots, "screenshot-11.png");
          },
        },
      ]);
      expectNoChange(world, 3);
      expect(reads()).toBe(6);
    },
  );

  it(
    "unreadable during the first eval, readable again in the second: it reports both steps' files",
    REAL,
    async () => {
      const { world, ws, run } = await drive();
      const shots = join(ws, "screenshots");
      writeIn(shots, "old.png");
      await run([
        {
          call: "e1",
          tool: "eval",
          during() {
            writeIn(shots, "screenshot-6.png");
            lock(shots);
          },
          after: () => chmodSync(shots, 0o755),
        },
        { call: "e2", tool: "eval", during: () => writeIn(shots, "screenshot-8.png") },
      ]);
      expectTwoEvals(world, ["screenshot-6.png", "screenshot-8.png"]);
      expect(reads()).toBe(3);
    },
  );

  it(
    "4097 entries during the first eval, 4096 in the second: it reports both steps' files",
    REAL,
    async () => {
      const { world, ws, run } = await drive();
      const shots = join(ws, "screenshots");
      const names = fillers(shots, 4090);
      const added = ["g-0.png", "g-1.png", "g-2.png", "g-3.png", "g-4.png", "g-5.png"];
      await run([
        {
          call: "e1",
          tool: "eval",
          during: () => writeIn(shots, ...added, "screenshot-6.png"),
          after() {
            for (const name of names.slice(0, 2)) rmSync(join(shots, name));
          },
        },
        { call: "e2", tool: "eval", during: () => writeIn(shots, "screenshot-8.png") },
      ]);
      expectTwoEvals(world, [...added, "screenshot-6.png", "screenshot-8.png"]);
      expect(reads()).toBe(3);
    },
  );

  it(
    "screenshots is a link to a directory outside the workspace: read through, dropped by ownership",
    REAL,
    async () => {
      const { world, ws, run } = await drive();
      const outside = outsideDir();
      symlinkSync(outside, join(ws, "screenshots"));
      await run([{ call: "e1", tool: "eval", during: () => writeIn(outside, "screenshot-5.png") }]);
      expectNoChange(world, 0);
      expect(reads()).toBe(2);
    },
  );
});

/** e1 has no files.changed and changes null; e2's files.changed carries exactly `names`. */
function expectTwoEvals(world: RecordingWorld, names: string[]): void {
  const { messageId, steps } = turnRows(world, 0);
  const [first, second] = steps;
  expect(typesOf(turnEvents(world, 0))).toEqual([
    "turn.start",
    "step.start",
    "step.end",
    "step.start",
    "files.changed",
    "step.end",
    "turn.end",
  ]);
  expect(turnEvents(world, 0).filter((event) => event.type === "files.changed")).toEqual([
    { type: "files.changed", data: { messageId, stepId: second?.id, files: shot(...names) } },
  ]);
  expect(steps.map(({ name, status, changes }) => [name, status, changes])).toEqual([
    ["eval", "done", null],
    ["eval", "done", shotText(...names)],
  ]);
  expect(first?.id).not.toBe(second?.id);
  expect(world.errors).toEqual([]);
}

describe("turn-artifacts「未绑定会话」 (eval)", () => {
  it(
    "an eval writing <ownerRoot>/screenshots/x.png: no files.changed, changes null, no read",
    REAL,
    async () => {
      const { world, ownerRoot, run } = await drive();
      const session = seedUnboundSession(world.fixture.db, OWNER_ID, UNBOUND);
      const shots = join(ownerRoot, "screenshots");
      await run([{ call: "e1", tool: "eval", during: () => writeIn(shots, "x.png") }], session);
      expect(existsSync(join(shots, "x.png"))).toBe(true);
      expectNoChange(world, 0, session);
      expect(reads()).toBe(0);
    },
  );
});
