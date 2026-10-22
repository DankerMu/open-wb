/**
 * s1d-model-registry group 7 (task 7.2): the five admin model endpoints of model-registry「模型管理端点」
 * (`GET` / `POST` / `PUT` / `DELETE /api/models`, `POST /api/models/default`) on the whole mount of
 * `models-rest-helpers.ts`, plus「变更即发布」's single flight and publish failure. Expected values are spec
 * literals (envelopes, view shapes, audit detail) and the files the real writers produced. The in-flight
 * scenario is `models-rest-inflight.test.ts`; the restart bytes are `models-rest-restart.test.ts`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { resolveModelCatalog } from "../src/model-catalog.js";
import { ompAgentDir } from "../src/sessions/omp/state-layout.js";
import {
  BAD_REQUEST,
  CONFLICT,
  call,
  expectAnswer,
  FAKE_KEY,
  FORBIDDEN,
  GENERIC_500,
  MODEL_IN_USE,
  type ModelsWorld,
  managedIds,
  managedModels,
  modelAudits,
  NOT_FOUND,
  openModelsWorld,
  putBody,
  type RawBody,
  tableRows,
  UNAUTHORIZED,
  VIEW_KEYS,
} from "./models-rest-helpers.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";

/** Low-entropy sentinels (gitleaks): an upstream key and base URLs that must never be echoed. */
const KEY = "wb-issue1649-upstream-api-key";
const KEY_TWO = "wb-issue1649-second-api-key";
const GW = "https://gw.example/v1";
const GW2 = "https://gw2.example/v1";
const MALFORMED: RawBody = { raw: "{", type: "application/json" };
const TEXT: RawBody = { raw: "hello", type: "text/plain" };
const NEVER = { status: "never", at: null, message: null };

/** The seed row `m1` as `GET /api/models` shows it (its base URL is the fake upstream's). */
function seedView(world: ModelsWorld) {
  return {
    id: "m1",
    name: "m1",
    reasoning: false,
    vision: false,
    maxTokens: 32768,
    efforts: null,
    upstream: { baseUrl: `http://127.0.0.1:${String(world.upstream.port)}/v1`, hasApiKey: true },
    isDefault: true,
    probe: NEVER,
    updatedAt: expect.any(Number),
  };
}

/** Table, audit, fake-upstream requests and `models.yml` rewrites: what a refused request must not move. */
function footprint(world: ModelsWorld) {
  return {
    rows: tableRows(world.db),
    audits: modelAudits(world.db),
    upstream: world.upstream.requests().length,
    writes: world.writes.length,
  };
}

describe("权限与视图", () => {
  it("401 / 403 / 200, then a create shows hasApiKey and no key, lists both rows and audits model.create", async () => {
    const world = await openModelsWorld();
    expectAnswer(await call(world, "anonymous", "GET", "/api/models"), 401, UNAUTHORIZED);
    expectAnswer(await call(world, "member", "GET", "/api/models"), 403, FORBIDDEN);
    expectAnswer(await call(world, "admin", "GET", "/api/models"), 200, {
      models: [seedView(world)],
    });

    const created = await call(world, "admin", "POST", "/api/models", {
      id: "m2",
      upstream: { baseUrl: GW, apiKey: KEY },
    });
    const m2 = {
      id: "m2",
      name: "m2",
      reasoning: false,
      vision: false,
      maxTokens: 32768,
      efforts: null,
      upstream: { baseUrl: GW, hasApiKey: true },
      isDefault: false,
      probe: NEVER,
      updatedAt: expect.any(Number),
    };
    expectAnswer(created, 201, m2);
    expect(Object.keys(created.json() as object).sort()).toEqual(VIEW_KEYS);
    expect(created.payload).not.toContain(KEY);

    const listed = await call(world, "admin", "GET", "/api/models");
    expectAnswer(listed, 200, { models: [seedView(world), m2] });
    for (const view of (listed.json() as { models: object[] }).models) {
      expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
    }
    expect(listed.payload).not.toContain(KEY);
    expect(listed.payload).not.toContain(FAKE_KEY);
    expect(modelAudits(world.db)).toEqual([
      {
        actorId: "u3",
        kind: "model.create",
        title: "登记模型 m2",
        detail: { modelId: "m2", name: "m2", upstreamChanged: true },
        workspaceId: null,
      },
    ]);
    expect(managedIds(world.stateDir)).toEqual(["m1", "m2"]);
    expect(JSON.stringify(managedModels(world.stateDir))).not.toContain(KEY);
  });

  it("a seed base URL with userinfo is shown without it; neither its password nor its key is echoed", async () => {
    const password = "wb-issue1649-userinfo-password";
    const seedKey = "wb-issue1649-seed-api-key";
    const world = await openModelsWorld({
      seedUpstream: { baseUrl: `https://wb-user:${password}@gw.example/v1`, apiKey: seedKey },
    });
    const listed = await call(world, "admin", "GET", "/api/models");
    expectAnswer(listed, 200);
    const [view] = (listed.json() as { models: Array<{ upstream: unknown }> }).models;
    expect(view?.upstream).toEqual({ baseUrl: GW, hasApiKey: true });
    for (const leak of [password, seedKey, "wb-user"]) {
      expect(listed.payload).not.toContain(leak);
    }
  });
});

describe("非管理员先于 body 与 id", () => {
  const MEMBER_REQUESTS: Array<[string, "GET" | "POST" | "PUT" | "DELETE", string, unknown?]> = [
    ["list", "GET", "/api/models"],
    ["create malformed", "POST", "/api/models", MALFORMED],
    ["create text/plain", "POST", "/api/models", TEXT],
    ["create valid", "POST", "/api/models", { id: "x" }],
    ["update malformed", "PUT", "/api/models?id=m1", MALFORMED],
    ["update text/plain", "PUT", "/api/models?id=m1", TEXT],
    ["update unknown id", "PUT", "/api/models?id=nope", putBody("n", null)],
    ["update missing id", "PUT", "/api/models", putBody("n", null)],
    ["delete unknown id", "DELETE", "/api/models?id=nope"],
    ["delete missing id", "DELETE", "/api/models"],
    ["delete the default", "DELETE", "/api/models?id=m1"],
    ["default unknown id", "POST", "/api/models/default?id=nope"],
    ["default missing id", "POST", "/api/models/default"],
    ["default with {}", "POST", "/api/models/default?id=m1", {}],
    ["default malformed", "POST", "/api/models/default?id=m1", MALFORMED],
  ];

  it("every member request is 403 forbidden with no-store; table, audit, upstream and files unchanged", async () => {
    const world = await openModelsWorld();
    const before = footprint(world);
    for (const [, method, url, body] of MEMBER_REQUESTS) {
      expectAnswer(await call(world, "member", method, url, body), 403, FORBIDDEN);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("every anonymous request is 401 unauthorized with no-store", async () => {
    const world = await openModelsWorld();
    const before = footprint(world);
    for (const [, method, url, body] of MEMBER_REQUESTS) {
      expectAnswer(await call(world, "anonymous", method, url, body), 401, UNAUTHORIZED);
    }
    expect(footprint(world)).toEqual(before);
  });
});

describe("id 查询参数", () => {
  it("missing, empty and repeated ids are 400 on PUT, DELETE and default; nothing changes", async () => {
    const world = await openModelsWorld();
    const before = footprint(world);
    for (const query of ["", "?id=", "?id=&id=m1", "?id=m1&id=m1", "?other=m1"]) {
      const put = await call(world, "admin", "PUT", `/api/models${query}`, putBody("n", null));
      expectAnswer(put, 400, BAD_REQUEST);
      expectAnswer(await call(world, "admin", "DELETE", `/api/models${query}`), 400, BAD_REQUEST);
      const fallback = await call(world, "admin", "POST", `/api/models/default${query}`);
      expectAnswer(fallback, 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("an unknown id is 404 on PUT (valid body), DELETE and default", async () => {
    const world = await openModelsWorld();
    const before = footprint(world);
    const put = await call(world, "admin", "PUT", "/api/models?id=nope", putBody("n", null));
    expectAnswer(put, 404, NOT_FOUND);
    expectAnswer(await call(world, "admin", "DELETE", "/api/models?id=nope"), 404, NOT_FOUND);
    const fallback = await call(world, "admin", "POST", "/api/models/default?id=nope");
    expectAnswer(fallback, 404, NOT_FOUND);
    expect(footprint(world)).toEqual(before);
  });

  it("an id with / round-trips through ?id=Qwen%2F…", async () => {
    const world = await openModelsWorld();
    const id = "Qwen/Qwen2.5-72B-Instruct";
    expectAnswer(await call(world, "admin", "POST", "/api/models", { id }), 201);
    const url = `/api/models?id=${encodeURIComponent(id)}`;
    expect(url).toBe("/api/models?id=Qwen%2FQwen2.5-72B-Instruct");
    const put = await call(world, "admin", "PUT", url, putBody("通义", null));
    expectAnswer(put, 200);
    expect(put.json()).toMatchObject({ id, name: "通义" });
    const listed = (await call(world, "admin", "GET", "/api/models")).json() as {
      models: Array<{ id: string }>;
    };
    expect(listed.models.map((model) => model.id)).toEqual(["m1", id]);
  });
});

describe("编辑种子行", () => {
  it("a zero-config seed row: name only keeps efforts null (no thinking), then efforts low/high", async () => {
    const world = await openModelsWorld({ seed: resolveModelCatalog({}), seedUpstream: {} });
    const id = "deepseek-v4.1-flash";
    const url = `/api/models?id=${id}`;
    const body = {
      name: "深度求索",
      reasoning: true,
      vision: true,
      maxTokens: 32768,
      upstream: null,
    };
    const renamed = await call(world, "admin", "PUT", url, body);
    expectAnswer(renamed, 200);
    expect(renamed.json()).toMatchObject({ id, name: "深度求索", efforts: null, upstream: null });
    expect(managedModels(world.stateDir)[0]).not.toHaveProperty("thinking");

    const withEfforts = await call(world, "admin", "PUT", url, {
      ...body,
      efforts: ["low", "high"],
    });
    expectAnswer(withEfforts, 200);
    expect(withEfforts.json()).toMatchObject({ efforts: ["low", "high"] });
    expect(managedModels(world.stateDir)[0]?.thinking).toEqual({
      mode: "effort",
      efforts: ["low", "high"],
    });
  });
});

describe("种子行带 userinfo 只改名", () => {
  it("PUT with the view's address and no apiKey keeps the stored userinfo address and key; upstreamChanged false; no sentinel echoed", async () => {
    const password = "wb-issue1651-userinfo-password";
    const seedKey = "wb-issue1651-seed-api-key";
    const stored = `https://u:${password}@host.example/v1`;
    const world = await openModelsWorld({ seedUpstream: { baseUrl: stored, apiKey: seedKey } });

    const renamed = await call(
      world,
      "admin",
      "PUT",
      "/api/models?id=m1",
      putBody("改名", { baseUrl: "https://host.example/v1" }),
    );
    expectAnswer(renamed, 200);
    expect(renamed.json()).toMatchObject({
      name: "改名",
      upstream: { baseUrl: "https://host.example/v1", hasApiKey: true },
    });
    for (const leak of [password, seedKey, "u:"]) {
      expect(renamed.payload).not.toContain(leak);
    }
    expect(world.store.routeOf("m1")).toEqual({ baseUrl: stored, apiKey: seedKey });
    expect(modelAudits(world.db)).toEqual([
      {
        actorId: "u3",
        kind: "model.update",
        title: "修改模型 改名",
        detail: { modelId: "m1", name: "改名", upstreamChanged: false },
        workspaceId: null,
      },
    ]);
  });
});

describe("修改保留密钥与清空上游", () => {
  it("omitted apiKey keeps the key, null clears both columns, a keyless model cannot omit it", async () => {
    const world = await openModelsWorld();
    await call(world, "admin", "POST", "/api/models", {
      id: "m2",
      upstream: { baseUrl: GW, apiKey: KEY },
    });
    const body = putBody(
      "深度",
      { baseUrl: GW2 },
      {
        reasoning: true,
        maxTokens: 8192,
        efforts: ["low", "high"],
      },
    );
    const kept = await call(world, "admin", "PUT", "/api/models?id=m2", body);
    expectAnswer(kept, 200);
    expect(kept.json()).toMatchObject({
      upstream: { baseUrl: GW2, hasApiKey: true },
      maxTokens: 8192,
    });
    expect(kept.payload).not.toContain(KEY);
    const column =
      "SELECT upstream_base_url AS baseUrl, upstream_api_key AS apiKey FROM models WHERE id = ?";
    expect({ ...world.db.prepare(column).get("m2") }).toEqual({ baseUrl: GW2, apiKey: KEY });

    const cleared = await call(world, "admin", "PUT", "/api/models?id=m2", {
      ...body,
      upstream: null,
    });
    expectAnswer(cleared, 200);
    expect(cleared.json()).toMatchObject({ upstream: null });
    expect({ ...world.db.prepare(column).get("m2") }).toEqual({ baseUrl: null, apiKey: null });

    await call(world, "admin", "POST", "/api/models", { id: "m3" });
    const rows = tableRows(world.db);
    const keyless = await call(
      world,
      "admin",
      "PUT",
      "/api/models?id=m3",
      putBody("m3", { baseUrl: GW }),
    );
    expectAnswer(keyless, 400, BAD_REQUEST);
    expect(tableRows(world.db)).toEqual(rows);
  });

  it("upstreamChanged: rename false, new base URL true, new key only true, null swap true", async () => {
    const world = await openModelsWorld();
    await call(world, "admin", "POST", "/api/models", {
      id: "m2",
      upstream: { baseUrl: GW, apiKey: KEY },
    });
    const url = "/api/models?id=m2";
    await call(world, "admin", "PUT", url, putBody("改名", { baseUrl: GW }));
    await call(world, "admin", "PUT", url, putBody("改名", { baseUrl: GW2 }));
    await call(world, "admin", "PUT", url, putBody("改名", { baseUrl: GW2, apiKey: KEY_TWO }));
    await call(world, "admin", "PUT", url, putBody("改名", null));
    const updates = modelAudits(world.db).filter((event) => event.kind === "model.update");
    expect(updates).toEqual(
      [false, true, true, true].map((upstreamChanged) => ({
        actorId: "u3",
        kind: "model.update",
        title: "修改模型 改名",
        detail: { modelId: "m2", name: "改名", upstreamChanged },
        workspaceId: null,
      })),
    );
    const audits = JSON.stringify(modelAudits(world.db));
    for (const leak of [KEY, KEY_TWO, GW, GW2, "gw.example", "gw2.example"]) {
      expect(audits).not.toContain(leak);
    }
  });
});

describe("删除与缺省", () => {
  it("the default is 409 model_in_use; after switching the default it deletes with 204; unknown 404", async () => {
    const world = await openModelsWorld();
    await call(world, "admin", "POST", "/api/models", { id: "m2" });
    const rows = tableRows(world.db);
    expectAnswer(await call(world, "admin", "DELETE", "/api/models?id=m1"), 409, MODEL_IN_USE);
    expect(tableRows(world.db)).toEqual(rows);

    const switched = await call(world, "admin", "POST", "/api/models/default?id=m2");
    expectAnswer(switched, 200);
    expect(switched.json()).toMatchObject({ id: "m2", isDefault: true });
    const deleted = await call(world, "admin", "DELETE", "/api/models?id=m1");
    expectAnswer(deleted, 204);
    expect(deleted.payload).toBe("");
    expect(managedIds(world.stateDir)).toEqual(["m2"]);
    expect(modelAudits(world.db).slice(1)).toEqual([
      {
        actorId: "u3",
        kind: "model.default",
        title: "设为缺省模型 m2",
        detail: { modelId: "m2", name: "m2" },
        workspaceId: null,
      },
      {
        actorId: "u3",
        kind: "model.delete",
        title: "删除模型 m1",
        detail: { modelId: "m1", name: "m1" },
        workspaceId: null,
      },
    ]);
    expectAnswer(await call(world, "admin", "DELETE", "/api/models?id=m1"), 404, NOT_FOUND);
  });

  it("default on the model that already is the default: 200, no audit, no publication", async () => {
    const world = await openModelsWorld();
    const before = footprint(world);
    const again = await call(world, "admin", "POST", "/api/models/default?id=m1");
    expectAnswer(again, 200, seedView(world));
    expect(footprint(world)).toEqual(before);
  });
});

describe("非法 body 与归属", () => {
  it("every invalid create body, malformed JSON, text/plain and a body on default is exact 400; nothing changes", async () => {
    const world = await openModelsWorld();
    for (let index = 2; index <= 32; index += 1) {
      world.store.create({ id: `fill-${String(index)}` });
    }
    const before = footprint(world);
    const invalid: Array<[string, unknown]> = [
      ["/api/models", {}],
      ["/api/models", { id: "a", extra: 1 }],
      ["/api/models", { id: "a", efforts: ["low"] }],
      ["/api/models", { id: "a", upstream: { baseUrl: "ftp://x" } }],
      ["/api/models", { id: "a", upstream: { baseUrl: "https://x/v1" } }],
      ["/api/models", { id: "a33" }],
      ["/api/models", MALFORMED],
      ["/api/models", TEXT],
      ["/api/models/default?id=m1", {}],
      ["/api/models/default?id=m1", MALFORMED],
      ["/api/models/default?id=m1", TEXT],
      ["/api/models/default?id=m1", { raw: "1", type: "application/json" }],
    ];
    for (const [url, body] of invalid) {
      expectAnswer(await call(world, "admin", "POST", url, body), 400, BAD_REQUEST);
    }
    for (const body of [MALFORMED, TEXT]) {
      expectAnswer(await call(world, "admin", "PUT", "/api/models?id=m1", body), 400, BAD_REQUEST);
    }
    expect(footprint(world)).toEqual(before);
  });

  it("an existing id is 409 conflict", async () => {
    const world = await openModelsWorld();
    expectAnswer(await call(world, "admin", "POST", "/api/models", { id: "m1" }), 409, CONFLICT);
  });
});

describe("变更即发布", () => {
  it("two concurrent creates are both 201 and the final models.yml holds the seed, a and b", async () => {
    const world = await openModelsWorld();
    const [a, b] = await Promise.all([
      call(world, "admin", "POST", "/api/models", { id: "a" }),
      call(world, "admin", "POST", "/api/models", { id: "b" }),
    ]);
    expectAnswer(a as NonNullable<typeof a>, 201);
    expectAnswer(b as NonNullable<typeof b>, 201);
    expect(managedIds(world.stateDir)).toEqual(["m1", "a", "b"]);
    expect(world.writes.length).toBeLessThanOrEqual(3);
    expect(world.writes.at(-1)).toEqual(["m1", "a", "b"]);
  });

  it("a failed publication is a non-envelope 500 with one record; row and audit stay; the next write publishes it", async () => {
    const world = await openModelsWorld();
    const agentDir = ompAgentDir(world.stateDir);
    rmSync(agentDir, { recursive: true, force: true });
    writeFileSync(agentDir, "");

    const failed = await call(world, "admin", "POST", "/api/models", { id: "c" });
    expectAnswer(failed, 500, GENERIC_500);
    expect(world.failed).toEqual([{ event: "model_publish_failed" }]);
    expect(tableRows(world.db)).toContainEqual(expect.objectContaining({ id: "c" }));
    expect(modelAudits(world.db).map((event) => event.kind)).toEqual(["model.create"]);

    rmSync(agentDir, { force: true });
    mkdirSync(agentDir, { recursive: true });
    expectAnswer(await call(world, "admin", "POST", "/api/models", { id: "d" }), 201);
    expect(managedIds(world.stateDir)).toEqual(["m1", "c", "d"]);
    expect(world.failed).toHaveLength(1);
  });

  it("without assembly.models the endpoints still write the table while the snapshot stays static", async () => {
    const db = openDb(":memory:");
    const app = createApp({ db, authRuntime: fixedRuntime(() => FIXED_NOW) });
    try {
      const world = { app, cookies: { admin: await cookieFor(app, "lisi"), member: "" } };
      const created = await call(world, "admin", "POST", "/api/models", { id: "x" });
      expectAnswer(created, 201);
      expect(created.json()).toMatchObject({ id: "x", isDefault: true });
      expect(tableRows(db)).toEqual([expect.objectContaining({ id: "x", is_default: 1 })]);
      const options = await call(world, "admin", "GET", "/api/composer/options");
      expect((options.json() as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual(
        ["deepseek-v4.1-flash"],
      );
    } finally {
      await app.close();
      db.close();
    }
  });
});
