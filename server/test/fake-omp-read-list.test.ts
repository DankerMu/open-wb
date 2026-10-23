/**
 * s1d-experts-skills group 1 (issue #1656): fake-omp `read:<path>` and `list:<path>` probes —
 * omp-test-harness「假 omp probe 回报」scenario「读取与列举探针」. The fixture reads the file / lists
 * the directory with its own credentials and reports only `read=<ok|errno>` / `listed=<ok|errno>`
 * in one text delta (never the content or an entry name), then completes the turn normally.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  isTextDelta,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const CONTENT = "FILE-CONTENT-SENTINEL-1656";
const ENTRY = "ENTRY-NAME-SENTINEL-1656";
const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-read-list-"));
  temps.push(dir);
  return dir;
}

/** One probe turn: exactly one delta, then the assistant stop and the terminal end; nothing leaks. */
async function probeTurn(message: string): Promise<string> {
  const session = await startPromptedSession({
    prompt: { id: "req_probe", type: "prompt", message },
  });
  const end = await session.wait(
    (frame) => frame.type === "agent_end" && frame.isTerminal === true,
  );
  const deltas = session.frames.filter(isTextDelta);
  expect(deltas).toHaveLength(1);
  expect(session.frames.slice(session.frames.indexOf(deltas[0] as Frame) + 1)).toEqual([
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
    end,
  ]);
  expect(session.stdout).not.toContain(CONTENT);
  expect(session.stdout).not.toContain(ENTRY);
  await closeSession(session);
  return String(asRecord(deltas[0]?.assistantMessageEvent).delta);
}

describe("fake omp read and list probes", () => {
  it("reports read=ok, read=ENOENT, listed=ok and listed=ENOENT without content or entry names", async () => {
    const dir = tempDir();
    const file = join(dir, "readable: file.yml");
    writeFileSync(file, CONTENT);
    const listed = join(dir, "listed dir");
    mkdirSync(listed);
    writeFileSync(join(listed, ENTRY), "x");

    expect(await probeTurn(`read:${file}`)).toBe("read=ok");
    expect(await probeTurn(`read:${join(dir, "absent")}`)).toBe("read=ENOENT");
    expect(await probeTurn(`list:${listed}`)).toBe("listed=ok");
    expect(await probeTurn(`list:${join(dir, "absent")}`)).toBe("listed=ENOENT");
  });
});
