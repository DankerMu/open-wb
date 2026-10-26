/**
 * Issue #909 (tasks 1.6, 1.7, 3.2): what official omp v18.12.3 does with the model proxy's
 * failure answers, in the proxied world of support/omp-official-proxied.ts. The upstream request
 * count is the fake upstream's record (`requests()`) or the stalled listener's accept count; the
 * frames are omp's own. Design D7 rests on these cases: none of the three 424 answers
 * (`no_response`, `no_connect`, `gateway_504`) may make omp retry — if one does, the envelope
 * design is reopened, not worked around here.
 *
 * Every case prints one `[upstream-failure] ` line (elapsed time, request count, per-request
 * `messages` count, frame types, the final `errorMessage`; shown for passing cases with
 * `--reporter=verbose`), quoted as 实测.
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
 *     npx vitest run test/omp-official-upstream-failure.test.ts --coverage=false
 * Without `WORKBUDDY_OMP_TEST=1` the file is skipped (also under `make test`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OmpFrame } from "../src/sessions/omp/frame.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import {
  type AppTurn,
  openAppSession,
  openProxiedApp,
  openProxiedWorld,
  PROXIED_MODELS,
  type ProxiedWorld,
  publishedOf,
  runAppTurn,
  until,
} from "./support/omp-official-proxied.js";

const CASE = { timeout: 120_000 };
/** turn-control's `OMP_ABORT_GRACE_MS` (a spec constant, copied). */
const ABORT_GRACE_MS = 8_000;
/**
 * One round of omp's transport and provider retries (design D2, 实测): 6 HTTP attempts
 * (v18.12.3 `ai/src/utils/openai-http.ts:33`), replayed once by the provider layer.
 */
const ROUND_REQUESTS = 12;
/** A first round takes about 32 s (实测); twice that is the wait for its `turn.retry`. */
const FIRST_ROUND_BOUND_MS = 64_000;
/** The fake upstream's reply parts (support/fake-upstream.mjs `REPLY_PARTS`), copied. */
const FAKE_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
/** Two rounds of omp's transport and provider retries (about a minute) and the turn's close. */
const CAPPED = { timeout: 180_000 };
/**
 * omp-runtime「会话级重试封顶一轮（真实 omp）」: two rounds are 24 upstream requests (v18.12.3 first run
 * 2026-10-20, #1570: the same count as under the previous pin).
 */
const UPSTREAM_REQUESTS = 24;
/** The overlay's `retry.baseDelayMs` (omp-runtime「宿主 overlay」). */
const OVERLAY_BASE_DELAY_MS = 500;
/**
 * omp-runtime「会话级重试封顶一轮（真实 omp）」: a session-cwd project layer that would lengthen
 * the retries and switch to the second whitelisted model of the same provider.
 */
const PROJECT_RETRY = [
  "retry:",
  "  maxRetries: 10",
  "  baseDelayMs: 3600000",
  "  modelFallback: true",
  "  fallbackChains:",
  "    default:",
  `      - workbuddy/${PROXIED_MODELS[1]}`,
  "",
].join("\n");
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

/**
 * Stops a turn past the overlay's cap — a second session retry, or a retry delay no test sits
 * through — so a widened cap fails on the assertions instead of on the case timeout.
 */
const BEYOND_CAP = (frame: OmpFrame): boolean =>
  frame.type === "auto_retry_start" && (frame.attempt !== 1 || Number(frame.delayMs) >= 60_000);

/**
 * The capped shape: exactly one `auto_retry_start` (attempt 1 of 1) waiting at most the overlay's
 * `baseDelayMs`, one `auto_retry_end` that failed, the terminal `agent_end` last; the upstream saw
 * two rounds of the first model only. omp v18.12.3 waits `baseDelayMs` less up to 25 % jitter
 * before the first retry and caps any base at 8 s (`retry-fallback-chains.ts:84-92`), so a project
 * base of an hour shows as a delay above 500, not as an hour.
 */
function expectOneCappedRetry(turn: Turn, world: { upstream: FakeUpstreamServer }): void {
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
function messagesOf(upstream: FakeUpstreamServer): number[] {
  return upstream.requests().map((request) => request.messages);
}

/**
 * The case's 实测 line: elapsed time, request count, per-request `messages` count (when given),
 * frame types and the last `errorMessage`.
 */
function note(label: string, turn: Turn, requests: number, messages?: number[]): void {
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
function expectFailedTurn(turn: Turn): AssistantEnd {
  const end = lastAssistantEnd(turn.frames);
  expect(end.stopReason).toBe("error");
  expect(turn.frames.at(-1)?.type).toBe("agent_end");
  return end;
}

function publishedTypes(turn: AppTurn): string[] {
  return turn.events.map((event) => event.type);
}

/** The published `error`'s classification (upstream-failure「失败的公开形状」). */
interface PublishedFailure {
  message: string;
  reason: string;
  status: number | null;
  detail: string;
}

/**
 * The browser's side of a failed turn: exactly one `error` with the five keys right before
 * `turn.end failed`; returns it without `messageId`.
 */
function publishedError(turn: AppTurn): PublishedFailure {
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
function storedError(db: DatabaseSync, session: string) {
  return db
    .prepare(
      "SELECT error_reason, error_status, error_detail FROM chat_messages WHERE session_id = ? AND role = 'assistant'",
    )
    .get(session) as { error_reason: unknown; error_status: unknown; error_detail: unknown };
}

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} through the model proxy`, () => {
  it("completes an unmarked prompt through the proxy as done", CASE, async () => {
    const world = await openProxiedWorld();
    const turn = await runTurn(world, "你好");
    const end = lastAssistantEnd(turn.frames);
    note("done", turn, world.upstream.requests().length, messagesOf(world.upstream));
    expect(end.stopReason).toBe("stop");
    expect(turn.frames.at(-1)?.type).toBe("agent_end");
    expect(world.upstream.requests().length).toBeGreaterThanOrEqual(2);
  });

  it("(a) an upstream 401 fails after exactly one upstream request", CASE, async () => {
    const world = await openProxiedApp();
    const turn = await runAppTurn(world, "你好 WORKBUDDY_FAKE_STATUS=401");
    const end = expectFailedTurn(turn);
    note("a-401", turn, world.upstream.requests().length, messagesOf(world.upstream));
    expect(end.errorStatus).toBe(401);
    expect(world.upstream.requests()).toHaveLength(1);
    // 5.5 (sentence and status as separate keys since group 7).
    expect(publishedError(turn)).toMatchObject({
      message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
      status: 401,
    });
  });

  it(
    "(b) no response headers within the first-byte deadline: one request, no retry, no_response",
    CASE,
    async () => {
      const world = await openProxiedWorld({ firstByteDeadlineMs: 3_000 });
      const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_HANG", AT_RETRY);
      note("b-hang", turn, world.upstream.requests().length, messagesOf(world.upstream));
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.upstream.requests()).toHaveLength(1);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=no_response\)$/u);
    },
  );

  it(
    "3.2 an upstream 503 every time: one capped session retry, then failed, first model only",
    CAPPED,
    async () => {
      const world = await openProxiedApp();
      const turn = await runAppTurn(world, "你好 WORKBUDDY_FAKE_STATUS=503", BEYOND_CAP);
      note("cap-503", turn, world.upstream.requests().length, messagesOf(world.upstream));
      expectOneCappedRetry(turn, world);
      // The proxy's summary is what omp retried on and what it failed with (1.7(c) folded in here).
      const [retry] = retryStarts(turn.frames);
      const message = String(retry?.errorMessage);
      expect(message.split("\n")[0]).toMatch(/^502 模型服务返回 HTTP 503：/u);
      expect(message).toMatch(/\(type=wb_upstream param=status\.503\)$/u);
      const end = lastAssistantEnd(turn.frames);
      expect(end.errorStatus).toBe(502);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=status\.503\)$/u);
      // 4.3: one turn.retry published for the one omp retry; 5.5: the sentence and one log record.
      expect(publishedTypes(turn).filter((type) => type === "turn.retry")).toHaveLength(1);
      const failure = publishedError(turn);
      expect(failure).toMatchObject({
        message: "上游出错：模型服务内部错误",
        reason: "upstream_error",
        status: 503,
      });
      // 6.5: the three columns were stored, with the same sanitised detail as the event.
      const stored = storedError(world.db, turn.session);
      expect(stored).toMatchObject({ error_reason: "upstream_error", error_status: 503 });
      expect(String(stored.error_detail)).toContain("模型服务返回 HTTP 503");
      expect(stored.error_detail).toBe(failure.detail);
      expect(world.log).toEqual([
        {
          event: "upstream_failed",
          sessionId: turn.session,
          reason: "upstream_error",
          status: 503,
        },
      ]);
    },
  );

  it(
    "3.2 a project layer asking for ten slow retries and a fallback model changes nothing",
    CAPPED,
    async () => {
      const world = await openProxiedWorld();
      mkdirSync(join(world.workspaceRoot, ".omp"));
      writeFileSync(join(world.workspaceRoot, ".omp", "config.yml"), PROJECT_RETRY);
      const turn = await runTurn(world, "你好 WORKBUDDY_FAKE_STATUS=503", BEYOND_CAP);
      note(
        "cap-503-project-layer",
        turn,
        world.upstream.requests().length,
        messagesOf(world.upstream),
      );
      expectOneCappedRetry(turn, world);
    },
  );

  it(
    "(d) a stalled TLS handshake past the connection deadline: one connection, no retry, no_connect",
    CASE,
    async () => {
      const world = await openProxiedApp({
        target: "stalled-handshake",
        connectDeadlineMs: 1_000,
      });
      const turn = await runAppTurn(world, "你好", AT_RETRY);
      note("d-no-connect", turn, world.stalled.accepted());
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.stalled.accepted()).toBe(1);
      expect(world.upstream.requests()).toHaveLength(0);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=no_connect\)$/u);
      // 5.5: the sentence, without a status.
      expect(publishedError(turn)).toMatchObject({
        message: "上游不可达：无法连接模型服务",
        status: null,
      });
    },
  );

  it(
    "(e) an upstream 504 after 2s: one request, no retry, gateway_504 without the upstream body",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const turn = await runAppTurn(
        world,
        "你好 WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_BODY=text WORKBUDDY_FAKE_DELAY=2000",
        AT_RETRY,
      );
      note("e-gateway-504", turn, world.upstream.requests().length, messagesOf(world.upstream));
      expect(retryStarts(turn.frames)).toEqual([]);
      expect(world.upstream.requests()).toHaveLength(1);
      const end = expectFailedTurn(turn);
      expect(end.errorStatus).toBe(424);
      expect(String(end.errorMessage)).toMatch(/\(type=wb_upstream param=gateway_504\)$/u);
      expect(String(end.errorMessage)).not.toContain("Gateway");
      // 5.5: the sentence with the gateway's status.
      expect(publishedError(turn)).toMatchObject({
        message: "上游超时：模型服务没有及时响应",
        status: 504,
      });
    },
  );

  it(
    "6.5 an upstream 400 with an empty body: request_rejected, 400, the dump path line not stored",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const turn = await runAppTurn(
        world,
        "你好 WORKBUDDY_FAKE_STATUS=400 WORKBUDDY_FAKE_BODY=empty",
      );
      const end = expectFailedTurn(turn);
      note("6.5-400-empty", turn, world.upstream.requests().length, messagesOf(world.upstream));
      expect(world.upstream.requests()).toHaveLength(1);
      expect(end.errorStatus).toBe(400);
      // omp appends its request dump path (design Context, case 12 实测); the column must not keep it.
      expect(String(end.errorMessage)).toContain("raw-http-request=");
      const stored = storedError(world.db, turn.session);
      console.log(
        `[upstream-failure] ${JSON.stringify({ case: "6.5-400-empty-stored", errorMessage: end.errorMessage, stored })}`,
      );
      expect(stored).toMatchObject({ error_reason: "request_rejected", error_status: 400 });
      expect(String(stored.error_detail)).not.toContain("raw-http-request=");
      expect(publishedError(turn)).toMatchObject({
        reason: "request_rejected",
        status: 400,
        detail: stored.error_detail,
      });
    },
  );

  it(
    "4.4(a) twelve 503s then success: one turn.retry, done, the fake upstream's tool round and reply",
    CAPPED,
    async () => {
      const world = await openProxiedApp();
      const turn = await runAppTurn(
        world,
        "你好 WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=12",
        BEYOND_CAP,
      );
      note("retry-then-done", turn, world.upstream.requests().length, messagesOf(world.upstream));
      expect(retryStarts(turn.frames)).toHaveLength(1);
      expect(publishedTypes(turn).filter((type) => type === "turn.start")).toHaveLength(1);
      expect(publishedTypes(turn).filter((type) => type === "turn.retry")).toHaveLength(1);
      expect(publishedTypes(turn)).not.toContain("error");
      expect(turn.events.at(-1)).toMatchObject({ type: "turn.end", data: { status: "done" } });
      expect(world.denied).toHaveLength(1);
      const snapshot = await world.app.inject({
        method: "GET",
        url: `/api/sessions/${turn.session}/messages`,
        headers: { cookie: world.cookie },
      });
      const assistant = (
        snapshot.json() as {
          messages: Array<{ status: string; content: string; steps: Array<{ name: string }> }>;
        }
      ).messages[1];
      expect(assistant?.status).toBe("done");
      expect(assistant?.content).toBe(FAKE_REPLY);
      expect(assistant?.steps.map((step) => step.name)).toEqual(["bash"]);
      expect(world.log).toEqual([]);
      expect(world.faults).toEqual([]);
    },
  );

  it(
    "4.4(b) stop during the retry backoff: 202, one turn.end stopped within the grace, no error",
    CASE,
    async () => {
      const world = await openProxiedApp();
      const session = await openAppSession(world);
      const startedAt = Date.now();
      const prompted = await world.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/prompt`,
        headers: { "content-type": "application/json", cookie: world.cookie },
        payload: JSON.stringify({ message: "你好 WORKBUDDY_FAKE_STATUS=503" }),
      });
      expect(prompted.statusCode).toBe(202);
      await until(
        () => publishedOf(world, session).some((event) => event.type === "turn.retry"),
        "turn.retry",
        FIRST_ROUND_BOUND_MS,
      );
      const stoppedAt = Date.now();
      const atStop = world.frames.length;
      const stop = await world.app.inject({
        method: "POST",
        url: `/api/sessions/${session}/stop`,
        headers: { cookie: world.cookie },
      });
      expect(stop.statusCode).toBe(202);
      expect(stop.json()).toEqual({});
      await until(
        () => publishedOf(world, session).some((event) => event.type === "turn.end"),
        "turn.end after stop",
        ABORT_GRACE_MS + 4_000,
      );
      const closedMs = Date.now() - stoppedAt;
      const after = world.frames.slice(atStop);
      // 实测 line: which way the turn closed (omp's own agent_end, or the bounded fallback).
      console.log(
        `[upstream-failure] ${JSON.stringify({
          case: "stop-in-backoff",
          ms: Date.now() - startedAt,
          closedMs,
          requests: world.upstream.requests().length,
          messages: messagesOf(world.upstream),
          after: after.map((frame) =>
            frame.type === "auto_retry_end"
              ? `auto_retry_end:${String(frame.finalError)}`
              : frame.type,
          ),
        })}`,
      );
      // The WHEN: the stop landed in the backoff, so omp cancelled the retry itself (a stop in
      // the second round would also end stopped, through an aborted message_end).
      expect(after).toContainEqual(
        expect.objectContaining({ type: "auto_retry_end", finalError: "Retry cancelled" }),
      );
      const events = publishedOf(world, session);
      expect(events.filter((event) => event.type === "turn.retry")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "turn.end")).toEqual([
        { type: "turn.end", data: { messageId: expect.any(Number), status: "stopped" } },
      ]);
      expect(closedMs).toBeLessThanOrEqual(ABORT_GRACE_MS);
      // No full second round went out (12 requests in every local run, the 实测 line above).
      expect(world.upstream.requests().length).toBeLessThan(2 * ROUND_REQUESTS);
      const snapshot = await world.app.inject({
        method: "GET",
        url: `/api/sessions/${session}/messages`,
        headers: { cookie: world.cookie },
      });
      const body = snapshot.json() as {
        session: { status: string };
        messages: Array<{ status: string }>;
      };
      expect(body.session.status).toBe("stopped");
      expect(body.messages[1]?.status).toBe("stopped");
      // turn-control「重试退避中停止（真实 omp）」: a stopped turn stores no error columns.
      expect(storedError(world.db, session)).toEqual({
        error_reason: null,
        error_status: null,
        error_detail: null,
      });
      expect(world.log).toEqual([]);
    },
  );
});
