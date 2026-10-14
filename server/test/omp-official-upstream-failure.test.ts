/**
 * Issue #909 (tasks 1.6, 1.7): what the official omp v18.0.10 binary does with the model proxy's
 * failure answers, in the proxied world of support/omp-official-proxied.ts. The upstream request
 * count is the fake upstream's record (`requests()`) or the stalled listener's accept count; the
 * frames are omp's own. Design D7 rests on these cases: none of the three 424 answers
 * (`no_response`, `no_connect`, `gateway_504`) may make omp retry — if one does, the envelope
 * design is reopened, not worked around here.
 *
 * Every case prints one `[upstream-failure] ` line (elapsed time, request count, frame types, the
 * final `errorMessage`), which is what the PR quotes as 实测.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-upstream-failure.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedWorld, type ProxiedWorld } from "./support/omp-official-proxied.js";

const CASE = { timeout: 120_000 };
/** omp's spelling of an assistant failure: the end of a turn's last assistant message. */
interface AssistantEnd {
  stopReason?: unknown;
  errorStatus?: unknown;
  errorMessage?: unknown;
}

interface Turn {
  frames: OmpFrame[];
  ms: number;
}

/** Runs one prompt to its terminal frame, or until `stopAt` matches (the turn is then abandoned). */
async function runTurn(
  world: ProxiedWorld,
  text: string,
  stopAt?: (frame: OmpFrame) => boolean,
): Promise<Turn> {
  const startedAt = Date.now();
  const frames: OmpFrame[] = [];
  for await (const frame of world.runtime.prompt(text)) {
    frames.push(frame);
    if (stopAt?.(frame) === true) {
      break;
    }
  }
  return { frames, ms: Date.now() - startedAt };
}

function lastAssistantEnd(frames: readonly OmpFrame[]): AssistantEnd {
  const ends = frames
    .filter((frame) => frame.type === "message_end")
    .map((frame) => frame.message as { role?: unknown } & AssistantEnd)
    .filter((message) => message?.role === "assistant");
  const last = ends.at(-1);
  if (last === undefined) {
    throw new Error("the turn has no assistant message_end");
  }
  return last;
}

function retryStarts(frames: readonly OmpFrame[]): OmpFrame[] {
  return frames.filter((frame) => frame.type === "auto_retry_start");
}

/** Stops a turn at omp's first session-level retry: one retry is already the failure. */
const AT_RETRY = (frame: OmpFrame): boolean => frame.type === "auto_retry_start";

/** The case's 实测 line: elapsed time, request count, frame types and the last `errorMessage`. */
function note(label: string, turn: Turn, requests: number): void {
  const types = turn.frames
    .map((frame) => frame.type)
    .filter((type) => type !== "message_update" && type !== "text_delta");
  const errorMessage = turn.frames
    .map((frame) => (frame.type === "message_end" ? frame.message : frame))
    .map((value) => (value as { errorMessage?: unknown }).errorMessage)
    .filter((value) => value !== undefined)
    .at(-1);
  console.log(
    `[upstream-failure] ${JSON.stringify({ case: label, ms: turn.ms, requests, types, errorMessage })}`,
  );
}

/** A failed turn ended by omp: an assistant error, then the terminal `agent_end`. */
function expectFailedTurn(turn: Turn): AssistantEnd {
  const end = lastAssistantEnd(turn.frames);
  expect(end.stopReason).toBe("error");
  expect(turn.frames.at(-1)?.type).toBe("agent_end");
  return end;
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} through the model proxy`, () => {
  it("completes an unmarked prompt through the proxy as done", CASE, async () => {
    const world = await openProxiedWorld();
    const turn = await runTurn(world, "你好");
    const end = lastAssistantEnd(turn.frames);
    note("done", turn, world.upstream.requests().length);
    expect(end.stopReason).toBe("stop");
    expect(turn.frames.at(-1)?.type).toBe("agent_end");
    expect(world.upstream.requests().length).toBeGreaterThanOrEqual(2);
  });

  it("(a) an upstream 401 fails after exactly one upstream request", CASE, async () => {
    const world = await openProxiedWorld();
    const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_STATUS=401");
    const end = expectFailedTurn(turn);
    note("a-401", turn, world.upstream.requests().length);
    expect(end.errorStatus).toBe(401);
    expect(world.upstream.requests()).toHaveLength(1);
  });

  it(
    "(b) no response headers within the first-byte deadline: one request, no retry, no_response",
    CASE,
    async () => {
      const world = await openProxiedWorld({ firstByteDeadlineMs: 3_000 });
      const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_HANG", AT_RETRY);
      note("b-hang", turn, world.upstream.requests().length);
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.upstream.requests()).toHaveLength(1);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=no_response\)$/u);
    },
  );

  it(
    "(c) an upstream 503 reaches omp's first session retry as the status.503 summary",
    CASE,
    async () => {
      const world = await openProxiedWorld();
      const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_STATUS=503", AT_RETRY);
      const [retry] = retryStarts(turn.frames);
      note("c-503", turn, world.upstream.requests().length);
      expect(retry).toBeDefined();
      const message = String(retry?.errorMessage);
      expect(message.split("\n")[0]).toMatch(/^502 模型服务返回 HTTP 503：/u);
      expect(message).toMatch(/\(type=wb_upstream param=status\.503\)$/u);
    },
  );

  it(
    "(d) a stalled TLS handshake past the connection deadline: one connection, no retry, no_connect",
    CASE,
    async () => {
      const world = await openProxiedWorld({
        target: "stalled-handshake",
        connectDeadlineMs: 1_000,
      });
      const turn = await runTurn(world, "你好", AT_RETRY);
      note("d-no-connect", turn, world.stalled.accepted());
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.stalled.accepted()).toBe(1);
      expect(world.upstream.requests()).toHaveLength(0);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=no_connect\)$/u);
    },
  );

  it(
    "(e) an upstream 504 after 2s: one request, no retry, gateway_504 without the upstream body",
    CASE,
    async () => {
      const world = await openProxiedWorld();
      const turn = await runTurn(
        world,
        "你好 WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_BODY=text WORKBUDDY_FAKE_DELAY=2000",
        AT_RETRY,
      );
      note("e-gateway-504", turn, world.upstream.requests().length);
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.upstream.requests()).toHaveLength(1);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=gateway_504\)$/u);
      expect(String(end.errorMessage)).not.toContain("Gateway");
    },
  );
});
