import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/routes/index.js";
import { createFetchMock, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const principal = { id: "user-1", account: "zhangsan", role: "member" };
const workspace = {
  id: "workspace-1",
  name: "设计文档",
  dir: "design-docs",
  root: "/sandbox/user-1/design-docs",
  createdAt: 1_726_000_000_000,
};
const secondWorkspace = {
  ...workspace,
  id: "workspace-2",
  name: "数据分析",
  dir: "data-analysis",
  root: "/sandbox/user-1/data-analysis",
};

type FetchRoutes = Parameters<typeof createFetchMock>[0];
type WorkspaceCreateRoute = (options?: RequestInit) => Error | Promise<Response> | Response;
type WorkspaceFixture = typeof workspace;

let disposeRouter: (() => void) | undefined;
let restoreBlobUrls: (() => void) | undefined;

function workspaceRoute(workspaces: readonly WorkspaceFixture[], onCreate?: WorkspaceCreateRoute) {
  return (_path: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      if (!onCreate) {
        throw new Error("unexpected workspace creation");
      }

      return onCreate(options);
    }

    return jsonResponse({ workspaces });
  };
}

function authenticatedFilesRoutes(
  workspaces: readonly WorkspaceFixture[],
  routes: FetchRoutes = {},
): FetchRoutes {
  return {
    "/api/auth/me": () => jsonResponse(principal),
    "/api/workspaces": workspaceRoute(workspaces),
    ...routes,
  };
}

function imagePreviewResponse(size = 8) {
  return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
    headers: {
      "Content-Type": "image/png",
      "X-Workbuddy-Size": String(size),
    },
  });
}

function renderFiles(path: string, routes: FetchRoutes, strict = false) {
  disposeRouter?.();
  window.history.replaceState(null, "", path);
  const fetchMock = createFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  const appRouter = createAppRouter();
  disposeRouter = () => appRouter.dispose();
  const application = <RouterProvider router={appRouter} />;
  const view = render(strict ? <StrictMode>{application}</StrictMode> : application);
  return { fetchMock, view };
}

async function expectLocation(expected: string) {
  await waitFor(() => {
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      expected,
    );
  });
}

async function openWorkspaceDialog() {
  fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新建工作空间" }));
  return screen.findByRole("dialog", { name: "新建工作空间" });
}

async function openDirectoryDialog() {
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "新建文件夹" }));
  return screen.findByRole("dialog", { name: "新建文件夹" });
}

function stubBlobUrls(urls: string[]) {
  const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const createObjectURL = vi.fn(() => urls.shift() ?? "blob:unexpected");
  const revokeObjectURL = vi.fn();
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: createObjectURL },
    revokeObjectURL: { configurable: true, value: revokeObjectURL },
  });
  restoreBlobUrls = () => {
    if (createDescriptor) {
      Object.defineProperty(URL, "createObjectURL", createDescriptor);
    } else {
      Reflect.deleteProperty(URL, "createObjectURL");
    }
    if (revokeDescriptor) {
      Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
    } else {
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  };
  return { createObjectURL, revokeObjectURL };
}

afterEach(() => {
  restoreBlobUrls?.();
  restoreBlobUrls = undefined;
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("workspace page route integration", () => {
  it("loads the authenticated account workspace, reconciles its URL, and starts the root tree", async () => {
    const { fetchMock } = renderFiles(
      "/files?from=tracer#preview",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
      }),
    );

    expect(await screen.findByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "选择工作空间" })).toBeTruthy();
    expect(screen.getByText("设计文档", { exact: true })).toBeTruthy();
    expect(screen.getByText(workspace.root, { exact: true })).toBeTruthy();
    expect(screen.getByText("工作空间目录", { exact: true })).toBeTruthy();

    await expectLocation("/files?from=tracer&ws=workspace-1#preview");
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/workspace-1/tree?path=", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("browses cached directories, previews supported files, and creates a directory", async () => {
    const secondReadme = deferredResponse();
    const blobUrls = stubBlobUrls(["blob:logo"]);
    const rootEntries = [
      { name: "out", type: "dir", size: 0, mtime: 101 },
      { name: "in", type: "dir", size: 0, mtime: 101.5 },
      { name: "readme.md", type: "file", size: 8, mtime: 102 },
      { name: "notes.csv", type: "file", size: 24, mtime: 103 },
      { name: "logo.png", type: "file", size: 8, mtime: 104 },
      { name: "archive.zip", type: "file", size: 2, mtime: 105 },
    ] as const;
    const rootAfterCreate = [
      ...rootEntries,
      { name: "drafts", type: "dir" as const, size: 0, mtime: 106 },
    ];
    let rootReads = 0;
    let readmeReads = 0;
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": () => {
          rootReads += 1;
          return jsonResponse({
            path: "",
            entries: rootReads === 1 ? rootEntries : rootAfterCreate,
          });
        },
        "/api/workspaces/workspace-1/tree?path=out": jsonResponse({ path: "out", entries: [] }),
        "/api/workspaces/workspace-1/file?path=readme.md": () => {
          readmeReads += 1;
          return readmeReads === 1 ? textPreviewResponse("# 第一份") : secondReadme.promise;
        },
        "/api/workspaces/workspace-1/file?path=notes.csv": textPreviewResponse(
          "name,size\nalpha,1\nbeta,2\n",
        ),
        "/api/workspaces/workspace-1/file?path=logo.png": imagePreviewResponse(),
        "/api/workspaces/workspace-1/dirs": (_path, options) => {
          expect(options).toMatchObject({ body: '{"path":"drafts"}', method: "POST" });
          return jsonResponse({ path: "drafts" }, 201);
        },
      }),
    );

    await screen.findByRole("button", { name: "展开 out" });
    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    await screen.findByRole("button", { name: "折叠 out" });
    fireEvent.click(screen.getByRole("button", { name: "折叠 out" }));
    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(
          ([path]) => path === "/api/workspaces/workspace-1/tree?path=out",
        ),
      ).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "readme.md" }));
    const markdownSourceButton = await screen.findByRole("button", { name: "查看源码" });
    expect(screen.getAllByRole("heading", { level: 1, name: "工作空间" })).toHaveLength(1);
    expect(
      within(screen.getByRole("region", { name: "文件预览" })).getByRole("heading", {
        level: 1,
        name: "第一份",
      }),
    ).toBeTruthy();
    fireEvent.click(markdownSourceButton);
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "readme.md" }));
    expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    expect(screen.getByText("正在读取文件", { exact: true })).toBeTruthy();
    await act(async () => {
      secondReadme.resolve(textPreviewResponse("# 刷新后"));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "渲染视图" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "notes.csv" }));
    expect(await screen.findByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(screen.getByText("共 2 行 · 大文件仅预览前若干行", { exact: true })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "logo.png" }));
    expect(await screen.findByRole("img", { name: "logo.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "archive.zip" }));
    expect(await screen.findByText("该类型不支持预览", { exact: true })).toBeTruthy();
    expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:logo");
    expect(
      fetchMock.mock.calls.filter(
        ([path]) => path === "/api/workspaces/workspace-1/file?path=archive.zip",
      ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(2);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "新建文件夹" }));
    const directoryDialog = await screen.findByRole("dialog", { name: "新建文件夹" });
    expect(
      within(directoryDialog)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["根目录　root", "out"]);
    fireEvent.change(within(directoryDialog).getByLabelText("文件夹名称"), {
      target: { value: "drafts" },
    });
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByRole("button", { name: "展开 drafts" })).toBeTruthy();
  });

  it("removes an empty workspace target and rejects invalid targets before their tree is requested", async () => {
    const empty = renderFiles("/files?ws=unknown&keep=1#section", authenticatedFilesRoutes([]));

    expect(await screen.findByText("未选择工作空间", { exact: true })).toBeTruthy();
    expect(screen.getByText("该工作空间暂无目录", { exact: true })).toBeTruthy();
    expect(
      screen.getByText("点击左上角 ＋ 新建文件夹，或挂载本服务器/外部服务器目录", { exact: true }),
    ).toBeTruthy();
    await expectLocation("/files?keep=1#section");
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "新建文件夹" }));
    expect((await screen.findByRole("alert")).textContent).toBe("当前工作空间没有可写目录");
    empty.view.unmount();

    const invalid = renderFiles(
      "/files?ws=other-account&tab=files#keep",
      authenticatedFilesRoutes([workspace, secondWorkspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
      }),
    );

    await screen.findByRole("button", { name: "选择工作空间" });
    await expectLocation("/files?ws=workspace-1&tab=files#keep");
    fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
    const switcher = screen.getByRole("dialog", { name: "工作空间切换器" });
    expect(within(switcher).getByLabelText("当前工作空间")).toBeTruthy();
    fireEvent.change(within(switcher).getByLabelText("搜索工作空间"), {
      target: { value: "数据" },
    });
    expect(within(switcher).getByRole("button", { name: /数据分析/ })).toBeTruthy();
    expect(within(switcher).queryByRole("button", { name: /设计文档/ })).toBeNull();
    fireEvent.keyDown(switcher, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "工作空间切换器" })).toBeNull();
    expect(invalid.fetchMock.mock.calls.map(([path]) => path)).not.toContain(
      "/api/workspaces/other-account/tree?path=",
    );
    expect(invalid.fetchMock.mock.calls.map(([path]) => path)).not.toContain(
      "/api/workspaces/other-account/file?path=readme.md",
    );
  });

  it("validates both creation dialogs locally and maps their server conflicts", async () => {
    const createdWorkspace = {
      ...secondWorkspace,
      name: "新空间",
      dir: "new-workspace",
      root: "/sandbox/user-1/new-workspace",
    };
    const createWorkspace: WorkspaceCreateRoute = (options) => {
      if (options?.body === '{"name":"重复"}') {
        return jsonResponse({ error: { code: "conflict", message: "ignored" } }, 409);
      }

      expect(options).toMatchObject({ body: '{"name":"新空间"}', method: "POST" });
      return jsonResponse(createdWorkspace, 201);
    };
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces": workspaceRoute([workspace], createWorkspace),
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
        "/api/workspaces/workspace-2/tree?path=": jsonResponse({ path: "", entries: [] }),
        "/api/workspaces/workspace-1/dirs": jsonResponse(
          { error: { code: "conflict", message: "ignored" } },
          409,
        ),
      }),
    );

    await screen.findByRole("button", { name: "选择工作空间" });
    const workspaceDialog = await openWorkspaceDialog();
    fireEvent.click(within(workspaceDialog).getByRole("button", { name: "创建" }));
    expect((await within(workspaceDialog).findByRole("alert")).textContent).toBe("请输入名称");
    expect(
      fetchMock.mock.calls.filter(
        ([, options]) => (options as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(0);
    fireEvent.change(within(workspaceDialog).getByLabelText("工作空间名称"), {
      target: { value: "重复" },
    });
    fireEvent.click(within(workspaceDialog).getByRole("button", { name: "创建" }));
    expect((await within(workspaceDialog).findByRole("alert")).textContent).toBe(
      "同名工作空间已存在",
    );
    expect(
      fetchMock.mock.calls.filter(
        ([, options]) => (options as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
    fireEvent.click(within(workspaceDialog).getByRole("button", { name: "取消" }));

    const directoryDialog = await openDirectoryDialog();
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "创建" }));
    expect((await within(directoryDialog).findByRole("alert")).textContent).toBe(
      "请填写文件夹名称",
    );
    fireEvent.change(within(directoryDialog).getByLabelText("文件夹名称"), {
      target: { value: "bad/name" },
    });
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "创建" }));
    expect((await within(directoryDialog).findByRole("alert")).textContent).toBe(
      "名称不能包含路径分隔符",
    );
    expect(
      fetchMock.mock.calls.filter(
        ([, options]) => (options as RequestInit | undefined)?.method === "POST",
      ),
    ).toHaveLength(1);
    fireEvent.change(within(directoryDialog).getByLabelText("文件夹名称"), {
      target: { value: "重复" },
    });
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "创建" }));
    expect((await within(directoryDialog).findByRole("alert")).textContent).toBe(
      "该目录下已存在同名条目",
    );
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "取消" }));
    const newWorkspaceDialog = await openWorkspaceDialog();
    fireEvent.change(within(newWorkspaceDialog).getByLabelText("工作空间名称"), {
      target: { value: "新空间" },
    });
    fireEvent.click(within(newWorkspaceDialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(`${window.location.pathname}${window.location.search}`).toBe("/files?ws=workspace-2");
    });
    expect(screen.getByText("新空间", { exact: true })).toBeTruthy();
  });

  it("does not let a late workspace creation close or select a newer dialog", async () => {
    const lateWorkspace = deferredResponse();
    const createdWorkspace = {
      ...workspace,
      id: "workspace-late",
      name: "迟到空间",
      dir: "late-workspace",
      root: "/sandbox/user-1/late-workspace",
    };
    renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces": workspaceRoute([workspace], () => lateWorkspace.promise),
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({ path: "", entries: [] }),
      }),
    );

    await screen.findByRole("button", { name: "选择工作空间" });
    const firstDialog = await openWorkspaceDialog();
    fireEvent.change(within(firstDialog).getByLabelText("工作空间名称"), {
      target: { value: "迟到空间" },
    });
    fireEvent.click(within(firstDialog).getByRole("button", { name: "创建" }));
    fireEvent.click(within(firstDialog).getByRole("button", { name: "取消" }));

    const newerDialog = await openWorkspaceDialog();
    await act(async () => {
      lateWorkspace.resolve(jsonResponse(createdWorkspace, 201));
    });

    expect(screen.getByRole("dialog", { name: "新建工作空间" })).toBe(newerDialog);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/files?ws=workspace-1");
    expect(screen.queryByText("迟到空间", { exact: true })).toBeNull();
  });

  it("discards late tree, preview, and directory results after switching workspaces under StrictMode", async () => {
    const lateDirectory = deferredResponse();
    const lateImage = deferredResponse();
    const lateTree = deferredResponse();
    const blobUrls = stubBlobUrls(["blob:late-image"]);
    const { fetchMock } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace, secondWorkspace], {
        "/api/workspaces/workspace-1/tree?path=": () =>
          jsonResponse({
            path: "",
            entries: [
              { name: "out", type: "dir", size: 0, mtime: 1 },
              { name: "logo.png", type: "file", size: 8, mtime: 2 },
            ],
          }),
        "/api/workspaces/workspace-1/tree?path=out": () => lateTree.promise,
        "/api/workspaces/workspace-1/file?path=logo.png": () => lateImage.promise,
        "/api/workspaces/workspace-1/dirs": () => lateDirectory.promise,
        "/api/workspaces/workspace-2/tree?path=": () => jsonResponse({ path: "", entries: [] }),
      }),
      true,
    );

    await screen.findByRole("button", { name: "展开 out" });
    fireEvent.click(screen.getByRole("button", { name: "展开 out" }));
    fireEvent.click(screen.getByRole("button", { name: "logo.png" }));
    const directoryDialog = await openDirectoryDialog();
    fireEvent.change(within(directoryDialog).getByLabelText("文件夹名称"), {
      target: { value: "late-dir" },
    });
    fireEvent.click(within(directoryDialog).getByRole("button", { name: "创建" }));

    fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
    fireEvent.click(screen.getByRole("button", { name: /数据分析/ }));
    await screen.findByText(secondWorkspace.root, { exact: true });
    await act(async () => {
      lateTree.resolve(
        jsonResponse({
          path: "out",
          entries: [{ name: "late-secret.txt", type: "file", size: 1, mtime: 3 }],
        }),
      );
      lateImage.resolve(imagePreviewResponse());
      lateDirectory.resolve(jsonResponse({ path: "late-dir" }, 201));
    });
    await waitFor(() => {
      expect(blobUrls.createObjectURL).toHaveBeenCalledTimes(1);
      expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:late-image");
    });
    expect(screen.queryByText("late-secret.txt", { exact: true })).toBeNull();
    expect(screen.queryByText("late-dir", { exact: true })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/workspaces/workspace-2/tree?path="),
    ).not.toHaveLength(0);
  });

  it("releases a displayed image when replaced and when the page unmounts", async () => {
    const blobUrls = stubBlobUrls(["blob:first", "blob:second"]);
    const { view } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace], {
        "/api/workspaces/workspace-1/tree?path=": jsonResponse({
          path: "",
          entries: [
            { name: "first.png", type: "file", size: 8, mtime: 1 },
            { name: "second.png", type: "file", size: 8, mtime: 2 },
          ],
        }),
        "/api/workspaces/workspace-1/file?path=first.png": imagePreviewResponse(),
        "/api/workspaces/workspace-1/file?path=second.png": imagePreviewResponse(),
      }),
    );

    await screen.findByRole("button", { name: "first.png" });
    fireEvent.click(screen.getByRole("button", { name: "first.png" }));
    await screen.findByRole("img", { name: "first.png" });
    fireEvent.click(screen.getByRole("button", { name: "second.png" }));
    await screen.findByRole("img", { name: "second.png" });
    expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:first");
    view.unmount();
    expect(blobUrls.revokeObjectURL).toHaveBeenCalledWith("blob:second");
  });
});
