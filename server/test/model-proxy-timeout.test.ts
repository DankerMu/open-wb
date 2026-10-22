import { afterEach, describe, expect, it } from "vitest";
import {
  API_KEY,
  createGate,
  expectHeldSseCompletion,
  expectPendingDuring,
  liveTokenTable,
  postCompletions,
  proxyModels,
  readRest,
  readUntilPrefix,
  startHeldSse,
  startRecordingUpstream,
  tokensFrom,
  useResources,
  waitFor,
  waitForUpstream,
  withListeningProxy,
} from "./model-proxy-helpers.js";
import { startStalledHandshake } from "./support/stalled-handshake.js";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const FIRST = Buffer.from("data: first\n\n");
const REST = Buffer.from("data: second\n\ndata: [DONE]\n\n");
// #909: the deadlines are injected (production keeps 10000 / 120000), so no case waits 10 s.
const INJECTED_DEADLINE_MS = 300;
const HOLD_PAST_DEADLINE_MS = INJECTED_DEADLINE_MS + 250;
const FETCH_WATCHDOG_MS = INJECTED_DEADLINE_MS + 2_500;
const CASE_TIMEOUT_MS = 10_000;
const NO_CONNECT =
  '{"error":{"message":"模型服务在 10 秒内没有建立连接","type":"wb_upstream","param":"no_connect"}}';

function configured(baseUrl: string, firstByteDeadlineMs?: number) {
  return {
    tokens: tokensFrom(liveTokenTable()),
    models: proxyModels({ baseUrl, apiKey: API_KEY }),
    connectDeadlineMs: INJECTED_DEADLINE_MS,
    ...(firstByteDeadlineMs === undefined ? {} : { firstByteDeadlineMs }),
  };
}

describe("connection-establishment deadline", () => {
  it(
    "Slow failures answer 424: a stalled TLS handshake past connectDeadlineMs is no_connect",
    async () => {
      const stalled = resources.track(await startStalledHandshake());
      await withListeningProxy(configured(`https://127.0.0.1:${stalled.port}`), async (origin) => {
        const startedAt = Date.now();
        const pending = postCompletions(origin);
        const response = await waitFor(
          pending,
          FETCH_WATCHDOG_MS,
          "stalled TLS did not produce 424 within the connection deadline",
        );
        const elapsed = Date.now() - startedAt;
        expect(response.status).toBe(424);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
        expect(await response.text()).toBe(NO_CONNECT);
        expect(elapsed).toBeGreaterThanOrEqual(INJECTED_DEADLINE_MS - 50);
        // The stalled socket is released and no second connection is made.
        await waitFor(
          (async () => {
            while (stalled.released() < 1) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          })(),
          2_000,
          "the stalled socket was not released",
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(stalled.accepted()).toBe(1);
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "does not 502 or 424 an established transport whose headers arrive after the connection deadline",
    async () => {
      const arrived = createGate();
      const release = createGate();
      const upstream = resources.track(
        await startRecordingUpstream(async ({ response }) => {
          arrived.resolve();
          await release.promise;
          response.writeHead(202, { "content-type": "application/octet-stream" });
          response.end("delayed-ok");
        }),
      );
      await withListeningProxy(configured(`${upstream.origin}/v1`, 5_000), async (origin) => {
        try {
          const pending = postCompletions(origin, {
            body: '{"model":"m1","mode":"delayed-headers"}',
          });
          await waitForUpstream(arrived.promise, pending, "delayed headers");
          await expectPendingDuring(
            Date.now(),
            HOLD_PAST_DEADLINE_MS,
            pending,
            "connection timer cancelled established delayed headers",
          );
          release.resolve();
          const response = await waitFor(
            pending,
            3_000,
            "delayed headers never arrived after release",
          );
          expect(response.status).toBe(202);
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(await response.text()).toBe("delayed-ok");
        } finally {
          release.resolve();
        }
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "keeps a healthy established SSE open past both deadlines",
    async () => {
      const held = resources.track(await startHeldSse(FIRST, REST));
      await withListeningProxy(
        configured(`${held.origin}/v1`, INJECTED_DEADLINE_MS),
        async (origin) => {
          try {
            const response = await waitFor(
              postCompletions(origin, { body: '{"model":"m1","mode":"long-sse"}' }),
              3_000,
              "healthy stream never committed headers",
            );
            expect(response.status).toBe(200);
            const reader = response.body?.getReader();
            if (reader === undefined) {
              throw new Error("response has no body");
            }
            const first = await waitFor(
              readUntilPrefix(reader, FIRST),
              3_000,
              "healthy stream never emitted the first bytes",
            );
            const restPending = readRest(reader);
            await expectPendingDuring(
              Date.now(),
              HOLD_PAST_DEADLINE_MS,
              restPending,
              "connection timer cut a healthy established stream",
            );
            expect(held.didFinish()).toBe(false);
            expect(response.headers.get("cache-control")).toBe("no-store");
            held.release.resolve();
            const rest = await waitFor(
              restPending,
              3_000,
              "healthy stream never continued after release",
            );
            expectHeldSseCompletion(first, rest, FIRST, REST, held.didFinish);
          } finally {
            held.release.resolve();
          }
        },
      );
    },
    CASE_TIMEOUT_MS,
  );
});
