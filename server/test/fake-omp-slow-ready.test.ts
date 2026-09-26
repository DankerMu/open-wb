/**
 * Issue #461 fake-omp `slow-ready` scenario (parent s1c-turn-control-governance 6.5).
 * `--ready-delay-ms <n>`（缺省 500）扣住 ready，到期后与 abort-ok 逐字节一致；延迟期间 stdin 关闭零帧退出 0；
 * 非法值退出 1。真实子进程，只经 fake-omp-helpers.ts 观察 stdout/stderr/退出码；计时只断言下界。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  PROMPT,
  response,
  type Session,
  startFake,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

type StartOptions = Parameters<typeof startFake>[0];

const QUIET_MS = 300;
const ABORT = { type: "abort", id: "req_abort" };
const KNOB = (n: number | string): string[] => ["--ready-delay-ms", String(n)];
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
};
const AGENT_END = { type: "agent_end", messages: [], isTerminal: true };
const ABORTED = [
  messageEnd("aborted"),
  AGENT_END,
  { id: "req_abort", type: "response", command: "abort", success: true },
];
const CALL = { toolCallId: "tool-1", toolName: "bash" };

const tmps: string[] = [];

afterEach(stopFakeChildren);
afterEach(() => {
  for (const dir of tmps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/** 从 spawn 前起算到 ready；返回时 ready 必须是唯一一帧且与 normal 逐字节相同。 */
async function readyAfter(options: StartOptions): Promise<{ session: Session; elapsed: number }> {
  const t0 = performance.now();
  const session = startFake(options);
  await session.wait((frame) => frame.type === "ready");
  const elapsed = performance.now() - t0;
  expect(session.frames).toEqual([READY]);
  expect(session.stdout).toBe(`${JSON.stringify(READY)}\n`);
  return { session, elapsed };
}

async function handshake(session: Session): Promise<void> {
  session.write(HANDSHAKE);
  await session.wait(response("protocol-1", "negotiate_protocol"));
  await session.wait(response("state-1", "get_state"));
}

function indexAfter(session: Session, id: string, command: string): number {
  return session.frames.findIndex(response(id, command));
}

/** 等 `from` 下标之后首个满足 predicate 的帧，返回其下标。 */
async function waitAfter(
  session: Session,
  from: number,
  predicate: (frame: Frame) => boolean,
): Promise<number> {
  const match = await session.wait(
    (frame) => predicate(frame) && session.frames.indexOf(frame) > from,
  );
  return session.frames.indexOf(match);
}

async function expectQuiet(session: Session, count: number): Promise<void> {
  await expect(session.wait(() => session.frames.length > count, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
}

/** 握手 → 持有回合 → abort 三帧 → 下一 prompt 走缺省回合 → 关闭退出 0。 */
async function script(session: Session): Promise<void> {
  await handshake(session);
  session.write(PROMPT);
  await session.wait(response("req_1", "prompt"));
  const ack = indexAfter(session, "req_1", "prompt");
  await session.wait(() => session.frames.length >= ack + 4);
  await expectQuiet(session, ack + 4);
  expect(session.frames.slice(ack + 1)).toEqual([
    { type: "agent_start" },
    delta("Hello "),
    delta("from "),
  ]);

  session.write(ABORT);
  await session.wait(response("req_abort", "abort"));
  expect(session.frames.slice(ack + 4)).toEqual(ABORTED);

  session.write({ id: "req_2", type: "prompt", message: "again" });
  await session.wait(response("req_2", "prompt"));
  const ack2 = indexAfter(session, "req_2", "prompt");
  await waitAfter(session, ack2, (frame) => frame.type === "agent_end");
  expect(session.frames.slice(ack2 + 1)).toEqual([
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
  ]);

  session.closeStdin();
  expect(await session.waitExit()).toBe(0);
}

describe("fake-omp slow-ready", () => {
  it("E1 holds ready for the knob delay, then behaves byte-for-byte like abort-ok", async () => {
    const { session: slow, elapsed } = await readyAfter({
      extraArgs: KNOB(300),
      scenario: "slow-ready",
    });
    expect(elapsed).toBeGreaterThanOrEqual(300);
    await script(slow);

    const abortOk = startFake({ scenario: "abort-ok" });
    await abortOk.wait((frame) => frame.type === "ready");
    await script(abortOk);

    expect(slow.stdout).toBe(abortOk.stdout);
  });

  it("E2 defaults the delay to 500ms", async () => {
    const { session, elapsed } = await readyAfter({ scenario: "slow-ready" });
    expect(elapsed).toBeGreaterThanOrEqual(500);
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
  });

  it("E3 reads the knob before or after --scenario", async () => {
    const [before, after] = await Promise.all([
      readyAfter({ extraArgs: KNOB(1200), scenario: "slow-ready" }),
      readyAfter({ extraArgs: ["--scenario", "slow-ready", ...KNOB(1200)] }),
    ]);
    expect(before.elapsed).toBeGreaterThanOrEqual(1200);
    expect(after.elapsed).toBeGreaterThanOrEqual(1200);
  });

  it("E4 exits 0 with no frames when stdin closes during the delay", async () => {
    const session = startFake({ extraArgs: KNOB(30_000), scenario: "slow-ready" });
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
    expect(session.stdout).toBe("");
    expect(session.stderr).toBe("");
  });

  it("E5 rejects an invalid or missing knob value with exit 1 and no frames", async () => {
    const sessions = [
      ...["-1", "1.5", "abc", "2147483648"].map((value) =>
        startFake({ extraArgs: KNOB(value), scenario: "slow-ready" }),
      ),
      startFake({ extraArgs: ["--scenario", "slow-ready", "--ready-delay-ms"] }),
    ];
    const codes = await Promise.all(sessions.map((session) => session.waitExit()));
    expect(codes).toEqual([1, 1, 1, 1, 1]);
    for (const session of sessions) {
      expect(session.stdout).toBe("");
      expect(session.stderr).toContain("invalid --ready-delay-ms");
    }
  });

  it("E6 honors prompt+abort written together after the delayed handshake; probe sees the frame order", async () => {
    const { session, elapsed } = await readyAfter({
      extraArgs: KNOB(300),
      scenario: "slow-ready",
    });
    expect(elapsed).toBeGreaterThanOrEqual(300);
    await handshake(session);
    session.write([PROMPT, ABORT]);
    await session.wait((frame) => isDeepStrictEqual(frame, ABORTED[2]));
    const ack = indexAfter(session, "req_1", "prompt");
    expect(session.frames.slice(ack + 1)).toEqual([
      { type: "agent_start" },
      delta("Hello "),
      delta("from "),
      ...ABORTED,
    ]);

    const tmp = mkdtempSync(join(tmpdir(), "fake-omp-slow-ready-"));
    tmps.push(tmp);
    session.write({
      id: "req_probe",
      type: "prompt",
      message: `probe:${process.pid}:${join(tmp, "probe.txt")}`,
    });
    await session.wait(response("req_probe", "prompt"));
    const probeAck = indexAfter(session, "req_probe", "prompt");
    const at = await waitAfter(session, probeAck, isTextDelta);
    const report = String(asRecord(session.frames[at]?.assistantMessageEvent).delta);
    expect(report.split(" frames=")).toHaveLength(2);
    expect(/ frames=([^ ]*)$/u.exec(report)?.[1]).toBe(
      "negotiate_protocol,get_state,prompt,abort,prompt",
    );
    const end = await waitAfter(session, probeAck, (frame) => frame.type === "agent_end");
    expect(session.frames.slice(end - 1, end + 1)).toEqual([messageEnd("stop"), AGENT_END]);
  });
});

describe("fake-omp slow-ready guards", () => {
  it("G1 other scenarios ignore the knob, valid or not", async () => {
    const sessions = [
      startFake({ extraArgs: KNOB(30_000), scenario: "normal" }),
      startFake({ extraArgs: KNOB("abc"), scenario: "normal" }),
    ];
    for (const session of sessions) {
      await session.wait((frame) => frame.type === "ready");
      await handshake(session);
      session.closeStdin();
      expect(await session.waitExit()).toBe(0);
    }
  });

  it("G2 no-ready still never sends ready", async () => {
    const session = startFake({ extraArgs: KNOB(0), scenario: "no-ready" });
    session.write(HANDSHAKE);
    const negotiated = await session.wait(response("protocol-1", "negotiate_protocol"));
    expect(negotiated.success).toBe(true);
    await expect(session.wait((frame) => frame.type === "ready", QUIET_MS)).rejects.toThrow(
      /timed out/,
    );
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
  });

  it("G3 closing stdin after the delay takes the existing exit path; 0 is a valid knob", async () => {
    const { session } = await readyAfter({ extraArgs: KNOB(0), scenario: "slow-ready" });
    // 只守 knob 0 合法、到期后 close 走既有路径并发出排队响应；父进程持续读 stdout 时 readyTimer 清空语句被删的变异不可观测。
    session.write(HANDSHAKE);
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
    expect(session.frames).toHaveLength(3);
    expect(session.frames[0]).toEqual(READY);
    expect(
      session.frames.slice(1).map((frame) => [frame.id, frame.command, frame.success]),
    ).toEqual([
      ["protocol-1", "negotiate_protocol", true],
      ["state-1", "get_state", true],
    ]);
    expect(session.stdout).toBe(
      session.frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""),
    );
  });
});
