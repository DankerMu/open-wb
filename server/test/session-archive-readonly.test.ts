/**
 * Issue #923 (s1f-session-list-temp-space task 2.3, design D4): an archived session is read-only.
 * session-metadata 「会话归档」 (归档后只读 — prompt / regenerate / fork; undo is task 11.4 —
 * and 归档与受理不并发成功), chat-sessions "Archived session refuses prompts", turn-control
 * 「已归档的源会话」, and the order pin of task 2.4 (archived while the control claim is held).
 * The S cases run the production createApp → registerSessions assembly over real fake-omp `branch`
 * children; the P cases run the REST routes on the recording stub supervisor, whose metadata store
 * is the very object the routes hold. Oracles: the spec's status codes and envelopes, whole rows
 * read by SQL, the `chat_messages` sequence, spawn argv, per-child stdin frames and liveness.
 */
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REAL, spawnedAt } from "./session-approval-helpers.js";
import { archiveNow, patch, patched, rowOf } from "./session-archive-helpers.js";
import {
  type BodyInput,
  expectEnvelope,
  MALFORMED_JSON,
  messageSeq,
  postSessionAction,
} from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import {
  FIRST,
  forkWorlds,
  listedIds,
  openForkWorld,
  realSource,
  rowCounts,
  seedTwoTurns,
  turn,
} from "./session-fork-helpers.js";
import { held, QUESTION, sendPrompt, snapshot } from "./session-regenerate-helpers.js";
import {
  cookieFor,
  deferred,
  getSessionMessages,
  postPrompt,
  SESSION_ARCHIVED_ENVELOPE,
  SESSION_BUSY_ENVELOPE,
  SESSION_NOW,
  type SessionRestFixture,
  UNKNOWN_SESSION_ID,
  withSessionRest,
} from "./session-rest-helpers.js";
import { openEventStream } from "./session-sse-helpers.js";
import { OWNER_ID, waitFor, waitForTurn } from "./session-supervisor-helpers.js";
import { isLive, presetSessionFile } from "./session-supervisor-pool-helpers.js";

const PROMPT = JSON.stringify({ message: "next question" });
const worlds = forkWorlds();

afterEach(() => {
  vi.restoreAllMocks();
});

type ForkWorld = Awaited<ReturnType<typeof openForkWorld>>;
type Poster = { fixture: Pick<ForkWorld["fixture"], "app">; cookie: string; session: string };

function forkBody(messageId: unknown): BodyInput {
  return { name: "fork", payload: JSON.stringify({ messageId }), contentType: "application/json" };
}

function postFork(target: Poster, messageId: unknown, cookie: string | null = target.cookie) {
  return postSessionAction(target.fixture.app, "fork", target.session, cookie, forkBody(messageId));
}

function postRegenerate(target: Poster, cookie: string | null = target.cookie, body?: BodyInput) {
  return postSessionAction(target.fixture.app, "regenerate", target.session, cookie, body);
}

function expectArchived(response: LightMyRequestResponse): void {
  expectEnvelope(response, 409, SESSION_ARCHIVED_ENVELOPE);
}

/** Two real fake-omp turns (FIRST, QUESTION) to done on a live child 0, resuming at a real file. */
async function openLiveSource() {
  const world = worlds.track(await openForkWorld());
  const { db } = world.fixture;
  await turn(world, FIRST);
  await turn(world, QUESTION);
  const u2 = Number(
    (
      db
        .prepare("SELECT MAX(id) AS id FROM chat_messages WHERE session_id = ? AND role = 'user'")
        .get(world.session) as { id: number }
    ).id,
  );
  const source = realSource();
  presetSessionFile(db, world.session, source.file);
  return { world, u2, source, first: spawnedAt(world, 0) };
}

/** Everything a refused request must leave alone: rows, sequence, spawns, frames, claim. */
function observe(world: ForkWorld) {
  const { db, supervisor } = world.fixture;
  return {
    session: rowOf(db, world.session),
    rows: snapshot(db, world.session, true),
    counts: rowCounts(db),
    seq: messageSeq(db),
    spawns: world.rt.calls.length,
    sent: world.spawned.map((spawned) => spawned.stdin.length),
    alive: world.spawned.map((spawned) => isLive(spawned.child)),
    live: supervisor.liveProcessCount(),
    events: world.events.length,
    claimed: held(world),
  };
}

describe("an archived session is read-only (归档后只读)", () => {
  it(
    "S1 prompt, regenerate and fork are 409 session_archived with nothing changed; reads go on; restore revives",
    REAL,
    async () => {
      const { world, u2, first } = await openLiveSource();
      const { fixture, cookie, session } = world;
      const archived = await archiveNow(world, { archived: true });
      const before = observe(world);
      expect(before).toMatchObject({ spawns: 1, alive: [true], live: 1, claimed: false });
      expect(before.session).toMatchObject({ status: "done", archived_at: archived.archivedAt });
      const prompt = vi.spyOn(fixture.supervisor, "prompt");
      const claim = vi.spyOn(fixture.supervisor, "controlHeld");
      const accept = vi.spyOn(fixture.store, "acceptPrompt");

      expectArchived(await sendPrompt(world, "again"));
      // "No supervisor call" on the prompt route: neither the dispatch nor the claim check.
      expect(prompt).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(accept).not.toHaveBeenCalled();
      expectArchived(await postRegenerate(world));
      expectArchived(await postFork(world, u2));
      expect(observe(world)).toEqual(before);
      expect(await listedIds(world)).toEqual([session]);
      expect(isLive(first.child)).toBe(true);
      claim.mockRestore();

      // What archiving leaves alone: the snapshot, the event stream, PATCH and stop.
      const history = await getSessionMessages(fixture.app, session, cookie);
      expect(history.statusCode).toBe(200);
      expect((history.json() as { session: unknown }).session).toEqual(archived);
      const stream = await openEventStream(fixture, session, cookie);
      stream.abort();
      expect(await patched(patch(world, { title: "改名" }))).toEqual({
        ...archived,
        title: "改名",
      });
      const stop = await postSessionAction(fixture.app, "stop", session, cookie);
      expect([stop.statusCode, stop.payload]).toEqual([204, ""]);
      expect(observe(world)).toEqual({
        ...before,
        session: { ...before.session, title: "改名" },
        rows: { ...before.rows, session: { ...(before.rows.session as object), title: "改名" } },
      });

      expect(await patched(patch(world, { archived: false }))).toMatchObject({ archivedAt: null });
      const regenerated = await postRegenerate(world);
      expect(regenerated.statusCode).toBe(202);
      await waitForTurn(fixture, session, "done");
      const again = await sendPrompt(world, "again");
      expect(again.statusCode).toBe(202);
      expect(prompt).toHaveBeenCalledTimes(1);
      await waitForTurn(fixture, session, "done");
      expect(rowCounts(fixture.db).messages).toBe(before.counts.messages + 2);
    },
  );

  it(
    "S2 an archived source refuses fork with no row, no spawn and its process kept; restored, the same request is 201",
    REAL,
    async () => {
      const { world, u2, source, first } = await openLiveSource();
      const { fixture, session } = world;
      await archiveNow(world, { archived: true });
      const before = observe(world);
      const fork = vi.spyOn(fixture.supervisor, "fork");

      expectArchived(await postFork(world, u2));

      expect(fork).toHaveBeenCalledTimes(1);
      expect(observe(world)).toEqual(before);
      expect(await listedIds(world)).toEqual([session]);
      // Not retired: the source's own process is alive, was sent nothing and nothing was spawned.
      expect(isLive(first.child)).toBe(true);
      expect(first.child.killed).toBe(false);
      expect(world.rt.calls).toHaveLength(1);
      source.unchanged();

      expect(await patched(patch(world, { archived: false }))).toMatchObject({ archivedAt: null });
      const forked = await postFork(world, u2);
      expect(forked.statusCode).toBe(201);
      const body = forked.json() as { session: { id: string; archivedAt: unknown }; draft: string };
      expect(body.draft).toBe(QUESTION);
      expect(body.session.archivedAt).toBeNull();
      expect((await listedIds(world)).sort()).toEqual([session, body.session.id].sort());
      expect(rowCounts(fixture.db).sessions).toBe(before.counts.sessions + 1);
      expect(held(world)).toBe(false);
    },
  );
});

describe("where the archive check sits (order pins)", () => {
  it(
    "S3 archived wins over a held claim, a running status and the fork point's 400; 401, 404 and body 400 still come first",
    REAL,
    async () => {
      const world = worlds.track(await openForkWorld());
      const { fixture, session } = world;
      const seeded = seedTwoTurns(world);
      const foreign = await cookieFor(fixture.app, "zhaoliu");
      await archiveNow(world, { archived: true });
      const before = observe(world);
      const claim = vi.spyOn(fixture.supervisor, "controlHeld");

      // 已归档且占用被持有时返回 session_archived (task 2.4).
      const release = fixture.supervisor.holdControl(session);
      try {
        expectArchived(await sendPrompt(world, "again"));
        expect(claim).not.toHaveBeenCalled();
        claim.mockRestore();
        expect(held(world)).toBe(true);
        expectArchived(await postRegenerate(world));
        expectArchived(await postFork(world, seeded.u2));
      } finally {
        release();
      }
      expect(held(world)).toBe(false);

      // A well-formed body naming no user message of the session: archived, not the fork's 400.
      expectArchived(await postFork(world, seeded.a2));
      expectArchived(await postFork(world, 9_000_000));

      // The other half of session_busy: a running status (planted; the API cannot produce it).
      const plant = (status: string) =>
        fixture.db.prepare("UPDATE chat_sessions SET status = ? WHERE id = ?").run(status, session);
      plant("running");
      expectArchived(await sendPrompt(world, "again"));
      expectArchived(await postRegenerate(world));
      expectArchived(await postFork(world, seeded.u2));
      plant("done");

      // Body validation precedes the archive check.
      expectEnvelope(
        await postPrompt(fixture.app, session, world.cookie, MALFORMED_JSON.payload),
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expectEnvelope(await sendPrompt(world, "   "), 400, BAD_REQUEST_ENVELOPE);
      expectEnvelope(
        await postSessionAction(fixture.app, "fork", session, world.cookie, MALFORMED_JSON),
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expectEnvelope(await postFork(world, "7"), 400, BAD_REQUEST_ENVELOPE);
      expectEnvelope(
        await postRegenerate(world, world.cookie, forkBody(seeded.u2)),
        400,
        BAD_REQUEST_ENVELOPE,
      );

      // So does the owner check: someone else's archived session is the plain 404, anonymous 401.
      const stranger = { ...world, cookie: foreign };
      expectEnvelope(await sendPrompt(stranger, "again"), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(await postRegenerate(stranger), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(await postFork(stranger, seeded.u2), 404, NOT_FOUND_ENVELOPE);
      const nobody = { ...world, session: UNKNOWN_SESSION_ID };
      expectEnvelope(await sendPrompt(nobody, "again"), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(await postRegenerate(nobody), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(await postFork(nobody, seeded.u2), 404, NOT_FOUND_ENVELOPE);
      expectEnvelope(await postRegenerate(world, null), 401, UNAUTHORIZED_ENVELOPE);
      expectEnvelope(await postFork(world, seeded.u2, null), 401, UNAUTHORIZED_ENVELOPE);

      expect(observe(world)).toEqual(before);
      expect(before).toMatchObject({ spawns: 0, live: 0 });
      seeded.unchanged();
    },
  );
});

/** A `done` session of the stub fixture's owner, and what a refused prompt must not move. */
function doneSession(fixture: SessionRestFixture) {
  const session = fixture.store.create(OWNER_ID).id;
  fixture.store.finishTurn(
    fixture.store.acceptPrompt(session, OWNER_ID, "first").assistantMessageId,
    "done",
  );
  const state = () => ({
    row: rowOf(fixture.db, session),
    messages: fixture.db
      .prepare("SELECT * FROM chat_messages WHERE session_id = ? ORDER BY id")
      .all(session),
    seq: messageSeq(fixture.db),
  });
  return { session, state };
}

describe("REST prompt on an archived session (Archived session refuses prompts)", () => {
  it("P1 archived: 409 with no row and no supervisor call; restored: 202", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const { session, state } = doneSession(fixture);
      const target = { fixture, cookie, session };
      expect(await patched(patch(target, { archived: true }))).toMatchObject({
        status: "done",
        archivedAt: SESSION_NOW,
      });
      const before = state();
      const accept = vi.spyOn(fixture.store, "acceptPrompt");
      const claim = vi.spyOn(fixture.supervisor, "controlHeld");

      expectArchived(await postPrompt(fixture.app, session, cookie, PROMPT));

      expect(accept).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(fixture.supervisor.calls).toEqual([]);
      expect(state()).toEqual(before);

      expect(await patched(patch(target, { archived: false }))).toMatchObject({ archivedAt: null });
      const restored = await postPrompt(fixture.app, session, cookie, PROMPT);
      expect(restored.statusCode).toBe(202);
      expect(fixture.supervisor.calls).toEqual([{ sessionId: session, text: "next question" }]);
      expect(state().row).toMatchObject({ status: "running", archived_at: null });
      expect(state().messages).toHaveLength(before.messages.length + 2);
    });
  });

  it("P2 the archive read, the claim check and acceptPrompt share one synchronous segment", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const { session } = doneSession(fixture);
      const accept = vi.spyOn(fixture.store, "acceptPrompt");
      const claim = vi.spyOn(fixture.supervisor, "controlHeld");
      const seen: number[] = [];
      const inner = fixture.metadata.archivedAt.bind(fixture.metadata);
      const read = vi.spyOn(fixture.metadata, "archivedAt").mockImplementation((...args) => {
        queueMicrotask(() => seen.push(accept.mock.calls.length));
        return inner(...args);
      });

      const response = await postPrompt(fixture.app, session, cookie, PROMPT);

      expect(response.statusCode).toBe(202);
      // A microtask queued by the read runs only after admission: nothing awaited in between.
      expect(seen).toEqual([1]);
      expect(read.mock.calls).toEqual([[session, OWNER_ID]]);
      const order = [read, claim, accept].map((spy) => spy.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => Number(a) - Number(b)));
      expect(order).not.toContain(undefined);
    });
  });

  it("P3 archivedAt is an owner-scoped read: the time, else null", async () => {
    await withSessionRest(async (fixture) => {
      const { session } = doneSession(fixture);
      const { metadata } = fixture;
      expect(metadata.archivedAt(session, OWNER_ID)).toBeNull();
      fixture.db.prepare("UPDATE chat_sessions SET archived_at = 7 WHERE id = ?").run(session);
      expect(metadata.archivedAt(session, OWNER_ID)).toBe(7);
      expect(metadata.archivedAt(session, "u2")).toBeNull();
      expect(metadata.archivedAt(UNKNOWN_SESSION_ID, OWNER_ID)).toBeNull();
    });
  });
});

describe("archive and prompt admission never both succeed (归档与受理不并发成功)", () => {
  it("C1 an archive landing after the owner pre-check and before the handler refuses the prompt", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const { session, state } = doneSession(fixture);
      const before = state();
      const landed: unknown[] = [];
      // preParsing has just cached the (unarchived) tree: the archive commits right here, before
      // the body is parsed and the handler runs.
      fixture.supervisor.onStreamCursor(() => {
        landed.push(fixture.metadata.patchSession(OWNER_ID, session, { archived: true }));
        return fixture.supervisor.cursor;
      });

      expectArchived(await postPrompt(fixture.app, session, cookie, PROMPT));

      expect(landed).toEqual([
        expect.objectContaining({ status: "done", archivedAt: SESSION_NOW }),
      ]);
      expect(fixture.supervisor.calls).toEqual([]);
      expect(state()).toEqual({ ...before, row: { ...before.row, archived_at: SESSION_NOW } });
    });
  });

  it("C2 a prompt admitted first makes the archive 409 session_busy", async () => {
    await withSessionRest(async (fixture) => {
      const cookie = await cookieFor(fixture.app, "zhangsan");
      const { session, state } = doneSession(fixture);
      const dispatch = deferred();
      fixture.supervisor.onPrompt(() => dispatch.promise);

      const prompt = postPrompt(fixture.app, session, cookie, PROMPT);
      await waitFor(() => (fixture.supervisor.calls.length === 1 ? true : undefined), "dispatch");
      const admitted = state().row;
      expect(admitted).toMatchObject({ status: "running", archived_at: null });
      expectEnvelope(
        await patch({ fixture, cookie, session }, { archived: true }),
        409,
        SESSION_BUSY_ENVELOPE,
      );
      dispatch.resolve();

      expect((await prompt).statusCode).toBe(202);
      expect(state().row).toEqual(admitted);
    });
  });

  it("C3 fired together, in either order, exactly one of the two succeeds", async () => {
    const codeOf = (response: LightMyRequestResponse) =>
      (response.json() as { error?: { code: string } }).error?.code ?? null;
    for (const promptFirst of [true, false]) {
      await withSessionRest(async (fixture) => {
        const cookie = await cookieFor(fixture.app, "zhangsan");
        const { session, state } = doneSession(fixture);
        const sends = [
          () => postPrompt(fixture.app, session, cookie, PROMPT),
          () => patch({ fixture, cookie, session }, { archived: true }),
        ];
        const order = promptFirst ? sends : sends.toReversed();
        const settled = await Promise.all(order.map((send) => send()));
        const [prompt, archive] = promptFirst ? settled : settled.toReversed();

        const { status, archived_at: archivedAt } = state().row;
        const outcome = [
          [prompt?.statusCode, prompt && codeOf(prompt)],
          [archive?.statusCode, archive && codeOf(archive)],
          [status, archivedAt],
        ];
        // The spec's two outcomes and no third; never an archived running session.
        expect([
          [
            [202, null],
            [409, "session_busy"],
            ["running", null],
          ],
          [
            [409, "session_archived"],
            [200, null],
            ["done", SESSION_NOW],
          ],
        ]).toContainEqual(outcome);
      });
    }
  });
});
