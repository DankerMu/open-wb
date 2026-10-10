import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectLocation,
  openWorkspaceDialogFromMenu,
  renderFiles,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { jsonResponse, textPreviewResponse } from "./support.js";
import { readRepoFile } from "./ui-support.js";

afterEach(() => {
  cleanupFilesFixture();
});

const ROOT_ROUTE = "/api/workspaces/workspace-1/tree?path=";

function emptyStateOf(element: HTMLElement) {
  const container = element.closest('[data-slot="empty-state"]');
  expect(container).not.toBeNull();
  return container;
}

describe("files empty states", () => {
  it("E1 shows the empty-workspace guidance in the tree and the unselected-file state in the preview", async () => {
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT_ROUTE]: jsonResponse({ path: "", entries: [] }),
      }),
    );

    const title = await screen.findByText("该工作空间暂无目录", { exact: true });
    const guidance = screen.getByText("点击左上角 ＋ 新建文件夹", { exact: true });
    const treeEmpty = emptyStateOf(title);
    expect(guidance.closest('[data-slot="empty-state"]')).toBe(treeEmpty);
    expect(treeEmpty?.closest('nav[aria-label="工作空间目录树"]')).not.toBeNull();
    expect(screen.queryByText("空目录")).toBeNull();
    expect(screen.queryByText("此文件夹为空")).toBeNull();

    const preview = screen.getByRole("region", { name: "文件预览" });
    const unselected = within(preview).getByText("未选择文件", { exact: true });
    const hint = within(preview).getByText("在左侧目录树中选择一个文件进行预览", { exact: true });
    const previewEmpty = emptyStateOf(unselected);
    expect(hint.closest('[data-slot="empty-state"]')).toBe(previewEmpty);
  });

  it("E2 shows 空目录 for an expanded empty folder and the unsupported subline without a file request", async () => {
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT_ROUTE]: jsonResponse({
          path: "",
          entries: [
            { name: "out", type: "dir", size: 0, mtime: 101 },
            { name: "归档.zip", type: "file", size: 90492109, mtime: 102 },
          ],
        }),
        "/api/workspaces/workspace-1/tree?path=out": jsonResponse({ path: "out", entries: [] }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "展开 out" }));
    expect(await screen.findByText("空目录", { exact: true })).toBeTruthy();
    expect(screen.queryByText("该工作空间暂无目录")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "归档.zip" }));
    const unsupported = await screen.findByText("该类型不支持预览", { exact: true });
    const block = unsupported.closest('[data-slot="empty-state"]');
    expect(block).not.toBeNull();
    const description = block?.querySelector('[data-slot="empty-state-desc"]');
    expect(description?.textContent).toBe("归档.zip · 86.3 MB\u3000二进制或未识别格式");
    expect(fetchMock.mock.calls.filter(([path]) => path.includes("/file?"))).toEqual([]);
  });

  it("E3 shows the create-workspace guidance as an empty state when the account has no workspace", async () => {
    renderFiles("/files", authenticatedFilesRoutes([]));

    const title = await screen.findByText("先选择或创建工作空间", { exact: true });
    const guidance = screen.getByText("使用左上角 ＋ 新建工作空间", { exact: true });
    expect(guidance.closest('[data-slot="empty-state"]')).toBe(emptyStateOf(title));
  });

  // 只走 `新建` 菜单入口：切换器的 `＋ 新建工作空间` 直接调 openWorkspaceDialog，
  // 不经空态分支的 onNewWorkspace，走它会让「空态下 ＋ 菜单仍可新建」这条证据失去意义。
  it("E3b creates the first workspace from the 新建 menu when the account has no workspace", async () => {
    const firstWorkspace = {
      ...workspace,
      id: "workspace-first",
      name: "首个空间",
      dir: "first-space",
      root: "/sandbox/user-1/first-space",
    };
    const createBodies: unknown[] = [];
    renderFiles(
      "/files",
      authenticatedFilesRoutes([], {
        "/api/workspaces": workspaceRoute([], (options) => {
          createBodies.push(options?.body);
          return jsonResponse(firstWorkspace, 201);
        }),
        "/api/workspaces/workspace-first/tree?path=": jsonResponse({ path: "", entries: [] }),
      }),
    );

    expect(await screen.findByText("未选择工作空间", { exact: true })).toBeTruthy();
    expect(await screen.findByText("先选择或创建工作空间", { exact: true })).toBeTruthy();
    const dialog = await openWorkspaceDialogFromMenu();
    fireEvent.change(within(dialog).getByLabelText("工作空间名称"), {
      target: { value: "首个空间" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await expectLocation("/files?ws=workspace-first");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "新建工作空间" })).toBeNull();
      const card = screen.getByRole("button", { name: "选择工作空间" });
      expect(within(card).getByText("首个空间", { exact: true })).toBeTruthy();
      expect(screen.queryByText("先选择或创建工作空间")).toBeNull();
      expect(screen.queryByText("未选择工作空间")).toBeNull();
    });
    expect(createBodies).toEqual(['{"name":"首个空间"}']);
  });
});

describe("files long names and layout rules", () => {
  it("E4 titles tree rows with the full name while keeping their accessible names", async () => {
    const LONG_DIR = "d".repeat(52);
    const LONG_FILE = `${"f".repeat(52)}.md`;
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT_ROUTE]: jsonResponse({
          path: "",
          entries: [
            { name: LONG_DIR, type: "dir", size: 0, mtime: 101 },
            { name: LONG_FILE, type: "file", size: 12, mtime: 102 },
          ],
        }),
      }),
    );

    const dirButton = await screen.findByRole("button", { name: `展开 ${LONG_DIR}` });
    expect(dirButton.getAttribute("title")).toBe(LONG_DIR);
    expect(screen.getByRole("button", { name: LONG_FILE }).getAttribute("title")).toBe(LONG_FILE);
    expect(screen.getByRole("button", { name: "折叠 设计文档" }).getAttribute("title")).toBe(
      "设计文档",
    );
  });

  it("E5 pins ellipsis names, scrolling previews, and the retired empty-state copy", async () => {
    const LONG_FILE = `${"f".repeat(52)}.ts`;
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT_ROUTE]: jsonResponse({
          path: "",
          entries: [
            { name: "d".repeat(52), type: "dir", size: 0, mtime: 101 },
            { name: LONG_FILE, type: "file", size: 12, mtime: 102 },
            { name: "notes.csv", type: "file", size: 12, mtime: 103 },
            { name: "readme.md", type: "file", size: 12, mtime: 104 },
          ],
        }),
        [`/api/workspaces/workspace-1/file?path=${LONG_FILE}`]: textPreviewResponse("const a = 1;"),
        "/api/workspaces/workspace-1/file?path=notes.csv": textPreviewResponse("name\nalpha\n"),
        "/api/workspaces/workspace-1/file?path=readme.md": textPreviewResponse("# 说明"),
      }),
    );

    // 名称元素带单行省略的样式：目录行与文件行都是。
    await screen.findByRole("button", { name: LONG_FILE });
    const names = [
      ...screen
        .getByRole("navigation", { name: "工作空间目录树" })
        .querySelectorAll('[data-slot="tree-name"]'),
    ];
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(name.classList.contains("truncate"), name.textContent ?? "").toBe(true);
    }

    // 源码、表格与 Markdown 渲染各自的滚动容器可内部滚动。
    const preview = screen.getByRole("region", { name: "文件预览" });
    for (const [file, slot] of [
      [LONG_FILE, "preview-code"],
      ["notes.csv", "preview-table"],
      ["readme.md", "preview-markdown"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: file }));
      const body = await waitFor(() => {
        const container = preview.querySelector(`[data-slot="${slot}"]`);
        expect(container, slot).not.toBeNull();
        return container as HTMLElement;
      });
      expect(body.classList.contains("overflow-auto"), slot).toBe(true);
    }

    const tree = readRepoFile("web/src/features/files/tree.tsx");
    const page = readRepoFile("web/src/features/files/page.tsx");
    for (const source of [tree, page]) {
      expect(source).not.toContain("此文件夹为空");
      expect(source).not.toContain("files-tree-empty");
      expect(source).not.toContain('ui-empty"');
    }
    for (const path of ["preview.tsx", "types.ts"]) {
      expect(readRepoFile(`web/src/features/files/${path}`)).not.toContain(
        'status: "unsupported"; message',
      );
    }
  });
});
