import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  API_KEY,
  expectFetchEnvelope,
  expectReplacedCredentials,
  FOUR_MIB,
  jsonBodyOfSize,
  LIVE_TOKEN,
  liveTokenTable,
  postCompletions,
  type RecordedRequest,
  rawPostCompletions,
  startRecordingUpstream,
  tokensFrom,
  useResources,
  withListeningProxy,
} from "./model-proxy-helpers.js";
import { start } from "./support/fake-upstream.mjs";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const RAW_JSON = Buffer.from(' { "escaped" : "\\u4f60", "text" : "你好", "number":1e0 }\n');
const OPAQUE = Buffer.concat([Buffer.from("上游原始字节\n"), Buffer.from([0, 255, 254, 13, 10])]);
const USER_HELLO = { role: "user", content: "hello from workbuddy" };
const EXPECTED_COMMAND = "echo workbuddy-smoke";
const EXPECTED_REPLY = "你好，这是 WorkBuddy 的第一条流式回复。";
const ERROR_MARKER = "WORKBUDDY_FAKE_ERROR";

function configured(origin: string, basePath = "/v1") {
  return {
    tokens: tokensFrom(liveTokenTable()),
    upstream: { baseUrl: `${origin}${basePath}`, apiKey: API_KEY },
  };
}

function lastRecord(requests: RecordedRequest[]): RecordedRequest {
  const recorded = requests.at(-1);
  if (recorded === undefined) {
    throw new Error("expected an upstream request");
  }
  return recorded;
}

async function opaque202Upstream() {
  return resources.track(
    await startRecordingUpstream(({ response }) => {
      response.writeHead(202, { "content-type": "application/octet-stream" });
      response.end(OPAQUE);
    }),
  );
}

function sseDataRecords(text: string): string[] {
  return [...text.matchAll(/^data: (.*)$/gmu)].map((match) => match[1] ?? "");
}

function jsonChunks(text: string): Array<Record<string, unknown>> {
  const records = sseDataRecords(text);
  expect(records.at(-1)).toBe("[DONE]");
  return records.slice(0, -1).map((row) => JSON.parse(row) as Record<string, unknown>);
}

function firstChoice(chunk: Record<string, unknown>): Record<string, unknown> {
  const choices = chunk.choices;
  expect(Array.isArray(choices)).toBe(true);
  const choice = Array.isArray(choices) ? choices[0] : undefined;
  expect(choice !== null && typeof choice === "object").toBe(true);
  return choice as Record<string, unknown>;
}

function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
  const delta = firstChoice(chunk).delta;
  expect(delta !== null && typeof delta === "object").toBe(true);
  return delta as Record<string, unknown>;
}

function toolFunctions(chunks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const functions: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    const toolCalls = deltaOf(chunk).tool_calls;
    if (!Array.isArray(toolCalls)) {
      continue;
    }
    for (const call of toolCalls) {
      const fn = toolFunction(call);
      if (fn !== undefined) {
        functions.push(fn);
      }
    }
  }
  return functions;
}

function toolFunction(call: unknown): Record<string, unknown> | undefined {
  if (call === null || typeof call !== "object") {
    return undefined;
  }
  const fn = (call as Record<string, unknown>).function;
  return fn !== null && typeof fn === "object" ? (fn as Record<string, unknown>) : undefined;
}

function expectToolRound(status: number, contentType: string, text: string): void {
  expect(status).toBe(200);
  expect(contentType).toMatch(/text\/event-stream/iu);
  const chunks = jsonChunks(text);
  let name = "";
  let args = "";
  for (const record of toolFunctions(chunks)) {
    if (typeof record.name === "string") {
      name = record.name;
    }
    if (typeof record.arguments === "string") {
      args += record.arguments;
    }
  }
  expect(name).toBe("bash");
  expect(JSON.parse(args)).toEqual({ command: EXPECTED_COMMAND });
  expect(firstChoice(chunks[chunks.length - 1] ?? {}).finish_reason).toBe("tool_calls");
}

function expectTextRound(status: number, contentType: string, text: string): void {
  expect(status).toBe(200);
  expect(contentType).toMatch(/text\/event-stream/iu);
  const chunks = jsonChunks(text);
  const parts: string[] = [];
  for (const chunk of chunks) {
    const content = deltaOf(chunk).content;
    if (typeof content === "string") {
      parts.push(content);
    }
  }
  expect(parts.length).toBeGreaterThanOrEqual(3);
  expect(parts.join("")).toBe(EXPECTED_REPLY);
  expect(firstChoice(chunks[chunks.length - 1] ?? {}).finish_reason).toBe("stop");
}

describe("byte-preserving credential substitution", () => {
  it("forwards original JSON bytes, content-type, and the configured API key", async () => {
    const upstream = await opaque202Upstream();
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const response = await postCompletions(origin, {
        body: RAW_JSON,
        contentType: "application/json; charset=utf-8",
      });
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(Buffer.from(await response.arrayBuffer()).equals(OPAQUE)).toBe(true);
      expect(upstream.requests).toHaveLength(1);
      const recorded = lastRecord(upstream.requests);
      expect(recorded.url).toBe("/v1/chat/completions");
      expect(recorded.headers["content-type"]).toBe("application/json; charset=utf-8");
      expectReplacedCredentials(recorded, RAW_JSON);
    });
  });

  it("joins a prefix-free base URL onto /chat/completions", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(204);
        response.end();
      }),
    );
    await withListeningProxy(configured(upstream.origin, ""), async (origin) => {
      const response = await postCompletions(origin, { body: "{}" });
      expect(response.status).toBe(204);
      expect(upstream.requests).toHaveLength(1);
      expect(lastRecord(upstream.requests).url).toBe("/chat/completions");
    });
  });

  it("accepts exactly 4MiB valid JSON and rejects one extra byte before upstream", async () => {
    const exact = jsonBodyOfSize(FOUR_MIB);
    const over = jsonBodyOfSize(FOUR_MIB + 1);
    const upstream = await opaque202Upstream();
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const accepted = await postCompletions(origin, { body: exact });
      expect(accepted.status).toBe(202);
      await accepted.arrayBuffer();
      expect(upstream.requests).toHaveLength(1);
      expect(lastRecord(upstream.requests).body.equals(Buffer.from(exact))).toBe(true);
      await expectFetchEnvelope(await postCompletions(origin, { body: over }), 400, {
        error: { code: "bad_request", message: "请求格式不正确" },
      });
      expect(upstream.requests).toHaveLength(1);
    });
  });
});

describe("non5xx passthrough and 5xx sanitization", () => {
  it("passes 429 status, content-type, and opaque body unchanged", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(429, { "content-type": "application/json; charset=utf-8" });
        response.end('{"vendor":"rate-limited"}');
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const response = await postCompletions(origin, { body: '{"mode":"rate"}' });
      expect(response.status).toBe(429);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await response.text()).toBe('{"vendor":"rate-limited"}');
    });
  });

  it("does not follow redirects or decompress opaque bodies", async () => {
    const compressed = gzipSync(Buffer.from("opaque-plain"));
    let hits = 0;
    const upstream = resources.track(
      await startRecordingUpstream(({ response, recorded }) => {
        hits += 1;
        if (recorded.body.toString("utf8").includes("redirect")) {
          response.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" });
          response.end("redirect-body");
          return;
        }
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-encoding": "gzip",
        });
        response.end(compressed);
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      const redirected = await rawPostCompletions(origin, { body: '{"mode":"redirect"}' });
      expect(redirected.status).toBe(302);
      expect(redirected.body.toString("utf8")).toBe("redirect-body");
      expect(hits).toBe(1);

      const gzipped = await rawPostCompletions(origin, { body: '{"mode":"gzip"}' });
      expect(gzipped.status).toBe(200);
      expect(gzipped.headers["content-encoding"]).toBe("gzip");
      expect(gzipped.body.equals(compressed)).toBe(true);
      expect(hits).toBe(2);
    });
  });

  it("maps upstream 5xx to local 502, discards the raw body, and does not retry", async () => {
    const upstream = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end(`private ${API_KEY} ${LIVE_TOKEN}`);
      }),
    );
    await withListeningProxy(configured(upstream.origin), async (origin) => {
      await expectFetchEnvelope(
        await postCompletions(origin, { body: '{"mode":"error"}' }),
        502,
        AGENT_UNAVAILABLE_ENVELOPE,
      );
      expect(upstream.requests).toHaveLength(1);
    });
  });

  it("maps a refused configured port to 502 without leaking the API key", async () => {
    const occupier = resources.track(
      await startRecordingUpstream(({ response }) => {
        response.writeHead(200);
        response.end("unused");
      }),
    );
    const closedPort = occupier.port;
    await occupier.close();
    await withListeningProxy(configured(`http://127.0.0.1:${closedPort}`), async (origin) => {
      await expectFetchEnvelope(await postCompletions(origin), 502, AGENT_UNAVAILABLE_ENVELOPE);
    });
  });
});

describe("real #88 fake-upstream composition", () => {
  it("replays the two-round script and sanitizes the fixture 500", async () => {
    const fake = resources.track(await start({ apiKey: API_KEY }));
    await withListeningProxy(configured(`http://127.0.0.1:${fake.port}`), async (origin) => {
      const first = await postCompletions(origin, {
        body: JSON.stringify({ messages: [USER_HELLO], stream: true }),
      });
      expect(first.headers.get("cache-control")).toBe("no-store");
      expectToolRound(first.status, first.headers.get("content-type") ?? "", await first.text());

      const second = await postCompletions(origin, {
        body: JSON.stringify({
          messages: [USER_HELLO, { role: "tool", content: "workbuddy-smoke" }],
          stream: true,
        }),
      });
      expectTextRound(second.status, second.headers.get("content-type") ?? "", await second.text());

      const failed = await postCompletions(origin, {
        body: JSON.stringify({
          messages: [{ role: "user", content: `trigger ${ERROR_MARKER}` }],
          stream: true,
        }),
      });
      await expectFetchEnvelope(failed, 502, AGENT_UNAVAILABLE_ENVELOPE);
    });
  });
});
