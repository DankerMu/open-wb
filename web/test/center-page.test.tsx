// model-registry「中心页外壳」：`/center` 的 `?tab=` 规则、仅管理员可见的 tab 与空态；`isAdmin`；
// routeManifest 的 `/center` 描述。真表（`CENTER_TABS`：人人可见的「专家」「技能」「连接器」在前、仅管理员可见的
//「模型」「挂载源」在后，s1d-experts-skills 任务 7.2、8.2，s1d-connectors 任务 6.2，s1b-workspace-mounts 任务 13.2）经真实路由（createAppRouter）打开；「无可见 tab → 空态」与注入的表
//（空表、一项、两项）经只含 `/center` 一条的浏览器路由。

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  centerRoutes,
  composerOptionsRoute,
  composerReadRoutes,
  createFetchMock,
  currentLocation,
  expectExpertsTabSettled,
  type FetchMock,
  jsonResponse,
  paths,
  setBrowserPath,
} from "./support.js";
import "./radix-platform.js";

const EMPTY = "中心暂无可用内容";
/** `GET /api/models` 的一项：真表下管理员看到的模型表里的那一行。 */
const SEED_VIEW = {
  id: "deepseek-v4.1-flash",
  name: "深度求索",
  reasoning: true,
  vision: true,
  maxTokens: 32768,
  efforts: null,
  upstream: null,
  isDefault: true,
  probe: { status: "never", at: null, message: null },
  updatedAt: 1_760_000_000_000,
};
const ADMIN = { ...authenticatedPrincipal, account: "lisi", role: "管理员" };
const MEMBER = authenticatedPrincipal;

const ONE_ADMIN_TAB: readonly CenterTab[] = [
  { key: "a", label: "甲", adminOnly: true, Panel: () => <p>甲面板</p> },
];
const TWO_TABS: readonly CenterTab[] = [
  ...ONE_ADMIN_TAB,
  { key: "b", label: "乙", adminOnly: false, Panel: () => <p>乙面板</p> },
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
    "/api/models": () => jsonResponse({ models: [SEED_VIEW] }),
    ...composerOptionsRoute(),
    ...composerReadRoutes(),
    ...centerRoutes(),
  });
}

/** 整个应用（真实路由，缺省 `CENTER_TABS`）。 */
function openApp(path: string, principal: typeof MEMBER): FetchMock {
  const mounted = mountAuthenticatedApp(path, fetchFor(principal));
  dispose = () => mounted.router.dispose();
  return mounted.fetchMock;
}

/** tab 条各项的 `[label, aria-selected]`，按显示次序。 */
function tabStates() {
  const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
  return tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")]);
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

describe("注入空表", () => {
  it.each([
    ["管理员", ADMIN],
    ["普通用户", MEMBER],
  ])(
    "%s打开 /center?tab=models：空态、没有 tab 条、URL 与历史记录不变",
    async (_who, principal) => {
      const before = window.history.length;
      openCenter("/center?tab=models", principal, []);

      expect(await screen.findByText(EMPTY)).toBeTruthy();
      expect(screen.queryByRole("tablist")).toBeNull();
      expect(currentLocation()).toBe("/center?tab=models");
      expect(window.history.length).toBe(before);
    },
  );
});

describe("真表（CENTER_TABS：人人可见的「专家」「技能」「连接器」、仅管理员可见的「模型」「挂载源」）", () => {
  it.each([
    ["/center", "/center?tab=experts"],
    ["/center?tab=nope", "/center?tab=experts"],
  ])(
    "管理员打开 %s：以 replace 变为 %s，tab 条恰为「专家」「技能」「连接器」「模型」「挂载源」且「专家」选中，渲染专家面板",
    async (path, target) => {
      const before = window.history.length;
      const fetchMock = openApp(path, ADMIN);

      await expectExpertsTabSettled(fetchMock);
      await expectLocation(target);
      expect(window.history.length).toBe(before);
      expect(tabStates()).toEqual([
        ["专家", "true"],
        ["技能", "false"],
        ["连接器", "false"],
        ["模型", "false"],
        ["挂载源", "false"],
      ]);
      expect(paths(fetchMock)).not.toContain("/api/models");
      expect(screen.queryByText(EMPTY)).toBeNull();
    },
  );

  it("管理员打开 /center?tab=models：留在原地，「模型」选中，渲染模型表", async () => {
    const before = window.history.length;
    openApp("/center?tab=models", ADMIN);

    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("table")).toBeTruthy();
    expect(currentLocation()).toBe("/center?tab=models");
    expect(window.history.length).toBe(before);
    expect(tabStates()).toEqual([
      ["专家", "false"],
      ["技能", "false"],
      ["连接器", "false"],
      ["模型", "true"],
      ["挂载源", "false"],
    ]);
    expect(within(main).getByRole("cell", { name: SEED_VIEW.name })).toBeTruthy();
  });

  it.each(["/center?tab=models", "/center?tab=mount-sources", "/center"])(
    "普通用户打开 %s：以 replace 变为 /center?tab=experts，tab 条恰为「专家」「技能」「连接器」，不请求模型列表与挂载源",
    async (path) => {
      const before = window.history.length;
      const fetchMock = openApp(path, MEMBER);

      await expectExpertsTabSettled(fetchMock);
      await expectLocation("/center?tab=experts");
      expect(window.history.length).toBe(before);
      expect(tabStates()).toEqual([
        ["专家", "true"],
        ["技能", "false"],
        ["连接器", "false"],
      ]);
      expect(within(screen.getByRole("main")).queryByText(EMPTY)).toBeNull();
      expect(paths(fetchMock)).not.toContain("/api/models");
      expect(paths(fetchMock)).not.toContain("/api/mount-sources");
    },
  );

  it("普通用户打开 /center?tab=skills：留在原地，「技能」选中，技能面板按缺省应答稳定，只挂载当前 tab 的面板", async () => {
    const before = window.history.length;
    const fetchMock = openApp("/center?tab=skills", MEMBER);

    const main = await screen.findByRole("main");
    expect(await within(main).findByText("尚未安装平台技能")).toBeTruthy();
    expect(currentLocation()).toBe("/center?tab=skills");
    expect(window.history.length).toBe(before);
    expect(tabStates()).toEqual([
      ["专家", "false"],
      ["技能", "true"],
      ["连接器", "false"],
    ]);
    expect(within(main).queryByRole("alert")).toBeNull();
    expect(paths(fetchMock).filter((path) => path === "/api/skills")).toHaveLength(1);
    expect(paths(fetchMock)).not.toContain("/api/experts");
    expect(paths(fetchMock)).not.toContain("/api/models");
  });

  // 缺省面板取会话 principal：管理界面的显隐按 `isAdmin(principal)`，空表下两种身份的应答形状相同。
  it.each([
    ["普通用户", MEMBER, false],
    ["管理员", ADMIN, true],
  ])(
    "%s打开 /center?tab=connectors：「连接器」选中，空态；只有管理员见「新增连接器」",
    async (_who, principal, admin) => {
      const fetchMock = openApp("/center?tab=connectors", principal);

      const main = await screen.findByRole("main");
      expect(await within(main).findByText("尚未接入内网连接器")).toBeTruthy();
      expect(currentLocation()).toBe("/center?tab=connectors");
      expect(within(main).getByRole("tab", { name: "连接器" }).getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(within(main).queryByRole("button", { name: "新增连接器" }) !== null).toBe(admin);
      expect(within(main).queryByRole("alert")).toBeNull();
      expect(paths(fetchMock).filter((path) => path.startsWith("/api/connectors"))).toEqual([
        "/api/connectors",
        "/api/connectors/defaults",
      ]);
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
    // #1706：拷入层的 data-active: / data-horizontal: 绑定到的正是 Radix 输出的这两个属性。
    expect(tabs[0]?.getAttribute("data-state")).toBe("active");
    const root = screen.getByRole("tablist").closest('[data-slot="tabs"]');
    expect(root?.getAttribute("data-orientation")).toBe("horizontal");
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

describe("注入两项表（a 仅管理员、b 人人可见）", () => {
  it("普通用户打开 ?tab=a：以 replace 变为 ?tab=b，历史条数不变，只渲染 b 的面板", async () => {
    const before = window.history.length;
    openCenter("/center?tab=a", MEMBER, TWO_TABS);

    expect(await screen.findByText("乙面板")).toBeTruthy();
    await expectLocation("/center?tab=b");
    expect(window.history.length).toBe(before);
    expect(screen.queryByText("甲面板")).toBeNull();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["乙"]);
  });

  it("管理员点 tab「乙」：URL 为 ?tab=b，历史条数 +1（push）", async () => {
    openCenter("/center?tab=a", ADMIN, TWO_TABS);
    expect(await screen.findByText("甲面板")).toBeTruthy();
    const before = window.history.length;

    const second = within(screen.getByRole("tablist")).getByRole("tab", { name: "乙" });
    fireEvent.mouseDown(second, { button: 0 });
    fireEvent.click(second);

    expect(await screen.findByText("乙面板")).toBeTruthy();
    await expectLocation("/center?tab=b");
    expect(window.history.length).toBe(before + 1);
    expect(second.getAttribute("aria-selected")).toBe("true");
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
  it("/center 的描述以顿号连接人人可见的 tab、末两项之间用「与」：真表下为「专家、技能与连接器」", () => {
    expect(routeManifest.find(({ path }) => path === "/center")).toMatchObject({
      description: "专家、技能与连接器",
    });
  });
});
