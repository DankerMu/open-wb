/**
 * 入库世界的泄密哨兵（s2c-harness-followups 组 3，#2009）：`useIngestWorlds` 用的同一个收集器与判定，经 `console` 写出的
 * 哨兵也得抓到。不用 `useIngestWorlds`：它的收尾会对整段输出断言不含哨兵，这里故意写出哨兵，会被它自己绊倒。
 */
import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_SENTINEL,
  expectNoSentinel,
  MESSAGE_SENTINEL,
  outputCollector,
} from "./kb-ingest-helpers.js";

describe("泄密哨兵（verification-harness「入库世界的泄密哨兵覆盖 console」）", () => {
  it("经 console.log 写出的文件内容哨兵被判定抓到，信息点名该哨兵；stop 之后 spy 全部恢复", () => {
    const output = outputCollector();
    output.start();
    console.log("正文片段", `…${CONTENT_SENTINEL}…`);
    const text = output.stop();
    expect(vi.isMockFunction(console.log)).toBe(false);
    expect(vi.isMockFunction(process.stdout.write)).toBe(false);
    expect(() => expectNoSentinel(text)).toThrow(`泄密哨兵 ${CONTENT_SENTINEL} 出现在输出里`);
    expect(() => expectNoSentinel(text)).not.toThrow(MESSAGE_SENTINEL);
  });
});
