/**
 * Issue #652 production wiring of the handshake-timeout record (design L2): the pure
 * `appAssemblyOf(config)` seam the main path hands to createApp. Oracles: the assembly's runtime
 * equals `sessionRuntimeOf(config)`, and process.stderr/stdout write spies (callback honoured).
 *
 * Issue #664 adds the same seam's `onError`: one generic `{"event":"session_fault"}` stderr line
 * per retained supervisor fault, first at the seam, then through a real createApp whose fault is a
 * terminal transaction rejected by a TEMP TRIGGER (session-supervisor-faults.test.ts); that
 * trigger notifies the sink exactly once per turn.
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssemblyDependencies, createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { appAssemblyOf, resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { settle } from "./session-approval-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor, postPrompt } from "./session-rest-helpers.js";
import { collectRejections } from "./session-stop-helpers.js";
import {
  capturedFailure,
  containsMessage,
  createSession,
  createStartEofRuntime,
  emitAssistantDelta,
  waitFor,
} from "./session-supervisor-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const RECORD = {
  event: "omp_handshake_timeout",
  sessionId: "0123456789abcdef0123456789abcdef",
  reason: "handshake timeout",
  elapsedMs: 10_004,
} as const;

const FAULT_LINE = '{"event":"session_fault"}\n';
/** Shaped like what a raw fault carries: a host path and a credential; neither may reach stderr. */
const FAULT_SENTINEL = "EACCES /srv/private/app.db sk-664-secret-sentinel";
const TRIGGER_SENTINEL = "terminal write sentinel 664";
const SINK_CONTRACT = "must return synchronously";

type WriteCallback = (error?: Error | null) => void;

/** Captures writes without reaching the terminal; the callback settles the managed writer. */
function spyWrites(stream: NodeJS.WriteStream, fail?: Error) {
  return vi.spyOn(stream, "write").mockImplementation(((_chunk: unknown, ...rest: unknown[]) => {
    const callback = rest.find((arg): arg is WriteCallback => typeof arg === "function");
    callback?.(fail ?? null);
    return true;
  }) as typeof stream.write);
}

/** The other unavailable-sink shape: write itself throws before any callback. */
function spyThrowingWrites(stream: NodeJS.WriteStream, fail: Error) {
  return vi.spyOn(stream, "write").mockImplementation(() => {
    throw fail;
  });
}

function epipe(): Error {
  return Object.assign(new Error("EPIPE"), { code: "EPIPE" });
}

function linesOf(spy: ReturnType<typeof spyWrites>): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

/**
 * A real createApp over a fake omp whose every turn ends in a rejected terminal transaction.
 * `assembly` is exactly what the caller hands over, plus the fake runtime and its token registry.
 */
function openFaultingApp(assembly: AssemblyDependencies) {
  const runtime = createStartEofRuntime((child) => {
    emitAssistantDelta(child, "terminal residual");
    child.emitLine({ type: "agent_end", messages: [], isTerminal: true });
  });
  const db = openDb(":memory:");
  const tokens = new TokenRegistry();
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: { ...assembly, runtime: runtime.runtime, tokens },
  });
  db.exec(`CREATE TEMP TRIGGER reject_terminal_664
    BEFORE UPDATE OF status ON chat_sessions
    WHEN NEW.status = 'done'
    BEGIN SELECT RAISE(ABORT, '${TRIGGER_SENTINEL}'); END`);
  let closed = false;
  return {
    /** One faulting turn in a fresh session; resolves once its slot is retired (token revoked). */
    async faultOneTurn(): Promise<void> {
      const cookie = await cookieFor(app, "zhangsan");
      const session = await createSession(app, cookie);
      const spawned = runtime.calls.length;
      const response = await postPrompt(app, session, cookie, JSON.stringify({ message: "go" }));
      expect(response.statusCode).toBe(202);
      await waitFor(() => {
        const token = runtime.calls[spawned]?.token;
        return token !== undefined && tokens.lookup(token) === null ? true : undefined;
      }, "faulted slot retirement");
      await settle();
    },
    /** The retained faults as app.close() surfaces them; the caller-owned DB stays usable. */
    async closeAndCollect(): Promise<unknown> {
      closed = true;
      const failure = await capturedFailure(() => app.close());
      expect(db.prepare("SELECT 1 AS usable").get()).toEqual({ usable: 1 });
      db.close();
      return failure;
    },
    /** Cleanup for a test that failed before its own close; never masks that failure. */
    async dispose(): Promise<void> {
      if (!closed) {
        await app.close().catch(() => undefined);
        db.close();
      }
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("appAssemblyOf (L2)", () => {
  it("returns sessionRuntimeOf(config), the optional upstream and a log port, writing nothing", () => {
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const bare = resolveServerConfig({ OMP_SPAWN_CONCURRENCY: "2" }, ENTRY);
    const withUpstream = resolveServerConfig(
      { MODEL_UPSTREAM_BASE_URL: "http://127.0.0.1:9/v1", MODEL_UPSTREAM_API_KEY: "k-652" },
      ENTRY,
    );

    const assembly = appAssemblyOf(bare);
    const upstream = appAssemblyOf(withUpstream);

    expect(assembly.runtime).toEqual(sessionRuntimeOf(bare));
    expect(assembly.runtime?.spawnConcurrency).toBe(2);
    expect(Object.hasOwn(assembly, "upstream")).toBe(false);
    expect(typeof assembly.log).toBe("function");
    expect(upstream.upstream).toEqual({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k-652" });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("log writes exactly one LF-terminated four-key JSON line to stderr", async () => {
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const { log } = appAssemblyOf(resolveServerConfig({}, ENTRY));

    log?.({ ...RECORD });
    await settle(2);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
    const line = String(stderr.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["elapsedMs", "event", "reason", "sessionId"]);
    expect(parsed).toEqual(RECORD);
  });

  it("warn writes one LF-terminated JSON line for a dropped task-list candidate (#864)", async () => {
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const { warn } = appAssemblyOf(resolveServerConfig({}, ENTRY));
    const record = {
      level: "warn",
      event: "session_todo_rejected",
      assistantMessageId: 7,
    } as const;

    warn?.(record);
    await settle(2);

    expect(stdout).not.toHaveBeenCalled();
    expect(linesOf(stderr)).toEqual([`${JSON.stringify(record)}\n`]);
  });

  it("a failing stderr write is swallowed: no throw, no unhandled rejection", async () => {
    const rejections = collectRejections();
    try {
      spyWrites(process.stderr, Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
      const { log } = appAssemblyOf(resolveServerConfig({}, ENTRY));
      expect(() => log?.({ ...RECORD })).not.toThrow();
      await settle();
      expect(rejections.reasons).toEqual([]);
    } finally {
      rejections.dispose();
    }
  });

  it("re-importing server.ts writes nothing", async () => {
    vi.resetModules();
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const imported = await import("../src/server.js");
    expect(typeof imported.appAssemblyOf).toBe("function");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("appAssemblyOf onError (#664)", () => {
  it("writes exactly one generic session_fault line without the fault text and returns undefined", async () => {
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const { onError } = appAssemblyOf(resolveServerConfig({}, ENTRY));
    const fault = new Error(FAULT_SENTINEL);

    const returned: unknown = onError?.(fault);
    await settle(2);

    expect(typeof onError).toBe("function");
    expect(returned).toBe(undefined);
    expect(stdout).not.toHaveBeenCalled();
    expect(linesOf(stderr)).toEqual([FAULT_LINE]);
    expect(linesOf(stderr).join("")).not.toContain("sentinel");
    expect(linesOf(stderr).join("")).not.toContain("/srv/private");
  });

  it.each([
    ["a rejected write", (fail: Error) => spyWrites(process.stderr, fail)],
    ["a synchronously throwing write", (fail: Error) => spyThrowingWrites(process.stderr, fail)],
  ])(
    "%s is swallowed: no throw, no unhandled rejection, no second notification",
    async (_name, breakStderr) => {
      const rejections = collectRejections();
      try {
        const stderr = breakStderr(epipe());
        const assembly = appAssemblyOf(resolveServerConfig({}, ENTRY));
        const notified = vi.spyOn(assembly, "onError");

        let returned: unknown = "unset";
        expect(() => {
          returned = assembly.onError?.(new Error(FAULT_SENTINEL));
        }).not.toThrow();
        await settle();

        expect(returned).toBe(undefined);
        expect(stderr).toHaveBeenCalledTimes(1);
        expect(notified).toHaveBeenCalledTimes(1);
        expect(rejections.reasons).toEqual([]);
      } finally {
        rejections.dispose();
      }
    },
  );
});

describe("retained supervisor fault through createApp (#664)", () => {
  it("the production assembly writes one session_fault line per notification, also when stderr is broken", {
    timeout: 20_000,
  }, async () => {
    const production = appAssemblyOf(resolveServerConfig({}, ENTRY));
    const notified = vi.spyOn(production, "onError");
    const stdout = spyWrites(process.stdout);
    let stderr = spyWrites(process.stderr);
    const world = openFaultingApp(production);
    const rejections = collectRejections();
    try {
      await world.faultOneTurn();
      expect(notified).toHaveBeenCalledTimes(1);
      expect(String(notified.mock.calls[0]?.[0])).toContain(TRIGGER_SENTINEL);
      expect(notified.mock.results[0]).toEqual({ type: "return", value: undefined });
      expect(linesOf(stderr)).toEqual([FAULT_LINE]);

      stderr.mockRestore();
      stderr = spyWrites(process.stderr, epipe());
      await world.faultOneTurn();
      expect(notified).toHaveBeenCalledTimes(2);
      expect(linesOf(stderr)).toEqual([FAULT_LINE]);

      stderr.mockRestore();
      stderr = spyThrowingWrites(process.stderr, epipe());
      await world.faultOneTurn();
      expect(notified).toHaveBeenCalledTimes(3);
      expect(linesOf(stderr)).toEqual([FAULT_LINE]);
      expect(stdout).not.toHaveBeenCalled();
      expect(rejections.reasons).toEqual([]);

      const failure = await world.closeAndCollect();
      // Retained faults equal notifications: the broken sink added no sink-contract fault.
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toHaveLength(3);
      expect(notified).toHaveBeenCalledTimes(3);
      expect(containsMessage(failure, TRIGGER_SENTINEL)).toBe(true);
      expect(containsMessage(failure, SINK_CONTRACT)).toBe(false);
    } finally {
      rejections.dispose();
      await world.dispose();
    }
  });

  it("createApp without onError writes nothing for the same fault and still surfaces it at shutdown", {
    timeout: 20_000,
  }, async () => {
    const stdout = spyWrites(process.stdout);
    const stderr = spyWrites(process.stderr);
    const world = openFaultingApp({});
    try {
      await world.faultOneTurn();
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();

      const failure = await world.closeAndCollect();
      expect(containsMessage(failure, TRIGGER_SENTINEL)).toBe(true);
      expect(containsMessage(failure, SINK_CONTRACT)).toBe(false);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      await world.dispose();
    }
  });
});
