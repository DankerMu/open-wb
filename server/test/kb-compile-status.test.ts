/**
 * s2a-kb-ragflow tasks 9.8（#1870）：列表里的编译状态，组 9 第三刀（knowledge-bases「知识库端点」的编译状态判定与「编译状态
 * 读取有界」「编译状态按任务日志判定」「只有 0 切片的文档」「类型只看 task_type」，design D14）。全部经 `createApp` +
 * `app.inject()` 打假 RAGFlow。库行与文档行由 SQL / store 直接写入，`created_at` 因此可控；RAGFlow 一侧的文档与任务日志由
 * 夹具播种。期望值是 spec 与实测记录 §5.3 的字面量。
 */
import { describe, expect, it, vi } from "vitest";
import { resourceName } from "../src/kb/pipeline.js";
import { BASES, COMPILE_OFF } from "./kb-bases-helpers.js";
import {
  addCompileBase,
  LEAK,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { BASE_ROW, COMPILE_ROW, hex, insertRow } from "./kb-store-helpers.js";

const open = useSettingsWorlds();

const INGESTIONS = "GET /api/v1/datasets/*/ingestions";
const DOCUMENTS = "GET /api/v1/datasets/*/documents";
/** design D14 的读法：逐页，`page_size=100`，`orderby=id`，不带别的键。 */
const pageQuery = (n: number) => `page=${String(n)}&page_size=100&orderby=id`;
const BOTH = { raptor: 1, graph: 1 } as const;
const RAPTOR = { raptor: 1, graph: 0 } as const;
/** §5.3「类型与 entries」的表：两种都开时两条日志都是这个 `variants`。 */
const BOTH_VARIANTS = ["structure", "tree"];

interface DocumentSeed {
  status: string;
  chunks?: number;
}

interface Seeded {
  id: string;
  datasetId: string;
  /** RAGFlow 文档 id，次序同种子。 */
  documents: string[];
  variants?: string[];
}

const RAPTOR_PENDING = { raptor: "pending", graph: "off" };
const completed = (chunks = 3): DocumentSeed => ({ status: "COMPLETED", chunks });
/** 比一页任务日志（100 行）多一份。 */
const pageAndOne = () => Array.from({ length: 101 }, () => completed());

function memberId(world: World): string {
  const row = world.db.prepare("SELECT id FROM accounts WHERE account = 'zhangsan'").get();
  return String(row?.id);
}

/** 第 `n` 个库：数据集在夹具里，`created_at` 为 `n`；每份文档在 RAGFlow 一份、本地一行。 */
function seedBase(
  world: World,
  n: number,
  switches: { raptor: 0 | 1; graph: 0 | 1 },
  documents: DocumentSeed[],
): Seeded {
  const id = hex(n);
  const datasetId = world.fake.addDataset(resourceName(id, 0));
  const compiled = switches.raptor === 1 || switches.graph === 1;
  insertRow(world.db, "knowledge_bases", {
    ...(compiled ? COMPILE_ROW : BASE_ROW),
    ...switches,
    id,
    name: `库 ${String(n)}`,
    owner_id: memberId(world),
    dataset_id: datasetId,
    created_at: n,
  });
  const ids = documents.map(({ status, chunks = 0 }, index) => {
    const name = `${String(n)}-${String(index)}.txt`;
    const ragflowDocumentId = world.fake.addDocument(datasetId, {
      name,
      content: "x",
      ingestionStatus: status,
      chunkCount: chunks,
    });
    world.store.addDocument({ kbId: id, name, size: 1, source: "upload", ragflowDocumentId });
    return ragflowDocumentId;
  });
  const both = switches.raptor === 1 && switches.graph === 1;
  return { id, datasetId, documents: ids, ...(both ? { variants: BOTH_VARIANTS } : {}) };
}

/** 该类型的日志，每份文档一条（§5.3：一份文档一种类型一条日志）。 */
function logs(
  world: World,
  base: Seeded,
  taskType: "Tree" | "Graph",
  documents: string[],
  operationStatus: "DONE" | "RUNNING" = "DONE",
  variants = base.variants,
): void {
  for (const documentId of documents) {
    world.fake.addIngestionLog(base.datasetId, {
      taskType,
      operationStatus,
      documentId,
      ...(variants === undefined ? {} : { variants }),
    });
  }
}

async function listed(world: World): Promise<{ body: string; compile: Map<string, unknown> }> {
  const response = await world.call("GET", BASES, "member");
  expect(response.statusCode).toBe(200);
  const { bases } = response.json() as { bases: { id: string; compile: unknown }[] };
  return { body: response.body, compile: new Map(bases.map(({ id, compile }) => [id, compile])) };
}

const compileOf = async (world: World, base: Seeded) => (await listed(world)).compile.get(base.id);

/** 这个数据集收到的某种读取的查询串，按到达次序。 */
function queries(world: World, datasetId: string, kind: "ingestions" | "documents"): string[] {
  const path = `/api/v1/datasets/${datasetId}/${kind}`;
  return world.fake
    .requests()
    .filter((request) => request.method === "GET" && request.path === path)
    .map(({ query }) => query);
}

describe("编译状态按任务日志判定", () => {
  it("两种都开、两份文档的六种呈现依次为 {running, running}、{pending, pending}、{done, running}、{pending, pending}、{done, done}、{failed, failed}", async () => {
    const world = await open();
    const running = seedBase(world, 1, BOTH, [{ status: "RUNNING" }, completed()]);
    const silent = seedBase(world, 2, BOTH, [completed(), completed()]);
    const treeDone = seedBase(world, 3, BOTH, [completed(), completed()]);
    logs(world, treeDone, "Tree", treeDone.documents);
    logs(world, treeDone, "Graph", treeDone.documents, "RUNNING");
    const firstOnly = seedBase(world, 4, BOTH, [completed(), completed()]);
    logs(world, firstOnly, "Tree", firstOnly.documents.slice(0, 1));
    logs(world, firstOnly, "Graph", firstOnly.documents.slice(0, 1));
    const covered = seedBase(world, 5, BOTH, [completed(), completed()]);
    logs(world, covered, "Tree", covered.documents);
    logs(world, covered, "Graph", covered.documents);
    const failed = seedBase(world, 6, BOTH, [{ status: "FAILED" }, completed()]);
    logs(world, failed, "Tree", failed.documents.slice(1));
    logs(world, failed, "Graph", failed.documents.slice(1));
    world.forget();

    const { compile } = await listed(world);
    const presented = [running, silent, treeDone, firstOnly, covered, failed];
    expect(presented.map(({ id }) => compile.get(id))).toEqual([
      { raptor: "running", graph: "running" },
      { raptor: "pending", graph: "pending" },
      { raptor: "done", graph: "running" },
      { raptor: "pending", graph: "pending" },
      { raptor: "done", graph: "done" },
      { raptor: "failed", graph: "failed" },
    ]);
    expect(queries(world, running.datasetId, "ingestions")).toEqual([]);
    for (const base of presented.slice(1)) {
      expect(queries(world, base.datasetId, "ingestions")).toEqual([pageQuery(1)]);
    }
  });

  it.each([["CREATED"], ["SCHEDULED"], ["RUNNING"], ["STOPPING"]])(
    "有文档 %s：两种都 running，假 RAGFlow 没有收到任务日志请求",
    async (status) => {
      const world = await open();
      const base = seedBase(world, 1, BOTH, [completed(), { status }]);
      logs(world, base, "Tree", base.documents.slice(0, 1));
      expect(await compileOf(world, base)).toEqual({ raptor: "running", graph: "running" });
      expect(queries(world, base.datasetId, "documents")).toHaveLength(1);
      expect(queries(world, base.datasetId, "ingestions")).toEqual([]);
    },
  );

  it("有文档 FAILED 时照读任务日志：该类型有 RUNNING 日志即 running（第 1 步先于第 2 步），另一种 failed", async () => {
    const world = await open();
    const base = seedBase(world, 1, BOTH, [{ status: "FAILED" }, completed()]);
    logs(world, base, "Tree", base.documents.slice(1), "RUNNING");
    expect(await compileOf(world, base)).toEqual({ raptor: "running", graph: "failed" });
  });

  it("文档都 COMPLETED、该类型没有日志（RAPTOR 无信号）：停在 pending，不是 failed 也不是 done", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed(), completed()]);
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
  });

  it("没有本地文档：开着的类型为 pending", async () => {
    const world = await open();
    const base = seedBase(world, 1, BOTH, []);
    expect(await compileOf(world, base)).toEqual({ raptor: "pending", graph: "pending" });
  });

  it("只算本地文档：RAGFlow 里没有本地行的文档（kb_document_leak 留下的）不参与判定", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed()]);
    world.fake.addDocument(base.datasetId, {
      name: "leak.txt",
      content: "x",
      ingestionStatus: "FAILED",
    });
    world.fake.addDocument(base.datasetId, {
      name: "busy.txt",
      content: "x",
      ingestionStatus: "RUNNING",
    });
    logs(world, base, "Tree", base.documents);
    expect(await compileOf(world, base)).toEqual({ raptor: "done", graph: "off" });
  });
});

describe("只有 0 切片的文档", () => {
  it("一份 0 切片、另一份被 Tree 的 DONE 覆盖：raptor done；只有一份 0 切片的库：raptor pending", async () => {
    const world = await open();
    const mixed = seedBase(world, 1, RAPTOR, [completed(0), completed()]);
    logs(world, mixed, "Tree", mixed.documents.slice(1));
    const empty = seedBase(world, 2, RAPTOR, [completed(0)]);
    const { compile } = await listed(world);
    expect(compile.get(mixed.id)).toEqual({ raptor: "done", graph: "off" });
    expect(compile.get(empty.id)).toEqual({ raptor: "pending", graph: "off" });
  });
});

describe("类型只看 task_type", () => {
  it("只开 RAPTOR，Graph 日志的 variants 含 tree 且覆盖全部文档，没有 Tree 日志：raptor pending，graph off", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed(), completed()]);
    logs(world, base, "Graph", base.documents, "DONE", BOTH_VARIANTS);
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
  });
});

describe("任务日志的读法（design D14，实测记录 §5.3、§18 #26–#29）", () => {
  it("101 份文档、101 行日志：逐页读到 total，每个请求恰为 page、page_size=100、orderby=id；第 2 页上那份文档决定 done", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, pageAndOne());
    // 夹具按 id 倒序给出，第一条种子在第 2 页。
    logs(world, base, "Tree", base.documents);
    expect(await compileOf(world, base)).toEqual({ raptor: "done", graph: "off" });
    expect(queries(world, base.datasetId, "ingestions")).toEqual([pageQuery(1), pageQuery(2)]);
    expect(queries(world, base.datasetId, "documents")).toHaveLength(2);
  });

  it("第 2 页上那份文档没有日志：pending", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, pageAndOne());
    logs(world, base, "Tree", base.documents.slice(1));
    world.fake.addIngestionLog(base.datasetId, {
      taskType: "Graph",
      operationStatus: "DONE",
      documentId: String(base.documents[0]),
    });
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
    expect(queries(world, base.datasetId, "ingestions")).toEqual([pageQuery(1), pageQuery(2)]);
  });

  it("读到空页即停：total 过期（越界页的形状，logs 为空、total 不变）不会一直翻下去", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed()]);
    world.fake.answer(INGESTIONS, { code: 0, data: { logs: [], total: 999 } }, { times: 5 });
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
    expect(queries(world, base.datasetId, "ingestions")).toEqual([pageQuery(1)]);
  });
});

describe("读不到为 null，列表照常 200（knowledge-bases「知识库端点」）", () => {
  it("文档列表 code:404（数据集不在 RAGFlow）：该库 compile 为 null，不读任务日志；别的库照常", async () => {
    const world = await open();
    const ownerId = memberId(world);
    addCompileBase(world, 1, { owner_id: ownerId, created_at: 1 });
    const other = seedBase(world, 2, RAPTOR, [completed()]);
    logs(world, other, "Tree", other.documents);
    const { compile } = await listed(world);
    expect(compile.get(hex(1))).toBeNull();
    expect(compile.get(other.id)).toEqual({ raptor: "done", graph: "off" });
    expect(queries(world, "ds-1", "documents")).toHaveLength(1);
    expect(queries(world, "ds-1", "ingestions")).toEqual([]);
  });

  it.each([
    ["任务日志 HTTP 503", { kind: "status", status: 503 }],
    ["任务日志的行缺 task_type", { kind: "combo", code: 0, data: { logs: [{}], total: 1 } }],
    ["任务日志缺 total", { kind: "combo", code: 0, data: { logs: [] } }],
    ["任务日志 code:102", { kind: "combo", code: 102, message: LEAK }],
  ] as const)("%s：compile 为 null，应答里没有 RAGFlow 的原文", async (_label, fault) => {
    const world = await open();
    const base = seedBase(world, 1, BOTH, [completed()]);
    expect(await compileOf(world, base)).toEqual({ raptor: "pending", graph: "pending" });
    world.fake.fault(INGESTIONS, fault);
    const { body, compile } = await listed(world);
    expect(compile.get(base.id)).toBeNull();
    expect(body).not.toContain(LEAK);
    expect(queries(world, base.datasetId, "ingestions")).toEqual([pageQuery(1), pageQuery(1)]);
  });

  it("DONE 日志的 dsl.entries 不是数组：compile 为 null，不当作没有覆盖", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed()]);
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
    const row = { task_type: "Tree", operation_status: "DONE", dsl: {} };
    world.fake.fault(INGESTIONS, { kind: "combo", code: 0, data: { logs: [row], total: 1 } });
    expect(await compileOf(world, base)).toBeNull();
  });

  it("本地文档的 ingestion_status 在八种之外（漂移）：compile 为 null，不读任务日志", async () => {
    const world = await open();
    const base = seedBase(world, 1, RAPTOR, [completed()]);
    const documentId = String(base.documents[0]);
    expect(await compileOf(world, base)).toEqual(RAPTOR_PENDING);
    world.fake.fault(DOCUMENTS, { kind: "ingestion_status", documentId, value: "PAUSED" });
    world.forget();
    expect(await compileOf(world, base)).toBeNull();
    expect(routes(world.sent())).toEqual([`GET /api/v1/datasets/${base.datasetId}/documents`]);
  });

  it("RAGFlow 不可达：开了开关的库 compile 为 null，两开关为 0 的库为 off，200", async () => {
    const world = await open();
    const base = seedBase(world, 1, BOTH, [completed()]);
    const plain = seedBase(world, 2, { raptor: 0, graph: 0 }, []);
    expect(await compileOf(world, base)).toEqual({ raptor: "pending", graph: "pending" });
    await world.fake.close();
    const { compile } = await listed(world);
    expect(compile.get(base.id)).toBeNull();
    expect(compile.get(plain.id)).toEqual(COMPILE_OFF);
  });
});

describe("编译状态读取有界", () => {
  const DEADLINE_MS = 300;

  it("三个开了 RAPTOR 的库和一个两开关为 0 的库，全部文档列表与任务日志挂起：期限后 200，三个 null，第四个 off", async () => {
    const world = await open({ compileStatusDeadlineMs: DEADLINE_MS });
    const compiled = [1, 2, 3].map((n) => seedBase(world, n, RAPTOR, [completed()]));
    const plain = seedBase(world, 4, { raptor: 0, graph: 0 }, []);
    world.fake.fault(DOCUMENTS, { kind: "hang" }, { times: 3 });
    world.fake.fault(INGESTIONS, { kind: "hang" }, { times: 3 });
    world.forget();
    const started = performance.now();
    const { compile } = await listed(world);
    expect(performance.now() - started).toBeGreaterThanOrEqual(DEADLINE_MS - 1);
    expect(compiled.map(({ id }) => compile.get(id))).toEqual([null, null, null]);
    expect(compile.get(plain.id)).toEqual(COMPILE_OFF);
    // 三个库的读取并发发出：串行时第二个请求要等第一个挂起的读完。
    await vi.waitFor(() => {
      expect(routes(world.sent()).filter((line) => line.endsWith("/documents"))).toHaveLength(3);
    });
    expect(routes(world.sent()).filter((line) => line.endsWith("/ingestions"))).toEqual([]);
  });
});
