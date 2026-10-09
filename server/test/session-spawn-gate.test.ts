/**
 * Issue #652 concurrent spawn cap on the production createApp → registerSessions assembly over
 * real fake-omp children (design G2, G3, G4a, G5, G6). Oracles: REST status/envelope, the spawn
 * and `ready` instants tapped at each real child's spawn, spawn counts, SQLite rows. Timings: the
 * fake's ready delay D and the handshake bound H are the design's literals.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import { settle } from "./session-approval-helpers.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import {
  driveClock,
  type GateWorld,
  gateWorlds,
  send,
  spawnAt,
  stopTurn,
  turnDone,
  waitSpawns,
} from "./session-spawn-gate-helpers.js";
import { OWNER_ID, waitFor } from "./session-supervisor-helpers.js";
import { presetSessionFile } from "./session-supervisor-pool-helpers.js";
import { observePromise } from "./support/omp-rpc.js";

const REAL = { timeout: 30_000 };
const worlds = gateWorlds();
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const slowReady = (ms: number) => ["--scenario", "slow-ready", "--ready-delay-ms", String(ms)];

function readyAt(world: GateWorld, ordinal: number): number {
  const at = spawnAt(world, ordinal).readyAt;
  if (at === undefined) {
    throw new Error(`spawn ${String(ordinal)} never reported ready`);
  }
  return at;
}

describe("spawn concurrency cap (G2, G3)", () => {
  it(
    "G2 limit 1, cap 3: at most one child is spawned-but-unready; all three prompts 202",
    REAL,
    async () => {
      const world = await worlds.open({
        sessions: 3,
        argv: () => slowReady(300),
        spawnConcurrency: 1,
        maxProcesses: 3,
      });

      const responses = await Promise.all(world.sessions.map((s, n) => send(world, s, `g2-${n}`)));

      expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202]);
      expect(world.spawns).toHaveLength(3);
      expect(Math.max(...world.spawns.map((s) => s.unreadyAtSpawn))).toBe(1);
      for (const session of world.sessions) {
        await stopTurn(world, session);
      }
    },
  );

  it(
    "G3 queue time is outside the deadline: H=1500, D=600, three cold starts all succeed",
    REAL,
    async () => {
      const H = 1_500;
      const world = await worlds.open({
        sessions: 3,
        argv: () => slowReady(600),
        spawnConcurrency: 1,
        handshakeTimeoutMs: H,
      });

      const began = performance.now();
      const responses = await Promise.all(world.sessions.map((s, n) => send(world, s, `g3-${n}`)));

      expect(responses.map((response) => response.statusCode)).toEqual([202, 202, 202]);
      expect(spawnAt(world, 1).spawnAt).toBeGreaterThanOrEqual(readyAt(world, 0));
      expect(spawnAt(world, 2).spawnAt).toBeGreaterThanOrEqual(readyAt(world, 1));
      expect(readyAt(world, 2) - began).toBeGreaterThan(H);
      for (const session of world.sessions) {
        await stopTurn(world, session);
      }
    },
  );
});

describe("queued acquisitions and shutdown (G4a)", () => {
  it(
    "G4a supervisor shutdown ends the queued prompt with 502 and it never spawns",
    REAL,
    async () => {
      const world = await worlds.open({
        sessions: 2,
        argv: () => ["--scenario", "no-ready-hang"],
        spawnConcurrency: 1,
      });
      const [a, b] = world.sessions as [string, string];
      // A dispatch enters its runtime through the first alignment command (#1010): that call is
      // what queues b's acquisition on the spawn gate.
      const entered = vi.spyOn(SessionRuntime.prototype, "command");
      try {
        const first = send(world, a, "a handshaking");
        await waitSpawns(world, 1);
        const queued = send(world, b, "b queued");
        await waitFor(
          () => (entered.mock.calls.length === 2 ? true : undefined),
          "b's runtime acquisition",
        );
        await settle();
        expect(world.spawns).toHaveLength(1);

        const shutdown = world.supervisor.shutdown();
        const bResponse = await queued;
        expect(bResponse.statusCode).toBe(502);
        expect(bResponse.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
        await driveClock(world, shutdown);
        await expect(shutdown).resolves.toBeUndefined();
        expect((await first).statusCode).toBe(502);
        expect(world.spawns).toHaveLength(1);
      } finally {
        entered.mockRestore();
      }
    },
  );
});

describe("a failed startup returns its permit at settlement (G5)", () => {
  it(
    "G5 A's handshake times out: B spawns and is accepted while A's retirement is still held",
    REAL,
    async () => {
      const world = await worlds.open({
        sessions: 2,
        argv: (ordinal) => (ordinal === 0 ? ["--scenario", "no-ready"] : []),
        spawnConcurrency: 1,
        handshakeTimeoutMs: 400,
        holdExit: [0],
      });
      const [a, b] = world.sessions as [string, string];

      const first = send(world, a, "a never ready");
      const aObserved = observePromise(first);
      await waitSpawns(world, 1);
      world.runtime.handshakeTimeoutMs = undefined;
      const second = send(world, b, "b behind a");

      await waitSpawns(world, 2);
      const bResponse = await second;
      expect(bResponse.statusCode).toBe(202);
      const hold = world.holds.get(0);
      expect(hold?.held()).toBeGreaterThan(0);
      expect(aObserved.outcome).toBe("pending");
      await turnDone(world, b);

      hold?.release();
      await driveClock(world, first);
      const aResponse = await first;
      expect(aResponse.statusCode).toBe(502);
      expect(aResponse.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
    },
  );
});

describe("fork temporary process shares the gate (G6)", () => {
  it(
    "G6 a fork during a slow handshake spawns only after that child is ready; both succeed",
    REAL,
    async () => {
      const world = await worlds.open({
        sessions: 2,
        argv: (ordinal) => (ordinal === 0 ? slowReady(600) : ["--scenario", "branch"]),
        spawnConcurrency: 1,
      });
      const [busy, source] = world.sessions as [string, string];
      const u2 = seedTwoTurns(world, source);

      const prompt = send(world, busy, "slow handshake");
      await waitSpawns(world, 1);
      const fork = world.supervisor.fork(source, OWNER_ID, u2);

      const forked = await fork;
      expect(forked.session.id).toMatch(/^[0-9a-f]{32}$/u);
      expect((await prompt).statusCode).toBe(202);
      expect(world.spawns).toHaveLength(2);
      expect(spawnAt(world, 1).spawnAt).toBeGreaterThanOrEqual(readyAt(world, 0));
      await stopTurn(world, busy);
    },
  );
});

/** u1 → a1 → u2 → a2 settled through the store, resume file preset to a real file; returns u2. */
function seedTwoTurns(world: GateWorld, session: string): number {
  const first = world.store.acceptPrompt(session, OWNER_ID, "first question");
  world.store.finishTurn(first.assistantMessageId, "done");
  const second = world.store.acceptPrompt(session, OWNER_ID, "second question");
  world.store.finishTurn(second.assistantMessageId, "done");
  const dir = mkdtempSync(join(tmpdir(), "open-wb-652-"));
  scratch.push(dir);
  const file = join(dir, "source.jsonl");
  writeFileSync(file, '{"type":"session","id":"source"}\n');
  presetSessionFile(world.db, session, file);
  return second.userMessageId;
}
