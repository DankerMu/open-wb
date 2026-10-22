/**
 * s1d-model-registry group 4: the proxy routes per model (model-proxy「透传端点与 bearer 鉴权」, design D5,
 * D6) — scenarios「Missing configuration after valid authentication」「Per-model routing」「The forwarding
 * route's own secrets are sanitised」「Lookup change does not touch an in-flight stream」, plus the
 * `staticRegistry` adapter and the `assembly.models` seam of `createApp`. The lookups here are hand-made
 * mutable tables (what the registry snapshot looks like to the proxy); their `secrets()` follows the
 * upstream-failure key-set rule through the independent `upstreamSecretList`.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/core/db/index.js";
import { upstreamSecretList } from "../src/core/upstream-failure.js";
import type { ModelCatalog } from "../src/model-catalog.js";
import { type ModelRegistry, type ModelRoute, staticRegistry } from "../src/model-proxy/lookup.js";
import type { createRegistry } from "../src/models/registry.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import {
  AGENT_UNAVAILABLE_ENVELOPE,
  BAD_REQUEST_ENVELOPE,
  expectFetchEnvelope,
  liveTokenTable,
  postCompletions,
  type RecordingUpstream,
  readRest,
  readUntilPrefix,
  startHeldSse,
  startRecordingUpstream,
  tokensFrom,
  useResources,
  withListeningProxy,
} from "./model-proxy-helpers.js";

const resources = useResources();
afterEach(async () => {
  vi.restoreAllMocks();
  await resources.closeAll();
});

const KEY_A = "wb-route-a-upstream-api-key";
const KEY_B = "wb-route-b-upstream-api-key";
const OWN_KEY = "wb-route-own-upstream-api-key";

function catalogOf(ids: readonly string[]): ModelCatalog {
  return {
    models: ids.map((id) => ({ id, name: id, reasoning: false, vision: false, maxTokens: 32768 })),
    defaultModelId: ids[0] ?? "",
  };
}

/** A mutable lookup as the proxy sees the registry: `secrets()` is every listed upstream's key set, now. */
function tableModels(table: Map<string, ModelRoute>): Pick<ModelRegistry, "lookup" | "secrets"> {
  return {
    lookup: (id) => table.get(id),
    secrets: () =>
      [...table.values()].flatMap(({ upstream }) =>
        upstream === undefined ? [] : upstreamSecretList({ ...upstream, paths: [] }),
      ),
  };
}

function options(models: Pick<ModelRegistry, "lookup" | "secrets">) {
  return { tokens: tokensFrom(liveTokenTable()), models };
}

async function answering(
  status: number,
  body: () => string,
  type = "text/plain",
): Promise<RecordingUpstream> {
  return resources.track(
    await startRecordingUpstream(({ response }) => {
      response.writeHead(status, { "content-type": type });
      response.end(body());
    }),
  );
}

async function excerptOf(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const parsed = (await response.json()) as { error: { message: string; param: string } };
  expect(parsed.error.param).toBe(`status.${String(status)}`);
  expect(parsed.error.message.startsWith(`模型服务返回 HTTP ${String(status)}：`)).toBe(true);
  return parsed.error.message;
}

describe("Missing configuration after valid authentication", () => {
  it("answers 502 for a registered model without upstream and 400 for an unregistered or malformed body", async () => {
    const models = staticRegistry(catalogOf(["m1"]), undefined);
    await withListeningProxy(options(models), async (origin) => {
      await expectFetchEnvelope(
        await postCompletions(origin, { body: '{"model":"m1"}' }),
        502,
        AGENT_UNAVAILABLE_ENVELOPE,
      );
      const unregistered = await postCompletions(origin, { body: '{"model":"gpt-unlisted"}' });
      const text = await unregistered.clone().text();
      await expectFetchEnvelope(unregistered, 400, BAD_REQUEST_ENVELOPE);
      expect(text).not.toContain("gpt-unlisted");
      await expectFetchEnvelope(
        await postCompletions(origin, { body: '{"messages":' }),
        400,
        BAD_REQUEST_ENVELOPE,
      );
    });
  });

  it("answers 502 without echoing it when the lookup itself throws, and keeps serving", async () => {
    let broken = true;
    const models = {
      lookup: (id: string) => {
        if (broken) {
          throw new Error(`registry fault ${id} ${KEY_A}`);
        }
        return undefined;
      },
      secrets: () => [],
    };
    await withListeningProxy(options(models), async (origin) => {
      const faulted = await postCompletions(origin, { body: '{"model":"m1"}' });
      const text = await faulted.clone().text();
      await expectFetchEnvelope(faulted, 502, AGENT_UNAVAILABLE_ENVELOPE);
      expect(text).not.toContain(KEY_A);
      broken = false;
      await expectFetchEnvelope(
        await postCompletions(origin, { body: '{"model":"m1"}' }),
        400,
        BAD_REQUEST_ENVELOPE,
      );
    });
  });
});

describe("Per-model routing", () => {
  it("sends each model to its own upstream and bearer and sanitises both upstreams' secrets", async () => {
    let baseA = "";
    let baseB = "";
    const upstreamA = await answering(200, () => '{"from":"A"}', "application/json");
    const upstreamB = await answering(500, () => [KEY_A, baseA, KEY_B, baseB].join("\n"));
    baseA = `${upstreamA.origin}/tenant-aaaaaaaaaa/v1`;
    baseB = `${upstreamB.origin}/tenant-bbbbbbbbbb/v1`;
    const table = new Map<string, ModelRoute>();
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    await withListeningProxy(options(tableModels(table)), async (origin) => {
      // Listed after registration: a key set captured when the proxy was built would miss both.
      table.set("m1", { upstream: { baseUrl: baseA, apiKey: KEY_A } });
      table.set("m2", { upstream: { baseUrl: baseB, apiKey: KEY_B } });
      const first = await postCompletions(origin, { body: '{"model":"m1"}' });
      expect(first.status).toBe(200);
      expect(await first.text()).toBe('{"from":"A"}');
      const message = await excerptOf(
        await postCompletions(origin, { body: '{"model":"m2"}' }),
        500,
      );
      for (const secret of [KEY_A, baseA, KEY_B, baseB]) {
        expect(message).not.toContain(secret);
      }
      expect(message).toContain("[已移除]");
    });
    expect(upstreamA.requests.map((r) => r.body.toString("utf8"))).toEqual(['{"model":"m1"}']);
    expect(upstreamA.requests[0]?.headers.authorization).toBe(`Bearer ${KEY_A}`);
    expect(upstreamA.requests[0]?.url).toBe("/tenant-aaaaaaaaaa/v1/chat/completions");
    expect(upstreamB.requests.map((r) => r.body.toString("utf8"))).toEqual(['{"model":"m2"}']);
    expect(upstreamB.requests[0]?.headers.authorization).toBe(`Bearer ${KEY_B}`);
    expect(upstreamB.requests[0]?.url).toBe("/tenant-bbbbbbbbbb/v1/chat/completions");
    const output = [...stdout.mock.calls, ...stderr.mock.calls].map(([chunk]) => String(chunk));
    for (const sentinel of [KEY_A, KEY_B]) {
      expect(output.join("")).not.toContain(sentinel);
    }
  });
});

describe("The forwarding route's own secrets are sanitised", () => {
  it("removes the route's key and base URL even when secrets() lists nothing", async () => {
    let base = "";
    const upstream = await answering(500, () => `${OWN_KEY}\n${base}`);
    base = `${upstream.origin}/own-tenant-0123456789/v1`;
    const models = {
      lookup: (id: string) =>
        id === "m1" ? { upstream: { baseUrl: base, apiKey: OWN_KEY } } : undefined,
      secrets: () => [],
    };
    await withListeningProxy(options(models), async (origin) => {
      const message = await excerptOf(
        await postCompletions(origin, { body: '{"model":"m1"}' }),
        500,
      );
      expect(message).not.toContain(OWN_KEY);
      expect(message).not.toContain(base);
      expect(message).not.toContain("own-tenant-0123456789");
    });
    expect(upstream.requests).toHaveLength(1);
  });
});

describe("Lookup change does not touch an in-flight stream", () => {
  it("streams the first request to the end from its upstream; the second, after removal, is 400", async () => {
    const first = Buffer.from("data: first\n\n");
    const rest = Buffer.from("data: second\n\ndata: [DONE]\n\n");
    const held = resources.track(await startHeldSse(first, rest));
    const table = new Map<string, ModelRoute>([
      ["m1", { upstream: { baseUrl: `${held.origin}/v1`, apiKey: KEY_A } }],
    ]);
    await withListeningProxy(options(tableModels(table)), async (origin) => {
      const body = '{"model":"m1","stream":true}';
      const streaming = await postCompletions(origin, { body });
      expect(streaming.status).toBe(200);
      const reader = streaming.body?.getReader();
      if (reader === undefined) {
        throw new Error("streaming response has no body");
      }
      const got = await readUntilPrefix(reader, first);
      table.delete("m1");
      await expectFetchEnvelope(await postCompletions(origin, { body }), 400, BAD_REQUEST_ENVELOPE);
      expect(held.requests).toHaveLength(1);
      held.release.resolve();
      const tail = await readRest(reader);
      expect(Buffer.concat([got.subarray(first.length), tail]).equals(rest)).toBe(true);
      expect(held.didFinish()).toBe(true);
    });
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]?.headers.authorization).toBe(`Bearer ${KEY_A}`);
  });
});

describe("staticRegistry", () => {
  const upstream = { baseUrl: "http://u:p4ss@gw.example/tenant-0123456789/v1", apiKey: "k-static" };

  it("routes whitelisted ids to the one upstream and refuses the rest", () => {
    const catalog = catalogOf(["m1", "m3"]);
    const registry = staticRegistry(catalog, upstream);
    expect(registry.lookup("m1")).toEqual({ upstream });
    expect(registry.lookup("m3")).toEqual({ upstream });
    expect(registry.lookup("m2")).toBeUndefined();
    expect(registry.lookup("M1")).toBeUndefined();
    expect(registry.secrets()).toEqual(upstreamSecretList({ ...upstream, paths: [] }));
    expect(registry.secrets()).toEqual(expect.arrayContaining(["k-static", upstream.baseUrl]));
    registry.refresh();
    expect(registry.current()).toBe(catalog);
  });

  it("without upstream answers {} with no upstream key and has no secrets", () => {
    const registry = staticRegistry(catalogOf(["m1"]), undefined);
    const route = registry.lookup("m1");
    expect(route).toEqual({});
    expect(Object.keys(route ?? { missing: true })).toEqual([]);
    expect(registry.lookup("m2")).toBeUndefined();
    expect(registry.secrets()).toEqual([]);
  });

  it("is the shape the group-3 registry object has", () => {
    expectTypeOf<ReturnType<typeof createRegistry>>().toMatchTypeOf<ModelRegistry>();
  });
});

describe("createApp hands assembly.models to the proxy", () => {
  it("routes by the supplied registry instead of the static single-model catalog", async () => {
    const upstream = await answering(202, () => "ok");
    const table = new Map<string, ModelRoute>([
      ["routed-only", { upstream: { baseUrl: `${upstream.origin}/v1`, apiKey: KEY_B } }],
    ]);
    const models: ModelRegistry = {
      ...tableModels(table),
      current: () => catalogOf(["routed-only"]),
      refresh: () => {},
    };
    const tokens = new TokenRegistry();
    const bearer = tokens.issue("runtime-live");
    const db = openDb(":memory:");
    const app = createApp({ db, assembly: { tokens, models } });
    try {
      const post = (model: string) =>
        app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          payload: JSON.stringify({ model }),
        });
      expect((await post("routed-only")).statusCode).toBe(202);
      const fallback = await post("deepseek-v4.1-flash");
      expect(fallback.statusCode).toBe(400);
      expect(fallback.json()).toEqual(BAD_REQUEST_ENVELOPE);
      expect(upstream.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY_B}`]);
    } finally {
      await app.close();
      db.close();
    }
  });
});
