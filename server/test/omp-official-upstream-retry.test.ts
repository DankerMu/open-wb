/**
 * Issue #909: 4.4, a turn the session retry recovers (done), and a stop during the retry backoff (stopped).
 * Shared helpers, the case map and the local run command: support/omp-official-upstream.ts.
 */
import { describe, expect, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import {
  openAppSession,
  openProxiedApp,
  publishedOf,
  runAppTurn,
  until,
} from "./support/omp-official-proxied.js";
import {
  BEYOND_CAP,
  CAPPED,
  CASE,
  messagesOf,
  note,
  publishedTypes,
  retryStarts,
  storedError,
} from "./support/omp-official-upstream.js";

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

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} through the model proxy`, () => {
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
