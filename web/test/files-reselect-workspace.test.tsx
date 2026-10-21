// files-web「工作空间页」场景「重选当前空间」：在切换器里选当前已选中的空间不导航——地址、历史长度、
// 展开态与当前文件都不变，只关闭切换器；选另一空间仍 push 并去掉 `path`（对照）。整页渲染（真实
// router），期望值按场景手写。用例里的 W 是 `设计文档`（workspace-1），V 是 `数据分析`（workspace-2），
// y 是 `a.md`，x 是 `readme.md`。

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previewRegion, row, selectedRow, settle, tree } from "./files-deep-link-support.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectLocation,
  renderFiles,
  secondWorkspace,
  workspace,
} from "./files-fixture.js";
import {
  confirmButton,
  confirmGone,
  deleted,
  dirEntry,
  entriesUrl,
  expand,
  fileEntry,
  fileUrl,
  type Listings,
  openDelete,
  treeUrl,
} from "./files-ops-support.js";
import { jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const AT_Y = "/files?ws=workspace-1&path=a.md";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 两个空间；W 的根下有目录 `out`（含 `b.md`）、y、x，用例在 `DELETE` 的应答里把 y 拿掉。 */
function openTwoWorkspaces(at = AT_Y) {
  const listings: Listings = {
    "": [dirEntry("out"), fileEntry("a.md"), fileEntry("readme.md", 8)],
    out: [fileEntry("b.md")],
  };
  const lazy = (path: string) => () => jsonResponse({ path, entries: listings[path] });
  renderFiles(
    at,
    authenticatedFilesRoutes([workspace, secondWorkspace], {
      [treeUrl("")]: lazy(""),
      [treeUrl("out")]: lazy("out"),
      "/api/workspaces/workspace-2/tree?path=": () =>
        jsonResponse({ path: "", entries: [fileEntry("readme.md", 8)] }),
      [fileUrl("a.md")]: () => textPreviewResponse("甲"),
      [fileUrl("readme.md")]: () => textPreviewResponse("自述正文"),
      [entriesUrl("a.md")]: () => {
        listings[""] = [dirEntry("out"), fileEntry("readme.md", 8)];
        return deleted();
      },
    }),
  );
}

function switcher() {
  return screen.getByRole("dialog", { name: "工作空间切换器" });
}

function switcherGone() {
  return screen.queryByRole("dialog", { name: "工作空间切换器" });
}

/** 打开切换器，返回弹层里名字含 `name` 的那一项（树根行 `折叠 设计文档` 不在弹层里）。 */
async function openSwitcherItem(name: RegExp) {
  // 上一次弹层关闭时的焦点归还在 setTimeout(0) 里跑，先让它跑完，否则可能把刚打开的弹层关掉。
  await yieldMacrotask();
  fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
  return within(switcher()).getByRole("button", { name });
}

function currentAddress() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** 树里被选中的行的名字（没有选中行为 `[]`）。 */
function selectedNames() {
  const rows = tree().querySelectorAll('[aria-current="true"] [data-slot="tree-name"]');
  return [...rows].map((node) => node.textContent);
}

describe("重选当前空间", () => {
  it("(a) 删除当前文件 y、点 x，再在切换器里选当前空间：地址仍是 path=x、x 仍被选中，历史长度不变", async () => {
    openTwoWorkspaces();
    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();

    fireEvent.click(confirmButton(await openDelete("a.md")));
    await confirmGone();
    await expectLocation("/files?ws=workspace-1");
    await waitFor(() => expect(() => row("a.md")).toThrow());
    expect(selectedNames()).toStrictEqual([]);

    fireEvent.click(row("readme.md"));
    await expectLocation("/files?ws=workspace-1&path=readme.md");
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    const before = window.history.length;

    fireEvent.click(await openSwitcherItem(/设计文档/));
    await settle();

    // 修复前：push 了一条去掉 path 的 `?ws=workspace-1`，同一实例收到 path=null 后清掉选中。
    expect(currentAddress()).toBe("/files?ws=workspace-1&path=readme.md");
    expect(selectedNames()).toStrictEqual(["readme.md"]);
    expect(row("readme.md").getAttribute("aria-current")).toBe("true");
    expect(window.history.length).toBe(before);
    expect(switcherGone()).toBeNull();
  });

  it("(b) 在 path=y 上直接选当前空间：地址、选中、展开态与历史长度都不变，弹层关闭，再打开时当前项 aria-pressed", async () => {
    openTwoWorkspaces();
    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲", { exact: true })).toBeTruthy();
    await expand("out");
    await settle();
    const before = window.history.length;

    fireEvent.click(await openSwitcherItem(/设计文档/));
    await settle();

    expect(switcherGone()).toBeNull();
    expect(currentAddress()).toBe(AT_Y);
    expect(selectedNames()).toStrictEqual(["a.md"]);
    expect(previewRegion().getByText("甲", { exact: true })).toBeTruthy();
    expect(row("折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(row("b.md")).toBeTruthy();
    expect(window.history.length).toBe(before);

    // 弹层关闭后列表项卸载，只能再打开一次读当前项。
    const current = await openSwitcherItem(/设计文档/);
    expect(current.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(switcher())
        .getByRole("button", { name: /数据分析/ })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("(c) 对照：选另一空间 V 仍 push 到 ?ws=V、去掉 path，历史长度加一", async () => {
    openTwoWorkspaces();
    await selectedRow("a.md");
    await settle();
    const before = window.history.length;

    fireEvent.click(await openSwitcherItem(/数据分析/));
    await expectLocation("/files?ws=workspace-2");
    await settle();

    expect(currentAddress()).toBe("/files?ws=workspace-2");
    expect(window.history.length).toBe(before + 1);
    expect(switcherGone()).toBeNull();
    expect(within(tree()).getByRole("button", { name: "折叠 数据分析" })).toBeTruthy();
    expect(selectedNames()).toStrictEqual([]);
  });
});
