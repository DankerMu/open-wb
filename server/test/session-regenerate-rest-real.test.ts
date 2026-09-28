/**
 * Issue #467 regenerate REST route on the production createApp → registerSessions assembly (parent
 * s1c tasks 5.1b), design R1–R6 and W1–W2: real fake-omp `branch` children (R1–R5, W1–W2) and a
 * controlled FakeChild pool (R6), real SQLite and the injected clock. Regenerate is only ever
 * requested over REST (inject, or a real socket for the bodyless parser-owner boundary with tiny
 * bodies); `regenerate`/`acceptPrompt` are call-through spies. Oracles: status, payload, no-store,
 * SQL rows, the `chat_messages` sequence, per-child stdin frames, spawn argv and published events.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { FinishStatus } from "../src/sessions/store.js";
import type { RetainedEvent } from "../src/sessions/stream/ring-buffer.js";
import { withListeningApp } from "./raw-http-helpers.js";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import {
  EMPTY_JSON,
  expectEnvelope,
  MALFORMED_JSON,
  messageSeq,
  OCTET,
  onWire,
  postSessionAction,
  WIRE_BODIES,
  wireSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  answered,
  count,
  epochOf,
  HOLD,
  held,
  heldLine,
  type LineMatch,
  openRegenWorld,
  P,
  promptsAgain,
  QUESTION,
  type RegenWorld,
  regenWorlds,
  scriptedAt,
  scriptedRuntime,
  seedDone,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
  waitDead,
} from "./session-regenerate-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  getSessionMessages,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import {
  assistantIdFor,
  completeHeldTurn,
  createSession,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  requiredCall,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { expectCapacity, presetSessionFile } from "./session-supervisor-pool-helpers.js";

const ROUTE = "/api/sessions/:id/regenerate";

const worlds = regenWorlds();

function postRegenerate(
  world: RecordingWorld,
  session = world.session,
): Promise<LightMyRequestResponse> {
  return postSessionAction(world.fixture.app, "regenerate", session, world.cookie);
}

/** A 202 whose body is exactly `{assistantMessageId}` with no-store; returns that id. */
function regenerated(response: LightMyRequestResponse): number {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([202, "no-store"]);
  const body = JSON.parse(response.payload) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["assistantMessageId"]);
  const id = body.assistantMessageId;
  expect(Number.isSafeInteger(id)).toBe(true);
  return id as number;
}

/** A seeded done session whose REST regenerate is in flight with the first child's `hold` held. */
async function restHeldRegenerate(hold: LineMatch) {
  const world = worlds.track(await openRegenWorld({ hold }));
  seedDone(world);
  const work = Promise.resolve(postRegenerate(world));
  await heldLine(world);
  return { world, db: world.fixture.db, work };
}

/** `user(QUESTION) → assistant(status)` resuming at P, written without any spawn. */
function seedEnded(world: RegenWorld, session: string, status: FinishStatus): void {
  const { store, db } = world.fixture;
  const admitted = store.acceptPrompt(session, OWNER_ID, QUESTION);
  store.finishTurn(admitted.assistantMessageId, status);
  presetSessionFile(db, session, P);
}

describe("regenerate REST on real fake-omp branch children", () => {
  it(
    "R1 regenerates the last answer: 202 new id, branch frames, cascade, branch file",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { db } = world.fixture;
      await answered(world);
      const old = assistantIdFor(world.fixture, world.session);
      const stepsOf = "SELECT COUNT(*) AS count FROM chat_steps WHERE message_id = ?";
      expect(count(db, stepsOf, old)).toBeGreaterThan(0);
      const first = spawnedAt(world, 0);
      const sentBefore = first.stdin.length;

      const fresh = regenerated(await postRegenerate(world));

      expect(fresh).toBeGreaterThan(old);
      const sent = first.stdin.slice(sentBefore);
      expect(types(sent)).toEqual(["get_branch_messages", "branch", "get_state", "prompt"]);
      expect(sent[1]).toMatchObject({ type: "branch", entryId: "fake-entry-2" });
      expect(sent[3]).toMatchObject({ type: "prompt", message: QUESTION });
      expect(count(db, "SELECT COUNT(*) AS count FROM chat_messages WHERE id = ?", old)).toBe(0);
      expect(count(db, stepsOf, old)).toBe(0);
      expect(sessionFile(db, world.session)).toMatch(/branch-/u);
      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(
        tree.messages.map((m) => [m.role, m.status, m.role === "user" ? m.content : ""]),
      ).toEqual([
        ["user", "done", QUESTION],
        ["assistant", "done", ""],
      ]);
      expect(tree.messages.at(-1)?.id).toBe(fresh);
    },
  );

  it("R1b failed and stopped sessions regenerate to a done turn", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const stopped = await createSession(world.fixture.app, world.cookie);
    seedEnded(world, world.session, "failed");
    seedEnded(world, stopped, "stopped");

    for (const session of [world.session, stopped]) {
      const fresh = regenerated(await postRegenerate(world, session));
      const tree = await waitForTurn(world.fixture, session, "done");
      expect(tree.messages.at(-1)?.id).toBe(fresh);
    }
  });

  it(
    "R2 a reclaimed session: --resume spawn, epoch +1, one live turn of the 202 id",
    REAL,
    async () => {
      const world = worlds.track(await openRegenWorld());
      const { app, db, supervisor } = world.fixture;
      seedDone(world);
      const snapshotBefore = await getSessionMessages(app, world.session, world.cookie);
      const epoch = (snapshotBefore.json() as { streamCursor: { epoch: number } }).streamCursor
        .epoch;
      const live: RetainedEvent[] = [];
      const subscription = supervisor.subscribe(world.session, null, (event) => {
        live.push(event);
      });

      const fresh = regenerated(await postRegenerate(world));

      expect(world.rt.calls).toHaveLength(1);
      expect(resumePath(requiredCall(world.rt.calls, 0).args)).toBe(P);
      expect(epochOf(db, world.session)).toBe(epoch + 1);
      await waitForTurn(world.fixture, world.session, "done");
      await waitFor(() => (live.some((e) => e.type === "turn.end") ? true : undefined), "turn.end");
      subscription.unsubscribe();
      expect(live[0]).toMatchObject({ type: "turn.start" });
      expect(live.filter((e) => e.type === "turn.start")).toHaveLength(1);
      expect(live.at(-1)).toMatchObject({
        type: "turn.end",
        data: { messageId: fresh, status: "done" },
      });
      const after = await getSessionMessages(app, world.session, world.cookie);
      expect((after.json() as { streamCursor: { epoch: number } }).streamCursor.epoch).toBe(
        epoch + 1,
      );
    },
  );

  it("R3 running 409, idle/last-user 400, text mismatch 502: rows unchanged", REAL, async () => {
    const world = worlds.track(await openRegenWorld());
    const { app, db, store } = world.fixture;
    const running = world.session;
    store.acceptPrompt(running, OWNER_ID, QUESTION);
    const idle = await createSession(app, world.cookie);
    const lastUser = await createSession(app, world.cookie);
    db.prepare(
      "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'user', 'q', 'done', 1)",
    ).run(lastUser);
    db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(lastUser);
    const cases = [
      [running, 409, SESSION_BUSY_ENVELOPE],
      [idle, 400, BAD_REQUEST_ENVELOPE],
      [lastUser, 400, BAD_REQUEST_ENVELOPE],
    ] as const;
    for (const [session, status, envelope] of cases) {
      const before = snapshot(db, session, true);
      expectEnvelope(await postRegenerate(world, session), status, envelope);
      expect(snapshot(db, session, true)).toEqual(before);
    }
    expect(world.rt.calls).toHaveLength(0);

    const mismatch = worlds.track(await openRegenWorld({ entries: ["other"] }));
    seedDone(mismatch);
    const before = snapshot(mismatch.fixture.db, mismatch.session);
    expectEnvelope(await postRegenerate(mismatch), 502, AGENT_UNAVAILABLE_ENVELOPE);
    expect(types(spawnedAt(mismatch, 0).stdin)).not.toContain("branch");
    expect(snapshot(mismatch.fixture.db, mismatch.session)).toEqual(before);
    await waitDead(mismatch, 0);
    await promptsAgain(mismatch, "after mismatch");
  });

  const rewrites = [
    [
      "status rewritten to running",
      (db: DatabaseSync, session: string) => {
        db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(session);
        return () =>
          db.prepare("UPDATE chat_sessions SET status = 'done' WHERE id = ?").run(session);
      },
    ],
    [
      "a newer assistant inserted",
      (db: DatabaseSync, session: string) => {
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO chat_messages(session_id, role, content, status, created_at) VALUES (?, 'assistant', 'newer', 'done', ?)",
          )
          .run(session, Date.now() + 60_000);
        return () => db.prepare("DELETE FROM chat_messages WHERE id = ?").run(lastInsertRowid);
      },
    ],
  ] as const;
  for (const [name, rewrite] of rewrites) {
    it(`R4 the final recheck fails with ${name}: 409, retired, released`, REAL, async () => {
      const { world, db, work } = await restHeldRegenerate(HOLD.state);
      const undo = rewrite(db, world.session);
      const rewritten = snapshot(db, world.session);
      spawnedAt(world, 0).gate.release();

      expectEnvelope(await work, 409, SESSION_BUSY_ENVELOPE);

      expect(snapshot(db, world.session)).toEqual(rewritten);
      await waitDead(world, 0);
      expect(held(world)).toBe(false);
      undo();
      await promptsAgain(world, "after recheck");
    });
  }

  const gaps = [
    ["ready not yet arrived", HOLD.ready],
    ["get_branch_messages reply not yet arrived", HOLD.messages],
    ["branch reply not yet arrived", HOLD.branch],
    ["post-branch get_state reply not yet arrived", HOLD.state],
  ] as const;
  for (const [gap, hold] of gaps) {
    it(`R5 REST prompt and regenerate are 409 before admission with ${gap}`, REAL, async () => {
      const { world, db, work } = await restHeldRegenerate(hold);
      const child = spawnedAt(world, 0);
      const before = snapshot(db, world.session, true);
      const seq = messageSeq(db);
      const frames = child.stdin.length;
      const spawns = world.rt.calls.length;
      const accept = vi.spyOn(world.fixture.store, "acceptPrompt");

      expectEnvelope(await sendPrompt(world, "injected"), 409, SESSION_BUSY_ENVELOPE);
      expectEnvelope(await postRegenerate(world), 409, SESSION_BUSY_ENVELOPE);
      await settle();

      expect({
        rows: snapshot(db, world.session, true),
        seq: messageSeq(db),
        frames: child.stdin.length,
        spawns: world.rt.calls.length,
        admissions: accept.mock.calls.length,
      }).toEqual({ rows: before, seq, frames, spawns, admissions: 0 });
      child.gate.release();
      const fresh = regenerated(await work);
      const tree = await waitForTurn(world.fixture, world.session, "done");
      expect(tree.messages.at(-1)?.id).toBe(fresh);
      expect(held(world)).toBe(false);
    });
  }

  it("R6 a full pool is 503 agent_capacity with no row change and the claim released", async () => {
    const { rt, scripted } = scriptedRuntime([{ prompt: "hold" }, {}]);
    const world = worlds.track({
      ...(await openRecordingSession({ ...rt.runtime, maxProcesses: 1 })),
      rt,
    });
    const other = await createSession(world.fixture.app, world.cookie);
    expect((await sendPrompt(world, "b holds", other)).statusCode).toBe(202);
    seedDone(world);
    const before = snapshot(world.fixture.db, world.session);

    expectCapacity(await postRegenerate(world));

    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(held(world)).toBe(false);
    expect(rt.calls).toHaveLength(1);
    completeHeldTurn(scriptedAt(scripted, 0).child);
    await waitForTurn(world.fixture, other, "done");
  });
});

describe("regenerate REST over a real socket", () => {
  /** S running (admitted, no process), D a seeded done session; regenerate spied call-through. */
  async function socketWorld() {
    const world = worlds.track(await openRegenWorld());
    const { app, db, store, supervisor } = world.fixture;
    const running = world.session;
    store.acceptPrompt(running, OWNER_ID, QUESTION);
    const done = await createSession(app, world.cookie);
    seedDone(world, done);
    const spy = vi.spyOn(supervisor, "regenerate");
    const rows = () => ({
      running: snapshot(db, running, true),
      done: snapshot(db, done, true),
    });
    return { world, running, done, spy, rows, before: rows() };
  }

  it("W1 every body is an owned 400 before regenerate; no body keeps 409/202", REAL, async () => {
    const { world, running, done, spy, rows, before } = await socketWorld();

    await withListeningApp(world.fixture.app, async (origin) => {
      for (const session of [running, done]) {
        for (const body of WIRE_BODIES) {
          expect({
            body: body.name,
            ...(await wireSessionAction(origin, "regenerate", session, world.cookie, body)),
          }).toEqual({ body: body.name, ...onWire(400, JSON.stringify(BAD_REQUEST_ENVELOPE)) });
        }
      }
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(world.rt.calls).toHaveLength(0);
      expect(world.fixture.app.hasRoute({ method: "POST", url: ROUTE })).toBe(true);

      expect(await wireSessionAction(origin, "regenerate", running, world.cookie)).toEqual(
        onWire(409, JSON.stringify(SESSION_BUSY_ENVELOPE)),
      );
      const accepted = await wireSessionAction(origin, "regenerate", done, world.cookie);
      expect({ ...accepted, text: "" }).toEqual(onWire(202, ""));
      const body = JSON.parse(accepted.text) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["assistantMessageId"]);
      expect(Number.isSafeInteger(body.assistantMessageId)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(2);
      const tree = await waitForTurn(world.fixture, done, "done");
      expect(tree.messages.at(-1)?.id).toBe(body.assistantMessageId);
    });
  });

  it("W2 401 and the identical 404 come before the parser on the wire", REAL, async () => {
    const { world, running, spy, rows, before } = await socketWorld();
    const foreign = await cookieFor(world.fixture.app, "zhaoliu");

    await withListeningApp(world.fixture.app, async (origin) => {
      const unauthorized = onWire(401, JSON.stringify(UNAUTHORIZED_ENVELOPE));
      const notFound = onWire(404, JSON.stringify(NOT_FOUND_ENVELOPE));
      const targets = [
        [running, null, unauthorized],
        [running, foreign, notFound],
        [UNKNOWN_SESSION_ID, world.cookie, notFound],
      ] as const;
      for (const [session, cookie, expected] of targets) {
        for (const body of [MALFORMED_JSON, EMPTY_JSON, OCTET]) {
          expect(await wireSessionAction(origin, "regenerate", session, cookie, body)).toEqual(
            expected,
          );
        }
      }
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(world.rt.calls).toHaveLength(0);
    });
  });
});
