import { fstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRangeStream, parseRange, type RangeResult } from "../src/workspaces/preview.js";
import {
  collectBytes,
  waitForClose,
  waitForOpen,
  workspaceTempDir,
} from "./workspace-file-helpers.js";

type RangeRow = [header: string | undefined, size: number, expected: RangeResult];

/** The ten inputs of the workspaces scenario 「嗅探与范围解析」, size = 1000, in spec order. */
const SPEC_ROWS: RangeRow[] = [
  ["bytes=0-99", 1000, { start: 0, end: 99 }],
  ["bytes=900-", 1000, { start: 900, end: 999 }],
  ["bytes=-100", 1000, { start: 900, end: 999 }],
  ["bytes=990-2000", 1000, { start: 990, end: 999 }],
  ["bytes=1000-", 1000, "unsatisfiable"],
  ["bytes=-0", 1000, "unsatisfiable"],
  ["bytes=5-2", 1000, "ignore"],
  ["bytes=0-1,5-6", 1000, "ignore"],
  ["items=0-1", 1000, "ignore"],
  ["bytes= 0-1", 1000, "ignore"],
];

/** Branches the spec leaves open; the simplest reading is pinned here. */
const CHOSEN_ROWS: RangeRow[] = [
  [undefined, 1000, "ignore"],
  ["", 1000, "ignore"],
  ["bytes=-", 1000, "ignore"],
  ["Bytes=0-1", 1000, "ignore"],
  // Not trimmed: whitespace around the header is as foreign as whitespace inside it.
  [" bytes=0-1", 1000, "ignore"],
  ["bytes=0-1 ", 1000, "ignore"],
  ["bytes=007-0009", 1000, { start: 7, end: 9 }],
  ["bytes=-1500", 1000, { start: 0, end: 999 }],
  // Syntax and a > b are judged before satisfiability.
  ["bytes=1000-999", 1000, "ignore"],
  ["items=0-1", 0, "ignore"],
  ["bytes=0-", 0, "unsatisfiable"],
  ["bytes=-5", 0, "unsatisfiable"],
  ["bytes=999-999", 1000, { start: 999, end: 999 }],
];

describe("parseRange", () => {
  it.each(SPEC_ROWS)("spec row %j of size %i", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });

  it.each(CHOSEN_ROWS)("chosen branch %j of size %i", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe("openRangeStream", () => {
  /** 64 bytes, each equal to its own offset. */
  function indexedFile(): string {
    const path = join(workspaceTempDir(), "clip.mp4");
    writeFileSync(path, Buffer.from(Array.from({ length: 64 }, (_, index) => index)));
    return path;
  }

  it("yields exactly bytes 10 through 19 of the file, both ends included", async () => {
    const bytes = await collectBytes(openRangeStream(indexedFile(), 10, 19));
    expect(bytes).toEqual(Buffer.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
    expect(bytes.length).toBe(10);
  });

  it("releases the descriptor once the interval has been read to its end", async () => {
    const stream = openRangeStream(indexedFile(), 10, 19);
    const opened = waitForOpen(stream);
    const closed = waitForClose(stream);
    expect((await collectBytes(stream)).length).toBe(10);
    await closed;
    const fd = await opened;
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("releases the descriptor when destroyed before the interval is read", async () => {
    const stream = openRangeStream(indexedFile(), 10, 19);
    const closed = waitForClose(stream);
    const fd = await waitForOpen(stream);
    stream.destroy();
    await closed;
    expect(() => fstatSync(fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it("rejects with ENOENT for a missing path and still closes, never an empty body", async () => {
    const stream = openRangeStream(join(workspaceTempDir(), "gone.mp4"), 10, 19);
    const closed = waitForClose(stream);
    await expect(collectBytes(stream)).rejects.toMatchObject({ code: "ENOENT" });
    await closed;
  });
});
