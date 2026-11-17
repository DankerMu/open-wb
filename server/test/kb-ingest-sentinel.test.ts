/**
 * 入库世界的泄密哨兵（s2c-harness-followups 组 3，#2009）：`useIngestWorlds` 用的同一个收集器与判定，经 `console` 写出的
 * 哨兵也得抓到。不用 `useIngestWorlds`：它的收尾会对整段输出断言不含哨兵，这里故意写出哨兵，会被它自己绊倒。
 * 设置世界一例（#2018）：同一收集器以 `useSettingsWorlds` 的哨兵列表判定，经 `console.warn` 写出的密钥也得抓到；同理不用
 * `useSettingsWorlds`。
 */
import { describe, expect, it, vi } from "vitest";
import { CONTENT_SENTINEL, MESSAGE_SENTINEL } from "./kb-ingest-helpers.js";
import { EMBED_KEY, SENTINELS } from "./kb-settings-helpers.js";
import { expectNoSentinel, outputCollector } from "./support/output-sentinel.js";

describe("泄密哨兵（verification-harness「入库世界的泄密哨兵覆盖 console」）", () => {
  it("经 console.log 写出的文件内容哨兵被判定抓到，信息点名该哨兵；stop 之后 spy 全部恢复", () => {
    const output = outputCollector();
    output.start();
    console.log("正文片段", `…${CONTENT_SENTINEL}…`);
    const text = output.stop();
    expect(vi.isMockFunction(console.log)).toBe(false);
    expect(vi.isMockFunction(process.stdout.write)).toBe(false);
    expect(() => expectNoSentinel(text, [CONTENT_SENTINEL, MESSAGE_SENTINEL])).toThrow(
      `泄密哨兵 ${CONTENT_SENTINEL} 出现在输出里`,
    );
    expect(() => expectNoSentinel(text, [CONTENT_SENTINEL, MESSAGE_SENTINEL])).not.toThrow(
      MESSAGE_SENTINEL,
    );
  });

  it("设置世界：经 console.warn 写出的嵌入密钥哨兵以设置世界的哨兵列表判定被抓到，信息点名该哨兵；stop 之后 spy 全部恢复", () => {
    const output = outputCollector();
    output.start();
    console.warn("上游应答", `…${EMBED_KEY}…`);
    const text = output.stop();
    expect(vi.isMockFunction(console.warn)).toBe(false);
    expect(vi.isMockFunction(process.stderr.write)).toBe(false);
    expect(() => expectNoSentinel(text, SENTINELS)).toThrow(`泄密哨兵 ${EMBED_KEY} 出现在输出里`);
  });
});
