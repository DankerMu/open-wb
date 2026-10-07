/**
 * Issue #922 (s1f-session-list-temp-space task 2.2, design D4): `PATCH /api/sessions/:id`
 * `{archived}` — session-metadata 「会话归档」 (归档与恢复 / 运行中与占用期间不能归档 / 鉴权) and
 * 「会话元数据修改」 (归档键与其它键一起修改 / the two `archived` examples of 非法 body 与鉴权).
 * Every world is the production createApp → registerSessions assembly driven through
 * `app.inject()` on a real in-memory SQLite: a real fake-omp turn for the `done` worlds, a
 * controlled child holding a turn open for `running`, a real regenerate parked on its first child
 * for a held control claim. Oracles: the spec's status codes and envelopes, the wall clock around
 * each request, and whole `chat_sessions` rows read by SQL. The read-only interception of archived
 * sessions is task 2.3 (#923): `session-archive-readonly.test.ts`.
 */
import { Buffer } from "node:buffer";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emit } from "../src/core/audit/index.js";
import { createSessionMetadataStore } from "../src/sessions/store-metadata.js";
import { REAL, spawnedAt } from "./session-approval-helpers.js";
import {
  archiveNow,
  patch,
  patched,
  rowOf,
  type Target,
  type View,
} from "./session-archive-helpers.js";
import { expectEnvelope } from "./session-bodyless-rest-helpers.js";
import {
  BAD_REQUEST_ENVELOPE,
  NOT_FOUND_ENVELOPE,
  UNAUTHORIZED_ENVELOPE,
} from "./session-db-helpers.js";
import { auditEvents, auditRows } from "./session-delete-helpers.js";
import {
  HOLD,
  heldLine,
  openRegenWorld,
  regenerate,
  regenWorlds,
  seedDone,
} from "./session-regenerate-helpers.js";
import {
  cookieFor,
  getSessionMessages,
  postPrompt,
  SESSION_BUSY_ENVELOPE,
  UNKNOWN_SESSION_ID,
} from "./session-rest-helpers.js";
import {
  completeHeldTurn,
  createRealFakeRuntime,
  OWNER_ID,
  openBareSession,
  openHeldPromptSession,
  type RealFakeRuntime,
  type SupervisorApp,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { temporaryWorkspacePort } from "./support/temporary-workspace.js";

const fixtures: SupervisorApp[] = [];
const regenWorldsOwned = regenWorlds();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

async function laterThan(ms: number): Promise<void> {
  await waitFor(() => (Date.now() > ms ? true : undefined), `clock past ${String(ms)}`);
}

/** A session whose one real fake-omp turn ended `done`; its child stays alive (idle). */
async function openDoneWorld(): Promise<Target & { fixture: SupervisorApp; rt: RealFakeRuntime }> {
  const rt = createRealFakeRuntime();
  const opened = await openBareSession(rt.runtime);
  fixtures.push(opened.fixture);
  const prompt = await postPrompt(
    opened.fixture.app,
    opened.session,
    opened.cookie,
    JSON.stringify({ message: "hi" }),
  );
  expect(prompt.statusCode).toBe(202);
  await waitForTurn(opened.fixture, opened.session, "done");
  return { ...opened, rt };
}

describe("PATCH archived: archive and restore (归档与恢复)", REAL, () => {
  it("A1 archive, re-archive and restore touch archived_at only", async () => {
    const world = await openDoneWorld();
    const { fixture, cookie, session, rt } = world;
    // A non-null pin and scene make "pinnedAt unchanged" observable.
    const base = await patched(patch(world, { pinned: true, scene: "code" }));
    expect(base).toMatchObject({ status: "done", archivedAt: null });
    expect(base.pinnedAt).toEqual(expect.any(Number));
    const rowBefore = rowOf(fixture.db, session);
    const historyBefore = await getSessionMessages(fixture.app, session, cookie);
    expect(historyBefore.statusCode).toBe(200);
    const auditBefore = await auditEvents(fixture.app, cookie);
    const auditCount = auditRows(fixture.db);
    const spawns = rt.calls.length;
    expect(spawns).toBe(1);
    expect(fixture.supervisor.liveProcessCount()).toBe(1);

    const first = await archiveNow(world, { archived: true });
    expect(first).toEqual({ ...base, archivedAt: first.archivedAt });
    expect(rowOf(fixture.db, session)).toEqual({ ...rowBefore, archived_at: first.archivedAt });
    const archivedHistory = await getSessionMessages(fixture.app, session, cookie);
    expect(archivedHistory.json()).toEqual({
      ...(historyBefore.json() as object),
      session: first,
    });
    const listed = await fixture.app.inject({
      method: "GET",
      url: "/api/sessions",
      headers: { cookie },
    });
    expect((listed.json() as { sessions: View[] }).sessions).toEqual([first]);

    // The clock moves on, so an overwrite could not pass for "kept the first time".
    await laterThan(first.archivedAt ?? Number.NaN);
    expect(await patched(patch(world, { archived: true }))).toEqual(first);
    expect(rowOf(fixture.db, session).archived_at).toBe(first.archivedAt);

    expect(await patched(patch(world, { archived: false }))).toEqual(base);
    expect(rowOf(fixture.db, session)).toEqual(rowBefore);
    // Restoring a session that is not archived is the same 200.
    expect(await patched(patch(world, { archived: false }))).toEqual(base);
    expect(rowOf(fixture.db, session)).toEqual(rowBefore);

    expect((await getSessionMessages(fixture.app, session, cookie)).payload).toBe(
      historyBefore.payload,
    );
    expect(await auditEvents(fixture.app, cookie)).toEqual(auditBefore);
    expect(auditRows(fixture.db)).toBe(auditCount);
    expect(rt.calls).toHaveLength(spawns);
    expect(fixture.supervisor.liveProcessCount()).toBe(1);
    expect(rt.children[0]?.exitCode).toBeNull();
    expect(rt.children[0]?.killed).toBe(false);
  });
});

describe("PATCH archived: running or claimed sessions (运行中与占用期间不能归档)", REAL, () => {
  it("B1 a running turn refuses archived:true whole, yet allows archived:false and pinned", async () => {
    const held = await openHeldPromptSession();
    fixtures.push(held.fixture);
    const { fixture, session } = held;
    const noted = vi.spyOn(fixture.store, "noteTitleWrite");
    const before = rowOf(fixture.db, session);
    expect(before).toMatchObject({ status: "running", archived_at: null, pinned_at: null });
    expect(fixture.supervisor.controlHeld(session)).toBe(false);

    expectEnvelope(await patch(held, { archived: true }), 409, SESSION_BUSY_ENVELOPE);
    expect(rowOf(fixture.db, session)).toEqual(before);
    // The other keys of a refused PATCH are not written either.
    expectEnvelope(
      await patch(held, { title: "新名", scene: "design", pinned: true, archived: true }),
      409,
      SESSION_BUSY_ENVELOPE,
    );
    expect(rowOf(fixture.db, session)).toEqual(before);
    expect(noted).not.toHaveBeenCalled();

    // archived:false is not gated: it clears a planted archive time on the running session.
    fixture.db.prepare("UPDATE chat_sessions SET archived_at = 5 WHERE id = ?").run(session);
    const restored = await patched(patch(held, { archived: false }));
    expect(restored).toMatchObject({ status: "running", archivedAt: null });
    expect(rowOf(fixture.db, session)).toEqual(before);
    const pinned = await patched(patch(held, { pinned: true }));
    expect(pinned).toEqual({ ...restored, pinnedAt: expect.any(Number) });
    expect(rowOf(fixture.db, session)).toEqual({ ...before, pinned_at: pinned.pinnedAt });

    completeHeldTurn(held.child);
    const done = (await waitForTurn(fixture, session, "done")).session;
    const archived = await archiveNow(held, { archived: true });
    expect(archived).toMatchObject({ status: "done", updatedAt: done.updatedAt });
  });

  it("B2 a regenerate holding the claim refuses {title, archived:true} whole", async () => {
    const world = regenWorldsOwned.track(await openRegenWorld({ hold: HOLD.ready }));
    seedDone(world);
    const { fixture, session } = world;
    const work = regenerate(world);
    await heldLine(world);
    const noted = vi.spyOn(fixture.store, "noteTitleWrite");
    const before = rowOf(fixture.db, session);
    // The claim, not the status, is what refuses here.
    expect(before).toMatchObject({ status: "done", archived_at: null, title: "second question" });
    expect(fixture.supervisor.controlHeld(session)).toBe(true);

    expectEnvelope(
      await patch(world, { title: "新名", archived: true }),
      409,
      SESSION_BUSY_ENVELOPE,
    );
    expectEnvelope(await patch(world, { archived: true }), 409, SESSION_BUSY_ENVELOPE);
    expect(rowOf(fixture.db, session)).toEqual(before);
    expect(noted).not.toHaveBeenCalled();
    // Only archived:true is gated by the claim.
    expect(await patched(patch(world, { archived: false }))).toMatchObject({ archivedAt: null });
    expect(rowOf(fixture.db, session)).toEqual(before);

    spawnedAt(world, 0).gate.release();
    await work;
    await waitForTurn(fixture, session, "done");
    expect(fixture.supervisor.controlHeld(session)).toBe(false);
    const archived = await archiveNow(world, { title: "新名", archived: true });
    expect(archived).toMatchObject({ title: "新名", status: "done" });
    expect(noted.mock.calls).toEqual([[session]]);
  });

  it("B3 any holder of the claim refuses until its last release", async () => {
    const world = await openDoneWorld();
    const { fixture, session } = world;
    const before = rowOf(fixture.db, session);
    const releaseFirst = fixture.supervisor.holdControl(session);
    const releaseSecond = fixture.supervisor.holdControl(session);

    expectEnvelope(await patch(world, { archived: true }), 409, SESSION_BUSY_ENVELOPE);
    releaseFirst();
    expectEnvelope(await patch(world, { archived: true }), 409, SESSION_BUSY_ENVELOPE);
    expect(rowOf(fixture.db, session)).toEqual(before);
    releaseSecond();

    const archived = await archiveNow(world, { archived: true });
    expect(rowOf(fixture.db, session)).toEqual({ ...before, archived_at: archived.archivedAt });
  });
});

describe("PATCH archived: authorization (鉴权)", REAL, () => {
  it("C1 anonymous is 401; foreign and unknown ids are identical 404s, nothing written", async () => {
    const world = await openDoneWorld();
    const other = await cookieFor(world.fixture.app, "zhaoliu");
    const before = rowOf(world.fixture.db, world.session);
    const envelope = JSON.stringify(NOT_FOUND_ENVELOPE);
    const notFound = {
      status: 404,
      cacheControl: "no-store",
      contentType: "application/json; charset=utf-8",
      contentLength: String(Buffer.byteLength(envelope, "utf8")),
      body: envelope,
    };
    const shape = (response: LightMyRequestResponse) => ({
      status: response.statusCode,
      cacheControl: response.headers["cache-control"],
      contentType: response.headers["content-type"],
      contentLength: response.headers["content-length"],
      body: response.payload,
    });

    // A valid body and a mistyped one: both are answered before the body is looked at.
    for (const body of [{ archived: true }, { archived: "yes" }]) {
      expectEnvelope(await patch(world, body, { cookie: null }), 401, UNAUTHORIZED_ENVELOPE);
      expect(shape(await patch(world, body, { cookie: other }))).toEqual(notFound);
      expect(shape(await patch(world, body, { session: UNKNOWN_SESSION_ID }))).toEqual(notFound);
    }
    expect(rowOf(world.fixture.db, world.session)).toEqual(before);
  });
});

describe("PATCH archived with other keys (归档键与其它键一起修改)", REAL, () => {
  it("D1 {title, pinned:false, archived:true} on a done session is one 200 write", async () => {
    const world = await openDoneWorld();
    const { fixture, cookie, session } = world;
    // Pinned first, so pinned:false has something to clear.
    const base = await patched(patch(world, { pinned: true }));
    expect(base.pinnedAt).toEqual(expect.any(Number));
    const rowBefore = rowOf(fixture.db, session);
    const auditBefore = await auditEvents(fixture.app, cookie);
    const noted = vi.spyOn(fixture.store, "noteTitleWrite");

    const view = await archiveNow(world, { title: "旧项目", pinned: false, archived: true });

    expect(view).toEqual({ ...base, title: "旧项目", pinnedAt: null, archivedAt: view.archivedAt });
    expect(view).toMatchObject({ status: "done", updatedAt: base.updatedAt });
    expect(rowOf(fixture.db, session)).toEqual({
      ...rowBefore,
      title: "旧项目",
      pinned_at: null,
      archived_at: view.archivedAt,
    });
    expect(noted.mock.calls).toEqual([[session]]);
    expect(await auditEvents(fixture.app, cookie)).toEqual(auditBefore);
  });
});

describe("PATCH archived body validation (非法 body 与鉴权)", REAL, () => {
  it("E1 a non-boolean archived, or archived beside an illegal key, is a 400 with no write", async () => {
    const world = await openDoneWorld();
    const before = rowOf(world.fixture.db, world.session);
    const shapes: unknown[] = [
      { archived: "yes" },
      { archived: null },
      { archived: "true" },
      { archived: 1 },
      { archived: 0 },
      { archived: {} },
      { archived: [true] },
      { archived: true, extra: 1 },
      { archived: true, workspaceId: null },
      { archived: true, title: "" },
      { archived: false, pinned: "no" },
      { title: "ok", archived: "yes" },
    ];

    for (const shape of shapes) {
      expectEnvelope(await patch(world, shape), 400, BAD_REQUEST_ENVELOPE);
    }
    expectEnvelope(await patch(world, '{"archived": ', { raw: true }), 400, BAD_REQUEST_ENVELOPE);
    expect(rowOf(world.fixture.db, world.session)).toEqual(before);
  });
});

describe("patchSession tri-state (store)", REAL, () => {
  it("F1 view, absent (null) and condition-not-met (busy) are three distinct results", async () => {
    const world = await openDoneWorld();
    const { fixture, session } = world;
    const metadata = createSessionMetadataStore(fixture.db, {
      emit,
      sandboxRoot: world.rt.runtime.sandboxRoot,
      createTemporaryWorkspace: temporaryWorkspacePort(fixture.db, world.rt.runtime.sandboxRoot),
    });
    const done = rowOf(fixture.db, session);

    // Absent for this owner: null, with or without the archive condition.
    expect(metadata.patchSession("u2", session, { archived: true })).toBeNull();
    expect(metadata.patchSession(OWNER_ID, UNKNOWN_SESSION_ID, { archived: true })).toBeNull();
    expect(rowOf(fixture.db, session)).toEqual(done);

    // Present but running: busy, and none of the keys is written.
    fixture.db.prepare("UPDATE chat_sessions SET status = 'running' WHERE id = ?").run(session);
    const running = rowOf(fixture.db, session);
    expect(metadata.patchSession(OWNER_ID, session, { title: "x", archived: true })).toBe("busy");
    expect(rowOf(fixture.db, session)).toEqual(running);
    // The condition rides only on archived:true.
    expect(metadata.patchSession(OWNER_ID, session, { title: "y" })).toMatchObject({
      title: "y",
      status: "running",
      archivedAt: null,
    });
    expect(metadata.patchSession(OWNER_ID, session, { archived: false })).toMatchObject({
      archivedAt: null,
    });

    for (const status of ["idle", "done", "failed", "stopped"]) {
      fixture.db.prepare("UPDATE chat_sessions SET status = ? WHERE id = ?").run(status, session);
      fixture.db.prepare("UPDATE chat_sessions SET archived_at = NULL WHERE id = ?").run(session);
      const view = metadata.patchSession(OWNER_ID, session, { archived: true });
      expect(view, status).toMatchObject({ status, archivedAt: expect.any(Number) });
    }

    fixture.db.prepare("DELETE FROM chat_sessions WHERE id = ?").run(session);
    expect(metadata.patchSession(OWNER_ID, session, { archived: true })).toBeNull();
  });
});
