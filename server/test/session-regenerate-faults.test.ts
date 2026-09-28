/**
 * Issue #465 regenerate faults and windows over scripted FakeChild processes (production createApp
 * assembly, real SQLite): empty branch list (F1), process exit before the post-branch get_state
 * (F2), the claim excluding eviction (F3), a full pool (F4), a stop intent across the post-commit
 * dispatch (F5), a post-commit dispatch failure (F6) and the dispatch-count balance that seals a
 * regenerate's generation (F7). Oracles: SQL rows, recorded stdin frames, spawn argv, pool
 * envelopes, published events and the public supervisor surface.
 */
import { describe, expect, it } from "vitest";
import { settle } from "./session-approval-helpers.js";
import {
  answered,
  type ChildScript,
  held,
  P,
  promptsAgain,
  regenerate,
  regenWorlds,
  rejectedCode,
  scriptedAt,
  scriptedRuntime,
  seedDone,
  sendPrompt,
  snapshot,
  types,
} from "./session-regenerate-helpers.js";
import {
  assistantIdFor,
  completeHeldTurn,
  createSession,
  OWNER_ID,
  openRecordingSession,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { expectCapacity, isLive, presetSessionFile } from "./session-supervisor-pool-helpers.js";
import { holdNextPromptWrite } from "./support/omp-rpc.js";

const worlds = regenWorlds();

async function openScripted(scripts: ChildScript[], cap?: number) {
  const { rt, scripted } = scriptedRuntime(scripts);
  const world = await openRecordingSession(
    cap === undefined ? rt.runtime : { ...rt.runtime, maxProcesses: cap },
  );
  return { ...worlds.track(world), rt, scripted };
}

type Scripted = Awaited<ReturnType<typeof openScripted>>;

/** One completed REST turn on a live child, then its file preset to P (the runtime keeps its own). */
async function liveDone(world: Scripted, complete: boolean): Promise<void> {
  const answering = answered(world);
  if (complete) {
    await waitFor(() => world.scripted[0]?.frames.find((f) => f.type === "prompt"), "prompt");
    completeHeldTurn(scriptedAt(world.scripted, 0).child);
  }
  await answering;
  presetSessionFile(world.fixture.db, world.session, P);
}

describe("regenerate faults over scripted FakeChild processes (#465)", () => {
  it("F1 an empty branch list is agent_unavailable without branch or row change", async () => {
    const world = await openScripted([{ messages: [] }]);
    seedDone(world);
    const before = snapshot(world.fixture.db, world.session);

    expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

    expect(types(scriptedAt(world.scripted, 0).frames)).not.toContain("branch");
    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(held(world)).toBe(false);
  });

  const exits = [
    ["(a) exit inside the post-branch get_state", { exitOnState: true }],
    ["(b) exit in the same segment as the branch reply", { exitAfterBranch: true }],
  ] as const;
  for (const [name, script] of exits) {
    it(`F2 ${name}: agent_unavailable, one spawn, rows kept`, async () => {
      const world = await openScripted([script, {}]);
      await liveDone(world, false);
      const before = snapshot(world.fixture.db, world.session);

      expect(await rejectedCode(regenerate(world))).toBe("agent_unavailable");

      expect(world.rt.calls).toHaveLength(1);
      expect(types(scriptedAt(world.scripted, 0).frames)).toContain("branch");
      expect(snapshot(world.fixture.db, world.session)).toEqual(before);
      expect(held(world)).toBe(false);
      await promptsAgain(world, "after exit");
    });
  }

  it("F3 a claimed session's process is not evictable", async () => {
    const world = await openScripted([{ hold: "branch" }, {}], 1);
    const other = await createSession(world.fixture.app, world.cookie);
    seedDone(world);
    const work = regenerate(world);
    const a = await waitFor(
      () => (world.scripted[0]?.release === undefined ? undefined : world.scripted[0]),
      "held branch",
    );

    expectCapacity(await sendPrompt(world, "b", other));

    expect(a.child.stdin.writableEnded).toBe(false);
    expect(a.child.signalCode).toBeNull();
    a.release?.();
    await work;
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    expect((await sendPrompt(world, "b again", other)).statusCode).toBe(202);
    expect(isLive(a.child)).toBe(false);
    await waitForTurn(world.fixture, other, "done");
  });

  it("F4 a full pool is agent_capacity with no row change and the claim released", async () => {
    const world = await openScripted([{ prompt: "hold" }, {}], 1);
    const other = await createSession(world.fixture.app, world.cookie);
    expect((await sendPrompt(world, "b holds", other)).statusCode).toBe(202);
    seedDone(world);
    const before = snapshot(world.fixture.db, world.session);

    expect(await rejectedCode(regenerate(world))).toBe("agent_capacity");

    expect(snapshot(world.fixture.db, world.session)).toEqual(before);
    expect(held(world)).toBe(false);
    expect(world.rt.calls).toHaveLength(1);
    const b = scriptedAt(world.scripted, 0).child;
    completeHeldTurn(b);
    await waitForTurn(world.fixture, other, "done");
    await settle();
    await promptsAgain(world, "a after capacity");
    expect(world.rt.calls).toHaveLength(2);
    expect(isLive(b)).toBe(false);
  });

  it("F5 a stop between commit and dispatch receipt aborts exactly once after it", async () => {
    const world = await openScripted([{ prompt: "hold" }]);
    await liveDone(world, true);
    const a = scriptedAt(world.scripted, 0);
    const write = holdNextPromptWrite(a.child);
    const work = regenerate(world);
    await write.entered;

    await world.fixture.supervisor.stop(world.session);

    expect(types(a.frames)).not.toContain("abort");
    write.release();
    const { assistantMessageId } = await work;
    await settle();
    const written = types(a.frames);
    expect(written.slice(written.lastIndexOf("prompt") + 1)).toEqual(["abort"]);
    const tree = await waitFor(() => {
      const found = world.fixture.store.getMessages(world.session, OWNER_ID);
      return found?.session.status === "stopped" ? found : undefined;
    }, "stopped");
    expect(tree.messages.at(-1)?.id).toBe(assistantMessageId);
    const after = types(a.frames);
    expect(after.slice(after.lastIndexOf("prompt") + 1)).toEqual(["abort"]);
    const ends = world.events.filter(
      (e) => e.sessionId === world.session && e.event.type === "turn.end",
    );
    expect(ends.at(-1)?.event).toEqual({
      type: "turn.end",
      data: { messageId: assistantMessageId, status: "stopped" },
    });
    expect(
      ends.filter(
        (e) => e.event.type === "turn.end" && e.event.data.messageId === assistantMessageId,
      ),
    ).toHaveLength(1);
    expect(world.events.filter((e) => e.event.type === "error")).toEqual([]);
  });

  it("F6 a post-commit dispatch failure settles the new row failed and never revives", async () => {
    const world = await openScripted([{ prompt: "hold" }, {}]);
    await liveDone(world, true);
    const { db } = world.fixture;
    const old = assistantIdFor(world.fixture, world.session);
    db.exec(
      "CREATE TRIGGER f6_receipt BEFORE UPDATE OF omp_session_file ON chat_sessions WHEN OLD.status = 'running' AND NEW.omp_session_file = OLD.omp_session_file BEGIN SELECT RAISE(ABORT, 'f6'); END",
    );
    const a = scriptedAt(world.scripted, 0);
    const write = holdNextPromptWrite(a.child);
    const events = world.events.length;
    const work = regenerate(world);
    await write.entered;
    await world.fixture.supervisor.stop(world.session);
    write.release();

    expect(await rejectedCode(work)).toBe("agent_unavailable");

    const rows = snapshot(db, world.session).messages as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows.some((row) => row.id === old)).toBe(false);
    expect(rows[1]?.status).toBe("failed");
    expect(snapshot(db, world.session).session).toMatchObject({ status: "failed" });
    expect(types(a.frames)).not.toContain("abort");
    expect(world.events.slice(events)).toEqual([]);
    expect(held(world)).toBe(false);
    db.exec("DROP TRIGGER f6_receipt");
    expect((await sendPrompt(world, "after failure")).statusCode).toBe(202);
    await waitForTurn(world.fixture, world.session, "done");
  });

  it("F7 a reclaimed regenerate's generation seals once its process exits", async () => {
    const world = await openScripted([{ keepStdout: true }]);
    seedDone(world);
    const epoch = world.fixture.supervisor.streamCursor(world.session).epoch;
    await regenerate(world);
    await waitForTurn(world.fixture, world.session, "done");
    await settle();
    const a = scriptedAt(world.scripted, 0).child;
    try {
      // The live generation is what streamCursor reads until it seals (ring sequence, not null).
      expect(world.fixture.supervisor.streamCursor(world.session).seq).not.toBeNull();
      a.nativeExit(0);
      await settle();
      expect(world.fixture.supervisor.streamCursor(world.session)).toEqual({
        epoch: epoch + 1,
        seq: null,
      });
    } finally {
      a.endStdout();
    }
  });
});
