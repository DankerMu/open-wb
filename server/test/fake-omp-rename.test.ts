/**
 * Issue #706 fake-omp `rename:<path>` probe (omp-test-harness「假 omp probe 回报」): the fixture
 * renames `<path>` to `<path>.moved` with its own credentials and reports `renamed=<ok|errno>` in
 * one text delta, then completes the turn normally. The whole remainder after `rename:` is the path.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asRecord,
  closeSession,
  type Frame,
  isTextDelta,
  type Session,
  startPromptedSession,
  stopFakeChildren,
} from "./fake-omp-helpers.js";

const temps: string[] = [];

afterEach(async () => {
  await stopFakeChildren();
  for (const dir of temps.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-omp-rename-"));
  temps.push(dir);
  return dir;
}

/** One `rename:` turn; asserts the single delta and the normal completion after it. */
async function renameTurn(path: string): Promise<{ session: Session; delta: string }> {
  const session = await startPromptedSession({
    prompt: { id: "req_rename", type: "prompt", message: `rename:${path}` },
  });
  const end = await session.wait(
    (frame) => frame.type === "agent_end" && frame.isTerminal === true,
  );
  const deltas = session.frames.filter(isTextDelta);
  expect(deltas).toHaveLength(1);
  // Normal completion: the one delta is followed by the assistant stop and the terminal end only.
  expect(session.frames.slice(session.frames.indexOf(deltas[0] as Frame) + 1)).toEqual([
    { type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } },
    end,
  ]);
  expect(end).toEqual({ type: "agent_end", messages: [], isTerminal: true });
  const delta = String(asRecord(deltas[0]?.assistantMessageEvent).delta);
  return { session, delta };
}

describe("fake omp rename probe", () => {
  it("renames an existing path containing colons and spaces and reports ok", async () => {
    const path = join(tempDir(), "entry: with spaces:and colons");
    mkdirSync(path);
    writeFileSync(join(path, "inside.txt"), "kept");

    const { session, delta } = await renameTurn(path);

    expect(delta).toBe("renamed=ok");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(`${path}.moved`, "inside.txt"), "utf8")).toBe("kept");
    await closeSession(session);
  });

  it.skipIf(process.geteuid?.() === 0)(
    "reports EACCES and moves nothing when the parent directory is not writable",
    async () => {
      const parent = tempDir();
      const path = join(parent, "held");
      mkdirSync(path);
      chmodSync(parent, 0o555);

      const { session, delta } = await renameTurn(path);

      expect(delta).toBe("renamed=EACCES");
      expect(existsSync(path)).toBe(true);
      expect(existsSync(`${path}.moved`)).toBe(false);
      await closeSession(session);
    },
  );

  it("reports the actual errno for a path that does not exist", async () => {
    const path = join(tempDir(), "absent");

    const { session, delta } = await renameTurn(path);

    expect(delta).toBe("renamed=ENOENT");
    expect(existsSync(`${path}.moved`)).toBe(false);
    await closeSession(session);
  });
});
