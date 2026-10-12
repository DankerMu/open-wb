// files-web「当前文件随操作变化」「随操作更新」里删除的一步，与删除成功之后的跟随：选中项、地址、展开
// 集合、目录的失败文案、在途的目录请求与进行中的定位。期望值按规格的场景手写；请求串整串相等，`DELETE`
// 的地址按 `DELETE …/entries?path=` 的约定手写（`path` 整段编码一次）。确认框本身在
// files-ops-delete.test.tsx。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  address,
  expectEmptyPreview,
  findRow,
  previewRegion,
  row,
  rowNames,
  selectedRow,
  settle,
  tree,
} from "./files-deep-link-support.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectLocation,
  imagePreviewResponse,
  openDirectoryDialog,
  renderFiles,
  secondWorkspace,
  selectWorkspaceByName,
  stubBlobUrls,
  workspace,
} from "./files-fixture.js";
import {
  confirmButton,
  confirmGone,
  deleted,
  dialogGone,
  dirEntry,
  entriesUrl,
  expand,
  fileEntry,
  fileUrl,
  flat,
  type Listings,
  MOVE,
  nested,
  openDelete,
  openFiles,
  openRename,
  renameTo,
  treeUrl,
  withoutOut,
} from "./files-ops-support.js";
import { createFetchMock, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const NOT_FOUND = () =>
  jsonResponse({ error: { code: "not_found", message: "请求的资源不存在" } }, 404);
const DIRS = "/api/workspaces/workspace-1/dirs";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 树上被选中的行数。 */
function selectedCount() {
  return tree().querySelectorAll('[aria-current="true"]').length;
}

describe("当前文件随操作变化：删除", () => {
  it("D11 预览根下的 a.md 时删它：没有选中行，预览区是 未选择文件，地址恰为 /files?ws=workspace-1", async () => {
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    const { mark } = openFiles(listings, {
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [entriesUrl("a.md")]: () => {
        listings[""] = [fileEntry("readme.md", 8)];
        return deleted();
      },
    });
    fireEvent.click(await findRow("a.md"));
    await expectLocation("/files?ws=workspace-1&path=a.md");
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();
    const dialog = await openDelete("a.md");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await expectLocation("/files?ws=workspace-1");
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "readme.md"]));
    await settle();
    expectEmptyPreview();
    expect(previewRegion().queryByText("甲", { exact: true })).toBeNull();
    expect(selectedCount()).toBe(0);
    await expectLocation("/files?ws=workspace-1");
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("a.md")}`, treeUrl("")]);
  });

  it("D12 预览 out/a.md、out/sub 的列表还在途时删 out：在途请求被中止，选中清空，地址没有 path；其后的请求恰为 DELETE 与根的 tree", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { fetchMock, mark } = openFiles(
      listings,
      {
        [treeUrl("out/sub")]: () => held.promise,
        [fileUrl("out/a.md")]: () => textPreviewResponse("甲的正文"),
        [entriesUrl("out")]: () => {
          listings[""] = withoutOut();
          return deleted();
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    fireEvent.click(await findRow("展开 sub"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await expectLocation("/files?ws=workspace-1");
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md"]));
    await settle();
    const stale = fetchMock.mock.calls.filter(([path]) => path === treeUrl("out/sub"));
    expect(stale.map(([, options]) => options?.signal?.aborted)).toStrictEqual([true]);
    expect(within(tree()).queryByText("正在读取目录", { exact: true })).toBeNull();
    expectEmptyPreview();
    expect(selectedCount()).toBe(0);
    // 没有 `tree?path=out`，也没有为地址的变化另起一次定位。
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, treeUrl("")]);

    // 被中止的那一次迟到的列表不再落地。
    await act(async () => {
      held.resolve(jsonResponse({ path: "out/sub", entries: [fileEntry("x.md")] }));
    });
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md"]);
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, treeUrl("")]);
  });

  it("D13 删的不是当前文件也不是它的祖先：选中项、预览与地址都不动，没有 file 请求", async () => {
    const listings = flat();
    const { mark } = openFiles(listings, {
      [fileUrl("readme.md")]: () => textPreviewResponse("自述正文"),
      [entriesUrl("notes.md")]: () => {
        listings[""] = [fileEntry("readme.md", 8)];
        return deleted();
      },
    });
    fireEvent.click(await findRow("readme.md"));
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    const dialog = await openDelete("notes.md");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "readme.md"]));
    await settle();
    await selectedRow("readme.md");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=readme.md");
    // 送出的是被点的那一行的路径，不是选中项的。
    expect(since()).toStrictEqual([
      "DELETE /api/workspaces/workspace-1/entries?path=notes.md",
      treeUrl(""),
    ]);
  });

  it("D13b 预览 output/o.md 时删名字是它前缀的同级 out：选中项、预览、地址与 output 的展开都不动", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("output/o.md")]: () => textPreviewResponse("同级的正文"),
        [entriesUrl("out")]: () => {
          listings[""] = withoutOut();
          return deleted();
        },
      },
      address("output/o.md"),
    );
    await findRow("折叠 output");
    expect(await previewRegion().findByText("同级的正文", { exact: true })).toBeTruthy();
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "output", "o.md", "top.md"]));
    await settle();
    await selectedRow("o.md");
    expect(row("折叠 output").getAttribute("aria-expanded")).toBe("true");
    expect(previewRegion().getByText("同级的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=output%2Fo.md");
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, treeUrl("")]);
  });

  it("D14 随操作更新：当前文件 a.md 改名为 b.md 后删除，地址的 path 依次是 b.md、被移除，ws 不变", async () => {
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    openFiles(listings, {
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [fileUrl("b.md")]: () => textPreviewResponse("乙"),
      [MOVE]: () => {
        listings[""] = [fileEntry("b.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "b.md" });
      },
      [entriesUrl("b.md")]: () => {
        listings[""] = [fileEntry("readme.md", 8)];
        return deleted();
      },
    });
    fireEvent.click(await findRow("a.md"));
    await expectLocation("/files?ws=workspace-1&path=a.md");

    renameTo(await openRename("a.md"), "b.md");
    await dialogGone();
    await expectLocation("/files?ws=workspace-1&path=b.md");
    expect(await previewRegion().findByText("乙", { exact: true })).toBeTruthy();

    fireEvent.click(confirmButton(await openDelete("b.md")));
    await confirmGone();
    await expectLocation("/files?ws=workspace-1");
    await settle();
    expect(new URLSearchParams(window.location.search).has("path")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("ws")).toBe("workspace-1");
    expectEmptyPreview();
  });

  it("D24 随操作更新的三步连着走：当前文件 a.md 改名为 b.md、删除、再经切换器换到另一个空间——path 依次是 b.md、被移除、保持移除，ws 依次是原空间、原空间、新空间；新空间里同名的 b.md 不被选中", async () => {
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace, secondWorkspace], {
        [treeUrl("")]: () => jsonResponse({ path: "", entries: listings[""] }),
        "/api/workspaces/workspace-2/tree?path=": () =>
          jsonResponse({ path: "", entries: [fileEntry("b.md")] }),
        [fileUrl("a.md")]: () => textPreviewResponse("甲"),
        [fileUrl("b.md")]: () => textPreviewResponse("乙"),
        [MOVE]: () => {
          listings[""] = [fileEntry("b.md"), fileEntry("readme.md", 8)];
          return jsonResponse({ path: "b.md" });
        },
        [entriesUrl("b.md")]: () => {
          listings[""] = [fileEntry("readme.md", 8)];
          return deleted();
        },
      }),
    );
    fireEvent.click(await findRow("a.md"));
    await expectLocation("/files?ws=workspace-1&path=a.md");

    renameTo(await openRename("a.md"), "b.md");
    await dialogGone();
    await expectLocation("/files?ws=workspace-1&path=b.md");
    expect(await previewRegion().findByText("乙", { exact: true })).toBeTruthy();

    fireEvent.click(confirmButton(await openDelete("b.md")));
    await confirmGone();
    await expectLocation("/files?ws=workspace-1");
    await settle();

    await yieldMacrotask();
    await selectWorkspaceByName(/数据分析/);
    await expectLocation("/files?ws=workspace-2");
    await waitFor(() => expect(rowNames()).toStrictEqual(["数据分析", "b.md"]));
    await settle();
    await expectLocation("/files?ws=workspace-2");
    expect(new URLSearchParams(window.location.search).has("path")).toBe(false);
    expect(selectedCount()).toBe(0);
    expectEmptyPreview();
    // 新空间里没有为那个同名文件发过 file 请求。
    expect(
      fetchMock.mock.calls
        .map(([path]) => path)
        .filter((path) => path.includes("workspace-2/file")),
    ).toStrictEqual([]);
  });

  it("D20 组件收到的 path 指向 out/a.md 而被点的是 out/b.md 这一行：DELETE 送的是这一行的路径，不上报路径变化", async () => {
    const listings = nested();
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: listings[""] }),
      [treeUrl("out")]: () => jsonResponse({ path: "out", entries: listings.out }),
      [fileUrl("out/a.md")]: () => textPreviewResponse("甲的正文"),
      [entriesUrl("out/b.md")]: () => {
        listings.out = [dirEntry("sub"), fileEntry("a.md")];
        return deleted();
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPathChange = vi.fn();
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        onPathChange={onPathChange}
        path="out/a.md"
        workspaceId="workspace-1"
      />,
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    const dialog = await openDelete("b.md");
    const before = fetchMock.mock.calls.length;

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() =>
      expect(rowNames()).toStrictEqual(["工作空间", "out", "sub", "a.md", "output", "top.md"]),
    );
    await settle();
    expect(
      fetchMock.mock.calls
        .slice(before)
        .map(([path, options]) => `${options?.method ?? "GET"} ${path}`),
    ).toStrictEqual([
      "DELETE /api/workspaces/workspace-1/entries?path=out%2Fb.md",
      "GET /api/workspaces/workspace-1/tree?path=out",
    ]);
    await selectedRow("a.md");
    expect(onPathChange).not.toHaveBeenCalled();
  });
  it("D20b 宿主不把 path 送回来（属性一直指向 out/a.md）时删 out/a.md：选中照样清掉、预览回到空态，恰上报一次 null", async () => {
    const listings = nested();
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: listings[""] }),
      [treeUrl("out")]: () => jsonResponse({ path: "out", entries: listings.out }),
      [fileUrl("out/a.md")]: () => textPreviewResponse("甲的正文"),
      [entriesUrl("out/a.md")]: () => {
        listings.out = [dirEntry("sub"), fileEntry("b.md")];
        return deleted();
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPathChange = vi.fn();
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        onPathChange={onPathChange}
        path="out/a.md"
        workspaceId="workspace-1"
      />,
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();

    fireEvent.click(confirmButton(await openDelete("a.md")));
    await confirmGone();
    await waitFor(() =>
      expect(rowNames()).toStrictEqual(["工作空间", "out", "sub", "b.md", "output", "top.md"]),
    );
    await settle();
    expectEmptyPreview();
    expect(selectedCount()).toBe(0);
    expect(onPathChange.mock.calls).toStrictEqual([[null]]);
  });

  it("D21 定位还在等 out/sub 的列表时删 out：定位放弃，不为它再发请求，预览区是空态、没有失败文案", async () => {
    const listings = nested();
    const held = deferredResponse();
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: listings[""] }),
      [treeUrl("out")]: () => jsonResponse({ path: "out", entries: listings.out }),
      [treeUrl("out/sub")]: () => held.promise,
      [entriesUrl("out")]: () => {
        listings[""] = withoutOut();
        return deleted();
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();
    const browser = (path: string | null) => (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        onPathChange={() => {}}
        path={path}
        workspaceId="workspace-1"
      />
    );
    const view = render(browser(null));
    // `out` 的列表在定位开始之前就已加载：这一次定位没有请求过它。
    await expand("out");
    view.rerender(browser("out/sub/x.md"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openDelete("out");
    const before = fetchMock.mock.calls.length;

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["工作空间", "output", "top.md"]));
    await settle();
    expect(
      fetchMock.mock.calls
        .slice(before)
        .map(([path, options]) => `${options?.method ?? "GET"} ${path}`),
    ).toStrictEqual([
      "DELETE /api/workspaces/workspace-1/entries?path=out",
      "GET /api/workspaces/workspace-1/tree?path=",
    ]);
    expectEmptyPreview();
    expect(selectedCount()).toBe(0);
  });
});

describe("删除之后的状态清理", () => {
  it("D15 out/sub 读取失败后删 out：树里没有失败文案，点 刷新 只请求根", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [treeUrl("out/sub")]: () =>
        jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
      [entriesUrl("out")]: () => {
        listings[""] = withoutOut();
        return deleted();
      },
    });
    await expand("out");
    fireEvent.click(await findRow("展开 sub"));
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md"]));
    await settle();
    expect(within(tree()).queryByRole("alert")).toBeNull();
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, treeUrl("")]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await settle();
    expect(since().slice(2)).toStrictEqual([treeUrl("")]);
  });

  it("D16 删掉已展开的 out 之后经 新建文件夹 重建同名目录：新行是折叠的，没有对它的 tree 请求；展开它才请求一次，看到的是新目录的内容", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [entriesUrl("out")]: () => {
        listings[""] = withoutOut();
        return deleted();
      },
      [DIRS]: () => {
        listings[""] = [dirEntry("out"), ...withoutOut()];
        listings.out = [];
        return jsonResponse({ path: "out" }, 201);
      },
    });
    await expand("out");
    await expand("sub");
    const since = mark();

    fireEvent.click(confirmButton(await openDelete("out")));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md"]));

    const creation = await openDirectoryDialog();
    fireEvent.change(within(creation).getByLabelText("文件夹名称"), { target: { value: "out" } });
    fireEvent.click(within(creation).getByRole("button", { name: "创建" }));
    await dialogGone("新建文件夹");
    const recreated = await findRow("展开 out");
    await settle();
    expect(recreated.getAttribute("aria-expanded")).toBe("false");
    expect(rowNames()).toStrictEqual(["设计文档", "out", "output", "top.md"]);
    expect(since()).toStrictEqual([
      `DELETE ${entriesUrl("out")}`,
      treeUrl(""),
      `POST ${DIRS} {"path":"out"}`,
      treeUrl(""),
    ]);

    // 旧的 `out`、`out/sub` 两份列表没有留在缓存里：展开新目录是一次新的请求，里面是空的。
    fireEvent.click(recreated);
    expect(await within(tree()).findByText("空目录", { exact: true })).toBeTruthy();
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "output", "top.md"]);
    expect(since().slice(4)).toStrictEqual([treeUrl("out")]);
  });

  it("D19 名字含 %、#、?：DELETE 地址里的 path 是整段编码一次的写法，读回来逐字相同", async () => {
    const name = "a%20b#c?.md";
    const url = "/api/workspaces/workspace-1/entries?path=a%2520b%23c%3F.md";
    const listings: Listings = { "": [fileEntry(name), fileEntry("readme.md", 8)] };
    const { mark } = openFiles(listings, {
      [url]: () => {
        listings[""] = [fileEntry("readme.md", 8)];
        return deleted();
      },
    });
    await findRow(name);
    const dialog = await openDelete(name);
    expect(within(dialog).getByRole("heading", { name: `删除「${name}」？` })).toBeTruthy();
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "readme.md"]));
    await settle();
    expect(since()).toStrictEqual([`DELETE ${url}`, treeUrl("")]);
    expect(new URL(url, "http://localhost").searchParams.get("path")).toBe(name);
  });

  it("D19b 目录 out 里名为两个点的条目：路径原样送出，不折叠成它的父目录", async () => {
    const name = "..";
    const url = "/api/workspaces/workspace-1/entries?path=out%2F..";
    // 列表是这里合成的：服务端的 `tree` 由 `readdirSync` 列目录，不含 `.` 与 `..`（读代码推出）。这里只看
    // 界面拿到这样一行时送出什么——裁决是服务端的。
    const listings: Listings = { "": [dirEntry("out")], out: [fileEntry(name)] };
    const { mark } = openFiles(listings, { [url]: NOT_FOUND });
    await expand("out");
    const dialog = await openDelete(name);
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    await settle();
    expect(since()).toStrictEqual([`DELETE ${url}`]);
  });
});

// 删除当前文件时预览的清理（#1101 评审留下的覆盖缺口）。直接渲染组件、`path` 属性不变：整页上宿主会把
// `path=null` 送回来，`path` 的 effect 自己也会清一次选中，看不出跟随这一步清了没有。
describe("删除当前文件时的预览清理", () => {
  function mount(entry: ReturnType<typeof fileEntry>, preview: () => Promise<Response> | Response) {
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [entry] }),
      [fileUrl(entry.name)]: preview,
      [entriesUrl(entry.name)]: deleted,
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        onPathChange={() => {}}
        path={entry.name}
        workspaceId="workspace-1"
      />,
    );
    return fetchMock;
  }

  it("D22 当前文件的 file 请求还在途时删它：该请求被中止，迟到的正文不显示，预览区是空态", async () => {
    const held = deferredResponse();
    const fetchMock = mount(fileEntry("a.md"), () => held.promise);
    const previews = () => fetchMock.mock.calls.filter(([path]) => path === fileUrl("a.md"));
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(previews()[0]?.[1]?.signal?.aborted).toBe(false);

    fireEvent.click(confirmButton(await openDelete("a.md")));
    await confirmGone();
    await settle();
    expect(previews().map(([, options]) => options?.signal?.aborted)).toStrictEqual([true]);
    expectEmptyPreview();
    expect(selectedCount()).toBe(0);

    await act(async () => {
      held.resolve(textPreviewResponse("迟到的正文"));
    });
    await settle();
    expect(previewRegion().queryByText("迟到的正文", { exact: true })).toBeNull();
    expectEmptyPreview();
    expect(previews()).toHaveLength(1);
  });

  it("D23 当前文件是已显示的图片：删除后它的 blob 地址恰被释放一次，预览区是空态", async () => {
    const blobUrls = stubBlobUrls(["blob:pic"]);
    mount(fileEntry("pic.png", 8), () => imagePreviewResponse());
    expect(await screen.findByRole("img", { name: "pic.png" })).toBeTruthy();
    expect(blobUrls.revokeObjectURL).not.toHaveBeenCalled();

    fireEvent.click(confirmButton(await openDelete("pic.png")));
    await confirmGone();
    await settle();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:pic"]]);
    expect(blobUrls.createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("img", { name: "pic.png" })).toBeNull();
    expectEmptyPreview();
  });
});
