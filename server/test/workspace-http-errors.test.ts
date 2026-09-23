import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  loginSessionPair,
  UNAUTHORIZED_ENVELOPE,
  validatingBodyRouteOptions,
} from "./auth-lifecycle-helpers.js";
import { removeTempDirs } from "./core-db-helpers.js";
import { withListeningApp } from "./raw-http-helpers.js";
import {
  expectEmptyWorkspaceAuditAndOwnerRoot,
  withWorkspacesApp,
} from "./workspaces-http-helpers.js";

/**
 * Issue #115/#128：真实生产 POST /api/workspaces 与 POST /api/workspaces/:id/dirs
 * 经 createApp + 登录 cookie + 监听 HTTP 验收 parser owner。
 */

const PARSER_CASES = [
  { name: "malformed JSON", contentType: "application/json", body: "{" },
  { name: "empty JSON body", contentType: "application/json", body: "" },
  { name: "unsupported media", contentType: "application/octet-stream", body: "x" },
  {
    name: "oversized body",
    contentType: "application/json",
    body: JSON.stringify({ p: "x".repeat(17_000) }),
  },
] as const;

const BODY_LIMIT = 32;

interface Probe {
  calls: number;
}

afterEach(removeTempDirs);

function expectNoAuthSideEffects(headers: Headers): void {
  expect(headers.get("set-cookie")).toBeNull();
}

function expectRouteOwnedNoStore(headers: Headers): void {
  expect(headers.get("cache-control")).toBe("no-store");
  expectNoAuthSideEffects(headers);
}

function expectUnownedNoStore(headers: Headers): void {
  expect(headers.get("cache-control")).toBeNull();
  expectNoAuthSideEffects(headers);
}

function registerUnownedProbes(app: FastifyInstance, probe: Probe): void {
  app.put("/api/workspaces/:id/dirs", { bodyLimit: BODY_LIMIT }, async () => {
    probe.calls += 1;
    return { ok: true };
  });
  app.post("/api/workspaces-extra", { bodyLimit: BODY_LIMIT }, async () => {
    probe.calls += 1;
    return { ok: true };
  });
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
}

function throwForgedParserErrorOnCollection(app: FastifyInstance): void {
  app.addHook("preHandler", (request: FastifyRequest, _reply, done) => {
    if (request.method === "POST" && request.routeOptions.url === "/api/workspaces") {
      done(
        Object.assign(new Error("private-parser-detail"), {
          code: "FST_ERR_CTP_EMPTY_JSON_BODY",
          statusCode: 400,
        }),
      );
      return;
    }
    done();
  });
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
  it("认证后四个 genuine CTP 失败在两条 owner 上归一 exact 400，且不写 DB/审计/FS", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        const owned = await postJson(
          origin,
          "/api/workspaces",
          cookie,
          "application/json",
          JSON.stringify({ name: "parser-owned" }),
        );
        expect(owned.status).toBe(201);
        const workspace = (await owned.json()) as { id: string; dir: string };
        const ownerPaths = ["/api/workspaces", `/api/workspaces/${workspace.id}/dirs`] as const;
        const beforeWorkspaces = db.prepare("SELECT count(*) AS count FROM workspaces").get();
        const beforeAudits = db.prepare("SELECT count(*) AS count FROM audit_events").get();

        for (const path of ownerPaths) {
          for (const input of PARSER_CASES) {
            const response = await postJson(origin, path, cookie, input.contentType, input.body);
            expect(response.status, `${input.name} @ ${path}`).toBe(400);
            expect(await response.json(), `${input.name} @ ${path}`).toEqual(BAD_REQUEST_ENVELOPE);
            expectRouteOwnedNoStore(response.headers);
          }
        }

        expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual(
          beforeWorkspaces,
        );
        expect(db.prepare("SELECT count(*) AS count FROM audit_events").get()).toEqual(
          beforeAudits,
        );
        expect(existsSync(join(sandboxRoot, "u1", "parser-owned-extra"))).toBe(false);
        expect(existsSync(join(sandboxRoot, "u1", workspace.dir, "out"))).toBe(false);
      });
    });
  });

  it("未认证 malformed body 在 parser/handler 前 exact 401 且 route-owned no-store", async () => {
    await withWorkspacesApp(async ({ app, db, sandboxRoot }) => {
      await withListeningApp(app, async (origin) => {
        for (const path of ["/api/workspaces", "/api/workspaces/ws123/dirs"] as const) {
          const response = await postJson(origin, path, undefined, "application/json", "{");
          expect(response.status, path).toBe(401);
          expect(await response.json(), path).toEqual(UNAUTHORIZED_ENVELOPE);
          expectRouteOwnedNoStore(response.headers);
        }

        expectEmptyWorkspaceAuditAndOwnerRoot(db, sandboxRoot);
      });
    });
  });

  it("registered non-POST 与 lookalike 保持 generic 500，handler 不运行", async () => {
    await withWorkspacesApp(async ({ app }) => {
      const probe: Probe = { calls: 0 };
      registerUnownedProbes(app, probe);
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
          expectUnownedNoStore(response.headers);
        }
        expect(probe.calls).toBe(0);
      });
    });
  });

  it("owner 上伪造 CTP 与真实 schema validation 保持 generic 500", async () => {
    await withWorkspacesApp(async ({ app, db }) => {
      const probe: Probe = { calls: 0 };
      registerUnownedProbes(app, probe);
      throwForgedParserErrorOnCollection(app);
      await withListeningApp(app, async (origin) => {
        const cookie = await loginSessionPair(app);
        const beforeWorkspaces = db.prepare("SELECT count(*) AS count FROM workspaces").get();
        const forged = await postJson(
          origin,
          "/api/workspaces",
          cookie,
          "application/json",
          JSON.stringify({ name: "forged-owner" }),
        );
        expect(forged.status).toBe(500);
        expect(await forged.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expectRouteOwnedNoStore(forged.headers);
        expect(db.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual(
          beforeWorkspaces,
        );

        const duck = await fetch(`${origin}/api/workspaces/programmer`, { headers: { cookie } });
        expect(duck.status).toBe(500);
        expect(await duck.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expectUnownedNoStore(duck.headers);

        const validation = await postJson(
          origin,
          "/api/workspaces/ws123/dirs/schema",
          cookie,
          "application/json",
          "{}",
        );
        expect(validation.status).toBe(500);
        expect(await validation.json()).toEqual(INTERNAL_ERROR_ENVELOPE);
        expectUnownedNoStore(validation.headers);
        expect(probe.calls).toBe(0);
      });
    });
  });

  it("单独注册的 concrete /api/workspaces/ws123/dirs 不是 parametric owner", async () => {
    await withWorkspacesApp(async ({ app }) => {
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
        expectUnownedNoStore(response.headers);
      });
    });
  });
});
