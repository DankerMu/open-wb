// files-web「文件操作界面」与「树的键盘操作」：行菜单 `更多操作 <名>` 本身——哪些行有、里面有什么、
// 只用键盘走通重命名。重命名对话框与改名之后的跟随在 files-ops-rename.test.tsx。

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { findRow, row, rowNames, settle, tree } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  dialogGone,
  dirEntry,
  fileEntry,
  focusedOn,
  type Listings,
  MOVE,
  menuButton,
  nameInput,
  openFiles,
  openRowMenu,
  treeUrl,
} from "./files-ops-support.js";
import { createFetchMock, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

/** 根下两个文件。 */
const flat = (): Listings => ({ "": [fileEntry("notes.md"), fileEntry("readme.md", 8)] });

/** 根下 `out`（含 `sub` 与两个文件）、同级的 `output`、一个文件。 */
const nested = (): Listings => ({
  "": [dirEntry("out"), dirEntry("output"), fileEntry("top.md")],
  out: [dirEntry("sub"), fileEntry("a.md"), fileEntry("b.md")],
  "out/sub": [fileEntry("x.md")],
  output: [fileEntry("o.md")],
});

async function expand(name: string) {
  fireEvent.click(await findRow(`展开 ${name}`));
  await findRow(`折叠 ${name}`);
}

describe("行菜单", () => {
  it("R12 只用键盘：更多操作上按 Enter 打开菜单、焦点在重命名上，再按 Enter 打开对话框，输入后提交", async () => {
    const listings = flat();
    const { mark } = openFiles(listings, {
      [MOVE]: () => {
        listings[""] = [fileEntry("todo.md"), fileEntry("readme.md", 8)];
        return jsonResponse({ path: "todo.md" });
      },
    });
    await findRow("notes.md");
    const trigger = menuButton("notes.md");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const rename = within(menu).getByRole("menuitem", { name: "重命名" });
    await waitFor(() => expect(document.activeElement).toBe(rename));
    fireEvent.keyDown(rename, { key: "Enter" });
    const dialog = await screen.findByRole("dialog", { name: "重命名" });
    await yieldMacrotask();
    const input = nameInput(dialog);
    expect(document.activeElement).toBe(input);
    const since = mark();

    fireEvent.change(input, { target: { value: "todo.md" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await dialogGone();
    await findRow("todo.md");
    await focusedOn(() => menuButton("todo.md"));
    await settle();
    expect(since()).toStrictEqual([`POST ${MOVE} {"from":"notes.md","to":"todo.md"}`, treeUrl("")]);
  });

  it("R12b 菜单上按 Escape：菜单关闭，焦点回到更多操作", async () => {
    openFiles(flat());
    await findRow("notes.md");
    const trigger = menuButton("notes.md");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await focusedOn(() => trigger);
  });

  it("R13 每个非根行恰有一个可聚焦的更多操作，是行按钮的兄弟而不在行按钮里；根行没有；行的可访问名不变", async () => {
    openFiles(nested());
    await expand("out");

    const menus = within(tree()).getAllByRole<HTMLButtonElement>("button", { name: /^更多操作/ });
    expect(menus.map((button) => button.getAttribute("aria-label"))).toStrictEqual([
      "更多操作 out",
      "更多操作 sub",
      "更多操作 a.md",
      "更多操作 b.md",
      "更多操作 output",
      "更多操作 top.md",
    ]);
    const rows = within(tree())
      .getAllByRole("button")
      .filter((button) => !menus.includes(button as HTMLButtonElement));
    expect(
      rows.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toStrictEqual([
      "折叠 设计文档",
      "折叠 out",
      "展开 sub",
      "a.md4 B",
      "b.md4 B",
      "展开 output",
      "top.md4 B",
    ]);
    for (const [index, menu] of menus.entries()) {
      // 根行排第一，它没有菜单：第 n 个菜单属于第 n + 1 行。
      expect(menu.previousElementSibling).toBe(rows[index + 1]);
      expect(menu.closest('[data-slot="tree-name"]')).toBeNull();
      expect(menu.tabIndex).toBe(0);
      expect(menu.disabled).toBe(false);
      menu.focus();
      expect(document.activeElement).toBe(menu);
    }
    expect(tree().querySelector("button button")).toBeNull();
    expect(
      row("折叠 设计文档").parentElement?.querySelector(":scope > [aria-haspopup]"),
    ).toBeNull();
  });

  it("R17 文件行的菜单恰为 重命名、下载，下载是指向 download 地址、带 download 属性的链接；目录行的菜单只有 重命名", async () => {
    const { fetchMock, view } = openFiles(nested());
    await expand("out");

    const fileMenu = await openRowMenu("b.md");
    // 菜单不是模态的：开着的时候不锁 body 的指针事件，也不把页面其余部分标成 aria-hidden。
    expect(document.body.style.pointerEvents).toBe("");
    expect(view.container.hasAttribute("aria-hidden")).toBe(false);
    expect(
      within(fileMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toStrictEqual(["重命名", "下载"]);
    const link = within(fileMenu).getByRole("menuitem", { name: "下载" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/api/workspaces/workspace-1/download?path=out%2Fb.md");
    expect(link.getAttribute("download")).toBe("");
    fireEvent.keyDown(fileMenu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    const directoryMenu = await openRowMenu("out");
    expect(
      within(directoryMenu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toStrictEqual(["重命名"]);
    expect(directoryMenu.querySelector("a")).toBeNull();
    expect(
      fetchMock.mock.calls.map(([path]) => path).filter((path) => path.includes("/download")),
    ).toStrictEqual([]);
  });

  it("R16 onlyPaths 生效期间没有行菜单，撤掉后又有", async () => {
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [fileEntry("notes.md")] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createApiClient();
    const browser = (onlyPaths?: ReadonlySet<string>) => (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        onlyPaths={onlyPaths}
        onPathChange={() => {}}
        path={null}
        workspaceId="workspace-1"
      />
    );
    const view = render(browser());
    await findRow("notes.md");
    expect(menuButton("notes.md")).toBeTruthy();

    view.rerender(browser(new Set(["notes.md", "out/a.md"])));
    expect(rowNames()).toStrictEqual(["工作空间", "out", "a.md", "notes.md"]);
    expect(within(tree()).queryByRole("button", { name: /更多操作/ })).toBeNull();
    expect(tree().querySelector("[aria-haspopup]")).toBeNull();

    view.rerender(browser());
    expect(menuButton("notes.md")).toBeTruthy();
  });
});
