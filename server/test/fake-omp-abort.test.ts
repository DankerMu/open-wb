/**
 * Issue #456 fake-omp abort scenarios (parent s1c-turn-control-governance 6.1).
 * `abort-ok` 兑现入站 abort：message_end aborted → agent_end → response{command:"abort"}（无 data，
 * 同 omp v18.0.10 rpc-mode）；`abort-ignored` 收到 abort 不回任何帧，但仍可被 stdin 关闭或 SIGTERM 终止。
 * 真实子进程；帧读取复用 fake-omp-helpers.ts。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  PROMPT,
  response,
  type Session,
  startFake,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const ABORT = { type: "abort", id: "req_abort" };
const QUIET_MS = 300;

afterEach(async () => {
  await stopFakeChildren();
});

/** 帧序比对用的紧凑描述：类型 + 与 abort 语义相关的字段。 */
function describeFrame(frame: Frame): string {
  if (isTextDelta(frame)) {
    return `delta:${String(asRecord(frame.assistantMessageEvent).delta)}`;
  }
  if (frame.type === "message_end") {
    return `message_end:${String(asRecord(frame.message).stopReason)}`;
  }
  if (frame.type === "response") {
    return `response:${String(frame.id)}:${String(frame.command)}`;
  }
  return String(frame.type);
}

function indexOfResponse(session: Session, id: string, command: string): number {
  return session.frames.findIndex(response(id, command));
}

function isAbortResponse(frame: Frame): boolean {
  return frame.type === "response" && frame.command === "abort";
}

function expectAbortedTurnEnd(frames: Frame[]): void {
  expect(frames).toHaveLength(3);
  const [end, agentEnd, reply] = frames;
  expect(end?.type).toBe("message_end");
  expect(asRecord(end?.message).stopReason).toBe("aborted");
  expect(asRecord(end?.message).role).toBe("assistant");
  expect(agentEnd).toMatchObject({ type: "agent_end", isTerminal: true });
  expect(reply).toEqual({ id: "req_abort", type: "response", command: "abort", success: true });
}

/** prompt ack 之后恰好 agent_start 与两段 delta，返回这之后应有的帧总数。 */
async function expectHeldTurn(session: Session): Promise<number> {
  const ack = indexOfResponse(session, "req_1", "prompt");
  expect(ack).toBeGreaterThanOrEqual(0);
  const held = ack + 4;
  await session.wait(() => session.frames.length >= held);
  await expect(session.wait(() => session.frames.length > held, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
  expect(session.frames.slice(ack + 1).map(describeFrame)).toEqual([
    "agent_start",
    "delta:Hello ",
    "delta:from ",
  ]);
  return held;
}

describe("fake-omp abort-ok", () => {
  it("holds the turn after two deltas, honors abort, then runs the next prompt by default", async () => {
    const session = await startPromptedSession({ scenario: "abort-ok" });
    const held = await expectHeldTurn(session);

    session.write(ABORT);
    await session.wait(isAbortResponse);
    expectAbortedTurnEnd(session.frames.slice(held));

    session.write({ id: "req_2", type: "prompt", message: "again" });
    const ack = await session.wait(response("req_2", "prompt"));
    expect(ack).toMatchObject({ success: true });
    const ackIndex = indexOfResponse(session, "req_2", "prompt");
    await session.wait(
      (frame) =>
        frame.type === "agent_end" &&
        frame.isTerminal !== false &&
        session.frames.indexOf(frame) > ackIndex,
    );
    const turn = session.frames.slice(ackIndex + 1);
    expect(turn.filter(isTextDelta).length).toBeGreaterThanOrEqual(3);
    const stop = turn.find(
      (frame) => frame.type === "message_end" && asRecord(frame.message).stopReason === "stop",
    );
    expect(asRecord(stop?.message).role).toBe("assistant");
    expect(turn.at(-1)).toMatchObject({ type: "agent_end", isTerminal: true });
    await closeSession(session);
  });

  it("defers an abort read before agent_start until the two deltas are out", async () => {
    const session = startFake({ scenario: "abort-ok" });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await session.wait(response("protocol-1", "negotiate_protocol"));
    await session.wait(response("state-1", "get_state"));
    session.write([PROMPT, ABORT]);
    await session.wait(isAbortResponse);

    const ack = indexOfResponse(session, String(PROMPT.id), "prompt");
    expect(ack).toBeGreaterThanOrEqual(0);
    expect(session.frames.slice(ack + 1).map(describeFrame)).toEqual([
      "agent_start",
      "delta:Hello ",
      "delta:from ",
      "message_end:aborted",
      "agent_end",
      "response:req_abort:abort",
    ]);
    expectAbortedTurnEnd(session.frames.slice(ack + 4));
    await closeSession(session);
  });
});

describe("fake-omp abort-ignored", () => {
  it("stays silent and alive after abort, then exits 0 once stdin closes", async () => {
    const session = await startPromptedSession({ scenario: "abort-ignored" });
    const held = await expectHeldTurn(session);

    session.write(ABORT);
    await expect(session.wait(() => session.frames.length > held, QUIET_MS)).rejects.toThrow(
      /timed out/,
    );
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
  });

  it("terminates on SIGTERM", async () => {
    const child = spawn(process.execPath, [FAKE, "--scenario", "abort-ignored"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      await new Promise<void>((resolve, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes('"type":"ready"')) {
            resolve();
          }
        });
        child.on("close", () => reject(new Error(`exited before ready: ${stdout}`)));
      });
      child.kill("SIGTERM");
      const exit = await closed;
      expect(exit.code !== null || exit.signal === "SIGTERM").toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("fake-omp default abort guard", () => {
  it("keeps answering abort with the unsupported fallback under normal", async () => {
    const session = await startPromptedSession();
    await session.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    session.write(ABORT);
    const reply = await session.wait(isAbortResponse);
    expect(reply).toEqual({
      type: "response",
      command: "abort",
      success: false,
      error: "unsupported",
    });
    await closeSession(session);
  });
});
