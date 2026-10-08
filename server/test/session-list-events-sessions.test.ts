/**
 * Issue #932 list event trigger points of the session routes (S1f task 6.3): `POST /api/sessions`,
 * `PATCH /api/sessions/:id`, `DELETE /api/sessions/:id` and `POST /api/sessions/:id/fork` on the
 * production createApp → registerSessions assembly with a real listener; each list connection is a
 * real HTTP client whose bytes are read natively. The fork runs a real fake-omp `branch` child.
 *
 * Silence and "everything written so far has arrived" are both proven with the heartbeat: the
 * injected clock writes one comment line per connection, after whatever was written before it.
 */
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { REAL } from "./session-approval-helpers.js";
import { patch, rowOf } from "./session-archive-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
} from "./session-db-helpers.js";
import { sendDelete } from "./session-delete-helpers.js";
import { forkWorlds, openForkWorld, seedTwoTurns } from "./session-fork-helpers.js";
import {
  accountOf,
  changed,
  closeListening,
  drainedBy,
  expectOnlyChangedFrames,
  HEARTBEAT_FRAME,
  type ListClient,
  type Listening,
  listedSession,
  listening,
  openList,
} from "./session-list-events-helpers.js";
import { SESSION_BUSY_ENVELOPE, UNKNOWN_SESSION_ID } from "./session-rest-helpers.js";
import { createSession, OWNER_ID } from "./session-supervisor-helpers.js";

type World = Listening<Awaited<ReturnType<typeof openForkWorld>>>;

/** What `GET /api/sessions` shows of one session, as far as these writes change it. */
interface Listed {
  id: string;
  title: string | null;
  archivedAt: number | null;
}

interface Outcome {
  session: string;
  /** The session's entry in the owner's list after the write; `undefined` = no longer listed. */
  listed: Partial<Listed> | undefined;
}

interface TriggerRow {
  name: string;
  /** Brings the world to the state the write needs and returns the one write under test. */
  prepare(world: World): Promise<() => Promise<Outcome>>;
}

// Removes the real resume file `seedTwoTurns` writes for the fork row.
forkWorlds();

afterEach(closeListening);

/** zhangsan's world (one session of hers exists), her list connection and lisi's. */
async function openWorld(): Promise<{ world: World; mine: ListClient; theirs: ListClient }> {
  const opened = await openForkWorld();
  const world = await listening(opened, opened.clock, () =>
    opened.spawned.map((spawned) => spawned.child),
  );
  const lisi = await accountOf(world.fixture.app, "lisi");
  return {
    world,
    mine: await openList(world, world.cookie),
    theirs: await openList(world, lisi.cookie),
  };
}

async function patchedTo(world: World, body: object, listed: Partial<Listed>): Promise<Outcome> {
  expect((await patch(world, body)).statusCode).toBe(200);
  return { session: world.session, listed };
}

const TRIGGER_ROWS: TriggerRow[] = [
  {
    name: "POST /api/sessions",
    prepare: async (world) => async () => {
      const session = await createSession(world.fixture.app, world.cookie);
      return { session, listed: { id: session, title: null, archivedAt: null } };
    },
  },
  {
    name: "PATCH title",
    prepare: async (world) => () => patchedTo(world, { title: "季度复盘" }, { title: "季度复盘" }),
  },
  {
    name: "PATCH {archived:true}",
    prepare: async (world) => () =>
      patchedTo(world, { archived: true }, { archivedAt: expect.any(Number) as number }),
  },
  {
    name: "PATCH {archived:false}",
    async prepare(world) {
      expect((await patch(world, { archived: true })).statusCode).toBe(200);
      return () => patchedTo(world, { archived: false }, { archivedAt: null });
    },
  },
  {
    name: "fork commit",
    async prepare(world) {
      const seeded = seedTwoTurns(world);
      return async () => {
        const response = await postSessionAction(
          world.fixture.app,
          "fork",
          world.session,
          world.cookie,
          {
            name: "fork body",
            payload: JSON.stringify({ messageId: seeded.u2 }),
            contentType: "application/json",
          },
        );
        expect(response.statusCode).toBe(201);
        const session = response.json<{ session: { id: string } }>().session.id;
        expect(session).not.toBe(world.session);
        return { session, listed: { id: session, archivedAt: null } };
      };
    },
  },
  {
    name: "DELETE",
    prepare: async (world) => async () => {
      expect((await sendDelete(world.fixture.app, world.session, world.cookie)).statusCode).toBe(
        204,
      );
      return { session: world.session, listed: undefined };
    },
  },
];

describe("session list events: session create, PATCH, fork and delete trigger points", () => {
  it.each(TRIGGER_ROWS)(
    "每个触发点各自通知: $name → at least one more sessions.changed for the owner, none for the other account",
    REAL,
    async (row) => {
      const { world, mine, theirs } = await openWorld();
      const act = await row.prepare(world);
      const [before = 0, theirsBefore = 0] = await drainedBy(world.clock, [mine, theirs]);

      const outcome = await act();

      await changed(mine, before, row.name);
      // After the notification the write is readable: the notification followed the commit.
      const listed = await listedSession<Listed>(world.fixture.app, world.cookie, outcome.session);
      if (outcome.listed === undefined) {
        expect(listed).toBeUndefined();
      } else {
        expect(listed).toMatchObject(outcome.listed);
      }
      await drainedBy(world.clock, [mine, theirs]);
      // One heartbeat bounds the write on the other account's connection: nothing else came.
      expect(theirs.text().slice(theirsBefore)).toBe(HEARTBEAT_FRAME);
      // sessions.changed only: no session.rewound, no other event, every data exactly `{}`.
      expectOnlyChangedFrames(mine);
      expectOnlyChangedFrames(theirs);
    },
  );

  it("被拒绝的写入不通知: 409 archive of a running session, 400 PATCH body, 404 DELETE, and a create and a delete whose transactions roll back", {
    timeout: 20_000,
  }, async () => {
    const { world, mine, theirs } = await openWorld();
    const { app, db, store } = world.fixture;
    const kept = await createSession(app, world.cookie);
    // `running` without a child: the store's admission alone, which notifies nobody.
    const turn = store.acceptPrompt(world.session, OWNER_ID, "still running");
    // From here on both transactions abort: the session INSERT, and the delete's audit row.
    db.exec(`CREATE TEMP TRIGGER reject_session_insert BEFORE INSERT ON chat_sessions
      BEGIN SELECT RAISE(ABORT, 'list events'); END`);
    db.exec(`CREATE TEMP TRIGGER reject_delete_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'session.delete' BEGIN SELECT RAISE(ABORT, 'list events'); END`);
    const rows = [rowOf(db, world.session), rowOf(db, kept)];
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM chat_sessions").get();

    const rejected: Array<[() => Promise<LightMyRequestResponse>, number, object]> = [
      [() => patch(world, { archived: true }), 409, SESSION_BUSY_ENVELOPE],
      [() => patch(world, { title: "x", unknown: 1 }), 400, BAD_REQUEST_ENVELOPE],
      [() => patch(world, { pinned: "yes" }, { session: kept }), 400, BAD_REQUEST_ENVELOPE],
      [() => sendDelete(app, UNKNOWN_SESSION_ID, world.cookie), 404, NOT_FOUND_ENVELOPE],
      [
        () =>
          app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: world.cookie } }),
        500,
        INTERNAL_ERROR_ENVELOPE,
      ],
      [() => sendDelete(app, kept, world.cookie), 500, INTERNAL_ERROR_ENVELOPE],
    ];
    for (const [request, status, envelope] of rejected) {
      const clients = [mine, theirs];
      const marks = await drainedBy(world.clock, clients);
      expectEnvelope(await request(), status, envelope);
      await drainedBy(world.clock, clients);
      // One heartbeat later neither connection carries anything but that heartbeat.
      expect(clients.map((client, index) => client.text().slice(marks[index] ?? 0))).toEqual([
        HEARTBEAT_FRAME,
        HEARTBEAT_FRAME,
      ]);
    }

    // Nothing was written: no row moved, none appeared, none went away.
    expect([rowOf(db, world.session), rowOf(db, kept)]).toEqual(rows);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_sessions").get()).toEqual(sessions);
    expect(db.isTransaction).toBe(false);
    expectOnlyChangedFrames(mine);
    expectOnlyChangedFrames(theirs);
    expect(store.finishTurn(turn.assistantMessageId, "stopped")).toBe(true);
  });
});
