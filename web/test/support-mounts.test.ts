// 共享 fetch 桩对挂载列表的缺省应答与请求记录的过滤（s1b-workspace-mounts 10.2；workspace-mounts「挂载根行」：
// `WorkspaceBrowser` 进入空间、`刷新`、建出与卸载之后请求 `GET …/mounts`，既有用例的路由表不登记它）。

import { describe, expect, it } from "vitest";
import { createFetchMock, jsonResponse, paths } from "./support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const TREE_NAMED_MOUNTS = "/api/workspaces/workspace-1/tree?path=mounts";

describe("support.ts：挂载列表的缺省应答", () => {
  it("未登记的 GET …/mounts（不带方法或显式 GET）应答 {enabled:false, mounts:[]}，每次一份新应答", async () => {
    const fetchMock = createFetchMock({});
    for (const options of [undefined, { method: "GET" }, undefined]) {
      const response = await fetchMock(MOUNTS, options);
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ enabled: false, mounts: [] });
    }
    const other = await fetchMock("/api/workspaces/other-space/mounts");
    expect(await other.json()).toStrictEqual({ enabled: false, mounts: [] });
  });

  it("登记了的 …/mounts 走登记值；登记的数组用完后不回落到缺省应答", async () => {
    const listed = { enabled: true, mounts: [] };
    const fetchMock = createFetchMock({ [MOUNTS]: [jsonResponse(listed)] });
    expect(await (await fetchMock(MOUNTS)).json()).toStrictEqual(listed);
    expect(() => fetchMock(MOUNTS)).toThrow(`unexpected request ${MOUNTS}`);
  });

  it.each([
    ["POST …/mounts", MOUNTS, { method: "POST", body: "{}" }],
    ["DELETE …/mounts/<id>", `${MOUNTS}/m1`, { method: "DELETE" }],
    ["GET …/mounts/<id>", `${MOUNTS}/m1`, undefined],
    ["GET …/mounts 带查询串", `${MOUNTS}?x=1`, undefined],
    ["名为 mounts 的目录的 tree", TREE_NAMED_MOUNTS, undefined],
    ["别的未登记地址", "/api/workspaces/workspace-1/tree?path=", undefined],
  ] as const)("其余未登记请求照旧抛 unexpected request：%s", (_case, path, options) => {
    const fetchMock = createFetchMock({});
    expect(() => fetchMock(path, options)).toThrow(`unexpected request ${path}`);
  });
});

describe("support.ts：paths() 滤掉 …/mounts", () => {
  it("按路径名滤：…/mounts、其查询串与子路径都不在记录里，名为 mounts 的条目的 tree 与 file 照旧在", async () => {
    const answer = () => jsonResponse({});
    const kept = [
      "/api/workspaces/workspace-1/tree?path=",
      TREE_NAMED_MOUNTS,
      "/api/workspaces/workspace-1/file?path=mounts%2Fa.md",
      "/api/workspaces/workspace-1/mounts-archive",
    ];
    const dropped = [MOUNTS, `${MOUNTS}?x=1`, `${MOUNTS}/m1`, "/api/workspaces/other/mounts"];
    const fetchMock = createFetchMock(
      Object.fromEntries([...kept, ...dropped].map((path) => [path, answer])),
    );
    await fetchMock(kept[0] as string);
    await fetchMock(MOUNTS);
    await fetchMock(kept[1] as string);
    await fetchMock(`${MOUNTS}/m1`, { method: "DELETE" });
    await fetchMock(kept[2] as string);
    await fetchMock(`${MOUNTS}?x=1`);
    await fetchMock("/api/workspaces/other/mounts");
    await fetchMock(kept[3] as string);

    expect(paths(fetchMock)).toStrictEqual(kept);
    expect(fetchMock.mock.calls).toHaveLength(kept.length + dropped.length);
  });
});
