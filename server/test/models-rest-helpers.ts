/**
 * s1d-model-registry group 7 (task 7.2): the whole mount of the admin model endpoints
 * (model-registry「模型管理端点」「变更即发布」). createApp gets `assembly.models` = a real registry on the
 * app's own database and `assembly.publish` = `createPublisher(...).publish` with the real writers on a
 * temp state dir (the production publisher minus the entry's stage wrapper); `onPublishFailed`
 * collects its records. The seed row routes to a fake upstream, so a case can show that no request
 * reached it. Oracles: spec literals, the table, `core/audit` `query` and the written files.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, expect } from "vitest";
import { parse } from "yaml";
import { type AssemblyDependencies, createApp } from "../src/app.js";
import { query } from "../src/core/audit/index.js";
import { openDb } from "../src/core/db/index.js";
import type { ModelCatalog } from "../src/model-catalog.js";
import { writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { createPublisher } from "../src/models/publish.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
import { writeHostOverlay } from "../src/sessions/omp/host-overlay.js";
import { ensureOmpStateLayout, ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { FIXED_NOW, fixedRuntime } from "./session-db-helpers.js";
import { cookieFor } from "./session-rest-helpers.js";
import { type FakeUpstreamServer, start } from "./support/fake-upstream.mjs";

const PROXY_BASE = "http://127.0.0.1:18016/v1";
/** Low-entropy sentinel (gitleaks): the seed row's key at the fake upstream. */
export const FAKE_KEY = "wb-issue1649-fake-upstream-key";
export const FORBIDDEN = { error: { code: "forbidden", message: "没有权限执行此操作" } };
export const UNAUTHORIZED = { error: { code: "unauthorized", message: "请先登录" } };
export const BAD_REQUEST = { error: { code: "bad_request", message: "请求格式不正确" } };
export const NOT_FOUND = { error: { code: "not_found", message: "请求的资源不存在" } };
export const CONFLICT = { error: { code: "conflict", message: "同名资源已存在" } };
export const MODEL_IN_USE = {
  error: { code: "model_in_use", message: "该模型是缺省模型，先把缺省换成别的模型" },
};
/** `handleHttpError`'s generic 5xx body: no `code`, so not a typed envelope. */
export const GENERIC_500 = { error: { message: "服务器内部错误" } };
/** The `ModelView` key set (model-registry「模型管理端点」), sorted. */
export const VIEW_KEYS = [
  "efforts",
  "id",
  "isDefault",
  "maxTokens",
  "name",
  "probe",
  "reasoning",
  "updatedAt",
  "upstream",
  "vision",
];

/** One non-vision, non-reasoning seed row `m1` (the default). */
const SEED_M1: ModelCatalog = {
  models: [{ id: "m1", name: "m1", reasoning: false, vision: false, maxTokens: 32768 }],
  defaultModelId: "m1",
};

type PublishFailedRecord = Parameters<NonNullable<AssemblyDependencies["onPublishFailed"]>>[0];

export interface ModelsWorld {
  app: FastifyInstance;
  db: DatabaseSync;
  store: ReturnType<typeof createModelStore>;
  stateDir: string;
  upstream: FakeUpstreamServer;
  /** The model ids of every `models.yml` rewrite since the world opened (the startup one excluded). */
  writes: string[][];
  /** Whatever reached `assembly.onPublishFailed` (no `mcpPublish` here, so only model records). */
  failed: PublishFailedRecord[];
  cookies: { admin: string; member: string };
}

const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of opened.splice(0).reverse()) await close();
});

interface WorldOptions {
  seed?: ModelCatalog;
  /** The seed rows' upstream; omitted → the fake upstream with `FAKE_KEY`. */
  seedUpstream?: { baseUrl?: string; apiKey?: string };
  /** `assembly.probeDeadlines` (group 8: a 1 s total deadline makes `超时` testable). */
  probeDeadlines?: { connectDeadlineMs?: number; totalDeadlineMs?: number };
}

export async function openModelsWorld(options: WorldOptions = {}): Promise<ModelsWorld> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "models-rest-")));
  const stateDir = join(root, "state");
  ensureOmpStateLayout(stateDir);
  const upstream = await start({ apiKey: FAKE_KEY });
  const db = openDb(":memory:");
  const store = createModelStore(db);
  store.seedIfEmpty(
    options.seed ?? SEED_M1,
    options.seedUpstream ?? {
      baseUrl: `http://127.0.0.1:${String(upstream.port)}/v1`,
      apiKey: FAKE_KEY,
    },
  );
  const registry = createRegistry(store);
  registry.refresh();
  const writes: string[][] = [];
  let recording = false;
  const publisher = createPublisher({
    agentDir: ompAgentDir(stateDir),
    stateDir,
    proxyBaseUrl: () => PROXY_BASE,
    browserEnabled: false,
    registry,
    writeModelsYml: (dir, models) => {
      if (recording) writes.push(models.models.map((model) => model.id));
      return writeManagedModelsYml(dir, models);
    },
    writeOverlay: writeHostOverlay,
  });
  // The entry's startup publication (`models_yml` / `host_overlay`).
  await publisher.publish();
  recording = true;
  const failed: PublishFailedRecord[] = [];
  const app = createApp({
    db,
    authRuntime: fixedRuntime(() => FIXED_NOW),
    assembly: {
      runtime: {
        bin: join(root, "omp"),
        sandboxRoot: join(root, "sandbox"),
        stateDir,
        modelId: "m1",
        idleMs: 600_000,
      },
      models: registry,
      publish: publisher.publish,
      onPublishFailed: (record) => {
        failed.push(record);
      },
      ...(options.probeDeadlines === undefined ? {} : { probeDeadlines: options.probeDeadlines }),
    },
  });
  opened.push(async () => {
    await app.close();
    db.close();
    await upstream.close();
    rmSync(root, { recursive: true, force: true });
  });
  const cookies = { admin: await cookieFor(app, "lisi"), member: await cookieFor(app, "zhangsan") };
  return { app, db, store, stateDir, upstream, writes, failed, cookies };
}

/** A raw body with its media type (malformed JSON, `text/plain`). */
export interface RawBody {
  raw: string;
  type: string;
}

export type Who = "admin" | "member" | "anonymous";

export function call(
  world: Pick<ModelsWorld, "app" | "cookies">,
  who: Who,
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = who === "anonymous" ? {} : { cookie: world.cookies[who] };
  if (body === undefined) {
    return world.app.inject({ method, url, headers });
  }
  const raw = isRaw(body) ? body : { raw: JSON.stringify(body), type: "application/json" };
  return world.app.inject({
    method,
    url,
    headers: { ...headers, "content-type": raw.type },
    payload: raw.raw,
  });
}

function isRaw(body: unknown): body is RawBody {
  return typeof body === "object" && body !== null && "raw" in body && "type" in body;
}

/** Status, exact JSON body and `Cache-Control: no-store` in one go. */
export function expectAnswer(
  response: LightMyRequestResponse,
  status: number,
  body?: unknown,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  if (body !== undefined) {
    expect(response.json()).toEqual(body);
  }
}

export function tableRows(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT * FROM models ORDER BY created_at, id")
    .all()
    .map((row) => ({ ...row }));
}

/** Every `model.*` audit event, oldest first, as the admin audit view reads them. */
export function modelAudits(db: DatabaseSync) {
  return query(db, { id: "u3", role: "管理员" }, { limit: 200 })
    .filter((event) => event.kind.startsWith("model."))
    .reverse()
    .map(({ actorId, kind, title, detail, workspaceId }) => ({
      actorId,
      kind,
      title,
      detail,
      workspaceId,
    }));
}

/** The model entries of the managed `models.yml`, parsed. */
export function managedModels(stateDir: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(ompAgentDir(stateDir), "models.yml"), "utf8");
  const parsed = parse(text) as {
    providers: { workbuddy: { models: Array<Record<string, unknown>> } };
  };
  return parsed.providers.workbuddy.models;
}

export function managedIds(stateDir: string): unknown[] {
  return managedModels(stateDir).map((model) => model.id);
}

/** A full `PUT` body for a model that keeps `name` and the three defaults. */
export function putBody(name: string, upstream: unknown, extra: Record<string, unknown> = {}) {
  return { name, reasoning: false, vision: false, maxTokens: 32768, upstream, ...extra };
}
