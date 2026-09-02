import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeManagedLine } from "../src/startup-writer.js";

/**
 * 纯 managed-writer 行为单测（内部 helper，不暴露公共启动 API；无监听单测）。
 *
 * 语义依据（真实 Writable/pipe 探针）：
 * - `callback(new Error())` 后 Writable 还会再发一次 error 事件；
 * - 用户 write callback 先于 error 事件，error 事件先于 setImmediate；
 * - writer 必须：三路（callback error / 后续 error 事件 / 同步 throw）恰 settle 一次；
 *   即使 settle 后 error 事件到达，writer 自己的监听在 setImmediate 前仍消费它，
 *   绝不变成未处理异常；settle 后 writer 监听被移除，fixture 自己的监听仍保留。
 */

interface SinkFixture {
  sink: Writable;
  writes: string[];
  emittedErrors: Error[];
}

function makeSink(
  writeImpl: (chunk: string, callback: (error?: Error | null) => void) => void,
): SinkFixture {
  const writes: string[] = [];
  const emittedErrors: Error[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(String(chunk));
      writeImpl(String(chunk), callback);
    },
  });
  sink.on("error", (e) => emittedErrors.push(e));
  return { sink, writes, emittedErrors };
}

async function settleTicks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("writeManagedLine — 三路 settle 语义", () => {
  it("成功：resolve，写入 exact line，writer 的 error 监听被移除", async () => {
    const { sink, writes, emittedErrors } = makeSink((_chunk, callback) => callback());
    await writeManagedLine(sink, '{"event":"server_started"}\n');
    await settleTicks();
    expect(writes).toEqual(['{"event":"server_started"}\n']);
    expect(emittedErrors).toEqual([]);
    // writer 监听被移除；只剩 fixture 自己的 error 收集监听
    expect(sink.listenerCount("error")).toBe(1);
  });

  it("write callback error：reject；后到的 error 事件仍被消费，无未处理异常", async () => {
    const { sink, emittedErrors } = makeSink((_chunk, callback) =>
      callback(new Error("write-callback-failure")),
    );
    await expect(writeManagedLine(sink, "x\n")).rejects.toThrow("write-callback-failure");
    await settleTicks();
    // Writable 在 callback(error) 后仍发 error 事件；writer 监听消费它（fixture 也记录到）
    expect(emittedErrors).toHaveLength(1);
    expect(sink.listenerCount("error")).toBe(1);
  });

  it("同步 throw：reject，writer 监听最终移除", async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const originalWrite = sink.write.bind(sink);
    sink.write = (() => {
      throw new Error("sync-write-failure");
    }) as typeof sink.write;
    void originalWrite;
    await expect(writeManagedLine(sink, "x\n")).rejects.toThrow("sync-write-failure");
    await settleTicks();
    expect(sink.listenerCount("error")).toBe(0);
  });
});

describe("writeManagedLine — 后到 error 事件与监听器生命周期", () => {
  it("callback 成功后 nextTick 到达的 error 事件被消费：不崩溃，writer 监听移除", async () => {
    const { sink, emittedErrors } = makeSink((_chunk, callback) => {
      callback();
      process.nextTick(() => sink.emit("error", new Error("late-event-failure")));
    });
    await writeManagedLine(sink, "x\n");
    await settleTicks();
    expect(emittedErrors).toHaveLength(1);
    expect(sink.listenerCount("error")).toBe(1);
  });

  it("失败后新 sink 的第二次 write 独立工作", async () => {
    const first = makeSink((_chunk, callback) => callback(new Error("first-fail")));
    await expect(writeManagedLine(first.sink, "a\n")).rejects.toThrow("first-fail");
    const second = makeSink((_chunk, callback) => callback());
    await writeManagedLine(second.sink, "b\n");
    await settleTicks();
    expect(second.writes).toEqual(["b\n"]);
    expect(second.emittedErrors).toEqual([]);
    expect(second.sink.listenerCount("error")).toBe(1);
  });
});
