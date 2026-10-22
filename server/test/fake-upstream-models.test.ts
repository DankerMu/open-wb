/**
 * s1d-model-registry group 8 (task 8.2): the fake upstream's `GET /models` listing for probes
 * (model-proxy「假上游夹具契约」, scenario「Models listing for probes」). Oracles are the spec
 * delta's literals; nothing is read back from the fixture's own source.
 */
import { afterEach, describe, expect, it } from "vitest";
import { startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const handles: FakeUpstreamServer[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

const LISTING = { object: "list", data: [{ id: "fake-model", object: "model" }] };

async function get(
  handle: FakeUpstreamServer,
  path: string,
  authorization?: string,
): Promise<{ status: number; type: string | null; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${String(handle.port)}${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  });
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    body: await response.json(),
  };
}

describe("Models listing for probes", () => {
  it("answers 200 with the fixed list, 401 echoing the offered bearer, and records both", async () => {
    const handle = await startTrackedFakeUpstream(handles);
    expect(await get(handle, "/models", "Bearer fake")).toEqual({
      status: 200,
      type: "application/json",
      body: LISTING,
    });
    const rejected = await get(handle, "/v1/models", "Bearer leak-0001");
    expect(rejected.status).toBe(401);
    expect(rejected.type).toBe("application/json");
    expect((rejected.body as { error: { message: string } }).error.message).toBe(
      "bad key leak-0001",
    );
    expect(handle.modelsRequests()).toEqual([
      { authorization: "Bearer fake" },
      { authorization: "Bearer leak-0001" },
    ]);
  });

  it("answers a scripted modelsStatus with the scripted error body", async () => {
    const handle = await startTrackedFakeUpstream(handles, { modelsStatus: 503 });
    expect(await get(handle, "/models", "Bearer fake")).toEqual({
      status: 503,
      type: "application/json",
      body: { error: { message: "scripted models 503", type: "scripted_error" } },
    });
    expect(handle.modelsRequests()).toEqual([{ authorization: "Bearer fake" }]);
  });

  it("records a missing bearer as null and says none", async () => {
    const handle = await startTrackedFakeUpstream(handles);
    const rejected = await get(handle, "/models");
    expect(rejected.status).toBe(401);
    expect((rejected.body as { error: { message: string } }).error.message).toBe("bad key none");
    expect(handle.modelsRequests()).toEqual([{ authorization: null }]);
  });

  it("keeps chat-completions unchanged: its 401 does not echo and requests() stays empty", async () => {
    const handle = await startTrackedFakeUpstream(handles);
    await get(handle, "/models", "Bearer fake");
    const response = await fetch(`http://127.0.0.1:${String(handle.port)}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer leak-0001", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: "Unauthorized" } });
    expect(handle.requests()).toEqual([]);
    expect(handle.modelsRequests()).toEqual([{ authorization: "Bearer fake" }]);
  });

  it("serves no listing on other methods or paths", async () => {
    const handle = await startTrackedFakeUpstream(handles);
    const base = `http://127.0.0.1:${String(handle.port)}`;
    const post = await fetch(`${base}/models`, {
      method: "POST",
      headers: { authorization: "Bearer fake" },
    });
    const doubled = await fetch(`${base}/v1//models`, {
      headers: { authorization: "Bearer fake" },
    });
    expect([post.status, doubled.status]).toEqual([404, 404]);
    expect(handle.modelsRequests()).toEqual([]);
  });

  it.each([200, 399, 600, 503.5, "503"])("rejects modelsStatus %s at start", async (status) => {
    await expect(
      startTrackedFakeUpstream(handles, { modelsStatus: status as number }),
    ).rejects.toThrow("fake-upstream modelsStatus must be an integer 400-599");
  });
});
