// files-web「当前文件随操作变化」「随操作更新」里移动的一步，与移动成功之后的跟随：选中项、地址、展开
// 集合、子层列表、目标位置上早先留下的状态与在途的目录请求。期望值按规格的场景手写；请求串整串相等，
// `to` 按 `POST …/move` 的请求体约定手写。对话框本身在 files-ops-move.test.tsx。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  address,
  findRow,
  previewRegion,
  row,
  rowNames,
  selectedRow,
  settle,
  tree,
} from "./files-deep-link-support.js";
import { cleanupFilesFixture, expectLocation } from "./files-fixture.js";
import {
  dialogGone,
  dirEntry,
  expand,
  fileEntry,
  fileUrl,
  type Listings,
  MOVE,
  moveButton,
  moveInto,
  nested,
  openFiles,
  openMove,
  openRename,
  renameTo,
  rowIn,
  rowsUnder,
  targetSelect,
  treeUrl,
} from "./files-ops-support.js";
import { createFetchMock, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

const targets = (dialog: HTMLElement) =>
  [...targetSelect(dialog).options].map((option) => option.value);

describe("当前文件随操作变化：移动", () => {
  it("M5 预览 out/a.md：先把 out 改名为 dist，再把 dist/a.md 移到根——选中项与地址跟到 a.md；其后的请求恰为 POST、新路径的 file、dist 的 tree、根的 tree", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("dist/a.md")]: () => textPreviewResponse("改名之后的正文"),
        [fileUrl("a.md")]: () => textPreviewResponse("移到根之后的正文"),
        [treeUrl("dist")]: () => jsonResponse({ path: "dist", entries: listings.dist }),
        [MOVE]: (_path, options) => {
          if (String(options?.body).includes('"to":"dist"')) {
            listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
            return jsonResponse({ path: "dist" });
          }
          listings[""] = [
            dirEntry("dist"),
            dirEntry("output"),
            fileEntry("top.md"),
            fileEntry("a.md"),
          ];
          listings.dist = [dirEntry("sub"), fileEntry("b.md")];
          return jsonResponse({ path: "a.md" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    renameTo(await openRename("out"), "dist");
    await dialogGone();
    await expectLocation("/files?ws=workspace-1&path=dist%2Fa.md");
    expect(await previewRegion().findByText("改名之后的正文", { exact: true })).toBeTruthy();
    await settle();

    const dialog = await openMove("a.md");
    // 根是首项也是缺省值：`dist` 是当前父目录，`output` 没展开。
    expect(targets(dialog)).toStrictEqual([""]);
    const since = mark();
    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await expectLocation("/files?ws=workspace-1&path=a.md");
    expect(await previewRegion().findByText("移到根之后的正文", { exact: true })).toBeTruthy();
    await waitFor(() => expect(rowsUnder("dist")).toStrictEqual(["sub", "b.md"]));
    await settle();
    await selectedRow("a.md");
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "dist",
      "sub",
      "b.md",
      "output",
      "top.md",
      "a.md",
    ]);
    // `to` 是 `a.md`，不是 `/a.md`；没有为地址的变化另起一次定位。
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"dist/a.md","to":"a.md"}`,
      fileUrl("a.md"),
      treeUrl("dist"),
      treeUrl(""),
    ]);
    await expectLocation("/files?ws=workspace-1&path=a.md");
  });

  it("M5b 移动的不是当前文件也不是它的祖先：选中项、预览与地址都不动，没有 file 请求", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("甲的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("out"), dirEntry("output")];
          listings.out = [
            dirEntry("sub"),
            fileEntry("a.md"),
            fileEntry("b.md"),
            fileEntry("top.md"),
          ];
          return jsonResponse({ path: "out/top.md" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    const dialog = await openMove("top.md");
    const since = mark();

    moveInto(dialog, "out");
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["sub", "a.md", "b.md", "top.md"]));
    await settle();
    await selectedRow("a.md");
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=out%2Fa.md");
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"top.md","to":"out/top.md"}`,
      treeUrl(""),
      treeUrl("out"),
    ]);
  });

  it("M14 组件收到的 path 指向 out/a.md 而被点的是 out/b.md 这一行：POST 的 from 是这一行的路径，to 是目标接上这一行的名字，不上报路径变化", async () => {
    const listings = nested();
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: listings[""] }),
      [treeUrl("out")]: () => jsonResponse({ path: "out", entries: listings.out }),
      [treeUrl("out/sub")]: () => jsonResponse({ path: "out/sub", entries: listings["out/sub"] }),
      [fileUrl("out/a.md")]: () => textPreviewResponse("甲的正文"),
      [MOVE]: () => {
        listings.out = [dirEntry("sub"), fileEntry("a.md")];
        listings["out/sub"] = [fileEntry("x.md"), fileEntry("b.md")];
        return jsonResponse({ path: "out/sub/b.md" });
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
    await expand("sub");
    const dialog = await openMove("b.md");
    expect(targets(dialog)).toStrictEqual(["", "out/sub"]);
    const before = fetchMock.mock.calls.length;

    moveInto(dialog, "out/sub");
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("sub")).toStrictEqual(["x.md", "b.md"]));
    await settle();
    expect(
      fetchMock.mock.calls
        .slice(before)
        .map(([path, options]) => [options?.method ?? "GET", path, options?.body].join(" ")),
    ).toStrictEqual([
      'POST /api/workspaces/workspace-1/move {"from":"out/b.md","to":"out/sub/b.md"}',
      "GET /api/workspaces/workspace-1/tree?path=out ",
      "GET /api/workspaces/workspace-1/tree?path=out%2Fsub ",
    ]);
    await selectedRow("a.md");
    expect(onPathChange).not.toHaveBeenCalled();
  });
});

describe("随操作更新：移动", () => {
  it("M6 已展开且已加载的 out/sub 移到已展开的 output：sub 在 output 之下仍是展开的、里面的行还在，没有对 output/sub 的 tree 请求；其后的请求恰为 POST、out 的 tree、output 的 tree", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings.out = [fileEntry("a.md"), fileEntry("b.md")];
        listings.output = [dirEntry("sub"), fileEntry("o.md")];
        return jsonResponse({ path: "output/sub" });
      },
    });
    await expand("out");
    await expand("sub");
    await expand("output");
    const dialog = await openMove("sub");
    expect(targets(dialog)).toStrictEqual(["", "output"]);
    const since = mark();

    moveInto(dialog, "output");
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("output")).toStrictEqual(["sub", "x.md", "o.md"]));
    await settle();
    expect(row("折叠 sub").getAttribute("aria-expanded")).toBe("true");
    expect(rowsUnder("out")).toStrictEqual(["a.md", "b.md"]);
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "out",
      "a.md",
      "b.md",
      "output",
      "sub",
      "x.md",
      "o.md",
      "top.md",
    ]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out/sub","to":"output/sub"}`,
      treeUrl("out"),
      treeUrl("output"),
    ]);
  });
});

describe("移动之后目标位置上早先留下的状态", () => {
  /** 根下只有 `out`，`out` 里有目录 `a`；`stale()` 之后根下多出目录 `a`，`out` 不再列出它的 `a`。 */
  function staleScene(lateListing: () => Promise<Response> | Response) {
    const listings: Listings = { "": [dirEntry("out")], out: [dirEntry("a")] };
    let moved = false;
    let stale = false;
    const opened = openFiles(listings, {
      [treeUrl("out/a")]: () => {
        if (moved) return jsonResponse({ path: "out/a", entries: [fileEntry("new.md")] });
        return stale
          ? lateListing()
          : jsonResponse({ path: "out/a", entries: [fileEntry("old.md")] });
      },
      [MOVE]: () => {
        moved = true;
        listings[""] = [dirEntry("out")];
        listings.out = [dirEntry("a")];
        return jsonResponse({ path: "out/a" });
      },
    });
    return {
      ...opened,
      stale() {
        stale = true;
        listings[""] = [dirEntry("a"), dirEntry("out")];
        listings.out = [];
      },
    };
  }

  it("M13 out/a 展开过、读取失败且已不在 out 的列表里：把根下折叠的目录 a 移进 out 后新行是折叠的、树里没有失败文案；其后的请求恰为 POST、根的 tree、out 的 tree；展开它才请求一次，看到的是新目录的内容", async () => {
    const { mark, stale } = staleScene(() =>
      jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
    );
    await expand("out");
    await expand("a");
    await findRow("old.md");
    stale();
    const refreshed = mark();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await findRow("展开 a");
    await settle();
    expect(refreshed()).toStrictEqual([treeUrl(""), treeUrl("out"), treeUrl("out/a")]);
    expect(rowNames()).toStrictEqual(["设计文档", "a", "out"]);

    const dialog = await openMove("a");
    // 缓存里还留着 `out/a` 的旧列表，但 `out` 的列表已不列它：它不是目标。
    expect(targets(dialog)).toStrictEqual(["out"]);
    const since = mark();
    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["a"]));
    await settle();
    expect(row("展开 a").getAttribute("aria-expanded")).toBe("false");
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a"]);
    expect(within(tree()).queryByRole("alert")).toBeNull();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"a","to":"out/a"}`,
      treeUrl(""),
      treeUrl("out"),
    ]);

    fireEvent.click(row("展开 a"));
    await findRow("new.md");
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a", "new.md"]);
    expect(since().slice(3)).toStrictEqual([treeUrl("out/a")]);
  });

  it("M13b 旧的 out/a 的列表还在途时把根下的 a 移进 out：在途请求被中止，迟到的旧列表不落进新目录；展开新行是一次新的请求，看到的是新目录的内容", async () => {
    const held = deferredResponse();
    const { fetchMock, mark, stale } = staleScene(() => held.promise);
    await expand("out");
    await expand("a");
    await findRow("old.md");
    stale();
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await findRow("展开 a");
    await settle();
    const requests = () => fetchMock.mock.calls.filter(([path]) => path === treeUrl("out/a"));
    expect(requests().map(([, options]) => options?.signal?.aborted)).toStrictEqual([false, false]);

    const dialog = await openMove("a");
    const since = mark();
    fireEvent.click(moveButton(dialog));
    await dialogGone("移动到");
    await waitFor(() => expect(rowsUnder("out")).toStrictEqual(["a"]));
    await settle();
    expect(requests().map(([, options]) => options?.signal?.aborted)).toStrictEqual([false, true]);

    await act(async () => {
      held.resolve(jsonResponse({ path: "out/a", entries: [fileEntry("old.md")] }));
    });
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a"]);
    fireEvent.click(row("展开 a"));
    await findRow("new.md");
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a", "new.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"a","to":"out/a"}`,
      treeUrl(""),
      treeUrl("out"),
      treeUrl("out/a"),
    ]);
  });

  it("M13c 旧的 out/a 之下再深一层的 out/a/deep 与名字以 a 开头的同级 out/ab 的列表都在途时把根下的 a 移进 out：只有 out/a/deep 的被中止；out/ab 的照常落地；迟到的旧列表不落进新目录，展开新的 deep 是一次新的请求", async () => {
    const heldDeep = deferredResponse();
    const heldSibling = deferredResponse();
    const listings: Listings = {
      "": [dirEntry("a"), dirEntry("out")],
      out: [dirEntry("a"), dirEntry("ab")],
      "out/a": [dirEntry("deep")],
    };
    let moved = false;
    const { fetchMock, mark } = openFiles(listings, {
      [treeUrl("out/a/deep")]: () =>
        moved
          ? jsonResponse({ path: "out/a/deep", entries: [fileEntry("new.md")] })
          : heldDeep.promise,
      [treeUrl("out/ab")]: () => heldSibling.promise,
      [MOVE]: () => {
        moved = true;
        listings[""] = [dirEntry("out")];
        return jsonResponse({ path: "out/a" });
      },
    });
    await expand("out");
    // 根下的 `a` 一直折叠着；`out` 里的那个展开，再点开它的 `deep` 与同级的 `ab`，两个列表都挂着。
    fireEvent.click(rowIn("out", "a"));
    fireEvent.click(await findRow("展开 deep"));
    fireEvent.click(rowIn("out", "ab"));
    await waitFor(() => expect(within(tree()).getAllByText("正在读取目录")).toHaveLength(2));
    const signal = (path: string) =>
      fetchMock.mock.calls
        .filter(([url]) => url === treeUrl(path))
        .map(([, options]) => options?.signal?.aborted);
    expect([signal("out/a/deep"), signal("out/ab")]).toStrictEqual([[false], [false]]);

    await yieldMacrotask();
    pressPointer(rowIn("设计文档", "a").nextElementSibling as Element);
    fireEvent.click(
      within(await screen.findByRole("menu")).getByRole("menuitem", { name: "移动到…" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "移动到" });
    expect(targets(dialog)).toStrictEqual(["out", "out/a"]);
    const since = mark();
    moveInto(dialog, "out");
    await dialogGone("移动到");
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "out", "a", "ab"]));
    await settle();
    expect([signal("out/a/deep"), signal("out/ab")]).toStrictEqual([[true], [false]]);

    await act(async () => {
      heldDeep.resolve(jsonResponse({ path: "out/a/deep", entries: [fileEntry("old.md")] }));
      heldSibling.resolve(jsonResponse({ path: "out/ab", entries: [fileEntry("kept.md")] }));
    });
    await findRow("kept.md");
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a", "ab", "kept.md"]);

    fireEvent.click(rowIn("out", "a"));
    fireEvent.click(await findRow("展开 deep"));
    await findRow("new.md");
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a", "deep", "new.md", "ab", "kept.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"a","to":"out/a"}`,
      treeUrl(""),
      treeUrl("out"),
      treeUrl("out/a"),
      treeUrl("out/a/deep"),
    ]);
  });
});
