import { pageNotices } from "./page-notices.js";
// files-web「文件操作界面」的「删除」：行菜单 `删除` 打开的确认框——文案、焦点、发出的请求、请求中的
// 状态与模态清理；「当前文件随操作变化」「随操作更新」里删除的一步。期望值按规格的场景手写：说明文案
// 逐字抄自规格，`DELETE` 的地址按 `DELETE …/entries?path=` 的约定手写（`path` 整段编码一次），404 的
// 文案是服务端信封里 `not_found` 的那一句。请求串整串相等。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { findRow, row, rowNames, settle } from "./files-deep-link-support.js";
import { cleanupFilesFixture } from "./files-fixture.js";
import {
  cancelButton,
  confirmButton,
  confirmGone,
  deleted,
  dirEntry,
  entriesUrl,
  expand,
  fileEntry,
  flat,
  focusedOn,
  menuButton,
  nested,
  openDelete,
  openFiles,
  treeUrl,
  withoutOut,
} from "./files-ops-support.js";
import { createFetchMock, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const FILE_NOTE = "文件将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。";
const DIRECTORY_NOTE =
  "文件夹及其全部内容将从工作空间移除。管理员可在保留期内从服务器恢复，界面不提供回收站。";
const PENDING_NOTE = "正在删除。取消将停止等待；如请求已到达服务器，结果可在刷新后确认。";
const NOT_FOUND = () =>
  jsonResponse({ error: { code: "not_found", message: "请求的资源不存在" } }, 404);

afterEach(async () => {
  vi.restoreAllMocks();
  cleanupFilesFixture();
  await yieldMacrotask();
});

function overlay() {
  const element = document.querySelector('[data-slot="alert-dialog-overlay"]');
  if (!element) throw new Error("expected the alert dialog overlay");
  return element;
}

/** 确认框的说明：`aria-describedby` 指向的那个元素的文字。 */
function noteOf(dialog: HTMLElement) {
  return document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent;
}

describe("删除", () => {
  it("D1 目录 out：标题是 删除「out」？，说明是目录的那一句全文，按钮恰为 取消、删除，没有 关闭", async () => {
    const { mark } = openFiles(nested());
    await findRow("展开 out");
    const since = mark();
    const dialog = await openDelete("out");

    expect(within(dialog).getByRole("heading", { name: "删除「out」？" })).toBeTruthy();
    expect(noteOf(dialog)).toBe(DIRECTORY_NOTE);
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toStrictEqual(["取消", "删除"]);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(confirmButton(dialog).disabled).toBe(false);
    await settle();
    // 打开确认框本身不发请求。
    expect(since()).toStrictEqual([]);
  });

  it("D2 文件 top.md：说明是文件的那一句全文", async () => {
    openFiles(nested());
    await findRow("top.md");
    const dialog = await openDelete("top.md");

    expect(within(dialog).getByRole("heading", { name: "删除「top.md」？" })).toBeTruthy();
    expect(noteOf(dialog)).toBe(FILE_NOTE);
  });

  it("D3 点 取消：确认框关闭，没有请求，焦点回到 更多操作 out，树不变", async () => {
    const { mark } = openFiles(nested());
    await findRow("展开 out");
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(cancelButton(dialog));
    await confirmGone();
    await focusedOn(() => menuButton("out"));
    await settle();
    expect(document.activeElement).toBe(menuButton("out"));
    expect(since()).toStrictEqual([]);
    expect(rowNames()).toStrictEqual(["设计文档", "out", "output", "top.md"]);
  });

  it("D4 点 删除：恰一次 DELETE entries?path=out，确认框关闭，根层被重新请求，out 不在树里，焦点在根行上", async () => {
    const listings = nested();
    const { mark } = openFiles(listings, {
      [entriesUrl("out")]: () => {
        listings[""] = [...withoutOut(), fileEntry("later.md")];
        return deleted();
      },
    });
    await findRow("展开 out");
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    // `later.md` 只在重新列出的根里有：树上出现它即重列的结果已经用上。
    await findRow("later.md");
    expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md", "later.md"]);
    await focusedOn(() => row("折叠 设计文档"));
    // 确认框卸载后的回焦在下一个宏任务里跑：它之后焦点仍在根行上。
    await settle();
    expect(document.activeElement).toBe(row("折叠 设计文档"));
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, treeUrl("")]);
    expect(since()[0]).toBe("DELETE /api/workspaces/workspace-1/entries?path=out");
  });

  it("D4b 目录里的 out/b.md：DELETE 带着父目录，只重新列出 out，焦点在 out 的行按钮上", async () => {
    const listings = nested();
    const { deletes, mark } = openFiles(listings, {
      [entriesUrl("out/b.md")]: () => {
        listings.out = [dirEntry("sub"), fileEntry("a.md")];
        return deleted();
      },
    });
    await expand("out");
    const dialog = await openDelete("b.md");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() =>
      expect(rowNames()).toStrictEqual(["设计文档", "out", "sub", "a.md", "output", "top.md"]),
    );
    await focusedOn(() => row("折叠 out"));
    await settle();
    expect(document.activeElement).toBe(row("折叠 out"));
    expect(since()).toStrictEqual([
      "DELETE /api/workspaces/workspace-1/entries?path=out%2Fb.md",
      treeUrl("out"),
    ]);
    // 没有请求体，也没有 Content-Type：路径只在地址里。
    expect(deletes().map(([, options]) => options?.body)).toStrictEqual([undefined]);
  });

  it("D5 服务端答 404：确认框内显示信封文案，确认框仍开，删除 恢复可用，再点再发一次；树不变、不自动重列", async () => {
    const { mark } = openFiles(nested(), { [entriesUrl("out")]: NOT_FOUND });
    await findRow("展开 out");
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    expect(screen.getByRole("alertdialog", { name: "删除「out」？" })).toBe(dialog);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).queryByRole("status")).toBeNull();
    expect(confirmButton(dialog).disabled).toBe(false);
    await settle();
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`]);

    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(since()).toHaveLength(2));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    await settle();
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`, `DELETE ${entriesUrl("out")}`]);
    expect(rowNames()).toStrictEqual(["设计文档", "out", "output", "top.md"]);
  });
  it("D5b 服务端答 409（删除路由今天不答它）：显示的是信封文案，不是重命名的同名冲突文案", async () => {
    const { mark } = openFiles(nested(), {
      [entriesUrl("out")]: () =>
        jsonResponse({ error: { code: "conflict", message: "同名资源已存在" } }, 409),
    });
    await findRow("展开 out");
    const dialog = await openDelete("out");
    const since = mark();

    fireEvent.click(confirmButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("同名资源已存在");
    expect(confirmButton(dialog).disabled).toBe(false);
    await settle();
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`]);
  });
});

describe("删除确认框的焦点与模态清理", () => {
  it("D6 初始焦点经受延迟回焦：让出一个宏任务后焦点仍在 取消 上，确认框是 aria-modal", async () => {
    openFiles(nested());
    await findRow("展开 out");
    const dialog = await openDelete("out");

    await yieldMacrotask();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(cancelButton(dialog));
    await settle();
    expect(document.activeElement).toBe(cancelButton(dialog));
  });

  it("D7 取消 与 Escape：焦点回到该行的更多操作，body 没有 pointer-events 残留、容器没有 aria-hidden，没有 DELETE；按压遮罩不关闭", async () => {
    const { deletes, view } = openFiles(nested());
    await findRow("展开 out");
    const closers: ((dialog: HTMLElement) => void)[] = [
      (dialog) => fireEvent.click(cancelButton(dialog)),
      () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" }),
    ];

    for (const close of closers) {
      const dialog = await openDelete("out");
      await yieldMacrotask();
      // 模态期两样都在：下面「没有残留」的断言因此不是空话。
      expect(view.container.getAttribute("aria-hidden")).toBe("true");
      expect(document.body.style.pointerEvents).toBe("none");
      // 遮罩上的一次按压：确认框仍开（拷入层 alert-dialog 的既有行为）。焦点不在这里断言：jsdom 的
      // 合成按压不移焦点，真实浏览器里它落到 body、Tab 仍困在框内。
      pressPointer(overlay());
      await settle();
      expect(screen.getByRole("alertdialog", { name: "删除「out」？" })).toBe(dialog);

      close(dialog);
      await confirmGone();
      await focusedOn(() => menuButton("out"));
      expect(document.body.style.pointerEvents).toBe("");
      expect(view.container.hasAttribute("aria-hidden")).toBe(false);
    }
    expect(deletes()).toHaveLength(0);
  });

  it("D17 只用键盘：更多操作上按 Enter，方向键到 删除，再按 Enter，焦点在 取消 上；取消 上按 Enter 即关闭、没有请求", async () => {
    const { deletes } = openFiles(flat());
    await findRow("notes.md");
    const trigger = menuButton("notes.md");
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    const rename = within(menu).getByRole("menuitem", { name: "重命名" });
    await waitFor(() => expect(document.activeElement).toBe(rename));
    fireEvent.keyDown(rename, { key: "ArrowDown" });
    const move = within(menu).getByRole("menuitem", { name: "移动到…" });
    await waitFor(() => expect(document.activeElement).toBe(move));
    fireEvent.keyDown(move, { key: "ArrowDown" });
    const remove = within(menu).getByRole("menuitem", { name: "删除" });
    await waitFor(() => expect(document.activeElement).toBe(remove));
    fireEvent.keyDown(remove, { key: "Enter" });
    const dialog = await screen.findByRole("alertdialog", { name: "删除「notes.md」？" });
    await yieldMacrotask();
    expect(document.activeElement).toBe(cancelButton(dialog));

    // 回车落在 取消 上：按钮的回车即点击。
    fireEvent.click(document.activeElement as Element);
    await confirmGone();
    await focusedOn(() => trigger);
    await settle();
    expect(deletes()).toHaveLength(0);
    expect(rowNames()).toStrictEqual(["设计文档", "notes.md", "readme.md"]);
  });

  it("D18 成功与 404 全程不弹 Toast", async () => {
    const listings = nested();
    const answers = [NOT_FOUND(), deleted()];
    openFiles(listings, {
      [entriesUrl("out")]: () => {
        const answer = answers.shift() as Response;
        if (answer.status === 204) listings[""] = withoutOut();
        return answer;
      },
    });
    /** 让出一轮再数：整页的提示面恰为 `notices`（应用里已没有 Toast 组件，#1398）。 */
    const noToast = async (notices: string[]) => {
      await yieldMacrotask();
      expect(pageNotices()).toEqual(notices);
    };
    await findRow("展开 out");
    const dialog = await openDelete("out");

    fireEvent.click(confirmButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    await noToast(["alert:请求的资源不存在"]);
    fireEvent.click(confirmButton(dialog));
    await confirmGone();
    await waitFor(() => expect(rowNames()).toStrictEqual(["设计文档", "output", "top.md"]));
    await noToast([]);
  });
});

describe("请求中的确认框", () => {
  it("D8 挂起时 删除 禁用、焦点移到 取消、按压遮罩不关闭也不中止；取消 后 signal 已中止、确认框关闭；迟到的 204 不重开、不重列、不报错", async () => {
    const held = deferredResponse();
    const { deletes, mark } = openFiles(nested(), { [entriesUrl("out")]: () => held.promise });
    await findRow("展开 out");
    const dialog = await openDelete("out");
    const since = mark();
    const confirm = confirmButton(dialog);

    confirm.focus();
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm.disabled).toBe(true));
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(within(dialog).getByRole("status").textContent).toBe(PENDING_NOTE);
    // 按钮被禁用的那一刻焦点在它上面：移到 取消，不留在禁用的控件上、也不逃出确认框。
    expect(document.activeElement).toBe(cancelButton(dialog));
    expect(cancelButton(dialog).textContent).toBe("取消");
    fireEvent.click(confirm);
    await settle();
    expect(deletes()).toHaveLength(1);

    await yieldMacrotask();
    pressPointer(overlay());
    await settle();
    expect(screen.getByRole("alertdialog", { name: "删除「out」？" })).toBe(dialog);
    expect(deletes()[0]?.[1]?.signal?.aborted).toBe(false);
    expect(confirm.disabled).toBe(true);

    fireEvent.click(cancelButton(dialog));
    await confirmGone();
    expect(deletes()[0]?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(() => menuButton("out"));

    await act(async () => {
      held.resolve(deleted());
    });
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "output", "top.md"]);
    expect(document.activeElement).toBe(menuButton("out"));
    expect(since()).toStrictEqual([`DELETE ${entriesUrl("out")}`]);
  });

  it("D9 挂起时按 Escape：确认框关闭，请求的 signal 已中止，焦点回到该行的更多操作，全程恰一次 DELETE", async () => {
    const held = deferredResponse();
    const { deletes } = openFiles(nested(), { [entriesUrl("out")]: () => held.promise });
    await findRow("展开 out");
    const dialog = await openDelete("out");
    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(confirmButton(dialog).disabled).toBe(true));
    expect(deletes()[0]?.[1]?.signal?.aborted).toBe(false);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await confirmGone();
    expect(deletes()[0]?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(() => menuButton("out"));
    await settle();
    expect(deletes()).toHaveLength(1);
  });

  it("D10 服务端答 401：确认框里不显示失败文案，停在请求中的样子（登录层接手），取消 仍可关闭", async () => {
    // 整页上 401 会先把页面换成登录页、确认框随之卸载；直接渲染组件，看的是确认框自己做了什么。
    const fetchMock = createFetchMock({
      [treeUrl("")]: () => jsonResponse({ path: "", entries: [fileEntry("notes.md")] }),
      [entriesUrl("notes.md")]: () =>
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    });
    vi.stubGlobal("fetch", fetchMock);
    const deletes = () => fetchMock.mock.calls.filter(([path]) => path === entriesUrl("notes.md"));
    render(
      <WorkspaceBrowser
        account="zhangsan"
        client={createApiClient()}
        onPathChange={() => {}}
        path={null}
        workspaceId="workspace-1"
      />,
    );
    await findRow("notes.md");
    const dialog = await openDelete("notes.md");

    fireEvent.click(confirmButton(dialog));
    await waitFor(() => expect(deletes()).toHaveLength(1));
    await settle();
    expect(screen.getByRole("alertdialog", { name: "删除「notes.md」？" })).toBe(dialog);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(dialog).getByRole("status").textContent).toBe(PENDING_NOTE);
    expect(confirmButton(dialog).disabled).toBe(true);
    expect(rowNames()).toStrictEqual(["工作空间", "notes.md"]);

    fireEvent.click(cancelButton(dialog));
    await confirmGone();
    await focusedOn(() => menuButton("notes.md"));
    expect(deletes()).toHaveLength(1);
  });
});
