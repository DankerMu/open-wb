import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  expectTreeRequestCount,
  imagePreviewResponse,
  openDirectoryDialog,
  openWorkspaceDialog,
  openWorkspaceDialogFromMenu,
  renderFiles,
  stubBlobUrls,
  workspace,
  workspaceRoute,
} from "./files-fixture.js";
import { deferredResponse, jsonResponse } from "./support.js";

afterEach(() => {
  cleanupFilesFixture();
});

function postBodies(fetchMock: ReturnType<typeof renderFiles>["fetchMock"], path: string) {
  return fetchMock.mock.calls
    .filter(([requestPath, options]) => requestPath === path && options?.method === "POST")
    .map(([, options]) => options?.body);
}

async function submitNamedWorkspace(dialog: HTMLElement, name: string) {
  fireEvent.change(within(dialog).getByLabelText("工作空间名称"), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
}

async function submitNamedDirectory(dialog: HTMLElement, name: string) {
  fireEvent.change(within(dialog).getByLabelText("文件夹名称"), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
}

describe("workspace page concurrency", () => {
  it.each([
    ["the switcher", "选择工作空间", openWorkspaceDialog, "第一空间", "第二空间"],
    ["the plus menu", "新建", openWorkspaceDialogFromMenu, "菜单第一", "菜单第二"],
  ] as const)(
    "issues a second workspace POST after reopening from %s while the first create is pending",
    async (_label, readyName, openDialog, firstName, secondName) => {
      const firstCreate = deferredResponse();
      const secondCreate = deferredResponse();
      let creates = 0;
      const { fetchMock } = renderFiles(
        "/files?ws=workspace-1",
        authenticatedFilesRoutes([workspace], {
          "/api/workspaces": workspaceRoute([workspace], () => {
            creates += 1;
            return creates === 1 ? firstCreate.promise : secondCreate.promise;
          }),
          "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
        }),
      );

      await screen.findByRole("button", { name: readyName });
      await submitNamedWorkspace(await openDialog(), firstName);
      await submitNamedWorkspace(await openDialog(), secondName);
      await waitFor(() => {
        expect(postBodies(fetchMock, "/api/workspaces")).toEqual([
          JSON.stringify({ name: firstName }),
          JSON.stringify({ name: secondName }),
        ]);
      });
    },
  );

  it("issues a second folder POST after reopening the dialog while the first create is pending", async () => {
    const firstCreate = deferredResponse();
    const secondCreate = deferredResponse();
    let creates = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
        "/api/workspaces/workspace-1/dirs": () => {
          creates += 1;
          return creates === 1 ? firstCreate.promise : secondCreate.promise;
        },
      }),
    );

    await screen.findByRole("button", { name: "新建" });
    await submitNamedDirectory(await openDirectoryDialog(), "alpha");
    await submitNamedDirectory(await openDirectoryDialog(), "beta");
    await waitFor(() => {
      expect(postBodies(fetchMock, "/api/workspaces/workspace-1/dirs")).toEqual([
        '{"path":"alpha"}',
        '{"path":"beta"}',
      ]);
    });
  });

  it("keeps the later created folder after an older parent refresh resolves without it", async () => {
    const firstRefresh = deferredResponse();
    const secondRefresh = deferredResponse();
    let creates = 0;
    let rootReads = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": () => {
          rootReads += 1;
          if (rootReads === 1) {
            return jsonResponse({ path: "", entries: [] });
          }
          return rootReads === 2 ? firstRefresh.promise : secondRefresh.promise;
        },
        "/api/workspaces/workspace-1/dirs": () => {
          creates += 1;
          return jsonResponse({ path: creates === 1 ? "alpha" : "beta" }, 201);
        },
      }),
    );

    await screen.findByRole("button", { name: "新建" });
    await submitNamedDirectory(await openDirectoryDialog(), "alpha");
    await expectTreeRequestCount(fetchMock, "/api/workspaces/workspace-1/tree?path=", 2);
    await submitNamedDirectory(await openDirectoryDialog(), "beta");
    await expectTreeRequestCount(fetchMock, "/api/workspaces/workspace-1/tree?path=", 3);
    await act(async () => {
      firstRefresh.resolve(
        jsonResponse({
          path: "",
          entries: [{ name: "alpha", type: "dir", size: 0, mtime: 1 }],
        }),
      );
    });
    expect(screen.queryByRole("button", { name: "展开 beta" })).toBeNull();
    await act(async () => {
      secondRefresh.resolve(
        jsonResponse({
          path: "",
          entries: [
            { name: "alpha", type: "dir", size: 0, mtime: 1 },
            { name: "beta", type: "dir", size: 0, mtime: 2 },
          ],
        }),
      );
    });
    expect(await screen.findByRole("button", { name: "展开 beta" })).toBeTruthy();
    expect(screen.queryByText("正在读取目录", { exact: true })).toBeNull();
  });

  it("discards a late same-workspace image preview after another file is selected", async () => {
    const lateFirst = deferredResponse();
    const blobUrls = stubBlobUrls(["blob:a", "blob:b"]);
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({
          path: "",
          entries: [
            { name: "a.png", type: "file", size: 8, mtime: 1 },
            { name: "b.png", type: "file", size: 8, mtime: 2 },
          ],
        }),
        "/api/workspaces/workspace-1/file?path=a.png": () => lateFirst.promise,
        "/api/workspaces/workspace-1/file?path=b.png": imagePreviewResponse(),
      }),
    );

    await screen.findByRole("button", { name: "a.png" });
    fireEvent.click(screen.getByRole("button", { name: "a.png" }));
    expect(await screen.findByText("正在读取文件", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "b.png" }));
    const displayed = await screen.findByRole("img", { name: "b.png" });
    expect(displayed.getAttribute("src")).toBe("blob:a");
    await act(async () => {
      lateFirst.resolve(imagePreviewResponse());
    });
    await waitFor(() => {
      expect(blobUrls.createObjectURL).toHaveBeenCalledTimes(2);
      expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:b");
    });
    expect(screen.getByRole("img", { name: "b.png" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "b.png" }).getAttribute("src")).toBe("blob:a");
    expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();
  });
});
