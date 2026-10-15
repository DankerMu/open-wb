/**
 * Issue #910 slice 2b (task 2.5): the delta coalescer on the real chain — official omp v18.0.10,
 * the model proxy and the controlled upstream's `WORKBUDDY_PACE` answering round (three reasoning
 * parts, then 40 `字` content chunks 25 ms apart), in `openProxiedApp`, the production sessions
 * assembly on the system clock. Asserted is omp-test-harness「官方 omp 上的合并取证」for
 * `text.delta` and `thinking.delta`: fewer than 40 text events, the first exactly one `字` (the
 * leading edge does not wait 250 ms), both concatenations verbatim; slice 3b adds exactly one
 * `thinking.end`, before the first `text.delta` (omp's raw `thinking_end` closes the span); slice 3c
 * adds the done snapshot: the assistant's `thinkingMs` a non-negative integer (the published
 * `thinking.end` value), the user's null. No upper bound on the count: it depends on how the 40
 * chunks spread under load (design D9).
 *
 * The case prints one `[delta-coalescing] ` line (text.delta count, first-to-last publication span,
 * turn time, omp's own text_delta frame count; shown with `--reporter=verbose`), quoted as 实测.
 * The fake upstream's first request is the bash tool round (default `toolRoundScope`), which the
 * world denies; the paced answer is the second request.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-delta-coalescing.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedApp, runAppTurn } from "./support/omp-official-proxied.js";

const CASE = { timeout: 120_000 };
/** omp-test-harness「受控上游节奏与闸门停点标记」literals, copied. */
const PACED_TEXT = "字".repeat(40);
const THOUGHT = "先读需求，再列要点，最后作答。";

function textDeltaFrames(frames: readonly OmpFrame[]): number {
  return frames.filter((frame) => {
    const update = frame.assistantMessageEvent as { type?: unknown } | undefined;
    return frame.type === "message_update" && update?.type === "text_delta";
  }).length;
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: coalesced deltas`, () => {
  it("40 paced 字 chunks publish fewer than 40 text.delta, the first one 字", CASE, async () => {
    const world = await openProxiedApp();
    const turn = await runAppTurn(world, "你好 WORKBUDDY_PACE");
    expect(turn.events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
    expect(world.faults).toEqual([]);

    const published = world.events.filter((entry) => entry.sessionId === turn.session);
    const texts = published.filter((entry) => entry.event.type === "text.delta");
    const delta = (entry: (typeof published)[number]) =>
      entry.event.type === "text.delta" || entry.event.type === "thinking.delta"
        ? entry.event.data.delta
        : "";
    const thinking = published.filter((entry) => entry.event.type === "thinking.delta");
    const frames = textDeltaFrames(turn.frames);
    console.log(
      `[delta-coalescing] ${JSON.stringify({
        textDeltas: texts.length,
        spanMs: (texts.at(-1)?.at ?? 0) - (texts[0]?.at ?? 0),
        turnMs: turn.ms,
        ompTextFrames: frames,
        thinkingDeltas: thinking.length,
        thinkingEnds: published.flatMap(({ event }) =>
          event.type === "thinking.end" ? [event.data.thinkingMs] : [],
        ),
        cuts: texts.map((entry) => [...delta(entry)].length),
      })}`,
    );

    // omp itself delivers one frame per upstream chunk, so the merging is the coalescer's.
    expect(frames).toBe(40);
    expect(texts.map(delta).join("")).toBe(PACED_TEXT);
    expect(texts.length).toBeLessThan(40);
    expect(delta(texts[0] as (typeof published)[number])).toBe("字");
    expect(thinking.map(delta).join("")).toBe(THOUGHT);
    const types = published.map((entry) => entry.event.type);
    expect(types.filter((type) => type === "thinking.end")).toHaveLength(1);
    expect(types.indexOf("thinking.end")).toBeGreaterThan(types.lastIndexOf("thinking.delta"));
    expect(types.indexOf("thinking.end")).toBeLessThan(types.indexOf("text.delta"));

    const history = await world.app.inject({
      method: "GET",
      url: `/api/sessions/${turn.session}/messages`,
      headers: { cookie: world.cookie },
    });
    expect(history.statusCode).toBe(200);
    const { messages } = history.json() as {
      messages: Array<{ role: string; thinkingMs: unknown }>;
    };
    const [end] = published.flatMap(({ event }) => (event.type === "thinking.end" ? [event] : []));
    const answer = messages.find((message) => message.role === "assistant");
    expect(Number.isSafeInteger(answer?.thinkingMs) && Number(answer?.thinkingMs) >= 0).toBe(true);
    expect(answer?.thinkingMs).toBe(end?.data.thinkingMs);
    expect(messages.filter((message) => message.role === "user").map((m) => m.thinkingMs)).toEqual([
      null,
    ]);
  });
});
