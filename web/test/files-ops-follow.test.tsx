// files-web「当前文件随操作变化」与「随操作更新」：改名成功之后的跟随——选中项、地址、展开集合、目录
// 列表与在途的目录请求。期望值按规格的场景手写；请求串整串相等。行菜单在 files-ops-row-menu.test.tsx，
// 重命名对话框在 files-ops-rename.test.tsx。

import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  flat,
  type Listings,
  MOVE,
  nested,
  openFiles,
  openRename,
  renameTo,
  rowsUnder,
  treeUrl,
} from "./files-ops-support.js";
import { deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

describe("当前文件随操作变化", () => {
  it("R9 预览 out/a.md 时把 out 改名为 dist：选中项与地址跟到 dist/a.md，dist 仍展开；其后的请求恰为 POST、新路径的 file、根的 tree", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("dist/a.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
          return jsonResponse({ path: "dist" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=dist%2Fa.md");
    expect(row("折叠 dist").getAttribute("aria-expanded")).toBe("true");
    expect(rowsUnder("dist")).toStrictEqual(["sub", "a.md", "b.md"]);
    const selected = row("折叠 dist").closest("li")?.querySelector('[aria-current="true"]');
    expect(selected?.querySelector('[data-slot="tree-name"]')?.textContent).toBe("a.md");
    expect(tree().querySelectorAll('[aria-current="true"]')).toHaveLength(1);
    await settle();
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "dist",
      "sub",
      "a.md",
      "b.md",
      "output",
      "top.md",
    ]);
    // 没有 `tree?path=out`、`tree?path=dist`，也没有为地址的变化另起一次定位。
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      fileUrl("dist/a.md"),
      treeUrl(""),
    ]);
  });

  it("R9b 目录里的当前文件 out/a.md 改名：to 带着父目录，只重新列出 out，选中项与地址跟到新路径", async () => {
    const listings = nested();
    const { mark } = openFiles(
      listings,
      {
        [fileUrl("out/a.md")]: () => textPreviewResponse("旧路径的正文"),
        [fileUrl("out/c.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings.out = [dirEntry("sub"), fileEntry("b.md"), fileEntry("c.md")];
          return jsonResponse({ path: "out/c.md" });
        },
      },
      address("out/a.md"),
    );
    await findRow("折叠 out");
    expect(await previewRegion().findByText("旧路径的正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("a.md");
    const since = mark();

    renameTo(dialog, "c.md");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=out%2Fc.md");
    await selectedRow("c.md");
    await settle();
    expect(rowsUnder("out")).toStrictEqual(["sub", "b.md", "c.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out/a.md","to":"out/c.md"}`,
      fileUrl("out/c.md"),
      treeUrl("out"),
    ]);
  });

  it("R10 随操作更新：当前文件 a.md 改名为 b.md 后地址的 path 是 b.md，ws 不变", async () => {
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    openFiles(listings, {
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [fileUrl("b.md")]: () => textPreviewResponse("乙"),
      [MOVE]: () => {
        listings[""] = [fileEntry("b.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "b.md" });
      },
    });
    fireEvent.click(await findRow("a.md"));
    await expectLocation("/files?ws=workspace-1&path=a.md");
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();

    renameTo(await openRename("a.md"), "b.md");
    await dialogGone();
    await expectLocation("/files?ws=workspace-1&path=b.md");
    await selectedRow("b.md");
    expect(await previewRegion().findByText("乙", { exact: true })).toBeTruthy();
    // 预览头用的是选中条目的名字：它也换成了新名字。
    const download = previewRegion().getByRole("link", { name: "下载 b.md" });
    expect(download.getAttribute("href")).toBe("/api/workspaces/workspace-1/download?path=b.md");
    expect(previewRegion().queryByRole("link", { name: "下载 a.md" })).toBeNull();
  });

  it("R10b 改名的不是当前文件也不是它的祖先：选中项、预览与地址都不动，没有 file 请求", async () => {
    const listings = flat();
    const { mark } = openFiles(listings, {
      [fileUrl("readme.md")]: () => textPreviewResponse("自述正文"),
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "todo.md" });
      },
    });
    fireEvent.click(await findRow("readme.md"));
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    const dialog = await openRename("notes.md");
    const since = mark();

    renameTo(dialog, "todo.md");
    await dialogGone();
    await findRow("todo.md");
    await settle();
    await selectedRow("readme.md");
    expect(previewRegion().getByText("自述正文", { exact: true })).toBeTruthy();
    await expectLocation("/files?ws=workspace-1&path=readme.md");
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`, treeUrl("")]);
  });

  it("R10c 新名含 %、#、?：恰一次 POST 原样带着它，file 请求与地址各自编码一次，地址的 path 读回来逐字相同，不另起定位", async () => {
    const name = "a%20b#c?.md";
    const encoded = "a%2520b%23c%3F.md";
    const listings: Listings = { "": [fileEntry("a.md"), fileEntry("readme.md", 8)] };
    const { mark } = openFiles(listings, {
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [`/api/workspaces/workspace-1/file?path=${encoded}`]: () => textPreviewResponse("乙"),
      [MOVE]: () => {
        listings[""] = [fileEntry(name), fileEntry("readme.md", 8)];
        return jsonResponse({ path: name });
      },
    });
    fireEvent.click(await findRow("a.md"));
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();
    const dialog = await openRename("a.md");
    const since = mark();

    renameTo(dialog, name);
    await dialogGone();
    expect(await previewRegion().findByText("乙", { exact: true })).toBeTruthy();
    // `#` 没有变成页内锚点、`?` 没有截断查询串：`expectLocation` 比的是 pathname + search + hash。
    await expectLocation(`/files?ws=workspace-1&path=${encoded}`);
    expect(new URLSearchParams(window.location.search).get("path")).toBe(name);
    await selectedRow(name);
    await settle();
    expect(rowNames()).toStrictEqual(["设计文档", name, "readme.md"]);
    expect(
      previewRegion()
        .getByRole("link", { name: `下载 ${name}` })
        .getAttribute("href"),
    ).toBe(`/api/workspaces/workspace-1/download?path=${encoded}`);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"a.md","to":"a%20b#c?.md"}`,
      `/api/workspaces/workspace-1/file?path=${encoded}`,
      "/api/workspaces/workspace-1/tree?path=",
    ]);
  });

  it("R11 已展开的 out/sub 跟到 dist/sub 且不重新请求；名字以 out 开头的同级 output 不动", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    await expand("sub");
    await expand("output");
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("折叠 dist");
    await settle();
    expect(row("折叠 sub").getAttribute("aria-expanded")).toBe("true");
    expect(row("折叠 output").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "dist",
      "sub",
      "x.md",
      "a.md",
      "b.md",
      "output",
      "o.md",
      "top.md",
    ]);
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);
  });

  it("R11b 深一层的 out/sub/x.md 改名：只重新列出 out/sub，不重列根与 out", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings["out/sub"] = [fileEntry("y.md")];
        return jsonResponse({ path: "out/sub/y.md" });
      },
    });
    await expand("out");
    await expand("sub");
    const dialog = await openRename("x.md");
    const since = mark();

    renameTo(dialog, "y.md");
    await dialogGone();
    await findRow("y.md");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out/sub/x.md","to":"out/sub/y.md"}`,
      treeUrl("out/sub"),
    ]);
  });

  it("R18 展开了而列表还在途的 out/sub：改名后旧路径的请求被中止，新路径补请求一次", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { fetchMock, mark } = openFiles(listings, {
      [treeUrl("out/sub")]: () => held.promise,
      [treeUrl("dist/sub")]: () => jsonResponse({ path: "dist/sub", entries: [fileEntry("x.md")] }),
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    fireEvent.click(await findRow("展开 sub"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("x.md");
    await settle();
    const stale = fetchMock.mock.calls.find(([path]) => path === treeUrl("out/sub"));
    expect(stale?.[1]?.signal?.aborted).toBe(true);
    expect(within(tree()).queryByText("正在读取目录", { exact: true })).toBeNull();
    expect(rowsUnder("sub")).toStrictEqual(["x.md"]);
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      treeUrl(""),
      treeUrl("dist/sub"),
    ]);
  });

  it("R18b 名字以 out 开头的同级 output 的列表还在途时把 out 改名：output 的请求不被中止，随后照常落地", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { fetchMock, mark } = openFiles(listings, {
      [treeUrl("output")]: () => held.promise,
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        return jsonResponse({ path: "dist" });
      },
    });
    fireEvent.click(await findRow("展开 output"));
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("展开 dist");
    await settle();
    const pending = fetchMock.mock.calls.filter(([path]) => path === treeUrl("output"));
    expect(pending.map(([, options]) => options?.signal?.aborted)).toStrictEqual([false]);
    expect(within(tree()).getByText("正在读取目录", { exact: true })).toBeTruthy();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);

    await act(async () => {
      held.resolve(jsonResponse({ path: "output", entries: [fileEntry("o.md")] }));
    });
    await findRow("o.md");
    expect(within(tree()).queryByText("正在读取目录", { exact: true })).toBeNull();
    expect(rowsUnder("output")).toStrictEqual(["o.md"]);
    expect(rowNames()).toStrictEqual(["设计文档", "dist", "output", "o.md", "top.md"]);
    await settle();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);
  });

  it("R19 读取失败且已折叠的 out/sub：改名后失败文案跟到 dist 之下，刷新重取的是新路径", async () => {
    const listings = nested();
    const failure = () =>
      jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500);
    const { mark } = openFiles(listings, {
      [treeUrl("out/sub")]: failure,
      [treeUrl("dist/sub")]: failure,
      [MOVE]: () => {
        listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
        listings.dist = listings.out as Listings[string];
        return jsonResponse({ path: "dist" });
      },
    });
    await expand("out");
    fireEvent.click(await findRow("展开 sub"));
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    fireEvent.click(row("折叠 sub"));
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    await findRow("折叠 dist");
    await settle();
    const alert = within(tree()).getByRole("alert");
    expect(alert.textContent).toBe("目录读取失败");
    expect(row("展开 sub").closest("li")?.contains(alert)).toBe(true);
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"out","to":"dist"}`, treeUrl("")]);

    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    await settle();
    expect(since().slice(2).sort()).toStrictEqual(
      [treeUrl(""), treeUrl("dist"), treeUrl("dist/sub")].sort(),
    );
  });

  it("R20 地址的定位还在等 out/sub 的列表时把 out 改名：定位跟到 dist/sub/x.md 并选中，不为旧路径发请求，地址不改", async () => {
    const listings = nested();
    const held = deferredResponse();
    const { mark } = openFiles(
      listings,
      {
        [treeUrl("out/sub")]: () => held.promise,
        [treeUrl("dist/sub")]: () =>
          jsonResponse({ path: "dist/sub", entries: [fileEntry("x.md")] }),
        [fileUrl("dist/sub/x.md")]: () => textPreviewResponse("新路径的正文"),
        [MOVE]: () => {
          listings[""] = [dirEntry("dist"), dirEntry("output"), fileEntry("top.md")];
          return jsonResponse({ path: "dist" });
        },
      },
      address("out/sub/x.md"),
    );
    await findRow("折叠 sub");
    await within(tree()).findByText("正在读取目录", { exact: true });
    const dialog = await openRename("out");
    const since = mark();

    renameTo(dialog, "dist");
    await dialogGone();
    expect(await previewRegion().findByText("新路径的正文", { exact: true })).toBeTruthy();
    await selectedRow("x.md");
    await settle();
    expect(since()).toStrictEqual([
      `POST ${MOVE} {"from":"out","to":"dist"}`,
      treeUrl(""),
      treeUrl("dist/sub"),
      fileUrl("dist/sub/x.md"),
    ]);
    // 由地址定位到的选中不写地址（「地址定位到文件」）：`path` 仍是进入时的写法。
    await expectLocation("/files?ws=workspace-1&path=out%2Fsub%2Fx.md");
  });
});
