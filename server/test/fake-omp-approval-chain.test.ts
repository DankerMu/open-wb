/**
 * Issue #470 fake-omp `approval-chain-abort-ignored`（父 s1c-turn-control-governance 6.6）。
 * 仅最后一个 `--approval-mode` 恰为 write 时门控：开头同 `approval`（r1 select 先于 C1 start，#620），
 * r1 任意应答后依次发 C1 结束帧、C1 toolResult、r2 select 与 C2 start；r2 应答后发 C2 结束帧与其
 * toolResult 并永久挂起。任何时刻的 abort 都不产生帧、不被延后兑现；进程只在 stdin 关闭或 SIGTERM 时
 * 退出。帧形状钉在 omp v18.0.10（见 change tasks.md）。真实子进程；缺省 argv 即生产的 write。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  type Frame,
  HANDSHAKE,
  PROMPT,
  response,
  type Session,
  type StartOptions,
  startFake,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const CHAIN = "approval-chain-abort-ignored";
const WRITE = ["--approval-mode", "write"];
const YOLO = ["--approval-mode", "yolo"];
const QUIET_MS = 300;
const ABORT = { type: "abort", id: "req_abort" };

afterEach(async () => {
  await stopFakeChildren();
});

interface Call {
  id: string;
  command: string;
}
const C1: Call = { id: "tool-1", command: "echo workbuddy-smoke" };
const C2: Call = { id: "tool-2", command: "echo workbuddy-smoke-2" };

function start(call: Call): Frame {
  return {
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: "bash",
    args: { command: call.command },
  };
}

function select(id: string, call: Call): Frame {
  const title = `Allow tool: bash\nCommand: ${call.command}`;
  const options = ["Approve", "Deny"];
  return { type: "extension_ui_request", id, method: "select", title, options };
}

/** 成功结束不带 isError 键；拒绝结束带 `isError: true`。 */
function end(call: Call, approved: boolean): Frame {
  const base = { type: "tool_execution_end", toolCallId: call.id, toolName: "bash" };
  if (approved) {
    const content = [{ type: "text", text: "workbuddy-smoke" }];
    return { ...base, result: { content, details: { exitCode: 0 } } };
  }
  const content = [{ type: "text", text: "Tool call denied by user: bash" }];
  return { ...base, result: { content, details: {} }, isError: true };
}

/** end 之后紧跟的 toolResult message_end：content 同 end 的 result.content，isError 恒为布尔。 */
function ended(call: Call, approved: boolean): Frame[] {
  const frame = end(call, approved);
  const { content } = asRecord(frame.result);
  const message = { role: "toolResult", toolCallId: call.id, toolName: "bash", content };
  return [frame, { type: "message_end", message: { ...message, isError: !approved } }];
}

/** ack 之后的门控前缀：agent_start、三段 delta、toolUse message_end（仅 C1 块）、r1 select、C1 start。 */
const PREFIX: Frame[] = [
  { type: "agent_start" },
  ...["Hello ", "from ", "fake-omp"].map((delta) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta },
    message: { role: "assistant", content: [] },
  })),
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: C1.id, name: "bash", arguments: { command: C1.command } }],
      stopReason: "toolUse",
    },
  },
  select("r1", C1),
  start(C1),
];

/** r1 应答后恰好新增的四帧。 */
function chained(approved: boolean): Frame[] {
  return [...ended(C1, approved), select("r2", C2), start(C2)];
}

function answer(id: string, reply: Frame): Frame {
  return { type: "extension_ui_response", id, ...reply };
}

/** 观察窗：超时（而非子进程退出）即同时证明「无新帧」与「仍存活」。 */
async function quiet(session: Session): Promise<void> {
  const seen = session.frames.length;
  await expect(session.wait(() => session.frames.length > seen, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
}

/** 自 `from` 起新增帧恰为 `expected`，其后观察窗无帧。 */
async function appended(session: Session, from: number, expected: Frame[]): Promise<void> {
  await session.wait(() => session.frames.length >= from + expected.length);
  await quiet(session);
  expect(session.frames.slice(from)).toEqual(expected);
}

/** 写入一帧并断言新增帧恰为 `expected`。 */
async function send(session: Session, frame: Frame | Frame[], expected: Frame[]): Promise<void> {
  const from = session.frames.length;
  session.write(frame);
  await appended(session, from, expected);
}

async function expectPrefixAfterAck(session: Session): Promise<void> {
  const ack = session.frames.findIndex(response(String(PROMPT.id), "prompt"));
  expect(ack).toBeGreaterThanOrEqual(0);
  await appended(session, ack + 1, PREFIX);
}

async function promptedChain(): Promise<Session> {
  const session = await startPromptedSession({ scenario: CHAIN, extraArgs: WRITE });
  await expectPrefixAfterAck(session);
  return session;
}

/** 无收尾：没有 agent_end、abort 应答，也没有 stop/aborted 的 message_end。 */
function expectUnfinished(session: Session): void {
  const finishing = session.frames.filter(
    (frame) =>
      frame.type === "agent_end" ||
      (frame.type === "response" && frame.command === "abort") ||
      (frame.type === "message_end" &&
        ["stop", "aborted"].includes(String(asRecord(frame.message).stopReason))),
  );
  expect(finishing).toEqual([]);
}

async function expectCleanExit(session: Session): Promise<void> {
  session.closeStdin();
  expect(await session.waitExit()).toBe(0);
}

describe("fake-omp approval-chain-abort-ignored under write", () => {
  it("chains r2 after a denied r1, then ignores abort and a repeated r1 answer", async () => {
    const session = await promptedChain();
    await send(session, answer("r1", { value: "Deny" }), chained(false));
    await send(session, ABORT, []);
    await send(session, answer("r1", { value: "Approve" }), []);
    session.write({ id: "state-2", type: "get_state" });
    await session.wait(response("state-2", "get_state"));
    expectUnfinished(session);
    await expectCleanExit(session);
  });

  it.each([
    [{ value: "Approve" }, { value: "Deny" }, true, false],
    [{ cancelled: true }, { value: "Approve" }, false, true],
    [{ value: "approve" }, { cancelled: true, value: "Approve" }, false, false],
  ])("answers r1 %j then r2 %j and stays suspended", async (first, second, firstOk, secondOk) => {
    const session = await promptedChain();
    const c1End = session.frames.length;
    await send(session, answer("r1", first), chained(firstOk));
    expect("isError" in asRecord(session.frames[c1End])).toBe(!firstOk);
    const c2End = session.frames.length;
    await send(session, answer("r2", second), ended(C2, secondOk));
    expect("isError" in asRecord(session.frames[c2End])).toBe(!secondOk);
    await send(session, ABORT, []);
    expectUnfinished(session);
    await expectCleanExit(session);
  });

  const DENY_R1 = answer("r1", { value: "Deny" });
  /** 各时机把回合推进到「r2 挂起」；TAIL 在其后统一执行。 */
  const timings: [string, () => Promise<Session>][] = [
    [
      "while r1 is pending",
      async () => {
        const session = await promptedChain();
        await send(session, ABORT, []);
        await send(session, DENY_R1, chained(false));
        return session;
      },
    ],
    [
      "between r1 and r2",
      async () => {
        const session = await promptedChain();
        await send(session, [DENY_R1, ABORT], chained(false));
        return session;
      },
    ],
    [
      "while r2 is pending",
      async () => {
        const session = await promptedChain();
        await send(session, DENY_R1, chained(false));
        await send(session, ABORT, []);
        return session;
      },
    ],
    [
      "while idle before the prompt",
      async () => {
        const session = startFake({ scenario: CHAIN, extraArgs: WRITE });
        await session.wait((frame) => frame.type === "ready");
        session.write(HANDSHAKE);
        await session.wait(response("state-1", "get_state"));
        await send(session, ABORT, []);
        session.write(PROMPT);
        await session.wait(response(String(PROMPT.id), "prompt"));
        await expectPrefixAfterAck(session);
        await send(session, DENY_R1, chained(false));
        return session;
      },
    ],
  ];

  it.each(timings)("never honours an abort written %s", async (_timing, reachR2) => {
    const session = await reachR2();
    // TAIL：只有 r2 答完才会结算，错误记下的延后 abort 只在这一步暴露。
    await send(session, answer("r2", { value: "Deny" }), ended(C2, false));
    expectUnfinished(session);
  });

  it("exits on SIGTERM while r2 is pending after an ignored abort", async () => {
    const child = spawn(process.execPath, [FAKE, ...WRITE, "--scenario", CHAIN]);
    try {
      const closed = once(child, "close");
      const next = frameReader(child);
      const push = (frames: Frame[]): void => {
        child.stdin.write(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(""));
      };
      await next((frame) => frame.type === "ready");
      push(HANDSHAKE);
      await next(response("protocol-1", "negotiate_protocol"));
      await next(response("state-1", "get_state"));
      push([PROMPT]);
      await next((frame) => frame.id === "r1" && frame.method === "select");
      push([DENY_R1]);
      await next((frame) => frame.id === "r2" && frame.method === "select");
      push([ABORT]);
      child.kill("SIGTERM");
      // 无 SIGTERM 处理器：以信号退出，close 为 (code=null, signal="SIGTERM")。
      expect(await closed).toEqual([null, "SIGTERM"]);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

/** 最小 JSONL 读取器：返回按谓词等待首个匹配帧的函数，2s 内未见则带已收帧报错。 */
function frameReader(
  child: ChildProcessWithoutNullStreams,
): (predicate: (frame: Frame) => boolean) => Promise<Frame> {
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    frames.push(JSON.parse(line) as Frame);
    for (const waiter of waiters) {
      waiter();
    }
  });
  return (predicate) =>
    new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`no matching frame; got ${JSON.stringify(frames)}`));
      }, 2_000);
      const check = (): void => {
        const hit = frames.find(predicate);
        if (hit !== undefined) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(hit);
        }
      };
      waiters.add(check);
      check();
    });
}

describe("fake-omp approval-chain-abort-ignored without write", () => {
  async function settledFrames(options: StartOptions = {}): Promise<Frame[]> {
    const session = await startPromptedSession(options);
    await session.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    session.write(ABORT);
    await session.wait((frame) => frame.type === "response" && frame.command === "abort");
    return session.frames;
  }

  it("behaves exactly like normal under yolo, including the last --approval-mode", async () => {
    const [baseline, yolo, lastYolo] = await Promise.all([
      settledFrames(),
      settledFrames({ scenario: CHAIN, extraArgs: YOLO }),
      settledFrames({ scenario: CHAIN, extraArgs: [...WRITE, ...YOLO] }),
    ]);
    for (const frames of [yolo, lastYolo]) {
      expect(frames).toEqual(baseline);
      expect(frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
      expect(frames.filter((frame) => frame.command === "abort")).toEqual([
        { type: "response", command: "abort", success: false, error: "unsupported" },
      ]);
    }
  });
});
