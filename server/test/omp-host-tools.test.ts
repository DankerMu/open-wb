/**
 * Change s2c-kb-session 3.3 (#1964): omp-runtime「宿主工具协议」 at the OmpProcess seam. Each case
 * runs a real fake omp child (omp-test-harness「假 omp host tool 场景」, spawned with the production
 * argv and `--approval-mode yolo`) and observes the frames the host writes through an stdin tee
 * (`captureStdinFrames`); the expected replies are the literals of the requirement's scenarios and
 * of tasks.md「组 3 首刀约定」. The fake's inbound record (`frames=`) is read with a probe prompt.
 */
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as macrotask } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { HostToolHandler, HostToolResult } from "../src/sessions/omp/host-tools.js";
import { OmpProcess, type SpawnImpl } from "../src/sessions/omp/process.js";
import { asRecord, createRpcHarness, DEFAULT_READY } from "./support/omp-rpc.js";
import { captureStdinFrames } from "./support/omp-runtime.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const TOKEN = "wb-issue1964-secret-token";
const SENTINEL = "secret-detail-1964";
const QUESTION = "查一下 KB:k1";
const MIB = 1_048_576;
const POLL = { timeout: 4_000, interval: 10 };
const REAL = { timeout: 15_000 };
const harness = createRpcHarness();

type Answer = (toolName: string, args: unknown, signal: AbortSignal) => Promise<unknown>;

interface Call {
  toolName: string;
  args: unknown;
  signal: AbortSignal;
}

interface Run {
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
  writes: OmpFrame[];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** A handler that records every call and answers with `answer`. */
function recording(answer: Answer): { tools: HostToolHandler; calls: Call[] } {
  const calls: Call[] = [];
  const tools: HostToolHandler = {
    call(toolName, args, signal) {
      calls.push({ toolName, args, signal });
      return answer(toolName, args, signal) as Promise<HostToolResult | undefined>;
    },
  };
  return { tools, calls };
}

/** A promise the test settles itself. */
function gate(): { promise: Promise<unknown>; release: (value: unknown) => void } {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function start(scenario: string, tools?: HostToolHandler): Promise<Run> {
  const writes: OmpFrame[] = [];
  const spawnImpl: SpawnImpl = (_command, args, options) => {
    const child = harness.spawnTracked([FAKE, ...args, "--scenario", scenario], options);
    captureStdinFrames(child, (frame) => {
      writes.push(frame);
    });
    return child;
  };
  const proc = harness.manage(
    new OmpProcess({
      ...harness.tempOpts(TOKEN, "omp-host-tools-"),
      approvalMode: "yolo",
      spawnImpl,
      hostTools: tools,
    }),
  );
  const run = { proc, frames: harness.collectFrames(proc), errors: harness.collectErrors(proc) };
  await proc.start();
  return { ...run, writes };
}

async function prompt(run: Run, message = QUESTION): Promise<void> {
  await run.proc.send({ id: "p1", type: "prompt", message });
}

function results(run: Run, id?: string): OmpFrame[] {
  return run.writes.filter(
    (frame) => frame.type === "host_tool_result" && (id === undefined || frame.id === id),
  );
}

function reply(id: string, text: string, isError: boolean): OmpFrame {
  return {
    type: "host_tool_result",
    id,
    result: { content: [{ type: "text", text }] },
    ...(isError ? { isError: true } : {}),
  };
}

async function terminal(run: Run): Promise<void> {
  await harness.waitFrame(run.proc, (frame) => frame.type === "agent_end", 8_000, run.frames);
}

function toolEnds(run: Run): unknown[] {
  return run.frames.filter((frame) => frame.type === "tool_execution_end").map((f) => f.toolCallId);
}

/** Probe prompt after the scenario turn: the fake's inbound frame-type record. */
async function probeFrames(run: Run): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omp-host-tools-probe-"));
  harness.temps.push(dir);
  const start = run.frames.length;
  const message = `probe:${String(process.pid)}:${dir}/probe.txt`;
  await run.proc.send({ id: "p-probe", type: "prompt", message });
  await harness.waitFrame(run.proc, (f) => f.type === "agent_end", 8_000, run.frames.slice(start));
  const delta = run.frames
    .slice(start)
    .find((frame) => asRecord(frame.assistantMessageEvent).type === "text_delta");
  const text = String(asRecord(delta?.assistantMessageEvent).delta);
  return / frames=(\S*) cwd=/u.exec(text)?.[1] ?? `<no frames= in ${text}>`;
}

/** Holds h1 open: returns the run, the h1 call and the release of its handler. */
async function holdFirst(scenario: string): Promise<{ run: Run; call: Call; release: () => void }> {
  const held = gate();
  const { tools, calls } = recording(() => held.promise);
  const run = await start(scenario, tools);
  await prompt(run);
  await expect.poll(() => calls.length, POLL).toBe(1);
  const call = calls[0] as Call;
  return { run, call, release: () => held.release({ text: "late", isError: false }) };
}

describe("omp-runtime「宿主工具协议」: 调用与应答", () => {
  it(
    "hands each call to the handler and writes exactly one result frame per id",
    REAL,
    async () => {
      const { tools, calls } = recording(async () => ({
        text: "r",
        details: { bases: [] },
        isError: false,
      }));
      const run = await start("host-tool", tools);
      await prompt(run);
      await terminal(run);

      expect(results(run, "h1")).toStrictEqual([
        {
          type: "host_tool_result",
          id: "h1",
          result: { content: [{ type: "text", text: "r" }], details: { bases: [] } },
        },
      ]);
      expect(results(run, "h2")).toHaveLength(1);
      expect(calls.map((call) => [call.toolName, call.args])).toEqual([
        ["kb_search", { question: QUESTION, kb_ids: ["k1"] }],
        ["kb_search", { question: `${QUESTION} 详细说明`, kb_ids: ["k1"] }],
      ]);
      expect(run.frames.filter((frame) => frame.type === "host_tool_call")).toHaveLength(2);
      expect(toolEnds(run)).toEqual(["c1", "c2"]);
      expect(run.errors).toEqual([]);
    },
  );
});

describe("omp-runtime「宿主工具协议」: 并发", () => {
  it("a held call does not delay the next: h2 is written before h1", REAL, async () => {
    const held = gate();
    const { tools, calls } = recording(async (toolName, args) => {
      if (toolName !== "kb_search") {
        return undefined;
      }
      const [kbId] = asRecord(args).kb_ids as string[];
      return kbId === "k1" ? held.promise : { text: "r2", isError: false };
    });
    const run = await start("host-tool-parallel", tools);
    await prompt(run, "查一下 KB:k1 KB:k2");
    await expect.poll(() => results(run, "h2").length, POLL).toBe(1);

    expect(calls.slice(0, 2).map((call) => asRecord(call.args).kb_ids)).toEqual([["k1"], ["k2"]]);
    expect(results(run, "h1")).toEqual([]);
    held.release({ text: "r1", isError: false });
    await terminal(run);

    const order = results(run).map((frame) => frame.id);
    expect(order.indexOf("h2")).toBeLessThan(order.indexOf("h1"));
    expect(results(run, "h1")).toStrictEqual([reply("h1", "r1", false)]);
    expect(results(run, "h3")).toStrictEqual([reply("h3", "未知工具", true)]);
    expect(run.errors).toEqual([]);
  });
});

describe("omp-runtime「宿主工具协议」: 取消与迟到的结果", () => {
  it("host_tool_cancel aborts the handler and its late result is never written", REAL, async () => {
    const { run, call, release } = await holdFirst("host-tool-abort");
    await run.proc.request({ type: "abort" });
    expect(call.signal.aborted).toBe(true);
    release();
    await macrotask();

    expect(await probeFrames(run)).toBe("negotiate_protocol,get_state,prompt,abort,prompt");
    expect(results(run)).toEqual([]);
    expect(run.errors).toEqual([]);
  });

  it("child exit aborts the in-flight call and nothing is written afterwards", REAL, async () => {
    const { run, call, release } = await holdFirst("host-tool");
    const writes = run.writes.length;
    const exited = harness.waitExit(run.proc);
    run.proc.kill("SIGKILL");
    await exited;
    release();
    await macrotask();

    expect(call.signal.aborted).toBe(true);
    expect(run.writes).toHaveLength(writes);
    expect(run.errors).toEqual([]);
  });

  it(
    "closing stdin aborts the in-flight call and nothing is written afterwards",
    REAL,
    async () => {
      const { run, call, release } = await holdFirst("host-tool");
      const writes = run.writes.length;
      const stdin = run.proc.child?.stdin;
      stdin?.end();
      await once(stdin as NonNullable<typeof stdin>, "finish");
      expect(call.signal.aborted).toBe(true);
      release();
      await macrotask();

      expect(run.writes).toHaveLength(writes);
      expect(run.errors).toEqual([]);
    },
  );

  it("a result released in the same tick as closeInput is dropped, not written", REAL, async () => {
    const { run, release } = await holdFirst("host-tool");
    const writes = run.writes.length;
    run.proc.closeInput();
    release();
    await macrotask();
    await macrotask();

    expect(run.writes).toHaveLength(writes);
    expect(run.errors).toEqual([]);
  });
});

describe("omp-runtime「宿主工具协议」: 未知工具与失败", () => {
  const unknown = [
    ["no handler injected", undefined],
    ["the handler resolves undefined", recording(async () => undefined).tools],
  ] as const;
  for (const [name, tools] of unknown) {
    it(`${name}: every call is answered isError 未知工具`, REAL, async () => {
      const run = await start("host-tool", tools);
      await prompt(run);
      await terminal(run);

      expect(results(run)).toStrictEqual([
        reply("h1", "未知工具", true),
        reply("h2", "未知工具", true),
      ]);
      expect(run.errors).toEqual([]);
    });
  }

  const failing: [string, Answer][] = [
    [
      "a synchronous throw",
      () => {
        throw new Error(SENTINEL);
      },
    ],
    ["an async rejection", async () => Promise.reject(new Error(SENTINEL))],
  ];
  for (const [name, answer] of failing) {
    it(`${name} is answered isError 工具执行失败 and the message leaks nowhere`, REAL, async () => {
      const stderr = vi.spyOn(process.stderr, "write");
      const consoles = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
        vi.spyOn(console, method),
      );
      const run = await start("host-tool", recording(answer).tools);
      await prompt(run);
      await terminal(run);

      expect(results(run)).toStrictEqual([
        reply("h1", "工具执行失败", true),
        reply("h2", "工具执行失败", true),
      ]);
      expect(run.errors).toEqual([]);
      const seen = [run.writes, ...[stderr, ...consoles].map((spy) => spy.mock.calls)];
      expect(JSON.stringify(seen)).not.toContain(SENTINEL);
    });
  }

  it("a rejection that only comes after the cancel writes no frame", REAL, async () => {
    const { tools, calls } = recording(
      (_toolName, _args, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error(SENTINEL)));
        }),
    );
    const run = await start("host-tool-abort", tools);
    await prompt(run);
    await expect.poll(() => calls.length, POLL).toBe(1);
    await run.proc.request({ type: "abort" });
    await macrotask();

    expect(results(run)).toEqual([]);
    expect(run.errors).toEqual([]);
  });
});

describe("omp-runtime「宿主工具协议」: 结果过大", () => {
  it("details that overflow the frame limit are dropped, the text is kept", REAL, async () => {
    const text = "a".repeat(100 * 1024);
    const { tools } = recording(async () => ({
      text,
      details: { blob: "b".repeat(MIB) },
      isError: false,
    }));
    const run = await start("host-tool", tools);
    await prompt(run);
    await terminal(run);

    expect(results(run)).toStrictEqual([reply("h1", text, false), reply("h2", text, false)]);
    expect(toolEnds(run)).toEqual(["c1", "c2"]);
    expect(run.errors).toEqual([]);
  });

  it(
    "details that cannot be serialized are dropped too: still one frame per call",
    REAL,
    async () => {
      const details: Record<string, unknown> = {};
      details.self = details;
      const run = await start(
        "host-tool",
        recording(async () => ({ text: "r", details, isError: false })).tools,
      );
      await prompt(run);
      await terminal(run);

      expect(results(run)).toStrictEqual([reply("h1", "r", false), reply("h2", "r", false)]);
      expect(run.errors).toEqual([]);
    },
  );

  it(
    "a text over the limit (ASCII, and CJK under it in characters) is 工具结果过大",
    REAL,
    async () => {
      const ascii = "x".repeat(MIB + 1);
      const cjk = "你".repeat(400_000);
      expect(cjk.length).toBeLessThan(MIB);
      const { tools } = recording(async (_toolName, args) => ({
        text: String(asRecord(args).question).endsWith("详细说明") ? cjk : ascii,
        isError: false,
      }));
      const run = await start("host-tool", tools);
      await prompt(run);
      await terminal(run);

      expect(results(run)).toStrictEqual([
        reply("h1", "工具结果过大", true),
        reply("h2", "工具结果过大", true),
      ]);
      expect(toolEnds(run)).toEqual(["c1", "c2"]);
      expect(run.errors).toEqual([]);
    },
  );
});

/** Synthetic child (FakeChild) for frames the fake omp never sends. */
async function startSynthetic(tools: HostToolHandler) {
  const child = harness.fake();
  const written: OmpFrame[] = [];
  child.onCommand("host_tool_result", (frame) => {
    written.push(frame);
  });
  const proc = harness.manage(
    new OmpProcess({ ...harness.tempOpts(TOKEN), spawnImpl: child.spawnImpl, hostTools: tools }),
  );
  const errors = harness.collectErrors(proc);
  child.emitLine(DEFAULT_READY);
  child.replyHandshake();
  await proc.start();
  return { child, proc, written, errors };
}

const SYNTHETIC_CALL = { type: "host_tool_call", toolCallId: "c1", toolName: "kb_search" };

describe("omp-runtime「宿主工具协议」: frames the transport ignores", () => {
  it("a call without a nonempty string id, a duplicate id and an unknown cancel write nothing extra", async () => {
    const { tools, calls } = recording(() => gate().promise);
    const { child, written, errors } = await startSynthetic(tools);
    for (const id of [undefined, "", 7]) {
      child.emitLine({ ...SYNTHETIC_CALL, ...(id === undefined ? {} : { id }) });
    }
    child.emitLine({ ...SYNTHETIC_CALL, id: "h1" });
    child.emitLine({ ...SYNTHETIC_CALL, id: "h1" });
    child.emitLine({ type: "host_tool_cancel", id: "x1", targetId: "nope" });
    await expect.poll(() => calls.length, POLL).toBe(1);
    await macrotask();

    expect(calls[0]?.signal.aborted).toBe(false);
    expect(written).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("a call arriving after input closed, before the child exits, never reaches the handler", async () => {
    const { tools, calls } = recording(async () => ({ text: "r", isError: false }));
    const { child, proc, written, errors } = await startSynthetic(tools);
    proc.closeInput();
    await once(child.stdin, "finish");
    child.emitLine({ ...SYNTHETIC_CALL, id: "h1" });
    await macrotask();
    await macrotask();

    expect(calls).toEqual([]);
    expect(written).toEqual([]);
    expect(errors).toEqual([]);
  });
});
