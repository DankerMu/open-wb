/**
 * Issue #463 A group: serialized admission against the global live-process cap and
 * least-recently-active eviction. Oracles: Node child exit state sampled at every spawn, the
 * recorded spawn argv (`--resume`), the injected clock, the SQL rows and the REST envelope.
 */
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { messageRows, sessionRow } from "./session-store-helpers.js";
import {
  closeOnEof,
  completeHeldTurn,
  createControlledRuntime,
  createRealFakeRuntime,
  OWNER_ID,
  resumePath,
  waitFor,
  waitForContent,
} from "./session-supervisor-helpers.js";
import {
  A_FILE,
  autoComplete,
  child,
  completed,
  expectCapacity,
  expectWithinCap,
  gateApprovals,
  holdAfterHello,
  isLive,
  openPool,
  presetSessionFile,
  sampleSpawns,
  send,
  settledTurn,
  tapStdout,
} from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const REAL = { timeout: 20_000 };

describe("SessionSupervisor process pool admission", () => {
  it("A1 admits exactly one of two concurrent prompts at cap 1", REAL, async () => {
    const rt = createRealFakeRuntime("hang-prompt");
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      const responses = await Promise.all([send(world, a, "one"), send(world, b, "two")]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 503]);
      const rejected = responses.find((response) => response.statusCode === 503);
      if (rejected === undefined) {
        throw new Error("missing capacity rejection");
      }
      expectCapacity(rejected);
      expect(rt.calls).toHaveLength(1);
      expect(world.fixture.supervisor.liveProcessCount()).toBe(1);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      await world.fixture.close();
    }
  });

  it("A2 never exceeds cap 2 across four concurrent prompts", REAL, async () => {
    const rt = createRealFakeRuntime("hang-prompt");
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 2, 4);
    try {
      const seenAtRejection: number[] = [];
      const responses = await Promise.all(
        world.sessions.map((session, index) =>
          send(world, session, `prompt ${String(index)}`).then((response) => {
            if (response.statusCode === 503) {
              seenAtRejection.push(world.fixture.supervisor.liveProcessCount());
            }
            return response;
          }),
        ),
      );
      const codes = responses.map((response) => response.statusCode);
      expect([...codes].sort()).toEqual([202, 202, 503, 503]);
      for (const response of responses.filter((item) => item.statusCode === 503)) {
        expectCapacity(response);
      }
      expect(seenAtRejection).toEqual([2, 2]);
      const admitted = world.sessions.filter((_session, index) => codes[index] === 202);
      expect(admitted.map((session) => sessionRow(world.fixture.db, session).status)).toEqual([
        "running",
        "running",
      ]);
      expect(rt.calls).toHaveLength(2);
      expectWithinCap(liveAtSpawn, 2);
    } finally {
      await world.fixture.close();
    }
  });

  it("A3 evicts the least recently active idle process and resumes it later", REAL, async () => {
    const rt = createRealFakeRuntime();
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 2, 3);
    try {
      const [a, b, c] = world.sessions as [string, string, string];
      presetSessionFile(world.fixture.db, a, A_FILE);
      const firstA = await completed(world, a, "a one");
      rt.clock.advance(100);
      await completed(world, b, "b one");
      rt.clock.advance(100);

      const admittedC = await send(world, c, "c one");
      expect(admittedC.statusCode).toBe(202);
      expect(child(rt.children, 0).stdin.writableEnded).toBe(true);
      expect(isLive(child(rt.children, 0))).toBe(false);
      expect(liveAtSpawn[2]).toEqual([1]);
      const childB = child(rt.children, 1);
      expect(isLive(childB)).toBe(true);
      expect(childB.stdin.writableEnded).toBe(false);
      await settledTurn(world, c);

      const resumedA = await send(world, a, "a two");
      expect(resumedA.statusCode).toBe(202);
      expect(childB.stdin.writableEnded).toBe(true);
      expect(isLive(childB)).toBe(false);
      expect(liveAtSpawn[3]).toEqual([2]);
      expect(resumePath(child(rt.calls, 3).args)).toBe(A_FILE);
      const tree = await waitFor(() => {
        const current = world.fixture.store.getMessages(a, OWNER_ID);
        return current?.session.status === "done" && current.messages.length === 4
          ? current
          : undefined;
      }, "A resumed turn");
      expect(tree.messages.slice(0, 2)).toEqual(firstA.messages);
      expect(sessionRow(world.fixture.db, a).stream_epoch).toBe(2);
      expect(rt.calls).toHaveLength(4);
      expectWithinCap(liveAtSpawn, 2);
    } finally {
      await world.fixture.close();
    }
  });

  it("A4 orders victims by last activity, not by admission order", REAL, async () => {
    const rt = createRealFakeRuntime();
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 2, 3);
    try {
      const [a, b, c] = world.sessions as [string, string, string];
      await completed(world, a, "a one");
      rt.clock.advance(100);
      await completed(world, b, "b one");
      rt.clock.advance(100);
      await completed(world, a, "a two on the same process");
      expect(rt.calls).toHaveLength(2);

      const admittedC = await send(world, c, "c one");
      expect(admittedC.statusCode).toBe(202);
      expect(child(rt.children, 1).stdin.writableEnded).toBe(true);
      expect(isLive(child(rt.children, 1))).toBe(false);
      expect(liveAtSpawn[2]).toEqual([0]);
      expect(isLive(child(rt.children, 0))).toBe(true);
      expect(child(rt.children, 0).stdin.writableEnded).toBe(false);
      expectWithinCap(liveAtSpawn, 2);
    } finally {
      await world.fixture.close();
    }
  });

  it("A5 breaks a last-activity tie by earlier admission", REAL, async () => {
    const rt = createRealFakeRuntime();
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 2, 3);
    try {
      const [a, b, c] = world.sessions as [string, string, string];
      await completed(world, a, "a one");
      await completed(world, b, "b one");
      const admittedC = await send(world, c, "c one");
      expect(admittedC.statusCode).toBe(202);
      expect(child(rt.children, 0).stdin.writableEnded).toBe(true);
      expect(isLive(child(rt.children, 0))).toBe(false);
      expect(liveAtSpawn[2]).toEqual([1]);
      expect(isLive(child(rt.children, 1))).toBe(true);
      expectWithinCap(liveAtSpawn, 2);
    } finally {
      await world.fixture.close();
    }
  });

  it("A6 rejects with 503 and no side effects while every process is mid-turn", async () => {
    const rt = createControlledRuntime((fake, _call, ordinal) => {
      if (ordinal === 1) {
        holdAfterHello(fake);
        closeOnEof(fake);
        return;
      }
      autoComplete(fake);
    });
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      await completed(world, b, "b one");
      const admittedA = await send(world, a, "a held");
      expect(admittedA.statusCode).toBe(202);
      await waitForContent(world.fixture, a, "Hello");
      expect(isLive(child(rt.children, 0))).toBe(false);

      const rowsBefore = messageRows(world.fixture.db).filter((row) => row.session_id === b);
      const sessionBefore = sessionRow(world.fixture.db, b);
      const rejected = await send(world, b, "b blocked");
      expectCapacity(rejected);
      expect(messageRows(world.fixture.db).filter((row) => row.session_id === b)).toEqual(
        rowsBefore,
      );
      expect(sessionRow(world.fixture.db, b)).toEqual(sessionBefore);
      expect(sessionBefore).toMatchObject({ status: "done", stream_epoch: 1 });
      expect(rt.calls).toHaveLength(2);
      const childA = child(rt.children, 1);
      expect(childA.stdin.writableEnded).toBe(false);
      expect(isLive(childA)).toBe(true);

      completeHeldTurn(childA);
      await settledTurn(world, a);
      const retried = await send(world, b, "b after A");
      expect(retried.statusCode).toBe(202);
      expect(childA.stdin.writableEnded).toBe(true);
      expect(isLive(childA)).toBe(false);
      expect(rt.calls).toHaveLength(3);
      expect(resumePath(child(rt.calls, 2).args)).toBe(sessionBefore.omp_session_file);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      await world.fixture.close();
    }
  });

  it("A7 rejects with 503 while the only process holds a pending approval", REAL, async () => {
    const rt = createRealFakeRuntime("approval");
    gateApprovals(rt.runtime);
    const stdout = tapStdout(rt.runtime);
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 2);
    try {
      const [a, b] = world.sessions as [string, string];
      const admittedA = await send(world, a, "run the tool");
      expect(admittedA.statusCode).toBe(202);
      const childA = await waitFor(() => rt.children[0], "A child");
      await waitFor(
        () => (stdout[0]?.includes('"type":"extension_ui_request"') ? true : undefined),
        "A pending approval",
      );
      const rejected = await send(world, b, "b blocked");
      expectCapacity(rejected);
      expect(isLive(childA)).toBe(true);
      expect(childA.stdin.writableEnded).toBe(false);
      expect(rt.calls).toHaveLength(1);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      await world.fixture.close();
    }
  });

  it("A8 never selects a process already being evicted", REAL, async () => {
    const rt = createRealFakeRuntime("hang-eof");
    const liveAtSpawn = sampleSpawns(rt);
    const world = await openPool(rt.runtime, 1, 3);
    try {
      const [a, b, c] = world.sessions as [string, string, string];
      await completed(world, a, "a one");
      rt.setScenario("hang-prompt");
      const pendingB = send(world, b, "b");
      const pendingC = send(world, c, "c");
      const observedB = observePromise(pendingB);
      const observedC = observePromise(pendingC);
      const childA = child(rt.children, 0);
      await waitFor(() => (childA.stdin.writableEnded ? true : undefined), "A stdin EOF");
      for (let n = 0; n < 5; n += 1) {
        await waitImmediate();
      }
      expect(observedB.outcome).toBe("pending");
      expect(observedC.outcome).toBe("pending");
      expect(rt.calls).toHaveLength(1);
      expect(isLive(childA)).toBe(true);

      rt.clock.advance(5_000);
      const responses = await Promise.all([pendingB, pendingC]);
      expect(childA.signalCode).toBe("SIGTERM");
      expect(rt.calls).toHaveLength(2);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 503]);
      expectWithinCap(liveAtSpawn, 1);
    } finally {
      // hang-eof ignores stdin EOF; without this a failed assertion would leave its retirement
      // waiting on the injected clock and mask the failure behind a close timeout.
      for (const spawned of rt.children.filter(isLive)) {
        spawned.kill("SIGKILL");
      }
      await world.fixture.close();
    }
  });
});
