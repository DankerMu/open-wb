import type { FastifyInstance, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionPair,
  UNAUTHORIZED_ENVELOPE,
  validatingBodyRouteOptions,
  withApp,
} from "./auth-lifecycle-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";

/**
 * Issue #115：测试侧挂载 POST /api/workspaces 与 POST /api/workspaces/:id/dirs，
 * 经真实 createApp + 登录 cookie + 监听 HTTP 验收 parser owner；不挂载产品路由。
 */

const PARSER_CASES = [
  { name: "malformed JSON", contentType: "application/json", body: "{" },
  { name: "empty JSON body", contentType: "application/json", body: "" },
  { name: "unsupported media", contentType: "application/octet-stream", body: "x" },
  {
    name: "oversized body",
    contentType: "application/json",
    body: JSON.stringify({ p: "x".repeat(64) }),
  },
] as const;

const OWNER_PATHS = ["/api/workspaces", "/api/workspaces/ws123/dirs"] as const;
const BODY_LIMIT = 32;

interface Probe {
  calls: number;
}

function expectNoAuthSideEffects(headers: Headers): void {
  expect(headers.get("cache-control")).toBeNull();
  expect(headers.get("set-cookie")).toBeNull();
}

function registerOwnerRoutes(app: FastifyInstance, probe: Probe): void {
  const onOwner = async (request: FastifyRequest) => {
    probe.calls += 1;
    const body = request.body;
    if (typeof body === "object" && body !== null && "fail" in body && body.fail === true) {
      throw Object.assign(new Error("private-parser-detail"), {
        code: "FST_ERR_CTP_EMPTY_JSON_BODY",
        statusCode: 400,
      });
    }
    return { ok: true };
  };
  app.post("/api/workspaces", { bodyLimit: BODY_LIMIT }, onOwner);
  app.post("/api/workspaces/:id/dirs", { bodyLimit: BODY_LIMIT }, onOwner);
}

async function postJson(
  origin: string,
  path: string,
  cookie: string | undefined,
  contentType: string,
  body: string,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": contentType,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body,
  });
}

describe("工作空间 parser owner 的真实 HTTP 边界", () => {
  it("认证后四个 genuine CTP 失败在两条 owner 上归一 exact 400，且 handler 不运行", async () => {
    await withApp({}, async ({ app }) => {
      const probe: Probe = { calls: 0 };
      registerOwnerRoutes(app, probe);
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        for (const path of OWNER_PATHS) {
          for (const input of PARSER_CASES) {
            const response = await postJson(origin, path, cookie, input.contentType, input.body);
            expect(response.status, `${input.name} @ ${path}`).toBe(400);
            expect(await response.json(), `${input.name} @ ${path}`).toEqual(BAD_REQUEST_ENVELOPE);
            expectNoAuthSideEffects(response.headers);
          }
        }
        expect(probe.calls).toBe(0);
      });
    });
  });

  it("未认证 malformed body 在 parser/handler 前 exact 401", async () => {
    await withApp({}, async ({ app }) => {
      const probe: Probe = { calls: 0 };
      registerOwnerRoutes(app, probe);
      await withListeningApp(app, async (origin) => {
        for (const path of OWNER_PATHS) {
          const response = await postJson(origin, path, undefined, "application/json", "{");
          expect(response.status, path).toBe(401);
          expect(await response.json(), path).toEqual(UNAUTHORIZED_ENVELOPE);
          expectNoAuthSideEffects(response.headers);
        }
        expect(probe.calls).toBe(0);
      });
    });
  });

  it("registered non-POST 与 lookalike 保持 generic 500，handler 不运行", async () => {
    await withApp({}, async ({ app }) => {
      const probe: Probe = { calls: 0 };
      registerOwnerRoutes(app, probe);
      app.put("/api/workspaces/:id/dirs", { bodyLimit: BODY_LIMIT }, async () => {
        probe.calls += 1;
        return { ok: true };
      });
      app.post("/api/workspaces-extra", { bodyLimit: BODY_LIMIT }, async () => {
        probe.calls += 1;
        return { ok: true };
      });
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        for (const [method, path] of [
          ["PUT", "/api/workspaces/ws123/dirs"],
          ["POST", "/api/workspaces-extra"],
        ] as const) {
          const response = await fetch(`${origin}${path}`, {
            method,
            headers: { cookie, "content-type": "application/json" },
            body: "{",
          });
          expect(response.status, `${method} ${path}`).toBe(500);
          expect(await response.json(), `${method} ${path}`).toEqual(INTERNAL_ERROR_ENVELOPE);
          expectNoAuthSideEffects(response.headers);
        }
        expect(probe.calls).toBe(0);
      });
    });
  });

  it("owner 上伪造 CTP 与真实 schema validation 保持 generic 500", async () => {
    await withApp({}, async ({ app }) => {
      const probe: Probe = { calls: 0 };
      registerOwnerRoutes(app, probe);
      app.post(
        "/api/workspaces/:id/dirs/schema",
        { bodyLimit: BODY_LIMIT, ...validatingBodyRouteOptions() },
        async () => {
          probe.calls += 1;
          return { ok: true };
        },
      );
      app.get("/api/workspaces/programmer", () => {
        throw Object.assign(new Error("status duck typing"), { statusCode: 400 });
      });
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        const forged = await postJson(
          origin,
          "/api/workspaces",
          cookie,
          "application/json",
          JSON.stringify({ fail: true }),
        );
        expect(forged.status).toBe(500);
        expect(await forged.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expectNoAuthSideEffects(forged.headers);

        const duck = await fetch(`${origin}/api/workspaces/programmer`, { headers: { cookie } });
        expect(duck.status).toBe(500);
        expect(await duck.json()).toEqual(INTERNAL_ERROR_ENVELOPE);

        const validation = await postJson(
          origin,
          "/api/workspaces/ws123/dirs/schema",
          cookie,
          "application/json",
          "{}",
        );
        expect(validation.status).toBe(500);
        expect(await validation.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expectNoAuthSideEffects(validation.headers);
      });
    });
  });

  it("单独注册的 concrete /api/workspaces/ws123/dirs 不是 parametric owner", async () => {
    await withApp({}, async ({ app }) => {
      const probe: Probe = { calls: 0 };
      app.post("/api/workspaces/ws123/dirs", { bodyLimit: BODY_LIMIT }, async () => {
        probe.calls += 1;
        return { ok: true };
      });
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        const response = await postJson(
          origin,
          "/api/workspaces/ws123/dirs",
          cookie,
          "application/json",
          "{",
        );
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expect(probe.calls).toBe(0);
        expectNoAuthSideEffects(response.headers);
      });
    });
  });
});
