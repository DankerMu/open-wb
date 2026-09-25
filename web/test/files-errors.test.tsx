import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  collapseAndExpand,
  expectCreateEnabledAfterAlert,
  expectTreeRequestCount,
  openDirectoryDialog,
  openWorkspaceDialog,
  renderFiles,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { jsonResponse } from "./support.js";

afterEach(() => {
  cleanupFilesFixture();
});

const fallback = "请求失败，请稍后重试";

function envelope(status: number, message: string) {
  return jsonResponse({ error: { code: "internal", message } }, status);
}

describe("workspace page error surfaces", () => {
  it("shows a workspace-list envelope and ends loading", async () => {
    renderFiles(
      "/files",
      authenticatedFilesRoutes([], {
        "/api/workspaces": envelope(500, "工作空间列表暂时不可用"),
      }),
    );

    expect((await screen.findByRole("alert")).textContent).toBe("工作空间列表暂时不可用");
    expect(screen.queryByText("正在读取工作空间", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "选择工作空间" })).toBeNull();
  });

  it("shows a tree-expand envelope and lets collapse then expand retry", async () => {
    let outReads = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({
          path: "",
          entries: [{ name: "out", type: "dir", size: 0, mtime: 1 }],
        }),
        "/api/workspaces/workspace-1/tree?path=out": () => {
          outReads += 1;
          return outReads === 1
            ? envelope(500, "目录读取失败")
            : jsonResponse({ path: "out", entries: [] });
        },
      }),
    );

    await screen.findByRole("button", { name: "展开 out" });
    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("目录读取失败");
    await collapseAndExpand("out");
    await expectTreeRequestCount(fetchMock, "/api/workspaces/workspace-1/tree?path=out", 2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a preview envelope and ends loading", async () => {
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({
          path: "",
          entries: [{ name: "readme.md", type: "file", size: 8, mtime: 1 }],
        }),
        "/api/workspaces/workspace-1/file?path=readme.md": envelope(502, "预览服务不可用"),
      }),
    );

    await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }));
    expect(await screen.findByText("预览服务不可用", { exact: true })).toBeTruthy();
    expect(screen.queryByText("正在读取文件", { exact: true })).toBeNull();
  });

  it("shows a workspace-create envelope, clears pending, and allows retry", async () => {
    let creates = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces": workspaceRoute([workspace], () => {
          creates += 1;
          return creates === 1
            ? envelope(500, "工作空间创建失败")
            : jsonResponse(
                {
                  ...workspace,
                  id: "workspace-created",
                  name: "可重试空间",
                  dir: "retry-space",
                  root: "/sandbox/user-1/retry-space",
                },
                201,
              );
        }),
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
        "/api/workspaces/workspace-created/tree?path=": jsonResponse({ path: "", entries: [] }),
      }),
    );

    await screen.findByRole("button", { name: "选择工作空间" });
    const dialog = await openWorkspaceDialog();
    fireEvent.change(within(dialog).getByLabelText("工作空间名称"), {
      target: { value: "可重试空间" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await expectCreateEnabledAfterAlert(dialog, "工作空间创建失败");
    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: "选择工作空间" })).getByText("可重试空间", {
          exact: true,
        }),
      ).toBeTruthy();
    });
    expect(
      fetchMock.mock.calls.filter(
        ([path, options]) => path === "/api/workspaces" && options?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("shows the stable folder-create fallback, clears pending, and allows retry", async () => {
    let creates = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": () =>
          jsonResponse({
            path: "",
            entries: creates === 0 ? [] : [{ name: "drafts", type: "dir", size: 0, mtime: 1 }],
          }),
        "/api/workspaces/workspace-1/dirs": () => {
          creates += 1;
          return creates === 1
            ? new Error("private transport detail")
            : jsonResponse({ path: "drafts" }, 201);
        },
      }),
    );

    const dialog = await openDirectoryDialog();
    fireEvent.change(within(dialog).getByLabelText("文件夹名称"), { target: { value: "drafts" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await expectCreateEnabledAfterAlert(dialog, fallback);
    expect(await screen.findByRole("button", { name: "展开 drafts" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(
        ([path, options]) =>
          path === "/api/workspaces/workspace-1/dirs" && options?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("hands a current workspace-list 401 to the login form instead of an inline alert", async () => {
    renderFiles(
      "/files?from=list-401#keep",
      authenticatedFilesRoutes([], {
        "/api/workspaces": jsonResponse(
          { error: { code: "unauthorized", message: "登录已失效" } },
          401,
        ),
      }),
    );

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "工作空间" })).toBeNull();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      "/files?from=list-401#keep",
    );
  });
});
