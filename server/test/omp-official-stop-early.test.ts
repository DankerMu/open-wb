/**
 * Issue #1594 (change omp-stop-early-official): turn-control「派发后极早停止（真实 omp）」— a stop
 * right after the prompt route answered 202, against the official omp v18.12.3 binary in the
 * production sessions assembly of support/omp-official-proxied.ts (`openProxiedApp`).
 *
 * The host's dispatch receipt is the stdin write of the `prompt` frame (`runtime.ts` `#runPrompt`
 * resolves it right after `proc.send`, which only writes), not omp's `response` frame; the prompt
 * route awaits that receipt before its 202, so the stop never takes the stop-intent branch here.
 * `abort()` then either writes the frame at once (the turn already read `agent_start`) or defers it
 * to `agent_start` (`deferAbort`, #650). omp v18.12.3 acknowledges a `prompt` only once the message
 * is admitted (`can1357/oh-my-pi` tag `v18.12.3`, `docs/rpc.md:119`, `:315`), answers every `abort`
 * with `success: true` (`rpc-types.ts:393`) and closes an aborted prompt with a `prompt_result`
 * whose `status` is `aborted` (`docs/rpc.md:336-337`), written one macrotask after `agent_end`
 * (`modes/rpc/rpc-prompt-results.ts:128,152`).
 *
 * The prompt carries `WORKBUDDY_FAKE_HANG`: the fake upstream answers the first model request with
 * neither headers nor body (support/fake-upstream-failures.mjs), and the proxy's first-byte
 * deadline (120 s by default) is far past this case, so the model never answers before the stop.
 *
 * The `[stop-early]` reading: `order` is the first-occurrence sequence of the prompt response
 * (`prompt`), `agent_start`, the abort response (`abort`) and `prompt_result`;
 * `agentStartBeforeStop` is whether `agent_start` was among the frames right before the stop call
 * and right after it returned. The host path is decided when the stop route calls `abort()`,
 * between the two samples: both `false` means `deferAbort`, both `true` the direct write, a
 * mismatch is「边界不定」. First runs (2026-10-21, three of three identical, so pinned as literals,
 * the v18.12.3 regression pin): `order` = prompt, agent_start, abort, prompt_result;
 * `agentStartBeforeStop` = false at both samples, so the stop took the `deferAbort` path; the
 * turn closed 42–44 ms after the stop call with 0 upstream requests (omp aborted before its first
 * model request went out).
 *
 * Run locally (`OMP_BIN` absolute):
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-stop-early.test.ts --coverage=false --reporter=verbose
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import {
  openAppSession,
  openProxiedApp,
  publishedOf,
  until,
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 60_000 };
/** turn-control's `OMP_ABORT_GRACE_MS` (a spec constant, copied). */
const ABORT_GRACE_MS = 8_000;
const TURN_END_BOUND_MS = 12_000;
const PROMPT_RESULT_BOUND_MS = 2_000;
const PROMPT_TEXT = "你好 WORKBUDDY_FAKE_HANG";

/** The four frame kinds of the reading, identified literally. */
const KINDS: Array<[string, (frame: OmpFrame) => boolean]> = [
  ["prompt", (frame) => frame.type === "response" && frame.command === "prompt"],
  ["agent_start", (frame) => frame.type === "agent_start"],
  ["abort", (frame) => frame.type === "response" && frame.command === "abort"],
  ["prompt_result", (frame) => frame.type === "prompt_result"],
];

function firstIndex(frames: readonly OmpFrame[], kind: string): number {
  const match = KINDS.find(([name]) => name === kind);
  return match === undefined ? -1 : frames.findIndex(match[1]);
}

/** The kinds by first occurrence; an absent kind is listed last as `<kind>:absent`. */
function orderOf(frames: readonly OmpFrame[]): string[] {
  const seen = KINDS.map(([name]) => ({ name, at: firstIndex(frames, name) }));
  return [
    ...seen
      .filter((entry) => entry.at !== -1)
      .sort((a, b) => a.at - b.at)
      .map((entry) => entry.name),
    ...seen.filter((entry) => entry.at === -1).map((entry) => `${entry.name}:absent`),
  ];
}

const hasAgentStart = (frames: readonly OmpFrame[]) =>
  frames.some((frame) => frame.type === "agent_start");

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION}: stop right after dispatch`, () => {
  it(
    "stop right after the prompt's 202: one turn.end stopped within the grace, prompt_result aborted",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const session = await openAppSession(world);
      const prompted = await world.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/prompt`,
        headers: { "content-type": "application/json", cookie: world.cookie },
        payload: JSON.stringify({ message: PROMPT_TEXT }),
      });
      expect(prompted.statusCode).toBe(202);
      // No await between the 202 and the stop call: both samples bracket the route's abort().
      const startedBefore = hasAgentStart(world.frames);
      const stoppedAt = Date.now();
      const stop = await world.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/stop`,
        headers: { cookie: world.cookie },
      });
      const startedAfter = hasAgentStart(world.frames);
      expect(stop.statusCode).toBe(202);
      expect(stop.json()).toEqual({});
      await until(
        () => publishedOf(world, session).some((event) => event.type === "turn.end"),
        "turn.end after stop",
        TURN_END_BOUND_MS,
      );
      const closedMs = Date.now() - stoppedAt;
      await until(
        () => world.frames.some((frame) => frame.type === "prompt_result"),
        "prompt_result after turn.end",
        PROMPT_RESULT_BOUND_MS,
      );
      const frames = world.frames;
      const promptResult = frames[firstIndex(frames, "prompt_result")];
      const order = orderOf(frames);
      const agentStartBeforeStop = startedBefore === startedAfter ? startedBefore : "边界不定";
      // 实测 line (shown with --reporter=verbose); quoted in the PR and in runtime.ts / commands.ts.
      console.log(
        `[stop-early] ${JSON.stringify({
          order,
          agentStartBeforeStop,
          samples: [startedBefore, startedAfter],
          promptResultStatus: promptResult?.status,
          closedMs,
          requests: world.upstream.requests().length,
        })}`,
      );

      const events = publishedOf(world, session);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "turn.end")).toEqual([
        { type: "turn.end", data: { messageId: expect.any(Number), status: "stopped" } },
      ]);
      expect(closedMs).toBeLessThan(ABORT_GRACE_MS);
      const snapshot = await world.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/messages`,
        headers: { cookie: world.cookie },
      });
      const body = snapshot.json() as {
        session: { status: string };
        messages: Array<{ role: string; content: string; status: string }>;
      };
      expect(body.session.status).toBe("stopped");
      expect(body.messages[0]).toMatchObject({ role: "user", content: PROMPT_TEXT });
      expect(body.messages[1]?.status).toBe("stopped");

      // omp's side: the prompt closed as aborted under its own id; the abort answered after the start.
      const promptResponse = frames[firstIndex(frames, "prompt")];
      expect(promptResponse?.id).toEqual(expect.any(String));
      expect(promptResult).toMatchObject({ status: "aborted", id: promptResponse?.id });
      const abortAt = firstIndex(frames, "abort");
      expect(frames[abortAt]?.success).toBe(true);
      expect(abortAt).toBeGreaterThan(firstIndex(frames, "agent_start"));
      expect(firstIndex(frames, "agent_start")).toBeGreaterThan(-1);

      // v18.12.3 pin (three identical first runs): omp acknowledged the prompt before agent_start,
      // and the stop landed before agent_start, so the host deferred the abort to it.
      expect(order).toEqual(["prompt", "agent_start", "abort", "prompt_result"]);
      expect([startedBefore, startedAfter]).toEqual([false, false]);
    },
  );
});
