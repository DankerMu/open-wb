/**
 * Issue #652 production wiring of the handshake-timeout record (design L2): the pure
 * `appAssemblyOf(config)` seam the main path hands to createApp. Oracles: the assembly's runtime
 * equals `sessionRuntimeOf(config)`, and process.stderr/stdout write spies (callback honoured).
 */
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appAssemblyOf, resolveServerConfig, sessionRuntimeOf } from "../src/server.js";
import { settle } from "./session-approval-helpers.js";
import { collectRejections } from "./session-stop-helpers.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const ENTRY = pathToFileURL(join(REPO_ROOT, "server", "src", "server.ts")).href;
const RECORD = {
  event: "omp_handshake_timeout",
  sessionId: "0123456789abcdef0123456789abcdef",
  reason: "handshake timeout",
  elapsedMs: 10_004,
} as const;

type WriteCallback = (error?: Error | null) => void;

/** Captures writes without reaching the terminal; the callback settles the managed writer. */
function spyWrites(stream: NodeJS.WriteStream, fail?: Error) {
  return vi.spyOn(stream, "write").mockImplementation(((_chunk: unknown, ...rest: unknown[]) => {
    const callback = rest.find((arg): arg is WriteCallback => typeof arg === "function");
    callback?.(fail ?? null);
    return true;
  }) as typeof stream.write);
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
