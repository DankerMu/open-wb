/**
 * s1d-model-registry group 7 (task 7.2): model-registry「注册表写入不打断服务端任何东西、但该模型的下一次上游
 * 请求失败」through the admin endpoint. A real fake-omp child (`call-proxy`) posts the first `models.yml`
 * model to a standalone `/v1` — `registerModelProxy` on its own Fastify with an injected 3 s first-byte
 * deadline (createApp's own `/v1` takes none), sharing the app's `TokenRegistry` and the very registry
 * object createApp got as `assembly.models` — and the proxy forwards to the fake upstream, which holds
 * the `WORKBUDDY_FAKE_HANG` request open. The publisher's `proxyBaseUrl` is that proxy. Wired here after
 * `openProxiedApp` (`support/omp-official-proxied.ts`, gated on `WORKBUDDY_OMP_TEST`), not imported.
 * The 424 / 502 the proxy answers are pinned at the proxy layer (group 4); here only omp-visible outcomes.
 * Oracles: the spawn record and Node's exit state of the child, the fake upstream's request record,
 * the published events and the session row status.
 */
import type { AddressInfo } from "node:net";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/core/db/index.js";
import { handleHttpError } from "../src/http/errors.js";
import { registerModelProxy } from "../src/model-proxy/index.js";
import { deriveProxyBaseUrl, writeManagedModelsYml } from "../src/model-proxy/models-yml.js";
import { createPublisher } from "../src/models/publish.js";
import { createRegistry } from "../src/models/registry.js";
import { createModelStore } from "../src/models/store.js";
import { writeHostOverlay } from "../src/sessions/omp/host-overlay.js";
import { ompAgentDir } from "../src/sessions/omp/state-layout.js";
import { TokenRegistry } from "../src/sessions/tokens.js";
import { call, expectAnswer, putBody } from "./models-rest-helpers.js";
import { ofType, sessionEvents } from "./session-approval-helpers.js";
import { cookieFor, postPrompt } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  openRecordingSession,
  waitFor,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { isLive } from "./session-supervisor-pool-helpers.js";
import { start } from "./support/fake-upstream.mjs";

const FIRST_BYTE_MS = 3_000;
/** Low-entropy sentinel (gitleaks): the key the fake upstream expects for `m1`. */
const KEY = "wb-issue1649-inflight-api-key";

describe("注册表写入不打断服务端任何东西、但该模型的下一次上游请求失败", () => {
  it("PUT upstream:null while m1's request hangs: 200, nothing retired, the turn fails at the deadline; the next prompt fails without reaching the upstream", {
    timeout: 30_000,
  }, async () => {
    const upstream = await start({ apiKey: KEY });
    const baseUrl = `http://127.0.0.1:${String(upstream.port)}/v1`;
    const db = openDb(":memory:");
    const store = createModelStore(db);
    store.create({ id: "m1", upstream: { baseUrl, apiKey: KEY } });
    const registry = createRegistry(store);
    registry.refresh();
    const tokens = new TokenRegistry();
    const proxy = fastify({ logger: false });
    proxy.setErrorHandler((error, request, reply) => handleHttpError(error, request, reply));
    registerModelProxy(proxy, { tokens, models: registry, firstByteDeadlineMs: FIRST_BYTE_MS });
    await proxy.listen({ host: "127.0.0.1", port: 0 });
    const runtime = createRealFakeRuntime("call-proxy");
    const proxyBaseUrl = deriveProxyBaseUrl(proxy.server.address() as AddressInfo);
    const publisher = createPublisher({
      agentDir: ompAgentDir(runtime.runtime.stateDir),
      stateDir: runtime.runtime.stateDir,
      proxyBaseUrl: () => proxyBaseUrl,
      browserEnabled: false,
      registry,
      writeModelsYml: writeManagedModelsYml,
      writeOverlay: writeHostOverlay,
    });
    await publisher.publish();
    const world = await openRecordingSession(runtime.runtime, {
      db,
      tokens,
      assembly: { models: registry, publish: publisher.publish },
    });
    try {
      const { app } = world.fixture;
      const admin = { app, cookies: { admin: await cookieFor(app, "lisi"), member: "" } };
      const startedAt = Date.now();
      const hung = await postPrompt(
        app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "WORKBUDDY_FAKE_HANG" }),
      );
      expect(hung.statusCode).toBe(202);
      await waitFor(
        () => (upstream.requests().length === 1 ? true : undefined),
        "the hung upstream request",
      );
      const [child] = runtime.children;

      const cleared = await call(admin, "admin", "PUT", "/api/models?id=m1", putBody("m1", null));
      expectAnswer(cleared, 200);
      expect(cleared.json()).toMatchObject({ id: "m1", upstream: null });
      expect(upstream.requests()).toHaveLength(1);
      expect(runtime.calls).toHaveLength(1);
      expect(isLive(child)).toBe(true);

      await waitForTurn(world.fixture, world.session, "failed");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(FIRST_BYTE_MS);

      const next = await postPrompt(
        app,
        world.session,
        world.cookie,
        JSON.stringify({ message: "hello after the registry write" }),
      );
      expect(next.statusCode).toBe(202);
      await waitFor(
        () => (ofType(sessionEvents(world), "error").length === 2 ? true : undefined),
        "the second turn's error",
      );
      await waitForTurn(world.fixture, world.session, "failed");
      expect(upstream.requests()).toHaveLength(1);
      expect(runtime.calls).toHaveLength(1);
      expect(isLive(child)).toBe(true);
      const events = sessionEvents(world).map((entry) => entry.event.type);
      expect(events.filter((type) => type.startsWith("approval."))).toEqual([]);
      const detail = JSON.stringify(ofType(sessionEvents(world), "error")[1]);
      for (const leak of [KEY, baseUrl, String(upstream.port)]) {
        expect(detail).not.toContain(leak);
      }
      expect(world.errors).toEqual([]);
    } finally {
      await world.fixture.close();
      await proxy.close();
      await upstream.close();
    }
  });
});
