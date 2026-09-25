import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ownsHistory } from "../src/features/chat/ownership.js";
import { selectedSessionTitle } from "../src/features/chat/session-path.js";
import { chatStateFromSnapshot } from "../src/features/chat/stream.js";
import type { ChatHistoryState } from "../src/features/chat/types.js";
import { createApiClient } from "../src/lib/api.js";
import type { ChatSession } from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
} from "./chat-page-lifecycle-support.js";
import { cleanupChatPage, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, FakeEventSource, resetFakeEventSources } from "./chat-stream-support.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  authenticatedPrincipal,
  createFetchMock,
  deferredResponse,
  jsonResponse,
} from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";
import "./radix-platform.js";

const HERO = "WorkBuddy，我帮你";
const OLD_EMPTY_COPY = "选择一个会话，或直接发送开始新对话";
const SESSION_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let disposeApp: (() => void) | undefined;

afterEach(() => {
  disposeApp?.();
  disposeApp = undefined;
  cleanupChatLifecycle();
  cleanupChatPage();
  vi.restoreAllMocks();
});

function session(id: string, title: string | null): ChatSession {
  return { ...chatSnapshot().session, id, status: "done", title };
}

function snapshotOf(item: ChatSession) {
  const snapshot = chatSnapshot({
    sessionId: item.id,
    status: "done",
    assistantStatus: "done",
    cursor: { epoch: 1, seq: null },
  });
  return { ...snapshot, session: item };
}

/** 列表 + 各会话快照；`pending` 中的会话历史保持挂起。 */
function chatRoutes(sessions: ChatSession[], pending: string[] = []): FetchRoutes {
  const routes: FetchRoutes = { "/api/sessions": () => jsonResponse({ sessions }) };
  for (const item of sessions) {
    routes[`/api/sessions/${item.id}/messages`] = () =>
      pending.includes(item.id) ? deferredResponse().promise : jsonResponse(snapshotOf(item));
  }
  return routes;
}

/** 经完整路由挂载已认证应用（含 shell/顶栏）。 */
function mountApp(path: string, routes: FetchRoutes = {}) {
  resetFakeEventSources();
  vi.stubGlobal("EventSource", FakeEventSource);
  const fetchMock = createFetchMock({
    "/api/auth/me": () => jsonResponse(authenticatedPrincipal),
    "/api/sessions": () => jsonResponse({ sessions: [] }),
    "/api/workspaces": () => jsonResponse({ workspaces: [] }),
    "/api/info": () =>
      jsonResponse({
        name: "workbuddy-app-server",
        version: "0.0.0",
        auth: { provider: "dev-stub" },
      }),
    ...routes,
  });
  const mounted = mountAuthenticatedApp(path, fetchMock);
  disposeApp = () => mounted.router.dispose();
  return mounted;
}

function mainLevelOneHeadings() {
  return within(screen.getByRole("main")).queryAllByRole("heading", { level: 1 });
}

async function findBreadcrumb(title: string) {
  const banner = await screen.findByRole("banner");
  return within(banner).findByRole("heading", { level: 1, name: `我的工作 / ${title}` });
}

/** 面包屑是唯一的 level-1 heading：main 内无 h1，也无 hero。 */
async function expectBreadcrumbOnly(title: string) {
  const crumb = await findBreadcrumb(title);
  expect(mainLevelOneHeadings()).toHaveLength(0);
  expect(screen.getAllByRole("heading", { level: 1 })).toEqual([crumb]);
  expect(screen.queryByText(HERO)).toBeNull();
}

/** 欢迎态：无顶栏，hero 是 main 内唯一的 level-1 heading。 */
async function expectWelcomeOnly() {
  const hero = await screen.findByRole("heading", { level: 1, name: HERO });
  expect(screen.queryByRole("banner")).toBeNull();
  expect(screen.getAllByRole("heading", { level: 1 })).toEqual([hero]);
  expect(hero.closest("main")).not.toBeNull();
}

function sidebarLink(label: string | RegExp) {
  const navigation = within(screen.getByRole("complementary", { name: "侧栏" })).getByRole(
    "navigation",
    { name: "主导航" },
  );
  return within(navigation).getByRole("link", { name: label });
}

describe("顶栏三态 (T1/T2/T2b/T2c/T3/T3b)", () => {
  it("T1 欢迎态无顶栏，唯一 level-1 heading 为 main 内的 hero", async () => {
    mountApp("/");

    await expectWelcomeOnly();
    expect(screen.queryByText(OLD_EMPTY_COPY)).toBeNull();
  });

  it("T2 已选会话：banner 内面包屑为唯一 level-1 heading，main 内无 h1、无 hero", async () => {
    renderChatPage(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, "周报")]));

    expect(await screen.findByRole("article", { name: "用户" })).toBeTruthy();
    await expectBreadcrumbOnly("周报");
  });

  it("T2b 已选会话、历史挂起：面包屑唯一，main 内无 h1、无 hero", async () => {
    renderChatPage(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, "周报")], [SESSION_A]));

    await expectBreadcrumbOnly("周报");
    expect(screen.getByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
  });

  it("T2c 标题未知窗口（列表与历史均挂起）：无顶栏、无 hero，页面级 h1 为 0", async () => {
    const history = deferredResponse();
    renderChatPage(`/?session=${SESSION_A}`, {
      "/api/sessions": () => deferredResponse().promise,
      [`/api/sessions/${SESSION_A}/messages`]: () => history.promise,
    });

    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByText(HERO)).toBeNull();
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
  });

  it("T3 列表标题为 null 时面包屑回退 新会话", async () => {
    renderChatPage(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, null)]));

    expect(await findBreadcrumb("新会话")).toBeTruthy();
  });

  it("T3b 列表 503 时以本页就绪快照标题兜底", async () => {
    renderChatPage(`/?session=${SESSION_A}`, {
      ...chatRoutes([session(SESSION_A, "周报")]),
      "/api/sessions": () => jsonResponse({ error: { code: "unavailable", message: "x" } }, 503),
    });

    await expectBreadcrumbOnly("周报");
  });

  it("T3b 兜底只取本页持有的快照：他会话的陈旧快照不泄入面包屑", () => {
    const client = createApiClient();
    const snapshot = snapshotOf(session(SESSION_A, "周报"));
    const ready: ChatHistoryState = {
      status: "ready",
      client,
      snapshot,
      view: chatStateFromSnapshot(snapshot),
    };
    const titleFor = (id: string) =>
      selectedSessionTitle(id, null, ownsHistory(ready, client, id), ready);

    expect(titleFor(SESSION_A)).toBe("周报");
    expect(titleFor(SESSION_B)).toBeUndefined();
  });
});

describe("其它路由顶栏标题 (T4)", () => {
  it.each([
    ["/files", "工作空间"],
    ["/settings", "设置"],
    ["/center", "中心"],
  ])("T4 %s → banner h1 %s，页面级 h1 恰 1 个且不在 main 内", async (path, title) => {
    mountApp(path);

    const banner = await screen.findByRole("banner");
    const heading = await within(banner).findByRole("heading", { level: 1, name: title });
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([heading]);
    expect(heading.closest("main")).toBeNull();
    expect(mainLevelOneHeadings()).toHaveLength(0);
    if (path === "/center") {
      expect(within(screen.getByRole("main")).getByText("中心暂不可用")).toBeTruthy();
    }
  });
});

describe("上报次序 (T5/T5b/T6/T7)", () => {
  it("T5 离开会话到 /files 再回 会话：面包屑清空、回到欢迎态", async () => {
    mountApp(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, "周报")]));
    await findBreadcrumb("周报");

    fireEvent.click(sidebarLink(/^工作空间/));
    await waitFor(() => {
      const banner = screen.getByRole("banner");
      expect(within(banner).getByRole("heading", { level: 1, name: "工作空间" })).toBeTruthy();
      expect(within(banner).queryByText(/我的工作/)).toBeNull();
    });

    fireEvent.click(sidebarLink("会话"));
    await expectWelcomeOnly();
  });

  it("T5b 同页取消选中（ChatPage 不卸载）：面包屑清空、回到欢迎态", async () => {
    const { router } = mountApp(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, "周报")]));
    await findBreadcrumb("周报");

    await act(async () => {
      await router.navigate("/");
    });
    await expectWelcomeOnly();
  });

  it("T6 切换会话（StrictMode）：面包屑跟随新会话标题", async () => {
    renderChatPage(
      `/?session=${SESSION_A}`,
      chatRoutes([session(SESSION_A, "周报"), session(SESSION_B, "复盘")]),
      true,
    );
    await findBreadcrumb("周报");

    fireEvent.click(await screen.findByRole("button", { name: "复盘" }));
    expect(await findBreadcrumb("复盘")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("T7 Provider 外裸挂 ChatPage：上报为 no-op，不抛错、无 console.error", async () => {
    const consoleError = vi.spyOn(console, "error");
    renderChatPageWithAuthProbe(`/?session=${SESSION_A}`, chatRoutes([session(SESSION_A, "周报")]));

    expect(await screen.findByRole("article", { name: "用户" })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "周报" }).getAttribute("aria-current")).toBe(
        "true",
      );
    });
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.queryByText(/我的工作/)).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe("静态契约 (T8)", () => {
  it("页面不再渲染自有 h1，样式与依赖方向符合顶栏归属", () => {
    for (const path of [
      "web/src/features/chat/page.tsx",
      "web/src/features/files/page.tsx",
      "web/src/features/settings/page.tsx",
      "web/src/routes/router.tsx",
    ]) {
      expect(readRepoFile(path), path).not.toContain("<h1");
    }
    expect(readRepoFile("web/src/features/chat/welcome.tsx")).toContain(HERO);
    for (const path of [
      "web/src/styles.css",
      "web/src/features/chat/chat.css",
      "web/src/features/files/files.css",
    ]) {
      expect(readRepoFile(path), path).not.toContain("ui-page-heading");
    }
    const styles = readRepoFile("web/src/styles.css");
    expect(styles).toContain(".app-content > main");
    expect(styles).not.toContain(".app-shell > main");
    const topbar = readRepoFile("web/src/routes/shell/topbar.tsx");
    expect(topbar).not.toContain('role="banner"');
    expect(topbar).not.toContain("@radix-ui");
    expect(topbar).not.toContain("features/");
    const chatPage = readRepoFile("web/src/features/chat/page.tsx");
    expect(chatPage).toContain("useTopbar(");
    expect(chatPage).not.toContain("routes/");
    const lib = readRepoFile("web/src/lib/topbar.tsx");
    expect(lib).not.toContain("routes/");
    expect(lib).not.toContain("features/");
    const topbarRule = ruleBody(
      stripComments(readRepoFile("web/src/routes/shell/topbar.css")),
      ".topbar",
    );
    expect(topbarRule).toMatch(/^\s*height: 56px;$/m);
    expect(topbarRule).toContain("flex: none;");
    expect(ruleBody(stripComments(styles), ".app-content")).toContain("flex-direction: column;");
  });

  it("顶栏位于 main 之外（挂载后 main .topbar 不存在）", async () => {
    mountApp("/files");

    await screen.findByRole("banner");
    expect(document.querySelector(".topbar")).not.toBeNull();
    expect(document.querySelector("main .topbar")).toBeNull();
  });
});
