import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";
import { blockBody, COLOR_LITERAL_PATTERNS, readRepoFile, stripComments } from "./ui-support.js";

afterEach(() => {
  cleanupFilesFixture();
});

const ROOT_ROUTE = "/api/workspaces/workspace-1/tree?path=";

function emptyStateOf(element: HTMLElement) {
  const container = element.closest(".ui-empty-state");
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
    expect(guidance.closest(".ui-empty-state")).toBe(treeEmpty);
    expect(treeEmpty?.closest('nav[aria-label="工作空间目录树"]')).not.toBeNull();
    expect(screen.queryByText("空目录")).toBeNull();
    expect(screen.queryByText("此文件夹为空")).toBeNull();

    const preview = screen.getByRole("region", { name: "文件预览" });
    const unselected = within(preview).getByText("未选择文件", { exact: true });
    const hint = within(preview).getByText("在左侧目录树中选择一个文件进行预览", { exact: true });
    const previewEmpty = emptyStateOf(unselected);
    expect(hint.closest(".ui-empty-state")).toBe(previewEmpty);
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
    const description = emptyStateOf(unsupported)?.querySelector(".ui-empty-state-desc");
    expect(description?.textContent).toBe("归档.zip · 86.3 MB\u3000二进制或未识别格式");
    expect(fetchMock.mock.calls.filter(([path]) => path.includes("/file?"))).toEqual([]);
  });

  it("E3 shows the create-workspace guidance as an empty state when the account has no workspace", async () => {
    renderFiles("/files", authenticatedFilesRoutes([]));

    const title = await screen.findByText("先选择或创建工作空间", { exact: true });
    const guidance = screen.getByText("使用左上角 ＋ 新建工作空间", { exact: true });
    expect(guidance.closest(".ui-empty-state")).toBe(emptyStateOf(title));
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

  it("E5 pins the tree column widths, the narrow column layout, ellipsis names, and scrolling previews", () => {
    const rules = stripComments(readRepoFile("web/src/features/files/files.css"));
    expect(blockBody(rules, /^\.files-layout \{/m)).toContain(
      "grid-template-columns: 280px minmax(0, 1fr)",
    );
    const medium = blockBody(rules, /^@media \(max-width: 900px\) \{/m);
    expect(medium).toContain(".files-layout");
    expect(medium).toContain("grid-template-columns: 210px minmax(0, 1fr)");
    expect(blockBody(rules, /^@media \(max-width: 760px\) \{/m)).toContain(
      "flex-direction: column",
    );

    const nameRule = blockBody(rules, /^\.files-tree-name \{/m);
    for (const declaration of [
      "min-width: 0",
      "overflow: hidden",
      "text-overflow: ellipsis",
      "white-space: nowrap",
    ]) {
      expect(nameRule).toContain(declaration);
    }
    expect(nameRule).not.toContain("overflow-wrap");
    expect(blockBody(rules, /^\.files-code,\n\.files-table \{/m)).toContain("overflow: auto");
    expect(blockBody(rules, /^\.files-md \{/m)).toContain("overflow: auto");
    expect(blockBody(rules, /^\.files-preview-empty \.ui-empty-state \{/m)).toContain(
      "min-width: 0",
    );
    expect(blockBody(rules, /^\.files-preview-empty \.ui-empty-state-desc \{/m)).toContain(
      "overflow-wrap: anywhere",
    );

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
    for (const pattern of COLOR_LITERAL_PATTERNS) {
      expect(rules).not.toMatch(pattern);
    }
  });
});
