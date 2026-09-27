/**
 * Issue #518 fake-omp `thinking` / `edit-write` scenarios (parent s1c-session-metadata-presentation 6.1).
 * 真实子进程：只看 stdout 帧与磁盘文件。`thinking` 发 omp v18.0.10 形状的 thinking_start/delta/end，
 * 旋钮 `--thinking-repeat <n>` 与 `--hold-after-thinking` 只作用于 `thinking`；`edit-write` 在
 * `<cwd>` 下真实写 `notes.md` 与 `out/report.html` 后才发各自的 tool_execution_end。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
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
const MAIN = join(SUPPORT, "fake-omp.mjs");
const PROXY = join(SUPPORT, "fake-omp-proxy.mjs");
const THINKING = join(SUPPORT, "fake-omp-thinking.mjs");
const PARTS = ["先读需求，", "再列要点，", "最后作答。"];
const TEXT = "先读需求，再列要点，最后作答。";
const PARTIAL = { role: "assistant", content: [] };
const WRITE_MODE = ["--approval-mode", "write"];
const ABORT = { type: "abort", id: "req_abort" };
const PROMPT_2 = { id: "req_2", type: "prompt", message: "again" };
const QUIET_MS = 250;
const DIFF = "+1|a\n+2|b\n-3|c\n 4|d";
/** fixture 文档化的固定内容（fake-omp-thinking.mjs）；独立抄写，不从夹具导入。 */
const NOTES_CONTENT = "a\nb\nd\n";
const REPORT_HTML = "<!doctype html>\n<html><body><h1>Report</h1></body></html>\n";
const DEFAULT_THINKING = [
  "response:prompt",
  "agent_start",
  "thinking_start",
  "thinking_delta",
  "thinking_delta",
  "thinking_delta",
  "thinking_end",
  "text_delta",
  "text_delta",
  "text_delta",
  "message_end:stop",
  "agent_end",
];
const EDIT_WRITE = [
  "response:prompt",
  "agent_start",
  "thinking_start",
  "thinking_delta",
  "thinking_delta",
  "thinking_delta",
  "thinking_end",
  "message_end:toolUse",
  "tool_execution_start:edit",
  "tool_execution_end:edit",
  "tool_execution_start:write",
  "tool_execution_end:write",
  "text_delta",
  "text_delta",
  "message_end:stop",
  "agent_end",
];

const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function eventOf(frame: Frame): Frame {
  return frame.type === "message_update" ? asRecord(frame.assistantMessageEvent) : {};
}

function isThinkingDelta(frame: Frame): boolean {
  return eventOf(frame).type === "thinking_delta";
}

function isThinkingEnd(frame: Frame): boolean {
  return eventOf(frame).type === "thinking_end";
}

function isTerminal(frame: Frame): boolean {
  return frame.type === "agent_end" && frame.isTerminal === true;
}

/** 帧类型序列：message_update 取事件类型，message_end 带 stopReason，工具帧带 toolName。 */
function describeFrame(frame: Frame): string {
  if (frame.type === "message_update") {
    return String(eventOf(frame).type);
  }
  if (frame.type === "message_end") {
    return `message_end:${String(asRecord(frame.message).stopReason)}`;
  }
  if (frame.type === "response") {
    return `response:${String(frame.command)}`;
  }
  if (frame.type === "tool_execution_start" || frame.type === "tool_execution_end") {
    return `${frame.type}:${String(frame.toolName)}`;
  }
  return String(frame.type);
}

/** 从 id 对应的 prompt ack 起（含）到 `end`（不含）的帧。 */
function turnFrames(session: Session, id: string, end = session.frames.length): Frame[] {
  const ack = session.frames.findIndex(response(id, "prompt"));
  expect(ack).toBeGreaterThanOrEqual(0);
  return session.frames.slice(ack, end);
}

function turnOf(session: Session, id: string): string[] {
  return turnFrames(session, id).map(describeFrame);
}

async function runTurn(session: Session, prompt: Frame): Promise<Frame[]> {
  const before = session.frames.length;
  session.write(prompt);
  await session.wait((frame) => session.frames.indexOf(frame) >= before && isTerminal(frame));
  return turnFrames(session, String(prompt.id));
}

async function expectQuiet(session: Session): Promise<void> {
  const count = session.frames.length;
  await expect(session.wait(() => session.frames.length > count, QUIET_MS)).rejects.toThrow(
    /timed out/,
  );
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-wb-meta-"));
  temps.push(dir);
  return realpathSync(dir);
}

/** 断言一个完整默认 thinking 回合的逐字段形状（repeat=1）。 */
function expectThinkingTurn(frames: Frame[]): void {
  expect(frames.map(describeFrame)).toEqual(DEFAULT_THINKING);
  expect(frames[1]).toEqual({ type: "agent_start" });
  expect(frames[2]).toEqual({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: PARTIAL },
    message: PARTIAL,
  });
  for (const [index, part] of PARTS.entries()) {
    expect(frames[3 + index]).toEqual({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: part,
        partial: PARTIAL,
      },
      message: PARTIAL,
    });
  }
  expect(frames[6]).toEqual({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex: 0,
      content: TEXT,
      partial: PARTIAL,
    },
    message: PARTIAL,
  });
  const texts = frames.filter((frame) => eventOf(frame).type === "text_delta");
  expect(texts.length).toBeGreaterThanOrEqual(3);
  for (const frame of texts) {
    expect(eventOf(frame).contentIndex).toBe(1);
    expect(typeof eventOf(frame).delta).toBe("string");
  }
  const message = asRecord(frames[10]?.message);
  expect(message.role).toBe("assistant");
  const content = message.content as Frame[];
  expect(content[0]).toEqual({ type: "thinking", thinking: TEXT });
  expect(content[1]).toEqual({
    type: "text",
    text: texts.map((frame) => String(eventOf(frame).delta)).join(""),
  });
  expect(frames[11]).toEqual({ type: "agent_end", messages: [], isTerminal: true });
  for (const frame of frames) {
    expect(String(frame.type)).not.toMatch(/^tool_execution_|^extension_ui_request$/);
  }
}

describe("fake omp thinking scenario", () => {
  it.each([
    ["default argv (yolo)", []],
    ["--approval-mode write", WRITE_MODE],
  ])("emits thinking frames, text, stop with thinking block under %s", async (_label, extra) => {
    const session = await startPromptedSession({ scenario: "thinking", extraArgs: extra });
    await session.wait(isTerminal);
    expectThinkingTurn(turnFrames(session, "req_1"));
    const second = await runTurn(session, PROMPT_2);
    expectThinkingTurn(second);
    expect(session.frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
    await closeSession(session);
  });

  it("answers abort as unsupported without the hold knob, like normal", async () => {
    const session = await startPromptedSession({ scenario: "thinking" });
    await session.wait(isTerminal);
    session.write(ABORT);
    const reply = await session.wait(
      (frame) => frame.type === "response" && frame.command === "abort",
    );
    expect(reply).toEqual({
      type: "response",
      command: "abort",
      success: false,
      error: "unsupported",
    });
    await closeSession(session);
  });

  it("--thinking-repeat 3 emits exactly nine deltas cycling the three parts", async () => {
    const session = await startPromptedSession({
      scenario: "thinking",
      extraArgs: ["--thinking-repeat", "3"],
    });
    await session.wait(isTerminal);
    const frames = turnFrames(session, "req_1");
    const deltas = frames.filter(isThinkingDelta).map((frame) => eventOf(frame).delta);
    expect(deltas).toEqual([...PARTS, ...PARTS, ...PARTS]);
    expect(eventOf(frames.find(isThinkingEnd) ?? {}).content).toBe(TEXT.repeat(3));
    await closeSession(session);
  });

  it("--thinking-repeat 2185 emits 6555 deltas past 32768 code points in under 4 MiB", async () => {
    const session = await startPromptedSession({
      scenario: "thinking",
      extraArgs: ["--thinking-repeat", "2185"],
    });
    await session.wait(isTerminal, 20_000);
    const frames = turnFrames(session, "req_1");
    const deltas = frames.filter(isThinkingDelta);
    expect(deltas).toHaveLength(6555);
    deltas.forEach((frame, index) => {
      expect(eventOf(frame).delta).toBe(PARTS[index % 3]);
    });
    const expected = TEXT.repeat(2185);
    const content = String(eventOf(frames.find(isThinkingEnd) ?? {}).content);
    expect(content).toBe(expected);
    expect([...content].length).toBe(32775);
    const stop = frames.find((frame) => describeFrame(frame) === "message_end:stop");
    const blocks = asRecord(stop?.message).content as Frame[];
    expect(blocks[0]).toEqual({ type: "thinking", thinking: expected });
    expect(frames.map(describeFrame).slice(2 + 6555 + 2)).toEqual(DEFAULT_THINKING.slice(7));
    expect(Buffer.byteLength(session.stdout, "utf8")).toBeLessThan(4 * 1024 * 1024);
    await closeSession(session);
  }, 30_000);

  it.each([
    ["0", ["--thinking-repeat", "0"]],
    ["-1", ["--thinking-repeat", "-1"]],
    ["1.5", ["--thinking-repeat", "1.5"]],
    ["abc", ["--thinking-repeat", "abc"]],
  ])("rejects --thinking-repeat %s before any frame", async (_label, extra) => {
    const session = startFake({ scenario: "thinking", extraArgs: extra });
    const code = await session.waitExit();
    expect(code).not.toBe(0);
    expect(session.stdout).toBe("");
    expect(session.frames).toEqual([]);
  });

  it("rejects a trailing --thinking-repeat without value before any frame", async () => {
    const session = startFake({ extraArgs: ["--scenario", "thinking", "--thinking-repeat"] });
    const code = await session.waitExit();
    expect(code).not.toBe(0);
    expect(session.stdout).toBe("");
    expect(session.frames).toEqual([]);
  });
});

describe("fake omp thinking hold", () => {
  it("holds after thinking_end until abort, then ends aborted; the next prompt holds again", async () => {
    const session = await startPromptedSession({
      scenario: "thinking",
      extraArgs: ["--hold-after-thinking"],
    });
    await session.wait(isThinkingEnd);
    await expectQuiet(session);
    expect(turnOf(session, "req_1")).toEqual(DEFAULT_THINKING.slice(0, 7));
    session.write(ABORT);
    await session.wait(response("req_abort", "abort"));
    const tail = turnFrames(session, "req_1").slice(7);
    expect(tail).toEqual([
      { type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } },
      { type: "agent_end", messages: [], isTerminal: true },
      { id: "req_abort", type: "response", command: "abort", success: true },
    ]);
    const before = session.frames.length;
    session.write(PROMPT_2);
    await session.wait((frame) => session.frames.indexOf(frame) >= before && isThinkingEnd(frame));
    await expectQuiet(session);
    expect(turnOf(session, "req_2")).toEqual(DEFAULT_THINKING.slice(0, 7));
    await closeSession(session);
  });

  it("honors an abort written together with the prompt right after thinking_end", async () => {
    const session = startFake({ scenario: "thinking", extraArgs: ["--hold-after-thinking"] });
    await session.wait((frame) => frame.type === "ready");
    session.write(HANDSHAKE);
    await session.wait(response("state-1", "get_state"));
    session.write([PROMPT, ABORT]);
    await session.wait(response("req_abort", "abort"));
    expect(turnOf(session, "req_1")).toEqual([
      ...DEFAULT_THINKING.slice(0, 7),
      "message_end:aborted",
      "agent_end",
      "response:abort",
    ]);
    await expectQuiet(session);
    await closeSession(session);
  });

  it("without either knob the turn has exactly the default thinking sequence", async () => {
    const session = await startPromptedSession({ scenario: "thinking" });
    await session.wait(isTerminal);
    expect(turnOf(session, "req_1")).toEqual(DEFAULT_THINKING);
    await closeSession(session);
  });
});

/** 在收到各 end 帧的同一回调里同步检查所报告文件（先于 prompt 注册）。 */
function watchEnd(
  session: Session,
  tool: string,
  file: string,
): Promise<{ exists: boolean; text: string }> {
  let seen: { exists: boolean; text: string } | undefined;
  return session
    .wait((frame) => {
      if (frame.type !== "tool_execution_end" || frame.toolName !== tool) {
        return false;
      }
      seen ??= {
        exists: existsSync(file),
        text: existsSync(file) ? readFileSync(file, "utf8") : "",
      };
      return true;
    })
    .then(() => seen ?? { exists: false, text: "" });
}

async function runEditWrite(
  dir: string,
  extra: string[],
): Promise<{
  session: Session;
  frames: Frame[];
  edit: { exists: boolean; text: string };
  write: { exists: boolean; text: string };
}> {
  const session = startFake({ scenario: "edit-write", cwd: dir, extraArgs: extra });
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("state-1", "get_state"));
  const edit = watchEnd(session, "edit", join(dir, "notes.md"));
  const write = watchEnd(session, "write", join(dir, "out", "report.html"));
  session.write(PROMPT);
  await session.wait(isTerminal);
  return { session, frames: turnFrames(session, "req_1"), edit: await edit, write: await write };
}

function expectEditWriteTurn(frames: Frame[], dir: string): void {
  expect(frames.map(describeFrame)).toEqual(EDIT_WRITE);
  expect(frames.filter(isThinkingDelta).map((frame) => eventOf(frame).delta)).toEqual(PARTS);
  expect(eventOf(frames[6] ?? {}).content).toBe(TEXT);
  const toolUse = asRecord(frames[7]?.message);
  const calls = toolUse.content as Frame[];
  expect(calls.map((call) => [call.type, call.name])).toEqual([
    ["toolCall", "edit"],
    ["toolCall", "write"],
  ]);
  const [editStart, editEnd, writeStart, writeEnd] = frames.slice(8, 12);
  expect(Object.keys(asRecord(editStart?.args))).toEqual(["input"]);
  expect(typeof asRecord(editStart?.args).input).toBe("string");
  expect(asRecord(calls[0]?.arguments)).toEqual(editStart?.args);
  expect(editEnd?.toolCallId).toBe(editStart?.toolCallId);
  expect(editEnd?.isError).toBeUndefined();
  expect(asRecord(editEnd?.result).details).toEqual({ path: join(dir, "notes.md"), diff: DIFF });
  for (const end of [editEnd, writeEnd]) {
    const [block] = asRecord(end?.result).content as Frame[];
    expect(block?.type).toBe("text");
    expect(typeof block?.text).toBe("string");
  }
  expect(asRecord(writeStart?.args)).toEqual({ path: "out/report.html", content: REPORT_HTML });
  expect(asRecord(calls[1]?.arguments)).toEqual(writeStart?.args);
  expect(writeEnd?.toolCallId).toBe(writeStart?.toolCallId);
  expect(writeEnd?.toolCallId).not.toBe(editStart?.toolCallId);
  expect(writeEnd?.isError).toBeUndefined();
  const writeDetails = asRecord(asRecord(writeEnd?.result).details);
  expect(writeDetails).toEqual({ resolvedPath: join(dir, "out", "report.html") });
  expect("diff" in writeDetails).toBe(false);
  expect(asRecord(frames[14]?.message).stopReason).toBe("stop");
  expect(frames[15]).toEqual({ type: "agent_end", messages: [], isTerminal: true });
}

describe("fake omp edit-write scenario", () => {
  it("emits thinking, two tool steps with details and real files, text and stop (write mode)", async () => {
    const dir = tempDir();
    const { session, frames, edit, write } = await runEditWrite(dir, WRITE_MODE);
    expectEditWriteTurn(frames, dir);
    expect(edit).toEqual({ exists: true, text: NOTES_CONTENT });
    expect(write).toEqual({ exists: true, text: REPORT_HTML });
    expect(session.frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
    await closeSession(session);
  });

  it("emits no extension_ui_request under yolo either", async () => {
    const dir = tempDir();
    const { session, frames, edit, write } = await runEditWrite(dir, []);
    expectEditWriteTurn(frames, dir);
    expect(edit.exists && write.exists).toBe(true);
    expect(session.frames.some((frame) => frame.type === "extension_ui_request")).toBe(false);
    await closeSession(session);
  });

  it("roots every reported path at another working directory, diff and order unchanged", async () => {
    const first = tempDir();
    const other = tempDir();
    const a = await runEditWrite(first, WRITE_MODE);
    const b = await runEditWrite(other, WRITE_MODE);
    expectEditWriteTurn(b.frames, other);
    expect(b.frames.map(describeFrame)).toEqual(a.frames.map(describeFrame));
    expect(JSON.stringify(b.frames)).not.toContain(first);
    expect(b.edit).toEqual({ exists: true, text: NOTES_CONTENT });
    expect(b.write).toEqual({ exists: true, text: REPORT_HTML });
    await closeSession(a.session);
    await closeSession(b.session);
  });

  it("ignores both thinking knobs: three deltas, no hold, normal tool steps", async () => {
    const dir = tempDir();
    const { session, frames } = await runEditWrite(dir, [
      ...WRITE_MODE,
      "--thinking-repeat",
      "3",
      "--hold-after-thinking",
    ]);
    expectEditWriteTurn(frames, dir);
    await closeSession(session);
  });

  it("reports a failed write as isError without details and still completes the turn", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "out"), "not a directory");
    const { session, frames, edit } = await runEditWrite(dir, WRITE_MODE);
    expect(frames.map(describeFrame)).toEqual(EDIT_WRITE);
    expect(edit).toEqual({ exists: true, text: NOTES_CONTENT });
    const editEnd = frames[9];
    expect(asRecord(editEnd?.result).details).toEqual({ path: join(dir, "notes.md"), diff: DIFF });
    const writeEnd = frames[11];
    expect(writeEnd?.isError).toBe(true);
    expect("details" in asRecord(writeEnd?.result)).toBe(false);
    const [block] = asRecord(writeEnd?.result).content as Frame[];
    expect(block?.type).toBe("text");
    expect(asRecord(frames[14]?.message).stopReason).toBe("stop");
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("not a directory");
    await closeSession(session);
  });
});

describe("fake omp knobs on other scenarios", () => {
  it("normal with --thinking-repeat 0 --hold-after-thinking starts and matches the knob-less run", async () => {
    const plain = await startPromptedSession({ scenario: "normal" });
    await plain.wait(isTerminal);
    const knobbed = await startPromptedSession({
      scenario: "normal",
      extraArgs: ["--thinking-repeat", "0", "--hold-after-thinking"],
    });
    await knobbed.wait(isTerminal);
    expect(knobbed.frames).toEqual(plain.frames);
    await closeSession(plain);
    await closeSession(knobbed);
  });
});

/** 叶子模块只许 `node:` 静态导入：不回引主程序、不互引、无动态导入/shebang/顶层可变状态。 */
function expectNodeOnlyLeaf(file: string): void {
  const module = readFileSync(file, "utf8");
  const imports = module.split("\n").filter((line) => line.startsWith("import"));
  expect(imports.length, file).toBeGreaterThan(0);
  for (const line of imports) {
    expect(line, file).toMatch(/from "node:[a-z/]+";$/);
  }
  expect(imports.join("\n"), file).not.toMatch(/fake-omp(-proxy|-thinking)?\.mjs/);
  expect(module, file).not.toMatch(/\bimport\(|\brequire\(/);
  expect(module.startsWith("#!"), file).toBe(false);
  expect(module, file).not.toMatch(/^let /m);
}

describe("fake omp module split", () => {
  it("keeps proxy and thinking modules node-only leaves, statically imported by main and within line budgets", () => {
    for (const leaf of [PROXY, THINKING]) {
      expectNodeOnlyLeaf(leaf);
    }
    const main = readFileSync(MAIN, "utf8");
    expect(main).toMatch(/^import \{[^}]+\} from "\.\/fake-omp-proxy\.mjs";$/m);
    expect(main).toMatch(/^import \{[^}]+\} from "\.\/fake-omp-thinking\.mjs";$/m);
    for (const file of [MAIN, PROXY, THINKING]) {
      const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      expect(check.status, check.stderr).toBe(0);
      expect(readFileSync(file, "utf8").split("\n").length - 1).toBeLessThanOrEqual(800);
    }
  });
});
