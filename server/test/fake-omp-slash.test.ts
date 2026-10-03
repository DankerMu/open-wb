/**
 * Issue #552 fake-omp `slash` scenario (parent s1c-session-metadata-presentation 10.1).
 * 真实子进程，只看 stdout 帧与磁盘文件：`/todo` 先 command_output 后回执，`/compact` 先回执后
 * 经定时器输出（`--compact-silent` 只压制输出），`abort` 一律回执并取消未发出的输出，其余 prompt
 * 走 normal；`branch` 的可重复 `--branch-entry <text>` 在固定列表后追加条目。
 */
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  response,
  type Session,
  type StartOptions,
  startFake,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

/** omp v18.0.10 的本地命令文本（todo.ts:246-260、builtin-lifecycle.ts）；独立抄写，不从夹具导入。 */
const TODO_OUTPUT = {
  type: "command_output",
  text: "No todos. Use /todo append <task> to start one.",
};
const COMPACT_OUTPUT = { type: "command_output", text: "Compaction complete." };
const FIXED_ENTRIES = [
  { entryId: "fake-entry-1", text: "first question" },
  { entryId: "fake-entry-2", text: "second question" },
];
const ESCAPED = " /help 这是什么";

const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function prompt(id: string, message: string): Frame {
  return { id, type: "prompt", message };
}

function localAck(id: string): Frame {
  return {
    id,
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked: false },
  };
}

function abortAck(id: string): Frame {
  return { id, type: "response", command: "abort", success: true };
}

function isTerminal(frame: Frame): boolean {
  return frame.type === "agent_end" && frame.isTerminal === true;
}

/** ready + 协商 + get_state 之后返回，其后的帧全部由用例产生。 */
async function ready(options: StartOptions): Promise<Session> {
  const session = startFake(options);
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("state-1", "get_state"));
  return session;
}

/** 写入后等到恰好新增 `count` 帧（`ms` 内），返回这些新帧。 */
async function exchange(
  session: Session,
  input: Frame | Frame[],
  count: number,
  ms?: number,
): Promise<Frame[]> {
  const before = session.frames.length;
  session.write(input);
  await session.wait(() => session.frames.length >= before + count, ms);
  return session.frames.slice(before);
}

/** 写入一个 prompt，返回自写入起到终止 agent_end（含）的全部新帧。 */
async function turn(session: Session, input: Frame): Promise<Frame[]> {
  const before = session.frames.length;
  session.write(input);
  await session.wait((frame) => session.frames.indexOf(frame) >= before && isTerminal(frame));
  return session.frames.slice(before);
}

/** `ms` 内不再有任何新帧。 */
async function expectSilent(session: Session, ms: number): Promise<void> {
  const count = session.frames.length;
  await expect(session.wait(() => session.frames.length > count, ms)).rejects.toThrow(/timed out/);
  expect(session.frames).toHaveLength(count);
}

/** 另起一个 normal 进程跑同一 prompt，得到作为对照的帧序列。 */
async function normalTurn(input: Frame, extraArgs: string[] = []): Promise<Frame[]> {
  const session = await ready({ scenario: "normal", extraArgs });
  const frames = await turn(session, input);
  await closeSession(session);
  return frames;
}

/** 完整 normal 回合：回执 agentInvoked:true、三段 delta、bash 工具 start/end、stop、终止 agent_end。 */
function expectNormalTurn(frames: Frame[], id: string): void {
  expect(frames[0]).toEqual({
    id,
    type: "response",
    command: "prompt",
    success: true,
    data: { agentInvoked: true },
  });
  expect(frames[1]).toEqual({ type: "agent_start" });
  expect(frames.filter(isTextDelta)).toHaveLength(3);
  expect(frames.map((frame) => frame.type)).toEqual([
    "response",
    "agent_start",
    "message_update",
    "message_update",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "message_end",
    "agent_end",
  ]);
  expect(frames.find((frame) => frame.type === "tool_execution_start")?.toolName).toBe("bash");
  expect(frames.at(-1)).toEqual({ type: "agent_end", messages: [], isTerminal: true });
  expect(frames.some((frame) => frame.type === "command_output")).toBe(false);
}

async function branchList(session: Session, id: string): Promise<Frame> {
  session.write({ id, type: "get_branch_messages" });
  return session.wait(response(id, "get_branch_messages"));
}

async function listedEntries(extraArgs: string[]): Promise<unknown> {
  const session = await ready({ extraArgs });
  const list = await branchList(session, "gbm-1");
  expect(list.success).toBe(true);
  await closeSession(session);
  return asRecord(list.data).messages;
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "open-wb-slash-")));
  temps.push(dir);
  return dir;
}

describe("fake omp slash scenario: local command completion order", () => {
  it("answers /todo output-first, /compact receipt-first, and runs escaped text as normal", async () => {
    const session = await ready({ scenario: "slash" });

    const todo = await exchange(session, prompt("req_todo", "/todo"), 2);
    expect(todo).toEqual([TODO_OUTPUT, localAck("req_todo")]);
    await expectSilent(session, 200);

    const compact = await exchange(session, prompt("req_compact", "/compact"), 2, 1_000);
    expect(compact).toEqual([localAck("req_compact"), COMPACT_OUTPUT]);
    await expectSilent(session, 200);

    const escaped = prompt("req_escaped", " /session delete");
    const frames = await turn(session, escaped);
    expectNormalTurn(frames, "req_escaped");
    expect(frames).toEqual(await normalTurn(escaped));
    await expectSilent(session, 200);

    expect(await exchange(session, { id: "req_abort_n", type: "abort" }, 1)).toEqual([
      abortAck("req_abort_n"),
    ]);
    await expectSilent(session, 200);
    await closeSession(session);
  });

  it("matches /todo and /compact exactly: arguments or other text run the normal turn", async () => {
    const session = await ready({ scenario: "slash" });
    for (const message of ["/todo append x", "/compact now", "/todo ", "/help"]) {
      const input = prompt("req_other", message);
      const frames = await turn(session, input);
      expectNormalTurn(frames, "req_other");
      expect(frames).toEqual(await normalTurn(input));
    }
    await closeSession(session);
  });

  it("--compact-silent answers /compact with only the receipt and still answers abort", async () => {
    const session = await ready({ scenario: "slash", extraArgs: ["--compact-silent"] });
    expect(await exchange(session, prompt("req_compact", "/compact"), 1)).toEqual([
      localAck("req_compact"),
    ]);
    await expectSilent(session, 300);
    expect(await exchange(session, { id: "req_abort_y", type: "abort" }, 1)).toEqual([
      abortAck("req_abort_y"),
    ]);
    await expectSilent(session, 200);
    session.closeStdin();
    expect(await session.waitExit()).toBe(0);
  });

  it("--compact-silent leaves /todo output-first", async () => {
    const session = await ready({ scenario: "slash", extraArgs: ["--compact-silent"] });
    expect(await exchange(session, prompt("req_todo", "/todo"), 2)).toEqual([
      TODO_OUTPUT,
      localAck("req_todo"),
    ]);
    await expectSilent(session, 200);
    await closeSession(session);
  });
});

describe("fake omp slash scenario: abort", () => {
  it("an abort written together with /compact cancels the pending output", async () => {
    const session = await ready({ scenario: "slash" });
    const frames = await exchange(
      session,
      [prompt("req_compact_x", "/compact"), { id: "req_abort_x", type: "abort" }],
      2,
    );
    expect(frames).toEqual([localAck("req_compact_x"), abortAck("req_abort_x")]);
    await expectSilent(session, 300);
    await closeSession(session);
  });

  it("two pending /compact each emit their output once", async () => {
    const session = await ready({ scenario: "slash" });
    const frames = await exchange(
      session,
      [prompt("req_c1", "/compact"), prompt("req_c2", "/compact")],
      4,
      1_000,
    );
    expect(frames).toEqual([
      localAck("req_c1"),
      localAck("req_c2"),
      COMPACT_OUTPUT,
      COMPACT_OUTPUT,
    ]);
    await expectSilent(session, 200);
    await closeSession(session);
  });

  it("one abort cancels every pending /compact output", async () => {
    const session = await ready({ scenario: "slash" });
    const frames = await exchange(
      session,
      [
        prompt("req_c1", "/compact"),
        prompt("req_c2", "/compact"),
        { id: "req_abort_z", type: "abort" },
      ],
      3,
    );
    expect(frames).toEqual([localAck("req_c1"), localAck("req_c2"), abortAck("req_abort_z")]);
    await expectSilent(session, 300);
    await closeSession(session);
  });

  it("answers abort with nothing pending", async () => {
    const session = await ready({ scenario: "slash" });
    expect(await exchange(session, { id: "req_abort_idle", type: "abort" }, 1)).toEqual([
      abortAck("req_abort_idle"),
    ]);
    await expectSilent(session, 200);
    await closeSession(session);
  });
});

describe("fake omp branch --branch-entry", () => {
  it("appends repeatable entries verbatim after the fixed list and branches to them", async () => {
    const dir = tempDir();
    const session = await ready({
      scenario: "branch",
      extraArgs: ["--session-dir", dir, "--branch-entry", ESCAPED, "--branch-entry", "继续"],
    });
    const list = await branchList(session, "gbm-1");
    expect(list).toEqual({
      id: "gbm-1",
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [
          ...FIXED_ENTRIES,
          { entryId: "fake-entry-3", text: ESCAPED },
          { entryId: "fake-entry-4", text: "继续" },
        ],
      },
    });
    expect(readdirSync(dir)).toEqual([]);

    session.write([
      { id: "br-4", type: "branch", entryId: "fake-entry-4" },
      { id: "state-2", type: "get_state" },
    ]);
    expect(await session.wait(response("br-4", "branch"))).toEqual({
      id: "br-4",
      type: "response",
      command: "branch",
      success: true,
      data: { text: "继续", cancelled: false },
    });
    // 每个新 .jsonl 旁有一个同名产物目录。
    const written = readdirSync(dir).sort();
    expect(written).toHaveLength(2);
    const file = join(dir, String(written[1]));
    expect(file.endsWith(".jsonl")).toBe(true);
    expect(statSync(file).size).toBeGreaterThan(0);
    expect(written[0]).toBe(String(written[1]).slice(0, -".jsonl".length));
    expect(statSync(join(dir, String(written[0]))).isDirectory()).toBe(true);
    const state = await session.wait(response("state-2", "get_state"));
    expect(asRecord(state.data).sessionFile).toBe(file);

    session.write({ id: "br-3", type: "branch", entryId: "fake-entry-3" });
    const escaped = await session.wait(response("br-3", "branch"));
    expect(escaped.success).toBe(true);
    expect(asRecord(escaped.data).text).toBe(ESCAPED);
    expect(readdirSync(dir)).toHaveLength(4);
    await closeSession(session);
  });

  it("a trailing --branch-entry without value appends nothing", async () => {
    expect(await listedEntries(["--scenario", "branch", "--branch-entry"])).toEqual(FIXED_ENTRIES);
  });

  it("without the knob the list is exactly the fixed entries", async () => {
    expect(await listedEntries(["--scenario", "branch"])).toEqual(FIXED_ENTRIES);
  });

  it("the value is taken verbatim even when it looks like a flag, regardless of --scenario order", async () => {
    expect(
      await listedEntries(["--branch-entry", "--compact-silent", "--scenario", "branch"]),
    ).toEqual([...FIXED_ENTRIES, { entryId: "fake-entry-3", text: "--compact-silent" }]);
  });
});

describe("fake omp slash knobs on other scenarios", () => {
  it("normal ignores --compact-silent and --branch-entry: /compact runs the normal turn", async () => {
    const input = prompt("req_n", "/compact");
    const knobbed = await normalTurn(input, ["--compact-silent", "--branch-entry", "x"]);
    expectNormalTurn(knobbed, "req_n");
    expect(knobbed).toEqual(await normalTurn(input));
  });

  it("slash with --branch-entry still answers get_branch_messages as unsupported", async () => {
    const session = await ready({ scenario: "slash", extraArgs: ["--branch-entry", "x"] });
    session.write({ id: "gbm-1", type: "get_branch_messages" });
    const reply = await session.wait(
      (frame) => frame.type === "response" && frame.command === "get_branch_messages",
    );
    expect(reply).toEqual({
      type: "response",
      command: "get_branch_messages",
      success: false,
      error: "unsupported",
    });
    await closeSession(session);
  });
});
