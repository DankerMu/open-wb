import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { writeManagedLine } from "../src/startup-writer.js";

/**
 * 纯 managed-writer 行为单测（内部 helper，不暴露公共启动 API；不起 HTTP 监听）。
 *
 * 语义依据（真实 Writable/pipe 探针）：
 * - `callback(new Error())` 后 Writable 还会再发一次 error 事件；
 * - 用户 write callback 先于 error 事件，error 事件先于 setImmediate；
 * - writer 必须：三路（callback error / 后续 error 事件 / 同步 throw）恰 settle 一次；
 *   即使 settle 后 error 事件到达，writer 自己的监听在 setImmediate 前仍消费它，
 *   绝不变成未处理异常；settle 后 writer 监听被移除，fixture 自己的监听仍保留。
 * - 每个 stream 至多一个 writer 监听，由全部在途记录共用（#787）：Writable 会串行化
 *   `_write`，拿不到多条同时在途的 callback，所以这部分用手控的 EventEmitter sink；
 *   真实 `process.stderr` 的监听上限警告只能在子进程里观察（stderr 接管道）。
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

  it("裸 sink 无外部 error 监听：callback 成功后 nextTick 的 late error 被 writer 消费，无未处理异常", async () => {
    // 无 fixture 自身的 error 收集监听——若 writer 在 settle 时同步移除自己的监听，
    // 该 late error 就会变成 unhandled 'error' 事件（uncaught exception）。
    const writes: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
        process.nextTick(() => sink.emit("error", new Error("bare-late-event-failure")));
      },
    });
    await writeManagedLine(sink, "x\n");
    await settleTicks();
    expect(writes).toEqual(["x\n"]);
    expect(sink.listenerCount("error")).toBe(0);
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

/** 手控 sink：write 只登记 callback，由用例决定何时、以什么结果回调；没有任何自带 error 监听。 */
class ManualSink extends EventEmitter {
  readonly writes: string[] = [];
  readonly callbacks: ((error?: Error | null) => void)[] = [];

  write(chunk: string, callback?: (error: Error | null | undefined) => void): boolean {
    this.writes.push(chunk);
    this.callbacks.push((error) => callback?.(error));
    return true;
  }
}

type Outcome = { status: "resolved" } | { status: "rejected"; error: unknown };

/** 记录一条写入的每一次 settle；长度恰为 1 即「恰 settle 一次」。 */
function track(sink: ManualSink, line: string): Outcome[] {
  const outcomes: Outcome[] = [];
  writeManagedLine(sink, line).then(
    () => outcomes.push({ status: "resolved" }),
    (error: unknown) => outcomes.push({ status: "rejected", error }),
  );
  return outcomes;
}

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const WRITER_SOURCE = fileURLToPath(new URL("../src/startup-writer.ts", import.meta.url));

const CHILD_SCRIPT = `
const { writeManagedLine } = await import(process.argv[1]);
const before = process.stderr.listenerCount("error");
const maxBefore = process.stderr.getMaxListeners();
const pending = [];
for (let i = 0; i < 16; i += 1) {
  pending.push(writeManagedLine(process.stderr, JSON.stringify({ event: "session_fault", n: i }) + "\\n"));
}
const during = process.stderr.listenerCount("error");
await Promise.all(pending);
await new Promise((resolve) => setImmediate(resolve));
const after = process.stderr.listenerCount("error");
const maxAfter = process.stderr.getMaxListeners();
process.stdout.write(JSON.stringify({ before, during, after, maxBefore, maxAfter }));
`;

function runChild(): Promise<{ stdout: string; stderr: string }> {
  // NODE_OPTIONS 不继承：测试 runner 的 loader/flag 不得改变子进程 stderr。
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", CHILD_SCRIPT, WRITER_SOURCE],
      { env },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

describe("writeManagedLine — 同 tick 多条记录共用一个监听（#787）", () => {
  it("真实 process.stderr 同 tick 16 条：stderr 恰 16 行记录、无 MaxListenersExceededWarning，之后监听数归 0", async () => {
    const { stdout, stderr } = await runChild();
    const expected = Array.from(
      { length: 16 },
      (_unused, n) => `${JSON.stringify({ event: "session_fault", n })}\n`,
    ).join("");
    expect(stderr).toBe(expected);
    expect(stderr).not.toContain("MaxListenersExceededWarning");
    expect(JSON.parse(stdout)).toEqual({
      before: 0,
      during: 1,
      after: 0,
      maxBefore: 10,
      maxAfter: 10,
    });
  });

  it("三条在途：监听数恰为 1、上限未动；一次 error 使三条各 reject 恰一次，迟到的 callback 不改结果", async () => {
    const sink = new ManualSink();
    const maxBefore = sink.getMaxListeners();
    const outcomes = ["a\n", "b\n", "c\n"].map((line) => track(sink, line));
    expect(sink.writes).toEqual(["a\n", "b\n", "c\n"]);
    expect(sink.listenerCount("error")).toBe(1);
    expect(sink.getMaxListeners()).toBe(maxBefore);

    const failure = new Error("shared-stream-failure");
    expect(() => sink.emit("error", failure)).not.toThrow();
    await Promise.resolve();
    const rejected: Outcome = { status: "rejected", error: failure };
    expect(outcomes).toEqual([[rejected], [rejected], [rejected]]);

    // 迟到的 write callback（成功与失败各一种）不得再 settle
    sink.callbacks[0]?.();
    sink.callbacks[1]?.(new Error("late-callback-failure"));
    sink.callbacks[2]?.(null);
    await Promise.resolve();
    expect(outcomes).toEqual([[rejected], [rejected], [rejected]]);

    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("callback 成功之后、setImmediate 之前的 error：记录保持 resolved，没有未处理的 error 事件", async () => {
    const sink = new ManualSink();
    const outcomes = track(sink, "a\n");
    sink.callbacks[0]?.();
    await Promise.resolve();
    expect(outcomes).toEqual([{ status: "resolved" }]);
    // 裸 EventEmitter：没有监听时 emit("error") 会同步 throw
    expect(sink.listenerCount("error")).toBe(1);
    expect(() => sink.emit("error", new Error("late-epipe"))).not.toThrow();
    await Promise.resolve();
    expect(outcomes).toEqual([{ status: "resolved" }]);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("三条在途、其中一条 callback 报错：只有它 reject，其余仍在途并随各自 callback resolve，监听留到最后一条 settle 后的下一轮", async () => {
    const sink = new ManualSink();
    const [a, b, c] = ["a\n", "b\n", "c\n"].map((line) => track(sink, line));
    const failure = new Error("one-callback-failure");
    sink.callbacks[1]?.(failure);
    await Promise.resolve();
    expect(b).toEqual([{ status: "rejected", error: failure }]);
    expect([a, c]).toEqual([[], []]);
    // 过一轮 setImmediate：A、C 仍在途，监听不得被摘
    await nextImmediate();
    expect([a, c]).toEqual([[], []]);
    expect(sink.listenerCount("error")).toBe(1);

    sink.callbacks[0]?.();
    sink.callbacks[2]?.(null);
    await Promise.resolve();
    expect([a, b, c]).toEqual([
      [{ status: "resolved" }],
      [{ status: "rejected", error: failure }],
      [{ status: "resolved" }],
    ]);
    expect(sink.listenerCount("error")).toBe(1);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("三条在途时第四条 write 同步 throw：只有它 reject，监听仍挂着，随后的 error 仍 reject 剩余在途记录", async () => {
    const sink = new ManualSink();
    const [a, b, c] = ["a\n", "b\n", "c\n"].map((line) => track(sink, line));
    const thrown = new Error("sync-write-failure");
    // 实例属性遮住原型上的 write，只让第四条同步 throw
    sink.write = () => {
      throw thrown;
    };
    const d = track(sink, "d\n");
    await Promise.resolve();
    expect(d).toEqual([{ status: "rejected", error: thrown }]);
    expect([a, b, c]).toEqual([[], [], []]);
    expect(sink.writes).toEqual(["a\n", "b\n", "c\n"]);
    await nextImmediate();
    expect([a, b, c]).toEqual([[], [], []]);
    expect(sink.listenerCount("error")).toBe(1);

    sink.callbacks[0]?.();
    await Promise.resolve();
    expect(a).toEqual([{ status: "resolved" }]);
    expect([b, c]).toEqual([[], []]);

    // 裸 EventEmitter：监听若已被摘，emit("error") 会同步 throw
    const failure = new Error("stream-failure-after-sync-throw");
    expect(() => sink.emit("error", failure)).not.toThrow();
    await Promise.resolve();
    const rejected: Outcome = { status: "rejected", error: failure };
    expect([a, b, c, d]).toEqual([
      [{ status: "resolved" }],
      [rejected],
      [rejected],
      [{ status: "rejected", error: thrown }],
    ]);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });
});

describe("writeManagedLine — 同一 stream 上监听的复用与重挂（#787）", () => {
  it("A settle 后、其 setImmediate 前写入 B 且 B 仍在途：监听沿用，随后的 error reject B", async () => {
    const sink = new ManualSink();
    const a = track(sink, "a\n");
    sink.callbacks[0]?.();
    const b = track(sink, "b\n");
    await nextImmediate(); // A 的 setImmediate 已触发，B 仍在途
    expect(a).toEqual([{ status: "resolved" }]);
    expect(b).toEqual([]);
    expect(sink.listenerCount("error")).toBe(1);

    const failure = new Error("reuse-failure");
    expect(() => sink.emit("error", failure)).not.toThrow();
    await Promise.resolve();
    expect(a).toEqual([{ status: "resolved" }]);
    expect(b).toEqual([{ status: "rejected", error: failure }]);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("A 的 setImmediate 与 B 的 settle 落在同一轮：监听留到 B settle 后的下一轮", async () => {
    const sink = new ManualSink();
    const seen: number[] = [];
    let threw = false;
    let b: Outcome[] = [];
    const a = track(sink, "a\n");
    // 排在 A 的 setImmediate 之前：同一轮 check 阶段里写入并 settle B
    setImmediate(() => {
      b = track(sink, "b\n");
      sink.callbacks[1]?.();
    });
    sink.callbacks[0]?.();
    // 排在 A 的 setImmediate 之后：此时 B 刚 settle、尚未过一轮
    setImmediate(() => {
      seen.push(sink.listenerCount("error"));
      try {
        sink.emit("error", new Error("same-round-late-epipe"));
      } catch {
        threw = true;
      }
    });
    await nextImmediate();
    expect(seen).toEqual([1]);
    expect(threw).toBe(false);
    expect(a).toEqual([{ status: "resolved" }]);
    expect(b).toEqual([{ status: "resolved" }]);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("监听已摘除后写入 C：监听数回到 1，error reject C，之后再次归 0", async () => {
    const sink = new ManualSink();
    const a = track(sink, "a\n");
    sink.callbacks[0]?.();
    await nextImmediate();
    expect(a).toEqual([{ status: "resolved" }]);
    expect(sink.listenerCount("error")).toBe(0);

    const c = track(sink, "c\n");
    expect(sink.listenerCount("error")).toBe(1);
    const failure = new Error("reattach-failure");
    expect(() => sink.emit("error", failure)).not.toThrow();
    await Promise.resolve();
    expect(c).toEqual([{ status: "rejected", error: failure }]);
    await nextImmediate();
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("两个 sink 各一条在途：只有出错的 sink 的记录 reject，另一个按自己的 callback settle", async () => {
    const first = new ManualSink();
    const second = new ManualSink();
    const a = track(first, "a\n");
    const b = track(second, "b\n");
    expect(first.listenerCount("error")).toBe(1);
    expect(second.listenerCount("error")).toBe(1);

    const failure = new Error("first-sink-failure");
    first.emit("error", failure);
    await Promise.resolve();
    expect(a).toEqual([{ status: "rejected", error: failure }]);
    expect(b).toEqual([]);

    second.callbacks[0]?.();
    await Promise.resolve();
    expect(b).toEqual([{ status: "resolved" }]);
    await nextImmediate();
    expect(first.listenerCount("error")).toBe(0);
    expect(second.listenerCount("error")).toBe(0);
  });
});
