/**
 * Issue #933 list event trigger points of the turn lifecycle and approvals (S1f task 6.4), on the
 * production createApp → registerSessions assembly with a real listener: each list connection is a
 * real HTTP client whose bytes are read natively. Turns run on fake omp (real children where the
 * scenario needs one, scripted FakeChild processes where a turn must be held).
 *
 * Silence and "everything written so far has arrived" are both proven with the heartbeat: the
 * injected clock writes one comment line per connection, after whatever was written before it.
 */
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/core/errors/index.js";
import type { ChatEvent } from "../src/sessions/events.js";
import {
  type ApprovalWorld,
  openApprovalWorld,
  prompted,
  REAL,
  TTL_MS,
  waitForEvent,
  waitForRows,
} from "./session-approval-helpers.js";
import { patch } from "./session-archive-helpers.js";
import {
  expectEnvelope,
  MALFORMED_JSON,
  postSessionAction,
} from "./session-bodyless-rest-helpers.js";
import { BAD_REQUEST_ENVELOPE, NOT_FOUND_ENVELOPE } from "./session-db-helpers.js";
import {
  accountOf,
  CHANGED_FRAME,
  changed,
  changedSince,
  closeListening,
  count,
  drainedBy,
  expectOnlyChangedFrames,
  HEARTBEAT_FRAME,
  type ListClient,
  type Listening,
  listedSession,
  listening,
  openList,
} from "./session-list-events-helpers.js";
import {
  type ChildScript,
  HOLD,
  heldLine,
  P,
  QUESTION,
  type ScriptedChild,
  scriptedAt,
  scriptedRuntime,
} from "./session-regenerate-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  postPrompt,
  SESSION_ARCHIVED_ENVELOPE,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import {
  completeHeldTurn,
  createSession,
  openRecordingSession,
  type RecordingWorld,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { presetSessionFile } from "./session-supervisor-pool-helpers.js";
import { holdNextPromptWrite } from "./support/omp-rpc.js";

/** Longer than any clock advance below: an idle process is never evicted mid-case. */
const NO_IDLE_EVICTION_MS = 3_600_000;
const ALLOW = JSON.stringify({ decision: "allow" });
const SELECT_LINE = (line: string) => line.includes('"extension_ui_request"');
const TERMINAL_LINE = (line: string) => line.includes('"agent_end"');

type ScriptedWorld = Listening<RecordingWorld & { scripted: ScriptedChild[] }>;
type RealWorld = Listening<ApprovalWorld>;
type AnyWorld = Listening<RecordingWorld>;

interface Listed {
  status: string;
  pendingApproval: boolean;
}

afterEach(async () => {
  vi.useRealTimers();
  await closeListening();
});

async function openScripted(script: ChildScript): Promise<ScriptedWorld> {
  const { rt, scripted } = scriptedRuntime([script]);
  rt.runtime.idleMs = NO_IDLE_EVICTION_MS;
  const world = await openRecordingSession(rt.runtime);
  return listening({ ...world, scripted }, rt.clock);
}

/** Real fake-omp children; `hold` gates the first child's stdout from its first matching line. */
async function openReal(
  scenario: string | undefined,
  hold?: (line: string) => boolean,
): Promise<RealWorld> {
  const world = await openApprovalWorld("approval", {
    idleMs: NO_IDLE_EVICTION_MS,
    ...(hold === undefined ? {} : { hold }),
  });
  world.rt.setScenario(scenario);
  return listening(world, world.clock, () => world.spawned.map((spawned) => spawned.child));
}

function drained(world: AnyWorld, ...clients: ListClient[]): Promise<number[]> {
  return drainedBy(world.clock, clients);
}

async function mark(world: AnyWorld, client: ListClient): Promise<number> {
  const [length] = await drained(world, client);
  return length ?? 0;
}

async function listed(world: AnyWorld, session = world.session): Promise<Listed | undefined> {
  const found = await listedSession<Listed>(world.fixture.app, world.cookie, session);
  return found === undefined
    ? undefined
    : { status: found.status, pendingApproval: found.pendingApproval };
}

function send(world: AnyWorld, message: string, session = world.session) {
  return postPrompt(world.fixture.app, session, world.cookie, JSON.stringify({ message }));
}

function child(world: ScriptedWorld) {
  return scriptedAt(world.scripted, 0).child;
}

/** A turn admitted over REST and held by the scripted child after its first delta. */
async function heldTurn(world: ScriptedWorld, message = QUESTION): Promise<void> {
  const prompts = () => scriptedAt(world.scripted, 0).frames.filter((f) => f.type === "prompt");
  const before = world.scripted.length === 0 ? 0 : prompts().length;
  expect((await send(world, message)).statusCode).toBe(202);
  await waitFor(() => (prompts().length > before ? true : undefined), "prompt frame");
}

/** One completed turn of QUESTION on the live child, resuming at P (regenerate's precondition). */
async function answeredTurn(world: ScriptedWorld): Promise<void> {
  await heldTurn(world);
  completeHeldTurn(child(world));
  await waitForTurn(world.fixture, world.session, "done");
  await waitFor(
    () => (world.fixture.supervisor.controlHeld(world.session) ? undefined : true),
    "turn claim released",
  );
  presetSessionFile(world.fixture.db, world.session, P);
}

function decide(world: AnyWorld, approvalId: number): Promise<LightMyRequestResponse> {
  return world.fixture.app.inject({
    method: "POST",
    url: `/api/sessions/${world.session}/approvals/${String(approvalId)}`,
    headers: { cookie: world.cookie, "content-type": "application/json" },
    payload: ALLOW,
  });
}

/** A real approval turn whose select is pending and whose terminal `agent_end` line is held. */
async function pendingApproval(): Promise<{ world: RealWorld; approvalId: number }> {
  const world = await openReal("approval", TERMINAL_LINE);
  await prompted(world);
  const [row] = await waitForRows(world, 1);
  await waitForEvent(world, "approval.request");
  if (row === undefined) {
    throw new Error("approval row missing");
  }
  return { world, approvalId: row.id };
}

interface Prepared {
  world: AnyWorld;
  client: ListClient;
  /** Length of the connection's text once everything before the write under test had arrived. */
  mark: number;
  /** The one write under test. */
  act(): Promise<void>;
}

interface TriggerRow {
  name: string;
  /** What `GET /api/sessions` shows for the session after the notification. */
  listed: Listed;
  prepare(): Promise<Prepared>;
}

async function prepared(world: AnyWorld, act: () => Promise<void>): Promise<Prepared> {
  const client = await openList(world, world.cookie);
  return { world, client, mark: await mark(world, client), act };
}

/** A scripted turn held after its first delta, the connection opened and read empty afterwards. */
async function preparedHeldTurn(act: (world: ScriptedWorld) => Promise<void>): Promise<Prepared> {
  const world = await openScripted({ prompt: "hold" });
  await heldTurn(world);
  return prepared(world, () => act(world));
}

async function preparedApproval(
  act: (world: RealWorld, approvalId: number) => Promise<void>,
): Promise<Prepared> {
  const { world, approvalId } = await pendingApproval();
  return prepared(world, () => act(world, approvalId));
}

const TRIGGER_ROWS: TriggerRow[] = [
  {
    name: "prompt accepted (the turn is held, not ended)",
    listed: { status: "running", pendingApproval: false },
    async prepare() {
      const world = await openScripted({ prompt: "hold" });
      return prepared(world, () => heldTurn(world));
    },
  },
  {
    name: "accept compensated (handshake refused, rollback, 502)",
    listed: { status: "idle", pendingApproval: false },
    async prepare() {
      const world = await openReal("missing-session", HOLD.ready);
      const client = await openList(world, world.cookie);
      const pending = send(world, "never dispatched");
      await heldLine(world);
      // The acceptance already notified; only what follows it counts for the compensation.
      await changed(client, 0, "the acceptance");
      return {
        world,
        client,
        mark: client.text().length,
        async act() {
          world.spawned[0]?.gate.release();
          expectEnvelope(await pending, 502, AGENT_UNAVAILABLE_ENVELOPE);
        },
      };
    },
  },
  {
    name: "regenerate committed (the new turn is held, not ended)",
    listed: { status: "running", pendingApproval: false },
    async prepare() {
      const world = await openScripted({ prompt: "hold" });
      await answeredTurn(world);
      return prepared(world, async () => {
        const response = await postSessionAction(
          world.fixture.app,
          "regenerate",
          world.session,
          world.cookie,
        );
        expect(response.statusCode).toBe(202);
      });
    },
  },
  {
    name: "regenerate dispatch failed after its commit (502, the new row settled failed)",
    listed: { status: "failed", pendingApproval: false },
    async prepare() {
      const world = await openScripted({ prompt: "hold" });
      await answeredTurn(world);
      // The dispatch receipt's session-file write is refused, so the committed turn cannot start.
      world.fixture.db.exec(
        "CREATE TRIGGER list_events_receipt BEFORE UPDATE OF omp_session_file ON chat_sessions WHEN OLD.status = 'running' AND NEW.omp_session_file = OLD.omp_session_file BEGIN SELECT RAISE(ABORT, 'list events'); END",
      );
      return prepared(world, async () => {
        const write = holdNextPromptWrite(child(world));
        const published = world.events.length;
        const pending = postSessionAction(
          world.fixture.app,
          "regenerate",
          world.session,
          world.cookie,
        );
        await write.entered;
        await world.fixture.supervisor.stop(world.session);
        write.release();
        expectEnvelope(await pending, 502, AGENT_UNAVAILABLE_ENVELOPE);
        // No turn.end was published for this settlement: only the route can have notified.
        expect(world.events.slice(published)).toEqual([]);
      });
    },
  },
  {
    name: "turn ended done",
    listed: { status: "done", pendingApproval: false },
    prepare: () =>
      preparedHeldTurn(async (world) => {
        completeHeldTurn(child(world));
      }),
  },
  {
    name: "turn ended failed (the process died mid-turn)",
    listed: { status: "failed", pendingApproval: false },
    prepare: () =>
      preparedHeldTurn(async (world) => {
        child(world).nativeExit(1);
        child(world).endStdout();
      }),
  },
  {
    name: "turn ended stopped (the owner stopped it)",
    listed: { status: "stopped", pendingApproval: false },
    prepare: () =>
      preparedHeldTurn(async (world) => {
        const response = await postSessionAction(
          world.fixture.app,
          "stop",
          world.session,
          world.cookie,
        );
        expect(response.statusCode).toBe(202);
      }),
  },
  {
    name: "approval inserted",
    listed: { status: "running", pendingApproval: true },
    async prepare() {
      const world = await openReal("approval", SELECT_LINE);
      await prompted(world);
      await heldLine(world);
      return prepared(world, async () => {
        world.spawned[0]?.gate.release();
        await waitForRows(world, 1);
      });
    },
  },
  {
    name: "approval settled by the owner's answer",
    listed: { status: "running", pendingApproval: false },
    prepare: () =>
      preparedApproval(async (world, approvalId) => {
        expect((await decide(world, approvalId)).statusCode).toBe(200);
      }),
  },
  {
    name: "approval settled by its timeout",
    listed: { status: "running", pendingApproval: false },
    prepare: () =>
      preparedApproval(async (world) => {
        world.clock.advance(TTL_MS);
      }),
  },
  {
    name: "approval settled by a stop",
    listed: { status: "running", pendingApproval: false },
    prepare: () =>
      preparedApproval(async (world) => {
        const response = await postSessionAction(
          world.fixture.app,
          "stop",
          world.session,
          world.cookie,
        );
        expect(response.statusCode).toBe(202);
      }),
  },
];

describe("session list events: turn lifecycle and approval trigger points", () => {
  it(
    "状态变化推送给所有者的每条连接: both owner connections get one after acceptance and one after the terminal state; the other account gets nothing",
    REAL,
    async () => {
      const world = await openReal(undefined, TERMINAL_LINE);
      const lisi = await accountOf(world.fixture.app, "lisi");
      const mine = [await openList(world, world.cookie), await openList(world, world.cookie)];
      const theirs = await openList(world, lisi.cookie);

      expect((await send(world, "hello")).statusCode).toBe(202);
      for (const client of mine) {
        await changed(client, 0, "the acceptance");
      }
      expect(await listed(world)).toEqual({ status: "running", pendingApproval: false });
      await heldLine(world);
      const marks = await drained(world, ...mine, theirs);

      world.spawned[0]?.gate.release();
      for (const [index, client] of mine.entries()) {
        await changed(client, marks[index] ?? 0, "the terminal state");
      }
      expect(await listed(world)).toEqual({ status: "done", pendingApproval: false });

      await drained(world, ...mine, theirs);
      for (const client of mine) {
        expect(count(client.text(), CHANGED_FRAME)).toBeGreaterThanOrEqual(2);
        expectOnlyChangedFrames(client);
      }
      // Two heartbeats bound the whole turn on the other account's connection: nothing else came.
      expect(theirs.text()).toBe(HEARTBEAT_FRAME.repeat(2));
    },
  );

  it(
    "待决确认的出现与结算: one after the approval row is inserted, one after the owner allowed it",
    REAL,
    async () => {
      const world = await openReal("approval", SELECT_LINE);
      const client = await openList(world, world.cookie);
      await prompted(world);
      await heldLine(world);
      expect(await listed(world)).toEqual({ status: "running", pendingApproval: false });

      const inserted = await mark(world, client);
      world.spawned[0]?.gate.release();
      const [row] = await waitForRows(world, 1);
      await changed(client, inserted, "the approval row");
      expect((await listed(world))?.pendingApproval).toBe(true);

      const settled = await mark(world, client);
      expect((await decide(world, row?.id ?? 0)).statusCode).toBe(200);
      await changed(client, settled, "the settlement");
      expect((await listed(world))?.pendingApproval).toBe(false);
      await waitForTurn(world.fixture, world.session, "done");
      expect(await listed(world)).toEqual({ status: "done", pendingApproval: false });
      expectOnlyChangedFrames(client);
    },
  );

  it.each(TRIGGER_ROWS)(
    "每个触发点各自通知: $name → at least one more sessions.changed",
    REAL,
    async (row) => {
      const { world, client, mark: before, act } = await row.prepare();
      await act();
      await changed(client, before, row.name);
      expect(await listed(world)).toEqual(row.listed);
      // sessions.changed only: no session.rewound, no other event, every data exactly `{}`.
      expectOnlyChangedFrames(client);
    },
  );
});

describe("session list events: rejected prompt and regenerate writes", () => {
  it(
    "被拒绝的写入不通知: busy, archived, unknown and malformed prompts, regenerate 404 and 409",
    REAL,
    async () => {
      const world = await openScripted({ prompt: "hold" });
      const { app } = world.fixture;
      const archived = await createSession(app, world.cookie);
      expect((await patch(world, { archived: true }, { session: archived })).statusCode).toBe(200);
      await heldTurn(world);
      const client = await openList(world, world.cookie);
      const before = await mark(world, client);

      expectEnvelope(await send(world, "second"), 409, SESSION_BUSY_ENVELOPE);
      expectEnvelope(await send(world, "to the archive", archived), 409, SESSION_ARCHIVED_ENVELOPE);
      expectEnvelope(await send(world, "nowhere", UNKNOWN_SESSION_ID), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(
        await postPrompt(app, world.session, world.cookie, MALFORMED_JSON.payload),
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expectEnvelope(
        await postSessionAction(app, "regenerate", UNKNOWN_SESSION_ID, world.cookie),
        404,
        NOT_FOUND_ENVELOPE,
      );
      expectEnvelope(
        await postSessionAction(app, "regenerate", world.session, world.cookie),
        409,
        SESSION_BUSY_ENVELOPE,
      );

      await drained(world, client);
      expect(client.text().slice(before)).toBe(HEARTBEAT_FRAME);
      expect(await listed(world)).toEqual({ status: "running", pendingApproval: false });
    },
  );

  it("被拒绝的写入不通知: a failed prompt whose turn already ended is not notified as compensated", async () => {
    await withSessionRest(async ({ app, store, supervisor, listNotified }) => {
      const cookie = await cookieFor(app, "zhangsan");
      const session = await createSession(app, cookie);
      // The create notified too (#932); only the prompt's notifications are counted below.
      listNotified.length = 0;
      const body = JSON.stringify({ message: "ends before it fails" });

      // The turn reaches its terminal state before the supervisor rejects: nothing to roll back.
      supervisor.onPrompt(async (sessionId) => {
        const turn = store.runtimeState(sessionId)?.activeTurn;
        expect(store.finishTurn(turn?.assistantMessageId ?? 0, "failed")).toBe(true);
        throw new HttpError("agent_unavailable");
      });
      expectEnvelope(await postPrompt(app, session, cookie, body), 502, AGENT_UNAVAILABLE_ENVELOPE);
      expect(listNotified).toEqual(["u1"]);

      // The same rejection with the turn still open is rolled back, and that is a second change.
      const other = await createSession(app, cookie);
      listNotified.length = 0;
      supervisor.onPrompt(async () => {
        throw new HttpError("agent_unavailable");
      });
      expectEnvelope(await postPrompt(app, other, cookie, body), 502, AGENT_UNAVAILABLE_ENVELOPE);
      expect(listNotified).toEqual(["u1", "u1"]);
    });
  });
});

describe("session list events: the notifier's turn observer is isolated from the turn", () => {
  it(
    "a throwing notifier observer leaves the turn, the assembly's observer and the supervisor untouched",
    REAL,
    async () => {
      const { rt, scripted } = scriptedRuntime([{ prompt: "hold" }]);
      const seen: Array<ChatEvent<number>["type"]> = [];
      const opened = await openRecordingSession(rt.runtime, {
        onEvent(_sessionId, _epoch, event) {
          seen.push(event.type);
        },
      });
      const world: ScriptedWorld = await listening({ ...opened, scripted }, rt.clock);
      const { supervisor } = world.fixture;
      await heldTurn(world);

      // From here on every notification of this account throws inside the observer.
      const notify = vi
        .spyOn(world.fixture.app.sessions.listEvents, "notify")
        .mockImplementation(() => {
          throw new Error("controlled list notifier failure");
        });
      completeHeldTurn(child(world));

      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(tree.messages.map((message) => [message.role, message.status])).toEqual([
        ["user", "done"],
        ["assistant", "done"],
      ]);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith(world.fixture.store.runtimeState(world.session)?.ownerId);
      expect(seen).toEqual(["turn.start", "text.delta", "turn.end"]);
      expect(world.errors).toEqual([]);
      // No fault was retained: the slot is reusable and shutdown reports nothing.
      notify.mockRestore();
      await waitFor(
        () => (supervisor.controlHeld(world.session) ? undefined : true),
        "turn claim released",
      );
      await heldTurn(world, "after the observer threw");
      completeHeldTurn(child(world));
      await waitFor(
        () => (seen.filter((type) => type === "turn.end").length === 2 ? true : undefined),
        "second turn.end",
      );
      expect(world.scripted).toHaveLength(1);
      await expect(world.fixture.app.close()).resolves.toBeUndefined();
      expect(world.errors).toEqual([]);
    },
  );
});
