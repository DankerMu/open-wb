import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import "./radix-platform.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import { createFetchMock, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const principal = { id: "user-1", account: "zhangsan", role: "member" };
export const workspace = {
  id: "workspace-1",
  name: "设计文档",
  dir: "design-docs",
  root: "/sandbox/user-1/design-docs",
  createdAt: 1_726_000_000_000,
};
export const secondWorkspace = {
  ...workspace,
  id: "workspace-2",
  name: "数据分析",
  dir: "data-analysis",
  root: "/sandbox/user-1/data-analysis",
};

export type FetchRoutes = Parameters<typeof createFetchMock>[0];
export type WorkspaceCreateRoute = (options?: RequestInit) => Error | Promise<Response> | Response;
export type WorkspaceFixture = typeof workspace;

let disposeRouter: (() => void) | undefined;
let restoreBlobUrls: (() => void) | undefined;

export function workspaceRoute(
  workspaces: readonly WorkspaceFixture[],
  onCreate?: WorkspaceCreateRoute,
) {
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

export function authenticatedFilesRoutes(
  workspaces: readonly WorkspaceFixture[],
  routes: FetchRoutes = {},
): FetchRoutes {
  return {
    "/api/auth/me": () => jsonResponse(principal),
    "/api/workspaces": workspaceRoute(workspaces),
    ...routes,
  };
}

export function imagePreviewResponse(size = 8) {
  return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
    headers: {
      "Content-Type": "image/png",
      "X-Workbuddy-Size": String(size),
    },
  });
}

export function renderFiles(path: string, routes: FetchRoutes, strict = false) {
  disposeRouter?.();
  const fetchMock = createFetchMock(routes);
  const mounted = mountAuthenticatedApp(path, fetchMock, strict);
  disposeRouter = () => mounted.router.dispose();
  return mounted;
}

export async function expectLocation(expected: string) {
  await waitFor(() => {
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      expected,
    );
  });
}

export async function openWorkspaceDialog() {
  fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
  fireEvent.click(screen.getByRole("button", { name: "＋ 新建工作空间" }));
  return screen.findByRole("dialog", { name: "新建工作空间" });
}

/**
 * 经 `＋` 菜单选一项：Radix DropdownMenu 在 pointerdown 打开（click 不打开）。先让出一个宏任务：
 * 上一个覆盖层卸载时的焦点归还在 setTimeout(0) 里跑，若落在已打开的菜单之外会把它关掉。
 */
export async function chooseCreationMenuItem(item: "新建文件夹" | "新建工作空间") {
  await yieldMacrotask();
  pressPointer(screen.getByRole("button", { name: "新建" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

export async function openWorkspaceDialogFromMenu() {
  await chooseCreationMenuItem("新建工作空间");
  return screen.findByRole("dialog", { name: "新建工作空间" });
}
export async function openDirectoryDialog() {
  await waitFor(() => {
    const button = screen.getByRole("button", { name: "折叠 root" });
    const item = button.closest("li");
    if (!item?.querySelector(":scope > ul")) {
      throw new Error("expected the initial root listing to be present");
    }
  });
  await chooseCreationMenuItem("新建文件夹");
  return screen.findByRole("dialog", { name: "新建文件夹" });
}

function treeRequestCount(fetchMock: ReturnType<typeof renderFiles>["fetchMock"], path: string) {
  return fetchMock.mock.calls.filter(([requestPath]) => requestPath === path).length;
}

export async function expectTreeRequestCount(
  fetchMock: ReturnType<typeof renderFiles>["fetchMock"],
  path: string,
  count: number,
) {
  await waitFor(() => {
    expect(treeRequestCount(fetchMock, path)).toBe(count);
  });
}

export async function collapseAndExpand(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `折叠 ${name}` }));
  fireEvent.click(screen.getByRole("button", { name: `展开 ${name}` }));
}

export async function selectWorkspaceByName(name: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: "选择工作空间" }));
  fireEvent.click(screen.getByRole("button", { name }));
}

export async function expectCreateEnabledAfterAlert(dialog: HTMLElement, message: string) {
  expect((await within(dialog).findByRole("alert")).textContent).toBe(message);
  expect((within(dialog).getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
}

export function stubBlobUrls(urls: string[]) {
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

export function cleanupFilesFixture() {
  restoreBlobUrls?.();
  restoreBlobUrls = undefined;
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
}
