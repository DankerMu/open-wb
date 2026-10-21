/**
 * Issue #1592 (change omp-stdout-tee-guard): the stdout tee the official tests listen to omp's child
 * with (`teeStdoutFrames`, support/omp-official.ts) — omp-runtime「overlay 固定块 advisor / ida 钉的真实
 * omp 回归」, scenario「stdout tee 容错非 JSON 行」. Default suite, no binary: a `PassThrough` stands in
 * for the child's stdout and receives Buffers, as `child.stdout` does. Each WHEN of the scenario is
 * one case on a fresh stream (its own malformed delta), and the last case replays them in order on
 * one stream with the scenario's absolute counts.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { teeStdoutFrames } from "./support/omp-official.js";

interface Tee {
  frames: OmpFrame[];
  malformed(): number;
  /** Writes one chunk and waits until the stream has emitted it. */
  feed(chunk: string | Buffer): Promise<void>;
}

function openTee(): Tee {
  const stream = new PassThrough();
  const frames: OmpFrame[] = [];
  const { malformed } = teeStdoutFrames(stream, (frame) => frames.push(frame));
  return {
    frames,
    malformed,
    feed: async (chunk) => {
      stream.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      await new Promise(setImmediate);
    },
  };
}

const BAD_LINE = '{"type":"a"}\nnot json\n{"type":"b"}\n';
const HALVES = ['{"ty', 'pe":"c"}\n'];
const TRUNCATED = '{"type":"d"\n{"type":"e"}\n';
const NON_OBJECT = "null\n\n  \n";
/** `{"type":"中"}\n` cut after the first byte of the three-byte `中` (E4 B8 AD). */
const WIDE = Buffer.from('{"type":"中"}\n');
const WIDE_CUT = WIDE.indexOf(0xe4) + 1;
const WIDE_HALVES = [WIDE.subarray(0, WIDE_CUT), WIDE.subarray(WIDE_CUT)];

describe("teeStdoutFrames: stdout tee tolerating non-JSON lines", () => {
  it("skips and counts a bad line, keeping the frames around it in order", async () => {
    const tee = openTee();
    await tee.feed(BAD_LINE);
    expect(tee.frames).toEqual([{ type: "a" }, { type: "b" }]);
    expect(tee.malformed()).toBe(1);
  });

  it("joins a line cut across two chunks into one frame", async () => {
    const tee = openTee();
    for (const half of HALVES) {
      await tee.feed(half);
    }
    expect(tee.frames).toEqual([{ type: "c" }]);
    expect(tee.malformed()).toBe(0);
  });

  it("skips and counts a truncated line, keeping the next frame", async () => {
    const tee = openTee();
    await tee.feed(TRUNCATED);
    expect(tee.frames).toEqual([{ type: "e" }]);
    expect(tee.malformed()).toBe(1);
  });

  it("counts a non-object line as malformed and skips blank lines uncounted", async () => {
    const tee = openTee();
    await tee.feed(NON_OBJECT);
    expect(tee.frames).toEqual([]);
    expect(tee.malformed()).toBe(1);
  });

  it("joins a multi-byte character cut across two chunks", async () => {
    expect(WIDE_HALVES[0]?.at(-1)).toBe(0xe4);
    const tee = openTee();
    for (const half of WIDE_HALVES) {
      await tee.feed(half);
    }
    expect(tee.frames).toEqual([{ type: "中" }]);
    expect(tee.malformed()).toBe(0);
  });

  it("runs the scenario in order on one stream with its absolute counts", async () => {
    const tee = openTee();
    await tee.feed(BAD_LINE);
    expect(tee.frames.map((frame) => frame.type)).toEqual(["a", "b"]);
    expect(tee.malformed()).toBe(1);
    for (const half of HALVES) {
      await tee.feed(half);
    }
    expect(tee.frames.map((frame) => frame.type)).toEqual(["a", "b", "c"]);
    expect(tee.malformed()).toBe(1);
    await tee.feed(TRUNCATED);
    expect(tee.frames.map((frame) => frame.type)).toEqual(["a", "b", "c", "e"]);
    expect(tee.malformed()).toBe(2);
    await tee.feed(NON_OBJECT);
    expect(tee.frames).toHaveLength(4);
    expect(tee.malformed()).toBe(3);
    for (const half of WIDE_HALVES) {
      await tee.feed(half);
    }
    expect(tee.frames.map((frame) => frame.type)).toEqual(["a", "b", "c", "e", "中"]);
    expect(tee.malformed()).toBe(3);
  });
});
