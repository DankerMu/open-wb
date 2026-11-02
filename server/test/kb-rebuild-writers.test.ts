/**
 * s2a-kb-ragflow tasks 14.2（#1852）：重建器与在途写操作（knowledge-bases「同一知识库的写操作串行」的「上传与确认重建交错」与
 * 「锁正被重建器持有时立即 409」，design D20）。世界是 `kb-ingest-helpers.ts` 的（`createApp` + 真实挂载 manager + 假 RAGFlow），
 * 入库、上传与重新入库都走真实路由；重建器经注入的调度缝同步驱动。嵌入模型由 store 直接写入：这里的库是种子行，不经建库。
 * 关停（`app.kbRebuild.stop()`）不等排在写锁队列里的重建器：排队者拿到锁不读库，靠 `db.prepare` 上的间谍看（中止的出站本来
 * 就不发，读库是唯一的差别）。
 */
import { describe, expect, it, vi } from "vitest";
import type { KbDependencies } from "../src/kb/index.js";
import { POST_DATASETS } from "./kb-bases-helpers.js";
import { type IngestWorld, ingestedRow, REBUILDING, useIngestWorlds } from "./kb-ingest-helpers.js";
import { DATASETS, DOWNLOAD, NEW_NAME, UPLOAD } from "./kb-rebuild-helpers.js";
import { upload } from "./kb-upload-helpers.js";
import { send } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();
const EMBEDDING = {
  name: "bge-m3",
  baseUrl: "http://embed.upstream.test/v1",
  apiKey: "wb-issue1852-embed-key",
};

/** 调度缝：唤醒只把一轮排进来，`drain` 按次序跑完；`pending` 是排着还没跑的轮数。 */
function scheduler() {
  const passes: Array<() => Promise<void>> = [];
  const rebuildSchedule: KbDependencies["rebuildSchedule"] = (pass) => {
    passes.push(pass);
  };
  return {
    rebuildSchedule,
    async drain() {
      for (let pass = passes.shift(); pass !== undefined; pass = passes.shift()) {
        await pass();
      }
    },
    pending: () => passes.length,
  };
}

/** 嵌入模型已配置的世界，返回世界与调度缝。 */
async function configured() {
  const schedule = scheduler();
  const world = await open({ kb: { rebuildSchedule: schedule.rebuildSchedule } });
  world.store.saveSettings({ embedding: EMBEDDING });
  return { world, drain: schedule.drain, pending: schedule.pending };
}

/**
 * `promise` 在下一轮事件循环之前是否已落定。关停只中止在途请求、等正在持锁的那一个库，中间没有要等的 I/O；等写锁队列或等整轮
 * 才会拖到挂起的上游放行之后。
 */
async function settledNow(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

const stopNow = (world: IngestWorld): Promise<boolean> =>
  settledNow(world.fw.rest.app.kbRebuild.stop());

/** 该库的 `kb.rebuild` 审计（确认重建那一条不带库 id）。 */
const baseAudits = (world: IngestWorld, id: string) =>
  world.audits("kb.rebuild").filter(({ detail }) => detail.id === id);

function confirm(world: IngestWorld) {
  return world.fw.rest.app.inject({
    method: "PUT",
    url: "/api/kb/settings",
    headers: { cookie: world.fw.rest.cookies.admin },
    payload: { embedding: { ...EMBEDDING, name: NEW_NAME }, confirmRebuild: true },
  });
}

describe("上传与确认重建交错", () => {
  it("上传挂起时确认重建：上传 201；重建器在它之后才枚举，新数据集含这份文档，旧数据集已删", async () => {
    const { world, drain } = await configured();
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const uploading = upload(world, "a.md", "alpha");
    await gate.reached;
    expect((await confirm(world)).statusCode).toBe(200);
    expect(world.store.getBase(world.baseId)?.state).toBe("rebuilding");

    const pass = drain();
    expect(world.locks.writeWaiters(world.baseId)).toBe(1);
    expect(world.countOf(DOWNLOAD)).toBe(0);
    gate.release();
    expect((await uploading).statusCode).toBe(201);
    await pass;

    const base = world.store.getBase(world.baseId);
    expect(base).toMatchObject({ state: "ready", rebuildDatasetId: null });
    const next = base?.datasetId ?? "";
    expect(next).not.toBe(world.datasetId);
    const inNew = world.fake.documents(next).map(({ id }) => id);
    expect(world.rows().map(({ ragflowDocumentId }) => ragflowDocumentId)).toEqual(inNew);
    expect(inNew).toHaveLength(1);
    expect(world.fake.datasets().map(({ id }) => id)).not.toContain(world.datasetId);
    expect(world.countOf(DOWNLOAD)).toBe(1);
  });
});

describe("锁正被重建器持有", () => {
  it("切换之后删旧一代时：入库、上传与重新入库都立即 409 kb_rebuilding，不发出站；放行之后照常入库", async () => {
    const { world, drain } = await configured();
    const document = await ingestedRow(world, "a.md", "alpha");
    world.write("b.md", "beta");
    expect((await confirm(world)).statusCode).toBe(200);
    const gate = world.fake.fault(DATASETS, { kind: "hold" });
    const pass = drain();
    await gate.reached;
    expect(world.store.getBase(world.baseId)?.state).toBe("ready");

    const sent = world.fake.requests().length;
    const reingestUrl = `/api/kb/bases/${world.baseId}/documents/reingest?doc=${document.id}`;
    for (const response of [
      await world.ingest(["b.md"]),
      await upload(world, "c.md", "gamma"),
      await send(world.fw.rest, "member", "POST", reingestUrl),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual(REBUILDING);
    }
    expect(world.fake.requests()).toHaveLength(sent);
    expect(world.locks.writeWaiters(world.baseId)).toBe(0);

    gate.release();
    await pass;
    expect((await world.ingest(["b.md"])).statusCode).toBe(201);
  });
});

describe("关停时排队的重建器（rebuild.ts 文件头「关停」）", () => {
  it("排在上传之后时关停：stop 不等它；上传照常 201，它拿到锁即放，不读库、不出站、不审计，库仍 rebuilding", async () => {
    const { world, drain } = await configured();
    const gate = world.fake.fault(UPLOAD, { kind: "hold" });
    const uploading = upload(world, "a.md", "alpha");
    await gate.reached;
    expect((await confirm(world)).statusCode).toBe(200);
    const pass = drain();
    expect(world.locks.writeWaiters(world.baseId)).toBe(1);

    expect(await stopNow(world)).toBe(true);
    // 放行之后上传还要触发解析、写行与审计；重建器的两张表只有它会读。
    const prepared = vi.spyOn(world.fw.world.db, "prepare");
    gate.release();
    expect((await uploading).statusCode).toBe(201);
    await pass;
    const statements = prepared.mock.calls.map(([sql]) => sql);
    prepared.mockRestore();

    // 间谍确实看着同一个 DB：上传的写行在里面。
    expect(statements.some((sql) => sql.startsWith("INSERT INTO kb_documents"))).toBe(true);
    expect(statements.filter((sql) => /knowledge_bases|kb_settings/u.test(sql))).toEqual([]);
    expect(world.store.getBase(world.baseId)?.state).toBe("rebuilding");
    expect(world.countOf(POST_DATASETS)).toBe(0);
    expect(world.countOf(DOWNLOAD)).toBe(0);
    expect(baseAudits(world, world.baseId)).toEqual([]);
  });

  it("第一个库下载挂起时关停：这一轮不再排进第二个库的写锁，第二个库没有任何出站；两个库都仍 rebuilding", async () => {
    const { world, drain } = await configured();
    const document = await ingestedRow(world, "a.md", "alpha");
    const second = world.addBase("naive");
    // 清单按 created_at、id 排：同一毫秒建的两个库次序随 id，把第二个库挪后。
    world.fw.world.db
      .prepare("UPDATE knowledge_bases SET created_at = created_at + 1 WHERE id = ?")
      .run(second.baseId);
    const writing = world.fake.fault(UPLOAD, { kind: "hold" });
    const uploading = upload(world, "b.md", "beta", { baseId: second.baseId });
    await writing.reached;
    expect((await confirm(world)).statusCode).toBe(200);
    const downloading = world.fake.fault(DOWNLOAD, { kind: "hold" });
    const sent = world.lines().length;
    const pass = drain();
    await downloading.reached;

    expect(await stopNow(world)).toBe(true);
    expect(await settledNow(pass)).toBe(true);
    expect(world.locks.writeWaiters(second.baseId)).toBe(0);
    expect(world.lines().slice(sent)).toEqual([
      POST_DATASETS,
      `GET /api/v1/datasets/${world.datasetId}/documents/${document.ragflowDocumentId}`,
    ]);

    downloading.release();
    writing.release();
    expect((await uploading).statusCode).toBe(201);
    for (const id of [world.baseId, second.baseId]) {
      expect(world.store.getBase(id)?.state).toBe("rebuilding");
      expect(baseAudits(world, id)).toEqual([]);
    }
    expect(world.countOf(POST_DATASETS)).toBe(1);
  });

  it("关停之后确认重建：200，唤醒什么都不排，库仍 rebuilding", async () => {
    const { world, pending } = await configured();
    expect(await stopNow(world)).toBe(true);
    expect((await confirm(world)).statusCode).toBe(200);
    expect(pending()).toBe(0);
    expect(world.store.getBase(world.baseId)?.state).toBe("rebuilding");
    expect(world.countOf(POST_DATASETS)).toBe(0);
  });

  it("关停之前排下的一轮在关停之后才跑：不读库、不出站，库仍 rebuilding", async () => {
    const { world, drain, pending } = await configured();
    expect((await confirm(world)).statusCode).toBe(200);
    expect(pending()).toBe(1);
    expect(await stopNow(world)).toBe(true);
    const prepared = vi.spyOn(world.fw.world.db, "prepare");
    await drain();
    const statements = prepared.mock.calls.map(([sql]) => sql);
    prepared.mockRestore();
    expect(statements).toEqual([]);
    expect(world.store.getBase(world.baseId)?.state).toBe("rebuilding");
    expect(world.countOf(POST_DATASETS)).toBe(0);
  });
});
