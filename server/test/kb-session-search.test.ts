/**
 * s2c-kb-session tasks 2.2（#1963）：knowledge-bases「会话检索 `kb_search`」的五个场景（定义、两个库都命中、部分失败与不可探测、
 * 参数校验、中止），另加 `resolveReferences` 与「降级限频记录只有一份」（tasks.md「组 2 约定」；design D5）。
 *
 * 会话检索取自真实 `createApp` 里 `registerKb` 的返回值（对模块导出的透传 spy，照 `server-assembly-modules.test.ts`），
 * 真实 SQLite、真实客户端（缺省期限），对假 RAGFlow 跑（`kb-ingest-helpers.ts`：收尾断言 stdout / stderr 不含内容哨兵）。
 * 期望值是规格与「组 2 约定」的字面量与本文件种下的行，不从 `src/` 取。建库时间次序与 id 字典序相反（K1 > K2，K1 先建）。
 */
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as kb from "../src/kb/index.js";
import { resourceName } from "../src/kb/pipeline.js";
import { CONTENT_SENTINEL, type IngestWorld, useIngestWorlds } from "./kb-ingest-helpers.js";
import { RERANK_KEY } from "./kb-settings-helpers.js";
import { LISI, OWNER, WANGWU } from "./mounts-manager-helpers.js";
import { send } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();

const ROUTE = "POST /api/v1/retrieval";
const K1 = "b1".repeat(16);
const K2 = "a2".repeat(16);
const K3 = "c3".repeat(16);
const OTHER = "d4".repeat(16);
const QUESTION = "工单超时";
const PROMPT_MS = 3_000;
const SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    kb_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
  },
  required: ["question", "kb_ids"],
  additionalProperties: false,
};

type SessionSearch = NonNullable<ReturnType<typeof kb.registerKb>>["sessionSearch"];

let registered: MockInstance<typeof kb.registerKb>;

beforeEach(() => {
  registered = vi.spyOn(kb, "registerKb");
});

afterEach(() => {
  registered.mockRestore();
});

/** 开启的 `registerKb` 交回的会话检索。 */
function sessionSearch(): SessionSearch {
  const result = registered.mock.results.at(-1);
  if (result?.type !== "return" || result.value === null) {
    throw new Error("registerKb did not return a registration");
  }
  return result.value.sessionSearch;
}

interface BaseSeed {
  id: string;
  name: string;
  createdAt: number;
  ownerId?: string;
  state?: "ready" | "rebuilding";
  threshold?: number;
  vectorWeight?: number;
}

/** 直接插一行库并改建库时间、状态与检索参数，返回它的 dataset id。 */
function seedBase(world: IngestWorld, seed: BaseSeed): string {
  const datasetId = world.fake.addDataset(resourceName(seed.id, 0));
  world.store.createBase({
    id: seed.id,
    ownerId: seed.ownerId ?? OWNER,
    name: seed.name,
    template: "naive",
    raptor: false,
    graph: false,
    datasetId,
    canvasId: null,
    templateGroupId: null,
  });
  world.fw.world.db
    .prepare(
      "UPDATE knowledge_bases SET created_at = ?, state = ?, retrieval_threshold = ?, retrieval_vector_weight = ? WHERE id = ?",
    )
    .run(
      seed.createdAt,
      seed.state ?? "ready",
      seed.threshold ?? 0.2,
      seed.vectorWeight ?? 0.7,
      seed.id,
    );
  return datasetId;
}

interface Seeded {
  world: IngestWorld;
  search: SessionSearch;
  /** K1 / K2 的 dataset id。 */
  d1: string;
  d2: string;
}

/** zhangsan 的 产品文档（K1）、客服问答（K2）、旧版手册（K3，重建中）；lisi 的 别人的库（OTHER）。世界自带的那个库删掉。 */
async function seeded(): Promise<Seeded> {
  const world = await open();
  world.fw.world.db.prepare("DELETE FROM knowledge_bases WHERE id = ?").run(world.baseId);
  const d1 = seedBase(world, {
    id: K1,
    name: "产品文档",
    createdAt: 1_000,
    threshold: 0.35,
    vectorWeight: 0.5,
  });
  const d2 = seedBase(world, { id: K2, name: "客服问答", createdAt: 2_000 });
  seedBase(world, { id: K3, name: "旧版手册", createdAt: 3_000, state: "rebuilding" });
  seedBase(world, { id: OTHER, name: "别人的库", createdAt: 500, ownerId: LISI });
  return { world, search: sessionSearch(), d1, d2 };
}

const retrievals = (world: IngestWorld) =>
  world.fake.requests().filter((entry) => `${entry.method} ${entry.path}` === ROUTE);

const basesTable = (world: IngestWorld) =>
  world.fw.world.db.prepare("SELECT * FROM knowledge_bases ORDER BY id").all();

const auditCount = (world: IngestWorld) =>
  Number(world.fw.world.db.prepare("SELECT COUNT(*) AS n FROM audit_events").get()?.n);

function addDocument(world: IngestWorld, kbId: string, ragflowDocumentId: string, name: string) {
  return world.store.addDocument({ kbId, ragflowDocumentId, name, size: 3, source: "upload" }).id;
}

describe("定义", () => {
  it("描述末尾按建库时间升序逐行列库，库清单同序；没有库的账号没有定义；不访问 RAGFlow", async () => {
    const { world, search } = await seeded();
    const definition = search.definitionFor(OWNER);
    expect(Object.keys(definition ?? {})).toEqual(["tool", "bases"]);
    const tool = definition?.tool;
    expect(Object.keys(tool ?? {})).toEqual([
      "name",
      "label",
      "description",
      "parameters",
      "loadMode",
    ]);
    expect(tool).toStrictEqual({
      name: "kb_search",
      label: "知识库检索",
      description: expect.any(String),
      parameters: SCHEMA,
      loadMode: "essential",
    });
    const lines = tool?.description.split("\n") ?? [];
    expect(lines.slice(-3)).toEqual([
      `- 产品文档（${K1}）`,
      `- 客服问答（${K2}）`,
      `- 旧版手册（${K3}）`,
    ]);
    expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(3);
    for (const point of ["切片", "出处", "5 个", "6 条", "改写问句", "再次调用"]) {
      expect(tool?.description).toContain(point);
    }
    expect(definition?.bases).toStrictEqual([
      { id: K1, name: "产品文档" },
      { id: K2, name: "客服问答" },
      { id: K3, name: "旧版手册" },
    ]);
    expect(search.definitionFor(WANGWU)).toBeNull();
    expect(world.fake.requests()).toEqual([]);
  });
});

describe("两个库都命中", () => {
  it("两次并发检索各带本库 dataset 与已存参数，文本逐字节，details 键序固定，不写库不审计，切片不进日志", async () => {
    const { world, search, d1, d2 } = await seeded();
    const spec = addDocument(world, K1, "rf-spec", "规格.md");
    const manual = addDocument(world, K1, "rf-manual", "手册.pdf");
    const faq = addDocument(world, K2, "rf-faq", "faq.md");
    world.fake.setRetrievalHits(d1, [
      { documentId: "rf-spec", content: `超时 30 分钟 ${CONTENT_SENTINEL}`, similarity: 0.123456 },
      { documentId: "rf-manual", content: "第二段\n续行", similarity: 0.5 },
    ]);
    world.fake.setRetrievalHits(d2, [
      { documentId: "rf-faq", content: "客服答复", similarity: 0.9 },
    ]);
    const before = basesTable(world);
    const audits = auditCount(world);
    const gate = world.fake.fault(ROUTE, { kind: "hold" }, { times: 2 });
    const pending = search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1, K2] },
      new AbortController().signal,
    );
    await gate.reached;
    await expect.poll(() => retrievals(world).length).toBe(2);
    gate.release();
    const result = await pending;

    expect(Object.keys(result)).toEqual(["text", "details", "isError"]);
    expect(result.text).toBe(
      [
        `知识库「产品文档」（${K1}）：命中 2 条`,
        "[1] 规格.md（相似度 0.1235）",
        `超时 30 分钟 ${CONTENT_SENTINEL}`,
        "[2] 手册.pdf（相似度 0.5000）",
        "第二段\n续行",
        "",
        `知识库「客服问答」（${K2}）：命中 1 条`,
        "[1] faq.md（相似度 0.9000）",
        "客服答复",
      ].join("\n"),
    );
    expect(result.isError).toBe(false);
    expect(result.details).toStrictEqual({
      bases: [
        {
          kbId: K1,
          name: "产品文档",
          status: "ok",
          hits: [
            {
              documentId: spec,
              name: "规格.md",
              similarity: 0.123456,
              content: `超时 30 分钟 ${CONTENT_SENTINEL}`,
            },
            { documentId: manual, name: "手册.pdf", similarity: 0.5, content: "第二段\n续行" },
          ],
        },
        {
          kbId: K2,
          name: "客服问答",
          status: "ok",
          hits: [{ documentId: faq, name: "faq.md", similarity: 0.9, content: "客服答复" }],
        },
      ],
    });
    const bases = result.details?.bases ?? [];
    expect(bases.map((entry) => Object.keys(entry))).toEqual([
      ["kbId", "name", "status", "hits"],
      ["kbId", "name", "status", "hits"],
    ]);
    expect(Object.keys(bases[0]?.hits[0] ?? {})).toEqual([
      "documentId",
      "name",
      "similarity",
      "content",
    ]);
    const bodies = retrievals(world).map(({ json }) => json);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        {
          question: QUESTION,
          dataset_ids: [d1],
          similarity_threshold: 0.35,
          vector_similarity_weight: 0.5,
          page: 1,
          page_size: 6,
        },
        {
          question: QUESTION,
          dataset_ids: [d2],
          similarity_threshold: 0.2,
          vector_similarity_weight: 0.7,
          page: 1,
          page_size: 6,
        },
      ]),
    );
    expect(basesTable(world)).toEqual(before);
    expect(auditCount(world)).toBe(audits);
    expect(JSON.stringify(world.logged)).not.toContain(CONTENT_SENTINEL);
  });
});

describe("部分失败与不可探测", () => {
  it("k1 检索失败、不存在与别人的库同一句、重建中的库不检索：isError，只有 k1 一次检索", async () => {
    const { world, search, d1 } = await seeded();
    world.fake.fault(ROUTE, { kind: "status", status: 503 });
    const result = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1, "nope", OTHER, K3] },
      new AbortController().signal,
    );
    expect(result).toStrictEqual({
      text: [
        `知识库「产品文档」（${K1}）：检索失败`,
        "",
        "知识库 nope：未找到该知识库",
        "",
        `知识库 ${OTHER}：未找到该知识库`,
        "",
        `知识库「旧版手册」（${K3}）：正在重建，本轮未检索`,
      ].join("\n"),
      details: {
        bases: [
          { kbId: K1, name: "产品文档", status: "failed", hits: [] },
          { kbId: "nope", name: null, status: "not_found", hits: [] },
          { kbId: OTHER, name: null, status: "not_found", hits: [] },
          { kbId: K3, name: "旧版手册", status: "not_ready", hits: [] },
        ],
      },
      isError: true,
    });
    expect(result.text).not.toContain("别人的库");
    expect(retrievals(world).map(({ json }) => json)).toMatchObject([{ dataset_ids: [d1] }]);
  });

  it("同一调用里 k1 正常命中零条：isError 为假，k1 一段「命中 0 条」", async () => {
    const { search } = await seeded();
    const result = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1, "nope", OTHER, K3] },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.text.split("\n\n")[0]).toBe(`知识库「产品文档」（${K1}）：命中 0 条`);
    expect(result.details?.bases[0]).toStrictEqual({
      kbId: K1,
      name: "产品文档",
      status: "ok",
      hits: [],
    });
  });
});

describe("参数校验", () => {
  const six = [K1, K2, K3, OTHER, "n1", "n2"];
  const invalid: Array<[string, unknown]> = [
    ["缺 kb_ids", { question: QUESTION }],
    ["多一个键 top_k", { question: QUESTION, kb_ids: [K1], top_k: 3 }],
    ["kb_ids 为空数组", { question: QUESTION, kb_ids: [] }],
    ["kb_ids 含空串", { question: QUESTION, kb_ids: [""] }],
    ["去重后六个", { question: QUESTION, kb_ids: [...six, K1] }],
    ["question 只有空白", { question: "   ", kb_ids: [K1] }],
    ["question 1001 码点", { question: "字".repeat(1001), kb_ids: [K1] }],
  ];

  it.each(invalid)("%s：isError，没有 details 键，零请求", async (_label, args) => {
    const { world, search } = await seeded();
    const result = await search.execute(OWNER, args, new AbortController().signal);
    expect(Object.keys(result)).toEqual(["text", "isError"]);
    expect(result.isError).toBe(true);
    expect(result.text).not.toBe("");
    expect(world.fake.requests()).toEqual([]);
  });

  it("去重后六个：文本恰为「一次至多检索 5 个知识库」", async () => {
    const { search } = await seeded();
    const result = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [...six, K2] },
      new AbortController().signal,
    );
    expect(result).toStrictEqual({ text: "一次至多检索 5 个知识库", isError: true });
  });

  it("kb_ids 重复：先去重再计数，六个原始 id 去重后五个照常执行；[k1,k1] 只检索一次", async () => {
    const { world, search } = await seeded();
    const five = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1, K1, "n1", "n2", "n3", "n4"] },
      new AbortController().signal,
    );
    expect(five.isError).toBe(false);
    expect(five.details?.bases.map(({ kbId }) => kbId)).toEqual([K1, "n1", "n2", "n3", "n4"]);
    const twice = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1, K1] },
      new AbortController().signal,
    );
    expect(twice.details?.bases).toHaveLength(1);
    expect(retrievals(world)).toHaveLength(2);
  });
});

describe("中止", () => {
  it("挂起时中止：该库 failed 一行、isError，恰一条请求且连接被放弃，立即结束", async () => {
    const { world, search } = await seeded();
    const gate = world.fake.fault(ROUTE, { kind: "hold" });
    const controller = new AbortController();
    const started = performance.now();
    const pending = search.execute(OWNER, { question: QUESTION, kb_ids: [K1] }, controller.signal);
    await gate.reached;
    controller.abort();
    await expect(pending).resolves.toStrictEqual({
      text: `知识库「产品文档」（${K1}）：检索失败`,
      details: { bases: [{ kbId: K1, name: "产品文档", status: "failed", hits: [] }] },
      isError: true,
    });
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    await expect.poll(() => retrievals(world)[0]?.closed).toBe(true);
    expect(retrievals(world)).toHaveLength(1);
  });
});

describe("resolveReferences", () => {
  it("都是自己的库按输入次序给 {id,name}（非 ready 照样）；任一不存在或属于别人都为 null；重复原样；不访问 RAGFlow", async () => {
    const { world, search } = await seeded();
    expect(search.resolveReferences(OWNER, [K3, K1])).toStrictEqual([
      { id: K3, name: "旧版手册" },
      { id: K1, name: "产品文档" },
    ]);
    expect(search.resolveReferences(OWNER, [K1, K1])).toStrictEqual([
      { id: K1, name: "产品文档" },
      { id: K1, name: "产品文档" },
    ]);
    expect(search.resolveReferences(OWNER, [K1, "nope"])).toBeNull();
    expect(search.resolveReferences(OWNER, [K1, OTHER])).toBeNull();
    expect(world.fake.requests()).toEqual([]);
  });
});

describe("降级限频记录只有一份", () => {
  it("会话检索与检索测试端点各降级一次，60 秒内只记一行 kb_rerank_degraded", async () => {
    const { world, search } = await seeded();
    world.store.saveSettings({
      rerank: {
        name: "qwen3-rerank",
        baseUrl: "http://rerank.upstream.test/v1",
        apiKey: RERANK_KEY,
      },
    });
    world.fake.addModel("owb-rerank", "qwen3-rerank", "rerank");
    world.fake.failRerank();
    const result = await search.execute(
      OWNER,
      { question: QUESTION, kb_ids: [K1] },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    const response = await send(world.fw.rest, "member", "POST", `/api/kb/bases/${K1}/retrieval`, {
      question: QUESTION,
      threshold: 0.35,
      vectorWeight: 0.5,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(retrievals(world)).toHaveLength(4);
    expect(world.logged.filter((record) => isDegraded(record))).toHaveLength(1);
  });
});

function isDegraded(record: unknown): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    (record as { event?: unknown }).event === "kb_rerank_degraded"
  );
}
