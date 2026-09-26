/**
 * Issue #457 fake-omp `branch` scenario (parent s1c-turn-control-governance 6.2).
 * `get_branch_messages` 回固定列表（包在 data.messages，同 omp v18.0.10 rpc-mode）；`branch{entryId}`
 * 在 `--session-dir` 下真实写出新 .jsonl 并切换，`get_state.sessionFile` 随之变为新路径；
 * 未知 entryId 回显 id 的错误帧，不建文件、不切换。真实子进程；帧读取复用 fake-omp-helpers.ts。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const OLD_CONTENT = '{"type":"session","id":"old-session"}\n';
const MESSAGES = [
  { entryId: "fake-entry-1", text: "first question" },
  { entryId: "fake-entry-2", text: "second question" },
];
const UNKNOWN_ENTRY = "Invalid entry ID for branching";

const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface BranchFixture {
  session: Session;
  dir: string;
  old: string;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-branch-"));
  temps.push(dir);
  return dir;
}

async function handshake(session: Session): Promise<Frame> {
  await session.wait((frame) => frame.type === "ready");
  session.write(HANDSHAKE);
  await session.wait(response("protocol-1", "negotiate_protocol"));
  return session.wait(response("state-1", "get_state"));
}

async function startBranch(): Promise<BranchFixture> {
  const dir = tempDir();
  const old = join(dir, "old.jsonl");
  writeFileSync(old, OLD_CONTENT, "utf8");
  const session = startFake({
    scenario: "branch",
    extraArgs: ["--session-dir", dir, "--resume", old],
  });
  const state = await handshake(session);
  expect(asRecord(state.data).sessionFile).toBe(old);
  return { session, dir, old };
}

async function sessionFileOf(session: Session, id: string): Promise<unknown> {
  const state = await session.wait(response(id, "get_state"));
  return asRecord(state.data).sessionFile;
}

/** 新会话文件：session-dir 直属层、.jsonl、非空、与已知路径都不同。 */
function expectNewSessionFile(file: unknown, dir: string, previous: string[]): string {
  expect(typeof file).toBe("string");
  const path = String(file);
  expect(path.endsWith(".jsonl")).toBe(true);
  expect(dirname(path)).toBe(dir);
  for (const known of previous) {
    expect(path).not.toBe(known);
  }
  expect(statSync(path).size).toBeGreaterThan(0);
  return path;
}

function listing(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe("fake-omp branch scenario", () => {
  it("lists the fixed entries and switches to a new session file on branch", async () => {
    const { session, dir, old } = await startBranch();
    session.write({ id: "gbm-1", type: "get_branch_messages" });
    const list = await session.wait(response("gbm-1", "get_branch_messages"));
    expect(list).toEqual({
      id: "gbm-1",
      type: "response",
      command: "get_branch_messages",
      success: true,
      data: { messages: MESSAGES },
    });
    expect(listing(dir)).toEqual(["old.jsonl"]);

    session.write([
      { id: "br-1", type: "branch", entryId: "fake-entry-2" },
      { id: "state-2", type: "get_state" },
    ]);
    const branch = await session.wait(response("br-1", "branch"));
    expect(branch).toEqual({
      id: "br-1",
      type: "response",
      command: "branch",
      success: true,
      data: { text: "second question", cancelled: false },
    });
    const next = expectNewSessionFile(await sessionFileOf(session, "state-2"), dir, [old]);
    expect(listing(dir)).toEqual(["old.jsonl", basename(next)].sort());
    expect(readFileSync(old, "utf8")).toBe(OLD_CONTENT);
    await closeSession(session);
  });

  it("keeps the switch across prompts and branches again to another new file", async () => {
    const { session, dir, old } = await startBranch();
    session.write({ id: "gbm-1", type: "get_branch_messages" });
    const first = await session.wait(response("gbm-1", "get_branch_messages"));
    session.write([
      { id: "br-1", type: "branch", entryId: "fake-entry-2" },
      { id: "state-2", type: "get_state" },
    ]);
    await session.wait(response("br-1", "branch"));
    const next = expectNewSessionFile(await sessionFileOf(session, "state-2"), dir, [old]);

    session.write(PROMPT);
    await session.wait(response("req_1", "prompt"));
    await session.wait((frame) => frame.type === "agent_end" && frame.isTerminal !== false);
    session.write([
      { id: "state-3", type: "get_state" },
      { id: "gbm-2", type: "get_branch_messages" },
    ]);
    expect(await sessionFileOf(session, "state-3")).toBe(next);
    const second = await session.wait(response("gbm-2", "get_branch_messages"));
    expect(asRecord(second.data).messages).toEqual(asRecord(first.data).messages);

    session.write([
      { id: "br-2", type: "branch", entryId: "fake-entry-1" },
      { id: "state-4", type: "get_state" },
    ]);
    const branch = await session.wait(response("br-2", "branch"));
    expect(branch.data).toEqual({ text: "first question", cancelled: false });
    expectNewSessionFile(await sessionFileOf(session, "state-4"), dir, [next, old]);
    expect(readdirSync(dir)).toHaveLength(3);
    await closeSession(session);
  });

  it("rejects unknown or missing entry ids without writing or switching", async () => {
    const { session, dir, old } = await startBranch();
    const before = listing(dir);
    session.write([
      { id: "br-x", type: "branch", entryId: "no-such-entry" },
      { id: "br-y", type: "branch" },
      { id: "state-2", type: "get_state" },
    ]);
    for (const id of ["br-x", "br-y"]) {
      const reply = await session.wait(response(id, "branch"));
      expect(reply).toEqual({
        id,
        type: "response",
        command: "branch",
        success: false,
        error: UNKNOWN_ENTRY,
      });
    }
    expect(await sessionFileOf(session, "state-2")).toBe(old);
    expect(listing(dir)).toEqual(before);
    await closeSession(session);
  });
});

describe("fake-omp default branch guard", () => {
  it("keeps answering branch commands with the unsupported fallback under normal", async () => {
    const dir = tempDir();
    const session = startFake({ extraArgs: ["--session-dir", dir] });
    const state = await handshake(session);
    expect(asRecord(state.data).sessionFile).toBe("/tmp/open-wb-fake-session.jsonl");
    session.write([
      { id: "gbm-g", type: "get_branch_messages" },
      { id: "br-g", type: "branch", entryId: "fake-entry-2" },
    ]);
    for (const command of ["get_branch_messages", "branch"]) {
      const reply = await session.wait(
        (frame) => frame.type === "response" && frame.command === command,
      );
      expect(reply).toEqual({ type: "response", command, success: false, error: "unsupported" });
    }
    expect(readdirSync(dir)).toEqual([]);
    await closeSession(session);
    expect(await session.waitExit()).toBe(0);
  });
});
