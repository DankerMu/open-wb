import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectTreeRequestCount,
  renderFiles,
  workspace,
} from "./files-fixture.js";
import { jsonResponse, textPreviewResponse } from "./support.js";

// files-web「目录树与预览」的场景「手动刷新」。路由值用数组：每次请求取走一份应答，多发一次即抛错，
// 所以「恰两次」既由计数断言、也由路由表本身证明。

const ROOT = "/api/workspaces/workspace-1/tree?path=";
const OUT = "/api/workspaces/workspace-1/tree?path=out";
const NEVER = "/api/workspaces/workspace-1/tree?path=never";
const CLOSED = "/api/workspaces/workspace-1/tree?path=closed";
const README = "/api/workspaces/workspace-1/file?path=readme.md";

const rootEntries = [
  { name: "out", type: "dir", size: 0, mtime: 101 },
  { name: "never", type: "dir", size: 0, mtime: 102 },
  { name: "closed", type: "dir", size: 0, mtime: 106 },
  { name: "readme.md", type: "file", size: 8, mtime: 103 },
];
const outEntry = { name: "old.md", type: "file", size: 4, mtime: 104 };
const newEntry = { name: "new.md", type: "file", size: 4, mtime: 105 };
const closedEntry = { name: "before.md", type: "file", size: 4, mtime: 107 };
const reopenedEntry = { name: "after.md", type: "file", size: 4, mtime: 108 };

afterEach(() => {
  cleanupFilesFixture();
});

function tree() {
  return screen.getByRole("navigation", { name: "工作空间目录树" });
}

function refreshButton() {
  return screen.getByRole("button", { name: "刷新" }) as HTMLButtonElement;
}

describe("files manual refresh", () => {
  it("R1 refetches every loaded directory and the current file, keeping expansion, selection and view mode", async () => {
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT]: [
          jsonResponse({ path: "", entries: rootEntries }),
          jsonResponse({ path: "", entries: rootEntries }),
        ],
        [OUT]: [
          jsonResponse({ path: "out", entries: [outEntry] }),
          jsonResponse({ path: "out", entries: [outEntry, newEntry] }),
        ],
        [CLOSED]: [
          jsonResponse({ path: "closed", entries: [closedEntry] }),
          jsonResponse({ path: "closed", entries: [reopenedEntry] }),
        ],
        [README]: [textPreviewResponse("# 第一份"), textPreviewResponse("# 第二份")],
      }),
    );

    // 展开后又折叠的目录仍算「已加载」。
    fireEvent.click(await screen.findByRole("button", { name: "展开 closed" }));
    await screen.findByRole("button", { name: "before.md" });
    fireEvent.click(screen.getByRole("button", { name: "折叠 closed" }));
    expect(screen.queryByRole("button", { name: "before.md" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    await screen.findByRole("button", { name: "old.md" });
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看源码" }));
    const preview = screen.getByRole("region", { name: "文件预览" });
    expect(await within(preview).findByText("# 第一份", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "new.md" })).toBeNull();

    const refresh = refreshButton();
    expect(refresh.type).toBe("button");
    expect(refresh.disabled).toBe(false);
    fireEvent.click(refresh);

    expect(await screen.findByRole("button", { name: "new.md" })).toBeTruthy();
    expect(await within(preview).findByText("# 第二份", { exact: true })).toBeTruthy();
    for (const path of [ROOT, OUT, CLOSED, README]) {
      await expectTreeRequestCount(fetchMock, path, 2);
    }
    // 从未加载过的目录不在刷新范围内。
    await expectTreeRequestCount(fetchMock, NEVER, 0);
    expect(
      within(tree()).getByRole("button", { name: "折叠 out" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "old.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "readme.md" }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "查看源码" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    // 折叠着的目录刷新后不自动展开；再展开时走缓存，看到的是第二份应答。
    const closed = within(tree()).getByRole("button", { name: "展开 closed" });
    expect(closed.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(closed);
    expect(await screen.findByRole("button", { name: "after.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "before.md" })).toBeNull();
    await expectTreeRequestCount(fetchMock, CLOSED, 2);
  });

  it("R2 keeps the old listing and shows the error when a refresh fails", async () => {
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT]: [
          jsonResponse({ path: "", entries: rootEntries }),
          jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
        ],
      }),
    );

    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(refreshButton());

    expect((await screen.findByRole("alert")).textContent).toBe("目录读取失败");
    await expectTreeRequestCount(fetchMock, ROOT, 2);
    for (const name of ["展开 out", "展开 never", "展开 closed", "readme.md"]) {
      expect(within(tree()).getByRole("button", { name })).toBeTruthy();
    }
  });

  it("R3 retries a root listing that failed on first load", async () => {
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT]: [
          jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
          jsonResponse({ path: "", entries: rootEntries }),
        ],
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe("目录读取失败");
    fireEvent.click(refreshButton());

    expect(await screen.findByRole("button", { name: "readme.md" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await expectTreeRequestCount(fetchMock, ROOT, 2);
  });

  it("R4 places 刷新 between the tree heading and 新建, and disables it without a workspace", async () => {
    renderFiles("/files", authenticatedFilesRoutes([]));

    await screen.findByText("先选择或创建工作空间", { exact: true });
    const refresh = refreshButton();
    expect(refresh.disabled).toBe(true);
    const heading = screen.getByRole("heading", { level: 2, name: "工作空间目录" });
    const create = screen.getByRole("button", { name: "新建" });
    expect(heading.compareDocumentPosition(refresh)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(refresh.compareDocumentPosition(create)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("R5 retries an expanded directory whose first load failed", async () => {
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        [ROOT]: [
          jsonResponse({ path: "", entries: rootEntries }),
          jsonResponse({ path: "", entries: rootEntries }),
        ],
        [OUT]: [
          jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
          jsonResponse({ path: "out", entries: [outEntry] }),
        ],
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "展开 out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("目录读取失败");
    expect(screen.queryByRole("button", { name: "old.md" })).toBeNull();
    fireEvent.click(refreshButton());

    expect(await screen.findByRole("button", { name: "old.md" })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    for (const path of [ROOT, OUT]) {
      await expectTreeRequestCount(fetchMock, path, 2);
    }
    await expectTreeRequestCount(fetchMock, NEVER, 0);
    await expectTreeRequestCount(fetchMock, CLOSED, 0);
    expect(
      within(tree()).getByRole("button", { name: "折叠 out" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });
});
