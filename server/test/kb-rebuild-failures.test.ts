/**
 * s2a-kb-ragflow tasks 14.2（#1852）：重建的失败、跳过与重试（ragflow-backend「嵌入模型更换与全量重建」的失败一支、「不存在视为
 * 已删」的重建一腿，knowledge-bases「知识库端点」的「重建失败时删库」，design D8、D9、D20）。世界与调度缝同 `kb-rebuild.test.ts`。
 * 故障只用 tasks.md 头部的四种；`code:0` 的 `models:[]`、`success_count:0` 与 `DELETE /datasets` 的 `code:403` 是实测记录里的协议
 * 应答（§11.4、§8.1、表 B）。期望值是 spec 与实测记录的字面量。
 */
import { describe, expect, it } from "vitest";
import {
  auditsOf,
  createdBase,
  createdCompileBase,
  datasetIdOf,
  deleteBase,
  GET_DEFAULTS,
  POST_DATASETS,
} from "./kb-bases-helpers.js";
import {
  ABSENT,
  ADMIN,
  baseOf,
  confirm,
  DATASETS,
  DOWNLOAD,
  EMPTY_FILE_BODY,
  expectRebuildFailed,
  expectRebuilt,
  PARSE,
  plainRebuildOf,
  REBUILD_FAILED,
  rebuildAudits,
  seedDocument,
  UPLOAD,
} from "./kb-rebuild-helpers.js";
import {
  bodyOf,
  chatWorld,
  configuredWorld,
  routes,
  useSettingsWorlds,
  type World,
} from "./kb-settings-helpers.js";

const open = useSettingsWorlds();

const REBUILDING = { error: { code: "kb_rebuilding", message: "知识库正在重建，请稍后再试" } };
const isUpload = ({ method, path }: { method: string; path: string }) =>
  method === "POST" && path.endsWith("/documents");

/** 一个开了 RAPTOR 的库，带一份原件，已确认、还没驱动重建。 */
async function confirmedCompileBase(world: World) {
  const base = await createdCompileBase(world, "编译库");
  seedDocument(world, base.id, "a.md", "alpha");
  expect((await confirm(world)).statusCode).toBe(200);
  world.forget();
  return baseOf(world, base.id);
}

describe("一个库的失败", () => {
  it("账号缺省缺失时重建失败：models 为空即 rebuild_failed，不建模板组、画布与数据集", async () => {
    const world = await chatWorld(open);
    const base = await confirmedCompileBase(world);
    world.fake.answer(GET_DEFAULTS, { code: 0, data: { models: [] } });
    await world.rebuild();
    expect(routes(world.sent())).toEqual([GET_DEFAULTS]);
    expectRebuildFailed(world, base.id);
    expect(baseOf(world, base.id).rebuildDatasetId).toBeNull();
  });

  it("不带头的错误应答：HTTP 200、无 Content-Disposition、code 500 的下载即 rebuild_failed，没有上传", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    // 本地 size 恰是错误正文的字节数：错当成文件也对得上字节数，只剩「有没有 Content-Disposition」能判它失败。
    seedDocument(world, base.id, "empty.md", "", Buffer.byteLength(EMPTY_FILE_BODY));
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();
    await world.rebuild();
    expect(world.sent().filter(isUpload)).toEqual([]);
    expectRebuildFailed(world, base.id);
    expect(world.store.listDocuments(base.id)).toHaveLength(1);
  });

  it.each([
    ["比本地 size 少一个字节", 6],
    ["比本地 size 多一个字节", 4],
  ])("下载字节%s：该库 rebuild_failed，上传没有结束边界，不触发解析", async (_label, size) => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    seedDocument(world, base.id, "a.md", "alpha", size);
    expect((await confirm(world)).statusCode).toBe(200);
    world.forget();
    await world.rebuild();
    // 计数在出站之前就可能判定不符，请求连请求头都没发出；发出了的也没有结束边界。
    const uploads = world.sent().filter(isUpload);
    expect(uploads.length).toBeLessThanOrEqual(1);
    expect(uploads.filter(({ multipart }) => multipart !== null)).toEqual([]);
    expect(world.sent().some(({ path }) => path.endsWith("/parse"))).toBe(false);
    expect(world.fake.documents(baseOf(world, base.id).rebuildDatasetId ?? "")).toEqual([]);
    expectRebuildFailed(world, base.id);
  });

  it("解析未启动（success_count:0）时该库 rebuild_failed", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    seedDocument(world, base.id, "a.md", "alpha");
    expect((await confirm(world)).statusCode).toBe(200);
    world.fake.answer(PARSE, { code: 0, data: { success_count: 0 } });
    await world.rebuild();
    expectRebuildFailed(world, base.id);
  });
});

describe("旧一代删除失败", () => {
  it.each([
    [
      "删旧数据集 503：恰一行 kb_dataset_leak，不删画布与模板组",
      DATASETS,
      (old: ReturnType<typeof baseOf>) => [{ event: "kb_dataset_leak", datasetId: old.datasetId }],
      [],
    ],
    [
      "删旧画布 503：恰一行 kb_pipeline_leak，两个 id 都在，不删模板组",
      "DELETE /api/v1/agents/*",
      (old: ReturnType<typeof baseOf>) => [
        { event: "kb_pipeline_leak", canvasId: old.canvasId, groupId: old.templateGroupId },
      ],
      ["DELETE /api/v1/agents"],
    ],
    [
      "删旧模板组 503：恰一行 kb_pipeline_leak，canvasId 为 null",
      "DELETE /api/v1/compilation-template-groups/*",
      (old: ReturnType<typeof baseOf>) => [
        { event: "kb_pipeline_leak", canvasId: null, groupId: old.templateGroupId },
      ],
      ["DELETE /api/v1/agents", "DELETE /api/v1/compilation-template-groups"],
    ],
  ])("%s；库照常 ready", async (_label, route, leaks, sentAfter) => {
    const world = await chatWorld(open);
    const old = await confirmedCompileBase(world);
    world.fake.fault(route, { kind: "status", status: 503 });
    await world.rebuild();
    expect(world.logged).toEqual(leaks(old));
    const lines = routes(world.sent());
    const tail = lines.slice(lines.lastIndexOf(DATASETS) + 1);
    expect(tail.map((line) => line.slice(0, line.lastIndexOf("/")))).toEqual(sentAfter);
    expectRebuilt(world, old.id);
    expect(rebuildAudits(world).at(-1)?.detail).toEqual({ id: old.id, result: "ok", skipped: [] });
  });
});

describe("中途失败、重试与不存在视为已删", () => {
  it("中途失败与重试：第二个库上传 500 即 rebuild_failed，第一个照常 ready；失败的库入库 409、移出可行，重试先删残留的新一代", async () => {
    const world = await configuredWorld(open);
    await createdBase(world, "甲");
    await createdBase(world, "乙");
    expect((await confirm(world)).statusCode).toBe(200);
    // 重建器的处理次序就是这张清单的次序（`created_at`、`id`）。
    const [first, second] = world.store.listBasesInState("rebuilding");
    if (first === undefined || second === undefined) throw new Error("two bases expected");
    seedDocument(world, first.id, "a.md", "alpha");
    const kept = seedDocument(world, second.id, "b.md", "beta");
    const removed = seedDocument(world, second.id, "c.md", "gamma");
    // 第一份上传照常走（放行的 hold 只占一次），第二份即第二个库的上传。
    world.fake.fault(UPLOAD, { kind: "hold" }).release();
    world.fake.fault(UPLOAD, { kind: "status", status: 500 });
    await world.rebuild();

    expectRebuilt(world, first.id);
    expectRebuildFailed(world, second.id);
    const residual = baseOf(world, second.id).rebuildDatasetId;
    expect(residual).not.toBeNull();
    const uploadUrl = `/api/kb/bases/${second.id}/uploads?name=d.md`;
    const blocked = await world.raw(
      "POST",
      uploadUrl,
      "delta",
      "application/octet-stream",
      "member",
    );
    expect(blocked.statusCode).toBe(409);
    expect(bodyOf(blocked)).toEqual(REBUILDING);
    const removal = await world.call(
      "DELETE",
      `/api/kb/bases/${second.id}/documents?doc=${removed.id}`,
      "member",
    );
    expect(removal.statusCode).toBe(204);

    const old = datasetIdOf(world, second.id);
    world.forget();
    const retried = await world.retry();
    expect(retried.statusCode).toBe(200);
    expect(bodyOf(retried)).toMatchObject({ rebuilding: 1, rebuildFailed: 0, documents: 2 });
    await world.rebuild();
    expect(routes(world.sent())).toEqual([
      DATASETS,
      ...plainRebuildOf(old, datasetIdOf(world, second.id), [kept]),
    ]);
    expect(world.sent()[0]?.json).toEqual({ ids: [residual] });
    expectRebuilt(world, second.id);
    expect(rebuildAudits(world).slice(-2)).toEqual([
      { actorId: ADMIN, detail: { bases: 1, documents: 1, retry: true } },
      { actorId: ADMIN, detail: { id: second.id, result: "ok", skipped: [] } },
    ]);
  });

  it("第 1 步删残留的一代得到「不存在」组合（403、103、404）时照常继续，最终 ready", async () => {
    const world = await chatWorld(open);
    const base = await confirmedCompileBase(world);
    const residual = { datasetId: ABSENT, canvasId: ABSENT, templateGroupId: ABSENT };
    world.store.setRebuildGeneration(base.id, residual);
    world.store.failRebuild(base.id, REBUILD_FAILED);
    expect((await world.retry()).statusCode).toBe(200);
    await world.rebuild();
    expect(routes(world.sent()).slice(0, 4)).toEqual([
      DATASETS,
      `DELETE /api/v1/agents/${ABSENT}`,
      `DELETE /api/v1/compilation-template-groups/${ABSENT}`,
      GET_DEFAULTS,
    ]);
    expectRebuilt(world, base.id);
    expect(world.logged).toEqual([]);
  });

  it("rebuild_failed 删库时新一代为「不存在」（code:403）：照常删当前一代，204，恰一条 kb.delete", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    seedDocument(world, base.id, "a.md", "alpha");
    expect((await confirm(world)).statusCode).toBe(200);
    world.fake.fault(UPLOAD, { kind: "status", status: 500 });
    await world.rebuild();
    const failed = baseOf(world, base.id);
    expect(failed.state).toBe("rebuild_failed");
    world.forget();
    world.fake.answer(DATASETS, { code: 403, message: "Permission denied" });
    expect((await deleteBase(world, base.id)).statusCode).toBe(204);
    expect(world.sent().map(({ json }) => json)).toEqual([
      { ids: [failed.rebuildDatasetId] },
      { ids: [failed.datasetId] },
    ]);
    expect(world.store.getBase(base.id)).toBeUndefined();
    expect(auditsOf(world, "kb.delete")).toHaveLength(1);
  });

  it("重建器取锁后发现库已删除即跳过：不建数据集，不写这个库的 kb.rebuild", async () => {
    const world = await configuredWorld(open);
    const base = await createdBase(world, "甲");
    world.store.failRebuild(base.id, REBUILD_FAILED);
    const gate = world.fake.fault(DATASETS, { kind: "hold" });
    const removal = deleteBase(world, base.id);
    await gate.reached;
    expect((await world.retry()).statusCode).toBe(200);
    expect(baseOf(world, base.id).state).toBe("rebuilding");
    world.forget();
    const pass = world.rebuild();
    expect(world.locks.writeWaiters(base.id)).toBe(1);
    gate.release();
    expect((await removal).statusCode).toBe(204);
    await pass;
    expect(world.store.getBase(base.id)).toBeUndefined();
    expect(routes(world.sent())).not.toContain(POST_DATASETS);
    expect(rebuildAudits(world).map(({ detail }) => detail)).toEqual([
      { bases: 1, documents: 0, retry: true },
    ]);
  });
});

describe("一轮途中的唤醒", () => {
  it("第一个库失败、第二个库下载挂起时重试：不另排一轮，这一轮结束后再走一遍清单，两个库都 ready", async () => {
    const world = await configuredWorld(open);
    await createdBase(world, "甲");
    await createdBase(world, "乙");
    expect((await confirm(world)).statusCode).toBe(200);
    const [first, second] = world.store.listBasesInState("rebuilding");
    if (first === undefined || second === undefined) throw new Error("two bases expected");
    seedDocument(world, first.id, "a.md", "alpha");
    seedDocument(world, second.id, "b.md", "beta");
    // 第一份下载照常走（放行的 hold 只占一次），第二份即第二个库的下载；上传 500 只落在第一个库。
    world.fake.fault(DOWNLOAD, { kind: "hold" }).release();
    const gate = world.fake.fault(DOWNLOAD, { kind: "hold" });
    world.fake.fault(UPLOAD, { kind: "status", status: 500 });
    const pass = world.rebuild();
    await gate.reached;
    expectRebuildFailed(world, first.id);

    const retried = await world.retry();
    expect(bodyOf(retried)).toMatchObject({ rebuilding: 2, rebuildFailed: 0 });
    gate.release();
    await pass;
    expectRebuilt(world, first.id);
    expectRebuilt(world, second.id);
  });
});
