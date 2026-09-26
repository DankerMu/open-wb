/**
 * Issue #458 fake-omp approval scenarios (parent s1c-turn-control-governance 6.3).
 * 只有最后一个 `--approval-mode` 恰为 `write` 时，`approval`/`approval-parallel`/`approval-then-abort`
 * 才门控：先 tool_execution_start，再发 select{r1,r2}，每条应答只结束自己的调用；select 挂起时的
 * abort 延后到最后一条 tool_execution_end 之后兑现。帧形状钉在 omp v18.0.10（见 change tasks.md）。
 * 真实子进程；帧读取复用 fake-omp-helpers.ts。
 */
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

const WRITE = ["--approval-mode", "write"];
const QUIET_MS = 300;
const ABORT = { type: "abort", id: "req_abort" };

afterEach(async () => {
  await stopFakeChildren();
});

const C1_ARGS = { command: "echo workbuddy-smoke" };
const C2_ARGS = { command: "echo workbuddy-smoke-2" };

const START_C1 = {
  type: "tool_execution_start",
  toolCallId: "tool-1",
  toolName: "bash",
  args: C1_ARGS,
};
const START_C2 = {
  type: "tool_execution_start",
  toolCallId: "tool-2",
  toolName: "bash",
  args: C2_ARGS,
};
const SELECT_R1 = {
  type: "extension_ui_request",
  id: "r1",
  method: "select",
  title: "Allow tool: bash\nCommand: echo workbuddy-smoke",
  options: ["Approve", "Deny"],
};
const SELECT_R2 = {
  type: "extension_ui_request",
  id: "r2",
  method: "select",
  title: "Allow tool: bash\nCommand: echo workbuddy-smoke-2",
  options: ["Approve", "Deny"],
};

function okEnd(toolCallId: string): Frame {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "bash",
    result: { content: [{ type: "text", text: "workbuddy-smoke" }], details: { exitCode: 0 } },
  };
}

function deniedEnd(toolCallId: string): Frame {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName: "bash",
    result: { content: [{ type: "text", text: "Tool call denied by user: bash" }], details: {} },
    isError: true,
  };
}

const STOP = [
  { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
  { type: "agent_end", messages: [], isTerminal: true },
];
const ABORTED = [
  { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
  { type: "agent_end", messages: [], isTerminal: true },
  { id: "req_abort", type: "response", command: "abort", success: true },
];

function delta(text: string): Frame {
  return {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: text },
    message: { role: "assistant", content: [] },
  };
}

/** SELECTED(k)：agent_start、3 段 delta、toolUse message_end、k 个 start、k 个 select。 */
function selected(parallel: boolean): Frame[] {
  const blocks = [{ type: "toolCall", id: "tool-1", name: "bash", arguments: C1_ARGS }];
  if (parallel) {
    blocks.push({ type: "toolCall", id: "tool-2", name: "bash", arguments: C2_ARGS });
  }
  return [
    { type: "agent_start" },
    delta("Hello "),
    delta("from "),
    delta("fake-omp"),
    { type: "message_end", message: { role: "assistant", content: blocks, stopReason: "toolUse" } },
    ...(parallel ? [START_C1, START_C2, SELECT_R1, SELECT_R2] : [START_C1, SELECT_R1]),
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

/** 写入一帧后，新增帧恰为 `expected`（空数组即观察窗无帧）。 */
async function step(session: Session, frame: Frame, expected: Frame[]): Promise<void> {
  const from = session.frames.length;
  session.write(frame);
  await expectNext(session, from, expected);
}

function reply(id: string, body: Frame): Frame {
  return { type: "extension_ui_response", id, ...body };
}

/** 等 req_1 ack 后恰为门控前缀，随后观察窗无帧。 */
async function startGated(scenario: string): Promise<Session> {
  const session = await startPromptedSession({ scenario, extraArgs: WRITE });
  const ack = session.frames.findIndex(response("req_1", "prompt"));
  expect(ack).toBeGreaterThanOrEqual(0);
  await expectNext(session, ack + 1, selected(scenario === "approval-parallel"));
  return session;
}

function isTerminalAfter(session: Session, index: number): (frame: Frame) => boolean {
  return (frame) =>
    frame.type === "agent_end" &&
    frame.isTerminal !== false &&
    session.frames.indexOf(frame) > index;
}

/** done 态走缺省路径：req_2 得到 ack 与完整回合，且不再发 select。 */
async function expectDefaultTurn(session: Session): Promise<void> {
  session.write({ id: "req_2", type: "prompt", message: "again" });
  await session.wait(response("req_2", "prompt"));
  const ack = session.frames.findIndex(response("req_2", "prompt"));
  await session.wait(isTerminalAfter(session, ack));
  const turn = session.frames.slice(ack + 1);
  expect(turn.filter(isTextDelta).length).toBeGreaterThanOrEqual(3);
  const starts = turn.filter((frame) => frame.type === "tool_execution_start");
  const ends = turn.filter((frame) => frame.type === "tool_execution_end");
  expect(starts.length).toBeGreaterThan(0);
  expect(ends.map((frame) => frame.toolCallId)).toEqual(starts.map((frame) => frame.toolCallId));
  expect(turn.some((frame) => frame.type === "extension_ui_request")).toBe(false);
  expect(turn).toContainEqual(STOP[0]);
  expect(turn.at(-1)).toEqual(STOP[1]);
  await closeSession(session);
}

describe("fake-omp approval (--approval-mode write)", () => {
  it("gates bash behind an r1 select and completes normally after Approve", async () => {
    const session = await startGated("approval");
    const from = session.frames.length;
    await step(session, reply("r1", { value: "Approve" }), [okEnd("tool-1"), ...STOP]);
    expect("isError" in asRecord(session.frames[from])).toBe(false);
    await closeSession(session);
  });

  it.each([
    { name: "Deny", body: { value: "Deny" } },
    { name: "cancelled", body: { cancelled: true } },
    { name: "other value", body: { value: "approve" } },
    { name: "cancelled with Approve", body: { cancelled: true, value: "Approve" } },
  ])("ends r1 with the denied frame then completes for $name", async ({ body }) => {
    const session = await startGated("approval");
    await step(session, reply("r1", body), [deniedEnd("tool-1"), ...STOP]);
    await closeSession(session);
  });

  it("keeps the queue serving, ignores unknown and repeated ids, then runs a default turn", async () => {
    const session = await startGated("approval");
    const from = session.frames.length;
    session.write({ id: "state-2", type: "get_state" });
    await session.wait(response("state-2", "get_state"));
    expect(session.frames.slice(from)).toMatchObject([
      { id: "state-2", type: "response", command: "get_state", success: true },
    ]);
    await step(session, reply("no-such", { value: "Approve" }), []);
    await step(session, reply("r1", { value: "Approve" }), [okEnd("tool-1"), ...STOP]);
    await step(session, reply("r1", { value: "Deny" }), []);
    await expectDefaultTurn(session);
  });
});

describe("fake-omp approval scenarios without write mode", () => {
  /** 等终止 agent_end，再写 abort 并等其应答；返回全部帧。 */
  async function runToAbortReply(scenario?: string, extraArgs?: string[]): Promise<Frame[]> {
    const session = await startPromptedSession({
      ...(scenario === undefined ? {} : { scenario }),
      ...(extraArgs === undefined ? {} : { extraArgs }),
    });
    await session.wait(isTerminalAfter(session, 0));
    session.write(ABORT);
    await session.wait((frame) => frame.type === "response" && frame.command === "abort");
    await closeSession(session);
    return session.frames;
  }

  it.each(["approval", "approval-parallel", "approval-then-abort"])(
    "%s under yolo (default or last flag) matches normal byte for byte",
    async (scenario) => {
      const [baseline, byDefault, lastYolo] = await Promise.all([
        runToAbortReply(),
        runToAbortReply(scenario),
        runToAbortReply(scenario, [...WRITE, "--approval-mode", "yolo"]),
      ]);
      expect(byDefault).toEqual(baseline);
      expect(lastYolo).toEqual(baseline);
      for (const frames of [byDefault, lastYolo]) {
        expect(frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
        expect(frames.at(-1)).toEqual({
          type: "response",
          command: "abort",
          success: false,
          error: "unsupported",
        });
      }
    },
  );
});

describe("fake-omp approval-parallel", () => {
  it("answers each select independently: Deny r2 then Approve r1 completes", async () => {
    const session = await startGated("approval-parallel");
    await step(session, reply("r2", { value: "Deny" }), [deniedEnd("tool-2")]);
    await step(session, reply("r1", { value: "Approve" }), [okEnd("tool-1"), ...STOP]);
    await closeSession(session);
  });

  it.each([
    {
      name: "abort then Deny r1, Deny r2",
      steps: [
        [ABORT, []],
        [reply("r1", { value: "Deny" }), [deniedEnd("tool-1")]],
        [reply("r2", { value: "Deny" }), [deniedEnd("tool-2"), ...ABORTED]],
      ],
    },
    {
      name: "abort then Approve r1, Approve r2",
      steps: [
        [ABORT, []],
        [reply("r1", { value: "Approve" }), [okEnd("tool-1")]],
        [reply("r2", { value: "Approve" }), [okEnd("tool-2"), ...ABORTED]],
      ],
    },
    {
      name: "Deny r2, repeated r2, abort, then Approve r1",
      steps: [
        [reply("r2", { value: "Deny" }), [deniedEnd("tool-2")]],
        [reply("r2", { value: "Approve" }), []],
        [ABORT, []],
        [reply("r1", { value: "Approve" }), [okEnd("tool-1"), ...ABORTED]],
      ],
    },
  ] as { name: string; steps: [Frame, Frame[]][] }[])(
    "defers a pending-select abort until the last answer: $name",
    async ({ steps }) => {
      const session = await startGated("approval-parallel");
      for (const [frame, expected] of steps) {
        await step(session, frame, expected);
      }
      await expectDefaultTurn(session);
    },
  );

  it("holds the turn after two denials until abort, ignoring a spare answer", async () => {
    const session = await startGated("approval-parallel");
    await step(session, reply("r1", { value: "Deny" }), [deniedEnd("tool-1")]);
    await step(session, reply("r2", { value: "Deny" }), [deniedEnd("tool-2")]);
    await step(session, reply("r1", { value: "Approve" }), []);
    await step(session, ABORT, ABORTED);
    await expectDefaultTurn(session);
  });
});

describe("fake-omp approval-then-abort", () => {
  it("defers an abort received while r1 is pending until the Deny end frame", async () => {
    const session = await startGated("approval-then-abort");
    await step(session, ABORT, []);
    await step(session, reply("r1", { value: "Deny" }), [deniedEnd("tool-1"), ...ABORTED]);
    await expectDefaultTurn(session);
  });

  it.each([
    { name: "Deny", body: { value: "Deny" }, end: deniedEnd("tool-1") },
    { name: "Approve", body: { value: "Approve" }, end: okEnd("tool-1") },
  ])("holds after the $name end frame until a later abort", async ({ body, end }) => {
    const session = await startGated("approval-then-abort");
    await step(session, reply("r1", body), [end]);
    await step(session, ABORT, ABORTED);
    await closeSession(session);
  });

  it("defers an abort pipelined with the prompt until after the select", async () => {
    const session = startFake({ scenario: "approval-then-abort", extraArgs: WRITE });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await Promise.all([
      session.wait(response("protocol-1", "negotiate_protocol")),
      session.wait(response("state-1", "get_state")),
    ]);
    session.write([PROMPT, ABORT]);
    await session.wait(response(String(PROMPT.id), "prompt"));
    const ack = session.frames.findIndex(response(String(PROMPT.id), "prompt"));
    await expectNext(session, ack + 1, selected(false));
    await step(session, reply("r1", { value: "Deny" }), [deniedEnd("tool-1"), ...ABORTED]);
    await closeSession(session);
  });
});

describe("existing scenarios under --approval-mode write", () => {
  type Script = (session: Session) => Promise<void>;
  const toTerminal: Script = async (session) => {
    await session.wait(isTerminalAfter(session, 0));
  };
  const cases: { scenario?: string; script: Script }[] = [
    { script: toTerminal },
    { scenario: "error", script: toTerminal },
    {
      scenario: "extension-ui",
      script: async (session) => {
        const request = await session.wait((frame) => frame.type === "extension_ui_request");
        session.write({ type: "extension_ui_response", id: request.id, cancelled: true });
        await session.wait(isTerminalAfter(session, 0));
      },
    },
    {
      scenario: "abort-ok",
      script: async (session) => {
        await session.wait(() => session.frames.filter(isTextDelta).length >= 2);
        session.write(ABORT);
        await session.wait(response("req_abort", "abort"));
      },
    },
  ];

  async function run(scenario: string | undefined, script: Script, extra: string[]) {
    const session = await startPromptedSession({
      ...(scenario === undefined ? {} : { scenario }),
      extraArgs: extra,
    });
    await script(session);
    await closeSession(session);
    return session.frames;
  }

  it.each(cases.map((entry) => ({ name: entry.scenario ?? "normal", ...entry })))(
    "$name emits identical frames with and without write",
    async ({ scenario, script }) => {
      const [plain, write] = await Promise.all([
        run(scenario, script, []),
        run(scenario, script, WRITE),
      ]);
      expect(write).toEqual(plain);
    },
  );
});
