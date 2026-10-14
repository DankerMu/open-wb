/**
 * Issue #909 tasks 1.4, 1.5: the proxy's own failure answers (model-proxy「透传端点与 bearer
 * 鉴权」, 上游失败摘要) — scenarios「5xx summary carries status and a sanitised excerpt」「Below-500
 * answers stay opaque」「Slow failures answer 424」(504 / 524 and the production deadline; the
 * stalled-handshake case is in model-proxy-timeout.test.ts)「First-byte deadline answers 424」.
 * Expected bodies are the spec's literals; deadlines are injected short values, nothing waits 10 s.
 */
import { readdirSync, readFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readErrorBody } from "../src/model-proxy/error-body.js";
import {
  DEFAULT_CONNECT_DEADLINE_MS,
  DEFAULT_FIRST_BYTE_DEADLINE_MS,
  type ModelProxyOptions,
} from "../src/model-proxy/index.js";
import {
  ALLOWED_MODELS,
  API_KEY,
  CONNECTION_DEADLINE_MS,
  createGate,
  createProxyApp,
  expectFetchEnvelope,
  liveTokenTable,
  postCompletions,
  rawPostCompletions,
  startRecordingUpstream,
  tokensFrom,
  useResources,
  waitFor,
  withListeningProxy,
} from "./model-proxy-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";
import { start } from "./support/fake-upstream.mjs";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const FIRST_BYTE_DEADLINE_MS = 120_000;
const SECRET_BASE_PATH = "/tenant-0123456789/v1";
const LEAKS = [
  "leak-token-0123456789",
  "sk-leakleakleakleakleak",
  "raw-http-request=",
  "p4ss-secret",
  "tenant-0123456789",
];

function configured(baseUrl: string, extra: Partial<ModelProxyOptions> = {}): ModelProxyOptions {
  return {
    tokens: tokensFrom(liveTokenTable()),
    allowedModels: ALLOWED_MODELS,
    upstream: { baseUrl, apiKey: API_KEY },
    ...extra,
  };
}

function marked(text: string): { body: string } {
  return { body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: text }] }) };
}

function wbEnvelope(message: string, param: string): unknown {
  return { error: { message, type: "wb_upstream", param } };
}

async function expectExactBody(response: Response, status: number, body: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toMatch(/^application\/json/u);
  expect(await response.text()).toBe(body);
}

async function elapsed<T>(action: () => Promise<T>): Promise<[T, number]> {
  const startedAt = Date.now();
  const value = await action();
  return [value, Date.now() - startedAt];
}

const NO_RESPONSE =
  '{"error":{"message":"模型服务在 120 秒内没有返回响应","type":"wb_upstream","param":"no_response"}}';
const GATEWAY = (status: number): string =>
  `{"error":{"message":"模型服务的网关等待模型超时","type":"wb_upstream","param":"gateway_${String(status)}"}}`;

describe("5xx summary carries status and a sanitised excerpt", () => {
  it("removes the key, the base URL's userinfo and path, bearer, sk- and the dump line", async () => {
    let baseUrl = "";
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(500, { "content-type": "application/json" });
        // The fake upstream's `secret` message, echoing the base URL and its parts; the dump line
        // follows on a line of its own (in JSON it could only be an escaped `\n`, see the PR).
        response.end(
          `{"error":{"message":"rejected key ${API_KEY}; Authorization: Bearer leak-token-0123456789; sk-leakleakleakleakleak; via ${baseUrl} p4ss-secret tenant-0123456789"}}\nraw-http-request=/tmp/leak.json`,
        );
      }),
    );
    baseUrl = `http://u:p4ss-secret@127.0.0.1:${String(upstream.port)}${SECRET_BASE_PATH}`;
    await withListeningProxy(configured(baseUrl), async (origin) => {
      const response = await postCompletions(origin);
      const text = await response.clone().text();
      await expectFetchEnvelope(
        response,
        502,
        wbEnvelope(
          '模型服务返回 HTTP 500：{"error":{"message":"rejected key [已移除]; Authorization: Bearer [已移除] [已移除]; via [已移除] [已移除] [已移除]"}}',
          "status.500",
        ),
      );
      for (const leak of LEAKS) {
        expect(text).not.toContain(leak);
      }
      expect(upstream.requests).toHaveLength(1);
      expect(upstream.requests[0]?.url).toBe(`${SECRET_BASE_PATH}/chat/completions`);
    });
  });

  it("quotes a text/plain 503 body", async () => {
    const fake = resources.track(await start({ apiKey: API_KEY }));
    await withListeningProxy(
      configured(`http://127.0.0.1:${String(fake.port)}/v1`),
      async (origin) => {
        const response = await postCompletions(
          origin,
          marked("x WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_BODY=text"),
        );
        await expectFetchEnvelope(
          response,
          502,
          wbEnvelope("模型服务返回 HTTP 503：503 Service Unavailable", "status.503"),
        );
        expect(fake.requests()).toHaveLength(1);
      },
    );
  });

  it("folds a 20000-code-point body with line breaks into a 1000-code-point excerpt", async () => {
    const line = "上游忙碌，请稍后再试012345678\n";
    const body = line.repeat(20_000 / Array.from(line).length);
    expect(Array.from(body)).toHaveLength(20_000);
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(body);
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const response = await postCompletions(origin);
      expect(response.status).toBe(502);
      const { error } = (await response.json()) as { error: { message: string; param: string } };
      expect(error.param).toBe("status.502");
      expect(error.message).not.toMatch(/[\n\r]/u);
      const prefix = "模型服务返回 HTTP 502：";
      expect(error.message.startsWith(prefix)).toBe(true);
      const excerpt = error.message.slice(prefix.length);
      expect(Array.from(excerpt)).toHaveLength(1000);
      expect(excerpt.endsWith("…（已截断）")).toBe(true);
      expect(excerpt.startsWith("上游忙碌，请稍后再试012345678 上游忙碌")).toBe(true);
    });
  });

  it("drops a compressed error body: the message has no excerpt", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(500, { "content-type": "text/plain", "content-encoding": "gzip" });
        response.end("not really gzip");
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      await expectFetchEnvelope(
        await postCompletions(origin),
        502,
        wbEnvelope("模型服务返回 HTTP 500", "status.500"),
      );
    });
  });
});

describe("cancellation while a ≥500 body is being read", () => {
  it("a client abort and app close each reclaim the upstream well before the 5000 ms read cap", async () => {
    const wrote = createGate();
    const reclaims: Array<Promise<void>> = [];
    const upstream = resources.track(
      await startRecordingUpstream(async ({ response, reclaimed }) => {
        reclaims.push(reclaimed);
        response.writeHead(500, { "content-type": "text/plain" });
        response.write("partial");
        wrote.resolve();
        await reclaimed;
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const abort = new AbortController();
      const aborted = postCompletions(origin, { signal: abort.signal });
      await waitFor(wrote.promise, 3_000, "upstream never began the error body");
      abort.abort();
      await expect(aborted).rejects.toBeInstanceOf(Error);
      await waitFor(
        reclaims[0] ?? Promise.reject(new Error("no request")),
        1_000,
        "abort left the upstream open",
      );
    });
    const second = createGate();
    const held = resources.track(
      await startRecordingUpstream(async ({ response, reclaimed }) => {
        reclaims.push(reclaimed);
        response.writeHead(500, { "content-type": "text/plain" });
        response.write("partial");
        second.resolve();
        await reclaimed;
      }),
    );
    const app = await createProxyApp(configured(held.origin));
    await withListeningApp(app, async (origin) => {
      const pending = postCompletions(origin).then(
        () => "answered",
        () => "closed",
      );
      await waitFor(second.promise, 3_000, "upstream never began the error body");
      await waitFor(app.close(), 1_000, "app.close waited for the error body");
      await waitFor(
        reclaims[1] ?? Promise.reject(new Error("no request")),
        1_000,
        "app close left the upstream open",
      );
      expect(await pending).toBe("closed");
    });
  });
});

describe("a request that cannot be built", () => {
  it("answers 502 connect.ERR_INVALID_CHAR for a key that is no header value, with no upstream request", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.end("unused");
      }),
    );
    const options = configured(upstream.origin);
    await withListeningProxy(
      { ...options, upstream: { baseUrl: upstream.origin, apiKey: "bad\nkey" } },
      async (origin) => {
        await expectFetchEnvelope(
          await postCompletions(origin),
          502,
          wbEnvelope("无法连接模型服务（ERR_INVALID_CHAR）", "connect.ERR_INVALID_CHAR"),
        );
        expect(upstream.requests).toHaveLength(0);
      },
    );
  });
});

describe("Below-500 answers stay opaque", () => {
  it("passes 401, 404 and 429 JSON and a 400 empty body through unchanged", async () => {
    const fake = resources.track(await start({ apiKey: API_KEY }));
    await withListeningProxy(
      configured(`http://127.0.0.1:${String(fake.port)}/v1`),
      async (origin) => {
        const cases: Array<[string, number, string | undefined, string]> = [
          [
            "WORKBUDDY_FAKE_STATUS=401",
            401,
            "application/json",
            '{"error":{"message":"scripted upstream 401","type":"scripted_error"}}',
          ],
          [
            "WORKBUDDY_FAKE_STATUS=404 WORKBUDDY_FAKE_BODY=model",
            404,
            "application/json",
            '{"error":{"message":"The model `x` does not exist","type":"model_not_found"}}',
          ],
          [
            "WORKBUDDY_FAKE_STATUS=429 WORKBUDDY_FAKE_BODY=quota",
            429,
            "application/json",
            '{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
          ],
          ["WORKBUDDY_FAKE_STATUS=400 WORKBUDDY_FAKE_BODY=empty", 400, undefined, ""],
        ];
        for (const [marker, status, type, body] of cases) {
          const response = await rawPostCompletions(origin, marked(`x ${marker}`));
          expect(response.status).toBe(status);
          expect(response.headers["content-type"]).toBe(type);
          expect(response.headers["cache-control"]).toBe("no-store");
          expect(response.body.toString("utf8")).toBe(body);
        }
        expect(fake.requests()).toHaveLength(4);
      },
    );
  });
});

describe("Slow failures answer 424", () => {
  it("answers gateway_504 after a slow 504 and gateway_524 for an immediate 524, without the body", async () => {
    const fake = resources.track(await start({ apiKey: API_KEY }));
    await withListeningProxy(
      configured(`http://127.0.0.1:${String(fake.port)}/v1`),
      async (origin) => {
        const [slow, ms] = await elapsed(() =>
          postCompletions(
            origin,
            marked(
              "x WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_BODY=secret WORKBUDDY_FAKE_DELAY=200",
            ),
          ),
        );
        const slowText = await slow.clone().text();
        await expectExactBody(slow, 424, GATEWAY(504));
        expect(ms).toBeGreaterThanOrEqual(180);
        expect(fake.requests()).toHaveLength(1);
        const quick = await postCompletions(
          origin,
          marked("x WORKBUDDY_FAKE_STATUS=524 WORKBUDDY_FAKE_BODY=text"),
        );
        const quickText = await quick.clone().text();
        await expectExactBody(quick, 424, GATEWAY(524));
        expect(fake.requests()).toHaveLength(2);
        for (const text of [slowText, quickText]) {
          expect(text).not.toContain(API_KEY);
          expect(text).not.toContain("leak-token-0123456789");
          expect(text).not.toContain("524 ");
        }
      },
    );
  });
});

describe("First-byte deadline answers 424", () => {
  it("answers no_response when no headers arrive within firstByteDeadlineMs", async () => {
    const fake = resources.track(await start({ apiKey: API_KEY }));
    await withListeningProxy(
      configured(`http://127.0.0.1:${String(fake.port)}/v1`, { firstByteDeadlineMs: 300 }),
      async (origin) => {
        const [response, ms] = await elapsed(() =>
          waitFor(
            postCompletions(origin, marked("x WORKBUDDY_FAKE_HANG")),
            3_000,
            "no_response did not arrive",
          ),
        );
        await expectExactBody(response, 424, NO_RESPONSE);
        expect(ms).toBeGreaterThanOrEqual(250);
        expect(ms).toBeLessThan(2_000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(fake.requests()).toHaveLength(1);
      },
    );
  });

  it("lets headers at 200ms and a 2s stream through untouched", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(async ({ response }) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        response.end("data: [DONE]\n\n");
      }),
    );
    await withListeningProxy(
      configured(upstream.origin, { firstByteDeadlineMs: 300, connectDeadlineMs: 300 }),
      async (origin) => {
        const response = await postCompletions(origin);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("data: first\n\ndata: [DONE]\n\n");
      },
    );
  }, 8_000);
});

describe("deadline defaults and the production assembly", () => {
  it("defaults to 120000 / 10000 and is never given either by createApp or the environment", () => {
    expect(DEFAULT_FIRST_BYTE_DEADLINE_MS).toBe(FIRST_BYTE_DEADLINE_MS);
    expect(DEFAULT_CONNECT_DEADLINE_MS).toBe(CONNECTION_DEADLINE_MS);
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const call = /registerModelProxy\(app, \{[\s\S]*?\n {2}\}\);/u.exec(app)?.[0];
    expect(call).toBeDefined();
    expect(call).not.toMatch(/DeadlineMs/u);
    const dir = new URL("../src/model-proxy/", import.meta.url);
    for (const file of readdirSync(dir)) {
      expect(readFileSync(new URL(file, dir), "utf8")).not.toContain("process.env");
    }
  });
});

function upstreamResponse(origin: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(`${origin}/x`, { method: "POST" }, resolve);
    req.on("error", reject);
    req.end();
  });
}

describe("error body read limits (design D8: 16 KiB, 5000 ms)", () => {
  it("stops at the byte cap and at the time cap, and destroys the response", async () => {
    const big = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(500);
        response.end("x".repeat(40_000));
      }),
    );
    const capped = await upstreamResponse(big.origin);
    expect(await readErrorBody(capped)).toHaveLength(16 * 1024);
    expect(capped.destroyed).toBe(true);
    const held = resources.track(
      await startRecordingUpstream(async ({ response, reclaimed }) => {
        response.writeHead(500);
        response.write("partial");
        await reclaimed;
      }),
    );
    const slow = await upstreamResponse(held.origin);
    const [bytes, ms] = await elapsed(() => readErrorBody(slow, { bytes: 16 * 1024, ms: 200 }));
    expect(bytes.toString("utf8")).toBe("partial");
    expect(ms).toBeGreaterThanOrEqual(180);
    expect(ms).toBeLessThan(2_000);
    expect(slow.destroyed).toBe(true);
  });
});
