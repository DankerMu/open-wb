/**
 * Issue #95 RPC handshake against the real fake-omp subprocess.
 * Independent oracles: fake-omp.mjs scenario contract and frozen rpc.md v18.0.10.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { type OmpExit, OmpProcess, type SpawnImpl } from "../src/sessions/omp/process.js";
import {
  asRecord,
  createRpcHarness,
  DEFAULT_SESSION,
  hasTerminated,
  parseJsonl,
} from "./support/omp-rpc.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const TOKEN = "wb-issue95-secret-token-do-not-leak";
const UI_ID = "ui-confirm-1";
const THREE_MIB = 3 * 1024 * 1024;
const UNICODE_PAD = "你好".repeat(Math.ceil((THREE_MIB + 4096) / 6));
const PROMPT: OmpFrame = { id: "req_1", type: "prompt", message: "Summarize this repo" };
const harness = createRpcHarness();

describe("OmpProcess handshake with fake-omp", () => {
  it("resolves start with sessionFile after ready, v2 negotiate, and get_state", async () => {
    const fake = launchFake();
    const proc = harness.manage(
      new OmpProcess({ ...harness.tempOpts(TOKEN), spawnImpl: fake.spawnImpl }),
    );
    const frames = harness.collectFrames(proc);
    const first = await proc.start();
    expect(first).toEqual({ sessionFile: DEFAULT_SESSION });
    const second = await proc.start();
    expect(second).toBe(first);
    expect(fake.spawns).toBe(1);

    const inbound = parseJsonl(fake.writes());
    const negotiate = inbound.find((frame) => frame.type === "negotiate_protocol");
    const state = inbound.find((frame) => frame.type === "get_state");
    expect(negotiate).toMatchObject({ protocolVersion: 2 });
    expect(typeof negotiate?.id).toBe("string");
    expect(typeof state?.id).toBe("string");
    expect(state?.id).not.toBe(negotiate?.id);
    expect(inbound.findIndex((frame) => frame.type === "negotiate_protocol")).toBeLessThan(
      inbound.findIndex((frame) => frame.type === "get_state"),
    );

    expect(frames.some((frame) => frame.type === "ready")).toBe(true);
    expect(
      frames.some(
        (frame) =>
          frame.type === "response" &&
          frame.command === "negotiate_protocol" &&
          frame.id === negotiate?.id &&
          frame.success === true,
      ),
    ).toBe(true);
    const stateFrame = frames.find(
      (frame) =>
        frame.type === "response" && frame.command === "get_state" && frame.id === state?.id,
    );
    expect(asRecord(stateFrame?.data).sessionFile).toBe(DEFAULT_SESSION);
  });

  it("rejects no-ready startup as agent_unavailable and terminates the child", async () => {
    const { observed, spawns, proc } = await expectFailedStart("no-ready", 80);
    expect(spawns).toBe(1);
    expect(proc.child === undefined || hasTerminated(proc.child)).toBe(true);
    expect(observed.code !== undefined || observed.signal !== undefined).toBe(true);
    await expect(proc.start()).rejects.toMatchObject({ code: "agent_unavailable" });
    expect(spawns).toBe(1);
  });

  it("rejects missing sessionFile as agent_unavailable and terminates the child", async () => {
    const { proc } = await expectFailedStart("missing-session");
    expect(hasTerminated(proc.child)).toBe(true);
  });

  it("reassembles a chunked Unicode get_state into the original object", {
    timeout: 30_000,
  }, async () => {
    const fake = launchFake("chunked");
    const proc = harness.manage(
      new OmpProcess({ ...harness.tempOpts(TOKEN), spawnImpl: fake.spawnImpl }),
    );
    const frames = harness.collectFrames(proc);
    await expect(proc.start()).resolves.toEqual({ sessionFile: DEFAULT_SESSION });
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
    const state = frames.find(
      (frame) =>
        frame.type === "response" && frame.command === "get_state" && frame.success === true,
    );
    expect(state).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeGreaterThan(THREE_MIB);
    expect(asRecord(state?.data).sessionFile).toBe(DEFAULT_SESSION);
    expect(asRecord(state?.data).pad).toBe(UNICODE_PAD);
  });

  it("rejects interleaved chunk handshake without reporting readiness", {
    timeout: 30_000,
  }, async () => {
    const { frames } = await expectFailedStart("interleaved", 250);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
    expect(
      frames.some(
        (frame) =>
          frame.type === "response" &&
          frame.command === "get_state" &&
          frame.success === true &&
          typeof asRecord(frame.data).sessionFile === "string" &&
          String(asRecord(frame.data).sessionFile).length > 0,
      ),
    ).toBe(false);
  });

  it("cancels extension UI immediately and lets the turn finish", { timeout: 10_000 }, async () => {
    const fake = launchFake("extension-ui");
    const proc = harness.manage(
      new OmpProcess({ ...harness.tempOpts(TOKEN), spawnImpl: fake.spawnImpl }),
    );
    const frames = harness.collectFrames(proc);
    await proc.start();
    await proc.send(PROMPT);
    await harness.waitFrame(
      proc,
      (frame) => frame.type === "agent_end" && frame.isTerminal !== false,
    );
    const inbound = parseJsonl(fake.writes());
    expect(inbound).toContainEqual({
      type: "extension_ui_response",
      id: UI_ID,
      cancelled: true,
    });
    const uiIndex = inbound.findIndex(
      (frame) => frame.type === "extension_ui_response" && frame.id === UI_ID,
    );
    const promptIndex = inbound.findIndex((frame) => frame.type === "prompt");
    expect(uiIndex).toBeGreaterThan(promptIndex);
    expect(
      frames.some((frame) => frame.type === "extension_ui_request" && frame.id === UI_ID),
    ).toBe(true);
  });

  it("observes a crashed child exit code exactly once", async () => {
    const fake = launchFake("crash");
    const proc = harness.manage(
      new OmpProcess({ ...harness.tempOpts(TOKEN), spawnImpl: fake.spawnImpl }),
    );
    const exits: OmpExit[] = [];
    proc.on("exit", (exit) => {
      exits.push(exit);
    });
    await proc.start();
    await proc.send(PROMPT);
    await harness.waitExit(proc);
    expect(exits).toEqual([{ code: 2, signal: null }]);
  });
});

async function expectFailedStart(
  scenario: string,
  handshakeTimeoutMs?: number,
): Promise<{ observed: OmpExit; spawns: number; proc: OmpProcess; frames: OmpFrame[] }> {
  const fake = launchFake(scenario);
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(TOKEN),
      spawnImpl: fake.spawnImpl,
      ...(handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs }),
    }),
  );
  const frames = harness.collectFrames(proc);
  const exit = harness.waitExit(proc);
  const started = proc.start();
  await expect(started).rejects.toMatchObject({ code: "agent_unavailable" });
  await expect(started).rejects.toSatisfy((error) => !harness.includesSecret(error, TOKEN));
  return { observed: await exit, spawns: fake.spawns, proc, frames };
}

function launchFake(scenario?: string): {
  spawnImpl: SpawnImpl;
  spawns: number;
  writes: () => string;
} {
  const launched = { spawns: 0, written: "" };
  return {
    get spawns() {
      return launched.spawns;
    },
    writes: () => launched.written,
    spawnImpl: (_command, args, options) => {
      launched.spawns += 1;
      const extra = scenario === undefined ? [] : ["--scenario", scenario];
      const child = spawn(process.execPath, [FAKE, ...args, ...extra], {
        cwd: typeof options.cwd === "string" ? options.cwd : undefined,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      harness.children.push(child);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
        launched.written += toText(chunk, encoding);
        return write(chunk as string & Uint8Array, encoding as BufferEncoding, cb as () => void);
      }) as typeof child.stdin.write;
      return child;
    },
  };
}

function toText(chunk: unknown, encoding: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString(
      typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
    );
  }
  return "";
}
