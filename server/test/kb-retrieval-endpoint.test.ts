/**
 * s2b-kb-retrieval tasks 4.4（#1918）：`POST /api/kb/bases/:id/retrieval`（knowledge-bases「检索测试端点」「同一知识库的写操作串行」
 * 的检索写回、「知识库审计」的 `kb.retrieval_settings` 与哨兵问句一支、「知识库端点」的检索路由所有权；http-service-skeleton
 * 「统一错误信封」的归属路由；design D4）。经 `createApp` + `app.inject()`，真实 SQLite，打假 RAGFlow（`kb-ingest-helpers.ts`）。
 *
 * 期望值是 spec、design 与 tasks.md「组 4 第二刀约定」的字面量，以及本文件种下的行；不从 `src/` 取期望值。锁的注入照
 * `kb-bases-delete.test.ts`：用例经 `holdWriteLock` 以写者或重建器的身份持有该库的写锁，读等待者计数确认请求已在排队。
 */
import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  BAD_REQUEST,
  type IngestWorld,
  NOT_FOUND,
  REBUILDING,
  UPLOAD,
  useIngestWorlds,
} from "./kb-ingest-helpers.js";
import { KB_UNAVAILABLE } from "./kb-settings-helpers.js";
import { holdWriteLock } from "./kb-upload-helpers.js";
import { OWNER } from "./mounts-manager-helpers.js";
import { padded, send } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();

const ROUTE = "POST /api/v1/retrieval";
const DELETE_DATASETS = "DELETE /api/v1/datasets";
const KIND = "kb.retrieval_settings";
const TITLE = "修改检索参数";
const GENERIC_500 = { error: { message: "服务器内部错误" } };
const ABSENT_ID = "f".repeat(32);
const SENTINEL = "question-sentinel-question";
const STORED = { threshold: 0.2, vectorWeight: 0.7 };
const SAME = { question: "销售额", ...STORED };
const CHANGED = { question: "销售额", threshold: 0.1, vectorWeight: 0.9 };
const REFUSE_COLUMNS =
  "CREATE TRIGGER refuse_retrieval BEFORE UPDATE OF retrieval_threshold ON knowledge_bases BEGIN SELECT RAISE(ABORT, 'refuse'); END";
const REFUSE_AUDIT = `CREATE TRIGGER refuse_audit BEFORE INSERT ON audit_events WHEN NEW.kind = '${KIND}' BEGIN SELECT RAISE(ABORT, 'injected'); END`;

type Who = "admin" | "member" | "anonymous";

interface PostOptions {
  who?: Who;
  baseId?: string;
}

const post = (
  world: IngestWorld,
  body: unknown,
  options: PostOptions = {},
): Promise<LightMyRequestResponse> =>
  send(
    world.fw.rest,
    options.who ?? "member",
    "POST",
    `/api/kb/bases/${options.baseId ?? world.baseId}/retrieval`,
    body,
  );

/** 假 RAGFlow 收到的检索请求的 JSON body，按到达次序。 */
const retrievals = (world: IngestWorld): unknown[] =>
  world.fake
    .requests()
    .filter(({ method, path }) => `${method} ${path}` === ROUTE)
    .map(({ json }) => json);

/** 该库的两列检索参数与 `updated_at`，直接读行。 */
function storedOf(world: IngestWorld, id = world.baseId) {
  const row = world.fw.world.db
    .prepare(
      "SELECT retrieval_threshold, retrieval_vector_weight, updated_at FROM knowledge_bases WHERE id = ?",
    )
    .get(id);
  return {
    threshold: Number(row?.retrieval_threshold),
    vectorWeight: Number(row?.retrieval_vector_weight),
    updatedAt: Number(row?.updated_at),
  };
}

const auditOf = (before: typeof STORED, after: typeof STORED, id: string) => ({
  actorId: OWNER,
  title: TITLE,
  detail: { id, before, after },
  workspaceId: null,
});

function expectAnswer(response: LightMyRequestResponse, status: number, body: unknown): void {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json()).toEqual(body);
}

/** 400 `bad_request`，零个 RAGFlow 请求，没有审计。 */
function expectRefused(world: IngestWorld, response: LightMyRequestResponse): void {
  expectAnswer(response, 400, BAD_REQUEST);
  expect(world.lines()).toEqual([]);
  expect(world.audits(KIND)).toEqual([]);
}

const waitForWaiters = (world: IngestWorld, count: number) =>
  vi.waitFor(() => {
    expect(world.locks.writeWaiters(world.baseId)).toBe(count);
  });

describe("参数不变只检索", () => {
  it("命中透传：一条本地文档的切片与一条未知 document_id，200 恰为 {hits, retrieval}，不写库不审计", async () => {
    const world = await open();
    const before = storedOf(world);
    const doc = world.store.addDocument({
      kbId: world.baseId,
      ragflowDocumentId: "rf-local",
      name: "sales.md",
      size: 3,
      source: "upload",
    });
    world.fake.setRetrievalHits(world.datasetId, [
      { documentId: "rf-local", content: "# 销售额口径", similarity: 0.61 },
      { documentId: "rf-unknown", content: "无本地行", similarity: 0.9 },
    ]);
    const response = await post(world, SAME);
    expectAnswer(response, 200, {
      hits: [{ documentId: doc.id, name: "sales.md", similarity: 0.61, content: "# 销售额口径" }],
      retrieval: STORED,
    });
    expect(retrievals(world)).toEqual([
      {
        question: "销售额",
        dataset_ids: [world.datasetId],
        similarity_threshold: 0.2,
        vector_similarity_weight: 0.7,
        page: 1,
        page_size: 6,
      },
    ]);
    expect(world.audits(KIND)).toEqual([]);
    expect(storedOf(world)).toEqual(before);
  });

  it("零命中与全部关联不上：两次都是 200 {hits:[], retrieval:{0.2, 0.7}}", async () => {
    const world = await open();
    expectAnswer(await post(world, SAME), 200, { hits: [], retrieval: STORED });
    world.fake.setRetrievalHits(world.datasetId, [
      { documentId: "rf-x", content: "x", similarity: 0.7 },
      { documentId: "rf-y", content: "y", similarity: 0.6 },
    ]);
    expectAnswer(await post(world, SAME), 200, { hits: [], retrieval: STORED });
    expect(retrievals(world)).toHaveLength(2);
  });

  it("快路径不拿锁：重建器持锁、库为 ready 时提交已存参数，200，恰一次检索，没有审计", async () => {
    const world = await open();
    const release = holdWriteLock(world, "rebuild");
    expectAnswer(await post(world, SAME), 200, { hits: [], retrieval: STORED });
    expect(retrievals(world)).toHaveLength(1);
    expect(world.audits(KIND)).toEqual([]);
    await release();
  });
});

describe("参数变了先写回", () => {
  it("{0.1, 0.9}：200，检索带新参数，恰一条 kb.retrieval_settings，列表读出新值", async () => {
    const world = await open();
    const response = await post(world, CHANGED);
    expectAnswer(response, 200, { hits: [], retrieval: { threshold: 0.1, vectorWeight: 0.9 } });
    expect(retrievals(world)).toEqual([
      expect.objectContaining({ similarity_threshold: 0.1, vector_similarity_weight: 0.9 }),
    ]);
    expect(world.audits(KIND)).toEqual([
      auditOf(STORED, { threshold: 0.1, vectorWeight: 0.9 }, world.baseId),
    ]);
    expect(storedOf(world)).toMatchObject({ threshold: 0.1, vectorWeight: 0.9 });
    const list = await send(world.fw.rest, "member", "GET", "/api/kb/bases");
    expect(list.json()).toEqual({
      bases: [
        expect.objectContaining({
          id: world.baseId,
          retrieval: { threshold: 0.1, vectorWeight: 0.9 },
        }),
      ],
    });
  });

  it("写回后检索失败：假 RAGFlow 回 HTTP 503，应答 503 kb_unavailable，参数已是新值，恰一条审计", async () => {
    const world = await open();
    world.fake.fault(ROUTE, { kind: "status", status: 503 });
    expectAnswer(await post(world, CHANGED), 503, KB_UNAVAILABLE);
    expect(storedOf(world)).toMatchObject({ threshold: 0.1, vectorWeight: 0.9 });
    expect(world.audits(KIND)).toHaveLength(1);
  });

  it("含哨兵问句的写回：审计的 title 与 detail、受管 stderr 记录、stdout 与 stderr 都不含哨兵", async () => {
    const world = await open();
    const stderr = vi.spyOn(process.stderr, "write");
    const stdout = vi.spyOn(process.stdout, "write");
    const question = `季度 ${SENTINEL} 的口径`;
    expect((await post(world, { ...CHANGED, question })).statusCode).toBe(200);
    expect(retrievals(world)).toEqual([expect.objectContaining({ question })]);
    const audits = world.audits(KIND);
    expect(audits).toHaveLength(1);
    expect(Object.keys(audits[0]?.detail ?? {}).sort()).toEqual(["after", "before", "id"]);
    expect(JSON.stringify(audits)).not.toContain(SENTINEL);
    expect(JSON.stringify(world.logged)).not.toContain(SENTINEL);
    const written = [...stderr.mock.calls, ...stdout.mock.calls].map((args) => String(args[0]));
    expect(written.join("")).not.toContain(SENTINEL);
  });
});

describe("写回失败不检索", () => {
  it.each([
    ["列写入失败", REFUSE_COLUMNS],
    ["审计写入失败", REFUSE_AUDIT],
  ])("%s：500 通用信封，两列与 updated_at 不变，零次检索，没有审计", async (_name, trigger) => {
    const world = await open();
    const before = storedOf(world);
    world.fw.world.db.exec(trigger);
    const response = await post(world, CHANGED);
    expect(response.statusCode).toBe(500);
    expect(response.body).toBe(JSON.stringify(GENERIC_500));
    expect(storedOf(world)).toEqual(before);
    expect(retrievals(world)).toEqual([]);
    expect(world.audits(KIND)).toEqual([]);
  });
});

describe("body 校验", () => {
  it.each([
    ["问句全是空白", { ...SAME, question: "   " }],
    ["1001 码点的问句", { ...SAME, question: "字".repeat(1001) }],
    ["问句含 \\u0007", { ...SAME, question: "a\u0007b" }],
    ["问句含 \\r", { ...SAME, question: "a\rb" }],
    ["问句含 \\u007f", { ...SAME, question: "a\u007fb" }],
    ["question 是数字", { ...SAME, question: 123 }],
    ["threshold:1.5", { ...SAME, threshold: 1.5 }],
    ["vectorWeight:-0.1", { ...SAME, vectorWeight: -0.1 }],
    ['threshold:"0.3"', { ...SAME, threshold: "0.3" }],
    ["多一个 topK 键", { ...SAME, topK: 3 }],
    ["缺 vectorWeight 键", { question: "销售额", threshold: 0.2 }],
    ["body 为 null", null],
    ["body 为 []", []],
  ])("%s：400 bad_request，零请求，没有审计", async (_name, body) => {
    const world = await open();
    expectRefused(world, await post(world, body));
  });

  it("threshold:1e999（解析为无穷大）：400 bad_request", async () => {
    const world = await open();
    const raw = '{"question":"销售额","threshold":1e999,"vectorWeight":0.7}';
    expectRefused(world, await post(world, { raw, type: "application/json" }));
  });

  it.each([
    ["\\t 与 \\n 原样发出", "a\tb\nc"],
    ["首尾空白不去掉", "  销售额  "],
    ["1000 码点（2000 个 UTF-16 码元）", "😀".repeat(1000)],
  ])("%s：200，RAGFlow 收到的 question 逐字相同", async (_name, question) => {
    const world = await open();
    expect((await post(world, { ...SAME, question })).statusCode).toBe(200);
    expect(retrievals(world)).toEqual([expect.objectContaining({ question })]);
  });

  it("threshold:0, vectorWeight:1（两端）：200，按新值写回并检索", async () => {
    const world = await open();
    const ends = { threshold: 0, vectorWeight: 1 };
    expectAnswer(await post(world, { question: "q", ...ends }), 200, { hits: [], retrieval: ends });
    expect(retrievals(world)).toEqual([
      expect.objectContaining({ similarity_threshold: 0, vector_similarity_weight: 1 }),
    ]);
  });

  it.each([
    ["malformed JSON", { raw: "{not json", type: "application/json" }],
    ["空 JSON body", { raw: "", type: "application/json" }],
    ["text/plain body", { raw: JSON.stringify(SAME), type: "text/plain" }],
    ["超过 16 KiB", padded(16 * 1024 + 1, SAME)],
  ])("归属路由 %s：exact 400，零个 RAGFlow 请求", async (_name, raw) => {
    const world = await open();
    expectRefused(world, await post(world, raw));
  });
});

describe("判定次序", () => {
  it("别人的 id 带坏 JSON：404，归属先于解析", async () => {
    const world = await open();
    const response = await post(
      world,
      { raw: "{not json", type: "application/json" },
      { who: "admin" },
    );
    expectAnswer(response, 404, NOT_FOUND);
    expect(world.lines()).toEqual([]);
  });

  it("自己的 rebuilding 库带坏 body：400，body 先于 state", async () => {
    const world = await open();
    world.setState("rebuilding");
    expectRefused(world, await post(world, { ...SAME, threshold: 2 }));
  });

  it("所有权：别人的 id 与不存在的 id，合法 body 且参数不同，404，零请求，没有审计，A 的参数不变", async () => {
    const world = await open();
    const before = storedOf(world);
    expectAnswer(await post(world, CHANGED, { who: "admin" }), 404, NOT_FOUND);
    expectAnswer(await post(world, CHANGED, { baseId: ABSENT_ID }), 404, NOT_FOUND);
    expect(world.lines()).toEqual([]);
    expect(world.audits(KIND)).toEqual([]);
    expect(storedOf(world)).toEqual(before);
  });

  it.each(["rebuilding", "rebuild_failed"] as const)(
    "%s 的库以已存参数检索：409 kb_rebuilding，零请求",
    async (state) => {
      const world = await open();
      world.setState(state);
      expectAnswer(await post(world, SAME), 409, REBUILDING);
      expect(world.lines()).toEqual([]);
    },
  );
});

describe("写回与写锁", () => {
  it("写回与重建交错：重建器持锁时以不同参数检索，409，参数不变，零请求", async () => {
    const world = await open();
    const before = storedOf(world);
    const release = holdWriteLock(world, "rebuild");
    expectAnswer(await post(world, CHANGED), 409, REBUILDING);
    expect(storedOf(world)).toEqual(before);
    expect(world.lines()).toEqual([]);
    expect(world.audits(KIND)).toEqual([]);
    await release();
  });

  it("排队期间库转入 rebuilding：锁内重读，409，零请求，没有审计", async () => {
    const world = await open();
    const release = holdWriteLock(world);
    const pending = post(world, CHANGED);
    await waitForWaiters(world, 1);
    world.setState("rebuilding");
    await release();
    expectAnswer(await pending, 409, REBUILDING);
    expect(world.lines()).toEqual([]);
    expect(world.audits(KIND)).toEqual([]);
  });

  it("写回排在入库之后：入库挂起上传时以不同参数检索，入库结束后才写回，检索在上传之后带新参数", async () => {
    const world = await open();
    world.write("a.md", "a");
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const ingesting = world.ingest(["a.md"]);
    await gate.reached;
    const pending = post(world, CHANGED);
    await waitForWaiters(world, 1);
    expect(storedOf(world)).toMatchObject(STORED);
    gate.release();
    expect((await ingesting).statusCode).toBe(201);
    expect((await pending).statusCode).toBe(200);
    const lines = world.lines();
    const upload = lines.indexOf(`POST /api/v1/datasets/${world.datasetId}/documents`);
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(ROUTE)).toBeGreaterThan(upload);
    expect(retrievals(world)).toEqual([
      expect.objectContaining({ similarity_threshold: 0.1, vector_similarity_weight: 0.9 }),
    ]);
    expect(world.audits(KIND)).toHaveLength(1);
  });

  it("排队时库被删除：删库挂起删数据集时以不同参数检索，删库 204，检索 404，零次检索，没有审计", async () => {
    const world = await open();
    const gate = world.fake.fault(DELETE_DATASETS, { kind: "hold" });
    const deleting = send(world.fw.rest, "member", "DELETE", `/api/kb/bases/${world.baseId}`);
    await gate.reached;
    const pending = post(world, CHANGED);
    await waitForWaiters(world, 1);
    gate.release();
    expect((await deleting).statusCode).toBe(204);
    expectAnswer(await pending, 404, NOT_FOUND);
    expect(retrievals(world)).toEqual([]);
    expect(world.audits(KIND)).toEqual([]);
  });

  it("并发的相同提交：两者都排队，两次 200，恰一条审计，两次检索都带新阈值", async () => {
    const world = await open();
    const release = holdWriteLock(world);
    const body = { question: "q", threshold: 0.1, vectorWeight: 0.7 };
    const first = post(world, body);
    const second = post(world, body);
    await waitForWaiters(world, 2);
    await release();
    const after = { threshold: 0.1, vectorWeight: 0.7 };
    for (const response of [await first, await second]) {
      expectAnswer(response, 200, { hits: [], retrieval: after });
    }
    expect(world.audits(KIND)).toEqual([auditOf(STORED, after, world.baseId)]);
    expect(retrievals(world)).toEqual([
      expect.objectContaining({ similarity_threshold: 0.1 }),
      expect.objectContaining({ similarity_threshold: 0.1 }),
    ]);
  });

  it("并发的不同提交：按到达次序两条审计，第二条的 before 取锁内重读的值，终值为后到的", async () => {
    const world = await open();
    const release = holdWriteLock(world);
    const a = { threshold: 0.1, vectorWeight: 0.7 };
    const b = { threshold: 0.3, vectorWeight: 0.7 };
    const first = post(world, { question: "q", ...a });
    await waitForWaiters(world, 1);
    const second = post(world, { question: "q", ...b });
    await waitForWaiters(world, 2);
    await release();
    expectAnswer(await first, 200, { hits: [], retrieval: a });
    expectAnswer(await second, 200, { hits: [], retrieval: b });
    expect(world.audits(KIND)).toEqual([
      auditOf(STORED, a, world.baseId),
      auditOf(a, b, world.baseId),
    ]);
    expect(storedOf(world)).toMatchObject(b);
    const thresholds = retrievals(world).map(
      (json) => (json as { similarity_threshold: number }).similarity_threshold,
    );
    expect(thresholds.sort()).toEqual([0.1, 0.3]);
  });
});
