/**
 * #1816：workspace-mounts「挂载内条目的行菜单」——会话页侧边栏与文件页同一份实现（文件页各例在
 * files-mount-row-menu.test.tsx）。
 *
 * 接缝：会话页的真实外壳（桩掉的 `fetch`），宽屏侧边栏。W1 挂着 `远端`（`notes.txt`）；根下的 `readme.md` 在
 * 挂载外。期望值是规格里的菜单项字面量。
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import {
  file,
  listing,
  mountSidebarPage,
  openSidebar,
  treeOf,
  W1,
} from "./chat-workspace-sidebar-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import { expand, menuItemsOf, sftpMount } from "./files-ops-support.js";
import { jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const MOUNT = "远端";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await cleanupSessionMeta();
});

/**
 * 在侧边栏里打开 `name` 这一行的 `更多操作`，读出各项文字，再关掉。按下带一个离开原点的坐标：
 * 不带坐标的按下在 jsdom 里被分栏库当成落在分隔线上（同 chat-workspace-sidebar-changes 的 `rowMenu`）。
 */
async function menuItems(region: HTMLElement, name: string) {
  await yieldMacrotask();
  const trigger = within(region).getByRole("button", { name: `更多操作 ${name}` });
  fireEvent.pointerDown(trigger, { button: 0, clientX: 500, clientY: 500 });
  return menuItemsOf(await screen.findByRole("menu"));
}

describe("会话页侧边栏：挂载内条目的行菜单", () => {
  it("空间挂着 远端：远端/notes.txt 的菜单没有 删除（仍有 重命名、移动到…、下载）；挂载外的 readme.md 照常四项", async () => {
    const { fetchMock } = await mountSidebarPage(undefined, {
      [`/api/workspaces/${W1.id}/mounts`]: () =>
        jsonResponse({ enabled: true, mounts: [sftpMount(MOUNT)] }),
      [treeOf(W1.id, MOUNT)]: listing(MOUNT, [file("notes.txt")]),
    });
    const { region } = await openSidebar("readme.md");
    await expand(MOUNT);

    expect(await menuItems(region, "notes.txt")).toStrictEqual(["重命名", "移动到…", "下载"]);
    expect(await menuItems(region, "readme.md")).toStrictEqual([
      "重命名",
      "移动到…",
      "删除",
      "下载",
    ]);
    expect(
      fetchMock.mock.calls.filter(([path, options]) => {
        return options?.method === "DELETE" && path.includes("/entries");
      }),
    ).toStrictEqual([]);
  });
});
