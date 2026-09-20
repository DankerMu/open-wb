import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  API_KEY,
  BAD_REQUEST_ENVELOPE,
  expectInjectEnvelope,
  expectZeroUpstream,
  FOUR_MIB,
  installModelProxy,
  jsonBodyOfSize,
  LIVE_TOKEN,
  liveTokenTable,
  PROXY_PATH,
  REVOKED_TOKEN,
  type RecordingUpstream,
  startRecordingUpstream,
  tokensFrom,
  UNAUTHORIZED_ENVELOPE,
  UNKNOWN_TOKEN,
  useResources,
  withProxyApp,
} from "./model-proxy-helpers.js";
import {
  bearerCookie,
  BAD_REQUEST_ENVELOPE as LOGIN_BAD_REQUEST,
  loginSessionId,
} from "./session-db-helpers.js";

const resources = useResources();
afterEach(async () => {
  await resources.closeAll();
});

const INVALID_BEARERS: ReadonlyArray<{ name: string; authorization: string | undefined }> = [
  { name: "missing Authorization", authorization: undefined },
  { name: "empty Authorization", authorization: "" },
  { name: "non-bearer scheme", authorization: `Token ${LIVE_TOKEN}` },
  { name: "malformed non-hex", authorization: "Bearer not-a-token" },
  { name: "63 hex chars", authorization: `Bearer ${"a".repeat(63)}` },
  { name: "65 hex chars", authorization: `Bearer ${"a".repeat(65)}` },
  { name: "unknown live-shaped token", authorization: `Bearer ${UNKNOWN_TOKEN}` },
  { name: "uppercase hex identity", authorization: `Bearer ${LIVE_TOKEN.toUpperCase()}` },
  { name: "revoked token", authorization: `Bearer ${REVOKED_TOKEN}` },
];

const PARSER_FAILURES: ReadonlyArray<{ name: string; payload: string; contentType: string }> = [
  { name: "malformed JSON", payload: '{"messages":', contentType: "application/json" },
  { name: "empty JSON body", payload: "", contentType: "application/json" },
  { name: "unsupported octet-stream", payload: "binary", contentType: "application/octet-stream" },
  { name: "text/plain JSON", payload: "{}", contentType: "text/plain" },
  {
    name: "oversize valid JSON",
    payload: jsonBodyOfSize(FOUR_MIB + 1),
    contentType: "application/json",
  },
];

function configured(upstream: RecordingUpstream) {
  return {
    tokens: tokensFrom(liveTokenTable()),
    upstream: { baseUrl: `${upstream.origin}/v1`, apiKey: API_KEY },
  };
}

async function recordingEcho(): Promise<RecordingUpstream> {
  return resources.track(
    await startRecordingUpstream(({ response }) => {
      response.writeHead(202, { "content-type": "application/octet-stream" });
      response.end("ok");
    }),
  );
}

async function injectProxy(
  app: FastifyInstance,
  init: {
    authorization?: string | undefined;
    payload?: string;
    contentType?: string;
    cookie?: string;
  },
): Promise<{
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
  payload: string;
}> {
  const headers: Record<string, string> = {
    "content-type": init.contentType ?? "application/json",
  };
  if (init.authorization !== undefined) {
    headers.authorization = init.authorization;
  }
  if (init.cookie !== undefined) {
    headers.cookie = init.cookie;
  }
  return app.inject({
    method: "POST",
    url: PROXY_PATH,
    headers,
    payload: init.payload ?? "{}",
  });
}

describe("auth precedes config, parser, and upstream contact", () => {
  it.each(INVALID_BEARERS)(
    "$name never reaches a configured upstream",
    async ({ authorization }) => {
      const upstream = await recordingEcho();
      await withProxyApp(configured(upstream), async (app) => {
        expectInjectEnvelope(
          await injectProxy(app, { authorization, payload: '{"messages":' }),
          401,
          UNAUTHORIZED_ENVELOPE,
        );
        expectZeroUpstream(upstream);
      });
    },
  );

  it.each(INVALID_BEARERS)(
    "$name is 401 even when upstream config is absent",
    async ({ authorization }) => {
      await withProxyApp({ tokens: tokensFrom(liveTokenTable()) }, async (app) => {
        expectInjectEnvelope(
          await injectProxy(app, { authorization, payload: jsonBodyOfSize(FOUR_MIB + 1) }),
          401,
          UNAUTHORIZED_ENVELOPE,
        );
      });
    },
  );

  it.each(PARSER_FAILURES)(
    "invalid bearer wins over $name before a configured upstream is contacted",
    async ({ payload, contentType }) => {
      const upstream = await recordingEcho();
      await withProxyApp(configured(upstream), async (app) => {
        expectInjectEnvelope(
          await injectProxy(app, {
            authorization: `Bearer ${UNKNOWN_TOKEN}`,
            payload,
            contentType,
          }),
          401,
          UNAUTHORIZED_ENVELOPE,
        );
        expectZeroUpstream(upstream);
      });
    },
  );

  it("valid bearer with omitted upstream is 502 without throwing at registration", async () => {
    await withProxyApp({ tokens: tokensFrom(liveTokenTable()) }, async (app) => {
      expectInjectEnvelope(
        await injectProxy(app, { authorization: `Bearer ${LIVE_TOKEN}`, payload: "{" }),
        502,
        AGENT_UNAVAILABLE_ENVELOPE,
      );
    });
  });

  it("valid bearer with explicit undefined upstream is 502 before parser errors", async () => {
    await withProxyApp(
      { tokens: tokensFrom(liveTokenTable()), upstream: undefined },
      async (app) => {
        expectInjectEnvelope(
          await injectProxy(app, {
            authorization: `Bearer ${LIVE_TOKEN}`,
            payload: jsonBodyOfSize(FOUR_MIB + 1),
            contentType: "text/plain",
          }),
          502,
          AGENT_UNAVAILABLE_ENVELOPE,
        );
      },
    );
  });

  it.each(PARSER_FAILURES)(
    "authenticated configured $name is 400 no-store with zero upstream contact",
    async ({ payload, contentType }) => {
      const upstream = await recordingEcho();
      await withProxyApp(configured(upstream), async (app) => {
        expectInjectEnvelope(
          await injectProxy(app, {
            authorization: `Bearer ${LIVE_TOKEN}`,
            payload,
            contentType,
          }),
          400,
          BAD_REQUEST_ENVELOPE,
        );
        expectZeroUpstream(upstream);
      });
    },
  );

  it("revokes a previously live token without contacting upstream again", async () => {
    const table = liveTokenTable();
    const upstream = await recordingEcho();
    await withProxyApp(
      {
        tokens: tokensFrom(table),
        upstream: { baseUrl: `${upstream.origin}/v1`, apiKey: API_KEY },
      },
      async (app) => {
        const allowed = await injectProxy(app, { authorization: `Bearer ${LIVE_TOKEN}` });
        expect(allowed.statusCode).toBe(202);
        expect(upstream.requests).toHaveLength(1);
        table.delete(LIVE_TOKEN);
        expectInjectEnvelope(
          await injectProxy(app, { authorization: `Bearer ${LIVE_TOKEN}` }),
          401,
          UNAUTHORIZED_ENVELOPE,
        );
        expect(upstream.requests).toHaveLength(1);
      },
    );
  });
});

describe("createApp sibling parser, guard, and cache isolation", () => {
  it("registers without a cookie exemption and leaves sibling auth/parser/cache intact", async () => {
    const upstream = await recordingEcho();
    const db = openDb(":memory:");
    const app = createApp({ db });
    try {
      await installModelProxy(app, configured(upstream));

      const anonymous = await injectProxy(app, { authorization: `Bearer ${LIVE_TOKEN}` });
      expect(anonymous.statusCode).toBe(202);
      expect(anonymous.headers["cache-control"]).toBe("no-store");
      expect(upstream.requests).toHaveLength(1);

      const cookie = bearerCookie(await loginSessionId(app));
      expectInjectEnvelope(
        await injectProxy(app, { cookie, payload: "{}" }),
        401,
        UNAUTHORIZED_ENVELOPE,
      );
      expect(upstream.requests).toHaveLength(1);

      const health = await app.inject({ method: "GET", url: "/api/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json()).toEqual({ status: "ok" });
      expect(health.headers["cache-control"]).toBeUndefined();

      const me = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(me.statusCode).toBe(401);
      expect(me.headers["cache-control"]).toBe("no-store");

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: '{"account":',
      });
      expect(login.statusCode).toBe(400);
      expect(login.json()).toEqual(LOGIN_BAD_REQUEST);
      expect(login.headers["cache-control"]).toBe("no-store");

      const bulkyLogin = `{"account":"${"x".repeat(20_000)}","password":"demo"}`;
      const overLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: bulkyLogin,
      });
      expect(overLogin.statusCode).toBe(400);
      expect(overLogin.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
      db.close();
    }
  });
});
