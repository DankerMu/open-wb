/**
 * Issue #952 undo with `files:"restore"|"force"` (s1f-session-list-temp-space tasks 12.1, 12.2) on
 * the production createApp → registerSessions assembly: scripted FakeChild processes, the snapshot
 * service createApp builds (real `take` and `restore`), real directories. Undo is only ever
 * requested over REST. Oracles are the response, SQLite rows, the files under the workspace root
 * and the spawn record.
 *
 * Specs: message-undo「文件还原与结果」「共用空间冲突」「撤回审计与通知」(审计形状),「撤回 REST」
 * steps 6–7.
 *
 * Each scenario's comment lists its spawns in order: the scripted runtime hands script n to the
 * n-th child. Only `Date` is faked; the moments are offsets from the world's opening (`at`).
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settle } from "./session-approval-helpers.js";
import { expectEnvelope, postSessionAction } from "./session-bodyless-rest-helpers.js";
import { INTERNAL_ERROR_ENVELOPE } from "./session-db-helpers.js";
import { FIRST, forkWorlds, messagesOf } from "./session-fork-helpers.js";
import { held, QUESTION, scriptedAt } from "./session-regenerate-helpers.js";
import { cookieFor, SESSION_BUSY_ENVELOPE } from "./session-rest-helpers.js";
import { seedMessage, sessionId } from "./session-store-helpers.js";
import { completeHeldTurn, OWNER_ID, waitForTurn } from "./session-supervisor-helpers.js";
import {
  acceptedAt,
  at,
  clockOf,
  contents,
  entries,
  type FilesWorld,
  forkedAt,
  moment,
  openFilesWorld,
  put,
  registeredAt,
  restoredBy,
  seedShared,
  turnAt,
  undoWith,
} from "./session-undo-files-helpers.js";
import { historyOf, observed, THIRD, undone } from "./session-undo-helpers.js";

const UNDO_CONFLICT_ENVELOPE = {
  error: { code: "undo_conflict", message: "其它会话在这之后改动过工作空间" },
} as const;
const NOTHING_LEFT = { count: 0, paths: [] };
const REWRITTEN = "rewritten by the second turn";

const worlds = forkWorlds();
beforeEach(() => {
  // `Date` alone: the bare form would also freeze the timers the scripted runtime runs on.
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Rows, counts, spawns, directory entries, file contents and live processes, for "no change". */
function everything(world: FilesWorld) {
  return {
    rows: observed(world),
    files: contents(world),
    live: world.fixture.supervisor.liveProcessCount(),
    frames: world.scripted.map((child) => child.frames.length),
  };
}

/**
 * `a.txt` is there before anything; u1; u2, whose turn rewrote `a.txt` and made `out/b.html`.
 * `before` is the workspace as u2 was sent.
 */
async function editedInSecondTurn(world: FilesWorld) {
  put(world, "a.txt", "before");
  const u1 = await turnAt(world, 10, FIRST);
  const before = contents(world);
  const u2 = await turnAt(world, 20, QUESTION);
  put(world, "a.txt", REWRITTEN);
  put(world, "out/b.html", "<p>made by the second turn</p>");
  return { u1, u2, before };
}

/** The same two turns, then a fork of the session at u2 (it holds the copied u1 and a1). */
async function forkedAfterSecondTurn(world: FilesWorld) {
  const turns = await editedInSecondTurn(world);
  return { ...turns, fork: await forkedAt(world, 30, turns.u2) };
}

async function messageIds(world: FilesWorld): Promise<number[]> {
  return (await historyOf(world)).messages.map((message) => message.id);
}

describe("undo restoring the workspace (message-undo「文件还原与结果」)", () => {
  // Spawns: 0 the session's process, 1 the undo's temporary process.
  it("连文件一起还原: the rewritten file is written back, the new directory removed, u1 and a1 left", async () => {
    const world = await openFilesWorld(worlds);
    const { u1, u2, before } = await editedInSecondTurn(world);
    at(30);

    const body = restoredBy(await undoWith(world, u2, "restore"));

    expect(body.files).toEqual({
      mode: "restored",
      restored: 1,
      removed: 1,
      skipped: NOTHING_LEFT,
      failed: NOTHING_LEFT,
    });
    expect(contents(world)).toEqual(before);
    expect(before).toEqual({ "a.txt": "before" });
    expect(existsSync(join(world.root, "out/b.html"))).toBe(false);
    expect(body.draft).toBe(QUESTION);
    expect(await messageIds(world)).toEqual([u1, u1 + 1]);
    expect([world.rt.calls.length, held(world)]).toEqual([2, false]);
  });

  it("只撤回对话: keep answers the kept files and leaves both files as the turn left them", async () => {
    const world = await openFilesWorld(worlds);
    const { u1, u2 } = await editedInSecondTurn(world);
    const after = contents(world);
    at(30);

    undone(await undoWith(world, u2, "keep"));

    expect(contents(world)).toEqual(after);
    expect(after).toMatchObject({ "a.txt": REWRITTEN, "out/b.html": expect.any(String) });
    expect(await messageIds(world)).toEqual([u1, u1 + 1]);
  });

  // Spawns: 0 the session's process, 1 the undo's temporary process (three entries).
  it("一次退回多轮: undoing u1 takes all three turns' changes back; draft is the stored content", async () => {
    const world = await openFilesWorld(worlds, [{}, { messages: entries(3) }]);
    put(world, "a.txt", "one");
    const before = contents(world);
    const u1 = await turnAt(world, 10, FIRST);
    put(world, "a.txt", "one, then the first turn");
    await turnAt(world, 20, QUESTION);
    put(world, "b/c.txt", "made by the second turn");
    await turnAt(world, 30, THIRD);
    put(world, "d.txt", "made by the third turn");
    at(40);

    const body = restoredBy(await undoWith(world, u1, "restore"));

    expect(contents(world)).toEqual(before);
    expect(body.files).toMatchObject({ restored: 1, removed: 2 });
    expect(await messageIds(world)).toEqual([]);
    // The scripted `branch` reply always carries QUESTION: the draft is not read from it.
    expect([body.draft, body.session.status]).toEqual([FIRST, "idle"]);
  });

  it("超限文件不还原并列出: the file over the limit keeps its changed content and is listed", async () => {
    const world = await openFilesWorld(worlds, [{}], { snapshotMaxFileBytes: 16 });
    put(world, "a.txt", "small");
    put(world, "big.bin", "x".repeat(32));
    await turnAt(world, 10, FIRST);
    const u2 = await turnAt(world, 20, QUESTION);
    put(world, "a.txt", "changed");
    put(world, "big.bin", "y".repeat(40));
    at(30);

    const body = restoredBy(await undoWith(world, u2, "restore"));

    expect(body.files).toEqual({
      mode: "restored",
      restored: 1,
      removed: 0,
      skipped: { count: 1, paths: [{ path: "big.bin", reason: "too_large" }] },
      failed: NOTHING_LEFT,
    });
    expect(contents(world)).toEqual({ "a.txt": "small", "big.bin": "y".repeat(40) });
  });

  it("the lists are cut to their first 200 with the total: 201 skipped files", async () => {
    const world = await openFilesWorld(worlds, [{}], { snapshotMaxFileBytes: 4 });
    put(world, "a.txt", "1");
    for (let n = 0; n < 201; n += 1) {
      put(world, `big/f${String(n).padStart(3, "0")}.bin`, "12345678");
    }
    const u1 = await turnAt(world, 10, FIRST);
    put(world, "a.txt", "22");
    at(20);

    const { files } = restoredBy(await undoWith(world, u1, "restore"));

    expect([files.restored, files.skipped.count]).toEqual([1, 201]);
    expect(files.skipped.paths).toHaveLength(200);
    expect(new Set(files.skipped.paths.map((item) => item.path)).size).toBe(200);
    for (const item of files.skipped.paths) {
      expect(item).toEqual({
        path: expect.stringMatching(/^big\/f\d{3}\.bin$/u),
        reason: "too_large",
      });
    }
    expect(contents(world)["a.txt"]).toBe("1");
  });

  it("版本库连同提交一起还原: the ref, the object store and the source file go back together", async () => {
    const world = await openFilesWorld(worlds);
    // Stand-ins for two commit hashes, of different lengths like every rewritten file here.
    put(world, ".git/refs/heads/main", `${"a".repeat(40)}\n`);
    put(world, ".git/objects/aa/one", "object of commit a");
    put(world, "src/app.ts", "export const version = 1;\n");
    await turnAt(world, 10, FIRST);
    const before = contents(world);
    const u2 = await turnAt(world, 20, QUESTION);
    put(world, "src/app.ts", "export const version = 2; // the second turn\n");
    put(world, ".git/refs/heads/main", "b".repeat(40));
    put(world, ".git/objects/bb/two", "object of commit b");
    at(30);

    const body = restoredBy(await undoWith(world, u2, "restore"));

    expect(contents(world)).toEqual(before);
    expect(before[".git/refs/heads/main"]).toBe(`${"a".repeat(40)}\n`);
    expect(existsSync(join(world.root, ".git/objects/bb"))).toBe(false);
    expect(body.files).toMatchObject({ restored: 2, removed: 1, skipped: NOTHING_LEFT });
  });

  // Spawns: 0 the session's process, 1 and 2 the temporary processes of the two undos.
  it("还原的结构性失败: a snapshot moved away is the generic 5xx with nothing changed; keep then works", async () => {
    const world = await openFilesWorld(worlds);
    const { u1, u2 } = await editedInSecondTurn(world);
    renameSync(join(world.snapshots, String(u2)), join(world.rt.runtime.stateDir, "moved-away"));
    at(30);
    const before = everything(world);

    expectEnvelope(await undoWith(world, u2, "restore"), 500, INTERNAL_ERROR_ENVELOPE);

    // Nothing was committed: the four message rows are there.
    expect(messagesOf(world.fixture.db, world.session)).toHaveLength(4);
    // Only the temporary process was spawned (and has exited); the session's own was retired.
    expect(everything(world)).toEqual({
      ...before,
      rows: { ...before.rows, spawns: before.rows.spawns + 1 },
      live: 0,
      frames: [...before.frames, expect.any(Number)],
    });
    expect(held(world)).toBe(false);

    undone(await undoWith(world, u2, "keep"));
    expect(await messageIds(world)).toEqual([u1, u1 + 1]);
    expect(contents(world)).toEqual(before.files);
  });

  // Spawns: 0 the session's process, 1 the undo's temporary process (three entries).
  it("审计形状: session.undo carries force and the removed count; not in another member's list", async () => {
    const world = await openFilesWorld(worlds, [{}, { messages: entries(3) }]);
    const { app } = world.fixture;
    const { u2 } = await editedInSecondTurn(world);
    await turnAt(world, 30, THIRD);
    at(40);

    restoredBy(await undoWith(world, u2, "force"));

    const listed = async (cookie: string, limit: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/audit${limit}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      return (response.json() as { events: Array<{ kind: string }> }).events;
    };
    expect(await listed(world.cookie, "?limit=1")).toEqual([
      expect.objectContaining({
        kind: "session.undo",
        actorId: OWNER_ID,
        title: "撤回消息",
        workspaceId: world.workspaceId,
        detail: { sessionId: world.session, messageId: u2, removedMessages: 4, files: "force" },
      }),
    ]);
    const others = await listed(await cookieFor(app, "zhaoliu"), "");
    expect(others.filter((event) => event.kind === "session.undo")).toEqual([]);
  });
});

describe("undo in a workspace other sessions share (message-undo「共用空间冲突」)", () => {
  /** S's u2 at 20, the fork at 30, then a whole turn of the fork at 40 that wrote `f.txt`. */
  async function forkActiveAfter(world: FilesWorld) {
    const { db } = world.fixture;
    const seeded = await forkedAfterSecondTurn(world);
    await turnAt(world, 40, "a turn of the fork", seeded.fork);
    put(world, "f.txt", "written by the fork's turn");
    expect(messagesOf(db, world.session)[2]?.created_at).toBe(moment(20));
    expect(registeredAt(db, seeded.fork)).toEqual([moment(40)]);
    expect(clockOf(db, seeded.fork)).toEqual({
      status: "done",
      createdAt: moment(30),
      updatedAt: moment(40),
    });
    at(50);
    return seeded;
  }

  /**
   * S's u1 at 2, an empty fork B of it at 4, B's turn accepted at 10 and held by child 2: the
   * session REST can put beside S in one workspace is a fork.
   */
  async function besideHeldFork(world: FilesWorld) {
    const b = await forkedAt(world, 4, await turnAt(world, 2, FIRST));
    await acceptedAt(world, 10, "accepted before the other session's message", b);
    return { b, child: scriptedAt(world.scripted, 2).child };
  }

  /** `restore` is refused as a conflict and nothing at all changed. */
  async function expectConflict(world: FilesWorld, messageId: number): Promise<void> {
    const before = everything(world);
    expectEnvelope(await undoWith(world, messageId, "restore"), 409, UNDO_CONFLICT_ENVELOPE);
    expect(everything(world)).toEqual(before);
    expect(held(world)).toBe(false);
  }

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 F's process, 3 the undo's.
  it("别的会话在那之后有过回合: restore is 409 undo_conflict with nothing changed; keep is then 200", async () => {
    const world = await openFilesWorld(worlds);
    const { u1, u2 } = await forkActiveAfter(world);
    const files = contents(world);

    await expectConflict(world, u2);
    expect(world.rt.calls).toHaveLength(3);

    undone(await undoWith(world, u2, "keep"));
    expect(await messageIds(world)).toEqual([u1, u1 + 1]);
    expect(contents(world)).toEqual(files);
  });

  it("别的会话在那之后有过回合: 以 force 重发 200, the workspace is back to before u2 and F's file is gone", async () => {
    const world = await openFilesWorld(worlds);
    const { u1, u2, before } = await forkActiveAfter(world);

    const body = restoredBy(await undoWith(world, u2, "force"));

    expect(body.files).toMatchObject({ restored: 1, removed: 2, failed: NOTHING_LEFT });
    expect(contents(world)).toEqual(before);
    expect(await messageIds(world)).toEqual([u1, u1 + 1]);
  });

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 B's process (its turn held), 3 S's
  // next process.
  it("重叠回合: a turn accepted before u2 and settled after it is a conflict", async () => {
    const world = await openFilesWorld(worlds, [{}, {}, { prompt: "hold" }, {}]);
    const { db } = world.fixture;
    const { b, child } = await besideHeldFork(world);
    const u2 = await turnAt(world, 20, QUESTION);
    at(30);
    put(world, "late.txt", "written late by the other session");
    completeHeldTurn(child);
    await waitForTurn(world.fixture, b, "done");
    await settle();
    expect(messagesOf(db, b).map((message) => message.created_at)).toEqual([
      moment(10),
      moment(10),
    ]);
    expect(registeredAt(db, b)).toEqual([moment(10)]);
    expect(clockOf(db, b)).toEqual({ status: "done", createdAt: moment(4), updatedAt: moment(30) });
    expect(messagesOf(db, world.session)[2]?.created_at).toBe(moment(20));
    at(40);

    await expectConflict(world, u2);

    expect(contents(world)["late.txt"]).toBe("written late by the other session");
  });

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 the undo's.
  it("仅有 fork 拷贝行的会话不算: a fork that never ran a turn is no conflict", async () => {
    const world = await openFilesWorld(worlds);
    const { db } = world.fixture;
    const { u1, fork } = await forkedAfterSecondTurn(world);
    expect(messagesOf(db, fork).map((message) => message.created_at)).toEqual([
      moment(10),
      moment(10),
    ]);
    expect(registeredAt(db, fork)).toEqual([]);
    expect(clockOf(db, fork)).toEqual({
      status: "done",
      createdAt: moment(30),
      updatedAt: moment(30),
    });
    at(40);

    restoredBy(await undoWith(world, u1, "restore"));

    expect(await messageIds(world)).toEqual([]);
    expect(contents(world)).toEqual({ "a.txt": "before" });
  });

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 S's next process, 3 F's process
  // (its list ends with the copied u1, the entry regenerate compares). Script 4 is what an undo
  // let through would run on: it would find its entry and answer 200.
  it("分叉会话只重新生成过拷贝来的末轮: no registration of its own, yet a conflict", async () => {
    const world = await openFilesWorld(worlds, [
      {},
      {},
      {},
      { messages: entries(1) },
      { messages: entries(3) },
    ]);
    const { db, app } = world.fixture;
    const { fork } = await forkedAfterSecondTurn(world);
    const u3 = await turnAt(world, 40, THIRD);
    at(50);
    const regenerated = await postSessionAction(app, "regenerate", fork, world.cookie);
    expect(regenerated.statusCode).toBe(202);
    await waitForTurn(world.fixture, fork, "done");
    await settle();
    put(world, "regen.txt", "written by the regenerated turn");
    expect(registeredAt(db, fork)).toEqual([]);
    expect(clockOf(db, fork)).toEqual({
      status: "done",
      createdAt: moment(30),
      updatedAt: moment(50),
    });
    expect(messagesOf(db, world.session)[4]?.created_at).toBe(moment(40));
    at(60);

    await expectConflict(world, u3);

    expect(contents(world)["regen.txt"]).toBe("written by the regenerated turn");
    expect(world.rt.calls).toHaveLength(4);
  });

  // Spawns: 0 S's process. B's rows are written directly: no process ever ran its turn.
  it("被启动对账置为失败的回合: failed by reconciliation, updated_at still the acceptance, is a conflict", async () => {
    const world = await openFilesWorld(worlds);
    const { db, store } = world.fixture;
    const b = seedShared(world, {
      id: sessionId("b"),
      ownerId: OWNER_ID,
      status: "running",
      createdAt: 5,
      updatedAt: 10,
    });
    for (const role of ["user", "assistant"] as const) {
      const status = role === "user" ? "done" : "running";
      seedMessage(db, { sessionId: b, role, content: "", status, createdAt: moment(10) });
    }
    const u2 = await turnAt(world, 20, FIRST);
    at(25);
    store.reconcileOnStartup();
    expect(messagesOf(db, b).map((message) => message.status)).toEqual(["done", "failed"]);
    expect(registeredAt(db, b)).toEqual([]);
    expect(clockOf(db, b)).toEqual({
      status: "failed",
      createdAt: moment(5),
      updatedAt: moment(10),
    });
    at(30);

    await expectConflict(world, u2);
  });

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 B's process (exits in its turn),
  // 3 S's next process, 4 the undo's.
  it("被启动对账置为失败的回合: a turn that failed through settlement before u2 is no conflict", async () => {
    const world = await openFilesWorld(worlds, [{}, {}, { prompt: "hold" }, {}]);
    const { db } = world.fixture;
    const { b, child } = await besideHeldFork(world);
    at(15);
    child.endStdout();
    child.exit(1);
    await waitForTurn(world.fixture, b, "failed");
    await settle();
    const u2 = await turnAt(world, 20, QUESTION);
    put(world, "a.txt", REWRITTEN);
    expect(messagesOf(db, b).map((message) => message.created_at)).toEqual([
      moment(10),
      moment(10),
    ]);
    expect(clockOf(db, b)).toEqual({
      status: "failed",
      createdAt: moment(4),
      updatedAt: moment(15),
    });
    at(30);

    restoredBy(await undoWith(world, u2, "restore"));

    expect(contents(world)).toEqual({});
  });

  // Spawns: 0 S's process, 1 the fork's temporary process (of an empty fork), 2 F's process,
  // 3 S's next process, 4 the undo's.
  it("别的会话只在那之前活动过: every turn of the fork settled before u2 was sent", async () => {
    const world = await openFilesWorld(worlds);
    const { db } = world.fixture;
    const u1 = await turnAt(world, 10, FIRST);
    const fork = await forkedAt(world, 20, u1);
    await turnAt(world, 30, "a turn of the fork", fork);
    put(world, "f.txt", "written by the fork's turn");
    const u2 = await turnAt(world, 40, QUESTION);
    put(world, "a.txt", REWRITTEN);
    expect(registeredAt(db, fork)).toEqual([moment(30)]);
    expect(clockOf(db, fork)).toEqual({
      status: "done",
      createdAt: moment(20),
      updatedAt: moment(30),
    });
    expect(messagesOf(db, world.session)[2]?.created_at).toBe(moment(40));
    at(50);

    const body = restoredBy(await undoWith(world, u2, "restore"));

    expect(body.files).toMatchObject({ restored: 0, removed: 1 });
    expect(contents(world)).toEqual({ "f.txt": "written by the fork's turn" });
  });

  // Spawns: 0 S's process, 1 the fork's temporary process, 2 S's next process (alive), 3 F's
  // process (its turn held), 4 the undo's (three entries).
  it("别的会话正在运行: restore and force are 409 session_busy before anything is done; keep is 200", async () => {
    const world = await openFilesWorld(worlds, [
      {},
      {},
      {},
      { prompt: "hold" },
      { messages: entries(3) },
    ]);
    const { db, supervisor } = world.fixture;
    const { fork } = await forkedAfterSecondTurn(world);
    const u3 = await turnAt(world, 40, THIRD);
    put(world, "s3.txt", "written by the third turn");
    // Accepted after the message being undone: without step 6, `restore` would be a conflict.
    await acceptedAt(world, 50, "the fork is running", fork);
    expect(clockOf(db, fork).status).toBe("running");
    expect(registeredAt(db, fork)).toEqual([moment(50)]);
    at(60);
    const before = everything(world);
    expect([before.live, before.rows.spawns]).toEqual([2, 4]);

    for (const files of ["restore", "force"] as const) {
      expectEnvelope(await undoWith(world, u3, files), 409, SESSION_BUSY_ENVELOPE);
      expect([files, everything(world)]).toEqual([files, before]);
      expect(held(world)).toBe(false);
    }

    undone(await undoWith(world, u3, "keep"));
    expect(contents(world)).toEqual(before.files);
    expect(supervisor.liveProcessCount()).toBe(1);
    completeHeldTurn(scriptedAt(world.scripted, 3).child);
    await waitForTurn(world.fixture, fork, "done");
    await settle();
  });

  // Spawns: 0 S's process, 1 the undo's.
  it("他人的会话不参与判定: another account's session on the same workspace id is not looked at", async () => {
    const world = await openFilesWorld(worlds);
    const { db } = world.fixture;
    const { u2, before } = await editedInSecondTurn(world);
    const theirs = seedShared(world, {
      id: sessionId("d"),
      ownerId: "u2",
      status: "done",
      createdAt: 25,
      updatedAt: 30,
    });
    expect(clockOf(db, theirs)).toEqual({
      status: "done",
      createdAt: moment(25),
      updatedAt: moment(30),
    });
    expect(messagesOf(db, world.session)[2]?.created_at).toBe(moment(20));
    at(40);

    restoredBy(await undoWith(world, u2, "restore"));

    expect(contents(world)).toEqual(before);
  });
});
