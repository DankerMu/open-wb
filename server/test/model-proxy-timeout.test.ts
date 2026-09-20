import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  API_KEY,
  CONNECTION_DEADLINE_MS,
  createGate,
  expectFetchEnvelope,
  expectHeldSseCompletion,
  expectPendingDuring,
  liveTokenTable,
  postCompletions,
  readRest,
  readUntilPrefix,
  startHeldSse,
  startRecordingUpstream,
  startStalledHandshake,
  tokensFrom,
  useResources,
  waitFor,
  waitForUpstream,
  withListeningProxy,
} from "./model-proxy-helpers.js";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const FIRST = Buffer.from("data: first\n\n");
const REST = Buffer.from("data: second\n\ndata: [DONE]\n\n");
const HOLD_PAST_DEADLINE_MS = CONNECTION_DEADLINE_MS + 250;
const FETCH_WATCHDOG_MS = CONNECTION_DEADLINE_MS + 2_500;
const CASE_TIMEOUT_MS = CONNECTION_DEADLINE_MS + 8_000;

function configured(baseUrl: string) {
  return {
    tokens: tokensFrom(liveTokenTable()),
    upstream: { baseUrl, apiKey: API_KEY },
  };
}

describe("connection-establishment deadline", () => {
  it(
    "maps a stalled TLS handshake past 10s to 502 and does not wait for headers",
    async () => {
      const stalled = resources.track(await startStalledHandshake());
      await withListeningProxy(configured(`https://127.0.0.1:${stalled.port}`), async (origin) => {
        const startedAt = Date.now();
        const pending = postCompletions(origin);
        const response = await waitFor(
          pending,
          FETCH_WATCHDOG_MS,
          "stalled TLS did not produce 502 within the connection deadline",
        );
        const elapsed = Date.now() - startedAt;
        await expectFetchEnvelope(response, 502, AGENT_UNAVAILABLE_ENVELOPE);
        expect(elapsed).toBeGreaterThanOrEqual(CONNECTION_DEADLINE_MS - 50);
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "does not 502 an established transport whose headers arrive after 10s",
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
      await withListeningProxy(configured(`${upstream.origin}/v1`), async (origin) => {
        try {
          const pending = postCompletions(origin, { body: '{"mode":"delayed-headers"}' });
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
    "keeps a healthy established SSE open past 10s",
    async () => {
      const held = resources.track(await startHeldSse(FIRST, REST));
      await withListeningProxy(configured(`${held.origin}/v1`), async (origin) => {
        try {
          const response = await waitFor(
            postCompletions(origin, { body: '{"mode":"long-sse"}' }),
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
      });
    },
    CASE_TIMEOUT_MS,
  );
});
