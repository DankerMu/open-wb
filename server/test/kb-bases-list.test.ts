/**
 * s2a-kb-ragflow tasks 9.2（#1846）：`GET /api/kb/bases`（knowledge-bases「知识库端点」、design D9）。列表只依赖本地行：
 * 库行由 store 或 SQL 直接写入，`created_at` 因此可控，用例不依赖两次建库之间过了一毫秒。
 */
import { describe, expect, it } from "vitest";
import { BASES, COMPILE_OFF, createdBase } from "./kb-bases-helpers.js";
import {
  addCompileBase,
  configuredWorld,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { BASE_ROW, hex, insertRow, REBUILD_FAILED } from "./kb-store-helpers.js";

const open = useSettingsWorlds();
const ready = () => configuredWorld(open);

const BASE_KEYS = [
  "compile",
  "createdAt",
  "documents",
  "graph",
  "id",
  "name",
  "raptor",
  "retrieval",
  "state",
  "stateMessage",
  "template",
];

const list = (world: World, who: "member" | "peer" | "admin" = "member") =>
  world.call("GET", BASES, who);

async function basesOf(world: World, who?: "member" | "peer" | "admin") {
  const response = await list(world, who);
  expect(response.statusCode).toBe(200);
  return (response.json() as { bases: Array<Record<string, unknown>> }).bases;
}

describe("GET /api/kb/bases", () => {
  it("应答恰为 {bases}，BaseView 恰十一键，no-store", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库", "manual");
    const response = await list(world);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ bases: [view] });
    const [listed] = (response.json() as { bases: object[] }).bases;
    expect(Object.keys(listed ?? {}).sort()).toEqual(BASE_KEYS);
  });

  it("按 created_at 升序，不按插入次序", async () => {
    const world = await ready();
    const { id } = await createdBase(world, "现在");
    const ownerId = world.store.getBase(id)?.ownerId ?? "";
    const row = { ...BASE_ROW, owner_id: ownerId };
    insertRow(world.db, "knowledge_bases", {
      ...row,
      id: hex(2),
      name: "较晚",
      created_at: 3_000,
    });
    insertRow(world.db, "knowledge_bases", {
      ...row,
      id: hex(3),
      name: "最早",
      created_at: 1_000,
    });
    insertRow(world.db, "knowledge_bases", {
      ...row,
      id: hex(4),
      name: "中间",
      created_at: 2_000,
    });
    const names = (await basesOf(world)).map(({ name }) => name);
    expect(names).toEqual(["最早", "中间", "较晚", "现在"]);
  });

  it("只有自己的库，管理员也一样；createdAt 是毫秒整数", async () => {
    const world = await ready();
    const mine = await createdBase(world, "我的", "naive", "member");
    const theirs = await createdBase(world, "他的", "naive", "peer");
    const administered = await createdBase(world, "管理员的", "naive", "admin");
    expect((await basesOf(world)).map(({ id }) => id)).toEqual([mine.id]);
    expect((await basesOf(world, "peer")).map(({ id }) => id)).toEqual([theirs.id]);
    expect((await basesOf(world, "admin")).map(({ id }) => id)).toEqual([administered.id]);
    expect(Number.isSafeInteger(mine.createdAt)).toBe(true);
  });

  it("documents 是本地文档行数；state 与 stateMessage 取库行", async () => {
    const world = await ready();
    const { id } = await createdBase(world, "规范库");
    const document = { kbId: id, name: "a.md", size: 1, source: "upload" } as const;
    world.store.addDocument({ ...document, ragflowDocumentId: "rf-1" });
    world.store.addDocument({ ...document, ragflowDocumentId: "rf-2" });
    world.store.failRebuild(id, REBUILD_FAILED);
    expect(await basesOf(world)).toEqual([
      expect.objectContaining({
        documents: 2,
        state: "rebuild_failed",
        stateMessage: REBUILD_FAILED,
        compile: COMPILE_OFF,
      }),
    ]);
  });

  it("retrieval 取库行两列的原值：store 直写 0.5 / 0.3 后列表读出同值，不读 RAGFlow", async () => {
    const world = await ready();
    const { id } = await createdBase(world, "规范库");
    world.store.saveRetrieval(id, { threshold: 0.5, vectorWeight: 0.3 });
    world.forget();
    const [listed] = await basesOf(world);
    expect(listed?.retrieval).toEqual({ threshold: 0.5, vectorWeight: 0.3 });
    expect(world.sent()).toEqual([]);
  });

  it("两开关为 0 的库 compile 恒为 off，不发出站请求", async () => {
    const world = await ready();
    await createdBase(world, "一");
    await createdBase(world, "二");
    world.forget();
    const bases = await basesOf(world);
    expect(bases.map(({ compile }) => compile)).toEqual([COMPILE_OFF, COMPILE_OFF]);
    expect(world.sent()).toEqual([]);
  });

  it("开了开关的行（store 直接写入），数据集不在 RAGFlow：只读一次文档列表，code:404，compile 为 null", async () => {
    const world = await ready();
    const { id } = await createdBase(world, "普通库");
    addCompileBase(world, 2, { owner_id: world.store.getBase(id)?.ownerId ?? "" });
    world.forget();
    const compiled = (await basesOf(world)).find(({ raptor }) => raptor === true);
    expect(compiled).toMatchObject({ raptor: true, graph: false, compile: null });
    expect(routes(world.sent())).toEqual(["GET /api/v1/datasets/ds-2/documents"]);
  });

  it("RAGFlow 不可达时列表照常 200", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    await world.fake.close();
    expect(await basesOf(world)).toEqual([view]);
  });
});
