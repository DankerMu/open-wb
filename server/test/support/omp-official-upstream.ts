/**
 * Shared cases of the omp-official-upstream-* files (Issue #909 tasks 1.6, 1.7, 3.2, 4.4, 5.5, 6.5):
 * what official omp v18.12.3 does with the model proxy's failure answers, in the proxied world of
 * support/omp-official-proxied.ts. The upstream request count is the fake upstream's record
 * (`requests()`) or the stalled listener's accept count; the frames are omp's own. Design D7 rests on
 * these cases: none of the three 424 answers (`no_response`, `no_connect`, `gateway_504`) may make omp
 * retry — if one does, the envelope design is reopened, not worked around here.
 *
 * The cases sit in four files so the uid-isolation job's worker pool runs the three minute-long ones
 * side by side (#1979): `omp-official-upstream-failure` (the fast failures), `-cap` and
 * `-cap-project` (3.2, about 65 s each), `-retry` (4.4, about 33 s each). Every case prints one
 * `[upstream-failure] ` line (elapsed time, request count, per-request `messages` count, frame types,
 * the final `errorMessage`; shown for passing cases with `--reporter=verbose`), quoted as 实测.
 *
 * Tasks 4.4 and 5.5 run the cases that assert what the browser sees (the published events, the
 * sessions `log` port, the stop route) in `openProxiedApp`, the production sessions assembly over
 * the same proxy; the omp frames there are a tee of the child's stdout. 5.5 adds no 503 run: its
 * assertions ride on 3.2's first case, (a), (d) and (e). Group 6 (6.5) adds none either: the three
 * stored error columns ride on 3.2's first case and 4.4(b), plus one new 400 case of about 2 s.
 * Since group 7 the published `error` carries five keys and the sentence without `（HTTP s）`.
 *
 * Run locally: `make omp-fetch`, then in `server/`
 *   WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/../var/omp/omp" \
 *     npx vitest run test/omp-official-upstream-*.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the files are skipped (also under `make test`).
 */
import type { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import type { OmpFrame } from "../../src/sessions/omp/frame.js";
import type { FakeUpstreamServer } from "./fake-upstream.mjs";
import { type AppTurn, PROXIED_MODELS, type ProxiedWorld } from "./omp-official-proxied.js";

export const CASE = { timeout: 120_000 };
/** Two rounds of omp's transport and provider retries (about a minute) and the turn's close. */
export const CAPPED = { timeout: 180_000 };
/**
 * omp-runtime「会话级重试封顶一轮（真实 omp）」: two rounds are 24 upstream requests (v18.12.3 first run
 * 2026-10-20, #1570: the same count as under the previous pin).
 */
const UPSTREAM_REQUESTS = 24;
/** The overlay's `retry.baseDelayMs` (omp-runtime「宿主 overlay」). */
const OVERLAY_BASE_DELAY_MS = 500;
/** omp's spelling of an assistant failure: the end of a turn's last assistant message. */
export interface AssistantEnd {
  stopReason?: unknown;
  errorStatus?: unknown;
  errorMessage?: unknown;
}

export interface Turn {
  frames: OmpFrame[];
  ms: number;
}

/** Runs one prompt to its terminal frame, or until `stopAt` matches (the turn is then abandoned). */
export async function runTurn(
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

export function lastAssistantEnd(frames: readonly OmpFrame[]): AssistantEnd {
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

export function retryStarts(frames: readonly OmpFrame[]): OmpFrame[] {
  return frames.filter((frame) => frame.type === "auto_retry_start");
}

/** Stops a turn at omp's first session-level retry: one retry is already the failure. */
export const AT_RETRY = (frame: OmpFrame): boolean => frame.type === "auto_retry_start";

/**
 * Stops a turn past the overlay's cap — a second session retry, or a retry delay no test sits
 * through — so a widened cap fails on the assertions instead of on the case timeout.
 */
export const BEYOND_CAP = (frame: OmpFrame): boolean =>
  frame.type === "auto_retry_start" && (frame.attempt !== 1 || Number(frame.delayMs) >= 60_000);

/**
 * The capped shape: exactly one `auto_retry_start` (attempt 1 of 1) waiting at most the overlay's
 * `baseDelayMs`, one `auto_retry_end` that failed, the terminal `agent_end` last; the upstream saw
 * two rounds of the first model only. omp v18.12.3 waits `baseDelayMs` less up to 25 % jitter
 * before the first retry and caps any base at 8 s (`retry-fallback-chains.ts:84-92`), so a project
 * base of an hour shows as a delay above 500, not as an hour.
 */
export function expectOneCappedRetry(turn: Turn, world: { upstream: FakeUpstreamServer }): void {
  const starts = retryStarts(turn.frames).map(({ attempt, maxAttempts }) => ({
    attempt,
    maxAttempts,
  }));
  expect(starts).toEqual([{ attempt: 1, maxAttempts: 1 }]);
  expect(Number(retryStarts(turn.frames)[0]?.delayMs)).toBeLessThanOrEqual(OVERLAY_BASE_DELAY_MS);
  const ends = turn.frames.filter((frame) => frame.type === "auto_retry_end");
  expect(ends.map((frame) => frame.success)).toEqual([false]);
  expectFailedTurn(turn);
  const models = world.upstream.requests().map((request) => request.model);
  expect(models).toEqual(Array<string>(UPSTREAM_REQUESTS).fill(PROXIED_MODELS[0]));
}

/** `messages` length of each upstream request, in arrival order (#1769: shows omp's reminder). */
export function messagesOf(upstream: FakeUpstreamServer): number[] {
  return upstream.requests().map((request) => request.messages);
}

/**
 * The case's 实测 line: elapsed time, request count, per-request `messages` count (when given),
 * frame types and the last `errorMessage`.
 */
export function note(label: string, turn: Turn, requests: number, messages?: number[]): void {
  const types = turn.frames
    .map((frame) => frame.type)
    .filter((type) => type !== "message_update" && type !== "text_delta");
  const errorMessage = turn.frames
    .map((frame) => (frame.type === "message_end" ? frame.message : frame))
    .map((value) => (value as { errorMessage?: unknown }).errorMessage)
    .filter((value) => value !== undefined)
    .at(-1);
  console.log(
    `[upstream-failure] ${JSON.stringify({ case: label, ms: turn.ms, requests, messages, types, errorMessage })}`,
  );
}

/** A failed turn ended by omp: an assistant error, then the terminal `agent_end`. */
export function expectFailedTurn(turn: Turn): AssistantEnd {
  const end = lastAssistantEnd(turn.frames);
  expect(end.stopReason).toBe("error");
  expect(turn.frames.at(-1)?.type).toBe("agent_end");
  return end;
}

export function publishedTypes(turn: AppTurn): string[] {
  return turn.events.map((event) => event.type);
}

/** The published `error`'s classification (upstream-failure「失败的公开形状」). */
export interface PublishedFailure {
  message: string;
  reason: string;
  status: number | null;
  detail: string;
}

/**
 * The browser's side of a failed turn: exactly one `error` with the five keys right before
 * `turn.end failed`; returns it without `messageId`.
 */
export function publishedError(turn: AppTurn): PublishedFailure {
  const errors = turn.events.filter((event) => event.type === "error");
  expect(errors).toHaveLength(1);
  expect(Object.keys(errors[0]?.data ?? {})).toEqual([
    "messageId",
    "message",
    "reason",
    "status",
    "detail",
  ]);
  expect(turn.events.slice(-2).map((event) => event.type)).toEqual(["error", "turn.end"]);
  expect(turn.events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "failed" } });
  const { messageId: _id, ...failure } = (errors[0]?.data ?? {}) as PublishedFailure & {
    messageId: number;
  };
  return failure;
}

/** The three error columns of `session`'s assistant row (#909 group 6, migration 043). */
export function storedError(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT error_reason, error_status, error_detail FROM chat_messages WHERE session_id = ? AND role = 'assistant'",
    )
    .get(session) as { error_reason: unknown; error_status: unknown; error_detail: unknown };
}
