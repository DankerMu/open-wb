/**
 * s2b-kb-retrieval tasks 7.1（#1920）：检索带重排与自动降级（ragflow-backend「RAGFlow 出站请求」的「重排降级」「检索失败的映射」
 * 「超时不降级」；knowledge-bases「单轮检索」的「带重排」；design D2、D3）。经 `createApp` + `app.inject()` 打检索测试端点，
 * 真实 SQLite，假 RAGFlow（`kb-ingest-helpers.ts`），时钟注入。
 *
 * 期望值是 spec、design 与 tasks.md「组 7 约定」的字面量，以及本文件种下的行；不从 `src/` 取期望值。每次检索的 body 都与库里
 * 已存的参数相同，走快路径：不拿锁、不写回、不审计。另有两例直接调 `retrieveForBase`（S2c 会话内检索的接入点）：重排的读取
 * 与降级都在它里面，不在检索测试端点里。
 */
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { createRagflowClient } from "../src/kb/ragflow-client.js";
import { retrieveForBase } from "../src/kb/retrieval.js";
import {
  type IngestWorld,
  MESSAGE_SENTINEL,
  RAGFLOW_KEY,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE, RERANK_KEY } from "./kb-settings-helpers.js";
import { KB_REJECTED } from "./kb-upload-helpers.js";
import { auditRows, send } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();

const ROUTE = "POST /api/v1/retrieval";
const RERANK_NAME = "qwen3-rerank";
const RERANK_ID = "qwen3-rerank@owb-rerank@OpenAI-API-Compatible";
const RERANK_BASE_URL = "http://rerank.upstream.test/v1";
const DEGRADED = { event: "kb_rerank_degraded" };
const QUESTION = { question: "退款时效", threshold: 0.2, vectorWeight: 0.7 };
const START = 1_800_000_000_000;

let clock = START;

/** 世界的时钟由用例推进；`extra` 并进 `KbDependencies`。 */
function openAt(extra: Parameters<typeof open>[0] = {}): Promise<IngestWorld> {
  clock = START;
  return open({ kb: { now: () => clock, ...extra.kb } });
}

/** 配置重排模型；`resolvable` 为真时在假 RAGFlow 的账号里种下这个模型，带它的检索才能成功。 */
function configureRerank(world: IngestWorld, resolvable: boolean): void {
  world.store.saveSettings({
    rerank: { name: RERANK_NAME, baseUrl: RERANK_BASE_URL, apiKey: RERANK_KEY },
  });
  if (resolvable) {
    world.fake.addModel("owb-rerank", RERANK_NAME, "rerank");
  }
}

const search = (world: IngestWorld, baseId = world.baseId): Promise<LightMyRequestResponse> =>
  send(world.fw.rest, "member", "POST", `/api/kb/bases/${baseId}/retrieval`, QUESTION);

/** 假 RAGFlow 按到达次序收到的检索 body。 */
function sentBodies(world: IngestWorld): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  for (const entry of world.fake.requests()) {
    if (`${entry.method} ${entry.path}` === ROUTE) {
      bodies.push(entry.json as Record<string, unknown>);
    }
  }
  return bodies;
}

/** D2 的六个键，`dataset_ids` 取给定的数据集。 */
const plainBody = (datasetId: string) => ({
  question: "退款时效",
  dataset_ids: [datasetId],
  similarity_threshold: 0.2,
  vector_similarity_weight: 0.7,
  page: 1,
  page_size: 6,
});

function expectError(response: LightMyRequestResponse, status: number, envelope: unknown): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json()).toEqual(envelope);
  expect(response.body).not.toContain(MESSAGE_SENTINEL);
}

/** 种两份本地文档与指向它们的两条切片，返回期望的命中。 */
function seedTwoHits(world: IngestWorld) {
  const add = (ragflowDocumentId: string, name: string) =>
    world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId,
      name,
      size: 3,
      source: "upload",
    });
  const refund = add("rf-refund", "refund.md");
  const policy = add("rf-policy", "policy.md");
  world.fake.setRetrievalHits(world.datasetId, [
    { documentId: "rf-refund", content: "退款七日内", similarity: 0.66 },
    { documentId: "rf-policy", content: "时效以到账为准", similarity: 0.41 },
  ]);
  return [
    { documentId: refund.id, name: "refund.md", similarity: 0.66, content: "退款七日内" },
    { documentId: policy.id, name: "policy.md", similarity: 0.41, content: "时效以到账为准" },
  ];
}

/** 直接调 `retrieveForBase`：世界的 store、真实客户端与计数的降级回调。 */
async function retrieveDirectly(world: IngestWorld) {
  let degraded = 0;
  const deps = {
    store: world.store,
    client: createRagflowClient({
      baseUrl: world.fake.baseUrl,
      key: { read: () => RAGFLOW_KEY },
      log: () => {},
    }),
    onRerankDegraded: () => {
      degraded += 1;
    },
  };
  const base = world.store.getBase(world.baseId);
  if (base === undefined) {
    throw new Error("world has no base row");
  }
  const result = await retrieveForBase(deps, base, "退款时效");
  return { result, degraded };
}

/** 每一对的第二次恰为第一次去掉 `rerank_id`。 */
function expectPairs(bodies: Record<string, unknown>[]): void {
  for (let index = 0; index < bodies.length; index += 2) {
    const { rerank_id: rerankId, ...rest } = bodies[index] ?? {};
    const second = bodies[index + 1] ?? {};
    expect(rerankId).toBe(RERANK_ID);
    expect(second).toEqual(rest);
    expect(Object.hasOwn(second, "rerank_id")).toBe(false);
  }
}

describe("带重排（knowledge-bases「单轮检索」）", () => {
  it("配置了 qwen3-rerank：200，恰一次请求，body 为 D2 六键加 rerank_id，没有降级记录，密钥不外泄", async () => {
    const world = await openAt();
    configureRerank(world, true);
    const response = await search(world);
    expect(response.statusCode, response.body).toBe(200);
    expect(sentBodies(world)).toEqual([{ ...plainBody(world.datasetId), rerank_id: RERANK_ID }]);
    expect(world.logged).toEqual([]);
    expect(JSON.stringify(sentBodies(world))).not.toContain(RERANK_KEY);
    expect(response.body).not.toContain(RERANK_KEY);
  });

  it("重排探活失败：照样带 rerank_id", async () => {
    const world = await openAt();
    configureRerank(world, true);
    const identity = { name: RERANK_NAME, baseUrl: RERANK_BASE_URL, apiKey: RERANK_KEY };
    world.store.recordRerankProbe(identity, { status: "failed", at: START, message: null });
    expect((await search(world)).statusCode).toBe(200);
    expect(sentBodies(world).map((body) => body.rerank_id)).toEqual([RERANK_ID]);
  });

  it("每次检索读一次设置：清除重排之后的下一次检索恰一次请求，没有 rerank_id 键", async () => {
    const world = await openAt();
    configureRerank(world, true);
    expect((await search(world)).statusCode).toBe(200);
    world.store.saveSettings({ rerank: null });
    expect((await search(world)).statusCode).toBe(200);
    const bodies = sentBodies(world);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.rerank_id).toBe(RERANK_ID);
    expect(Object.hasOwn(bodies[1] ?? {}, "rerank_id")).toBe(false);
  });
});

describe("重排降级（ragflow-backend「RAGFlow 出站请求」）", () => {
  it("带 rerank_id 回 102：连续三次都 200 且各两条命中，每次恰两次请求，恰一行降级记录，没有审计", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.failRerank(MESSAGE_SENTINEL);
    const hits = seedTwoHits(world);
    const audits = auditRows(world.fw.world).length;
    for (const _ of [1, 2, 3]) {
      const response = await search(world);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ hits, retrieval: { threshold: 0.2, vectorWeight: 0.7 } });
      expect(response.body).not.toContain(MESSAGE_SENTINEL);
    }
    const bodies = sentBodies(world);
    expect(bodies).toHaveLength(6);
    expectPairs(bodies);
    expect(world.logged).toEqual([DEGRADED]);
    expect(auditRows(world.fw.world)).toHaveLength(audits);
  });

  it("限流：59 999 ms 后再降级仍是一行，再过 1 ms 变为两行", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.failRerank(MESSAGE_SENTINEL);
    expect((await search(world)).statusCode).toBe(200);
    clock += 59_999;
    expect((await search(world)).statusCode).toBe(200);
    expect(world.logged).toEqual([DEGRADED]);
    clock += 1;
    expect((await search(world)).statusCode).toBe(200);
    expect(world.logged).toEqual([DEGRADED, DEGRADED]);
    expectPairs(sentBodies(world));
  });

  it("限流是进程级的：两个库在 60 秒内各降级一次，恰一行", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.failRerank(MESSAGE_SENTINEL);
    const other = world.addBase("naive");
    expect((await search(world)).statusCode).toBe(200);
    clock += 30_000;
    expect((await search(world, other.baseId)).statusCode).toBe(200);
    expect(world.logged).toEqual([DEGRADED]);
    const bodies = sentBodies(world);
    expect(bodies.map((body) => body.dataset_ids)).toEqual([
      [world.datasetId],
      [world.datasetId],
      [other.datasetId],
      [other.datasetId],
    ]);
    expectPairs(bodies);
  });
});

describe("检索失败的映射（收窄后）", () => {
  it("配置了重排，带与不带 rerank_id 都回 102：503 kb_unavailable，恰两次请求，第二次不带键，一行降级记录", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.fault(ROUTE, { kind: "combo", code: 102, message: MESSAGE_SENTINEL }, { times: 2 });
    expectError(await search(world), 503, KB_UNAVAILABLE);
    const bodies = sentBodies(world);
    expect(bodies).toHaveLength(2);
    expectPairs(bodies);
    expect(world.logged).toEqual([DEGRADED]);
  });

  it("配置了重排，带 rerank_id 回 102、重试回 101：400 kb_rejected，恰两次请求，一行降级记录", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.fault(ROUTE, { kind: "combo", code: 102, message: MESSAGE_SENTINEL });
    world.fake.fault(ROUTE, { kind: "combo", code: 101, message: MESSAGE_SENTINEL });
    expectError(await search(world), 400, KB_REJECTED);
    const bodies = sentBodies(world);
    expect(bodies).toHaveLength(2);
    expectPairs(bodies);
    expect(world.logged).toEqual([DEGRADED]);
  });

  it("未配置重排，回 102：503，恰一次请求，没有降级记录", async () => {
    const world = await openAt();
    world.fake.fault(ROUTE, { kind: "combo", code: 102, message: MESSAGE_SENTINEL });
    expectError(await search(world), 503, KB_UNAVAILABLE);
    expect(sentBodies(world)).toEqual([plainBody(world.datasetId)]);
    expect(world.logged).toEqual([]);
  });
});

describe("retrieveForBase 直接调用（S2c 的接入点）", () => {
  it("配置了重排：发出的 body 带字面量 rerank_id，没有降级", async () => {
    const world = await openAt();
    configureRerank(world, true);
    const { result, degraded } = await retrieveDirectly(world);
    expect(result).toEqual({ kind: "ok", value: [] });
    expect(sentBodies(world)).toEqual([{ ...plainBody(world.datasetId), rerank_id: RERANK_ID }]);
    expect(degraded).toBe(0);
  });

  it("带 rerank_id 回 102：结果为两条命中，恰两次请求，第二次不带键，降级回调恰一次", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.failRerank(MESSAGE_SENTINEL);
    const hits = seedTwoHits(world);
    const { result, degraded } = await retrieveDirectly(world);
    expect(result).toEqual({ kind: "ok", value: hits });
    const bodies = sentBodies(world);
    expect(bodies).toHaveLength(2);
    expectPairs(bodies);
    expect(degraded).toBe(1);
  });
});

describe("不重试（配置了重排）", () => {
  it("回 101：400 kb_rejected，恰一次请求（带 rerank_id），没有降级记录", async () => {
    const world = await openAt();
    configureRerank(world, false);
    world.fake.fault(ROUTE, { kind: "combo", code: 101 });
    expectError(await search(world), 400, KB_REJECTED);
    expect(sentBodies(world).map((body) => body.rerank_id)).toEqual([RERANK_ID]);
    expect(world.logged).toEqual([]);
  });

  it("超时不降级：挂起带 rerank_id 的检索超过总期限，503，恰一次请求，没有降级记录", async () => {
    const world = await openAt({ kb: { deadlines: { totalMs: 50 } } });
    configureRerank(world, false);
    world.fake.fault(ROUTE, { kind: "hang" });
    expectError(await search(world), 503, KB_UNAVAILABLE);
    expect(sentBodies(world).map((body) => body.rerank_id)).toEqual([RERANK_ID]);
    expect(world.logged).toEqual([]);
  });
});
