/**
 * Change s2c-kb-session 3.2 (#1964): omp-test-harness「假 omp host tool 场景」 — the `host-tool`,
 * `host-tool-parallel` and `host-tool-abort` scenarios in `yolo` frame order — and「假 omp 进程契约」's
 * id-correlated `set_host_tools` refusal of every other scenario. 4.2 (#1966): `host-tool-register-fail`
 * refuses with `host tools rejected`, and `host-tool` answers the branch commands like `branch`.
 * 3.5 (#1965): `host-tool` under `write` / `always-ask` — `tool_execution_start`, then the
 * `Allow tool: kb_search` select, and `host_tool_call` only after `Approve`; any other answer ends
 * the call as denied (the fake's choice: record §2.4 did not measure Deny). Real subprocess; the
 * expected frames are literals of those requirements, of tasks.md「组 3 第二刀约定」 and of
 * docs/reviews/2026-11-10-omp-host-tools.md §2.3, §2.4, §2.6, §2.7.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  HANDSHAKE,
  isTextDelta,
  response,
  type Session,
  startFake,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const SUPPORT = fileURLToPath(new URL("./support/", import.meta.url));
const QUESTION = "查一下 KB:k1";
const QUIET_MS = 300;
const KB_SEARCH = { name: "kb_search", label: "知识库检索", description: "检索", parameters: {} };
const REGISTER: Frame = { id: "t1", type: "set_host_tools", tools: [KB_SEARCH] };
const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Handshake, `set_host_tools` and one prompt; returns once the prompt is acknowledged. */
async function openTurn(scenario: string, message: string, mode = "yolo"): Promise<Session> {
  const session = startFake({ scenario, extraArgs: ["--approval-mode", mode] });
  await session.wait((frame) => frame.type === "ready");
  session.write([...HANDSHAKE, REGISTER]);
  await session.wait(response("t1", "set_host_tools"));
  session.write({ id: "p1", type: "prompt", message });
  await session.wait(response("p1", "prompt"));
  return session;
}

function isCall(id: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "host_tool_call" && frame.id === id;
}

function isStart(toolCallId: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "tool_execution_start" && frame.toolCallId === toolCallId;
}

function isEnd(toolCallId: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "tool_execution_end" && frame.toolCallId === toolCallId;
}

function isSelect(id: string): (frame: Frame) => boolean {
  return (frame) => frame.type === "extension_ui_request" && frame.id === id;
}

/** The select omp v18.12.3 sends per call under `write` / `always-ask` (record §2.4). */
function kbSelect(id: string): Frame {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: "Allow tool: kb_search",
    options: ["Approve", "Approve kb_search for this session", "Deny"],
  };
}

function hostResult(id: string, text: string, isError = false): Frame {
  return {
    type: "host_tool_result",
    id,
    result: { content: [{ type: "text", text }], details: { bases: [id] } },
    ...(isError ? { isError: true } : {}),
  };
}

function indexOf(session: Session, predicate: (frame: Frame) => boolean): number {
  return session.frames.findIndex(predicate);
}

async function quiet(session: Session): Promise<number> {
  const count = session.frames.length;
  await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
  return session.frames.length - count;
}

/** A probe prompt after the scenario turn; returns its `frames=` inbound record. */
async function probeFrames(session: Session): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-host-tool-"));
  temps.push(dir);
  const start = session.frames.length;
  const message = `probe:${String(process.pid)}:${dir}/probe.txt`;
  session.write({ id: "p-probe", type: "prompt", message });
  await session.wait(
    (frame) => frame.type === "agent_end" && session.frames.indexOf(frame) > start,
  );
  const delta = session.frames.slice(start).find(isTextDelta);
  const text = String(asRecord(delta?.assistantMessageEvent).delta);
  return / frames=(\S*) cwd=/u.exec(text)?.[1] ?? `<no frames= in ${text}>`;
}

describe("fake omp host-tool: yolo frame order", () => {
  it("answers set_host_tools, runs two calls one after the other and echoes each result", async () => {
    const session = await openTurn("host-tool", QUESTION);
    expect(session.frames.find(response("t1", "set_host_tools"))).toEqual({
      id: "t1",
      type: "response",
      command: "set_host_tools",
      success: true,
      data: { toolNames: ["kb_search"] },
    });
    const first = await session.wait(isCall("h1"));
    expect(first).toEqual({
      type: "host_tool_call",
      id: "h1",
      toolCallId: "c1",
      toolName: "kb_search",
      arguments: { question: QUESTION, kb_ids: ["k1"] },
    });
    const start = await session.wait(isStart("c1"));
    expect(start).toMatchObject({
      toolName: "kb_search",
      intent: "第 1 轮",
      args: first.arguments,
    });
    expect(indexOf(session, isCall("h1"))).toBeLessThan(indexOf(session, isStart("c1")));
    expect(await quiet(session)).toBe(0);

    const answer = hostResult("h1", "r1");
    session.write(answer);
    expect(await session.wait(isEnd("c1"))).toEqual({
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "kb_search",
      result: answer.result,
      isError: false,
    });
    const second = await session.wait(isCall("h2"));
    expect(second).toMatchObject({
      toolCallId: "c2",
      toolName: "kb_search",
      arguments: { question: `${QUESTION} 详细说明`, kb_ids: ["k1"] },
    });
    expect(await session.wait(isStart("c2"))).toMatchObject({ intent: "第 2 轮" });
    expect(indexOf(session, isEnd("c1"))).toBeLessThan(indexOf(session, isCall("h2")));
    expect(indexOf(session, isCall("h2"))).toBeLessThan(indexOf(session, isStart("c2")));

    session.write(hostResult("h2", "r2", true));
    expect(await session.wait(isEnd("c2"))).toMatchObject({ isError: true });
    const end = indexOf(session, isEnd("c2"));
    await session.wait((frame) => frame.type === "agent_end");
    expect(session.frames.slice(end).some(isTextDelta)).toBe(true);
    expect(await probeFrames(session)).toBe(
      "negotiate_protocol,get_state,set_host_tools,prompt,host_tool_result,host_tool_result,prompt",
    );
    await closeSession(session);
  });

  it("host-tool-parallel sends three calls before any answer and ends each as its result arrives", async () => {
    const session = await openTurn("host-tool-parallel", "查一下 KB:k1 KB:k2");
    await session.wait(isStart("c3"));
    const calls = session.frames.filter((frame) => frame.type === "host_tool_call");
    expect(calls.map((call) => [call.id, call.toolCallId, call.toolName])).toEqual([
      ["h1", "c1", "kb_search"],
      ["h2", "c2", "kb_search"],
      ["h3", "c3", "other"],
    ]);
    expect(calls.slice(0, 2).map((call) => asRecord(call.arguments).kb_ids)).toEqual([
      ["k1"],
      ["k2"],
    ]);
    for (const n of [1, 2, 3]) {
      expect(indexOf(session, isCall(`h${n}`))).toBe(indexOf(session, isStart(`c${n}`)) - 1);
    }
    expect(await quiet(session)).toBe(0);
    expect(session.frames.some((frame) => frame.type === "tool_execution_end")).toBe(false);

    for (const n of [2, 3]) {
      session.write(hostResult(`h${n}`, `r${n}`));
      await session.wait(isEnd(`c${n}`));
    }
    expect(session.frames.some((frame) => frame.type === "agent_end")).toBe(false);
    session.write(hostResult("h1", "r1"));
    await session.wait((frame) => frame.type === "agent_end");
    const ends = session.frames.filter((frame) => frame.type === "tool_execution_end");
    expect(ends.map((frame) => frame.toolCallId)).toEqual(["c2", "c3", "c1"]);
    await closeSession(session);
  });
});

describe("fake omp host-tool: write / always-ask frame order (3.5)", () => {
  /** Waits for call n's start and select; nothing more is sent until it is answered. */
  async function selected(session: Session, n: number): Promise<void> {
    expect(await session.wait(isStart(`c${n}`))).toMatchObject({
      toolName: "kb_search",
      intent: `第 ${n} 轮`,
    });
    expect(await session.wait(isSelect(`r${n}`), 2_000)).toEqual(kbSelect(`r${n}`));
    expect(indexOf(session, isStart(`c${n}`))).toBeLessThan(indexOf(session, isSelect(`r${n}`)));
    expect(await quiet(session)).toBe(0);
    expect(indexOf(session, isCall(`h${n}`))).toBe(-1);
  }

  it.each(["write", "always-ask"])(
    "%s: each host_tool_call follows its select and only an Approve releases it",
    async (mode) => {
      const session = await openTurn("host-tool", QUESTION, mode);
      for (const n of [1, 2]) {
        await selected(session, n);
        session.write({ type: "extension_ui_response", id: `r${n}`, value: "Approve" });
        expect(await session.wait(isCall(`h${n}`))).toMatchObject({
          toolCallId: `c${n}`,
          toolName: "kb_search",
          arguments: { question: n === 1 ? QUESTION : `${QUESTION} 详细说明`, kb_ids: ["k1"] },
        });
        expect(indexOf(session, isSelect(`r${n}`))).toBeLessThan(indexOf(session, isCall(`h${n}`)));
        session.write(hostResult(`h${n}`, `r${n}`));
        await session.wait(isEnd(`c${n}`));
      }
      await session.wait((frame) => frame.type === "agent_end");
      expect(session.frames.slice(indexOf(session, isEnd("c2"))).some(isTextDelta)).toBe(true);
      expect(await probeFrames(session)).toBe(
        "negotiate_protocol,get_state,set_host_tools,prompt,extension_ui_response,host_tool_result," +
          "extension_ui_response,host_tool_result,prompt",
      );
      await closeSession(session);
    },
  );

  it.each([
    ["Deny", { value: "Deny" }],
    ["cancelled", { cancelled: true }],
  ])(
    "an answer of %s ends the call as denied without a host_tool_call; the next call is r2/c2/h2",
    async (_label, answer) => {
      const session = await openTurn("host-tool", QUESTION, "write");
      await selected(session, 1);
      session.write({ type: "extension_ui_response", id: "r1", ...answer });
      expect(await session.wait(isEnd("c1"))).toEqual({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "kb_search",
        result: { content: [{ type: "text", text: "Tool call denied by user: kb_search" }] },
        isError: true,
      });
      await selected(session, 2);
      expect(indexOf(session, isEnd("c1"))).toBeLessThan(indexOf(session, isStart("c2")));
      session.write({ type: "extension_ui_response", id: "r2", value: "Approve" });
      await session.wait(isCall("h2"));
      session.write(hostResult("h2", "r2"));
      await session.wait((frame) => frame.type === "agent_end");
      const calls = session.frames.filter((frame) => frame.type === "host_tool_call");
      expect(calls.map((call) => [call.id, call.toolCallId])).toEqual([["h2", "c2"]]);
      expect(await probeFrames(session)).toBe(
        "negotiate_protocol,get_state,set_host_tools,prompt,extension_ui_response," +
          "extension_ui_response,host_tool_result,prompt",
      );
      await closeSession(session);
    },
  );
});

describe("fake omp host-tool-abort", () => {
  it("cancels the call on abort, ignores the late result, then runs the next prompt as normal", async () => {
    const session = await openTurn("host-tool-abort", QUESTION);
    await session.wait(isStart("c1"));
    expect(indexOf(session, isCall("h1"))).toBeLessThan(indexOf(session, isStart("c1")));
    expect(await quiet(session)).toBe(0);
    const start = session.frames.length;
    session.write({ id: "a1", type: "abort" });
    await session.wait(response("a1", "abort"));
    const tail = session.frames.slice(start);
    expect(tail.map((frame) => frame.type)).toEqual([
      "host_tool_cancel",
      "tool_execution_end",
      "turn_end",
      "agent_end",
      "response",
    ]);
    expect(tail[0]).toMatchObject({ targetId: "h1" });
    expect(tail[1]).toMatchObject({
      toolCallId: "c1",
      isError: true,
      result: { content: [{ type: "text", text: 'Host tool "kb_search" was aborted' }] },
    });
    expect(tail[2]).toMatchObject({ stopReason: "aborted" });
    expect(tail[4]).toEqual({ id: "a1", type: "response", command: "abort", success: true });

    session.write(hostResult("h1", "late"));
    expect(await quiet(session)).toBe(0);
    expect(await probeFrames(session)).toBe(
      "negotiate_protocol,get_state,set_host_tools,prompt,abort,host_tool_result,prompt",
    );
    const next = session.frames.length;
    session.write({ id: "p2", type: "prompt", message: QUESTION });
    await session.wait(
      (frame) => frame.type === "agent_end" && session.frames.indexOf(frame) > next,
    );
    expect(session.frames.slice(next).some((frame) => frame.type === "host_tool_call")).toBe(false);
    expect(session.frames.slice(next).filter(isTextDelta)).toHaveLength(3);
    await closeSession(session);
  });
});

describe("fake omp set_host_tools outside the host tool scenarios", () => {
  it("refuses with an id-correlated unsupported response; other unknown commands stay unchanged", async () => {
    const session = startFake({ scenario: "normal" });
    await session.wait((frame) => frame.type === "ready");
    session.write([...HANDSHAKE, REGISTER, { type: "bogus" }]);
    await session.wait(response("t1", "set_host_tools"));
    await session.wait((frame) => frame.command === "bogus");
    expect(session.frames.slice(-2)).toEqual([
      {
        id: "t1",
        type: "response",
        command: "set_host_tools",
        success: false,
        error: "unsupported",
      },
      { type: "response", command: "bogus", success: false, error: "unsupported" },
    ]);
    await closeSession(session);
  });

  it("keeps fake-omp-host-tool.mjs an import-free leaf statically imported by main", () => {
    const leaf = readFileSync(join(SUPPORT, "fake-omp-host-tool.mjs"), "utf8");
    expect(leaf).not.toMatch(/^import /m);
    expect(leaf).not.toMatch(/\bimport\(|\brequire\(/);
    expect(leaf).not.toMatch(/^let /m);
    const main = readFileSync(join(SUPPORT, "fake-omp.mjs"), "utf8");
    expect(main).toMatch(/^import \{[^}]+\} from "\.\/fake-omp-host-tool\.mjs";$/m);
    for (const name of ["fake-omp.mjs", "fake-omp-host-tool.mjs"]) {
      const check = spawnSync(process.execPath, ["--check", join(SUPPORT, name)], {
        encoding: "utf8",
      });
      expect(check.status, check.stderr).toBe(0);
    }
  });
});

describe("fake omp host-tool-register-fail (4.2)", () => {
  it("refuses set_host_tools with exactly one id-correlated frame; a later probe turn runs as normal", async () => {
    const session = startFake({ scenario: "host-tool-register-fail" });
    await session.wait((frame) => frame.type === "ready");
    session.write([...HANDSHAKE, { id: "r1", type: "set_host_tools", tools: [KB_SEARCH] }]);
    await session.wait(response("r1", "set_host_tools"));
    expect(session.frames.filter(response("r1", "set_host_tools"))).toEqual([
      {
        id: "r1",
        type: "response",
        command: "set_host_tools",
        success: false,
        error: "host tools rejected",
      },
    ]);
    expect(await probeFrames(session)).toBe("negotiate_protocol,get_state,set_host_tools,prompt");
    await closeSession(session);
  });
});

describe("fake omp host-tool answers the branch commands (4.2, regenerate)", () => {
  it("lists the fixed entries and --branch-entry, branches to a new session file, then runs its turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-omp-host-tool-branch-"));
    temps.push(dir);
    const session = startFake({
      scenario: "host-tool",
      extraArgs: ["--approval-mode", "yolo", "--session-dir", dir, "--branch-entry", QUESTION],
    });
    await session.wait((frame) => frame.type === "ready");
    session.write([...HANDSHAKE, REGISTER, { id: "gbm-1", type: "get_branch_messages" }]);
    expect(await session.wait(response("gbm-1", "get_branch_messages"))).toEqual({
      id: "gbm-1",
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: {
        messages: [
          { entryId: "fake-entry-1", text: "first question" },
          { entryId: "fake-entry-2", text: "second question" },
          { entryId: "fake-entry-3", text: QUESTION },
        ],
      },
    });
    session.write([
      { id: "br-1", type: "branch", entryId: "fake-entry-3" },
      { id: "state-2", type: "get_state" },
    ]);
    expect(await session.wait(response("br-1", "branch"))).toEqual({
      id: "br-1",
      type: "response",
      command: "branch",
      success: true,
      data: { text: QUESTION, cancelled: false },
    });
    const state = await session.wait(response("state-2", "get_state"));
    const file = String(asRecord(state.data).sessionFile);
    expect([file.startsWith(`${dir}/branch-`), file.endsWith(".jsonl")]).toEqual([true, true]);
    session.write({ id: "p1", type: "prompt", message: QUESTION });
    expect(await session.wait(isCall("h1"))).toMatchObject({
      arguments: { question: QUESTION, kb_ids: ["k1"] },
    });
    await closeSession(session);
  });
});
