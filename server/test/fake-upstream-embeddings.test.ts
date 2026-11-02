/**
 * s2a-kb-ragflow tasks 8.2（#1844）：假上游的 `POST /embeddings`（design D7 的探活）。期望值是 ragflow-backend「探活」
 * 的字面量，不从夹具读回。
 */
import { afterEach, describe, expect, it } from "vitest";
import { startTrackedFakeUpstream } from "./fake-upstream-helpers.js";
import type { FakeUpstreamServer } from "./support/fake-upstream.mjs";

const handles: FakeUpstreamServer[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

const fresh = () => startTrackedFakeUpstream(handles, { apiKey: "embed-key" });

async function post(handle: FakeUpstreamServer, path = "/v1/embeddings", key = "embed-key") {
  const response = await fetch(`http://127.0.0.1:${String(handle.port)}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "bge-m3", input: "ping" }),
  });
  return { status: response.status, text: await response.text() };
}

describe("假上游的 /embeddings", () => {
  it("缺省回一个非空数字向量，并记录请求头与 body", async () => {
    const handle = await fresh();
    const { status, text } = await post(handle);
    expect(status).toBe(200);
    const [first] = (JSON.parse(text) as { data: { embedding: number[] }[] }).data;
    expect(first?.embedding.length).toBeGreaterThan(0);
    expect(handle.embeddings.requests()).toEqual([
      { authorization: "Bearer embed-key", body: { model: "bge-m3", input: "ping" } },
    ]);
  });

  it("/embeddings 与 /v1/embeddings 都在，别的路径不是", async () => {
    const handle = await fresh();
    expect((await post(handle, "/embeddings")).status).toBe(200);
    expect((await post(handle, "/v2/embeddings")).status).toBe(404);
  });

  it("answer() 排队，先登记的先生效，用完恢复缺省；字符串原样写出", async () => {
    const handle = await fresh();
    handle.embeddings.answer({ status: 500, body: { error: { message: "boom" } } });
    handle.embeddings.answer({ body: "not json" });
    expect((await post(handle)).status).toBe(500);
    expect((await post(handle)).text).toBe("not json");
    expect((await post(handle)).text).toContain("embedding");
  });

  it("密钥不对：401 回显收到的 bearer，且不消耗脚本", async () => {
    const handle = await fresh();
    handle.embeddings.answer({ status: 500 });
    const rejected = await post(handle, "/v1/embeddings", "leak-0002");
    expect(rejected).toMatchObject({ status: 401 });
    expect(rejected.text).toContain("leak-0002");
    expect((await post(handle)).status).toBe(500);
  });

  it("hold() 挂起下一个请求，release() 后照常应答", async () => {
    const handle = await fresh();
    const gate = handle.embeddings.hold();
    const pending = post(handle);
    await gate.reached;
    gate.release();
    expect((await pending).status).toBe(200);
  });

  it("夹具关闭时放掉挂起的请求", async () => {
    const handle = await fresh();
    const gate = handle.embeddings.hold();
    const pending = post(handle).catch(() => "closed");
    await gate.reached;
    await handle.close();
    await expect(pending).resolves.toBeDefined();
  });
});
