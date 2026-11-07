/**
 * s2a-kb-ragflow tasks 9.2（#1846）：`DELETE /api/kb/bases/:id`、所有权与「不可达不阻断」（knowledge-bases「知识库端点」
 * 「知识库审计」，ragflow-backend「不存在视为已删」「不可达不阻断」，design D9、D20）。开了开关的库的删除次序在
 * `kb-bases-compile.test.ts`（#1869）。
 *
 * 文档行与重建状态由 store 直接写入；第二代的数据集经 `fake.addDataset()` 种进假 RAGFlow，所以删除请求打到真的 id。
 */
import { describe, expect, it, vi } from "vitest";
import { resourceName } from "../src/kb/pipeline.js";
import {
  auditsOf,
  BASES,
  baseCount,
  COMPILE_OFF,
  createdBase,
  DELETE_DATASETS,
  datasetIdOf,
  deleteBase,
  expectDeleted,
  NOT_FOUND,
  ownerIdOf,
  POST_DATASETS,
  REBUILDING,
} from "./kb-bases-helpers.js";
import {
  bodyOf,
  configuredWorld,
  KB_UNAVAILABLE,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";
import { EMBEDDING, hex, PLAIN_BASE, REBUILD_FAILED } from "./kb-store-helpers.js";
import { closedPort } from "./models-probe-helpers.js";

const open = useSettingsWorlds();
const ready = () => configuredWorld(open);

/** 假 RAGFlow 这次删了哪些数据集，按到达次序。 */
function deletedIds(world: World): unknown[] {
  return world
    .sent()
    .filter(({ method, path }) => `${method} ${path}` === DELETE_DATASETS)
    .map(({ json }) => (json as { ids: unknown[] }).ids);
}

/** 持有一把锁，放行之前别的写者排着。 */
function latch(): { held: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** 一个 `rebuild_failed` 的普通库，新一代的数据集已建好。 */
async function failedBase(world: World) {
  const view = await createdBase(world, "重建失败的库");
  const next = world.fake.addDataset(resourceName(view.id, 1));
  world.store.setRebuildGeneration(view.id, {
    datasetId: next,
    canvasId: null,
    templateGroupId: null,
  });
  world.store.failRebuild(view.id, REBUILD_FAILED);
  world.forget();
  return { id: view.id, current: datasetIdOf(world, view.id), next };
}

describe("所有权", () => {
  it("普通模板的隔离：B 的列表为空，DELETE A 的库 404；建库之后假 RAGFlow 没有收到任何请求", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    expect(world.logged).toEqual([]);
    world.forget();

    const list = await world.call("GET", BASES, "peer");
    expect(list.json()).toEqual({ bases: [] });
    for (const who of ["peer", "admin"] as const) {
      const refused = await deleteBase(world, view.id, who);
      expect(refused.statusCode).toBe(404);
      expect(bodyOf(refused)).toEqual(NOT_FOUND);
      expect(refused.headers["cache-control"]).toBe("no-store");
    }
    expect(world.sent()).toEqual([]);
    expect(baseCount(world)).toBe(1);
    expect(auditsOf(world, "kb.delete")).toEqual([]);
  });

  it("别人的 id 判定先于 body 解析：malformed JSON 同样 404；不存在的 id 与它不可区分", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.forget();
    const url = `${BASES}/${view.id}`;
    const stranger = await world.raw("DELETE", url, "{not json", "application/json", "peer");
    const unknown = await world.raw(
      "DELETE",
      `${BASES}/${hex(9)}`,
      "{not json",
      "application/json",
      "peer",
    );
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).toBe(unknown.body);
    expect(bodyOf(stranger)).toEqual(NOT_FOUND);
    expect(world.sent()).toEqual([]);
    expect((await deleteBase(world, view.id)).statusCode).toBe(204);
  });

  it("重建中的别人的库：404 先于 state 判定，看不出它在重建", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.db.prepare("UPDATE knowledge_bases SET state = 'rebuilding'").run();
    const refused = await deleteBase(world, view.id, "peer");
    expect(refused.statusCode).toBe(404);
    const own = await deleteBase(world, view.id);
    expect(own.statusCode).toBe(409);
  });
});

describe("删库", () => {
  it("有两份文档的库：204，恰一次删数据集，库与文档行都不在，恰一条 kb.delete", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    const ownerId = ownerIdOf(world, view.id);
    const datasetId = datasetIdOf(world, view.id);
    const document = { kbId: view.id, name: "a.md", size: 1, source: "upload" } as const;
    world.store.addDocument({ ...document, ragflowDocumentId: "rf-1" });
    world.store.addDocument({ ...document, ragflowDocumentId: "rf-2" });
    world.forget();

    const response = await deleteBase(world, view.id);
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(routes(world.sent())).toEqual([DELETE_DATASETS]);
    expect(deletedIds(world)).toEqual([[datasetId]]);
    expect(world.fake.datasets()).toEqual([]);
    expect(world.store.getBase(view.id)).toBeUndefined();
    expect(world.store.listDocuments(view.id)).toEqual([]);
    expect(auditsOf(world, "kb.delete")).toEqual([
      {
        actorId: ownerId,
        title: expect.not.stringContaining("规范库"),
        detail: { id: view.id },
        workspaceId: null,
      },
    ]);
  });

  it("RAGFlow 不可达：503 kb_unavailable，行仍在，没有 kb.delete；恢复后重试 204", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.fake.fault(DELETE_DATASETS, { kind: "reset" });
    const down = await deleteBase(world, view.id);
    expect(down.statusCode).toBe(503);
    expect(bodyOf(down)).toEqual(KB_UNAVAILABLE);
    expect(world.store.getBase(view.id)).toBeDefined();
    expect(auditsOf(world, "kb.delete")).toEqual([]);
    expect((await deleteBase(world, view.id)).statusCode).toBe(204);
  });

  it("不存在视为已删：DELETE /datasets 的 code:403 删掉行，不写 kb_upstream_auth_failed", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.fake.answer(DELETE_DATASETS, { code: 403, message: "Permission denied" });
    await expectDeleted(world, view.id);
  });

  it.each([
    ["code:0 而没有 success_count", { kind: "combo", deletedList: true }, 503],
    ["同路由上别的 101", { kind: "combo", code: 101 }, 400],
  ] as const)("%s：不是已删，行不动", async (_label, fault, status) => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.fake.fault(DELETE_DATASETS, fault);
    expect((await deleteBase(world, view.id)).statusCode).toBe(status);
    expect(world.store.getBase(view.id)).toBeDefined();
    expect(auditsOf(world, "kb.delete")).toEqual([]);
  });

  it("删掉的名字可以再用，新库是新的 id", async () => {
    const world = await ready();
    const first = await createdBase(world, "规范库");
    expect((await deleteBase(world, first.id)).statusCode).toBe(204);
    const second = await createdBase(world, "规范库");
    expect(second.id).not.toBe(first.id);
    expect(second.compile).toEqual(COMPILE_OFF);
  });
});

describe("重建状态", () => {
  it("rebuilding：409 kb_rebuilding，没有出站，行仍在", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.db.prepare("UPDATE knowledge_bases SET state = 'rebuilding'").run();
    world.forget();
    const refused = await deleteBase(world, view.id);
    expect(refused.statusCode).toBe(409);
    expect(bodyOf(refused)).toEqual(REBUILDING);
    expect(world.sent()).toEqual([]);
    expect(world.store.getBase(view.id)).toBeDefined();
  });

  it("写锁被重建器持有：不排队，立即 409 kb_rebuilding", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.forget();
    const { held, release } = latch();
    const rebuilder = world.locks.rebuild(view.id, () => held);
    const refused = await deleteBase(world, view.id);
    expect(refused.statusCode).toBe(409);
    expect(bodyOf(refused)).toEqual(REBUILDING);
    expect(world.sent()).toEqual([]);
    release();
    await rebuilder;
  });

  it("rebuild_failed：先删新一代，再删当前一代，204，恰一条 kb.delete", async () => {
    const world = await ready();
    const { id, current, next } = await failedBase(world);
    expect((await deleteBase(world, id)).statusCode).toBe(204);
    expect(deletedIds(world)).toEqual([[next], [current]]);
    expect(world.fake.datasets()).toEqual([]);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it("rebuild_failed 而新一代还没建：只删当前一代", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    const current = datasetIdOf(world, view.id);
    world.store.failRebuild(view.id, REBUILD_FAILED);
    world.forget();
    expect((await deleteBase(world, view.id)).statusCode).toBe(204);
    expect(deletedIds(world)).toEqual([[current]]);
  });

  it("新一代的删除得 code:403：视为已删，当前一代照发，204", async () => {
    const world = await ready();
    const { id, current, next } = await failedBase(world);
    world.fake.answer(DELETE_DATASETS, { code: 403, message: "Permission denied" });
    expect((await deleteBase(world, id)).statusCode).toBe(204);
    expect(deletedIds(world)).toEqual([[next], [current]]);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it.each([
    ["HTTP 503", { kind: "status", status: 503 }],
    ["连接被重置", { kind: "reset" }],
  ] as const)("新一代删除失败即停（%s）：不发当前一代，行不动；重试 204", async (_label, fault) => {
    const world = await ready();
    const { id, current, next } = await failedBase(world);
    world.fake.fault(DELETE_DATASETS, fault);
    const down = await deleteBase(world, id);
    expect(down.statusCode).toBe(503);
    expect(bodyOf(down)).toEqual(KB_UNAVAILABLE);
    expect(deletedIds(world)).toEqual([[next]]);
    expect(world.fake.datasets().map((dataset) => dataset.id)).toContain(current);
    expect(world.store.getBase(id)).toMatchObject({ rebuildDatasetId: next });
    expect(auditsOf(world, "kb.delete")).toEqual([]);

    expect((await deleteBase(world, id)).statusCode).toBe(204);
  });

  it("当前一代删除失败：503，行不动；重试从头走一遍，新一代已不存在，204", async () => {
    const world = await ready();
    const { id, current, next } = await failedBase(world);
    // 新一代删除放行，第二个请求才失败：故障登记在第一个请求到达之后。
    const gate = world.fake.fault(DELETE_DATASETS, { kind: "hold" });
    const deleting = deleteBase(world, id);
    await gate.reached;
    world.fake.fault(DELETE_DATASETS, { kind: "status", status: 503 });
    gate.release();
    expect((await deleting).statusCode).toBe(503);
    expect(world.store.getBase(id)).toMatchObject({ rebuildDatasetId: next });
    expect(auditsOf(world, "kb.delete")).toEqual([]);

    world.forget();
    expect((await deleteBase(world, id)).statusCode).toBe(204);
    expect(deletedIds(world)).toEqual([[next], [current]]);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });
});

describe("写锁（design D20）", () => {
  function heldWriter(world: World, id: string) {
    const { held, release } = latch();
    const writer = world.locks.write(id, () => held);
    return { writer, release };
  }

  it("在途写操作结束之后才发删除", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.forget();
    const { writer, release } = heldWriter(world, view.id);
    const deleting = deleteBase(world, view.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(view.id)).toBe(1);
    });
    expect(world.sent()).toEqual([]);
    release();
    await writer;
    expect((await deleting).statusCode).toBe(204);
  });

  it("排队期间库已转入 rebuilding：取锁后重判，409，没有出站", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.forget();
    const { writer, release } = heldWriter(world, view.id);
    const deleting = deleteBase(world, view.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(view.id)).toBe(1);
    });
    world.db.prepare("UPDATE knowledge_bases SET state = 'rebuilding'").run();
    release();
    await writer;
    const refused = await deleting;
    expect(refused.statusCode).toBe(409);
    expect(bodyOf(refused)).toEqual(REBUILDING);
    expect(world.sent()).toEqual([]);
  });

  it("两个删除并发：后到的取锁后 404，恰一次删数据集，恰一条 kb.delete", async () => {
    const world = await ready();
    const view = await createdBase(world, "规范库");
    world.forget();
    const gate = world.fake.fault(DELETE_DATASETS, { kind: "hold" });
    const first = deleteBase(world, view.id);
    await gate.reached;
    const second = deleteBase(world, view.id);
    await vi.waitFor(() => {
      expect(world.locks.writeWaiters(view.id)).toBe(1);
    });
    gate.release();
    expect((await first).statusCode).toBe(204);
    const late = await second;
    expect(late.statusCode).toBe(404);
    expect(bodyOf(late)).toEqual(NOT_FOUND);
    expect(routes(world.sent())).toEqual([DELETE_DATASETS]);
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });
});

describe("不可达不阻断", () => {
  it("RAGFlow 地址指向已关闭的端口：启动、会话照常，状态 available:false，列表 200 含预置库，删除 503 且行仍在", async () => {
    const port = await closedPort();
    const world = await open({ baseUrl: `http://127.0.0.1:${String(port)}` });
    const preset = "预置库";
    world.store.saveSettings({ embedding: EMBEDDING });
    const session = await world.call("POST", "/api/sessions", "member");
    expect(session.statusCode).toBe(201);
    const owner = world.db.prepare("SELECT id FROM accounts WHERE account = 'zhangsan'").get();
    const id = hex(1);
    world.store.createBase({ ...PLAIN_BASE, id, ownerId: String(owner?.id), name: preset });

    const status = await world.call("GET", "/api/kb/status", "member");
    expect(status.json()).toMatchObject({ enabled: true, available: false, embeddingReady: true });
    const list = await world.call("GET", BASES, "member");
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ bases: [expect.objectContaining({ id, name: preset })] });

    const refused = await deleteBase(world, id);
    expect(refused.statusCode).toBe(503);
    expect(bodyOf(refused)).toEqual(KB_UNAVAILABLE);
    expect(world.store.getBase(id)).toBeDefined();
    expect(routes(world.fake.requests())).not.toContain(POST_DATASETS);
  });
});
