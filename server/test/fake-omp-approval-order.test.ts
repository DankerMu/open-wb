/**
 * Issue #1571 (omp-pin-18-12 7.2, design D9): the fake-omp approval scenarios in omp v18.12.3's
 * order — every gated call's `tool_execution_start` before its select, the three-item options of a
 * mode-raised prompt, the middle value answered like `Approve` for that one call. Real children;
 * the expected frames are the literals of omp-test-harness「审批 select 门控 bash」「并行审批各自应答」
 * 「select 挂起时 abort 被延后」「审批链上 abort 被忽略」「approval-write 只在 always-ask 下请求确认」and
 * tool-approval「写文件工具的确认同样识别为审批」, written out here, never imported from the fixture.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  response,
  type Session,
  type StartOptions,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const WRITE = ["--approval-mode", "write"];
const ALWAYS_ASK = ["--approval-mode", "always-ask"];
const QUIET_MS = 300;
const ABORT = { type: "abort", id: "req_abort" };
const BASH_OPTIONS = ["Approve", "Approve bash for this session", "Deny"];
const WRITE_OPTIONS = ["Approve", "Approve write for this session", "Deny"];
const WRITE_TITLE = "Allow tool: write\nPath: workbuddy-report.html";
const AGENT_END = { type: "agent_end", messages: [], isTerminal: true };
/** The aborted close of an approval turn (omp-test-harness `approval-then-abort`). */
const ABORTED_CLOSE = [
  { type: "turn_end" },
  { type: "turn_start" },
  {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "aborted",
      errorMessage: "Interrupted by user",
    },
  },
  { type: "turn_end" },
  AGENT_END,
  { id: "req_abort", type: "response", command: "abort", success: true },
];

afterEach(async () => {
  await stopFakeChildren();
});

function reply(id: string, body: Frame): Frame {
  return { type: "extension_ui_response", id, ...body };
}

/** The observation window passes with no new frame while the child stays alive. */
async function quiet(session: Session): Promise<void> {
  const seen = session.frames.length;
  await expect(session.wait(() => session.frames.length > seen, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
}

/** Writes `frame`, waits for exactly `count` new frames and a quiet window, returns them. */
async function send(session: Session, frame: Frame | Frame[], count: number): Promise<Frame[]> {
  const from = session.frames.length;
  session.write(frame);
  await session.wait(() => session.frames.length >= from + count);
  await quiet(session);
  return session.frames.slice(from);
}

/** Prompts `scenario`; returns the frames after the `toolUse` message_end once `count` arrived. */
async function gated(scenario: string, options: StartOptions, count: number) {
  const session = await startPromptedSession({ scenario, ...options });
  const ack = session.frames.findIndex(response("req_1", "prompt"));
  const isToolUse = (frame: Frame) =>
    frame.type === "message_end" && asRecord(frame.message).stopReason === "toolUse";
  await session.wait(isToolUse);
  const use = session.frames.findIndex((frame, index) => index > ack && isToolUse(frame));
  await session.wait(() => session.frames.length >= use + 1 + count);
  await quiet(session);
  return { session, tail: session.frames.slice(use + 1) };
}

/** A `tool_execution_start` for `toolName`; returns its toolCallId. */
function expectStart(frame: Frame | undefined, toolName: string): string {
  expect(frame).toMatchObject({ type: "tool_execution_start", toolName });
  return String(frame?.toolCallId);
}

function expectSelect(frame: Frame | undefined, id: string, title: RegExp, options: string[]) {
  expect(frame).toMatchObject({ type: "extension_ui_request", id, method: "select" });
  expect(String(frame?.title)).toMatch(title);
  expect(frame?.options).toEqual(options);
}

/** The call's `tool_execution_end` and its toolResult `message_end`, `isError` per `approved`. */
function expectEnded(frames: Frame[], toolCallId: string, approved: boolean): void {
  const [end, result] = frames;
  expect(end).toMatchObject({ type: "tool_execution_end", toolCallId });
  expect(end?.isError).toBe(approved ? undefined : true);
  expect(result).toMatchObject({
    type: "message_end",
    message: { role: "toolResult", toolCallId, isError: !approved },
  });
  expect(asRecord(result?.message).content).toEqual(asRecord(end?.result).content);
}

/** Normal completion: an assistant `message_end` with `stopReason` `stop`, then `agent_end`. */
function expectCompleted(frames: Frame[]): void {
  expect(frames).toHaveLength(2);
  expect(frames[0]).toMatchObject({ type: "message_end", message: { stopReason: "stop" } });
  expect(frames[1]).toEqual(AGENT_END);
}

const BASH = /^Allow tool: bash(\n|$)/;
const APPROVALS = [{ value: "Approve" }, { value: "Approve bash for this session" }];
const DENIALS = [{ value: "Deny" }, { cancelled: true }];

describe("审批 select 门控 bash (approval, --approval-mode write)", () => {
  async function approvalTurn() {
    const { session, tail } = await gated("approval", { extraArgs: WRITE }, 2);
    expect(tail).toHaveLength(2);
    const call = expectStart(tail[0], "bash");
    expectSelect(tail[1], "r1", BASH, BASH_OPTIONS);
    return { session, call };
  }

  it.each(APPROVALS)("start, then the three-item select; %j completes normally", async (body) => {
    const { session, call } = await approvalTurn();
    const after = await send(session, reply("r1", body), 4);
    expectEnded(after, call, true);
    expectCompleted(after.slice(2));
    await closeSession(session);
  });

  it.each(DENIALS)("%j ends the call with isError and still completes", async (body) => {
    const { session, call } = await approvalTurn();
    const after = await send(session, reply("r1", body), 4);
    expectEnded(after, call, false);
    expect(after.at(-1)).toEqual(AGENT_END);
    await closeSession(session);
  });
});

describe("并行审批各自应答 (approval-parallel, --approval-mode write)", () => {
  it.each(APPROVALS)("two starts, then two selects; Deny r2, then %j on r1", async (body) => {
    const { session, tail } = await gated("approval-parallel", { extraArgs: WRITE }, 4);
    expect(tail).toHaveLength(4);
    const first = expectStart(tail[0], "bash");
    const second = expectStart(tail[1], "bash");
    expect(second).not.toBe(first);
    expectSelect(tail[2], "r1", BASH, BASH_OPTIONS);
    expectSelect(tail[3], "r2", BASH, BASH_OPTIONS);

    const denied = await send(session, reply("r2", { value: "Deny" }), 2);
    expectEnded(denied, second, false);
    const approved = await send(session, reply("r1", body), 4);
    expectEnded(approved, first, true);
    expectCompleted(approved.slice(2));
    await closeSession(session);
  });
});

describe("select 挂起时 abort 被延后 (approval-then-abort, --approval-mode write)", () => {
  async function pendingSelect() {
    const { session, tail } = await gated("approval-then-abort", { extraArgs: WRITE }, 2);
    const call = expectStart(tail[0], "bash");
    expectSelect(tail[1], "r1", BASH, BASH_OPTIONS);
    return { session, call };
  }

  it("an abort while r1 is pending is honoured right after the Deny's end and toolResult", async () => {
    const { session, call } = await pendingSelect();
    expect(await send(session, ABORT, 0)).toEqual([]);
    const after = await send(session, reply("r1", { value: "Deny" }), 8);
    expectEnded(after, call, false);
    expect(after.slice(2)).toEqual(ABORTED_CLOSE);
    await closeSession(session);
  });

  it("after a Deny the turn holds until the later abort", async () => {
    const { session, call } = await pendingSelect();
    expectEnded(await send(session, reply("r1", { value: "Deny" }), 2), call, false);
    expect(await send(session, ABORT, 6)).toEqual(ABORTED_CLOSE);
    await closeSession(session);
  });
});

describe("审批链上 abort 被忽略 (approval-chain-abort-ignored, --approval-mode write)", () => {
  it.each([
    ["after", [reply("r1", { value: "Deny" }), ABORT]],
    ["before", [ABORT, reply("r1", { value: "Deny" })]],
  ] as [string, Frame[]][])(
    "r1 Deny with the abort %s it: end, toolResult, start, select",
    async (_, frames) => {
      const { session, tail } = await gated(
        "approval-chain-abort-ignored",
        { extraArgs: WRITE },
        2,
      );
      const c1 = expectStart(tail[0], "bash");
      expectSelect(tail[1], "r1", BASH, BASH_OPTIONS);

      const after = await send(session, frames, 4);
      expectEnded(after, c1, false);
      const c2 = expectStart(after[2], "bash");
      expect(c2).not.toBe(c1);
      expectSelect(after[3], "r2", BASH, BASH_OPTIONS);
      expect(session.frames.some((frame) => frame.type === "agent_end")).toBe(false);
      session.closeStdin();
      expect(await session.waitExit()).toBe(0);
    },
  );
});

describe("approval-write 只在 always-ask 下请求确认", () => {
  async function writeTurn() {
    const { session, tail } = await gated("approval-write", { extraArgs: ALWAYS_ASK }, 2);
    expect(tail).toHaveLength(2);
    const call = expectStart(tail[0], "write");
    expect(tail[1]).toEqual({
      type: "extension_ui_request",
      id: "w1",
      method: "select",
      title: WRITE_TITLE,
      options: WRITE_OPTIONS,
    });
    return { session, call };
  }

  it.each([
    [{ value: "Approve" }, true],
    [{ value: "Approve write for this session" }, true],
    [{ value: "Deny" }, false],
    [{ cancelled: true }, false],
  ] as [Frame, boolean][])("start(write), then exactly one select; %j", async (body, approved) => {
    const { session, call } = await writeTurn();
    const after = await send(session, reply("w1", body), 4);
    expectEnded(after, call, approved);
    expect(after.at(-1)).toEqual(AGENT_END);
    expect(session.frames.filter((frame) => frame.type === "extension_ui_request")).toHaveLength(1);
    await closeSession(session);
  });

  it.each([
    ["write", { extraArgs: WRITE }],
    ["yolo", { extraArgs: ["--approval-mode", "yolo"] }],
    ["no flag", { omitApprovalMode: true }],
  ] as [string, StartOptions][])("under %s emits no extension_ui_request", async (_, options) => {
    const session = await startPromptedSession({ scenario: "approval-write", ...options });
    await session.wait((frame) => frame.type === "agent_end");
    await closeSession(session);
    expect(session.frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
  });
});
