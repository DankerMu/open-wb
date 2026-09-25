// settings-footer 与 settings-page 两个测试文件共用的渲染、外壳断言与清理 helper。
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RouterProvider } from "react-router";
import { expect, vi } from "vitest";
import { createAppRouter } from "../src/routes/index.js";
import {
  createFetchMock,
  currentLocation,
  jsonResponse,
  authenticatedPrincipal as principal,
  serviceInfo,
  setBrowserPath,
} from "./support.js";

export function authenticatedRoutes(routes: Parameters<typeof createFetchMock>[0]) {
  return {
    "/api/auth/me": jsonResponse(principal),
    "/api/workspaces": jsonResponse({ workspaces: [] }),
    "/api/sessions": jsonResponse({ sessions: [] }),
    ...routes,
  };
}

export function createAuthenticatedFetch(
  infoResponse: Error | Response | Promise<Response> = jsonResponse(serviceInfo),
) {
  return createFetchMock(authenticatedRoutes({ "/api/info": infoResponse }));
}

let router: ReturnType<typeof createAppRouter> | undefined;

export function renderApp(path: string) {
  setBrowserPath(path);
  router = createAppRouter();
  return render(<RouterProvider router={router} />);
}

/** 当前挂载的 router（供用例 `navigate`）。 */
export function currentRouter() {
  return router;
}

export function disposeRouter() {
  router?.dispose();
  router = undefined;
}

export async function expectAuthenticatedShell(path: string) {
  const title =
    path === "/"
      ? "WorkBuddy，我帮你"
      : path === "/files"
        ? "工作空间"
        : path === "/center"
          ? "中心"
          : "设置";
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  const sidebar = screen.getByRole("complementary", { name: "侧栏" });
  expect(within(sidebar).getByText(principal.account, { exact: true })).toBeTruthy();
  expect(within(sidebar).getByText(principal.role, { exact: true })).toBeTruthy();
  expect(within(sidebar).getByRole("button", { name: "用户菜单" })).toBeTruthy();
}

export async function expectLoginAt(path: string) {
  expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
  expect(currentLocation()).toBe(path);
}

export function getFooter() {
  return screen.getByRole("complementary", { name: "侧栏", hidden: true });
}

export async function openLogoutDialog() {
  fireEvent.pointerDown(within(getFooter()).getByRole("button", { name: "用户菜单" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("menuitem", { name: "退出登录" }));
  return screen.getByRole("alertdialog");
}

/** 两个文件 afterEach 的统一清理：卸载、释放 router、还原 mock/全局、清主题与地址。 */
export function resetSettingsTestState() {
  cleanup();
  disposeRouter();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
  setBrowserPath("/");
}
