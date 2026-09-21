import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OmpProcess } from "../src/sessions/omp/process.js";
import { createRpcHarness } from "./support/omp-rpc.js";

const FAKE = fileURLToPath(new URL("./support/fake-omp.mjs", import.meta.url));
const harness = createRpcHarness();

describe("fake-omp crash-after-deltas fixture", () => {
  it("emits the first two normal deltas then exits before a terminal frame", async () => {
    const opts = harness.tempOpts("wb-issue100-crash-after-deltas", "omp-dispatch-fake-");
    const proc = harness.manage(
      new OmpProcess({
        ...opts,
        bin: FAKE,
        spawnImpl: (command, args, options) =>
          harness.spawnTracked([command, ...args, "--scenario", "crash-after-deltas"], options),
      }),
    );
    const frames = harness.collectFrames(proc);
    const started = proc.start();
    await expect(started).resolves.toEqual({ sessionFile: "/tmp/open-wb-fake-session.jsonl" });
    await proc.send({
      id: "req_crash_after_deltas",
      type: "prompt",
      message: "crash after deltas",
    });
    const exit = await harness.waitExit(proc);
    expect(exit).toEqual({ code: 2, signal: null });
    expect(frames.some((frame) => frame.type === "agent_end" && frame.isTerminal !== false)).toBe(
      false,
    );
    expect(textDeltas(frames)).toEqual(["Hello ", "from "]);
  });
});

function textDeltas(
  frames: readonly { type?: unknown; assistantMessageEvent?: unknown }[],
): string[] {
  const deltas: string[] = [];
  for (const frame of frames) {
    if (frame.type !== "message_update") {
      continue;
    }
    const event =
      frame.assistantMessageEvent !== null && typeof frame.assistantMessageEvent === "object"
        ? (frame.assistantMessageEvent as { type?: unknown; delta?: unknown })
        : undefined;
    if (event?.type === "text_delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    }
  }
  return deltas;
}
