/**
 * Issue #909: 3.2, an upstream 503 every time — one capped session retry, then failed, first model only.
 * Shared helpers, the case map and the local run command: support/omp-official-upstream.ts.
 */
import { describe, expect, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedApp, runAppTurn } from "./support/omp-official-proxied.js";
import {
  BEYOND_CAP,
  CAPPED,
  expectOneCappedRetry,
  lastAssistantEnd,
  messagesOf,
  note,
  publishedError,
  publishedTypes,
  retryStarts,
  storedError,
} from "./support/omp-official-upstream.js";

describe.skipIf(OMP_TEST_OFF)(`official omp v${OMP_VERSION} through the model proxy`, () => {
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
});
