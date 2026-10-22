/**
 * s1d-model-registry group 8 (task 8.2): `POST /api/models/probe?id=` through the whole mount
 * (model-registry「探活」「模型管理端点」), and `probeUpstream` on its own for the one case the mount
 * cannot reach (the probed route's own key missing from `registry.secrets()`). Oracles: the spec
 * literals, the table, `core/audit` `query`, the fake upstream's `modelsRequests()`, the
 * test-local listeners' connection records, the `writes` recorder and `models.yml`'s mtime.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { probeUpstream } from "../src/models/probe.js";
import { ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { closedPort, countingServer, holdServer, scriptedServer } from "./models-probe-helpers.js";
import {
  BAD_REQUEST,
  call,
  expectAnswer,
  FAKE_KEY,
  FORBIDDEN,
  type ModelsWorld,
  modelAudits,
  NOT_FOUND,
  openModelsWorld,
  tableRows,
  UNAUTHORIZED,
  VIEW_KEYS,
} from "./models-rest-helpers.js";
import { start } from "./support/fake-upstream.mjs";

/** Low-entropy sentinels (gitleaks); neither starts with `sk-` nor `Bearer` (`redact` drops those anyway). */
const PROBE_KEY = "wb-issue1650-probe-api-key";
const OTHER_KEY = "wb-issue1650-other-api-key";
const SENTINELS = [FAKE_KEY, PROBE_KEY, OTHER_KEY];
const TIMEOUT_DEADLINES = { totalDeadlineMs: 1000 };

/** Every base URL a row was registered with in the running test. */
const baseUrls: string[] = [];
let outputs: Array<MockInstance<typeof process.stdout.write>> = [];
beforeEach(() => {
  baseUrls.length = 0;
  outputs = [vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
});
afterEach(() => {
  const written = outputs.flatMap((spy) => spy.mock.calls.map((args) => String(args[0])));
  for (const spy of outputs) spy.mockRestore();
  const text = written.join("");
  for (const secret of [...SENTINELS, ...baseUrls]) expect(text).not.toContain(secret);
});

const local = (port: number, path = "/v1") => `http://127.0.0.1:${String(port)}${path}`;
const fakeBase = (world: ModelsWorld) => local(world.upstream.port);

async function addModel(
  world: ModelsWorld,
  id: string,
  upstream?: { baseUrl: string; apiKey: string },
): Promise<void> {
  if (upstream !== undefined) baseUrls.push(upstream.baseUrl);
  const body = upstream === undefined ? { id } : { id, upstream };
  expectAnswer(await call(world, "admin", "POST", "/api/models", body), 201);
}

const probeUrl = (id: string) => `/api/models/probe?id=${encodeURIComponent(id)}`;
const probeAudits = (world: ModelsWorld) =>
  modelAudits(world.db).filter((event) => event.kind === "model.probe");

/** No secret in a response body; no probed base URL in its `probe.message`. */
function expectClean(response: LightMyRequestResponse): void {
  for (const secret of SENTINELS) expect(response.body).not.toContain(secret);
  if (response.statusCode !== 200) return;
  const { message } = (response.json() as { probe: { message: string | null } }).probe;
  for (const url of baseUrls) expect(message ?? "").not.toContain(url);
}

/** One admin probe: no `models.yml` rewrite (recorder and mtime), body clean; returns the answer. */
async function probe(world: ModelsWorld, id: string): Promise<LightMyRequestResponse> {
  const file = join(ompAgentDir(world.stateDir), "models.yml");
  const writes = world.writes.length;
  const mtime = statSync(file).mtimeMs;
  const response = await call(world, "admin", "POST", probeUrl(id));
  expect(world.writes.length).toBe(writes);
  expect(statSync(file).mtimeMs).toBe(mtime);
  expectClean(response);
  return response;
}

/** 200 `ModelView` with the expected probe, `at` within the call, and the table agrees. */
function expectProbed(
  world: ModelsWorld,
  id: string,
  response: LightMyRequestResponse,
  window: { from: number; to: number },
  expected: { status: "ok" | "failed"; message: string | null },
): void {
  expectAnswer(response, 200);
  const view = response.json() as { probe: { status: string; at: number; message: string } };
  expect(Object.keys(view).sort()).toEqual(VIEW_KEYS);
  expect(view.probe).toEqual({ ...expected, at: view.probe.at });
  expect(view.probe.at).toBeGreaterThanOrEqual(window.from);
  expect(view.probe.at).toBeLessThanOrEqual(window.to);
  const row = world.db
    .prepare("SELECT probe_status, probe_message, probe_at FROM models WHERE id = ?")
    .get(id);
  expect({ ...row }).toEqual({
    probe_status: expected.status,
    probe_message: expected.message,
    probe_at: view.probe.at,
  });
}

async function timed<T>(work: () => Promise<T>): Promise<{ value: T; from: number; to: number }> {
  const from = Date.now();
  const value = await work();
  return { value, from, to: Date.now() };
}

describe("次序与 no-store", () => {
  it("401 / 403 / 400 / 404 / bodyless 400 before any upstream contact; nothing changes", async () => {
    const world = await openModelsWorld();
    const before = tableRows(world.db);
    const cases: Array<[LightMyRequestResponse, number, unknown]> = [
      [await call(world, "anonymous", "POST", probeUrl("m1")), 401, UNAUTHORIZED],
      [await call(world, "member", "POST", probeUrl("m1")), 403, FORBIDDEN],
      [await call(world, "member", "POST", "/api/models/probe"), 403, FORBIDDEN],
      [await call(world, "admin", "POST", "/api/models/probe"), 400, BAD_REQUEST],
      [await call(world, "admin", "POST", "/api/models/probe?id="), 400, BAD_REQUEST],
      [await call(world, "admin", "POST", "/api/models/probe?id=m1&id=m1"), 400, BAD_REQUEST],
      [await call(world, "admin", "POST", probeUrl("nope")), 404, NOT_FOUND],
      [await call(world, "admin", "POST", probeUrl("m1"), {}), 400, BAD_REQUEST],
    ];
    for (const [response, status, body] of cases) expectAnswer(response, status, body);
    expect(world.upstream.modelsRequests()).toEqual([]);
    expect(probeAudits(world)).toEqual([]);
    expect(tableRows(world.db)).toEqual(before);
  });
});

describe("四种结果与无上游", () => {
  it("ok / HTTP 401 / 无法连接 / 超时 / 未配置上游, one model.probe audit each", async () => {
    const world = await openModelsWorld({ probeDeadlines: TIMEOUT_DEADLINES });
    const hold = await holdServer();
    await addModel(world, "bad", { baseUrl: fakeBase(world), apiKey: PROBE_KEY });
    await addModel(world, "down", { baseUrl: local(await closedPort()), apiKey: OTHER_KEY });
    await addModel(world, "hang", { baseUrl: local(hold.port), apiKey: OTHER_KEY });
    await addModel(world, "bare");
    const cases: Array<[string, "ok" | "failed", string | null]> = [
      ["m1", "ok", null],
      ["bad", "failed", 'HTTP 401：{"error":{"message":"bad key [已移除]"}}'],
      ["down", "failed", "无法连接"],
      ["hang", "failed", "超时"],
      ["bare", "failed", "未配置上游"],
    ];
    const expectedAudits: unknown[] = [];
    for (const [id, status, message] of cases) {
      const { value, from, to } = await timed(() => probe(world, id));
      expectProbed(world, id, value, { from, to }, { status, message });
      expectedAudits.push({
        actorId: "u3",
        kind: "model.probe",
        title: `探活模型 ${id}`,
        detail: { modelId: id, status },
        workspaceId: null,
      });
      expect(probeAudits(world)).toEqual(expectedAudits);
    }
    expect(world.upstream.modelsRequests()).toEqual([
      { authorization: `Bearer ${FAKE_KEY}` },
      { authorization: `Bearer ${PROBE_KEY}` },
    ]);
    expect(hold.openBefore).toEqual([0]);
  });

  it("a base URL ending in / is probed at …/v1/models, not …/v1//models", async () => {
    const world = await openModelsWorld();
    await addModel(world, "slash", { baseUrl: `${fakeBase(world)}/`, apiKey: FAKE_KEY });
    const { value, from, to } = await timed(() => probe(world, "slash"));
    expectProbed(world, "slash", value, { from, to }, { status: "ok", message: null });
    expect(world.upstream.modelsRequests()).toEqual([{ authorization: `Bearer ${FAKE_KEY}` }]);
  });

  it("a 302 is not followed: failed with HTTP 302 and no connection to its Location", async () => {
    const world = await openModelsWorld();
    const target = await countingServer();
    const port = await scriptedServer((response) => {
      response.writeHead(302, { location: local(target.port, "/v1/models") });
      response.end("moved");
    });
    await addModel(world, "moved", { baseUrl: local(port), apiKey: OTHER_KEY });
    const { value, from, to } = await timed(() => probe(world, "moved"));
    expectProbed(
      world,
      "moved",
      value,
      { from, to },
      { status: "failed", message: "HTTP 302：moved" },
    );
    expect(target.connections()).toBe(0);
  });

  it("a long 500 body: the excerpt is cut to 200 code points without splitting a surrogate pair", async () => {
    const world = await openModelsWorld();
    const port = await scriptedServer((response) => {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(`${"a".repeat(100)}${"😀".repeat(400)}`);
    });
    await addModel(world, "long", { baseUrl: local(port), apiKey: OTHER_KEY });
    const { value, from, to } = await timed(() => probe(world, "long"));
    const excerpt = `${"a".repeat(100)}${"😀".repeat(94)}…（已截断）`;
    expect(Array.from(excerpt)).toHaveLength(200);
    expectProbed(
      world,
      "long",
      value,
      { from, to },
      { status: "failed", message: `HTTP 500：${excerpt}` },
    );
  });
});

describe("probeUpstream", () => {
  const closing: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });

  it("the probed route's own key is redacted even when the caller's secrets omit it", async () => {
    const upstream = await start();
    closing.push(() => upstream.close());
    const baseUrl = local(upstream.port);
    baseUrls.push(baseUrl);
    const result = await probeUpstream({ baseUrl, apiKey: PROBE_KEY }, { secrets: [] });
    expect(result).toEqual({
      status: "failed",
      message: 'HTTP 401：{"error":{"message":"bad key [已移除]"}}',
    });
    expect(upstream.modelsRequests()).toEqual([{ authorization: `Bearer ${PROBE_KEY}` }]);
  });

  it("a request that cannot be built (a key no header may carry) is 无法连接, sent nowhere", async () => {
    const target = await countingServer();
    const result = await probeUpstream(
      { baseUrl: local(target.port), apiKey: "wb-issue1650\nkey" },
      { secrets: [] },
    );
    expect(result).toEqual({ status: "failed", message: "无法连接" });
    expect(target.connections()).toBe(0);
  });

  it("the total deadline firing while a non-2xx body is still being read is 超时", async () => {
    const port = await scriptedServer((response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.write("partial");
    });
    const result = await probeUpstream(
      { baseUrl: local(port), apiKey: OTHER_KEY },
      { secrets: [], totalDeadlineMs: 300 },
    );
    expect(result).toEqual({ status: "failed", message: "超时" });
  });

  it("a 2xx settles ok without waiting for its body to end", async () => {
    const port = await scriptedServer((response) => {
      response.writeHead(204);
      response.end();
    });
    const endless = await scriptedServer((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    const deadlines = { secrets: [], totalDeadlineMs: 2000 };
    for (const baseUrl of [local(port), local(endless)]) {
      const { value, from, to } = await timed(() =>
        probeUpstream({ baseUrl, apiKey: OTHER_KEY }, deadlines),
      );
      expect(value).toEqual({ status: "ok", message: null });
      expect(to - from).toBeLessThan(2000);
    }
  });
});

describe("并发串行", () => {
  it("two probes of one id run one after the other; two ids overlap", async () => {
    const world = await openModelsWorld({ probeDeadlines: TIMEOUT_DEADLINES });
    const hold = await holdServer();
    await addModel(world, "hang", { baseUrl: local(hold.port), apiKey: OTHER_KEY });
    await addModel(world, "hang2", { baseUrl: local(hold.port), apiKey: PROBE_KEY });

    const same = await Promise.all([probe(world, "hang"), probe(world, "hang")]);
    const at = same.map((response) => {
      expectAnswer(response, 200);
      const view = response.json() as { probe: { status: string; at: number; message: string } };
      expect([view.probe.status, view.probe.message]).toEqual(["failed", "超时"]);
      return view.probe.at;
    });
    const [first = 0, second = 0] = [...at].sort((a, b) => a - b);
    expect(second).toBeGreaterThanOrEqual(first + 900);
    expect(hold.openBefore).toEqual([0, 0]);

    const both = await Promise.all([probe(world, "hang"), probe(world, "hang2")]);
    for (const response of both) expectAnswer(response, 200);
    expect(hold.openBefore).toEqual([0, 0, 0, 1]);
    expect(probeAudits(world)).toHaveLength(4);
  });
});

describe("在途删除", () => {
  it("DELETE while the probe is in flight: 204, then the probe is 404 and leaves no audit", async () => {
    const world = await openModelsWorld({ probeDeadlines: TIMEOUT_DEADLINES });
    const hold = await holdServer();
    await addModel(world, "hang", { baseUrl: local(hold.port), apiKey: OTHER_KEY });
    const pending = call(world, "admin", "POST", probeUrl("hang"));
    await hold.accepted(1);
    expectAnswer(await call(world, "admin", "DELETE", "/api/models?id=hang"), 204);
    const response = await pending;
    expectAnswer(response, 404, NOT_FOUND);
    expectClean(response);
    expect(world.store.get("hang")).toBeUndefined();
    expect(probeAudits(world)).toEqual([]);
  });
});
