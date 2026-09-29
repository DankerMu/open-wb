/**
 * Issue #650 fake-omp `--start-delay-ms` (change stop-after-agent-start, design F1–F3). omp v18.0.10
 * (#495, parent design Open Question 2 (c)): an `abort` read after the prompt ack but before the
 * turn's `agent_start` makes the still pre-processing prompt bail — the abort is answered success
 * and the turn never emits a frame. `abort-ok`/`slow-ready` model that window with the knob; with
 * the abort after `agent_start` the held turn is unchanged. Real child processes observed only
 * through fake-omp-helpers.ts; timing asserts lower bounds only. Expected frames are literals.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Frame,
  HANDSHAKE,
  PROMPT,
  response,
  type Session,
  startFake,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const SUPPORT = fileURLToPath(new URL("./support/", import.meta.url));
const QUIET_MS = 500;
const ABORT = { type: "abort", id: "req_abort" };
const ABORT_OK = { id: "req_abort", type: "response", command: "abort", success: true };
const START = (n: number | string): string[] => ["--start-delay-ms", String(n)];
const AGENT_END = { type: "agent_end", messages: [], isTerminal: true };
const CALL = { toolCallId: "tool-1", toolName: "bash" };
/** The held `abort-ok` turn after the ack, and its aborted tail (fake-omp-abort.test.ts). */
const HELD = [{ type: "agent_start" }, delta("Hello "), delta("from ")];
const ABORTED = [messageEnd("aborted"), AGENT_END, ABORT_OK];
/** The default complete turn (fake-omp-slow-ready.test.ts `script`). */
const DEFAULT_TURN = [
  { type: "agent_start" },
  delta("Hello "),
  delta("from "),
  delta("fake-omp"),
  messageEnd("toolUse"),
  { type: "tool_execution_start", ...CALL, args: { command: "echo workbuddy-smoke" } },
  {
    type: "tool_execution_end",
    ...CALL,
    result: { content: [{ type: "text", text: "workbuddy-smoke" }], details: { exitCode: 0 } },
  },
  messageEnd("stop"),
  AGENT_END,
];
/** Both knob scenarios; slow-ready's ready delay is zeroed so only the start delay is observed. */
const KNOBBED = [
  { scenario: "abort-ok", extraArgs: START(200) },
  { scenario: "slow-ready", extraArgs: ["--ready-delay-ms", "0", ...START(200)] },
];

afterEach(stopFakeChildren);

function delta(text: string): Frame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
    message: { role: "assistant", content: [] },
  };
}

function messageEnd(stopReason: string): Frame {
  return { type: "message_end", message: { role: "assistant", content: [], stopReason } };
}

function ackIndex(session: Session, id: string): number {
  return session.frames.findIndex(response(id, "prompt"));
}

async function expectQuiet(session: Session, count: number): Promise<void> {
  await expect(session.wait(() => session.frames.length > count, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
}

/** A second prompt `req_2` runs the default complete turn. */
async function expectDefaultTurn(session: Session): Promise<void> {
  session.write({ id: "req_2", type: "prompt", message: "again" });
  await session.wait(response("req_2", "prompt"));
  const ack = ackIndex(session, "req_2");
  await session.wait(() => session.frames.length >= ack + 1 + DEFAULT_TURN.length);
  expect(session.frames.slice(ack + 1)).toEqual(DEFAULT_TURN);
}

async function exitsCleanly(session: Session): Promise<void> {
  session.closeStdin();
  expect(await session.waitExit()).toBe(0);
  expect(session.stderr).toBe("");
}

describe("fake-omp abort before the turn starts (#650)", () => {
  it.each(KNOBBED)(
    "F1 $scenario: an abort before agent_start is answered success and the whole turn is dropped",
    async (options) => {
      const session = await startPromptedSession(options);
      session.write(ABORT);
      await session.wait(response("req_abort", "abort"));
      const ack = ackIndex(session, "req_1");
      expect(session.frames.slice(ack + 1)).toEqual([ABORT_OK]);

      await expectQuiet(session, session.frames.length);
      expect(session.frames.slice(ack + 1)).toEqual([ABORT_OK]);

      await expectDefaultTurn(session);
      await exitsCleanly(session);
    },
  );

  it.each(KNOBBED)(
    "F2 $scenario: after the delayed agent_start an abort ends the held turn exactly like abort-ok",
    async (options) => {
      const t0 = performance.now();
      const session = await startPromptedSession(options);
      const ack = ackIndex(session, "req_1");
      await session.wait(() => session.frames.length >= ack + 1 + HELD.length);
      expect(performance.now() - t0).toBeGreaterThanOrEqual(200);
      await expectQuiet(session, ack + 1 + HELD.length);
      expect(session.frames.slice(ack + 1)).toEqual(HELD);

      session.write(ABORT);
      await session.wait(response("req_abort", "abort"));
      expect(session.frames.slice(ack + 1)).toEqual([...HELD, ...ABORTED]);

      await expectDefaultTurn(session);
      await exitsCleanly(session);
    },
  );
});

describe("fake-omp --start-delay-ms guards (#650)", () => {
  it("F3a an invalid or missing value exits 1 with no frames under abort-ok and slow-ready", async () => {
    const sessions = [
      ...["-1", "abc", "1.5"].map((value) =>
        startFake({ extraArgs: START(value), scenario: "abort-ok" }),
      ),
      startFake({ extraArgs: START("abc"), scenario: "slow-ready" }),
      startFake({ extraArgs: ["--scenario", "abort-ok", "--start-delay-ms"] }),
    ];
    const codes = await Promise.all(sessions.map((session) => session.waitExit()));
    expect(codes).toEqual([1, 1, 1, 1, 1]);
    for (const session of sessions) {
      expect(session.stdout).toBe("");
      expect(session.stderr).toContain("invalid --start-delay-ms");
    }
  });

  it.each(["normal", "abort-ignored"])(
    "F3b %s ignores the knob and its value: the outbound bytes are unchanged",
    async (scenario) => {
      const plain = await scriptedTurn({ scenario });
      const knobbed = await scriptedTurn({ scenario, extraArgs: START("abc") });
      expect(knobbed.stderr).toBe("");
      expect(knobbed.stdout).toBe(plain.stdout);
    },
  );

  it("F3c a zero knob keeps abort-ok's frame order, an abort written with the prompt included", async () => {
    const plain = await promptAndAbort({ scenario: "abort-ok" });
    const zero = await promptAndAbort({ scenario: "abort-ok", extraArgs: START(0) });
    expect(zero.stdout).toBe(plain.stdout);
    const ack = ackIndex(zero, "req_1");
    expect(zero.frames.slice(ack + 1)).toEqual([...HELD, ...ABORTED]);
  });
});

/** Handshake, one prompt, then the turn's end (`normal`) or its held head (`abort-ignored`). */
async function scriptedTurn(options: Parameters<typeof startFake>[0]): Promise<Session> {
  const session = await startPromptedSession(options);
  const ack = ackIndex(session, "req_1");
  const done = options?.scenario === "normal" ? DEFAULT_TURN.length : HELD.length;
  await session.wait(() => session.frames.length >= ack + 1 + done);
  await expectQuiet(session, ack + 1 + done);
  await exitsCleanly(session);
  return session;
}

/** prompt and abort in one write after the handshake; waits for the abort's answer. */
async function promptAndAbort(options: Parameters<typeof startFake>[0]): Promise<Session> {
  const session = startFake(options);
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("state-1", "get_state"));
  session.write([PROMPT, ABORT]);
  await session.wait(response("req_abort", "abort"));
  await exitsCleanly(session);
  return session;
}

describe("fake omp argv module split (#650)", () => {
  it("keeps fake-omp-argv.mjs a node-only leaf statically imported by main, all four within 800 lines", () => {
    const argv = readFileSync(join(SUPPORT, "fake-omp-argv.mjs"), "utf8");
    const imports = argv.split("\n").filter((line) => line.startsWith("import"));
    for (const line of imports) {
      expect(line).toMatch(/from "node:[a-z/]+";$/);
    }
    expect(imports.join("\n")).not.toMatch(/fake-omp/);
    expect(argv).not.toMatch(/\bimport\(|\brequire\(/);
    expect(argv).not.toMatch(/^let /m);
    expect(argv.startsWith("#!")).toBe(false);
    for (const leaf of ["fake-omp-proxy.mjs", "fake-omp-thinking.mjs"]) {
      expect(readFileSync(join(SUPPORT, leaf), "utf8")).not.toMatch(/fake-omp-argv/);
    }
    const main = readFileSync(join(SUPPORT, "fake-omp.mjs"), "utf8");
    expect(main).toMatch(/^import \{[^}]+\} from "\.\/fake-omp-argv\.mjs";$/m);
    for (const name of [
      "fake-omp.mjs",
      "fake-omp-argv.mjs",
      "fake-omp-proxy.mjs",
      "fake-omp-thinking.mjs",
    ]) {
      const file = join(SUPPORT, name);
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
      expect(readFileSync(file, "utf8").split("\n").length - 1).toBeLessThanOrEqual(800);
    }
  });
});
