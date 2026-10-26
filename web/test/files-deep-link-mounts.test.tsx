/**
 * files-web「地址定位到文件」进到挂载里（#1797 F2）：空间根的 `tree` 不列出挂载点（D21），于是定位把在线挂载的
 * 名字当作根下列出的目录——逐级请求并展开它，落在文件上选中，落在目录上展开，落在挂载根本身上展开它。离线
 * 挂载照它的行（不可展开）：不展开，那一级照常请求一次，失败是服务端的信封文案，`刷新` 不再请求它。
 *
 * 接缝：文件页的真实外壳（桩掉的 `fetch`）与直接渲染的 `WorkspaceBrowser`（句柄的 `reveal`）。期望值是规格里的
 * 字面量与按端点约定手写的地址（`tree?path=` 整段编码）。
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  expectEmptyPreview,
  findRow,
  previewRegion,
  row,
  settle,
  tree,
} from "./files-deep-link-support.js";
import { cleanupFilesFixture, expectLocation } from "./files-fixture.js";
import {
  dirEntry,
  fileEntry,
  fileUrl,
  openFiles,
  rowIn,
  rowsUnder,
  treeUrl,
} from "./files-ops-support.js";
import {
  calls,
  createFetchMock,
  deferredResponse,
  jsonResponse,
  textPreviewResponse,
} from "./support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const ROOT = "设计文档";
const MOUNT = "远端";
const OFFLINE = "离线";
const OFFLINE_MESSAGE = "挂载已离线，重新连接后可用";

const view = {
  backend: "sftp",
  host: "files.intra",
  port: null,
  remotePath: "/data",
  sourceId: null,
  sourceName: null,
  readOnly: false,
  createdAt: 1_760_000_000_000,
};
const remote = { ...view, id: "m-1", name: MOUNT, status: "online" };
const offline = { ...view, id: "m-2", name: OFFLINE, status: "offline" };
const mountList = () => jsonResponse({ enabled: true, mounts: [remote, offline] });

/** 根下只有 `out`（不列挂载点）；`远端` 里是 `doc.pdf`、`notes.md` 与目录 `sub`（`x.md`）。 */
const listings = () => ({
  "": [dirEntry("out")],
  out: [fileEntry("a.md")],
  [MOUNT]: [dirEntry("sub"), fileEntry("doc.pdf"), fileEntry("notes.md")],
  [`${MOUNT}/sub`]: [fileEntry("x.md")],
});

const at = (path: string) => `/files?${new URLSearchParams({ ws: "workspace-1", path })}`;

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
});

function open(path: string, extra = {}) {
  const page = openFiles(
    listings(),
    {
      [MOUNTS]: mountList,
      [treeUrl(OFFLINE)]: () =>
        jsonResponse({ error: { code: "mount_offline", message: OFFLINE_MESSAGE } }, 409),
      ...extra,
    },
    at(path),
  );
  const trees = () =>
    page.fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes("/tree?path="));
  return { ...page, trees };
}

describe("地址定位进到挂载里", () => {
  it("path=远端/doc.pdf：依次请求根与 远端 各一次，远端 行展开、doc.pdf 选中，地址不变", async () => {
    const page = open(`${MOUNT}/doc.pdf`);
    const mountButton = await findRow(`折叠 ${MOUNT}`);
    await waitFor(() => expect(rowIn(MOUNT, "doc.pdf").getAttribute("aria-current")).toBe("true"));

    expect(mountButton.getAttribute("aria-expanded")).toBe("true");
    expect(page.trees()).toStrictEqual([treeUrl(""), treeUrl(MOUNT)]);
    expect(previewRegion().getByText(`${MOUNT}/doc.pdf`, { exact: true })).toBeTruthy();
    await expectLocation(at(`${MOUNT}/doc.pdf`));
  });

  it("path=远端/sub（挂载里的目录）：远端 与 sub 都展开、sub 的条目在，不选中文件、预览区是空态", async () => {
    const page = open(`${MOUNT}/sub`);
    await findRow(`折叠 ${MOUNT}`);
    await waitFor(() => expect(rowsUnder("sub")).toStrictEqual(["x.md"]));

    expect(row("折叠 sub").getAttribute("aria-expanded")).toBe("true");
    expect(page.trees()).toStrictEqual([treeUrl(""), treeUrl(MOUNT), treeUrl(`${MOUNT}/sub`)]);
    expectEmptyPreview();
    expect(screen.queryByText("文件不存在")).toBeNull();
  });

  it("path=远端（挂载根本身，挂载列表先于根的 tree 到）：远端 行展开、它的条目在，没有 文件不存在、预览区是空态", async () => {
    const root = deferredResponse();
    const page = open(MOUNT, { [treeUrl("")]: () => root.promise });
    await findRow(`展开 ${MOUNT}`);
    root.resolve(jsonResponse({ path: "", entries: [dirEntry("out")] }));

    await waitFor(() => expect(rowsUnder(MOUNT)).toStrictEqual(["sub", "doc.pdf", "notes.md"]));
    expect(row(`折叠 ${MOUNT}`).getAttribute("aria-expanded")).toBe("true");
    expect(page.trees()).toStrictEqual([treeUrl(""), treeUrl(MOUNT)]);
    await settle();
    expectEmptyPreview();
    expect(screen.queryByText("文件不存在")).toBeNull();
  });

  it("path=离线/s.md（离线挂载）：离线 行不可展开；那一级恰请求一次，预览区是它的信封文案；刷新 不再请求它", async () => {
    const page = open(`${OFFLINE}/s.md`);
    await findRow(`折叠 ${ROOT}`);
    expect((await previewRegion().findByRole("alert")).textContent).toBe(OFFLINE_MESSAGE);
    expect(within(tree()).queryByRole("button", { name: `展开 ${OFFLINE}` })).toBeNull();
    expect(within(tree()).queryByRole("button", { name: `折叠 ${OFFLINE}` })).toBeNull();
    expect(page.trees()).toStrictEqual([treeUrl(""), treeUrl(OFFLINE)]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await waitFor(() => expect(calls(page.fetchMock, MOUNTS)).toHaveLength(2));
    await settle();
    expect(calls(page.fetchMock, treeUrl(OFFLINE))).toHaveLength(1);
  });
});

describe("句柄的 reveal 进到挂载里", () => {
  it("reveal(远端/notes.md)：请求 远端 一次、展开它、选中并上报一次、恰一次 file", async () => {
    const fetchMock = createFetchMock({
      [MOUNTS]: mountList,
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [dirEntry("out")] }),
      [treeUrl(MOUNT)]: () => jsonResponse({ path: MOUNT, entries: listings()[MOUNT] }),
      [fileUrl(`${MOUNT}/notes.md`)]: () => textPreviewResponse("远端说明"),
    });
    vi.stubGlobal("fetch", fetchMock);
    const handle = createRef<WorkspaceBrowserHandle>();
    const onPathChange = vi.fn();
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        name={ROOT}
        onPathChange={onPathChange}
        path={null}
        ref={handle}
        workspaceId="workspace-1"
      />,
    );
    await findRow(`展开 ${MOUNT}`);

    act(() => handle.current?.reveal(`${MOUNT}/notes.md`));
    await waitFor(() => expect(rowIn(MOUNT, "notes.md").getAttribute("aria-current")).toBe("true"));
    expect(await previewRegion().findByText("远端说明")).toBeTruthy();
    expect(row(`折叠 ${MOUNT}`).getAttribute("aria-expanded")).toBe("true");
    expect(calls(fetchMock, treeUrl(MOUNT))).toHaveLength(1);
    expect(calls(fetchMock, fileUrl(`${MOUNT}/notes.md`))).toHaveLength(1);
    expect(onPathChange.mock.calls).toStrictEqual([[`${MOUNT}/notes.md`]]);
  });
});
