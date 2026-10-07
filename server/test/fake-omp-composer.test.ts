/**
 * Issue #998 fake-omp S1g (parent s1g-composer-capabilities 6.2 + 6.3)：`approval-write` 场景与
 * `set_model` / `set_thinking_level` 应答。真实子进程，只看 stdout 帧；期望值抄自 omp-test-harness
 * 规格（select id `w1` 抄自 tool-approval 规格），不从夹具导入。
 * `approval-write` 只在最后一个 `--approval-mode` 恰为 always-ask 时门控，其余取值与无旗标同 normal。
 * 两种命令在每个场景都应答；回合在途时到达的命令记下，等该回合终态 `agent_end`（或回合被丢弃）之后再答。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  response,
  type Session,
  startFake,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const COMPOSER = new URL("./support/fake-omp-composer.mjs", import.meta.url);
const ALWAYS_ASK = ["--approval-mode", "always-ask"];
const WRITE = ["--approval-mode", "write"];
const QUIET_MS = 300;
const BASH_GATED = ["approval", "approval-parallel", "approval-then-abort"];
const ABORT = { type: "abort", id: "req_abort" };
const MISSING = "workbuddy-missing-model";
const BAD_LEVEL = "workbuddy-bad-level";
const TODAY = { model: { provider: "workbuddy", id: "deepseek-v4.1-flash" }, thinkingLevel: "off" };
const APPLIED = { model: { provider: "workbuddy", id: "m3" }, thinkingLevel: "low" };
/** 首次命令之前的完整 get_state 应答（键序即字节序）：夹具自第一版起的值，本 issue 不得改动。 */
const STATE_TODAY = {
  id: "state-1",
  type: "response",
  command: "get_state",
  success: true,
  data: {
    ...TODAY,
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: "sess-fake",
    autoCompactionEnabled: true,
    fastModeEnabled: false,
    fastModeActive: false,
    tokensPerSecond: null,
    messageCount: 0,
    queuedMessageCount: 0,
    todoPhases: [],
    sessionFile: "/tmp/open-wb-fake-session.jsonl",
  },
};

let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fake-omp-composer-"));
});

afterEach(async () => {
  await stopFakeChildren();
  rmSync(tmp, { recursive: true, force: true });
});

const isTerminal = (frame: Frame): boolean => frame.type === "agent_end";
const isSelect = (frame: Frame): boolean => frame.type === "extension_ui_request";

function delta(text: string): Frame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
    message: { role: "assistant", content: [] },
  };
}

const SELECT_W1 = {
  type: "extension_ui_request",
  id: "w1",
  method: "select",
  title: "Allow tool: write\nPath: workbuddy-report.html",
  options: ["Approve", "Deny"],
};
const STOP = [
  { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
  { type: "agent_end", messages: [], isTerminal: true },
];

/** 一次工具调用的结束帧及紧随其后的 toolResult message_end（isError 恒为布尔）。 */
function ended(toolCallId: string, toolName: string, approved: boolean): Frame[] {
  const text = approved ? "workbuddy-smoke" : `Tool call denied by user: ${toolName}`;
  const content = [{ type: "text", text }];
  return [
    {
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content, details: approved ? { exitCode: 0 } : {} },
      ...(approved ? {} : { isError: true }),
    },
    {
      type: "message_end",
      message: { role: "toolResult", toolCallId, toolName, content, isError: !approved },
    },
  ];
}

/** 从 `from` 起恰好出现 `expected`，其后观察窗内无帧且进程存活（超时而非退出）。 */
async function expectNext(session: Session, from: number, expected: Frame[]): Promise<void> {
  const until = from + expected.length;
  await session.wait(() => session.frames.length >= until);
  await expect(session.wait(() => session.frames.length > until, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
  expect(session.frames.slice(from)).toEqual(expected);
}

/** 写入若干帧后，新增帧恰为 `expected`（空数组即观察窗无帧）。 */
async function step(session: Session, frames: Frame | Frame[], expected: Frame[]): Promise<void> {
  const from = session.frames.length;
  session.write(frames);
  await expectNext(session, from, expected);
}

function reply(id: string, body: Frame): Frame {
  return { type: "extension_ui_response", id, ...body };
}

function setModel(id: string, modelId: string): Frame {
  return { id, type: "set_model", provider: "workbuddy", modelId };
}

function setLevel(id: string, level: string): Frame {
  return { id, type: "set_thinking_level", level };
}

function modelOk(id: string, modelId: string): Frame {
  const data = { provider: "workbuddy", id: modelId };
  return { id, type: "response", command: "set_model", success: true, data };
}

function levelOk(id: string): Frame {
  return { id, type: "response", command: "set_thinking_level", success: true };
}

/** 写入 get_state 并取回其 data 的 model 与 thinkingLevel。 */
async function applied(session: Session, id: string): Promise<Frame> {
  session.write({ id, type: "get_state" });
  const { model, thinkingLevel } = asRecord((await session.wait(response(id, "get_state"))).data);
  return { model, thinkingLevel };
}

/** always-ask 下的门控前缀：toolUse message_end → 唯一的 select → write 的 start，随后观察窗无帧。 */
async function startWriteGated(): Promise<{ session: Session; writeArgs: Frame }> {
  const session = await startPromptedSession({ scenario: "approval-write", extraArgs: ALWAYS_ASK });
  const ack = session.frames.findIndex(response("req_1", "prompt"));
  await session.wait((frame) => frame.type === "tool_execution_start");
  const turn = session.frames.slice(ack + 1);
  const use = asRecord(turn.find((frame) => frame.type === "message_end")?.message);
  const [block] = use.content as Frame[];
  const writeArgs = asRecord(block?.arguments);
  expect(writeArgs.path).toBe("workbuddy-report.html");
  expect(typeof writeArgs.content).toBe("string");
  await expectNext(session, ack + 1, [
    { type: "agent_start" },
    delta("Hello "),
    delta("from "),
    delta("fake-omp"),
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: block?.id, name: "write", arguments: writeArgs }],
        stopReason: "toolUse",
      },
    },
    SELECT_W1,
    { type: "tool_execution_start", toolCallId: block?.id, toolName: "write", args: writeArgs },
  ]);
  return { session, writeArgs };
}

describe("fake omp approval-write scenario (#998)", () => {
  it("asks once for write under always-ask, starts the tool without waiting, and completes after Approve", async () => {
    const { session } = await startWriteGated();
    const callId = String(
      session.frames.find((f) => f.type === "tool_execution_start")?.toolCallId,
    );
    // 不匹配的 id 静默忽略：回合仍挂起。
    await step(session, reply("r1", { value: "Approve" }), []);
    await step(session, reply("w1", { value: "Approve" }), [
      ...ended(callId, "write", true),
      ...STOP,
    ]);
    expect(session.frames.filter(isSelect)).toEqual([SELECT_W1]);
    // 已答 id 的重复应答无帧；其后的 prompt 是普通回合。
    await step(session, reply("w1", { value: "Deny" }), []);
    await closeSession(session);
  });

  it.each([
    ["Deny", { value: "Deny" }],
    ["cancelled", { cancelled: true }],
    ["any other value", { value: "Maybe" }],
    ["cancelled alongside Approve", { value: "Approve", cancelled: true }],
  ])("ends the write call with isError:true on %s, then completes", async (_name, body) => {
    const { session } = await startWriteGated();
    const callId = String(
      session.frames.find((f) => f.type === "tool_execution_start")?.toolCallId,
    );
    await step(session, reply("w1", body), [...ended(callId, "write", false), ...STOP]);
    expect(session.frames.filter(isSelect)).toHaveLength(1);
    await closeSession(session);
  });

  it("does not write the reported file", async () => {
    const session = await startPromptedSession({
      scenario: "approval-write",
      extraArgs: ALWAYS_ASK,
      cwd: tmp,
    });
    await session.wait((frame) => frame.type === "tool_execution_start");
    session.write(reply("w1", { value: "Approve" }));
    await session.wait(isTerminal);
    await closeSession(session);
    expect(() => rmSync(join(tmp, "workbuddy-report.html"))).toThrow(/ENOENT/);
  });

  it("behaves as normal and emits no select under write, yolo and without the flag", async () => {
    const baseline = await startPromptedSession({ scenario: "normal" });
    await baseline.wait(isTerminal);
    await closeSession(baseline);
    expect(baseline.frames.filter(isSelect)).toEqual([]);
    const runs = [
      { extraArgs: WRITE },
      { extraArgs: ["--approval-mode", "yolo"] },
      { omitApprovalMode: true },
      // 取最后一个 --approval-mode：always-ask 被其后的 write 盖掉。
      { extraArgs: [...ALWAYS_ASK, ...WRITE] },
    ];
    for (const options of runs) {
      const session = await startPromptedSession({ scenario: "approval-write", ...options });
      await session.wait(isTerminal);
      await closeSession(session);
      expect(session.frames, JSON.stringify(options)).toEqual(baseline.frames);
    }
  });

  it("keeps the four bash approval scenarios keyed to write: always-ask runs them as normal", async () => {
    const baseline = await startPromptedSession({ scenario: "normal" });
    await baseline.wait(isTerminal);
    await closeSession(baseline);
    for (const scenario of [...BASH_GATED, "approval-chain-abort-ignored"]) {
      const session = await startPromptedSession({ scenario, extraArgs: ALWAYS_ASK });
      await session.wait(isTerminal);
      await closeSession(session);
      expect(session.frames, scenario).toEqual(baseline.frames);
    }
  });
});

function probeDelta(session: Session, id: string): string {
  const ack = session.frames.findIndex(response(id, "prompt"));
  const text = asRecord(session.frames.slice(ack + 1).find(isTextDelta)?.assistantMessageEvent);
  return String(text.delta);
}

describe("fake omp set_model / set_thinking_level answers (#998)", () => {
  it("answers both commands, reflects the last successful ones in get_state, and records the frames", async () => {
    const session = startFake();
    await session.wait((frame) => frame.type === "ready");
    const sent = [
      ...HANDSHAKE,
      setModel("model-1", "m3"),
      setLevel("level-1", "low"),
      { id: "state-2", type: "get_state" },
      setModel("model-2", MISSING),
      setLevel("level-2", BAD_LEVEL),
      { id: "state-3", type: "get_state" },
      { id: "probe-1", type: "prompt", message: `probe:${String(process.pid)}:${tmp}/probe.txt` },
    ];
    session.write(sent);
    await session.wait(isTerminal);
    await closeSession(session);

    const answers = session.frames.filter((frame) => frame.type === "response");
    expect(answers.map((frame) => frame.id)).toEqual(sent.map((frame) => frame.id));
    const [, state1, model1, level1, state2, model2, level2, state3] = answers;
    expect(state1).toEqual(STATE_TODAY);
    expect(session.stdout).toContain(`${JSON.stringify(STATE_TODAY)}\n`);
    expect(model1).toEqual(modelOk("model-1", "m3"));
    expect(level1).toEqual(levelOk("level-1"));
    expect(state2).toEqual({
      ...STATE_TODAY,
      id: "state-2",
      data: { ...STATE_TODAY.data, ...APPLIED },
    });
    expect(model2).toEqual({
      id: "model-2",
      type: "response",
      command: "set_model",
      success: false,
      error: "Model not found: workbuddy/workbuddy-missing-model",
    });
    expect(level2).toMatchObject({
      id: "level-2",
      type: "response",
      command: "set_thinking_level",
      success: false,
    });
    expect(level2).not.toHaveProperty("data");
    expect(typeof level2?.error).toBe("string");
    expect(asRecord(state3).data).toEqual(asRecord(state2).data);
    const frames = / frames=([^ ]*) cwd=/u.exec(probeDelta(session, "probe-1"))?.[1];
    expect(frames).toBe(
      "negotiate_protocol,get_state,set_model,set_thinking_level,get_state,set_model,set_thinking_level,get_state,prompt",
    );
  });

  it("keeps the last successful values across later successes and failures", async () => {
    const session = startFake();
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await session.wait(response("state-1", "get_state"));
    await step(session, setModel("a", "m3"), [modelOk("a", "m3")]);
    await step(session, { id: "b", type: "set_model", provider: "other", modelId: "m9" }, [
      {
        id: "b",
        type: "response",
        command: "set_model",
        success: true,
        data: { provider: "other", id: "m9" },
      },
    ]);
    await step(session, { id: "c", type: "set_model", provider: "other", modelId: MISSING }, [
      {
        id: "c",
        type: "response",
        command: "set_model",
        success: false,
        error: "Model not found: other/workbuddy-missing-model",
      },
    ]);
    await step(session, setLevel("d", "high"), [levelOk("d")]);
    session.write(setLevel("e", BAD_LEVEL));
    await session.wait(response("e", "set_thinking_level"));
    expect(await applied(session, "s")).toEqual({
      model: { provider: "other", id: "m9" },
      thinkingLevel: "high",
    });
    await closeSession(session);
  });

  it.each(["normal", "thinking", "todo", "branch", "approval-write"])(
    "answers both commands between turns under %s",
    async (scenario) => {
      const session = await startPromptedSession({ scenario, cwd: tmp });
      await session.wait(isTerminal);
      expect(await applied(session, "s0")).toEqual(TODAY);
      await step(
        session,
        [setModel("m", "m3"), setLevel("l", "low")],
        [modelOk("m", "m3"), levelOk("l")],
      );
      expect(await applied(session, "s1")).toEqual(APPLIED);
      await closeSession(session);
    },
  );
});

describe("fake omp commands arriving mid-turn (#998)", () => {
  it("answers after the terminal agent_end of a turn held on a pending select", async () => {
    const session = await startPromptedSession({ scenario: "approval", extraArgs: WRITE });
    await session.wait((frame) => frame.type === "tool_execution_start");
    await step(session, [setModel("m", "m3"), setLevel("l", BAD_LEVEL), setLevel("l2", "low")], []);
    // 在途期间 get_state 照常应答，且尚未生效。
    expect(await applied(session, "s0")).toEqual(TODAY);
    const from = session.frames.length;
    session.write(reply("r1", { value: "Approve" }));
    await session.wait(response("l2", "set_thinking_level"));
    const tail = session.frames.slice(from);
    expect(tail.slice(0, 4)).toEqual([...ended("tool-1", "bash", true), ...STOP]);
    expect(tail.slice(4, 5)).toEqual([modelOk("m", "m3")]);
    expect(tail[5]).toMatchObject({ id: "l", command: "set_thinking_level", success: false });
    expect(tail.slice(6)).toEqual([levelOk("l2")]);
    expect(await applied(session, "s1")).toEqual(APPLIED);
    // 回合结束后恢复即时应答。
    await step(session, setModel("m2", "m4"), [modelOk("m2", "m4")]);
    await closeSession(session);
  });

  it("answers after the terminal agent_end of a held abort-ok turn", async () => {
    const session = await startPromptedSession({ scenario: "abort-ok" });
    await session.wait(() => session.frames.filter(isTextDelta).length === 2);
    await step(session, setModel("m", "m3"), []);
    await step(session, ABORT, [
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
      { type: "agent_end", messages: [], isTerminal: true },
      { id: "req_abort", type: "response", command: "abort", success: true },
      modelOk("m", "m3"),
    ]);
    expect(await applied(session, "s1")).toEqual({ ...TODAY, model: APPLIED.model });
    await closeSession(session);
  });

  it("answers a command recorded before a turn that an early abort drops", async () => {
    const session = await startPromptedSession({
      scenario: "abort-ok",
      extraArgs: ["--start-delay-ms", "2000"],
    });
    await step(session, setLevel("l", "low"), []);
    await step(session, ABORT, [
      { id: "req_abort", type: "response", command: "abort", success: true },
      levelOk("l"),
    ]);
    expect(await applied(session, "s1")).toEqual({ ...TODAY, thinkingLevel: "low" });
    await closeSession(session);
  });

  it("never answers while a hung turn stays in flight", async () => {
    const session = await startPromptedSession({ scenario: "hang-prompt" });
    await step(session, [setModel("m", "m3"), setLevel("l", "low")], []);
    expect(await applied(session, "s0")).toEqual(TODAY);
  });
});

describe("fake-omp-composer.mjs pure builders (#998)", () => {
  it("builds command answers and the two documented failing values without holding state", async () => {
    const composer = (await import(fileURLToPath(COMPOSER))) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    expect(composer.isMissingModel?.(MISSING)).toBe(true);
    expect(composer.isMissingModel?.("m3")).toBe(false);
    expect(composer.isBadLevel?.(BAD_LEVEL)).toBe(true);
    expect(composer.isBadLevel?.("low")).toBe(false);
    expect(composer.commandAnswer?.(setModel("x", "m3"))).toEqual({
      response: modelOk("x", "m3"),
      patch: { model: { provider: "workbuddy", id: "m3" } },
    });
    expect(composer.commandAnswer?.(setLevel("y", "low"))).toEqual({
      response: levelOk("y"),
      patch: { thinkingLevel: "low" },
    });
    expect(composer.commandAnswer?.(setModel("x", MISSING))).toMatchObject({ patch: {} });
    expect(composer.commandAnswer?.(setLevel("y", BAD_LEVEL))).toMatchObject({ patch: {} });
    expect(composer.selectTitle?.({ name: "bash", args: { command: "ls" } })).toBe(
      "Allow tool: bash\nCommand: ls",
    );
    expect(composer.selectTitle?.({ name: "write", args: { path: "a.html", content: "" } })).toBe(
      "Allow tool: write\nPath: a.html",
    );
  });
});
