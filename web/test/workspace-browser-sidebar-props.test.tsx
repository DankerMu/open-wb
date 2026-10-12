// `WorkspaceBrowser` 为会话页侧边栏加的两个可选属性（issue #1106）：`treeCollapsed`（树栏收起而不卸载）
// 与 `onlyPathsEmpty`（`onlyPaths` 为空集时树的位置的文案）。组件直接渲染、不挂路由；文件页两个都不传，
// 用例同时钉住不传时与此前相同。请求数取自 fetch 桩的调用记录。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { createFetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const ROOT = "/api/workspaces/workspace-1/tree?path=";
const README = "/api/workspaces/workspace-1/file?path=readme.md";
const TREE = "工作空间目录树";
const EMPTY_TEXT = "这里没有要显示的文件";
const EMPTY_WORKSPACE = "该工作空间暂无目录";

type Extra = {
  onlyPaths?: ReadonlySet<string>;
  onlyPathsEmpty?: string;
  treeCollapsed?: boolean;
};

/** 根下只有 `readme.md` 的空间；`update` 换属性而不重挂。 */
function mount(extra: Extra = {}) {
  const fetchMock = createFetchMock({
    [ROOT]: () =>
      jsonResponse({
        path: "",
        entries: [{ name: "readme.md", type: "file", size: 4, mtime: 200 }],
      }),
    [README]: () => textPreviewResponse("自述正文"),
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = createApiClient();
  const browser = (props: Extra) => (
    <WorkspaceBrowser
      account="zhangsan"
      client={client}
      onPathChange={() => {}}
      path={null}
      workspaceId="workspace-1"
      {...props}
    />
  );
  const view = render(browser(extra));
  return {
    requests: () => paths(fetchMock),
    update: (props: Extra) => view.rerender(browser(props)),
  };
}

const column = () => document.querySelector('aside[aria-label="工作空间文件"]') as HTMLElement;
const preview = () => within(screen.getByRole("region", { name: "文件预览" }));

async function settle() {
  await act(async () => {
    await yieldMacrotask();
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WorkspaceBrowser treeCollapsed", () => {
  it("不传时树栏没有 hidden 属性；传真值后树栏带 hidden（树、刷新、新建按角色查不到）而节点还在，预览与选中不动，撤掉后是同一棵树且没有新请求", async () => {
    const { requests, update } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "readme.md" }));
    expect(await preview().findByText("自述正文", { exact: true })).toBeTruthy();
    const tree = screen.getByRole("navigation", { name: TREE });
    expect(column().hasAttribute("hidden")).toBe(false);
    expect(requests()).toStrictEqual([ROOT, README]);

    update({ treeCollapsed: true });

    expect(column().hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("navigation", { name: TREE })).toBeNull();
    expect(screen.queryByRole("button", { name: "刷新" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新建" })).toBeNull();
    expect(tree.isConnected).toBe(true);
    expect(column().contains(tree)).toBe(true);
    expect(preview().getByText("自述正文", { exact: true })).toBeTruthy();

    update({ treeCollapsed: false });

    expect(column().hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("navigation", { name: TREE })).toBe(tree);
    expect(screen.getByRole("button", { name: "readme.md" }).getAttribute("aria-current")).toBe(
      "true",
    );
    await settle();
    expect(requests()).toStrictEqual([ROOT, README]);
  });
});

describe("WorkspaceBrowser onlyPathsEmpty", () => {
  it("onlyPaths 为空集且给了文案：树的位置是这段文案，没有目录树，也没有空工作空间的提示", async () => {
    const { update } = mount();
    await screen.findByRole("button", { name: "readme.md" });

    update({ onlyPaths: new Set(), onlyPathsEmpty: EMPTY_TEXT });

    expect(within(column()).getByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: TREE })).toBeNull();
    expect(screen.queryByText(EMPTY_WORKSPACE)).toBeNull();
    // 树栏自己的 `刷新` 与 `新建` 还在；`新建` 在 `onlyPaths` 下禁用。
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "新建" }).disabled).toBe(true);
  });

  it("onlyPaths 不是空集、或没有 onlyPaths 时不显示这段文案：照常是树", async () => {
    const { update } = mount({ onlyPathsEmpty: EMPTY_TEXT });
    expect(await screen.findByRole("button", { name: "readme.md" })).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();

    update({ onlyPaths: new Set(["out/a.md"]), onlyPathsEmpty: EMPTY_TEXT });

    expect(screen.getByRole("button", { name: "a.md" })).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });

  it("onlyPaths 为空集而没给文案（文件页不传）：与此前相同，根行下是空工作空间的提示", async () => {
    const { requests } = mount({ onlyPaths: new Set() });

    expect(await screen.findByText(EMPTY_WORKSPACE, { exact: true })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: TREE })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([]);
  });
});

describe("WorkspaceBrowser 新建 under onlyPaths", () => {
  it("没有 onlyPaths 时 新建 可用；传入后禁用、按下不出菜单，刷新 不受影响；撤掉后又可用", async () => {
    const { update } = mount();
    await screen.findByRole("button", { name: "readme.md" });
    const creation = () => screen.getByRole<HTMLButtonElement>("button", { name: "新建" });
    expect(creation().disabled).toBe(false);

    update({ onlyPaths: new Set(["out/a.md"]) });

    expect(creation().disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "刷新" }).disabled).toBe(false);
    fireEvent.pointerDown(creation(), { button: 0 });
    await settle();
    expect(screen.queryByRole("menuitem")).toBeNull();

    update({});

    expect(creation().disabled).toBe(false);
    fireEvent.pointerDown(creation(), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "新建文件夹" })).toBeTruthy();
  });
});
