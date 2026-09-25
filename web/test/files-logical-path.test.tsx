import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { logicalPath } from "../src/features/files/file-meta.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  hasLucideGlyph,
  openDirectoryDialog,
  openWorkspaceDialogFromMenu,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";
import { blockBody, COLOR_LITERAL_PATTERNS, readRepoFile, stripComments } from "./ui-support.js";

const PRIVATE_PREFIX = "/srv/private-sandbox";
const analytics = {
  ...workspace,
  id: "workspace-analytics",
  name: "数据分析",
  dir: "analytics",
  root: `${PRIVATE_PREFIX}/user-1/analytics`,
};
const designDocs = {
  ...workspace,
  id: "workspace-design",
  name: "设计文档",
  dir: "design-docs",
  root: `${PRIVATE_PREFIX}/user-1/design-docs`,
};
const LEAK_ATTRIBUTES = ["title", "aria-label", "aria-description", "placeholder"] as const;
const SECRETS = [PRIVATE_PREFIX, analytics.root, designDocs.root];

afterEach(() => {
  cleanupFilesFixture();
});

function renderAnalytics() {
  return renderFiles(
    `/files?ws=${analytics.id}`,
    authenticatedFilesRoutes([analytics, designDocs], {
      [`/api/workspaces/${analytics.id}/tree?path=`]: jsonResponse({
        path: "",
        entries: [
          { name: "out", type: "dir", size: 0, mtime: 101 },
          { name: "readme.md", type: "file", size: 8, mtime: 102 },
        ],
      }),
      [`/api/workspaces/${analytics.id}/tree?path=out`]: jsonResponse({ path: "out", entries: [] }),
      [`/api/workspaces/${designDocs.id}/tree?path=`]: jsonResponse({ path: "", entries: [] }),
    }),
  );
}

function switcherCard() {
  return screen.getByRole("button", { name: "选择工作空间" });
}

function tree() {
  return screen.getByRole("navigation", { name: "工作空间目录树" });
}

function leakedAttributeValues() {
  const selector = LEAK_ATTRIBUTES.map((name) => `[${name}]`).join(",");
  return [...document.body.querySelectorAll(selector)].flatMap((element) =>
    LEAK_ATTRIBUTES.map((name) => element.getAttribute(name) ?? ""),
  );
}

function expectNoAbsoluteRoot(state: string) {
  const text = document.body.textContent ?? "";
  const html = document.body.innerHTML;
  const attributes = leakedAttributeValues();
  expect(attributes.length, state).toBeGreaterThan(0);
  for (const secret of SECRETS) {
    expect(text, state).not.toContain(secret);
    expect(html, state).not.toContain(secret);
    for (const value of attributes) {
      expect(value, state).not.toContain(secret);
    }
  }
}

function openSwitcher() {
  fireEvent.click(switcherCard());
  return screen.getByRole("dialog", { name: "工作空间切换器" });
}

function listedWorkspaceNames(switcher: HTMLElement) {
  return [...switcher.querySelectorAll(".files-switcher-list li")].map(
    (item) => item.querySelector("strong")?.textContent,
  );
}

function search(switcher: HTMLElement, value: string) {
  fireEvent.change(within(switcher).getByLabelText("搜索工作空间"), { target: { value } });
}

async function rootButton() {
  return waitFor(() => within(tree()).getByRole("button", { name: "折叠 数据分析" }));
}

describe("L1 logicalPath", () => {
  it.each([
    ["zhangsan", "smoke-fixture", "zhangsan/smoke-fixture"],
    ["lisi", "设计文档", "lisi/设计文档"],
    ["zhangsan", "design-docs", "zhangsan/design-docs"],
  ])("joins %s and %s without a leading slash", (account, dir, expected) => {
    const path = logicalPath(account, dir);
    expect(path).toBe(expected);
    expect(path.startsWith("/")).toBe(false);
  });
});

describe("files page shows logical paths instead of the server root", () => {
  it("L2 never leaks any workspace root across page, switcher, and both creation dialogs", async () => {
    renderAnalytics();
    await rootButton();
    await waitFor(() => within(switcherCard()).getByText("zhangsan/analytics", { exact: true }));
    expectNoAbsoluteRoot("initial page");

    const switcher = openSwitcher();
    expectNoAbsoluteRoot("switcher open");
    expect(within(switcher).getByText("zhangsan/analytics", { exact: true })).toBeTruthy();
    expect(within(switcher).getByText("zhangsan/design-docs", { exact: true })).toBeTruthy();
    fireEvent.keyDown(switcher, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "工作空间切换器" })).toBeNull(),
    );

    const directoryDialog = await openDirectoryDialog("数据分析");
    expectNoAbsoluteRoot("new folder dialog open");
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建文件夹" })).toBeNull());

    const workspaceDialog = await openWorkspaceDialogFromMenu();
    expectNoAbsoluteRoot("new workspace dialog open");
    fireEvent.click(within(workspaceDialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "新建工作空间" })).toBeNull());

    // 切换会按 key 重挂树与切换器卡：每次重试都重新查询，不缓存元素。
    fireEvent.click(within(openSwitcher()).getByRole("button", { name: /设计文档/ }));
    await waitFor(() => {
      const root = within(tree()).getByRole("button", { name: "折叠 设计文档" });
      expect(root.nextElementSibling?.textContent).toBe("zhangsan/design-docs");
      expect(within(switcherCard()).getByText("设计文档", { exact: true })).toBeTruthy();
      expect(
        within(switcherCard()).getByText("zhangsan/design-docs", { exact: true }),
      ).toBeTruthy();
    });
    expect(within(tree()).queryByRole("button", { name: /数据分析/ })).toBeNull();
    expectNoAbsoluteRoot("after switch");

    fireEvent.click(within(tree()).getByRole("button", { name: "折叠 设计文档" }));
    await waitFor(() =>
      expect(within(tree()).getByRole("button", { name: "展开 设计文档" })).toBeTruthy(),
    );
    expectNoAbsoluteRoot("after collapse");
  });

  it("L3 renders the switcher card as layout-grid icon, workspace name, and logical path", async () => {
    renderAnalytics();
    await waitFor(() => within(switcherCard()).getByText("zhangsan/analytics", { exact: true }));
    const card = switcherCard();
    expect(hasLucideGlyph(card, "layout-grid")).toBe(true);
    expect(within(card).getByText("数据分析", { exact: true })).toBeTruthy();
  });

  it("L4 renders the tree root as shield icon, workspace name, and a logical-path subline", async () => {
    renderAnalytics();
    const button = await rootButton();
    expect(button.getAttribute("title")).toBe("数据分析");
    expect(hasLucideGlyph(button, "shield")).toBe(true);
    expect(hasLucideGlyph(button, "folder")).toBe(false);
    const subline = button.nextElementSibling;
    expect(subline?.matches("p.files-tree-root-path")).toBe(true);
    expect(subline?.textContent).toBe("zhangsan/analytics");
    await waitFor(() => expect(subline?.nextElementSibling?.matches("ul")).toBe(true));
    expect(within(tree()).queryByText("root", { exact: true })).toBeNull();

    const rule = blockBody(
      stripComments(readRepoFile("web/src/features/files/files.css")),
      /^\.files-tree-root-path \{/m,
    );
    expect(rule).toContain("var(--wb-text-tertiary)");
    expect(rule).toContain("text-overflow: ellipsis");
    expect(rule).toContain("white-space: nowrap");
    for (const pattern of COLOR_LITERAL_PATTERNS) {
      expect(rule).not.toMatch(pattern);
    }
  });

  it("L5 filters by workspace name or logical path, case-insensitively", async () => {
    renderAnalytics();
    await rootButton();
    const switcher = openSwitcher();
    const cases = [
      ["数据", ["数据分析"]],
      ["DESIGN", ["设计文档"]],
      ["zhangsan/ana", ["数据分析"]],
    ] as const;
    for (const [query, expected] of cases) {
      search(switcher, query);
      expect(listedWorkspaceNames(switcher), query).toEqual(expected);
      expect(within(switcher).queryByText("无匹配的工作空间", { exact: true }), query).toBeNull();
    }
    search(switcher, "不存在");
    expect(listedWorkspaceNames(switcher)).toEqual([]);
    expect(within(switcher).getByText("无匹配的工作空间", { exact: true })).toBeTruthy();
  });

  it("L6 labels the root location option with the workspace name", async () => {
    renderAnalytics();
    await rootButton();
    fireEvent.click(await within(tree()).findByRole("button", { name: "展开 out" }));
    await waitFor(() => expect(within(tree()).getByText("空目录", { exact: true })).toBeTruthy());
    const dialog = await openDirectoryDialog("数据分析");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["根目录　数据分析", "out"]);
  });
});
