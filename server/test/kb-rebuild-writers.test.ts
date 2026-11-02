/**
 * s2a-kb-ragflow tasks 14.2（#1852）：重建器与在途写操作（knowledge-bases「同一知识库的写操作串行」的「上传与确认重建交错」与
 * 「锁正被重建器持有时立即 409」，design D20）。世界是 `kb-ingest-helpers.ts` 的（`createApp` + 真实挂载 manager + 假 RAGFlow），
 * 入库、上传与重新入库都走真实路由；重建器经注入的调度缝同步驱动。嵌入模型由 store 直接写入：这里的库是种子行，不经建库。
 */
import { describe, expect, it } from "vitest";
import type { KbDependencies } from "../src/kb/index.js";
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

/** 调度缝：唤醒只把一轮排进来，`drain` 按次序跑完。 */
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
  };
}

/** 嵌入模型已配置的世界，返回世界与调度缝。 */
async function configured() {
  const schedule = scheduler();
  const world = await open({ kb: { rebuildSchedule: schedule.rebuildSchedule } });
  world.store.saveSettings({ embedding: EMBEDDING });
  return { world, drain: schedule.drain };
}

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
