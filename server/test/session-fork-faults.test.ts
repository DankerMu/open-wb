/**
 * Issue #466 fork faults and windows over scripted FakeChild processes (production createApp
 * assembly, real SQLite; two seeded turns, fork at u2): an exit in the post-branch get_state
 * reply's segment (F1), the commit-time CAS recheck (F2), the temporary shutdown gap (F3), a fault
 * mid-transaction (F4), a still-running copied assistant (F5), shutdown during the temporary
 * shutdown (F6), the cap (F7, F8), shutdown of an in-flight temporary process (F9), no lazy
 * re-spawn after an exit (F10), shutdown while admission waits on an eviction (F11), a branch that
 * reports the source's own file (F12) and a scripted pid-less child that handshakes, then closes
 * mid-command (F13; no real spawn does this: the runtime binds no native exit to a pid-less child,
 * so only the fork's own revoke clears its token). Oracles: SQL rows, recorded stdin frames,
 * spawn count, pool envelopes, tokens and the public supervisor surface.
 */
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { settle } from "./session-approval-helpers.js";
import {
  approvalsOf,
  baseline,
  expectForkDone,
  expectForkRejected,
  expectSourceClaimed,
  forkAt,
  forkWorlds,
  insertApproval,
  messagesOf,
  openForkScripted,
  rowCounts,
  seedTwoTurns,
  shutdownStarted,
  stepsOf,
  subscribeQuietly,
  turn,
} from "./session-fork-helpers.js";
import {
  held,
  promptsAgain,
  QUESTION,
  rejectedCode,
  scriptedAt,
  sendPrompt,
  sessionFile,
  snapshot,
  types,
} from "./session-regenerate-helpers.js";
import {
  completeHeldTurn,
  createSession,
  expectSettled,
  requiredCall,
  requiredToken,
  resumePath,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { expectCapacity, isLive } from "./session-supervisor-pool-helpers.js";
import type { FakeChild } from "./support/omp-rpc.js";

const worlds = forkWorlds();

type Scripted = Awaited<ReturnType<typeof openForkScripted>>;

/** The temporary child (child 0) once its stdin was closed by the fork's own shutdown. */
function tempClosing(world: Scripted) {
  return waitFor(() => {
    const child = world.scripted[0]?.child;
    return child?.stdin.writableEnded === true ? child : undefined;
  }, "temporary stdin EOF");
}

function heldBranch(world: Scripted) {
  return waitFor(
    () => (world.scripted[0]?.release === undefined ? undefined : world.scripted[0]),
    "held branch",
  );
}

/** Outermost spawnImpl wrapper: `configure` runs on each scripted child right after its script. */
function afterScript(world: Scripted, configure: (child: FakeChild) => void): void {
  const inner = world.rt.runtime.spawnImpl;
  world.rt.runtime.spawnImpl = (command, args, options) => {
    const spawned = inner(command, args, options);
    configure(scriptedAt(world.scripted, world.scripted.length - 1).child);
    return spawned;
  };
}

/** The session's turn ended `done`, then a few macrotasks for its pump to release. */
async function turnEnded(world: Scripted, session: string): Promise<void> {
  await waitForTurn(world.fixture, session, "done");
  await settle();
}

/** Row counts read right before the store's database really closes. */
function countsAtClose(db: DatabaseSync): { value: ReturnType<typeof rowCounts> | undefined } {
  const seen: { value: ReturnType<typeof rowCounts> | undefined } = { value: undefined };
  const realClose = db.close.bind(db);
  db.close = () => {
    seen.value = rowCounts(db);
    realClose();
  };
  return seen;
}

describe("fork faults over scripted FakeChild processes (#466)", () => {
  const exits = [
    [
      "F1 an exit in the post-branch get_state reply's segment fails the liveness guard",
      {
        exitAfterState: true,
      },
    ],
    [
      "F10 an exit after the branch reply never re-spawns outside the pool",
      {
        exitAfterBranch: true,
      },
    ],
  ] as const;
  for (const [name, script] of exits) {
    it(`${name}: agent_unavailable, one spawn`, async () => {
      const world = await openForkScripted(worlds, [script]);
      const { db, supervisor } = world.fixture;
      const seeded = seedTwoTurns(world);
      const { before, rows } = baseline(world);

      await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rows);

      expect(world.rt.calls).toHaveLength(1);
      expect(types(scriptedAt(world.scripted, 0).frames)).toContain("branch");
      expect(supervisor.liveProcessCount()).toBe(0);
      expect(snapshot(db, world.session, true)).toEqual(before);
      seeded.unchanged();
      const token = requiredToken(requiredCall(world.rt.calls, 0).token);
      expect(world.fixture.tokens.lookup(token)).toBeNull();
    });
  }

  /** Each rewrite of the source between get_state and the commit returns its own undo. */
  const rewrites: Record<string, (db: DatabaseSync, session: string) => () => void> = {
    "its status rewritten to running": (db, session) => {
      const status = (value: string) =>
        db.prepare("UPDATE chat_sessions SET status = ? WHERE id = ?").run(value, session);
      status("running");
      return () => status("done");
    },
    "a later assistant appended": (db, session) => {
      const { lastInsertRowid } = db
        .prepare(
          "INSERT INTO chat_messages(session_id, role, content, status, created_at) SELECT id, 'assistant', 'later answer', 'done', updated_at + 60000 FROM chat_sessions WHERE id = ?",
        )
        .run(session);
      return () => db.prepare("DELETE FROM chat_messages WHERE id = ?").run(lastInsertRowid);
    },
  };
  for (const [name, rewrite] of Object.entries(rewrites)) {
    it(`F2 the commit-time CAS recheck fails with ${name}: session_busy`, async () => {
      const world = await openForkScripted(worlds, [{ keepStdout: true }, {}]);
      const { db } = world.fixture;
      const seeded = seedTwoTurns(world);
      const rows = rowCounts(db);
      const work = forkAt(world, seeded.u2);
      const temp = await tempClosing(world);
      const undo = rewrite(db, world.session);
      const rewritten = snapshot(db, world.session, true);
      const rewrittenRows = rowCounts(db);
      temp.endStdout();
      temp.exit(0);

      expect(await rejectedCode(work)).toBe("session_busy");

      expect(rewrittenRows.sessions).toBe(rows.sessions);
      expect(rowCounts(db)).toEqual(rewrittenRows);
      expect(snapshot(db, world.session, true)).toEqual(rewritten);
      seeded.unchanged();
      expect(isLive(temp)).toBe(false);
      expect(held(world)).toBe(false);
      undo();
      await promptsAgain(world, "after recheck", seeded.file, 1);
    });
  }

  it("F3 the source stays claimed until the temporary shutdown completes", async () => {
    const world = await openForkScripted(worlds, [{ keepStdout: true }, {}]);
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);
    const before = snapshot(db, world.session, true);
    const rows = rowCounts(db);
    const work = forkAt(world, seeded.u2);
    const temp = await tempClosing(world);
    const spawns = world.rt.calls.length;

    await expectSourceClaimed(world, seeded.u2);
    await settle();

    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(rowCounts(db)).toEqual(rows);
    expect(world.rt.calls).toHaveLength(spawns);
    temp.endStdout();
    temp.exit(0);
    await expectForkDone(world, work, rows.sessions);
  });

  it("F4 a fault mid-transaction rolls every copied row back", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);
    db.prepare(
      "INSERT INTO chat_steps(message_id, ordinal, name, detail, status, started_at, ended_at, output) VALUES (?, 0, 'bash', '{\"command\":\"ls\"}', 'done', 10, 20, 'ok')",
    ).run(seeded.a1);
    insertApproval(db, seeded.a1, "f4-1", "allow", 30);
    insertApproval(db, seeded.a1, "f4-2", "deny", 40);
    db.exec(
      "CREATE TRIGGER f4 BEFORE INSERT ON chat_approvals BEGIN SELECT RAISE(ABORT, 'f4'); END",
    );
    const { before, rows } = baseline(world);

    await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rows);

    expect(snapshot(db, world.session, true)).toEqual(before);
    db.exec("DROP TRIGGER f4");
    const result = await forkAt(world, seeded.u2);
    const copied = messagesOf(db, result.session.id);
    expect(copied.map((m) => m.role)).toEqual(["user", "assistant"]);
    const copy = copied[1]?.id ?? -1;
    expect(stepsOf(db, copy)).toEqual(stepsOf(db, seeded.a1));
    expect(stepsOf(db, copy)).toHaveLength(1);
    expect(approvalsOf(db, copy)).toEqual(approvalsOf(db, seeded.a1));
    expect(approvalsOf(db, copy)).toHaveLength(2);
  });

  it("F5 a still-running copied assistant fails the transaction", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db } = world.fixture;
    const seeded = seedTwoTurns(world);
    db.prepare("UPDATE chat_messages SET status = 'running' WHERE id = ?").run(seeded.a1);

    await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rowCounts(db));
  });

  it("F6 a shutdown during the temporary shutdown writes nothing", async () => {
    const world = await openForkScripted(worlds, [{ keepStdout: true }]);
    const { db, supervisor } = world.fixture;
    const seeded = seedTwoTurns(world);
    const rows = rowCounts(db);
    const atClose = countsAtClose(db);
    const work = forkAt(world, seeded.u2);
    const temp = await tempClosing(world);
    subscribeQuietly(world);

    const closing = worlds.closing(world);
    await shutdownStarted(world, world.session);
    temp.endStdout();
    temp.exit(0);

    expect(await rejectedCode(work)).toBe("agent_unavailable");
    await expect(closing).resolves.toBeUndefined();
    expect(atClose.value).toEqual(rows);
    expect(supervisor.liveProcessCount()).toBe(0);
  });

  it("F7 the temporary process counts against the cap", async () => {
    const world = await openForkScripted(worlds, [{ hold: "branch" }, {}], 1);
    const { app, db, supervisor } = world.fixture;
    const other = await createSession(app, world.cookie);
    const seeded = seedTwoTurns(world);
    const work = forkAt(world, seeded.u2);
    const temp = await heldBranch(world);

    expectCapacity(await sendPrompt(world, "b", other));

    expect(temp.child.stdin.writableEnded).toBe(false);
    expect(temp.child.signalCode).toBeNull();
    temp.release?.();
    const result = await work;
    expect(supervisor.liveProcessCount()).toBe(0);
    expect((await sendPrompt(world, "b again", other)).statusCode).toBe(202);
    expect(world.rt.calls).toHaveLength(2);
    await turnEnded(world, other);
    const file = sessionFile(db, result.session.id);
    expect(file).toMatch(/branch-.*\.jsonl$/u);
    expect((await sendPrompt(world, "on the fork", result.session.id)).statusCode).toBe(202);
    expect(resumePath(requiredCall(world.rt.calls, 2).args)).toBe(file);
    await waitForTurn(world.fixture, result.session.id, "done");
  });

  it("F8 a full pool is agent_capacity with no row and the claim released", async () => {
    const world = await openForkScripted(worlds, [{ prompt: "hold" }, {}], 1);
    const { app, db } = world.fixture;
    const other = await createSession(app, world.cookie);
    expect((await sendPrompt(world, "b holds", other)).statusCode).toBe(202);
    const seeded = seedTwoTurns(world);
    const b = scriptedAt(world.scripted, 0).child;

    await expectForkRejected(world, forkAt(world, seeded.u2), "agent_capacity", rowCounts(db));

    expect(world.rt.calls).toHaveLength(1);
    completeHeldTurn(b);
    await turnEnded(world, other);
    expect((await forkAt(world, seeded.u2)).draft).toBe(QUESTION);
    expect([isLive(b), world.rt.calls.length]).toEqual([false, 2]);
  });

  it("F9 shutdown closes an in-flight temporary process", async () => {
    const world = await openForkScripted(worlds, [{ hold: "branch" }]);
    const { db, supervisor } = world.fixture;
    const seeded = seedTwoTurns(world);
    const rows = rowCounts(db);
    const atClose = countsAtClose(db);
    const code = rejectedCode(forkAt(world, seeded.u2));
    const temp = await heldBranch(world);

    const closing = worlds.closing(world);
    try {
      await expectSettled(closing, "shutdown with a held temporary process", "resolved", 2_000);
    } finally {
      temp.release?.();
    }

    expect(await code).toBe("agent_unavailable");
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(isLive(temp.child)).toBe(false);
    expect(atClose.value).toEqual(rows);
  });

  it("F11 a shutdown while admission waits on an eviction spawns nothing", async () => {
    const world = await openForkScripted(worlds, [{ keepStdout: true }, {}], 1);
    const { app, db, supervisor } = world.fixture;
    const other = await createSession(app, world.cookie);
    await turn(world, "b", other);
    const b = scriptedAt(world.scripted, 0).child;
    const seeded = seedTwoTurns(world);
    const rows = rowCounts(db);
    const atClose = countsAtClose(db);
    subscribeQuietly(world);
    const work = forkAt(world, seeded.u2);
    await waitFor(() => (b.stdin.writableEnded ? true : undefined), "eviction stdin EOF");

    const closing = worlds.closing(world);
    await shutdownStarted(world, world.session);
    b.endStdout();
    b.exit(0);

    expect(await rejectedCode(work)).toBe("agent_unavailable");
    expect(world.rt.calls).toHaveLength(1);
    await expect(closing).resolves.toBeUndefined();
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(atClose.value).toEqual(rows);
  });

  it("F12 a branch that reports the source's own file is agent_unavailable", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db, supervisor, tokens } = world.fixture;
    const seeded = seedTwoTurns(world);
    afterScript(world, (child) => {
      child.onCommand("get_state", (frame) => {
        const data = { sessionFile: seeded.file };
        child.emitLine({
          id: frame.id,
          type: "response",
          command: "get_state",
          success: true,
          data,
        });
      });
    });
    const { before, rows } = baseline(world);

    await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rows);

    const sent = types(scriptedAt(world.scripted, 0).frames);
    expect(sent.filter((type) => type === "get_state")).toHaveLength(2);
    expect(sent).toContain("branch");
    expect(snapshot(db, world.session, true)).toEqual(before);
    expect(sessionFile(db, world.session)).toBe(seeded.file);
    seeded.unchanged();
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(world.rt.calls).toHaveLength(1);
    expect(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token))).toBeNull();
  });

  it("F13 a pid-less child closing mid-command: the fork revokes the token", async () => {
    const world = await openForkScripted(worlds, [{}]);
    const { db, supervisor, tokens } = world.fixture;
    const seeded = seedTwoTurns(world);
    const atSpawn: Array<string | null> = [];
    afterScript(world, (child) => {
      if (atSpawn.length > 0) {
        return;
      }
      atSpawn.push(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token)));
      Object.assign(child, { pid: undefined });
      child.onCommand("get_branch_messages", () => {
        child.exit(1);
      });
    });
    const { before, rows } = baseline(world);

    await expectForkRejected(world, forkAt(world, seeded.u2), "agent_unavailable", rows);

    expect(atSpawn).toHaveLength(1);
    expect(atSpawn[0]).toEqual(expect.any(String));
    expect(atSpawn[0]).not.toBe(world.session);
    expect(tokens.lookup(requiredToken(requiredCall(world.rt.calls, 0).token))).toBeNull();
    expect(types(scriptedAt(world.scripted, 0).frames)).toEqual([
      "negotiate_protocol",
      "get_state",
      "get_branch_messages",
    ]);
    expect(supervisor.liveProcessCount()).toBe(0);
    expect(snapshot(db, world.session, true)).toEqual(before);
    seeded.unchanged();
    expect((await forkAt(world, seeded.u2)).draft).toBe(QUESTION);
  });
});
