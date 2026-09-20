/**
 * Issue #95 rpc chunk envelope integrity at the public OmpProcess boundary.
 * Independent literals from frozen rpc.md v18.0.10 — not production code.
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { type OmpProcess, OmpProtocolError } from "../src/sessions/omp/process.js";
import {
  createRpcHarness,
  type FakeChild,
  RPC_PHYSICAL_LIMIT,
  rpcChunkFrames,
  startFakeProcess,
} from "./support/omp-rpc.js";

const TOKEN = "wb-issue95-frame-secret-token";
const PHYSICAL = RPC_PHYSICAL_LIMIT;
const harness = createRpcHarness();

const envelopeRecovered: OmpFrame = {
  type: "notice",
  id: "envelope-recovered",
  level: "info",
  message: "independent",
};

function largeNotice(id: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "notice",
      id,
      level: "info",
      message: "x".repeat(PHYSICAL),
    }),
    "utf8",
  );
}

async function expectRejectedChunks(
  child: FakeChild,
  proc: OmpProcess,
  frames: OmpFrame[],
  errors: unknown[],
  chunks: OmpFrame[],
  offendingId: string,
): Promise<void> {
  for (const chunk of chunks) {
    child.emitLine(chunk);
  }
  child.emitLine(envelopeRecovered);

  await expect(
    harness.waitFrame(proc, (frame) => frame.id === envelopeRecovered.id, 2_000, frames),
  ).resolves.toEqual(envelopeRecovered);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every((error) => error instanceof OmpProtocolError)).toBe(true);
  expect(frames.some((frame) => frame.id === offendingId)).toBe(false);
  expect(frames.some((frame) => frame.type === "rpc_chunk")).toBe(false);
}

describe("OmpProcess rpc chunk envelope integrity", () => {
  for (const field of ["chunkId", "count", "byteLength", "index"] as const) {
    it(`rejects a completed sequence whose second envelope changes ${field} and still reads the next frame`, async () => {
      const { child, proc, frames, errors } = await startFakeProcess(harness, TOKEN, {
        prefix: "omp-rpc-frame-",
      });
      const offendingId = `envelope-${field}`;
      const chunks = rpcChunkFrames(largeNotice(offendingId), "rpc-envelope");
      const second = chunks[1];
      if (second === undefined) {
        throw new Error("missing second envelope");
      }
      if (field === "chunkId") {
        second.chunkId = "other-envelope";
      } else {
        second[field] = Number(second[field]) + 1;
      }
      await expectRejectedChunks(child, proc, frames, errors, chunks, offendingId);
    });
  }

  it("rejects a completed sequence that overstates every envelope byteLength and still reads the next frame", async () => {
    const { child, proc, frames, errors } = await startFakeProcess(harness, TOKEN, {
      prefix: "omp-rpc-frame-",
    });
    const offendingId = "envelope-final-length";
    const chunks = rpcChunkFrames(largeNotice(offendingId), "rpc-envelope-length");
    for (const chunk of chunks) {
      chunk.byteLength = Number(chunk.byteLength) + 1;
    }
    await expectRejectedChunks(child, proc, frames, errors, chunks, offendingId);
  });
});
