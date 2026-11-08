/**
 * s2b-kb-retrieval tasks 5.2（#1914）：`probeModel` 的两种目标（design D7）。期望值取自 design D7 与实测记录 §19.4 的直连
 * 形状：嵌入 `POST <base>/embeddings`、body `{model, input:"ping"}`；重排 `POST <base>/rerank`、body
 * `{model, query:"ping", documents:["ping"]}`，2xx 且 `results[0].relevance_score` 为有限数字是 `ok`。假上游是
 * `fake-upstream.mjs` 的 `/embeddings` 与 `/rerank`；HTTP 层的嵌入用例在 `kb-settings-probe.test.ts`。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeModel } from "../src/kb/model-probe.js";
import { type FakeUpstreamServer, start } from "./support/fake-upstream.mjs";

const KEY = "probe-sentinel-probe";
const NO_SCORE = "响应不含重排分数";

let upstream: FakeUpstreamServer;
let baseUrl: string;

beforeEach(async () => {
  upstream = await start({ apiKey: KEY });
  baseUrl = `http://127.0.0.1:${String(upstream.port)}/v1`;
});

afterEach(async () => {
  await upstream.close();
});

const target = (name: string, apiKey = KEY) => ({ name, baseUrl, apiKey });

describe("嵌入目标", () => {
  it("POST <base>/embeddings，body 恰为 {model, input}，Bearer 是所给密钥：ok", async () => {
    expect(await probeModel("embedding", target("bge-m3"))).toEqual({
      status: "ok",
      message: null,
    });
    expect(upstream.embeddings.requests()).toEqual([
      { authorization: `Bearer ${KEY}`, body: { model: "bge-m3", input: "ping" } },
    ]);
    expect(upstream.rerank.requests()).toEqual([]);
  });

  it("2xx 但没有向量：沿用嵌入文案", async () => {
    upstream.embeddings.answer({ body: { data: [] } });
    expect(await probeModel("embedding", target("bge-m3"))).toEqual({
      status: "failed",
      message: "响应不含嵌入向量",
    });
  });
});

describe("重排目标", () => {
  it("POST <base>/rerank，body 恰为 {model, query, documents}，Bearer 是所给密钥：ok", async () => {
    expect(await probeModel("rerank", target("qwen3-rerank"))).toEqual({
      status: "ok",
      message: null,
    });
    expect(upstream.rerank.requests()).toEqual([
      {
        authorization: `Bearer ${KEY}`,
        body: { model: "qwen3-rerank", query: "ping", documents: ["ping"] },
      },
    ]);
    expect(upstream.embeddings.requests()).toEqual([]);
  });

  it("分数为 0 也是 ok", async () => {
    upstream.rerank.answer({ body: { results: [{ index: 0, relevance_score: 0 }] } });
    expect((await probeModel("rerank", target("qwen3-rerank"))).status).toBe("ok");
  });

  it.each<[string, unknown]>([
    ["缺 results", { usage: {} }],
    ["results 不是数组", { results: {} }],
    ["results 为空", { results: [] }],
    ["results[0] 不是对象", { results: [0.5] }],
    ["缺 relevance_score", { results: [{ index: 0 }] }],
    ["分数是字符串", { results: [{ relevance_score: "0.6" }] }],
    ["分数是 null", { results: [{ relevance_score: null }] }],
    ["分数溢出为 Infinity", '{"results":[{"relevance_score":1e999}]}'],
    ["不是 JSON", "<html>not json</html>"],
  ])("2xx 但 %s：failed，响应不含重排分数", async (_label, body) => {
    upstream.rerank.answer({ body });
    expect(await probeModel("rerank", target("qwen3-rerank"))).toEqual({
      status: "failed",
      message: NO_SCORE,
    });
  });

  it("超过 1 MiB 的 2xx 应答：failed，响应不含重排分数", async () => {
    const padding = "x".repeat(1_048_577);
    upstream.rerank.answer({ body: { results: [{ relevance_score: 0.5 }], padding } });
    expect(await probeModel("rerank", target("qwen3-rerank"))).toEqual({
      status: "failed",
      message: NO_SCORE,
    });
  });

  it("401：HTTP 401 开头，回显的密钥已净化", async () => {
    const leaked = "Snt1nelRejected1914Key";
    const result = await probeModel("rerank", target("qwen3-rerank", leaked));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/^HTTP 401：/u);
    expect(result.message).not.toContain(leaked);
  });

  it("503 model_not_found：HTTP 503 开头", async () => {
    upstream.rerank.answer({
      status: 503,
      body: { error: { code: "model_not_found", message: "no such model" } },
    });
    const result = await probeModel("rerank", target("missing-rerank"));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/^HTTP 503：/u);
    expect(result.message).toContain("model_not_found");
  });

  it("错误体含密钥与地址：message 两者都不含", async () => {
    upstream.rerank.answer({ status: 500, body: `key ${KEY} at ${baseUrl}/rerank broke` });
    const result = await probeModel("rerank", target("qwen3-rerank"));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/^HTTP 500：key /u);
    expect(result.message).not.toContain(KEY);
    expect(result.message).not.toContain(baseUrl);
  });

  it("上游挂起超过总期限：failed，超时", async () => {
    const gate = upstream.rerank.hold();
    const result = probeModel("rerank", target("qwen3-rerank"), { totalDeadlineMs: 50 });
    await gate.reached;
    expect(await result).toEqual({ status: "failed", message: "超时" });
  });

  it("上游不可达：failed，无法连接", async () => {
    await upstream.close();
    expect(await probeModel("rerank", target("qwen3-rerank"))).toEqual({
      status: "failed",
      message: "无法连接",
    });
  });
});
