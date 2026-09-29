/**
 * Issue #652 handshake-timeout record (design L1) on the production createApp → registerSessions
 * assembly, real fake-omp children and the system clock (no injected runtime clock). Oracles: the
 * REST 502 envelope, the records the assembly `log` sink received, unhandled rejections.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HandshakeTimeoutRecord } from "../src/sessions/omp/spawn-gate.js";
import { AGENT_UNAVAILABLE_ENVELOPE } from "./session-rest-helpers.js";
import { gateWorlds, send, waitSpawns } from "./session-spawn-gate-helpers.js";

const REAL = { timeout: 20_000 };
const H = 300;
const worlds = gateWorlds();

describe("handshake timeout is logged once (L1)", () => {
  it("a no-ready child: 502 and exactly one four-key record with elapsedMs ≥ H", REAL, async () => {
    const records: unknown[] = [];
    const world = await worlds.open({
      sessions: 1,
      argv: () => ["--scenario", "no-ready"],
      handshakeTimeoutMs: H,
      systemClock: true,
      log: (record) => {
        records.push(record);
      },
    });
    const session = world.sessions[0] as string;

    const response = await send(world, session, "never ready");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(["elapsedMs", "event", "reason", "sessionId"]);
    expect(record).toMatchObject({
      event: "omp_handshake_timeout",
      sessionId: session,
      reason: "handshake timeout",
    });
    expect(Number.isInteger(record.elapsedMs)).toBe(true);
    expect(record.elapsedMs as number).toBeGreaterThanOrEqual(H);
    expect(world.errors).toEqual([]);
  });

  it("an ENOENT spawn failure produces no record", REAL, async () => {
    const records: unknown[] = [];
    const world = await worlds.open({
      sessions: 1,
      argv: () => [],
      handshakeTimeoutMs: H,
      systemClock: true,
      missingBinary: join("/nonexistent-652", "omp"),
      log: (record) => {
        records.push(record);
      },
    });

    const response = await send(world, world.sessions[0] as string, "missing binary");

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
    await waitSpawns(world, 1);
    expect(world.spawns[0]?.child.pid).toBeUndefined();
    expect(records).toEqual([]);
  });

  it.each([
    [
      "throws",
      (): unknown => {
        throw new Error("log sink down");
      },
    ],
    ["returns a rejected thenable", (): unknown => Promise.reject(new Error("log sink async"))],
  ])(
    "a log port that %s leaves the 502 unchanged, with no unhandled rejection",
    async (_name, sink) => {
      const calls: HandshakeTimeoutRecord[] = [];
      const world = await worlds.open({
        sessions: 1,
        argv: () => ["--scenario", "no-ready"],
        handshakeTimeoutMs: H,
        systemClock: true,
        log: (record) => {
          calls.push(record);
          return sink();
        },
      });

      const response = await send(world, world.sessions[0] as string, "never ready");

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual(AGENT_UNAVAILABLE_ENVELOPE);
      expect(calls).toHaveLength(1);
      expect(world.errors).toEqual([]);
    },
    REAL.timeout,
  );
});
