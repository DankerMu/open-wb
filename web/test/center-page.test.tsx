// model-registry「中心页外壳」：`/center` 的 `?tab=` 规则、仅管理员可见的 tab 与空态；`isAdmin`；
// routeManifest 的 `/center` 描述。空表经真实路由（createAppRouter）打开，注入表经只含 `/center` 一条的浏览器路由。

import { cleanup, render, screen, within } from "@testing-library/react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider } from "../src/features/auth/index.js";
import { CenterPage } from "../src/features/center/index.js";
import type { CenterTab } from "../src/features/center/tabs.js";
import { isAdmin } from "../src/lib/roles.js";
import { routeManifest } from "../src/routes/manifest.js";
import { expectLocation } from "./files-fixture.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  composerOptionsRoute,
  createFetchMock,
  currentLocation,
  jsonResponse,
  setBrowserPath,
} from "./support.js";
import "./radix-platform.js";

const EMPTY = "中心暂无可用内容";
const ADMIN = { ...authenticatedPrincipal, account: "lisi", role: "管理员" };
const MEMBER = authenticatedPrincipal;

const ONE_ADMIN_TAB: readonly CenterTab[] = [
  { key: "a", label: "甲", adminOnly: true, Panel: () => <p>甲面板</p> },
];

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBrowserPath("/");
});

function fetchFor(principal: typeof MEMBER) {
  return createFetchMock({
    "/api/auth/me": () => jsonResponse(principal),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    ...composerOptionsRoute(),
  });
}

/** 整个应用（真实路由，缺省 `CENTER_TABS`）。 */
function openApp(path: string, principal: typeof MEMBER) {
  const mounted = mountAuthenticatedApp(path, fetchFor(principal));
  dispose = () => mounted.router.dispose();
}

/** 只含 `/center` 的浏览器路由：真实 `window.history`，注入 tab 表。 */
function openCenter(path: string, principal: typeof MEMBER, tabs: readonly CenterTab[]) {
  setBrowserPath(path);
  vi.stubGlobal("fetch", fetchFor(principal));
  const router = createBrowserRouter([
    {
      path: "/center",
      element: (
        <AuthProvider>
          <AuthGuard>
            <CenterPage tabs={tabs} />
          </AuthGuard>
        </AuthProvider>
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  dispose = () => router.dispose();
}

describe("空表（CENTER_TABS）", () => {
  it.each([
    ["管理员", ADMIN],
    ["普通用户", MEMBER],
  ])(
    "%s打开 /center?tab=models：空态、没有 tab 条、URL 与历史记录不变",
    async (_who, principal) => {
      const before = window.history.length;
      openApp("/center?tab=models", principal);

      const main = await screen.findByRole("main");
      expect(await within(main).findByText(EMPTY)).toBeTruthy();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(currentLocation()).toBe("/center?tab=models");
      expect(window.history.length).toBe(before);
    },
  );
});

describe("注入一张仅管理员可见的表", () => {
  it("管理员打开裸 /center：以 replace 变为 /center?tab=a，tab 条恰一项「甲」且选中，渲染甲面板", async () => {
    const before = window.history.length;
    openCenter("/center", ADMIN, ONE_ADMIN_TAB);

    expect(await screen.findByText("甲面板")).toBeTruthy();
    await expectLocation("/center?tab=a");
    expect(window.history.length).toBe(before);
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["甲"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("管理员打开 /center?tab=unknown&from=x#h：只改 tab，其它参数与 hash 保留，历史记录不变", async () => {
    const before = window.history.length;
    openCenter("/center?tab=unknown&from=x#h", ADMIN, ONE_ADMIN_TAB);

    expect(await screen.findByText("甲面板")).toBeTruthy();
    await expectLocation("/center?tab=a&from=x#h");
    expect(window.history.length).toBe(before);
  });

  it("普通用户打开 /center?tab=a：空态、没有 tablist、URL 保持不变", async () => {
    const before = window.history.length;
    openCenter("/center?tab=a", MEMBER, ONE_ADMIN_TAB);

    expect(await screen.findByText(EMPTY)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("甲面板")).toBeNull();
    expect(currentLocation()).toBe("/center?tab=a");
    expect(window.history.length).toBe(before);
  });
});

describe("isAdmin", () => {
  it("只对角色恰为「管理员」为真", () => {
    expect(isAdmin({ role: "管理员" })).toBe(true);
    expect(isAdmin({ role: "admin" })).toBe(false);
    expect(isAdmin({ role: "member" })).toBe(false);
  });
});

describe("routeManifest", () => {
  it("/center 的描述与空表一致：中心暂无可用内容", () => {
    expect(routeManifest.find(({ path }) => path === "/center")).toMatchObject({
      description: EMPTY,
    });
  });
});
