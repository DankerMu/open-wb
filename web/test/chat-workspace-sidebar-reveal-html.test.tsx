/**
 * Issue #1110 产物卡的 `打开网页预览`（tasks 25.2，分摊的 25.4）：workspace-sidebar「从卡片定位到文件」的
 * 场景「打开网页预览」——打开侧边栏、选中该网页并置为渲染视图，页面里没有 `srcdoc` 的框，也没有以文件名
 * 为名的对话框，渲染视图不请求 `file`。同一条需求的另外四个场景在 chat-workspace-sidebar-reveal.test.tsx
 * （#1109，用例 R1–R13）；这里的编号接着它。
 * 接缝：真实外壳里的整页（桩掉的 `fetch` 与事件连接）；请求取自 `fetch` 桩的调用记录。期望值是规格里
 * 的字面量，框的来源是夹具签发的 `BASE`。
 *
 * jsdom 不加载框：这里证到框的 `src` 与 `sandbox` 两个属性的值；「框确实从隔离来源加载、脚本够不到
 * 页面」只有 `make ui-walk` 能证（`web/e2e/ui-walk-workspace-sidebar.ts` 的 `walkOpenWebPreview`）。
 */
import { pageNotices } from "./page-notices.js";
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  actions,
  changedTurn,
  INDEX,
  OPEN_INDEX,
  siteRoutes,
} from "./chat-page-artifact-card-support.js";
import { listed, openSession, PROJ, turn, write } from "./chat-page-file-changes-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  cleanupSessionMeta,
  crumb,
  focusOn,
  installNarrowViewport,
  messagesPath,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { SESSION_ID } from "./chat-stream-support.js";
import {
  CLOSE,
  dir,
  fileOf,
  listing,
  NAME,
  settled,
  sidebarButton,
  sidebarRegion,
  treeOf,
  treeRequests,
} from "./chat-workspace-sidebar-support.js";
import { BASE } from "./files-site-fixture.js";
import {
  calls,
  currentLocation,
  type FetchMock,
  jsonResponse,
  paths,
  textPreviewResponse,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const SESSION = `/?session=${SESSION_ID}`;
const ROOT = treeOf(PROJ.id);
const OUT = treeOf(PROJ.id, "out");
const SOURCE_FILE = fileOf(PROJ.id, INDEX);
const TOKEN_PATH = `/api/workspaces/${PROJ.id}/preview-token`;
const SOURCE = "<h1>首页</h1>";
const SANDBOX = "allow-scripts allow-forms allow-modals";
const MISSING = "文件不存在";

afterEach(cleanupSessionMeta);

/**
 * 在真实外壳里打开一条改了 `out/index.html` 的回合，侧边栏是关的。PROJ 的根下只有 `out`，`out` 里只有
 * `index.html`；它的 `file` 有应答（源码视图要用），所以卡片若仍去取预览，是请求记录而不是抛错说出来。
 */
async function openPage(routes: FetchRoutes = {}) {
  const page = await openSession(changedTurn([write(INDEX)]), listed, {
    ...siteRoutes(),
    [SOURCE_FILE]: () => textPreviewResponse(SOURCE),
    ...routes,
  });
  await crumb("saved title");
  expect(sidebarRegion()).toBeNull();
  return page;
}

/** 卡头（图标）与卡脚（文字）的两个 `打开网页预览`；卡在模态层后面时照样取得到。 */
function openers() {
  const [head, foot] = actions(OPEN_INDEX);
  if (!head || !foot) throw new Error("html 产物卡应有卡头与卡脚两个按钮");
  return { foot, head };
}

/** 焦点先放到按钮上（真实点击会这样），再点它。 */
function press(opener: HTMLButtonElement) {
  opener.focus();
  fireEvent.click(opener);
}

/** 等到 `index.html` 那一行被选中、预览区里有框；返回那个框。 */
async function rendered(scope: HTMLElement) {
  const row = await within(scope).findByRole("button", { name: "index.html" });
  await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
  return waitFor(() => {
    const frame = within(scope).getByRole("region", { name: "文件预览" }).querySelector("iframe");
    if (!frame) throw new Error("预览区里还没有 iframe");
    return frame;
  });
}

function fileRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

/** 页面里没有 `srcdoc` 的框，也没有以文件名为名的对话框（模态层后面的也算）。 */
function expectNoDialogPreview() {
  expect(document.querySelector("iframe[srcdoc]")).toBeNull();
  expect(screen.queryByRole("dialog", { hidden: true, name: "index.html" })).toBeNull();
}

describe("打开网页预览", () => {
  it("R14 侧边栏关着点卡头的 打开网页预览：tree 只请求根与 out 各一次，index.html 被选中，预览是签发来源上的框、sandbox 恰为三个令牌；没有 srcdoc 的框、没有以文件名为名的对话框、不请求 file；地址不变、焦点仍在被点的按钮", async () => {
    const { fetchMock, router } = await openPage();
    expect(treeRequests(fetchMock)).toStrictEqual([]);
    const top = sidebarButton();
    const { foot, head } = openers();

    press(head);

    const region = await screen.findByRole("complementary", { name: NAME });
    const frame = await rendered(region);
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    expect(frame.getAttribute("src")).toBe(`${BASE}out/index.html`);
    expect(frame.getAttribute("sandbox")).toBe(SANDBOX);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expectNoDialogPreview();
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(calls(fetchMock, TOKEN_PATH).map(([, options]) => options?.method)).toStrictEqual([
      "POST",
    ]);
    expect(currentLocation()).toBe(SESSION);
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(SESSION);
    expect(document.activeElement).toBe(head);
    expect([head.disabled, foot.disabled]).toStrictEqual([false, false]);
    expect(top.getAttribute("aria-expanded")).toBe("true");
  });

  it("R15 已是渲染视图时再点卡脚的 打开网页预览：没有新的请求，框还是同一个节点，焦点在卡脚按钮", async () => {
    const { fetchMock } = await openPage();
    const { foot, head } = openers();
    press(head);
    const region = await screen.findByRole("complementary", { name: NAME });
    const frame = await rendered(region);
    await settled();
    const before = paths(fetchMock);

    press(foot);
    await settled();

    expect(await rendered(region)).toBe(frame);
    expect(paths(fetchMock)).toStrictEqual(before);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(sidebarRegion()).toBe(region);
    expect(document.activeElement).toBe(foot);
    expectNoDialogPreview();
  });

  it("R16 同一个网页已选中并停在源码视图时点 打开网页预览：回到渲染视图的框，file 仍只有看源码的那一次，令牌不重新签发", async () => {
    const { fetchMock } = await openPage();
    const { head } = openers();
    press(head);
    const region = await screen.findByRole("complementary", { name: NAME });
    await rendered(region);
    fireEvent.click(within(region).getByRole("button", { name: "查看源码" }));
    expect(await within(region).findByRole("cell", { name: SOURCE })).toBeTruthy();
    expect(region.querySelector("iframe")).toBeNull();
    expect(fileRequests(fetchMock)).toStrictEqual([SOURCE_FILE]);

    press(head);

    const frame = await rendered(region);
    await settled();
    expect(frame.getAttribute("src")).toBe(`${BASE}out/index.html`);
    expect(within(region).queryByRole("cell", { name: SOURCE })).toBeNull();
    expect(within(region).getByRole("button", { name: "查看源码" })).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([SOURCE_FILE]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    expect(calls(fetchMock, TOKEN_PATH)).toHaveLength(1);
    expectNoDialogPreview();
  });

  it("R16 停在源码视图时点同一个文件的 查看详情：不带渲染视图的定位不翻视图，源码还在，没有新的请求", async () => {
    const { fetchMock } = await openPage();
    press(openers().head);
    const region = await screen.findByRole("complementary", { name: NAME });
    await rendered(region);
    fireEvent.click(within(region).getByRole("button", { name: "查看源码" }));
    expect(await within(region).findByRole("cell", { name: SOURCE })).toBeTruthy();
    await settled();
    const before = paths(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: `查看详情 zhangsan/proj/${INDEX}` }));
    await settled();

    expect(within(region).getByRole("cell", { name: SOURCE })).toBeTruthy();
    expect(region.querySelector("iframe")).toBeNull();
    expect(paths(fetchMock)).toStrictEqual(before);
  });

  type Opener = keyof ReturnType<typeof openers>;
  const pressEscape = () => fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
  const closings: Array<[string, (layer: HTMLElement) => void]> = [
    ["Escape", pressEscape],
    ["关闭", (layer) => fireEvent.click(within(layer).getByRole("button", { name: CLOSE }))],
  ];
  // 被点的按钮 × 关闭方式：卡头是图标按钮，卡脚是文字按钮。
  const clickable: Array<[string, Opener]> = [
    ["卡头", "head"],
    ["卡脚", "foot"],
  ];
  const returns = clickable.flatMap(([label, clicked]) =>
    closings.map(([name, close]): [string, string, Opener, (layer: HTMLElement) => void] => [
      label,
      name,
      clicked,
      close,
    ]),
  );

  /**
   * 窄屏下打开 `out/index.html` 那一回合，焦点先放到 `clicked` 上（真实点击会这样），之后才装 `focus`
   * 的探针——所以探针记到的只有关闭时归还焦点的那一次。
   */
  async function narrowPage(clicked: Opener) {
    installNarrowViewport();
    const { fetchMock } = await openPage();
    const buttons = openers();
    const top = vi.spyOn(sidebarButton(), "focus");
    buttons[clicked].focus();
    const on = { foot: vi.spyOn(buttons.foot, "focus"), head: vi.spyOn(buttons.head, "focus") };
    return { buttons, fetchMock, on, top };
  }

  it.each(returns)(
    "R17 窄屏点%s的 打开网页预览：焦点进层内的 关闭，预览是渲染框；用 %s 关掉后焦点只带 preventScroll 回到被点的那个按钮，另一个按钮与顶栏按钮没有被聚焦",
    async (_label, _name, clicked, close) => {
      const { buttons, fetchMock, on, top } = await narrowPage(clicked);
      const other = clicked === "head" ? "foot" : "head";

      fireEvent.click(buttons[clicked]);

      const layer = await screen.findByRole("dialog", { name: NAME });
      expect(layer.getAttribute("aria-modal")).toBe("true");
      const frame = await rendered(layer);
      await yieldMacrotask();
      expect(frame.getAttribute("src")).toBe(`${BASE}out/index.html`);
      expect(document.activeElement).toBe(within(layer).getByRole("button", { name: CLOSE }));
      expectNoDialogPreview();
      expect(fileRequests(fetchMock)).toStrictEqual([]);

      close(layer);

      await waitFor(() => expect(screen.queryByRole("dialog", { name: NAME })).toBeNull());
      await focusOn(buttons[clicked]);
      expect(on[clicked].mock.calls).toStrictEqual([[{ preventScroll: true }]]);
      expect(on[other]).not.toHaveBeenCalled();
      expect(top).not.toHaveBeenCalled();
      expect(document.querySelector("iframe")).toBeNull();
    },
  );

  // 真实的点击落在卡头按钮里的图标上：记下的是挂着处理函数的按钮，不是事件的目标。
  it("R17 窄屏点卡头按钮里的图标：Escape 关掉后焦点只带 preventScroll 回到卡头按钮，卡脚按钮与顶栏按钮没有被聚焦", async () => {
    const { buttons, on, top } = await narrowPage("head");
    const glyph = buttons.head.querySelector("svg");
    if (!glyph) throw new Error("卡头按钮里应有图标");

    fireEvent.click(glyph);

    await rendered(await screen.findByRole("dialog", { name: NAME }));
    await yieldMacrotask();

    pressEscape();

    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAME })).toBeNull());
    await focusOn(buttons.head);
    expect(on.head.mock.calls).toStrictEqual([[{ preventScroll: true }]]);
    expect(on.foot).not.toHaveBeenCalled();
    expect(top).not.toHaveBeenCalled();
  });

  it("R18 out 的列表里没有 index.html：侧边栏打开并展开到 out，预览区是 未选择文件、页面上没有 文件不存在，没有框，不签发令牌，也不请求 file", async () => {
    const { fetchMock } = await openPage({
      [ROOT]: listing("", [dir("out")]),
      [OUT]: listing("out", []),
    });

    press(openers().head);

    const region = await screen.findByRole("complementary", { name: NAME });
    const preview = within(region).getByRole("region", { name: "文件预览" });
    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]));
    await settled();
    expect(within(preview).getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(screen.queryByText(MISSING)).toBeNull();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    expect(document.querySelector("iframe")).toBeNull();
    expect(calls(fetchMock, TOKEN_PATH)).toStrictEqual([]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(within(region).queryByRole("button", { name: "index.html" })).toBeNull();
    expect(currentLocation()).toBe(SESSION);
  });

  // 模态层盖着会话列表，换会话走路由（真实路径是浏览器的后退 / 前进）。
  it("R19 窄屏、渲染框开着时切到未绑定的会话：模态层与框都不留，页面没有被留在点不动的状态", async () => {
    installNarrowViewport();
    const { session } = changedTurn([write(INDEX)]);
    const unbound = { ...session, id: "c".repeat(32), title: "未绑定会话", workspaceId: null };
    const { router } = await openPage({
      "/api/sessions": () => jsonResponse({ sessions: [session, unbound] }),
      [messagesPath(unbound.id)]: () =>
        jsonResponse({ ...turn("done", { content: "没有空间" }, null), session: unbound }),
    });
    fireEvent.click(openers().foot);
    await rendered(await screen.findByRole("dialog", { name: NAME }));
    await yieldMacrotask();
    expect(document.body.style.pointerEvents).toBe("none");

    await act(() => router.navigate(`/?session=${unbound.id}`));
    await crumb(unbound.title);
    await settled();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toStrictEqual([]);
    expect(document.querySelector("iframe")).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(composer().closest('[aria-hidden="true"]')).toBeNull();
    expect(pageNotices()).toEqual([]);
  });
});
