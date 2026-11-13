/**
 * s2c-kb-session tasks 1.2（#1962）：单轮检索可取消（knowledge-bases「单轮检索」的「中止」；ragflow-backend「RAGFlow 出站请求」
 * 的检索中止；design D6）。直接调 `retrieveForBase`，真实 SQLite 的库行与设置、真实客户端（缺省期限），对假 RAGFlow 跑。
 *
 * 期望值是两份规格与 tasks.md「组 1 约定」的字面量：中止与期限到期同为 `kb_unavailable`；挂起时中止放弃连接（假 RAGFlow 的
 * `closed`）且不重试；调用前已中止不发请求；降级重试前中止只有带重排的那一次请求。不从 `src/` 取期望值。
 */
import { describe, expect, it } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { retrieveForBase } from "../src/kb/retrieval.js";
import { type IngestWorld, RAGFLOW_KEY, useIngestWorlds } from "./kb-ingest-helpers.js";
import { RERANK_KEY } from "./kb-settings-helpers.js";

const open = useIngestWorlds();

const ROUTE = "POST /api/v1/retrieval";
const RERANK_ID = "qwen3-rerank@owb-rerank@OpenAI-API-Compatible";
const UNAVAILABLE = { kind: "kb_unavailable" };
/** 缺省总期限 30 s 的零头：挂起时中止须立即结束。 */
const PROMPT_MS = 3_000;

/** 配置了名为 `qwen3-rerank` 的重排模型，且假 RAGFlow 的账号里有它：不 `failRerank` 时带重排的检索能成功。 */
async function rerankWorld(): Promise<IngestWorld> {
  const world = await open();
  world.store.saveSettings({
    rerank: { name: "qwen3-rerank", baseUrl: "http://rerank.upstream.test/v1", apiKey: RERANK_KEY },
  });
  world.fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
  return world;
}

/** 假 RAGFlow 按到达次序收到的检索请求。 */
const retrievals = (world: IngestWorld) =>
  world.fake.requests().filter((entry) => `${entry.method} ${entry.path}` === ROUTE);

/** 经 `retrieveForBase` 检索一次；`onDegraded` 在降级回调里调用，其余与生产接线相同（缺省期限）。 */
function retrieveWith(world: IngestWorld, signal: AbortSignal, onDegraded: () => void = () => {}) {
  const base = world.store.getBase(world.baseId);
  if (base === undefined) {
    throw new Error("world has no base row");
  }
  let degraded = 0;
  const onRerankDegraded = () => {
    degraded += 1;
    onDegraded();
  };
  const key = { read: () => RAGFLOW_KEY };
  const client = createRagflowClient({ baseUrl: world.fake.baseUrl, key, log: () => {} });
  const pending = retrieveForBase(
    { store: world.store, client, onRerankDegraded },
    base,
    "退款时效",
    signal,
  );
  return { pending, degraded: () => degraded };
}

describe("中止（knowledge-bases「单轮检索」；ragflow-backend「RAGFlow 出站请求」）", () => {
  it("挂起时中止：立即 kb_unavailable，恰一条带 rerank_id 的请求，连接被放弃，没有降级重试", async () => {
    const world = await rerankWorld();
    const gate = world.fake.fault(ROUTE, { kind: "hold" });
    const controller = new AbortController();
    const started = performance.now();
    const { pending, degraded } = retrieveWith(world, controller.signal);
    await gate.reached;
    controller.abort();
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    await expect.poll(() => retrievals(world)[0]?.closed).toBe(true);
    const sent = retrievals(world);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.json).toMatchObject({ rerank_id: RERANK_ID });
    expect(degraded()).toBe(0);
  });

  it("调用前已中止：kb_unavailable，检索路由零请求", async () => {
    const world = await rerankWorld();
    const { pending, degraded } = retrieveWith(world, AbortSignal.abort());
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(retrievals(world)).toEqual([]);
    expect(degraded()).toBe(0);
  });

  it("降级重试前中止：kb_unavailable，只有带重排的那一次请求，降级恰记一次", async () => {
    const world = await rerankWorld();
    world.fake.failRerank();
    const controller = new AbortController();
    const { pending, degraded } = retrieveWith(world, controller.signal, () => {
      controller.abort();
    });
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    const sent = retrievals(world);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.json).toMatchObject({ rerank_id: RERANK_ID });
    expect(degraded()).toBe(1);
  });
});
