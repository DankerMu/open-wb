/**
 * #1816：workspace-mounts「挂载内条目的行菜单」与 files-web「文件操作界面」的场景「挂载内条目没有删除」——文件页。
 * 会话页侧边栏的那一例在 chat-workspace-sidebar-mount-menu.test.tsx。
 *
 * 接缝：文件页的真实外壳（桩掉的 `fetch`，`openFiles` 夹具）；挂载列表由 `GET …/mounts` 应答，`远端` 是挂载，
 * 根下普通目录 `远端备份` 只是名字以它开头。期望值是规格里的字面量：菜单项、删除确认框的标题、说明与按钮。
 * 没登记的地址（任何 `DELETE …/entries`）一经请求就抛错并留在请求记录里，`deletes()` 另把它们数出来。
 */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findRow, settle } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  cancelButton,
  confirmGone,
  dirEntry,
  expand,
  fileEntry,
  menuItemsOf,
  openDelete,
  openFiles,
  openRowMenu,
  sftpMount,
} from "./files-ops-support.js";
import { jsonResponse } from "./support.js";

const MOUNTS = "/api/workspaces/workspace-1/mounts";
const MOUNT = "远端";
const NEAR = "远端备份";
const FILE_NOTE = "文件将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。";

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
});

/** 根下普通目录 `远端备份`（`x.md`）与文件 `a.md`（服务端不列出挂载点）；挂载 `远端` 里是目录 `docs` 与 `notes.txt`。 */
async function openPage() {
  const page = openFiles(
    {
      "": [dirEntry(NEAR), fileEntry("a.md")],
      [MOUNT]: [dirEntry("docs"), fileEntry("notes.txt")],
      [`${MOUNT}/docs`]: [],
      [NEAR]: [fileEntry("x.md")],
    },
    { [MOUNTS]: () => jsonResponse({ enabled: true, mounts: [sftpMount(MOUNT)] }) },
  );
  // 挂载根行出现即挂载列表已读到：「在挂载内」按列表判定，不是列表未到时的回退。
  await findRow(`展开 ${MOUNT}`);
  return page;
}

/** 打开 `name` 这一行的 `更多操作`，读出各项文字，再关掉。 */
async function menuItems(name: string) {
  return menuItemsOf(await openRowMenu(name));
}

describe("挂载内条目的行菜单", () => {
  it("挂载内文件 远端/notes.txt：菜单恰为 重命名、移动到…、下载，没有 删除；没有 DELETE …/entries", async () => {
    const page = await openPage();
    await expand(MOUNT);

    expect(await menuItems("notes.txt")).toStrictEqual(["重命名", "移动到…", "下载"]);
    await settle();
    expect(page.deletes()).toStrictEqual([]);
  });

  it("挂载内目录 远端/docs：菜单恰为 重命名、移动到…，没有 删除；没有 DELETE …/entries", async () => {
    const page = await openPage();
    await expand(MOUNT);

    expect(await menuItems("docs")).toStrictEqual(["重命名", "移动到…"]);
    await settle();
    expect(page.deletes()).toStrictEqual([]);
  });

  it("近名普通目录：远端备份 与 远端备份/x.md 的菜单照常有 删除", async () => {
    await openPage();
    await expand(NEAR);

    expect(await menuItems(NEAR)).toStrictEqual(["重命名", "移动到…", "删除"]);
    expect(await menuItems("x.md")).toStrictEqual(["重命名", "移动到…", "删除", "下载"]);
  });

  it("挂载外文件 a.md：菜单四项，删除确认框的标题、说明与按钮不变；全程没有 DELETE …/entries", async () => {
    const page = await openPage();
    await expand(MOUNT);
    expect(await menuItems("notes.txt")).not.toContain("删除");

    expect(await menuItems("a.md")).toStrictEqual(["重命名", "移动到…", "删除", "下载"]);
    const dialog = await openDelete("a.md");
    expect(within(dialog).getByRole("heading", { name: "删除「a.md」？" })).toBeTruthy();
    const note = document.getElementById(dialog.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(FILE_NOTE);
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toStrictEqual(["取消", "删除"]);
    fireEvent.click(cancelButton(dialog));
    await confirmGone();
    await settle();
    expect(page.deletes()).toStrictEqual([]);
  });
});
