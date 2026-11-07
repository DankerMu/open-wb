/**
 * #1878（verification-harness「轮询读取并发追加的 JSONL 时只解析已结束的行」）：`readCompleteJsonl` 的自测。
 * 假 rclone / 假 `fusermount3` 在另一个进程里追加记录，测试轮询时可能读到一行的前半段；这里用确定性的文件内容
 * 摆出那个时刻，不依赖真实竞态。期望值是写进文件的字面量。
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCompleteJsonl } from "./support/jsonl.mjs";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-jsonl-"));
  file = join(dir, "calls.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readCompleteJsonl", () => {
  it("returns [] when the file does not exist", () => {
    expect(readCompleteJsonl(file)).toEqual([]);
  });

  it("drops an unterminated trailing segment, and reads it once its newline lands", () => {
    writeFileSync(file, '{"argv":["rclone","mount"],"pid":11}\n{"argv":["rclone","mo');
    expect(readCompleteJsonl(file)).toEqual([{ argv: ["rclone", "mount"], pid: 11 }]);

    appendFileSync(file, 'unt"],"pid":12}\n');
    expect(readCompleteJsonl(file)).toEqual([
      { argv: ["rclone", "mount"], pid: 11 },
      { argv: ["rclone", "mount"], pid: 12 },
    ]);
  });

  it("returns [] while the only line is still unterminated", () => {
    writeFileSync(file, '{"pid":');
    expect(readCompleteJsonl(file)).toEqual([]);
  });

  it("throws on a newline-terminated line that is not JSON", () => {
    writeFileSync(file, '{"pid":11}\n{"pid":\n');
    expect(() => readCompleteJsonl(file)).toThrow(SyntaxError);
  });
});
