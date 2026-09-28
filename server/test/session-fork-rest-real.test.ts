/**
 * Issue #469 fork REST route on the production createApp → registerSessions assembly (parent s1c
 * tasks 5.2b), design R1–R6 and W1–W2: real fake-omp `branch` children (R1–R5, W1–W2), and
 * scripted FakeChild processes for the temporary-shutdown gap (R5) and the full pool (R6); real
 * SQLite and the injected clock. Fork is only ever requested over REST (inject, or a real socket
 * for the parser-owner boundary); `fork`/`acceptPrompt` are call-through spies. Oracles: status,
 * payload, no-store, SQL rows, the `chat_messages` sequence, the source file's bytes and mtime,
 * per-child stdin frames, spawn argv, liveness and published events.
 */
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { withListeningApp } from "./raw-http-helpers.js";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import {
  type BodyInput,
  EMPTY_JSON,
  expectEnvelope,
  MALFORMED_JSON,
  messageSeq,
  OCTET,
  onWire,
  postSessionAction,
  wireSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  FIRST,
  forkWorlds,
  insertApproval,
  listedIds,
  messagesOf,
  openCappedWorld,
  openForkScripted,
  openForkWorld,
  realSource,
  rowCounts,
  type Seeded,
  seedTwoTurns,
  sessionRowOf,
  subscribeQuietly,
  turn,
} from "./session-fork-helpers.js";
import {
  epochOf,
  HOLD,
  held,
  heldLine,
  type LineMatch,
  QUESTION,
  scriptedAt,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
} from "./session-regenerate-helpers.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  cookieFor,
  getSessionMessages,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import { heldTurn, openStopWorld } from "./session-stop-helpers.js";
import { HEX32 } from "./session-store-helpers.js";
import {
  completeHeldTurn,
  createSession,
  OWNER_ID,
  type RecordingWorld,
  requiredCall,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import {
  expectCapacity,
  expectWithinCap,
  isLive,
  presetSessionFile,
} from "./session-supervisor-pool-helpers.js";

const ROUTE = "/api/sessions/:id/fork";
const JSON_TYPE = "application/json";
const SESSION_KEYS = ["id", "title", "status", "createdAt", "updatedAt"];

const worlds = forkWorlds();

interface ForkBody {
  session: { id: string; title: string | null; status: string };
  draft: string;
}

interface PublicMessage {
  id: number;
  role: string;
  approvals: Array<Record<string, unknown>>;
  steps: Array<Record<string, unknown>>;
}

interface PublicHistory {
  session: Record<string, unknown>;
  messages: PublicMessage[];
  streamCursor: unknown;
}

function forkBody(messageId: number | string): BodyInput {
  return { name: "fork body", payload: JSON.stringify({ messageId }), contentType: JSON_TYPE };
}

function postFork(
  world: RecordingWorld,
  messageId: number,
  session = world.session,
): Promise<LightMyRequestResponse> {
  return postSessionAction(world.fixture.app, "fork", session, world.cookie, forkBody(messageId));
}

function postRegenerate(world: RecordingWorld, session = world.session) {
  return postSessionAction(world.fixture.app, "regenerate", session, world.cookie);
}

/** The body of a wire or inject 201: exactly `{session:<five keys>, draft:<string>}`. */
function forkedBody(text: string): ForkBody {
  const body = JSON.parse(text) as ForkBody;
  expect(Object.keys(body)).toEqual(["session", "draft"]);
  expect(Object.keys(body.session)).toEqual(SESSION_KEYS);
  expect(body.session.id).toMatch(HEX32);
  expect(typeof body.draft).toBe("string");
  return body;
}

/** A 201 with no-store whose body is exactly `{session, draft}`. */
function forked(response: LightMyRequestResponse): ForkBody {
  expect([response.statusCode, response.headers["cache-control"]]).toEqual([201, "no-store"]);
  return forkedBody(response.payload);
}

async function historyOf(world: RecordingWorld, session: string): Promise<PublicHistory> {
  const response = await getSessionMessages(world.fixture.app, session, world.cookie);
  expect(response.statusCode).toBe(200);
  return response.json() as PublicHistory;
}

/** A public message with every row id dropped (the copy has new ids, everything else equal). */
function withoutIds({ id: _id, approvals, steps, ...rest }: PublicMessage) {
  const strip = ({ id: _rowId, ...fields }: Record<string, unknown>) => fields;
  return { ...rest, approvals: approvals.map(strip), steps: steps.map(strip) };
}

function userIds(world: RecordingWorld, session: string): number[] {
  return messagesOf(world.fixture.db, session)
    .filter((message) => message.role === "user")
    .map((message) => message.id);
}

describe("fork REST on real fake-omp branch children", () => {
  it(
    "R1 forks at u2: 201 {session, draft}, copied history, parent kept private",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { db, supervisor } = world.fixture;
      const source = world.session;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      const [u1, a1, u2] = messagesOf(db, source);
      if (u1 === undefined || a1 === undefined || u2 === undefined) {
        throw new Error("missing seeded turns");
      }
      insertApproval(db, a1.id, "r-allow", "allow", 70);
      const real = realSource();
      presetSessionFile(db, source, real.file);
      const received = subscribeQuietly(world);
      const before = snapshot(db, source, true);
      const epoch = epochOf(db, source);
      const events = world.events.length;
      const first = spawnedAt(world, 0);
      const sent = first.stdin.length;
      expect(isLive(first.child)).toBe(true);
      const fork = vi.spyOn(supervisor, "fork");

      const body = forked(await postFork(world, u2.id));

      const temp = spawnedAt(world, 1);
      expect(isLive(temp.child)).toBe(false);
      expect(fork).toHaveBeenCalledTimes(1);
      expect(fork).toHaveBeenCalledWith(source, OWNER_ID, u2.id);
      expect(body.draft).toBe(QUESTION);
      expect(body.session).toMatchObject({ title: FIRST, status: "done" });
      const fresh = body.session.id;
      expect(fresh).not.toBe(source);
      const row = sessionRowOf(db, fresh);
      expect(row).toMatchObject({ owner_id: OWNER_ID, parent_session_id: source, stream_epoch: 0 });
      expect(String(row?.omp_session_file)).toMatch(/branch-/u);

      const copy = await historyOf(world, fresh);
      const original = await historyOf(world, source);
      expect(Object.keys(copy.session)).toEqual(SESSION_KEYS);
      expect(copy.session).toEqual(body.session);
      expect(copy.streamCursor).toEqual({ epoch: 0, seq: null });
      expect(copy.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(copy.messages.map(withoutIds)).toEqual(original.messages.slice(0, 2).map(withoutIds));
      const sourceIds = original.messages.map((m) => m.id);
      expect(copy.messages.some((m) => sourceIds.includes(m.id))).toBe(false);
      const copiedAnswer = copy.messages[1];
      expect(copiedAnswer?.steps.length).toBeGreaterThan(0);
      expect(copiedAnswer?.approvals).toEqual([
        {
          id: expect.any(Number),
          tool: "bash",
          title: "run r-allow",
          requestedAt: 70,
          expiresAt: 60_070,
          decision: "allow",
        },
      ]);

      expect(snapshot(db, source, true)).toEqual(before);
      real.unchanged();
      expect(first.stdin).toHaveLength(sent);
      expect(isLive(first.child)).toBe(false);
      expect(world.liveAtSpawn[1]).toEqual([]);
      expect(types(temp.stdin.slice(2))).toEqual(["get_branch_messages", "branch", "get_state"]);
      expect([epochOf(db, source), epochOf(db, fresh)]).toEqual([epoch, 0]);
      expect(received).toEqual([]);
      expect(world.events).toHaveLength(events);
      expect(held(world)).toBe(false);

      const listed = await world.fixture.app.inject({
        method: "GET",
        url: "/api/sessions",
        headers: { cookie: world.cookie },
      });
      const sessions = (listed.json() as { sessions: Array<Record<string, unknown>> }).sessions;
      expect(sessions.map((s) => s.id).sort()).toEqual([source, fresh].sort());
      for (const listedSession of sessions) {
        expect(Object.keys(listedSession)).toEqual(SESSION_KEYS);
      }
    },
  );

  it("R2a a fork at u1 is idle with no copied message", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const seeded = seedTwoTurns(world);

    const body = forked(await postFork(world, seeded.u1));

    expect(body.session.status).toBe("idle");
    expect(body.draft).toBe(FIRST);
    expect((await historyOf(world, body.session.id)).messages).toEqual([]);
    seeded.unchanged();
  });

  for (const status of ["stopped", "failed"] as const) {
    it(`R2b a1 ${status}: the fork is ${status} and regenerates over REST`, REAL, async () => {
      const world = worlds.track(await openForkWorld({ entries: [FIRST] }));
      const { db } = world.fixture;
      const seeded = seedTwoTurns(world, { a1: status });

      const body = forked(await postFork(world, seeded.u2));

      expect(body.session.status).toBe(status);
      const fresh = body.session.id;
      const file = sessionFile(db, fresh);
      const regenerated = await postRegenerate(world, fresh);
      expect([regenerated.statusCode, regenerated.headers["cache-control"]]).toEqual([
        202,
        "no-store",
      ]);
      expect(resumePath(requiredCall(world.rt.calls, 1).args)).toBe(file);
      const { assistantMessageId } = regenerated.json() as { assistantMessageId: number };
      const tree = await waitForTurn(world.fixture, fresh, "done");
      expect(tree.messages.at(-1)?.id).toBe(assistantMessageId);
    });
  }

  it("R3 prechecks 400/502, misalignment 502, a running source 409: no row", REAL, async () => {
    const world = worlds.track(await openForkWorld());
    const { app, db } = world.fixture;
    const seeded = seedTwoTurns(world);
    const other = await createSession(app, world.cookie);
    const elsewhere = seedTwoTurns(world, {}, other);
    const noFile = await createSession(app, world.cookie);
    const unfiled = seedTwoTurns(world, {}, noFile);
    db.prepare("UPDATE chat_sessions SET omp_session_file = NULL WHERE id = ?").run(noFile);
    const cases = [
      [world.session, seeded.a1, 400, BAD_REQUEST_ENVELOPE],
      [world.session, elsewhere.u1, 400, BAD_REQUEST_ENVELOPE],
      [world.session, 999_999, 400, BAD_REQUEST_ENVELOPE],
      [noFile, unfiled.u1, 502, AGENT_UNAVAILABLE_ENVELOPE],
    ] as const;
    for (const [session, messageId, status, envelope] of cases) {
      const rows = rowCounts(db);
      const before = snapshot(db, session, true);
      expectEnvelope(await postFork(world, messageId, session), status, envelope);
      expect(rowCounts(db)).toEqual(rows);
      expect(snapshot(db, session, true)).toEqual(before);
      expect(held(world, session)).toBe(false);
    }
    expect(world.rt.calls).toHaveLength(0);

    const misaligned = [
      [["other"], { u2Text: "other" }, "u2"],
      [[], { extraTurn: true }, "u3"],
    ] as const;
    for (const [entries, seed, target] of misaligned) {
      const drifted = worlds.track(await openForkWorld({ entries: [...entries] }));
      const driftedDb = drifted.fixture.db;
      const source: Seeded = seedTwoTurns(drifted, seed);
      const rows = rowCounts(driftedDb);
      const before = snapshot(driftedDb, drifted.session, true);

      expectEnvelope(await postFork(drifted, source[target]), 502, AGENT_UNAVAILABLE_ENVELOPE);

      const temp = spawnedAt(drifted, 0);
      expect(types(temp.stdin)).toContain("get_branch_messages");
      expect(types(temp.stdin)).not.toContain("branch");
      expect(isLive(temp.child)).toBe(false);
      expect(rowCounts(driftedDb)).toEqual(rows);
      expect(snapshot(driftedDb, drifted.session, true)).toEqual(before);
      source.unchanged();
      expect(held(drifted)).toBe(false);
    }

    const running = worlds.track(await openStopWorld("abort-ok"));
    await heldTurn(running);
    const runningDb = running.fixture.db;
    const [user] = userIds(running, running.session);
    const child = spawnedAt(running, 0);
    const frames = child.stdin.length;
    const rows = rowCounts(runningDb);
    const before = snapshot(runningDb, running.session, true);

    expectEnvelope(await postFork(running, user ?? -1), 409, SESSION_BUSY_ENVELOPE);
    await settle();

    expect(child.child.stdin.writableEnded).toBe(false);
    expect(child.stdin).toHaveLength(frames);
    expect(running.rt.calls).toHaveLength(1);
    expect(rowCounts(runningDb)).toEqual(rows);
    expect(snapshot(runningDb, running.session, true)).toEqual(before);
    expect(held(running)).toBe(false);
  });

  it(
    "R4 at cap 1 the live source exits first; the 201 comes with no live process",
    REAL,
    async () => {
      const world = worlds.track(await openCappedWorld(1));
      const { db, supervisor } = world.fixture;
      await turn(world, FIRST);
      await turn(world, QUESTION);
      const [u1] = userIds(world, world.session);
      expect(supervisor.liveProcessCount()).toBe(1);

      const body = forked(await postFork(world, u1 ?? -1));

      expect(supervisor.liveProcessCount()).toBe(0);
      expect(body.session.status).toBe("idle");
      expect(world.rt.calls).toHaveLength(2);
      expect(world.liveAtSpawn[1]).toEqual([]);
      expectWithinCap(world.liveAtSpawn, 1);
      const fresh = body.session.id;
      const file = sessionFile(db, fresh);
      expect(file).toMatch(/branch-/u);
      expect((await sendPrompt(world, "on the fork", fresh)).statusCode).toBe(202);
      expect(resumePath(requiredCall(world.rt.calls, 2).args)).toBe(file);
      await waitForTurn(world.fixture, fresh, "done");
      expectWithinCap(world.liveAtSpawn, 1);
    },
  );

  interface HeldFork {
    world: RecordingWorld & { rt: { calls: readonly unknown[] } };
    seeded: Seeded;
    work: Promise<LightMyRequestResponse>;
    frames(): number;
    release(): void;
  }

  /** A seeded source whose REST fork of u2 is in flight with the temporary child's `hold` held. */
  async function restHeldFork(hold: LineMatch): Promise<HeldFork> {
    const world = worlds.track(await openForkWorld({ hold }));
    const seeded = seedTwoTurns(world);
    const work = Promise.resolve(postFork(world, seeded.u2));
    await heldLine(world);
    const temp = spawnedAt(world, 0);
    return {
      world,
      seeded,
      work,
      frames: () => temp.stdin.length,
      release: () => temp.gate.release(),
    };
  }

  /** The same fork held after its temporary child's stdin EOF (shutdown not yet complete). */
  async function restClosingFork(): Promise<HeldFork> {
    const world = await openForkScripted(worlds, [{ keepStdout: true }, {}]);
    const seeded = seedTwoTurns(world);
    const work = Promise.resolve(postFork(world, seeded.u2));
    const temp = await waitFor(() => {
      const child = world.scripted[0]?.child;
      return child?.stdin.writableEnded === true ? child : undefined;
    }, "temporary stdin EOF");
    return {
      world,
      seeded,
      work,
      frames: () => scriptedAt(world.scripted, 0).frames.length,
      release: () => {
        temp.endStdout();
        temp.exit(0);
      },
    };
  }

  /** Real fake-omp children for the four RPC gaps (REAL); the scripted FakeChild needs no budget. */
  const gaps = [
    ["ready not yet arrived", () => restHeldFork(HOLD.ready), REAL],
    ["get_branch_messages reply not yet arrived", () => restHeldFork(HOLD.messages), REAL],
    ["branch reply not yet arrived", () => restHeldFork(HOLD.branch), REAL],
    ["get_state reply not yet arrived", () => restHeldFork(HOLD.state), REAL],
    ["temporary shutdown not yet complete", restClosingFork, {}],
  ] as const;
  for (const [gap, open, budget] of gaps) {
    it(
      `R5 REST prompt, regenerate and fork are 409 before admission with ${gap}`,
      budget,
      async () => {
        const { world, seeded, work, frames, release } = await open();
        const { db } = world.fixture;
        const accept = vi.spyOn(world.fixture.store, "acceptPrompt");
        const observed = () => ({
          source: snapshot(db, world.session, true),
          rows: rowCounts(db),
          seq: messageSeq(db),
          frames: frames(),
          spawns: world.rt.calls.length,
        });
        const before = observed();

        expectEnvelope(await sendPrompt(world, "injected"), 409, SESSION_BUSY_ENVELOPE);
        expectEnvelope(await postRegenerate(world), 409, SESSION_BUSY_ENVELOPE);
        expectEnvelope(await postFork(world, seeded.u2), 409, SESSION_BUSY_ENVELOPE);
        await settle();

        expect(observed()).toEqual(before);
        expect(accept).not.toHaveBeenCalled();
        seeded.unchanged();
        release();
        const body = forked(await work);
        expect(body.draft).toBe(QUESTION);
        expect(rowCounts(db).sessions).toBe(before.rows.sessions + 1);
        expect(held(world)).toBe(false);
      },
    );
  }

  it("R6 a full pool is 503 agent_capacity, no row, claim released; then 201", async () => {
    const world = await openForkScripted(worlds, [{ prompt: "hold" }, {}], 1);
    const { db } = world.fixture;
    const other = await createSession(world.fixture.app, world.cookie);
    expect((await sendPrompt(world, "other holds", other)).statusCode).toBe(202);
    const seeded = seedTwoTurns(world);
    const rows = rowCounts(db);
    const before = snapshot(db, world.session, true);

    expectCapacity(await postFork(world, seeded.u2));

    expect(rowCounts(db)).toEqual(rows);
    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(held(world)).toBe(false);
    expect(world.rt.calls).toHaveLength(1);
    completeHeldTurn(scriptedAt(world.scripted, 0).child);
    await waitForTurn(world.fixture, other, "done");
    await settle();

    const body = forked(await postFork(world, seeded.u2));
    expect(body.draft).toBe(QUESTION);
    expect(rowCounts(db).sessions).toBe(rows.sessions + 1);
    expect(world.fixture.supervisor.liveProcessCount()).toBe(0);
  });
});

describe("fork REST over a real socket", () => {
  /** S running (admitted, no process), D a seeded done source; fork spied call-through. */
  async function socketWorld() {
    const world = worlds.track(await openForkWorld());
    const { app, db, store, supervisor } = world.fixture;
    const running = world.session;
    store.acceptPrompt(running, OWNER_ID, QUESTION);
    const done = await createSession(app, world.cookie);
    const seeded = seedTwoTurns(world, {}, done);
    const spy = vi.spyOn(supervisor, "fork");
    const rows = () => ({
      running: snapshot(db, running, true),
      done: snapshot(db, done, true),
    });
    return { world, running, done, seeded, spy, rows, before: rows() };
  }

  /** Owned-400 bodies for a session whose valid fork target is `messageId`. */
  function wireBodies(messageId: number): BodyInput[] {
    const valid = JSON.stringify({ messageId });
    return [
      MALFORMED_JSON,
      EMPTY_JSON,
      OCTET,
      {
        name: "valid JSON padded past 1 KiB",
        payload: `${valid}${" ".repeat(1_100)}`,
        contentType: JSON_TYPE,
      },
      { ...forkBody(String(messageId)), name: "string id" },
      { name: "text/plain JSON", payload: valid, contentType: "text/plain" },
    ];
  }

  it("W1 every non-conforming body is an owned 400 before fork; then 409/201", REAL, async () => {
    const { world, running, done, seeded, spy, rows, before } = await socketWorld();
    const [runningUser] = userIds(world, running);
    if (runningUser === undefined) {
      throw new Error("missing running user message");
    }

    await withListeningApp(world.fixture.app, async (origin) => {
      for (const [session, messageId] of [
        [running, runningUser],
        [done, seeded.u2],
      ] as const) {
        for (const body of wireBodies(messageId)) {
          expect({
            body: body.name,
            ...(await wireSessionAction(origin, "fork", session, world.cookie, body)),
          }).toEqual({ body: body.name, ...onWire(400, JSON.stringify(BAD_REQUEST_ENVELOPE)) });
        }
      }
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(world.rt.calls).toHaveLength(0);
      expect(world.fixture.app.hasRoute({ method: "POST", url: ROUTE })).toBe(true);

      expect(
        await wireSessionAction(origin, "fork", running, world.cookie, forkBody(runningUser)),
      ).toEqual(onWire(409, JSON.stringify(SESSION_BUSY_ENVELOPE)));
      const accepted = await wireSessionAction(
        origin,
        "fork",
        done,
        world.cookie,
        forkBody(seeded.u2),
      );
      expect({ ...accepted, text: "" }).toEqual(onWire(201, ""));
      const body = forkedBody(accepted.text);
      expect(body.draft).toBe(QUESTION);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await listedIds(world)).toContain(body.session.id);
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
          expect(await wireSessionAction(origin, "fork", session, cookie, body)).toEqual(expected);
        }
      }
      await settle();
      expect(spy).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(world.rt.calls).toHaveLength(0);
    });
  });
});
