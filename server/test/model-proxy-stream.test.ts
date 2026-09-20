import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  API_KEY,
  createGate,
  createProxyApp,
  expectFetchEnvelope,
  expectHeldSseCompletion,
  LIVE_TOKEN,
  liveTokenTable,
  openIncompleteCompletionUpload,
  postCompletions,
  readRest,
  readUntilError,
  readUntilPrefix,
  startHeldSse,
  startPendingHeaders,
  startRecordingUpstream,
  tokensFrom,
  useResources,
  waitFor,
  waitForUpstream,
  withListeningProxy,
} from "./model-proxy-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const FIRST = Buffer.from("data: first\n\n");
const REST = Buffer.from("data: second\n\ndata: [DONE]\n\n");
const APP_CLOSE_TIMEOUT_MS = 20_000;

function configured(origin: string) {
  return {
    tokens: tokensFrom(liveTokenTable()),
    upstream: { baseUrl: `${origin}/v1`, apiKey: API_KEY },
  };
}

describe("incremental non5xx passthrough", () => {
  it("exposes the first downstream bytes while upstream completion is still held", async () => {
    const held = resources.track(await startHeldSse(FIRST, REST));
    await withListeningProxy(configured(held.origin), async (origin) => {
      try {
        const pending = postCompletions(origin, { body: '{"mode":"stream"}' });
        const response = await waitFor(pending, 3_000, "proxy buffered before exposing headers");
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("content-type")).toMatch(/text\/event-stream/iu);
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("response has no body");
        }
        const first = await waitFor(
          readUntilPrefix(reader, FIRST),
          3_000,
          "no first bytes while upstream completion is held",
        );
        expect(held.didFinish()).toBe(false);
        held.release.resolve();
        const rest = await readRest(reader);
        expectHeldSseCompletion(first, rest, FIRST, REST, held.didFinish);
      } finally {
        held.release.resolve();
      }
    });
  });
});

describe("cancellation and late stream failure", () => {
  it("client abort while headers are pending reclaims the upstream response", async () => {
    const pendingHeaders = resources.track(
      await startPendingHeaders({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: "data: late\n\n",
      }),
    );
    const abort = new AbortController();
    await withListeningProxy(configured(pendingHeaders.origin), async (origin) => {
      try {
        const pending = postCompletions(origin, { signal: abort.signal });
        await waitForUpstream(pendingHeaders.arrived.promise, pending, "pending-header abort");
        abort.abort();
        await expect(pending).rejects.toBeInstanceOf(Error);
        await waitFor(
          pendingHeaders.reclaimed.promise,
          3_000,
          "upstream not reclaimed after client abort",
        );
      } finally {
        abort.abort();
        pendingHeaders.release.resolve();
      }
    });
  });

  it("client abort after the first bytes reclaims the still-open upstream", async () => {
    const release = createGate();
    const reclaimed = createGate();
    const firstWritten = createGate();
    const abort = new AbortController();
    const upstream = resources.track(
      await startRecordingUpstream(async ({ response, reclaimed: closed }) => {
        void closed.then(() => reclaimed.resolve());
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(FIRST);
        firstWritten.resolve();
        await release.promise;
        if (!response.writableEnded) {
          response.end(REST);
        }
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      try {
        const pending = postCompletions(origin, { signal: abort.signal });
        const response = await waitFor(pending, 3_000, "missing streaming headers");
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("response has no body");
        }
        await waitFor(readUntilPrefix(reader, FIRST), 3_000, "missing first streamed bytes");
        await waitFor(firstWritten.promise, 3_000, "upstream did not write the first bytes");
        abort.abort();
        await waitFor(reclaimed.promise, 3_000, "upstream not reclaimed after mid-stream abort");
      } finally {
        abort.abort();
        release.resolve();
      }
    });
  });

  it("late upstream reset terminates the stream without a forged envelope or DONE", async () => {
    const seenFirst = createGate();
    const upstream = resources.track(
      await startRecordingUpstream(async ({ response }) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(FIRST);
        await seenFirst.promise;
        response.destroy();
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      try {
        const response = await waitFor(
          postCompletions(origin, { body: '{"mode":"reset"}' }),
          3_000,
          "missing headers before reset",
        );
        const reader = response.body?.getReader();
        if (reader === undefined) {
          throw new Error("response has no body");
        }
        const first = await waitFor(
          readUntilPrefix(reader, FIRST),
          3_000,
          "missing prefix before reset",
        );
        seenFirst.resolve();
        const { bytes, error } = await readUntilError(reader);
        expect(error).toBeInstanceOf(Error);
        const body = Buffer.concat([first, bytes]);
        expect(body.equals(FIRST)).toBe(true);
        expect(body.toString("utf8")).not.toContain("[DONE]");
        expect(body.toString("utf8")).not.toContain("agent_unavailable");
        expect(body.toString("utf8")).not.toContain(API_KEY);
        expect(body.toString("utf8")).not.toContain(LIVE_TOKEN);
      } finally {
        seenFirst.resolve();
      }
    });
  });

  it(
    "app close while headers are pending settles owned upstream work",
    async () => {
      const pendingHeaders = resources.track(
        await startPendingHeaders({ status: 200, body: "late" }),
      );
      const abort = new AbortController();
      const app = await createProxyApp(configured(pendingHeaders.origin));
      await withListeningApp(app, async (origin) => {
        try {
          const pending = postCompletions(origin, { signal: abort.signal });
          await waitForUpstream(
            pendingHeaders.arrived.promise,
            pending,
            "app close pending headers",
          );
          await waitFor(app.close(), 8_000, "app.close hung while headers were pending");
          await waitFor(
            pendingHeaders.reclaimed.promise,
            3_000,
            "upstream not reclaimed on app.close",
          );
          abort.abort();
          await pending.catch((error: unknown) => {
            expect(error).toBeInstanceOf(Error);
          });
        } finally {
          abort.abort();
          pendingHeaders.release.resolve();
        }
      });
    },
    APP_CLOSE_TIMEOUT_MS,
  );

  it(
    "app close cancels an authenticated incomplete upload during parsing",
    async () => {
      const parsingStarted = createGate();
      const upstream = resources.track(
        await startRecordingUpstream(({ response }) => {
          response.writeHead(500);
          response.end();
        }),
      );
      const app = await createProxyApp(configured(upstream.origin));
      app.addHook("preParsing", (_request, _reply, payload, done) => {
        parsingStarted.resolve();
        done(null, payload);
      });
      await withListeningApp(app, async (origin) => {
        const upload = openIncompleteCompletionUpload(origin);
        let closing: Promise<void> | undefined;
        try {
          await waitFor(upload.written, 3_000, "incomplete upload was not written");
          await waitFor(
            parsingStarted.promise,
            3_000,
            "authenticated upload never reached preParsing",
          );
          closing = app.close();
          await waitFor(closing, 3_000, "app.close left incomplete proxy upload alive");
          await waitFor(upload.closed, 3_000, "incomplete upload client did not settle");
          expect(upstream.requests).toEqual([]);
        } finally {
          upload.destroy();
          await closing;
        }
      });
    },
    APP_CLOSE_TIMEOUT_MS,
  );
  it("connection failure before headers is a sanitized 502", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.destroy();
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      await expectFetchEnvelope(await postCompletions(origin), 502, AGENT_UNAVAILABLE_ENVELOPE);
    });
  });
});
