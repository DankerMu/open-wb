/**
 * s1d-model-registry group 7 (task 7.2): model-registry「发布字节等于启动写出」on the compiled production
 * entry — the entry's own publisher (`server.ts` hands `publisher.publish` and `writeRecord` to createApp)
 * rewrites both managed files after an admin registers a vision model, and a restart over the same table
 * writes the same bytes. Also the eighth startup module (`models`) and that the registered key and base
 * URL reach neither the files nor the entry's stdout / stderr. The restart reuses the main port: the
 * proxy URL in `models.yml` is derived from it.
 *
 * #1711: model-registry「发布失败不回滚」on the same compiled entry — with the agent dir replaced by a
 * regular file, an admin create answers the generic 500, the row stays, and the entry's stderr is exactly
 * the one record `writeRecord` writes for `onPublishFailed`. Audit retention is left to
 * `models-rest.test.ts` (the entry does not touch that path).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { hostOverlayVisionBlock } from "./omp-layout-helpers.js";
import {
  type CompiledServerEntry,
  compiledFixtureEnv,
  compileServerEntry,
  releaseStartupFixtures,
  type StartedServer,
  startCompiledServer,
} from "./server-startup-helpers.js";
import { startCompiledServerWithRetry } from "./server-startup-retry.js";

const EIGHT_MODULES = [
  "core/db",
  "auth",
  "http",
  "model-proxy",
  "sessions",
  "workspaces",
  "accounts",
  "models",
];
/** Low-entropy sentinels (gitleaks); the base URL host is never contacted. */
const KEY = "wb-issue1649-restart-api-key";
const BASE = "http://127.0.0.1:9/wb-issue1649-restart-tenant/v1";
const FAILED_KEY = "wb-issue1711-api-key";
const FAILED_BASE = "http://127.0.0.1:9/wb-issue1711-tenant/v1";
const SQLITE_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n\(Use `node[^\n]*\n/u;

let compiled: CompiledServerEntry;
const scratch: string[] = [];

beforeAll(async () => {
  compiled = await compileServerEntry();
}, 90_000);

afterAll(async () => {
  await releaseStartupFixtures();
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agentDir(root: string): string {
  return join(root, "state", "home", ".omp", "agent");
}

function files(root: string): { models: string; overlay: string } {
  const agent = agentDir(root);
  return {
    models: readFileSync(join(agent, "models.yml"), "utf8"),
    overlay: readFileSync(join(agent, "host-overlay.yml"), "utf8"),
  };
}

async function adminCookie(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "lisi", password: "demo" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.slice(0, cookie.indexOf(";"));
}

async function stopped(server: StartedServer): Promise<string> {
  try {
    expect(await server.stop()).toBe(0);
    return server.stderr().replace(SQLITE_WARNING, "");
  } finally {
    await server.dispose();
  }
}

describe("model-registry「发布字节等于启动写出」on the compiled entry", () => {
  it("registering vision m3 rewrites models.yml and the overlay; a restart over the same table writes the same bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-wb-models-restart-"));
    scratch.push(root);
    const bin = join(root, "bin", "omp");
    const seed = { MODEL_CATALOG: JSON.stringify([{ id: "m1" }]), MODEL_ID: "m1" };
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (free) => ({
      env: compiledFixtureEnv(root, free, bin, seed),
    }));
    let registered: { models: string; overlay: string };
    let firstStderr: string;
    try {
      expect(await server.waitForStarted()).toMatchObject({ modules: EIGHT_MODULES });
      expect(files(root).overlay).not.toContain("modelRoles");
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/models`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await adminCookie(port) },
        body: JSON.stringify({ id: "m3", vision: true, upstream: { baseUrl: BASE, apiKey: KEY } }),
      });
      expect(response.status).toBe(201);
      expect(await response.text()).not.toContain(KEY);
      registered = files(root);
      const parsed = parse(registered.models) as {
        providers: { workbuddy: { models: Array<{ id: string }> } };
      };
      expect(parsed.providers.workbuddy.models.map((model) => model.id)).toEqual(["m1", "m3"]);
      expect(registered.overlay.endsWith(hostOverlayVisionBlock("m3"))).toBe(true);
    } finally {
      firstStderr = await stopped(server);
    }
    expect(firstStderr).toBe("");

    const restarted = startCompiledServer(compiled.entry, compiledFixtureEnv(root, port, bin, {}));
    let secondStderr: string;
    try {
      expect(await restarted.waitForStarted()).toMatchObject({ modules: EIGHT_MODULES });
      expect(files(root)).toEqual(registered);
    } finally {
      secondStderr = await stopped(restarted);
    }
    expect(secondStderr).toBe("");
    for (const text of [registered.models, registered.overlay]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(BASE);
    }
    for (const output of [
      server.stdout(),
      server.stderr(),
      restarted.stdout(),
      restarted.stderr(),
    ]) {
      expect(output).not.toContain(KEY);
      expect(output).not.toContain("wb-issue1649-restart-tenant");
    }
  }, 120_000);
});

describe("model-registry「发布失败不回滚」on the compiled entry", () => {
  it("with the agent dir replaced by a file, a create is a generic 500, the row stays, and stderr is exactly one model_publish_failed record", async () => {
    const root = mkdtempSync(join(tmpdir(), "open-wb-models-publish-failed-"));
    scratch.push(root);
    const bin = join(root, "bin", "omp");
    const seed = { MODEL_CATALOG: JSON.stringify([{ id: "m1" }]), MODEL_ID: "m1" };
    const { server, port } = await startCompiledServerWithRetry(compiled.entry, (free) => ({
      env: compiledFixtureEnv(root, free, bin, seed),
    }));
    let stderr: string;
    try {
      expect(await server.waitForStarted()).toMatchObject({ modules: EIGHT_MODULES });
      const agent = agentDir(root);
      rmSync(agent, { recursive: true, force: true });
      writeFileSync(agent, "");
      const cookie = await adminCookie(port);
      const failed = await fetch(`http://127.0.0.1:${String(port)}/api/models`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ id: "c", upstream: { baseUrl: FAILED_BASE, apiKey: FAILED_KEY } }),
      });
      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe('{"error":{"message":"服务器内部错误"}}');
      const listed = await fetch(`http://127.0.0.1:${String(port)}/api/models`, {
        headers: { cookie },
      });
      expect(listed.status).toBe(200);
      const { models } = (await listed.json()) as { models: Array<{ id: string }> };
      expect(models.map((model) => model.id)).toEqual(["m1", "c"]);
    } finally {
      stderr = await stopped(server);
    }
    expect(stderr).toBe('{"event":"model_publish_failed"}\n');
    for (const output of [server.stdout(), server.stderr()]) {
      expect(output).not.toContain(FAILED_KEY);
      expect(output).not.toContain("wb-issue1711-tenant");
    }
  }, 120_000);
});
