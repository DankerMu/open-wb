/**
 * Issue #909: the failures omp must not retry — 401, no_response, no_connect, gateway_504, an empty 400 — and a done turn.
 * Shared helpers, the case map and the local run command: support/omp-official-upstream.ts.
 */
import { describe, expect, it } from "vitest";
import { OMP_TEST_OFF, OMP_VERSION } from "./support/omp-official.js";
import { openProxiedApp, openProxiedWorld, runAppTurn } from "./support/omp-official-proxied.js";
import {
  AT_RETRY,
  CASE,
  expectFailedTurn,
  lastAssistantEnd,
  messagesOf,
  note,
  publishedError,
  retryStarts,
  runTurn,
  storedError,
} from "./support/omp-official-upstream.js";

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
});
