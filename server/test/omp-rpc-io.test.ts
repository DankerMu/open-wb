/**
 * Issue #95 controlled-wire RPC cases. Independent literals from frozen rpc.md
 * v18.0.10 (33cc6b9) and the RpcFrameDecoder contract — not production code.
 */
import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import {
  AgentUnavailableError,
  type OmpExit,
  OmpProcess,
  OmpProtocolError,
} from "../src/sessions/omp/process.js";
import {
  capturePromptFrames,
  createRpcHarness,
  DEFAULT_READY,
  DEFAULT_SESSION,
  emitIoFailure,
  expectInterruptedRequest,
  expectProtocolError,
  type FakeChild,
  IO_ERROR_SOURCES,
  observePromise,
  openFakeProcess,
  RPC_CHUNK_PAYLOAD,
  RPC_LOGICAL_LIMIT,
  RPC_PHYSICAL_LIMIT,
  rpcChunkFrames,
  startFakeProcess,
} from "./support/omp-rpc.js";

const TOKEN = "wb-issue95-io-secret-token";
const PHYSICAL = RPC_PHYSICAL_LIMIT;
const LOGICAL = RPC_LOGICAL_LIMIT;
const CHUNK_PAYLOAD = RPC_CHUNK_PAYLOAD;
const SESSION = DEFAULT_SESSION;
const READY = DEFAULT_READY;
const harness = createRpcHarness();

function noticeWithInvalidUtf8(id: string, pad: string): Buffer {
  return Buffer.concat([
    Buffer.from(`{"type":"notice","id":"${id}","level":"info","message":"${pad}`, "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}', "utf8"),
  ]);
}

const utf8Recovered: OmpFrame = {
  type: "notice",
  id: "utf8-recovered",
  level: "info",
  message: "independent",
};

describe("OmpProcess controlled wire", () => {
  it("resolves two concurrent requests in reverse order only when id and command match", async () => {
    const { child, proc, frames } = await startWired();
    const sent: OmpFrame[] = [];
    const settlements: string[] = [];
    child.onCommand("prompt", (frame) => {
      sent.push(frame);
      if (sent.length !== 2) {
        return;
      }
      const first = sent[0];
      const second = sent[1];
      if (first === undefined || second === undefined) {
        throw new Error("missing concurrent requests");
      }
      const firstId = String(first.id);
      const secondId = String(second.id);
      queueMicrotask(() => {
        child.emitLine({
          id: firstId,
          type: "response",
          command: "different_command",
          success: true,
          data: { ignored: true },
        });
        child.emitLine({
          id: secondId,
          type: "response",
          command: "prompt",
          success: true,
          data: { result: "second" },
        });
        child.emitLine({
          id: firstId,
          type: "response",
          command: "prompt",
          success: true,
          data: { result: "first" },
        });
      });
    });
    const first = proc.request({ id: "first-request", type: "prompt", message: "first" });
    const second = proc.request({ id: "second-request", type: "prompt", message: "second" });
    void first.then(
      () => settlements.push("first"),
      () => {},
    );
    void second.then(
      () => settlements.push("second"),
      () => {},
    );

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        id: "first-request",
        type: "response",
        command: "prompt",
        success: true,
        data: { result: "first" },
      },
      {
        id: "second-request",
        type: "response",
        command: "prompt",
        success: true,
        data: { result: "second" },
      },
    ]);
    expect(sent.map((frame) => frame.id)).toEqual(["first-request", "second-request"]);
    expect(settlements).toEqual(["second", "first"]);
    expect(frames).toContainEqual({
      id: "first-request",
      type: "response",
      command: "different_command",
      success: true,
      data: { ignored: true },
    });
  });

  it("preserves a late same-id prompt failure as an observable frame", async () => {
    const { child, proc, frames } = await startWired();
    const ack: OmpFrame = {
      id: "req_1",
      type: "response",
      command: "prompt",
      success: true,
      data: { agentInvoked: true },
    };
    const late: OmpFrame = {
      id: "req_1",
      type: "response",
      command: "prompt",
      success: false,
      error: "scheduling failed",
    };
    const pending = proc.request({ id: "req_1", type: "prompt", message: "hi" });
    child.emitLine(ack);
    await expect(pending).resolves.toEqual(ack);
    child.emitLine(late);
    await harness.waitFrame(
      proc,
      (frame) => frame.id === "req_1" && frame.success === false,
      2_000,
      frames,
    );
    expect(frames.filter((frame) => frame.id === "req_1")).toEqual([ack, late]);
  });

  it("reassembles JSONL across split and coalesced pipe writes", async () => {
    const { child, proc, frames } = openChild();
    const readyLine = `${JSON.stringify(READY)}\n`;
    const notice: OmpFrame = { type: "notice", level: "info", message: "coalesced" };
    child.emitRaw(readyLine.slice(0, 12));
    child.emitRaw(`${readyLine.slice(12)}${JSON.stringify(notice)}\n`);
    child.replyHandshake();
    await expect(proc.start()).resolves.toEqual({ sessionFile: SESSION });
    expect(frames.some((frame) => frame.type === "ready")).toBe(true);
    expect(frames).toContainEqual(notice);
  });

  it("recovers from a malformed idle JSON line and still reads the next frame", async () => {
    const { child, proc, frames, errors } = openChild();
    child.emitRaw("{not-json\n");
    child.emitLine(READY);
    child.replyHandshake();
    await expect(proc.start()).resolves.toEqual({ sessionFile: SESSION });
    expectProtocolError(errors);
    expect(
      errors.every(
        (error) => !harness.includesSecret(error, TOKEN) && !String(error).includes("{not-json"),
      ),
    ).toBe(true);
    expect(frames.some((frame) => frame.type === "ready")).toBe(true);
  });

  it("discards an oversized unterminated line through its newline before resuming JSONL", async () => {
    const { child, proc, frames, errors } = await startWired();
    const discarded: OmpFrame = { type: "notice", level: "info", message: "oversized-tail" };
    const independent: OmpFrame = { type: "notice", level: "info", message: "independent" };
    child.emitRaw("x".repeat(PHYSICAL + 1));
    child.emitRaw(`${JSON.stringify(discarded)}\n`);
    child.emitLine(independent);

    await expect(
      harness.waitFrame(proc, (frame) => frame.message === "independent", 2_000, frames),
    ).resolves.toEqual(independent);
    expect(frames).not.toContainEqual(discarded);
    expectProtocolError(errors);
  });

  it("rejects a pending chunked response when malformed JSON abandons its sequence", async () => {
    const { child, proc, frames, errors } = await startWired();
    const id = "chunk-request";
    const chunks = rpcChunkFrames(
      Buffer.from(
        JSON.stringify({
          id,
          type: "response",
          command: "prompt",
          success: true,
          data: { pad: "x".repeat(PHYSICAL) },
        }),
        "utf8",
      ),
      "malformed-interrupt",
    );
    const pending = proc.request({ id, type: "prompt", message: "wait" });
    const observation = observePromise(pending);
    emitFirstChunk(child, chunks);
    child.emitRaw("{not-json\n");
    for (const chunk of chunks.slice(1)) {
      child.emitLine(chunk);
    }
    await Promise.resolve();

    expect(observation.outcome).toBe("rejected");
    await expectInterruptedRequest(pending, id, frames, errors);
  });

  it("rejects invalid rpc chunk metadata without emitting a partial frame", async () => {
    const { child, frames, errors } = await startWired();
    child.emitLine(invalidMetadata);

    expectProtocolError(errors);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  it("rejects invalid rpc chunk base64 without emitting a partial frame", async () => {
    const { child, frames, errors } = await startWired();
    child.emitLine(invalidBase64);

    expectProtocolError(errors);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  it("rejects decodable noncanonical rpc chunk base64", async () => {
    const { child, frames, errors } = await startWired();
    child.emitLine(noncanonicalBase64);

    expectProtocolError(errors);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  for (const invalidUtf8 of [
    { name: "physical JSONL", id: "utf8-physical", chunked: false },
    { name: "chunked logical", id: "utf8-logical", chunked: true },
  ] as const) {
    it(`rejects invalid UTF-8 in ${invalidUtf8.name} and still reads the next frame`, async () => {
      const { child, proc, frames, errors } = await startWired();
      const bytes = noticeWithInvalidUtf8(
        invalidUtf8.id,
        invalidUtf8.chunked ? "x".repeat(PHYSICAL) : "x",
      );
      if (invalidUtf8.chunked) {
        for (const chunk of rpcChunkFrames(bytes, "rpc-utf8")) {
          child.emitLine(chunk);
        }
      } else {
        child.stdout.write(Buffer.concat([bytes, Buffer.from("\n")]));
      }
      child.emitLine(utf8Recovered);

      await expect(
        harness.waitFrame(proc, (frame) => frame.id === utf8Recovered.id, 2_000, frames),
      ).resolves.toEqual(utf8Recovered);
      expectProtocolError(errors);
      expect(frames.some((frame) => frame.id === invalidUtf8.id)).toBe(false);
      expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
    });
  }

  it("rejects rpc chunk metadata beyond the logical limit", async () => {
    const { child, frames, errors } = await startWired();
    child.emitLine(oversizeLogical);

    expectProtocolError(errors);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  it("sanitizes malformed reassembled JSON without exposing payload text", async () => {
    const { child, frames, errors } = await startWired();
    const secret = "ZXSECRET";
    const chunks = rpcChunkFrames(
      Buffer.from(`${secret}${"x".repeat(PHYSICAL)}`, "utf8"),
      "bad-json",
    );
    for (const chunk of chunks) {
      child.emitLine(chunk);
    }

    expectProtocolError(errors);
    expect(
      errors.every((error) => error instanceof Error && !harness.includesSecret(error, secret)),
    ).toBe(true);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
  });

  it("discards a normal frame that interrupts chunks before accepting the next frame", async () => {
    const { child, proc, frames, errors } = await startWired();
    const interrupt: OmpFrame = { type: "notice", level: "info", message: "interrupt" };
    child.emitLine(firstChunk);
    child.emitLine(interrupt);
    child.emitLine(afterInterrupt);

    await expect(
      harness.waitFrame(proc, (frame) => frame.message === "independent", 2_000, frames),
    ).resolves.toEqual(afterInterrupt);
    expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
    expect(frames).not.toContainEqual(interrupt);
    expect(frames).toContainEqual(afterInterrupt);
    expectProtocolError(errors);
  });

  it("rejects oversized unchunked outbound frames and write failures", async () => {
    const { child, proc } = await startWired();
    const oversized: OmpFrame = { type: "prompt", message: "x".repeat(PHYSICAL) };
    await expect(proc.send(oversized)).rejects.toBeInstanceOf(OmpProtocolError);
    child.failWrites(new Error(`EPIPE ${TOKEN}`));
    await expect(proc.send({ type: "abort" })).rejects.toSatisfy(
      (error) => error instanceof Error && !harness.includesSecret(error, TOKEN),
    );
  });

  it("keeps request ids usable after synchronous and late write failures", async () => {
    const { child, proc } = await startWired();
    const write = child.stdin.write;
    child.stdin.write = (() => {
      throw new Error(`EPIPE ${TOKEN}`);
    }) as typeof child.stdin.write;
    let failed: Promise<OmpFrame>;
    try {
      failed = proc.request({ id: "write-id", type: "prompt", message: "fail" });
    } catch (error) {
      child.emitLine({ id: "write-id", type: "response", command: "prompt", success: true });
      throw error;
    }
    await expect(failed).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(proc.send({ type: "prompt", message: "send" })).rejects.toBeInstanceOf(
      AgentUnavailableError,
    );

    let late: ((error?: Error | null) => void) | undefined;
    child.stdin.write = ((_chunk, encodingOrCallback, callback) => {
      late = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
      return true;
    }) as typeof child.stdin.write;
    const first = proc.request({ id: "write-id", type: "prompt", message: "first" });
    child.emitLine({ id: "write-id", type: "response", command: "prompt", success: true });
    await expect(first).resolves.toMatchObject({ success: true });
    child.stdin.write = write;
    const second = proc.request({ id: "write-id", type: "prompt", message: "second" });
    if (late === undefined) {
      throw new Error("missing write callback");
    }
    late(new Error(`EPIPE ${TOKEN}`));
    await Promise.resolve();
    child.emitLine({ id: "write-id", type: "response", command: "prompt", success: true });
    await expect(second).resolves.toMatchObject({ success: true });
  });

  it("rejects a duplicate explicit request id before writing it", async () => {
    const { child, proc } = await startWired();
    const written = capturePromptFrames(child);
    const first = proc.request({ id: "explicit-id", type: "prompt", message: "first" });
    const duplicate = proc.request({ id: "explicit-id", type: "prompt", message: "duplicate" });
    void first.catch(() => {});
    void duplicate.catch(() => {});
    await Promise.resolve();

    expect(written).toHaveLength(1);
    await expect(duplicate).rejects.toBeInstanceOf(OmpProtocolError);
    child.emitLine({
      id: "explicit-id",
      type: "response",
      command: "prompt",
      success: true,
      data: { result: "first" },
    });
    await expect(first).resolves.toMatchObject({ data: { result: "first" } });
  });

  it("generates an id that avoids an outstanding supplied id", async () => {
    const { child, proc } = await startWired();
    const written = capturePromptFrames(child);
    const supplied = proc.request({ id: "omp-3", type: "prompt", message: "supplied" });
    const generated = proc.request({ type: "prompt", message: "generated" });
    void supplied.catch(() => {});
    void generated.catch(() => {});
    await Promise.resolve();

    expect(written).toHaveLength(2);
    const generatedId = written[1]?.id;
    expect(typeof generatedId).toBe("string");
    expect(generatedId).not.toBe("omp-3");
    expect(written[0]?.id).toBe("omp-3");
    child.emitLine({
      id: generatedId,
      type: "response",
      command: "prompt",
      success: true,
      data: { result: "generated" },
    });
    child.emitLine({
      id: "omp-3",
      type: "response",
      command: "prompt",
      success: true,
      data: { result: "supplied" },
    });
    await expect(Promise.all([supplied, generated])).resolves.toEqual([
      {
        id: "omp-3",
        type: "response",
        command: "prompt",
        success: true,
        data: { result: "supplied" },
      },
      {
        id: generatedId,
        type: "response",
        command: "prompt",
        success: true,
        data: { result: "generated" },
      },
    ]);
  });

  it("rejects a pending request when stdout closes", async () => {
    const { child, proc } = await startWired();
    const pending = proc.request({ id: "close-pending", type: "prompt", message: "wait" });
    const observation = observePromise(pending);
    child.stdout.emit("close");
    await Promise.resolve();

    expect(observation.settlements).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("rejects a pending request when stdout ends cleanly", async () => {
    const { child, proc } = await startWired();
    const pending = proc.request({ id: "end-pending", type: "prompt", message: "wait" });
    const observation = observePromise(pending);
    child.endStdout();
    await waitImmediate();

    expect(observation.settlements).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("rejects a pending request when stdout ends with truncated chunks", async () => {
    const { child, proc, frames, errors } = await startWired();
    const id = "truncated-request";
    const chunks = rpcChunkFrames(
      Buffer.from(
        JSON.stringify({
          id,
          type: "response",
          command: "prompt",
          success: true,
          data: { pad: "x".repeat(PHYSICAL) },
        }),
        "utf8",
      ),
      "truncated",
    );
    const pending = proc.request({ id, type: "prompt", message: "wait" });
    const observation = observePromise(pending);
    emitFirstChunk(child, chunks);
    child.endStdout();
    await waitImmediate();

    expect(observation.settlements).toBe(1);
    await expectInterruptedRequest(pending, id, frames, errors);
  });

  it("rejects failed protocol negotiation without fabricating a session", async () => {
    const { child, proc, errors } = openChild();
    child.emitLine(READY);
    child.onCommand("negotiate_protocol", (frame) => {
      child.emitLine({
        id: String(frame.id),
        type: "response",
        command: "negotiate_protocol",
        success: false,
        error: `unsupported ${TOKEN}`,
      });
    });

    await expect(proc.start()).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(errors.every((error) => !harness.includesSecret(error, TOKEN))).toBe(true);
  });

  it("rejects an empty get_state sessionFile", async () => {
    const { child, proc } = openChild();
    child.emitLine(READY);
    child.replyHandshake({ sessionFile: "" });

    await expect(proc.start()).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  it("rejects startup when the child exits before readiness", async () => {
    const { child, proc } = openChild();
    const started = proc.start();
    child.exit(1);

    await expect(started).rejects.toBeInstanceOf(AgentUnavailableError);
  });

  for (const source of IO_ERROR_SOURCES) {
    it(`observes and sanitizes ${source} errors while settling a request once`, async () => {
      const { child, proc, errors } = await startWired();
      const pending = proc.request({ id: `${source}-pending`, type: "prompt", message: "wait" });
      const observation = observePromise(pending);
      emitIoFailure(child, source, TOKEN);
      await Promise.resolve();

      expect(observation.settlements).toBe(1);
      await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(AgentUnavailableError);
      expect(harness.includesSecret(errors[0], TOKEN)).toBe(false);
    });
  }

  it("settles a request once across terminal stream and child notifications", async () => {
    const { child, proc, errors } = await startWired();
    const pending = proc.request({ id: "terminal-pending", type: "prompt", message: "wait" });
    const observation = observePromise(pending);
    child.stdout.emit("error", new Error(`EIO ${TOKEN}`));
    child.endStdout();
    child.stdout.emit("close");
    child.exit(1);
    child.stderr.emit("error", new Error(`EIO ${TOKEN}`));
    await waitImmediate();

    expect(observation.settlements).toBe(1);
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(errors).toHaveLength(1);
    expect(harness.includesSecret(errors[0], TOKEN)).toBe(false);
  });

  it("ignores coalesced stdout frames after a terminal IO error", async () => {
    const { child, proc, frames } = await startWired();
    const pending = proc.request({ id: "late-pending", type: "prompt", message: "wait" });
    observePromise(pending);
    const lateReady: OmpFrame = { ...READY, maxFrameBytes: PHYSICAL - 1 };
    const lateResponse: OmpFrame = {
      id: "late-pending",
      type: "response",
      command: "prompt",
      success: true,
    };
    const lateNotice: OmpFrame = { type: "notice", level: "info", message: "late" };
    child.stdout.emit("error", new Error(`EPIPE ${TOKEN}`));
    child.emitRaw(
      `${JSON.stringify(lateReady)}\n${JSON.stringify(lateResponse)}\n${JSON.stringify(lateNotice)}\n`,
    );
    await waitImmediate();

    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(frames).not.toContainEqual(lateReady);
    expect(frames).not.toContainEqual(lateResponse);
    expect(frames).not.toContainEqual(lateNotice);
  });
  it("settles pending requests when the child exits and reports the original signal", async () => {
    const { child, proc } = await startWired();
    const exits: OmpExit[] = [];
    proc.on("exit", (exit) => {
      exits.push(exit);
    });
    const pending = proc.request({ id: "req_wait", type: "prompt", message: "hang" });
    child.exit(null, "SIGTERM");
    await expect(pending).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(exits).toEqual([{ code: null, signal: "SIGTERM" }]);
  });

  it("rejects spawn failures without fabricating readiness", async () => {
    const proc = harness.manage(
      new OmpProcess({
        ...harness.tempOpts(TOKEN, "omp-rpc-io-"),
        spawnImpl: () => {
          throw new Error(`ENOENT ${TOKEN}`);
        },
      }),
    );
    await expect(proc.start()).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(proc.start()).rejects.toSatisfy((error) => !harness.includesSecret(error, TOKEN));
  });
});

const firstChunk: OmpFrame = {
  type: "rpc_chunk",
  chunkId: "rpc-1",
  index: 0,
  count: 2,
  byteLength: PHYSICAL + 1,
  data: Buffer.from("{", "utf8").toString("base64"),
};
const afterInterrupt: OmpFrame = { type: "notice", level: "info", message: "independent" };
const invalidMetadata: OmpFrame = {
  type: "rpc_chunk",
  chunkId: "",
  index: 0,
  count: 5,
  byteLength: PHYSICAL + 1,
  data: Buffer.from("{", "utf8").toString("base64"),
};
const invalidBase64: OmpFrame = {
  type: "rpc_chunk",
  chunkId: "rpc-b64",
  index: 0,
  count: 2,
  byteLength: PHYSICAL + 1,
  data: "***not-base64***",
};

const noncanonicalBase64: OmpFrame = {
  type: "rpc_chunk",
  chunkId: "rpc-noncanonical",
  index: 0,
  count: 2,
  byteLength: PHYSICAL + 1,
  data: "ew",
};
const oversizeLogical: OmpFrame = {
  type: "rpc_chunk",
  chunkId: "rpc-limit",
  index: 0,
  count: 2,
  byteLength: LOGICAL + 1,
  data: Buffer.alloc(CHUNK_PAYLOAD, 0x61).toString("base64"),
};

function emitFirstChunk(child: FakeChild, chunks: OmpFrame[]): void {
  const initialChunk = chunks[0];
  if (initialChunk === undefined) {
    throw new Error("missing initial chunk");
  }
  child.emitLine(initialChunk);
}

function openChild(options: { handshakeTimeoutMs?: number } = {}): {
  child: FakeChild;
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
} {
  return openFakeProcess(harness, TOKEN, options);
}

async function startWired(): Promise<{
  child: FakeChild;
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
}> {
  return startFakeProcess(harness, TOKEN);
}
