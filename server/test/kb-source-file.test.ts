/**
 * s2a-kb-ragflow tasks 10.2（#1847）：`kb/source-file.ts` 给组 11 的只 stat 变体（knowledge-bases「文档列表与状态」的
 * `sourceChanged` 取值依据，design D12）：不经 facade，不写 `sandbox.reject`，挂载内经挂载的适配器。入库用的打开经
 * `kb-ingest-workspace*.test.ts` 的端点层覆盖。这里的 `createSourceFiles` 建在 `app.workspaces` 与 `app.mounts` 上，与
 * `kb/index.ts` 同一装配。
 */
import { renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSourceFiles } from "../src/kb/source-file.js";
import { type IngestWorld, useIngestWorlds } from "./kb-ingest-helpers.js";
import { createSeam, put } from "./mounts-file-endpoints-helpers.js";
import { OWNER, W_LISI, W1 } from "./mounts-manager-helpers.js";
import { CASE_MS } from "./mounts-rest-helpers.js";

const open = useIngestWorlds();
const MEMBER = { id: OWNER };

function sourcesOf(world: IngestWorld) {
  const { app } = world.fw.rest;
  return createSourceFiles({ workspaces: app.workspaces, mounts: app.mounts });
}

describe("只 stat 的无审计变体", () => {
  it("普通文件：大小与修改时间，与 stat 一致", async () => {
    const world = await open();
    world.write("sub/a.md", "abc");
    const { mtimeMs } = statSync(join(world.root, "sub/a.md"));
    await expect(sourcesOf(world).stat(MEMBER, W1, "sub/a.md")).resolves.toEqual({
      size: 3,
      mtimeMs,
    });
  });

  it("文件已不存在，或已不是普通文件：absent", async () => {
    const world = await open();
    world.write("gone.md", "a");
    world.write("dir/inner.md", "b");
    rmSync(join(world.root, "gone.md"));
    const sources = sourcesOf(world);
    await expect(sources.stat(MEMBER, W1, "gone.md")).resolves.toBe("absent");
    await expect(sources.stat(MEMBER, W1, "dir")).resolves.toBe("absent");
  });

  it("源路径变成符号链接：null，两次都不写 sandbox.reject", async () => {
    const world = await open();
    world.write("dir/a.md", "a");
    renameSync(join(world.root, "dir"), join(world.root, "moved"));
    symlinkSync(join(world.root, "moved"), join(world.root, "dir"));
    const sources = sourcesOf(world);
    await expect(sources.stat(MEMBER, W1, "dir/a.md")).resolves.toBeNull();
    await expect(sources.stat(MEMBER, W1, "dir/a.md")).resolves.toBeNull();
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("工作空间不可见：null，没有审计", async () => {
    const world = await open();
    const sources = sourcesOf(world);
    await expect(sources.stat(MEMBER, W_LISI, "a.md")).resolves.toBeNull();
    await expect(sources.stat(MEMBER, "f".repeat(32), "a.md")).resolves.toBeNull();
    expect(world.audits("sandbox.reject")).toEqual([]);
  });

  it("挂载离线：null", { timeout: CASE_MS }, async () => {
    const world = await open({ offline: ["docs"] });
    await expect(sourcesOf(world).stat(MEMBER, W1, "docs/a.pdf")).resolves.toBeNull();
  });

  it("在线挂载内经适配器 stat：不存在是 absent", { timeout: CASE_MS }, async () => {
    const seam = createSeam();
    const world = await open({ online: [{ name: "docs" }], overrides: { mountFs: seam.impl } });
    const point = world.fw.point("docs");
    put(point, "a.pdf", "abcd");
    const sources = sourcesOf(world);
    await expect(sources.stat(MEMBER, W1, "docs/a.pdf")).resolves.toMatchObject({ size: 4 });
    await expect(sources.stat(MEMBER, W1, "docs/gone.pdf")).resolves.toBe("absent");
    expect(seam.under(join(point, "a.pdf")).map(({ op }) => op)).toEqual(["lstat"]);
  });
});
