/**
 * Issue #460 approval select recognition and respondApproval (parent s1c-turn-control-governance 2.1a).
 * Oracles: fake-omp approval scenarios (#458, gated only under `--approval-mode write`, swapped from
 * the production `yolo` inside this file) with their probe `frames=` inbound record (#459), FakeChild
 * synthetic frames, and the injected clock for SessionRuntime idle/shutdown paths.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { AgentUnavailableError, OmpProcess, type SpawnImpl } from "../src/sessions/omp/process.js";
import { SessionRuntime } from "../src/sessions/omp/runtime.js";
import type { ApprovalRequest } from "../src/sessions/omp/ui-requests.js";
import { createRealFakeRuntime, type RealFakeRuntime } from "./session-supervisor-helpers.js";
import {
  asRecord,
  createRpcHarness,
  type FakeChild,
  observePromise,
  startFakeProcess,
} from "./support/omp-rpc.js";
import {
  type ChildObservation,
  createTokens,
  observeChild,
  settlesWithin,
} from "./support/omp-runtime.js";

const TOKEN = "wb-issue460-secret-token";
const T = "Allow tool: bash\nCommand: echo workbuddy-smoke";
const PROMPT: OmpFrame = { id: "p1", type: "prompt", message: "run the tool" };
const QUIET_MS = 300;
const REAL = { timeout: 20_000 };
const harness = createRpcHarness();

/** Test-side argv swap (no-op once #481 ships `write`) plus a synchronous record of every stdin line. */
interface Launch {
  real: RealFakeRuntime;
  spawnImpl: SpawnImpl;
  argv: string[][];
  written: OmpFrame[];
  watches: ChildObservation[];
}

interface Observed {
  proc: OmpProcess;
  frames: OmpFrame[];
  errors: unknown[];
  approvals: ApprovalRequest[];
  log: string[];
}

interface RealRun extends Observed {
  launch: Launch;
}

function launch(scenario: string): Launch {
  const real = createRealFakeRuntime(scenario);
  const inner = real.runtime.spawnImpl;
  const out: Launch = { real, spawnImpl: inner, argv: [], written: [], watches: [] };
  out.spawnImpl = (command, args, options) => {
    const swapped = args.map((arg, index) =>
      index > 0 && args[index - 1] === "--approval-mode" && arg === "yolo" ? "write" : arg,
    );
    out.argv.push(swapped);
    const child = inner(command, swapped, options);
    recordStdin(child, out.written);
    out.watches.push(observeChild(child));
    return child;
  };
  return out;
}

function recordStdin(child: ChildProcessWithoutNullStreams, sink: OmpFrame[]): void {
  const forward = child.stdin.write.bind(child.stdin) as (...args: unknown[]) => boolean;
  child.stdin.write = ((...args: unknown[]) => {
    const chunk = args[0];
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split("\n").filter((part) => part.length > 0)) {
      sink.push(JSON.parse(line) as OmpFrame);
    }
    return forward(...args);
  }) as typeof child.stdin.write;
}

function recordFakeStdin(child: FakeChild): OmpFrame[] {
  const sink: OmpFrame[] = [];
  child.stdin.on("data", (chunk: Buffer | string) => {
    for (const line of chunk
      .toString()
      .split("\n")
      .filter((part) => part.trim().length > 0)) {
      sink.push(JSON.parse(line) as OmpFrame);
    }
  });
  return sink;
}

function observe(proc: OmpProcess, frames: OmpFrame[], errors: unknown[]): Observed {
  const approvals: ApprovalRequest[] = [];
  const log: string[] = [];
  proc.on("frame", (frame) => {
    log.push(`frame:${String(frame.type)}:${String(frame.id ?? "")}`);
  });
  proc.on("approval", (request) => {
    approvals.push(request);
    log.push(`approval:${request.id}`);
  });
  return { proc, frames, errors, approvals, log };
}

async function startReal(scenario: string): Promise<RealRun> {
  const launched = launch(scenario);
  const { runtime } = launched.real;
  const proc = harness.manage(
    new OmpProcess({
      bin: runtime.bin,
      sandboxRoot: runtime.sandboxRoot,
      stateDir: runtime.stateDir,
      ownerId: "u1",
      modelId: runtime.modelId,
      token: TOKEN,
      resumePath: null,
      spawnImpl: launched.spawnImpl,
    }),
  );
  const observed = observe(proc, harness.collectFrames(proc), harness.collectErrors(proc));
  await proc.start();
  const argv = launched.argv[0] ?? [];
  expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("write");
  return { ...observed, launch: launched };
}

/** Prompt the gated fake and stop at its r1 approval select. */
async function reachR1(scenario: string): Promise<RealRun> {
  const run = await startReal(scenario);
  await run.proc.send(PROMPT);
  await harness.waitFrame(run.proc, isUi("r1"), 8_000, run.frames);
  return run;
}

async function startSynthetic(): Promise<Observed & { child: FakeChild; written: OmpFrame[] }> {
  const { child, proc, frames, errors } = await startFakeProcess(harness, TOKEN, {
    prefix: "omp-approval-",
  });
  return { ...observe(proc, frames, errors), child, written: recordFakeStdin(child) };
}

function isUi(id: string): (frame: OmpFrame) => boolean {
  return (frame) => frame.type === "extension_ui_request" && frame.id === id;
}

function isTerminalEnd(frame: OmpFrame): boolean {
  return frame.type === "agent_end" && frame.isTerminal !== false;
}

function uiAnswers(written: OmpFrame[]): OmpFrame[] {
  return written.filter((frame) => frame.type === "extension_ui_response");
}

function selectFrame(id: string | undefined, title: string, options: unknown): OmpFrame {
  return {
    type: "extension_ui_request",
    ...(id === undefined ? {} : { id }),
    method: "select",
    title,
    options,
  };
}

async function quiet(proc: OmpProcess, predicate: (frame: OmpFrame) => boolean): Promise<void> {
  await expect(harness.waitFrame(proc, predicate, QUIET_MS)).rejects.toThrow(/timed out/);
}

/** Probe turn after the gated turn: returns the fake's inbound `frames=` record. */
async function probeFrames(run: RealRun): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "omp-approval-probe-"));
  harness.temps.push(dir);
  const start = run.frames.length;
  const message = `probe:${String(process.pid)}:${dir}/probe.txt`;
  await run.proc.send({ id: "p-probe", type: "prompt", message });
  await harness.waitFrame(run.proc, isTerminalEnd, 8_000, run.frames.slice(start));
  const delta = run.frames
    .slice(start)
    .find(
      (frame) =>
        frame.type === "message_update" &&
        asRecord(frame.assistantMessageEvent).type === "text_delta",
    );
  const text = String(asRecord(delta?.assistantMessageEvent).delta);
  return / frames=(\S*)$/u.exec(text)?.[1] ?? `<no frames= in ${text}>`;
}

function toolEnd(frames: OmpFrame[]): OmpFrame | undefined {
  return frames.find((frame) => frame.type === "tool_execution_end");
}

describe("OmpProcess approval recognition over the gated fake-omp", () => {
  it(
    "E1 surfaces r1 to the owner after its frame, writes nothing and keeps the child waiting",
    REAL,
    async () => {
      const run = await reachR1("approval");
      expect(run.approvals).toEqual([{ id: "r1", title: T, tool: "bash" }]);
      const frameAt = run.log.indexOf("frame:extension_ui_request:r1");
      expect(frameAt).toBeGreaterThanOrEqual(0);
      expect(frameAt).toBeLessThan(run.log.indexOf("approval:r1"));
      await quiet(
        run.proc,
        (frame) => frame.type === "tool_execution_end" || frame.type === "agent_end",
      );
      expect(uiAnswers(run.launch.written)).toEqual([]);
    },
  );

  it(
    "E2 allow writes exactly one Approve, the tool runs, and repeats or unknown ids write nothing",
    REAL,
    async () => {
      const run = await reachR1("approval");
      run.proc.respondApproval("r1", "allow");
      expect(uiAnswers(run.launch.written)).toEqual([
        { type: "extension_ui_response", id: "r1", value: "Approve" },
      ]);
      await harness.waitFrame(run.proc, isTerminalEnd, 8_000, run.frames);
      const ended = toolEnd(run.frames);
      expect(ended).toMatchObject({ toolCallId: "tool-1" });
      expect(ended).not.toHaveProperty("isError");
      expect(() => {
        run.proc.respondApproval("r1", "allow");
        run.proc.respondApproval("r1", "deny");
        run.proc.respondApproval("nope", "allow");
      }).not.toThrow();
      expect(uiAnswers(run.launch.written)).toHaveLength(1);
      expect(await probeFrames(run)).toBe(
        "negotiate_protocol,get_state,prompt,extension_ui_response,prompt",
      );
      expect(run.errors).toEqual([]);
    },
  );

  it("E3 deny writes exactly one Deny and the fake reports the denied tool", REAL, async () => {
    const run = await reachR1("approval");
    run.proc.respondApproval("r1", "deny");
    expect(uiAnswers(run.launch.written)).toEqual([
      { type: "extension_ui_response", id: "r1", value: "Deny" },
    ]);
    await harness.waitFrame(run.proc, isTerminalEnd, 8_000, run.frames);
    expect(toolEnd(run.frames)).toMatchObject({
      toolCallId: "tool-1",
      isError: true,
      result: { content: [{ type: "text", text: "Tool call denied by user: bash" }] },
    });
    run.proc.respondApproval("r1", "allow");
    expect(uiAnswers(run.launch.written)).toHaveLength(1);
    expect(await probeFrames(run)).toBe(
      "negotiate_protocol,get_state,prompt,extension_ui_response,prompt",
    );
  });

  it(
    "E5 still cancels the non-approval confirm under write argv and surfaces nothing",
    REAL,
    async () => {
      const run = await startReal("extension-ui");
      await run.proc.send(PROMPT);
      await harness.waitFrame(run.proc, isTerminalEnd, 8_000, run.frames);
      expect(uiAnswers(run.launch.written)).toEqual([
        { type: "extension_ui_response", id: "ui-confirm-1", cancelled: true },
      ]);
      expect(run.approvals).toEqual([]);
    },
  );

  it(
    "E11 does not answer r1 while an abort is deferred; the owner's Deny releases it",
    REAL,
    async () => {
      const run = await reachR1("approval-then-abort");
      const abort = run.proc.request({ type: "abort", id: "a1" });
      const abortState = observePromise(abort);
      await quiet(run.proc, (frame) => frame.type === "agent_end");
      expect(uiAnswers(run.launch.written)).toEqual([]);
      expect(abortState.outcome).toBe("pending");
      run.proc.respondApproval("r1", "deny");
      await expect(abort).resolves.toMatchObject({ type: "response", command: "abort", id: "a1" });
      const after = run.frames.slice(run.frames.findIndex(isUi("r1")));
      const at = (predicate: (frame: OmpFrame) => boolean): number => after.findIndex(predicate);
      const denied = at((frame) => frame.type === "tool_execution_end" && frame.isError === true);
      const aborted = at(
        (frame) => frame.type === "message_end" && asRecord(frame.message).stopReason === "aborted",
      );
      const ended = at(isTerminalEnd);
      const answered = at((frame) => frame.type === "response" && frame.command === "abort");
      expect(denied).toBeGreaterThan(0);
      expect([denied < aborted, aborted < ended, ended < answered]).toEqual([true, true, true]);
      expect(await probeFrames(run)).toBe(
        "negotiate_protocol,get_state,prompt,abort,extension_ui_response,prompt",
      );
    },
  );

  it(
    "E12 writes the Deny synchronously, ahead of an abort issued in the same tick",
    REAL,
    async () => {
      const run = await reachR1("approval-then-abort");
      run.proc.respondApproval("r1", "deny");
      const abort = run.proc.request({ type: "abort", id: "a1" });
      const types = run.launch.written.map((frame) => frame.type);
      expect(types.slice(-2)).toEqual(["extension_ui_response", "abort"]);
      await expect(abort).resolves.toMatchObject({ command: "abort", id: "a1" });
      expect(await probeFrames(run)).toBe(
        "negotiate_protocol,get_state,prompt,extension_ui_response,abort,prompt",
      );
    },
  );
});

describe("OmpProcess UI request classification over synthetic frames", () => {
  it("E4 surfaces an unparseable tool name as unknown without cancelling it", async () => {
    const run = await startSynthetic();
    const title = "Allow tool: \nCommand: x";
    run.child.emitLine(selectFrame("u1", title, ["Approve", "Deny"]));
    await harness.waitFrame(run.proc, isUi("u1"), 8_000, run.frames);
    expect(run.approvals).toEqual([{ id: "u1", title, tool: "unknown" }]);
    await quiet(run.proc, () => false);
    expect(uiAnswers(run.written)).toEqual([]);
  });

  it("E6 cancels every non-approval shape and ignores an id-less approval shape", async () => {
    const run = await startSynthetic();
    const allow = "Allow tool: bash";
    const shapes: OmpFrame[] = [
      { type: "extension_ui_request", id: "n1", method: "input", title: allow },
      selectFrame("n2", allow, ["A", "B"]),
      selectFrame("n3", "Pick one", ["Approve", "Deny"]),
      selectFrame("n4", allow, ["Deny", "Approve"]),
      selectFrame("n5", "allow tool: bash", ["Approve", "Deny"]),
      selectFrame("n6", allow, ["Approve", "Deny", "Later"]),
      { type: "extension_ui_request", id: "n7", method: "confirm", title: allow },
    ];
    for (const shape of shapes) {
      run.child.emitLine(shape);
    }
    run.child.emitLine(selectFrame(undefined, allow, ["Approve", "Deny"]));
    await quiet(run.proc, () => false);
    expect(uiAnswers(run.written)).toEqual(
      shapes.map((shape) => ({ type: "extension_ui_response", id: shape.id, cancelled: true })),
    );
    expect(run.approvals).toEqual([]);
    expect(run.errors).toEqual([]);
  });

  it("E7 respondApproval after closeInput or child exit writes nothing and raises no error", async () => {
    const closers: ((run: Observed & { child: FakeChild }) => void)[] = [
      (run) => {
        run.proc.closeInput();
      },
      (run) => {
        run.child.exit(0);
      },
    ];
    for (const close of closers) {
      const run = await startSynthetic();
      run.child.emitLine(selectFrame("u2", "Allow tool: bash", ["Approve", "Deny"]));
      await harness.waitFrame(run.proc, isUi("u2"), 8_000, run.frames);
      expect(run.approvals).toEqual([{ id: "u2", title: "Allow tool: bash", tool: "bash" }]);
      const errorsBefore = run.errors.length;
      close(run);
      expect(() => {
        run.proc.respondApproval("u2", "allow");
      }).not.toThrow();
      await quiet(run.proc, () => false);
      expect(uiAnswers(run.written)).toEqual([]);
      expect(run.errors).toHaveLength(errorsBefore);
    }
  });

  it("E7 does not surface or answer an approval shape arriving after native exit", async () => {
    const run = await startSynthetic();
    run.child.nativeExit(0);
    run.child.emitLine(selectFrame("u3", "Allow tool: bash", ["Approve", "Deny"]));
    run.child.endStdout();
    await harness.waitExit(run.proc);
    expect(run.frames.some(isUi("u3"))).toBe(true);
    expect(run.approvals).toEqual([]);
    expect(uiAnswers(run.written)).toEqual([]);
  });

  it("routes a failed approval write to the transport error path, not an unhandled rejection", async () => {
    const run = await startSynthetic();
    run.child.emitLine(selectFrame("u4", "Allow tool: bash", ["Approve", "Deny"]));
    await harness.waitFrame(run.proc, isUi("u4"), 8_000, run.frames);
    run.child.failWrites(new Error(`EIO ${TOKEN}`));
    run.proc.respondApproval("u4", "deny");
    await waitImmediate();
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0]).toBeInstanceOf(AgentUnavailableError);
    expect(harness.includesSecret(run.errors[0], TOKEN)).toBe(false);
    run.proc.respondApproval("u4", "deny");
    await waitImmediate();
    expect(run.errors).toHaveLength(1);
  });
});

describe("SessionRuntime never answers an outstanding approval", () => {
  function openRuntime(launched: Launch, idleMs: number): SessionRuntime {
    const { runtime } = launched.real;
    return new SessionRuntime({
      sessionId: "sess-approval-460",
      bin: runtime.bin,
      sandboxRoot: runtime.sandboxRoot,
      stateDir: runtime.stateDir,
      ownerId: "u1",
      modelId: runtime.modelId,
      tokens: createTokens(TOKEN),
      idleMs,
      clock: launched.real.clock,
      spawnImpl: launched.spawnImpl,
    });
  }

  async function iterateToR1(runtime: SessionRuntime): Promise<AsyncIterator<OmpFrame>> {
    const iterator = runtime.prompt("run the tool")[Symbol.asyncIterator]();
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) {
        throw new Error("turn ended before the r1 approval select");
      }
      if (isUi("r1")(step.value)) {
        return iterator;
      }
    }
  }

  it(
    "E8 stays silent past 120s of injected time, then shutdown closes stdin without answering",
    REAL,
    async () => {
      const launched = launch("approval");
      const runtime = openRuntime(launched, 600_000);
      const iterator = await iterateToR1(runtime);
      launched.real.clock.advance(120_000);
      const next = iterator.next();
      void next.catch(() => {});
      expect(await settlesWithin(next, QUIET_MS)).toBe(false);
      const watch = launched.watches[0];
      expect(uiAnswers(launched.written)).toEqual([]);
      expect(watch?.signals).toEqual([]);
      await runtime.shutdown();
      await expect(next).rejects.toBeInstanceOf(AgentUnavailableError);
      expect(await watch?.exit).toEqual({ code: 0, signal: null });
      expect(watch?.stdinEnded).toBe(true);
      expect(watch?.signals).toEqual([]);
      expect(uiAnswers(launched.written)).toEqual([]);
    },
  );

  it("E9 idle retirement ends the child on EOF and never answers r1", REAL, async () => {
    const launched = launch("approval");
    const runtime = openRuntime(launched, 100_000);
    const iterator = await iterateToR1(runtime);
    const next = iterator.next();
    void next.catch(() => {});
    launched.real.clock.advance(100_000);
    const watch = launched.watches[0];
    expect(await watch?.exit).toEqual({ code: 0, signal: null });
    await expect(next).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(watch?.signals).toEqual([]);
    expect(uiAnswers(launched.written)).toEqual([]);
    await runtime.shutdown();
    expect(uiAnswers(launched.written)).toEqual([]);
  });
});

describe("omp source boundary guards", () => {
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/sessions/omp/${name}`, import.meta.url)), "utf8");

  it("E10 keeps extension_ui_response out of runtime.ts and commands.ts", () => {
    expect(source("runtime.ts")).not.toMatch(/extension_ui_response/u);
    expect(source("commands.ts")).not.toMatch(/extension_ui_response/u);
  });

  it("E10 keeps ui-requests.ts free of transport imports and child input writes", () => {
    expect(source("ui-requests.ts")).not.toMatch(
      /from "\.\/(process|runtime|commands)\.js"|stdin/u,
    );
  });
});
