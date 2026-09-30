/**
 * Issue #525 DELETE /api/sessions/:id, non-running path (parent s1c-session-metadata-presentation
 * tasks 4.3b, design D3): owner precheck, control claim, retire, tombstone, one delete + audit
 * transaction, post-commit unlink. Evidence numbers follow the fixture design "Required evidence";
 * its transitional running 409 (evidence 8) is replaced by #526 evidence 7 (the rest of the running
 * path is session-delete-running.test.ts). "Row unchanged" = every `chat_sessions` column plus the session's message/step/approval counts
 * deep-equal before and after (`sessionState`).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { REAL, settle, spawnedAt } from "./session-approval-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE, UNAUTHORIZED_ENVELOPE } from "./session-db-helpers.js";
import {
  auditEvents,
  auditRows,
  deleteEvent,
  deleteWorlds,
  expectDeleted,
  insertStep,
  JSON_TYPE,
  NOT_FOUND_WIRE,
  openLingeringWorld,
  openRealWorld,
  ownedDir,
  ownedFile,
  ownerSessionDir,
  parkedDelete,
  presetFile,
  release,
  sendDelete,
  sessionFileOf,
  sessionState,
  track,
  wireShape,
} from "./session-delete-helpers.js";
import {
  expectStoppedTail,
  observeDeletes,
  presetOwnedFile,
} from "./session-delete-running-helpers.js";
import {
  FIRST,
  heldRegenerate,
  insertApproval,
  listedIds,
  messagesOf,
  turn,
} from "./session-fork-helpers.js";
import { HOLD, QUESTION, regenWorlds } from "./session-regenerate-helpers.js";
import { cookieFor, postPrompt, SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { collected, openEventStream, readUntil } from "./session-sse-helpers.js";
import { heldTurn, openStopWorld } from "./session-stop-helpers.js";
import {
  assistantIdFor,
  createSession,
  OWNER_ID,
  type RecordingWorld,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";

deleteWorlds();
const worlds = regenWorlds();

const MALFORMED = { payload: '{"x": ', contentType: JSON_TYPE };
const WELL_FORMED = { payload: '{"x":1}', contentType: JSON_TYPE };
const OUTSIDE_SESSION_DIR = "session delete: session file outside the owner session dir";
const NOT_REGULAR_FILE = "session delete: session file is not a regular file";

type RealWorld = Awaited<ReturnType<typeof openRealWorld>>;

/** The same id-scoped request for `session` and for an unknown id, as compared wires. */
async function idScopedWires(world: RecordingWorld, session: string) {
  const { app } = world.fixture;
  const cookie = world.cookie;
  const requests = (id: string): Array<Promise<LightMyRequestResponse>> => [
    app.inject({ method: "GET", url: `/api/sessions/${id}/messages`, headers: { cookie } }),
    app.inject({ method: "GET", url: `/api/sessions/${id}/events`, headers: { cookie } }),
    app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      headers: { cookie, "content-type": JSON_TYPE },
      payload: JSON.stringify({ title: "x" }),
    }),
    sendDelete(app, id, cookie),
  ];
  const deleted = (await Promise.all(requests(session))).map(wireShape);
  const unknown = (await Promise.all(requests("f".repeat(32)))).map(wireShape);
  return { deleted, unknown };
}

describe("DELETE /api/sessions/:id authorization (evidence 1)", () => {
  it("anonymous is a no-store 401; foreign and unknown ids are identical 404s", async () => {
    const world = await openRealWorld();
    const { app, db, supervisor } = world.fixture;
    await turn(world, "hi");
    const other = await cookieFor(app, "zhaoliu");
    const before = sessionState(db, world.session);
    const audits = auditRows(db);
    const spawns = world.rt.calls.length;
    const retire = vi.spyOn(supervisor, "retire");

    for (const body of [undefined, MALFORMED]) {
      expectEnvelope(await sendDelete(app, world.session, null, body), 401, UNAUTHORIZED_ENVELOPE);
      expect(wireShape(await sendDelete(app, world.session, other, body))).toEqual(NOT_FOUND_WIRE);
      expect(wireShape(await sendDelete(app, "f".repeat(32), world.cookie, body))).toEqual(
        NOT_FOUND_WIRE,
      );
    }

    expect(retire).not.toHaveBeenCalled();
    expect(supervisor.controlHeld(world.session)).toBe(false);
    expect(supervisor.liveProcessCount()).toBe(1);
    expect(world.rt.calls).toHaveLength(spawns);
    expect(sessionState(db, world.session)).toEqual(before);
    expect(auditRows(db)).toBe(audits);
    expect(world.errors).toEqual([]);
  });
});

describe("DELETE of an idle session (evidence 2)", () => {
  it("retires the child, ends both streams, cascades rows, unlinks the branch file, audits once", {
    timeout: 30_000,
  }, async () => {
    const world = await openRealWorld("branch");
    const { app, db, supervisor } = world.fixture;
    const source = world.session;
    await turn(world, FIRST, source);
    await turn(world, QUESTION, source);
    const [u1, a1, u2] = messagesOf(db, source);
    if (u1 === undefined || a1 === undefined || u2 === undefined) {
      throw new Error("missing seeded turns");
    }
    insertApproval(db, a1.id, "r-allow", "allow", 70);
    const forked = await postSessionAction(app, "fork", source, world.cookie, {
      name: "fork body",
      payload: JSON.stringify({ messageId: u2.id }),
      contentType: JSON_TYPE,
    });
    expect(forked.statusCode).toBe(201);
    const fork = (forked.json() as { session: { id: string } }).session.id;
    const regenerated = await postSessionAction(app, "regenerate", source, world.cookie);
    expect(regenerated.statusCode).toBe(202);
    await waitForTurn(world.fixture, source, "done");
    await settle();

    const file = sessionFileOf(db, source) ?? "";
    expect(file.startsWith(join(world.rt.runtime.stateDir, "sessions", OWNER_ID, "branch-"))).toBe(
      true,
    );
    expect(existsSync(file)).toBe(true);
    const sourceMessageIds = messagesOf(db, source).map((message) => message.id);
    expect(sessionState(db, source)).toMatchObject({ messages: 4, approvals: 1 });
    expect(sessionState(db, source).steps).toBeGreaterThan(0);
    const live = world.rt.children.filter((candidate) => isLive(candidate));
    expect(live).toHaveLength(1);
    const [child] = live;

    const other = await createSession(app, world.cookie);
    await turn(world, "other session", other);
    const otherChild = world.rt.children.at(-1);
    const otherBefore = sessionState(db, other);
    const forkBefore = sessionState(db, fork);
    expect(forkBefore.row).toMatchObject({ parent_session_id: source });

    const streams = [
      await openEventStream(world.fixture, source, world.cookie),
      await openEventStream(world.fixture, source, world.cookie),
    ];
    await settle();
    expect(supervisor.sessionStreamSubscriberCount(source)).toBe(2);
    const admin = await cookieFor(app, "lisi");
    const adminBefore = await auditEvents(app, admin);

    expectDeleted(await sendDelete(app, source, world.cookie));

    expect(isLive(child)).toBe(false);
    for (const stream of streams) {
      stream.resume();
    }
    await settle();
    for (const stream of streams) {
      expect(stream.raw.writableEnded).toBe(true);
      expect(collected(stream)).toBe("");
    }
    expect(supervisor.sessionStreamSubscriberCount(source)).toBe(0);
    expect(sessionState(db, source)).toEqual({
      row: undefined,
      messages: 0,
      steps: 0,
      approvals: 0,
    });
    const placeholders = sourceMessageIds.map(() => "?").join(", ");
    const orphans = (table: string) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE message_id IN (${placeholders})`)
        .get(...sourceMessageIds) as { n: number };
    expect([orphans("chat_steps").n, orphans("chat_approvals").n]).toEqual([0, 0]);
    expect(existsSync(file)).toBe(false);

    const forkAfter = sessionState(db, fork);
    expect(forkAfter).toEqual({
      ...forkBefore,
      row: { ...(forkBefore.row as object), parent_session_id: null },
    });
    const ids = await listedIds(world);
    expect(ids).toContain(fork);
    expect(ids).not.toContain(source);

    const adminAfter = await auditEvents(app, admin);
    expect(adminAfter.slice(1)).toEqual(adminBefore);
    expect(adminAfter[0]).toEqual(deleteEvent(source, file, 4));
    const member = await auditEvents(app, await cookieFor(app, "zhaoliu"));
    expect(member.filter((event) => event.kind === "session.delete")).toEqual([]);

    const { deleted, unknown } = await idScopedWires(world, source);
    expect(deleted).toEqual(unknown);
    expect(deleted.every((wire) => wire.status === 404)).toBe(true);

    expect(isLive(otherChild)).toBe(true);
    expect(sessionState(db, other)).toEqual(otherBefore);
    expect(world.errors).toEqual([]);
  });
});

describe("DELETE file edge cases (evidence 3, 9)", () => {
  it("a missing session file and a never-prompted session both delete without error", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const missing = join(ownerSessionDir(world.rt.runtime.stateDir), "missing.jsonl");
    presetFile(db, world.session, missing);
    const fresh = await createSession(app, world.cookie);
    const admin = await cookieFor(app, "lisi");
    const before = await auditEvents(app, admin);

    expectDeleted(await sendDelete(app, world.session, world.cookie));
    expectDeleted(await sendDelete(app, fresh, world.cookie));

    const after = await auditEvents(app, admin);
    expect(after.slice(2)).toEqual(before);
    expect(after.slice(0, 2)).toEqual([
      deleteEvent(fresh, null, 0),
      deleteEvent(world.session, missing, 0),
    ]);
    expect([sessionState(db, world.session).row, sessionState(db, fresh).row]).toEqual([
      undefined,
      undefined,
    ]);
    expect(world.rt.calls).toEqual([]);
    expect(world.errors).toEqual([]);
  });

  it("an unlink failure other than ENOENT is reported once and the DELETE is still 204", async () => {
    await expectUnlinkFailureReported(await openRealWorld());
  });

  it("a throwing error channel does not turn the committed DELETE into a 5xx", async () => {
    const world = await openRealWorld(undefined, {
      onError() {
        throw new Error("error channel down");
      },
    });
    await expectUnlinkFailureReported(world);
  });
});

/**
 * A read-only (0500) owner session dir makes the unlink of a real file in it fail with EACCES. The
 * unlink runs on the resolved target, so the reported path is under the session dir's realpath.
 */
async function expectUnlinkFailureReported(world: RealWorld): Promise<void> {
  const { app, db } = world.fixture;
  const dir = ownerSessionDir(world.rt.runtime.stateDir);
  const file = ownedFile(dir);
  presetFile(db, world.session, file);
  const audits = auditRows(db);
  const mode = statSync(dir).mode & 0o7777;
  chmodSync(dir, 0o500);
  try {
    expectDeleted(await sendDelete(app, world.session, world.cookie));
  } finally {
    chmodSync(dir, mode);
  }

  expect(sessionState(db, world.session).row).toBeUndefined();
  expect(auditRows(db)).toBe(audits + 1);
  expect(world.errors).toHaveLength(1);
  const reported = world.errors[0] as NodeJS.ErrnoException;
  expect([reported.code, reported.path]).toEqual([
    "EACCES",
    join(realpathSync(dir), basename(file)),
  ]);
  expect(existsSync(file)).toBe(true);
}

describe("DELETE session file path validation (evidence 13)", () => {
  it("an outside file, a relative path and a symlink are each reported once, never unlinked", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    const outside = ownedFile();
    // Resolved against the app cwd it names a real file inside the session dir: only the
    // absolute-path check keeps it.
    const inside = ownedFile(dir, "inside.jsonl");
    const target = ownedFile();
    const link = join(dir, "link.jsonl");
    symlinkSync(target, link);
    const cases = [
      { file: outside, message: OUTSIDE_SESSION_DIR },
      { file: relative(process.cwd(), inside), message: OUTSIDE_SESSION_DIR },
      { file: link, message: NOT_REGULAR_FILE },
    ];
    expect(cases.map(({ file }) => isAbsolute(file))).toEqual([true, false, true]);
    const admin = await cookieFor(app, "lisi");

    for (const [index, { file }] of cases.entries()) {
      const session = await createSession(app, world.cookie);
      presetFile(db, session, file);

      expectDeleted(await sendDelete(app, session, world.cookie));

      expect(sessionState(db, session).row).toBeUndefined();
      expect((await auditEvents(app, admin, 1))[0]).toEqual(deleteEvent(session, file, 0));
      expect(world.errors.map((error) => error.message)).toEqual(
        cases.slice(0, index + 1).map(({ message }) => message),
      );
    }
    for (const survivor of [outside, inside, target]) {
      expect(existsSync(survivor)).toBe(true);
    }
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("a symlinked middle component resolving to the session dir deletes the resolved file", async () => {
    const world = await openRealWorld();
    const { app, db } = world.fixture;
    const dir = ownerSessionDir(world.rt.runtime.stateDir);
    const resolved = ownedFile(dir, "x.jsonl");
    const junction = join(ownedDir(), "j");
    symlinkSync(dir, junction);
    const file = join(junction, "x.jsonl");
    presetFile(db, world.session, file);
    const admin = await cookieFor(app, "lisi");

    expectDeleted(await sendDelete(app, world.session, world.cookie));

    expect(sessionState(db, world.session).row).toBeUndefined();
    expect((await auditEvents(app, admin, 1))[0]).toEqual(deleteEvent(world.session, file, 0));
    expect(existsSync(resolved)).toBe(false);
    expect(lstatSync(junction).isSymbolicLink()).toBe(true);
    expect(world.errors).toEqual([]);
  });
});

describe("DELETE request bodies (evidence 4)", () => {
  it("a well-formed JSON body is ignored; a malformed one is a generic 500 with no step run", async () => {
    const world = await openRealWorld();
    const { app, db, supervisor } = world.fixture;
    await turn(world, "hi");
    presetFile(db, world.session, ownedFile(ownerSessionDir(world.rt.runtime.stateDir)));
    const [child] = world.rt.children;
    const bodyless = await createSession(app, world.cookie);
    const withBody = await createSession(app, world.cookie);

    const plain = await sendDelete(app, bodyless, world.cookie);
    const ignored = await sendDelete(app, withBody, world.cookie, WELL_FORMED);
    expectDeleted(plain);
    expectDeleted(ignored);
    expect(wireShape(ignored)).toEqual(wireShape(plain));

    const before = sessionState(db, world.session);
    const audits = auditRows(db);
    const malformed = await sendDelete(app, world.session, world.cookie, MALFORMED);
    expectEnvelope(malformed, 500, INTERNAL_ERROR_ENVELOPE);
    expect(sessionState(db, world.session)).toEqual(before);
    expect(auditRows(db)).toBe(audits);
    expect(isLive(child)).toBe(true);
    expect(supervisor.liveProcessCount()).toBe(1);
    expect(supervisor.controlHeld(world.session)).toBe(false);

    expectDeleted(await sendDelete(app, world.session, world.cookie));
    expect(isLive(child)).toBe(false);
  });
});

describe("DELETE tombstone window (evidence 5, 6)", () => {
  it("a subscription opened while DELETE retires ends at once without subscribing", async () => {
    const world = await openLingeringWorld();
    const { app, db, supervisor } = world.fixture;
    await turn(world, "hi");
    expect(sessionFileOf(db, world.session)).toBe(world.file);

    const { pending } = await parkedDelete(world);
    const stream = await openEventStream(world.fixture, world.session, world.cookie);
    stream.resume();
    await settle();
    expect(stream.raw.writableEnded).toBe(true);
    expect(collected(stream)).toBe("");
    expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(0);

    release(world.rt.children[0]);
    expectDeleted(await pending);
    expect(existsSync(world.file)).toBe(false);
    const again = await app.inject({
      method: "GET",
      url: `/api/sessions/${world.session}/events`,
      headers: { cookie: world.cookie },
    });
    expect(wireShape(again)).toEqual(NOT_FOUND_WIRE);
  });

  it("an audit or delete failure keeps every row and file and lifts claim and tombstone", {
    timeout: 20_000,
  }, async () => {
    const world = await openLingeringWorld();
    const { app, db, supervisor } = world.fixture;
    const tree = await turn(world, "hi");
    const assistant = tree.messages[1]?.id ?? -1;
    insertStep(db, assistant);
    insertApproval(db, assistant, "r-allow", "allow", 70);
    db.exec(`CREATE TEMP TRIGGER reject_delete_audit BEFORE INSERT ON audit_events
      WHEN NEW.kind = 'session.delete' BEGIN SELECT RAISE(ABORT, 'x'); END`);
    const before = sessionState(db, world.session);
    expect(before).toMatchObject({ messages: 2, steps: 1, approvals: 1 });
    const audits = auditRows(db);

    const { pending } = await parkedDelete(world);
    const window = await openEventStream(world.fixture, world.session, world.cookie);
    window.resume();
    await settle();
    expect(window.raw.writableEnded).toBe(true);
    expect(collected(window)).toBe("");
    expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(0);
    release(world.rt.children[0]);
    expectEnvelope(await pending, 500, INTERNAL_ERROR_ENVELOPE);

    expect(supervisor.liveProcessCount()).toBe(0);
    expect(sessionState(db, world.session)).toEqual(before);
    expect(existsSync(world.file)).toBe(true);
    expect(auditRows(db)).toBe(audits);
    expect(supervisor.controlHeld(world.session)).toBe(false);
    db.exec("DROP TRIGGER reject_delete_audit");

    const live = await openEventStream(world.fixture, world.session, world.cookie);
    await settle();
    expect(live.raw.writableEnded).toBe(false);
    expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(1);
    const prompt = postPrompt(
      app,
      world.session,
      world.cookie,
      JSON.stringify({ message: "again" }),
    );
    expect((await prompt).statusCode).toBe(202);
    expect(await readUntil(live, (text) => text.includes("event: turn.end"))).toContain(
      "event: turn.start",
    );
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    expect(world.rt.calls).toHaveLength(2);

    db.exec(`CREATE TEMP TRIGGER reject_session_delete BEFORE DELETE ON chat_sessions
      BEGIN SELECT RAISE(ABORT, 'x'); END`);
    const second = sessionState(db, world.session);
    expectEnvelope(
      await sendDelete(app, world.session, world.cookie),
      500,
      INTERNAL_ERROR_ENVELOPE,
    );
    expect(sessionState(db, world.session)).toEqual(second);
    expect(existsSync(world.file)).toBe(true);
    expect(auditRows(db)).toBe(audits);
    expect(supervisor.controlHeld(world.session)).toBe(false);
    db.exec("DROP TRIGGER reject_session_delete");
    expect(world.errors).toEqual([]);
  });
});

describe("DELETE and concurrent control (evidence 7)", () => {
  it("is a side-effect-free 409 while a regenerate holds the control claim", REAL, async () => {
    const { world, db, work } = await heldRegenerate(worlds, HOLD.branch);
    const { app, supervisor } = world.fixture;
    const before = sessionState(db, world.session);
    const audits = auditRows(db);
    const spawns = world.rt.calls.length;
    const held = world.spawned[0];
    try {
      expect(supervisor.controlHeld(world.session)).toBe(true);

      const response = await sendDelete(app, world.session, world.cookie);

      expectEnvelope(response, 409, SESSION_BUSY_ENVELOPE);
      expect(sessionState(db, world.session)).toEqual(before);
      expect(auditRows(db)).toBe(audits);
      expect(world.rt.calls).toHaveLength(spawns);
      expect(isLive(held?.child)).toBe(true);
    } finally {
      held?.gate.release();
    }
    await work;
    await waitForTurn(world.fixture, world.session, "done");
  });

  it("while DELETE retires, prompt, regenerate, fork and a second DELETE are all 409", async () => {
    const world = await openLingeringWorld();
    const { app, db } = world.fixture;
    const tree = await turn(world, "hi");
    const user = tree.messages[0]?.id ?? -1;
    const before = sessionState(db, world.session);
    const audits = auditRows(db);

    const { pending } = await parkedDelete(world);
    const concurrent = [
      await postPrompt(app, world.session, world.cookie, JSON.stringify({ message: "x" })),
      await postSessionAction(app, "regenerate", world.session, world.cookie),
      await postSessionAction(app, "fork", world.session, world.cookie, {
        name: "fork body",
        payload: JSON.stringify({ messageId: user }),
        contentType: JSON_TYPE,
      }),
      await sendDelete(app, world.session, world.cookie),
    ];
    for (const response of concurrent) {
      expectEnvelope(response, 409, SESSION_BUSY_ENVELOPE);
    }
    expect(sessionState(db, world.session)).toEqual(before);
    expect(auditRows(db)).toBe(audits);
    expect(world.rt.calls).toHaveLength(1);

    release(world.rt.children[0]);
    expectDeleted(await pending);
    expect(auditRows(db)).toBe(audits + 1);
  });
});

describe("DELETE of a running session (#526 evidence 7, supersedes the transitional 409)", () => {
  it(
    "stops the turn first: stopped rows before deletion, the stream sees turn.end, then 204",
    REAL,
    async () => {
      const world = await openStopWorld("abort-ok");
      track(world.fixture);
      const { app, db, supervisor } = world.fixture;
      await heldTurn(world);
      const assistant = assistantIdFor(world.fixture, world.session);
      const stream = await openEventStream(world.fixture, world.session, world.cookie);
      stream.resume();
      await settle();
      expect(sessionState(db, world.session).row).toMatchObject({ status: "running" });
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(1);
      const deletes = observeDeletes(db);
      const file = presetOwnedFile(world);

      expectDeleted(await sendDelete(app, world.session, world.cookie));

      expect(deletes()).toEqual([
        { id: world.session, session: "stopped", assistants: "stopped", approvals: null },
      ]);
      await settle();
      expectStoppedTail(stream, assistant);
      expect(supervisor.sessionStreamSubscriberCount(world.session)).toBe(0);
      expect(supervisor.controlHeld(world.session)).toBe(false);
      expect(isLive(spawnedAt(world, 0).child)).toBe(false);
      expect(sessionState(db, world.session).row).toBeUndefined();
      expect(existsSync(file)).toBe(false);
      expect(world.errors).toEqual([]);
    },
  );
});

describe("DELETE audit shape over a full round (evidence 10)", () => {
  it("session.delete follows session.bind for a bound session; members see neither", async () => {
    const world = await openRealWorld("thinking");
    const { app, db } = world.fixture;
    mkdirSync(world.rt.runtime.sandboxRoot, { recursive: true });
    const workspace = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { "content-type": JSON_TYPE, cookie: world.cookie },
      payload: JSON.stringify({ name: "proj", dir: "proj" }),
    });
    expect(workspace.statusCode).toBe(201);
    const workspaceId = (workspace.json() as { id: string }).id;
    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": JSON_TYPE, cookie: world.cookie },
      payload: JSON.stringify({ workspaceId, scene: "office" }),
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;
    await turn(world, "think", id);
    const file = ownedFile(ownerSessionDir(world.rt.runtime.stateDir));
    presetFile(db, id, file);

    expectDeleted(await sendDelete(app, id, world.cookie));

    const admin = await auditEvents(app, await cookieFor(app, "lisi"), 2);
    expect(admin).toEqual([
      deleteEvent(id, file, 2, workspaceId),
      {
        id: expect.any(Number),
        ts: expect.any(Number),
        actorId: OWNER_ID,
        kind: "session.bind",
        title: "绑定工作空间",
        detail: { sessionId: id, scene: "office" },
        workspaceId,
      },
    ]);
    const member = await auditEvents(app, await cookieFor(app, "zhaoliu"));
    expect(member.some((event) => JSON.stringify(event.detail).includes(id))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});
