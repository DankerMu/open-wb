import { existsSync } from "node:fs";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  type FetchRoutes,
  openDirectoryDialog,
  openWorkspaceDialogFromMenu,
  renderFiles,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { deferredResponse, jsonResponse } from "./support.js";
import { listRepoFiles, pressPointer, readRepoFile, yieldMacrotask } from "./ui-support.js";

const DIRS_PATH = "/api/workspaces/workspace-1/dirs";
const ROOT_TREE = "/api/workspaces/workspace-1/tree?path=";

afterEach(async () => {
  cleanupFilesFixture();
  await yieldMacrotask();
});

type FetchMock = ReturnType<typeof renderFiles>["fetchMock"];

function renderWorkspace(routes: FetchRoutes = {}) {
  return renderFiles(
    "/files?ws=workspace-1",
    authenticatedFilesRoutes([workspace], {
      [ROOT_TREE]: jsonResponse({ path: "", entries: [] }),
      ...routes,
    }),
  );
}

function posts(fetchMock: FetchMock, path: string) {
  return fetchMock.mock.calls.filter(
    ([requestPath, options]) => requestPath === path && options?.method === "POST",
  );
}

function focusedOn(element: Element) {
  return waitFor(() => expect(document.activeElement).toBe(element));
}

function dialogGone(name: string) {
  return waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
}

type View = ReturnType<typeof renderFiles>["view"];

/** 模态期：Radix Dialog `hideOthers` 标记 RTL 容器，DismissableLayer 禁用外部指针。 */
function expectModalSet(view: View) {
  expect(view.container.getAttribute("aria-hidden")).toBe("true");
  expect(document.body.style.pointerEvents).toBe("none");
}

/** 取消类关闭且焦点已归还后：body 无 pointer-events 残留，应用根无 aria-hidden 残留。 */
function expectModalCleared(view: View) {
  expect(document.body.style.pointerEvents).toBe("");
  expect(view.container.hasAttribute("aria-hidden")).toBe(false);
}

describe("files creation overlays focus loop", () => {
  it("O1 returns focus to 选择工作空间 after the switcher path and after a bare switcher Escape", async () => {
    const { fetchMock, view } = renderWorkspace();
    const switcherTrigger = await screen.findByRole("button", { name: "选择工作空间" });

    fireEvent.click(switcherTrigger);
    const switcher = await screen.findByRole("dialog", { name: "工作空间切换器" });
    await focusedOn(within(switcher).getByLabelText("搜索工作空间"));
    fireEvent.click(within(switcher).getByRole("button", { name: "＋ 新建工作空间" }));
    const dialog = await screen.findByRole("dialog", { name: "新建工作空间" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("将在你的沙箱内创建同名目录", { exact: true })).toBeTruthy();
    await yieldMacrotask();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("工作空间名称"));
    expectModalSet(view);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await dialogGone("新建工作空间");
    await focusedOn(switcherTrigger);
    expectModalCleared(view);
    expect(posts(fetchMock, "/api/workspaces")).toHaveLength(0);

    await yieldMacrotask();
    fireEvent.click(switcherTrigger);
    const reopened = await screen.findByRole("dialog", { name: "工作空间切换器" });
    await focusedOn(within(reopened).getByLabelText("搜索工作空间"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await dialogGone("工作空间切换器");
    await focusedOn(switcherTrigger);
  });

  it("O2 lists exactly two menu items and returns focus to 新建 after cancelling from the menu path", async () => {
    const { fetchMock, view } = renderWorkspace();
    const menuTrigger = await screen.findByRole("button", { name: "新建" });

    pressPointer(menuTrigger);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["新建文件夹", "新建工作空间"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "新建工作空间" }));
    const dialog = await screen.findByRole("dialog", { name: "新建工作空间" });
    expect(within(dialog).getByText("将在你的沙箱内创建同名目录", { exact: true })).toBeTruthy();
    await yieldMacrotask();
    expectModalSet(view);
    expect(document.activeElement).toBe(within(dialog).getByLabelText("工作空间名称"));
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await dialogGone("新建工作空间");
    await focusedOn(menuTrigger);
    expectModalCleared(view);
    expect(posts(fetchMock, "/api/workspaces")).toHaveLength(0);
  });

  it("O3 focuses 位置 and returns focus to 新建 after 关闭 and after an overlay press", async () => {
    const { fetchMock } = renderWorkspace();
    const menuTrigger = await screen.findByRole("button", { name: "新建" });

    const dialog = await openDirectoryDialog();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await yieldMacrotask();
    expect(document.activeElement).toBe(within(dialog).getByLabelText("位置"));
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭" }));
    await dialogGone("新建文件夹");
    await focusedOn(menuTrigger);

    await openDirectoryDialog();
    await yieldMacrotask();
    const overlay = document.querySelector(".ui-dialog-overlay");
    if (!overlay) throw new Error("expected the dialog overlay");
    pressPointer(overlay);
    await dialogGone("新建文件夹");
    await focusedOn(menuTrigger);
    expect(posts(fetchMock, DIRS_PATH)).toHaveLength(0);
  });

  it("O4 keeps focus on 关闭 while a folder create is held and aborts it on 取消", async () => {
    const held = deferredResponse();
    const { fetchMock } = renderWorkspace({ [DIRS_PATH]: () => held.promise });
    const menuTrigger = await screen.findByRole("button", { name: "新建" });

    const dialog = await openDirectoryDialog();
    fireEvent.change(within(dialog).getByLabelText("文件夹名称"), { target: { value: "held" } });
    const create = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
    create.focus();
    fireEvent.click(create);
    await waitFor(() => expect(create.disabled).toBe(true));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));
    expect(posts(fetchMock, DIRS_PATH)).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await dialogGone("新建文件夹");
    const [request] = posts(fetchMock, DIRS_PATH);
    expect(request?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(menuTrigger);
  });

  it("O5 keeps focus inside the workspace dialog while held and after a 409 conflict", async () => {
    const held = deferredResponse();
    renderWorkspace({ "/api/workspaces": workspaceRoute([workspace], () => held.promise) });
    await screen.findByRole("button", { name: "新建" });

    const dialog = await openWorkspaceDialogFromMenu();
    fireEvent.change(within(dialog).getByLabelText("工作空间名称"), { target: { value: "重复" } });
    const create = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
    create.focus();
    fireEvent.click(create);
    await waitFor(() => expect(create.disabled).toBe(true));
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "关闭" }));

    await act(async () => {
      held.resolve(jsonResponse({ error: { code: "conflict", message: "ignored" } }, 409));
    });
    expect((await within(dialog).findByRole("alert")).textContent).toBe("同名工作空间已存在");
    expect(screen.getByRole("dialog", { name: "新建工作空间" })).toBe(dialog);
    expect(create.disabled).toBe(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("O6 closes the creation menu on Escape and returns focus to 新建", async () => {
    renderWorkspace();
    const menuTrigger = await screen.findByRole("button", { name: "新建" });

    pressPointer(menuTrigger);
    fireEvent.keyDown(await screen.findByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await focusedOn(menuTrigger);
  });

  it("O9 aborts a held folder create on an overlay press and returns focus to 新建", async () => {
    const held = deferredResponse();
    const { fetchMock } = renderWorkspace({ [DIRS_PATH]: () => held.promise });
    const menuTrigger = await screen.findByRole("button", { name: "新建" });

    const dialog = await openDirectoryDialog();
    fireEvent.change(within(dialog).getByLabelText("文件夹名称"), { target: { value: "held" } });
    const create = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
    create.focus();
    fireEvent.click(create);
    await waitFor(() => expect(create.disabled).toBe(true));
    expect(posts(fetchMock, DIRS_PATH)).toHaveLength(1);

    await yieldMacrotask();
    const overlay = document.querySelector(".ui-dialog-overlay");
    if (!overlay) throw new Error("expected the dialog overlay");
    pressPointer(overlay);
    await dialogGone("新建文件夹");
    const [request] = posts(fetchMock, DIRS_PATH);
    expect(request?.[1]?.signal?.aborted).toBe(true);
    await focusedOn(menuTrigger);
    expect(posts(fetchMock, DIRS_PATH)).toHaveLength(1);
  });
});

describe("files buttons render through the Button primitive", () => {
  it("O8 styles 新建, ＋ 新建工作空间, 取消 and 创建 as ui-btn variants", async () => {
    renderWorkspace();
    const menuTrigger = await screen.findByRole("button", { name: "新建" });
    expect(menuTrigger.className).toBe("ui-btn ui-btn--secondary ui-btn--md");

    fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
    const switcher = await screen.findByRole("dialog", { name: "工作空间切换器" });
    const newWorkspace = within(switcher).getByRole("button", { name: "＋ 新建工作空间" });
    expect(newWorkspace.className).toBe("ui-btn ui-btn--secondary ui-btn--md");

    fireEvent.click(newWorkspace);
    const dialog = await screen.findByRole("dialog", { name: "新建工作空间" });
    expect(within(dialog).getByRole("button", { name: "取消" }).className).toBe(
      "ui-btn ui-btn--secondary ui-btn--md",
    );
    const create = within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement;
    expect(create.className).toBe("ui-btn ui-btn--primary ui-btn--md");
    expect(create.type).toBe("submit");
  });
});

describe("files overlays come only from primitives", () => {
  it("O7 leaves no hand-written dialog, menu, or focus trap in web/src", () => {
    const legacy = ["<dialog", 'role="menu"', "showModal", "trapDialogFocus", "lib/dialog"];
    const hits = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path)).flatMap((path) => {
      const source = readRepoFile(path);
      return legacy
        .filter((needle) => source.includes(needle))
        .map((needle) => `${path}: ${needle}`);
    });
    expect(hits).toEqual([]);
    for (const removed of ["../src/lib/dialog.ts", "./dialog.test.tsx", "./dialog-platform.ts"]) {
      expect(existsSync(new URL(removed, import.meta.url)), removed).toBe(false);
    }
    const primitiveImport = (names: string) =>
      new RegExp(`import \\{ ${names} \\} from "\\.\\./\\.\\./ui/index\\.js";`);
    expect(readRepoFile("web/src/features/files/dialogs.tsx")).toMatch(
      primitiveImport("Button, Dialog, Menu"),
    );
    expect(readRepoFile("web/src/features/files/page.tsx")).toMatch(
      primitiveImport("Button, EmptyState, Icon, Popover"),
    );
  });
});
