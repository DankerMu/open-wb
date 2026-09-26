/**
 * Issue #459 fake-omp inbound frame record (parent s1c-turn-control-governance 6.4).
 * probe 回报末尾 ` frames=<入站 type 次序>`：只记 JSON.parse 成功且 `type` 为字符串的帧，
 * 记录点在串行 queue 内的 onLine，按进程累积。直接 spawn 并写原始行（空行/非法 JSON 无法经 Session.write）。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asRecord, type Frame, isTextDelta, response } from "./fake-omp-helpers.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const HS: Frame[] = [
  { id: "rid-neg", type: "negotiate_protocol", protocolVersion: 2 },
  { id: "rid-state", type: "get_state" },
];
const SECRET = "secret-marker";
const IDS = ["rid-neg", "rid-state", "rid-secret", "rid-probe"];

interface Running {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<number | null>;
}

const running: Running[] = [];
let tmp = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "fake-omp-frames-"));
});

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }),
  );
  rmSync(tmp, { recursive: true, force: true });
});

/** 字符串元素原样成行，对象元素 JSON.stringify；一次写入后关闭 stdin，等 close 再解析 stdout。 */
async function runRaw(
  args: string[],
  lines: (string | Frame)[],
): Promise<{ code: number | null; frames: Frame[] }> {
  const child = spawn(process.execPath, [FAKE, ...args], {
    stdio: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin" },
  });
  const closed = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  running.push({ child, closed });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.resume();
  const text = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)));
  child.stdin.write(`${text.join("\n")}\n`);
  child.stdin.end();
  const code = await closed;
  const frames = stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Frame);
  return { code, frames };
}

function probe(id: string): Frame {
  return { id, type: "prompt", message: `probe:${String(process.pid)}:${tmp}/probe.txt` };
}

function deltaAfter(frames: Frame[], id: string): string {
  const ack = frames.findIndex(response(id, "prompt"));
  expect(ack).toBeGreaterThanOrEqual(0);
  const delta = frames.slice(ack + 1).find(isTextDelta);
  const text = asRecord(delta?.assistantMessageEvent).delta;
  expect(typeof text).toBe("string");
  return String(text);
}

function framesOf(delta: string): string {
  expect(delta.split(" frames=")).toHaveLength(2);
  const match = / wrote=\S+ frames=([^ ]*)$/u.exec(delta);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

/** get_state 应答与 probe ack 之间的出站帧。 */
function between(frames: Frame[], probeId: string): Frame[] {
  const state = frames.findIndex(response("rid-state", "get_state"));
  const ack = frames.findIndex(response(probeId, "prompt"));
  expect(state).toBeGreaterThanOrEqual(0);
  expect(ack).toBeGreaterThan(state);
  return frames.slice(state + 1, ack);
}

function unsupported(command: string): Frame {
  return { type: "response", command, success: false, error: "unsupported" };
}

describe("fake-omp probe frames record", () => {
  it("records inbound types only, in arrival order", async () => {
    const { code, frames } = await runRaw(
      [],
      [
        ...HS,
        { id: "rid-secret", type: "prompt", message: `tell me ${SECRET}` },
        probe("rid-probe"),
      ],
    );
    expect(code).toBe(0);
    const delta = deltaAfter(frames, "rid-probe");
    for (const hidden of [SECRET, ...IDS]) {
      expect(delta).not.toContain(hidden);
    }
    expect(framesOf(delta)).toBe("negotiate_protocol,get_state,prompt,prompt");
    expect(delta).toMatch(
      /^uid=\d+ gid=\d+ env=\S* home=.* agent=.* environ=\S+ wrote=ok frames=/u,
    );
  });

  it("skips blank, unparsable and typeless lines without stalling the queue", async () => {
    const { code, frames } = await runRaw(
      [],
      [
        ...HS,
        "",
        "   ",
        "{not json",
        "null",
        "42",
        '"prompt"',
        "[]",
        '{"id":"rid-typeless"}',
        '{"type":7}',
        '{"type":null}',
        probe("rid-probe"),
      ],
    );
    expect(code).toBe(0);
    expect(between(frames, "rid-probe")).toEqual([
      { type: "response", command: "parse", success: false, error: "invalid json" },
      unsupported("parse"),
      unsupported("parse"),
      unsupported("parse"),
      unsupported("parse"),
      unsupported("parse"),
      unsupported("7"),
      unsupported("parse"),
    ]);
    expect(framesOf(deltaAfter(frames, "rid-probe"))).toBe("negotiate_protocol,get_state,prompt");
  });

  it("records unsupported and silently ignored frames", async () => {
    const { code, frames } = await runRaw(
      [],
      [
        ...HS,
        { id: "rid-abort", type: "abort" },
        { id: "rid-steer", type: "steer", message: SECRET },
        { id: "rid-gbm", type: "get_branch_messages" },
        { type: "extension_ui_response", id: "rid-ui", cancelled: true },
        probe("rid-probe"),
      ],
    );
    expect(code).toBe(0);
    const delta = deltaAfter(frames, "rid-probe");
    expect(between(frames, "rid-probe")).toEqual([
      unsupported("abort"),
      unsupported("steer"),
      unsupported("get_branch_messages"),
    ]);
    expect(delta).not.toContain(SECRET);
    expect(framesOf(delta)).toBe(
      "negotiate_protocol,get_state,abort,steer,get_branch_messages,extension_ui_response,prompt",
    );
  });

  it("reports approval-then-abort inbound order", async () => {
    const { code, frames } = await runRaw(
      ["--scenario", "approval-then-abort", "--approval-mode", "write"],
      [
        ...HS,
        { id: "rid-turn", type: "prompt", message: "run" },
        { type: "extension_ui_response", id: "r1", value: "Deny" },
        { id: "rid-abort", type: "abort" },
        probe("rid-probe"),
      ],
    );
    expect(code).toBe(0);
    const abortAck = frames.findIndex(
      (frame) =>
        frame.id === "rid-abort" &&
        frame.type === "response" &&
        frame.command === "abort" &&
        frame.success === true,
    );
    expect(abortAck).toBeGreaterThanOrEqual(0);
    expect(abortAck).toBeLessThan(frames.findIndex(response("rid-probe", "prompt")));
    expect(framesOf(deltaAfter(frames, "rid-probe"))).toBe(
      "negotiate_protocol,get_state,prompt,extension_ui_response,abort,prompt",
    );
  });

  it("records inside the serial queue and accumulates per process", async () => {
    const { code, frames } = await runRaw(
      [],
      [...HS, probe("rid-probe-1"), { id: "rid-state-2", type: "get_state" }, probe("rid-probe-2")],
    );
    expect(code).toBe(0);
    expect(framesOf(deltaAfter(frames, "rid-probe-1"))).toBe("negotiate_protocol,get_state,prompt");
    expect(framesOf(deltaAfter(frames, "rid-probe-2"))).toBe(
      "negotiate_protocol,get_state,prompt,get_state,prompt",
    );
  });
});
