/**
 * Issue #95 lifecycle and advertised-bound regressions.
 * Independent oracles: Node child_process exit vs stdio close, frozen rpc.md v18.0.10.
 */
import { once } from "node:events";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  OmpProcess,
  OmpProtocolError,
} from "../src/sessions/omp/process.js";
import {
  createRpcHarness,
  DEFAULT_READY,
  emitIoFailure,
  type FakeChild,
  IO_ERROR_SOURCES,
  negotiateOk,
  observePromise,
  parseJsonl,
  RPC_LOGICAL_LIMIT,
  RPC_PHYSICAL_LIMIT,
  rpcChunkFrames,
  startFakeProcess,
} from "./support/omp-rpc.js";

const TOKEN = "wb-issue95-life-secret-token";
const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const ADVERTISED_PHYSICAL = 512 * 1024;
const ADVERTISED_LOGICAL = 2 * 1024 * 1024;
const TERMINAL: OmpFrame = { type: "agent_end", isTerminal: true, messages: [] };
const harness = createRpcHarness();

afterEach(() => {
  vi.useRealTimers();
});

describe("OmpProcess startup commit after a terminal event", () => {
  it("still reports readiness when the live child finishes handshake", async () => {
    const { proc, child } = await startFakeProcess(harness, TOKEN, { prefix: "omp-rpc-life-" });
    await expect(proc.send({ type: "abort" })).resolves.toBeUndefined();
    expect(child.exitCode).toBeNull();
  });

  for (const terminal of startupTerminals()) {
    it(`rejects start after successful get_state then ${terminal.name}`, async () => {
      const session = countedSession();
      queueSuccessfulStateThen(session.child, () => {
        terminal.apply(session.child);
      });
      const started = session.proc.start();

      await expectUnavailableNoRespawn(started, session);

      if (terminal.name === "native exit") {
        session.child.endStdout();
        await expect(harness.waitExit(session.proc)).resolves.toEqual({ code: 2, signal: null });
        expect(session.exits).toEqual([{ code: 2, signal: null }]);
      }
    });
  }

  it("rejects start when native exit precedes ready while stdout stays open", async () => {
    const session = countedSession();
    const started = session.proc.start();
    await session.spawned;
    session.child.nativeExit(3);
    await expectUnavailableNoRespawn(started, session);
    await expect(session.proc.send({ type: "abort" })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );
    session.child.endStdout();
    await expect(harness.waitExit(session.proc)).resolves.toEqual({ code: 3, signal: null });
    expect(session.exits).toEqual([{ code: 3, signal: null }]);
  });

  it("rejects start when native exit arrives during unresolved negotiation", async () => {
    const session = countedSession();
    const inbound = waitHandshake(session.child);
    const started = session.proc.start();
    await session.spawned;
    session.child.emitLine(DEFAULT_READY);
    await inbound.negotiate;
    session.child.nativeExit(4);
    await expectUnavailableNoRespawn(started, session);
    session.child.endStdout();
    await expect(harness.waitExit(session.proc)).resolves.toEqual({ code: 4, signal: null });
  });
  it("rejects start when native codes are already set before attach", async () => {
    const child = harness.fake();
    child.exitCode = 7;
    child.signalCode = null;
    const proc = harness.manage(
      new OmpProcess({
        ...harness.tempOpts(TOKEN, "omp-rpc-life-"),
        spawnImpl: child.spawnImpl,
      }),
    );
    const started = proc.start();
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(proc.start()).rejects.toMatchObject({ code: "agent_unavailable" });
  });
});

describe("OmpProcess native exit versus stdout completion", () => {
  it("drains complete buffered frames after native exit before public exit", async () => {
    const { child, proc, frames } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-life-",
    });
    const events: string[] = [];
    const publicExit = harness.waitExit(proc);
    proc.on("frame", (frame) => {
      events.push(String(frame.type));
    });
    proc.on("exit", () => {
      events.push("exit");
    });
    const drained = proc.request({ id: "drain-wait", type: "prompt", message: "wait" });
    const unanswered = proc.request({ id: "unanswered", type: "prompt", message: "hang" });
    const unansweredState = observePromise(unanswered);
    await waitImmediate();
    child.emitRaw('{"type":"notice","level":"info","message":"part');
    child.nativeExit(0);
    expect(unansweredState.outcome).toBe("pending");
    await expect(proc.send({ type: "prompt", message: "after-death" })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );

    child.emitRaw('ial"}\n');
    child.emitLine({
      id: "drain-wait",
      type: "response",
      command: "prompt",
      success: true,
      data: { result: "drained" },
    });
    child.emitLine(TERMINAL);
    await expect(drained).resolves.toMatchObject({ data: { result: "drained" } });
    expect(unansweredState.outcome).toBe("pending");
    child.stdout.emit("end");
    await expect(unanswered).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(publicExit).resolves.toEqual({ code: 0, signal: null });

    expect(frames).toContainEqual({ type: "notice", level: "info", message: "partial" });
    expect(frames).toContainEqual({
      id: "drain-wait",
      type: "response",
      command: "prompt",
      success: true,
      data: { result: "drained" },
    });
    expect(frames).toContainEqual(TERMINAL);
    expect(events.indexOf("agent_end")).toBeGreaterThan(-1);
    expect(events.indexOf("agent_end")).toBeLessThan(events.indexOf("exit"));
  });

  it("drains a chunk sequence that spans native exit", async () => {
    const { child, proc, frames } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-life-",
    });
    const chunks = rpcChunkFrames(
      Buffer.from(
        JSON.stringify({
          type: "notice",
          level: "info",
          message: "chunk-drain",
          pad: "x".repeat(RPC_PHYSICAL_LIMIT),
        }),
        "utf8",
      ),
      "span-exit",
    );
    const firstChunk = chunks[0];
    const rest = chunks.slice(1);
    if (firstChunk === undefined) {
      throw new Error("missing spanning chunk");
    }
    child.emitLine(firstChunk);
    child.nativeExit(0);
    await expect(proc.send({ type: "abort" })).rejects.toBeInstanceOf(AgentUnavailableError);
    for (const chunk of rest) {
      child.emitLine(chunk);
    }
    child.endStdout();
    await harness.waitExit(proc);
    expect(frames.some((frame) => frame.message === "chunk-drain")).toBe(true);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  it("does not write a UI cancel after native death while draining later frames", async () => {
    const { child, proc, frames } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-life-",
    });
    const written: OmpFrame[] = [];
    child.stdin.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        written.push(JSON.parse(line) as OmpFrame);
      }
    });
    const beforeDeath = written.length;
    child.nativeExit(0);
    child.emitLine({
      type: "extension_ui_request",
      id: "ui-after-death",
      method: "confirm",
    });
    child.emitLine(TERMINAL);
    child.endStdout();
    await harness.waitExit(proc);
    expect(written.slice(beforeDeath).some((frame) => frame.type === "extension_ui_response")).toBe(
      false,
    );
    expect(frames).toContainEqual(TERMINAL);
    expect(frames.some((frame) => frame.type === "extension_ui_request")).toBe(true);
  });

  it("treats child close as completion when FakeChild.exit leaves streams open", async () => {
    const { child, proc } = await startFakeProcess(harness, TOKEN, { prefix: "omp-rpc-life-" });
    const exits: OmpExit[] = [];
    proc.on("exit", (exit) => {
      exits.push(exit);
    });
    const pending = proc.request({ id: "close-fallback", type: "prompt", message: "wait" });
    child.exit(1);
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(exits).toEqual([{ code: 1, signal: null }]);
    await expect(proc.send({ type: "abort" })).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("does not resurrect transport after a terminal IO error", async () => {
    const { child, proc, frames } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-life-",
    });
    const pending = proc.request({ id: "io-dead", type: "prompt", message: "wait" });
    child.stdout.emit("error", new Error(`EPIPE ${TOKEN}`));
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    child.emitLine(TERMINAL);
    child.nativeExit(0);
    child.endStdout();
    await waitImmediate();
    expect(frames).not.toContainEqual(TERMINAL);
    await expect(proc.send({ type: "abort" })).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("preserves real fake-omp terminal output that arrives after native exit", {
    timeout: 15_000,
  }, async () => {
    const proc = harness.manage(
      new OmpProcess({
        ...harness.tempOpts(TOKEN, "omp-rpc-life-"),
        bin: FAKE,
      }),
    );
    const frames: OmpFrame[] = [];
    const events: string[] = [];
    proc.on("frame", (frame) => {
      frames.push(frame);
      events.push(String(frame.type));
    });
    proc.on("exit", () => {
      events.push("exit");
    });
    await proc.start();
    const child = proc.child;
    if (child === undefined) {
      throw new Error("missing fake-omp child");
    }
    harness.children.push(child);
    const closed = once(child, "close");
    let raw = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stdout.pause();
    child.once("exit", () => {
      child.stdout.resume();
    });
    await proc.send({ type: "prompt", id: "drain", message: "hello" });
    proc.closeInput();
    await closed;

    const wire = parseJsonl(raw);
    expect(wire.some((frame) => frame.type === "agent_end")).toBe(true);
    expect(frames.some((frame) => frame.type === "agent_end")).toBe(true);
    expect(events.indexOf("agent_end")).toBeLessThan(events.indexOf("exit"));
    expect(child.exitCode).toBe(0);
  });
});

describe("OmpProcess advertised bounds and handshake deadline", () => {
  it("rejects the omitted-option handshake at the overall 10000ms deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const session = countedSession();
    const inbound = waitHandshake(session.child);
    const started = session.proc.start();
    const observation = observePromise(started);
    await session.spawned;
    await waitImmediate();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(observation.outcome).toBe("pending");
    session.child.emitLine(DEFAULT_READY);
    const negotiate = await inbound.negotiate;

    await vi.advanceTimersByTimeAsync(4_000);
    session.child.emitLine(negotiateOk(String(negotiate.id)));
    await inbound.getState;
    expect(observation.outcome).toBe("pending");

    await vi.advanceTimersByTimeAsync(1_999);
    expect(observation.outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(observation.outcome).toBe("rejected");
    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
  });
  it("rejects inbound JSONL that fits the global physical cap but exceeds ready", async () => {
    const { child, proc, frames, errors } = await startWithAdvertisedLimits();
    const oversized: OmpFrame = {
      type: "notice",
      level: "info",
      message: "x".repeat(ADVERTISED_PHYSICAL),
    };
    const recovered: OmpFrame = { type: "notice", level: "info", message: "after-limit" };
    child.emitLine(oversized);
    await waitImmediate();
    expect(errors.some((error) => error instanceof OmpProtocolError)).toBe(true);
    expect(frames).not.toContainEqual(oversized);
    child.emitLine(recovered);
    await expect(
      harness.waitFrame(proc, (frame) => frame.message === "after-limit", 2_000, frames),
    ).resolves.toEqual(recovered);
  });
  it("rejects outbound frames that fit the global physical cap but exceed ready", async () => {
    const { proc } = await startWithAdvertisedLimits();
    await expect(
      proc.send({ type: "prompt", message: "x".repeat(ADVERTISED_PHYSICAL) }),
    ).rejects.toBeInstanceOf(OmpProtocolError);
  });

  it("rejects a completed logical object that fits 64MiB but exceeds ready", async () => {
    const { child, frames, errors } = await startWithAdvertisedLimits();
    const payload = Buffer.from(
      JSON.stringify({
        type: "notice",
        level: "info",
        message: "y".repeat(ADVERTISED_LOGICAL),
      }),
      "utf8",
    );
    expect(payload.byteLength).toBeGreaterThan(ADVERTISED_LOGICAL);
    expect(payload.byteLength).toBeLessThan(RPC_LOGICAL_LIMIT);
    await expectRejectedChunkEmission(
      child,
      rpcChunkFrames(payload, "over-ready-logical"),
      frames,
      errors,
    );
    expect(frames.some((frame) => frame.message === "y".repeat(ADVERTISED_LOGICAL))).toBe(false);
  });

  it("rejects a completed nested rpc_chunk envelope without emitting it", async () => {
    const { child, frames, errors } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-life-",
    });
    const nested: OmpFrame = {
      type: "rpc_chunk",
      chunkId: "inner-envelope",
      index: 0,
      count: 2,
      byteLength: RPC_PHYSICAL_LIMIT + 1,
      data: Buffer.from("{", "utf8").toString("base64"),
      pad: "z".repeat(RPC_PHYSICAL_LIMIT),
    };
    await expectRejectedChunkEmission(
      child,
      rpcChunkFrames(Buffer.from(JSON.stringify(nested), "utf8"), "outer-nested"),
      frames,
      errors,
    );
    expect(frames.some((frame) => frame.chunkId === "inner-envelope")).toBe(false);
  });
});

function startupTerminals(): { name: string; apply: (child: FakeChild) => void }[] {
  return [
    { name: "native exit", apply: (child) => child.nativeExit(2) },
    { name: "stdout end", apply: (child) => child.stdout.emit("end") },
    { name: "stdout close", apply: (child) => child.stdout.emit("close") },
    ...IO_ERROR_SOURCES.map((source) => ({
      name: `${source} error`,
      apply: (child: FakeChild) => {
        emitIoFailure(child, source, TOKEN);
      },
    })),
  ];
}

function countedSession(): {
  child: FakeChild;
  proc: OmpProcess;
  exits: OmpExit[];
  spawned: Promise<void>;
  spawnCount: () => number;
} {
  const child = harness.fake();
  let spawns = 0;
  let markSpawned: (() => void) | undefined;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(TOKEN, "omp-rpc-life-"),
      spawnImpl: (command, args, options) => {
        spawns += 1;
        const spawnedChild = child.spawnImpl(command, args, options);
        markSpawned?.();
        return spawnedChild;
      },
    }),
  );
  const exits: OmpExit[] = [];
  proc.on("exit", (exit) => {
    exits.push(exit);
  });
  return { child, proc, exits, spawned, spawnCount: () => spawns };
}

function queueSuccessfulStateThen(child: FakeChild, afterState: () => void): void {
  child.emitLine(DEFAULT_READY);
  child.replyHandshake({ afterState });
}

async function expectUnavailableNoRespawn(
  started: Promise<{ sessionFile: string }>,
  session: { proc: OmpProcess; spawnCount: () => number },
): Promise<void> {
  await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
  await expect(session.proc.start()).rejects.toMatchObject({ code: "agent_unavailable" });
  expect(session.spawnCount()).toBe(1);
}

async function expectRejectedChunkEmission(
  child: FakeChild,
  chunks: OmpFrame[],
  frames: OmpFrame[],
  errors: unknown[],
): Promise<void> {
  for (const chunk of chunks) {
    child.emitLine(chunk);
  }
  await waitImmediate();
  expect(errors.some((error) => error instanceof OmpProtocolError)).toBe(true);
  expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
}

function waitHandshake(child: FakeChild): {
  negotiate: Promise<OmpFrame>;
  getState: Promise<OmpFrame>;
} {
  const negotiate = new Promise<OmpFrame>((resolve) => {
    child.onCommand("negotiate_protocol", resolve);
  });
  const getState = new Promise<OmpFrame>((resolve) => {
    child.onCommand("get_state", resolve);
  });
  return { negotiate, getState };
}

async function startWithAdvertisedLimits(): Promise<{
  child: FakeChild;
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
}> {
  return startFakeProcess(harness, TOKEN, {
    prefix: "omp-rpc-life-",
    ready: {
      ...DEFAULT_READY,
      maxFrameBytes: ADVERTISED_PHYSICAL,
      maxReassembledFrameBytes: ADVERTISED_LOGICAL,
    },
  });
}
