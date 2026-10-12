/**
 * Issue #1109 文件变更卡的 `查看详情`（tasks 25.1、25.3，分摊的 25.4）：workspace-sidebar「从卡片定位到
 * 文件」的场景「查看详情定位」「最后一次为准」「窄屏的焦点往返」「文件已不存在」，以及同一条需求里
 * 「开关开着时」的三个分支、换会话与关闭后重开。场景「打开网页预览」属产物卡（#1110），不在这里。
 * 接缝：真实外壳里的整页（桩掉的 `fetch` 与事件连接）；请求取自 `fetch` 桩的调用记录。期望值是规格里
 * 的字面量。
 *
 * jsdom 没有布局，`focus()` 也不滚动：「消息线程不滚动」在这里证到归还焦点时只带 `preventScroll`、
 * 没有对该按钮调 `scrollIntoView`、线程的 `scrollTop` 仍在底部且继续跟随。`make ui-walk` 的
 * `mobile-dark` 里卡片在视口内，去掉 `preventScroll` 不使走查变红（#1109 实测，见
 * `web/e2e/ui-walk-workspace-sidebar.ts` 的注释）；真实的滚动由一次钩子辅助复现证明过。
 */
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assistantMessage,
  type Change,
  edit,
  goLive,
  listed,
  openSession,
  PROJ,
  type Snapshot,
  toolStep,
  turn,
  withNeighbour,
  write,
} from "./chat-page-file-changes-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import { bottom, geometry, installGeometry, jumpButton } from "./chat-page-search-support.js";
import {
  cleanupSessionMeta,
  crumb,
  focusOn,
  installNarrowViewport,
  messagesPath,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import {
  deferred,
  historyUser,
  observeUnhandledRejections,
  SESSION_ID,
} from "./chat-stream-support.js";
import {
  CLOSE,
  dir,
  file,
  fileOf,
  listing,
  NAME,
  OPEN_IN_FILES,
  openSidebar,
  rowNames,
  selectSession,
  settled,
  sidebarButton,
  sidebarRegion,
  treeOf,
  treeRequests,
} from "./chat-workspace-sidebar-support.js";
import {
  currentLocation,
  type FetchMock,
  jsonResponse,
  paths,
  textPreviewResponse,
} from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const MARK = "本会话已改动";
const ONLY = "只看本会话改动";
const PREVIEW = "文件预览";
const MISSING = "文件不存在";
/** 服务端 `not_found` 信封的文案。 */
const NOT_FOUND = "请求的资源不存在";
const SESSION = `/?session=${SESSION_ID}`;
const ROOT = treeOf(PROJ.id);
const SRC = treeOf(PROJ.id, "src");
const DEEP = treeOf(PROJ.id, "src/deep");
const OUT = treeOf(PROJ.id, "out");
const APP = "src/deep/app.ts";
const APP_SOURCE = "export const app = 1;";
const README_TEXT = "自述正文";
const SCROLL_METRICS = ["scrollHeight", "clientHeight", "scrollTop"] as const;

afterEach(async () => {
  await cleanupSessionMeta();
  for (const name of SCROLL_METRICS) Reflect.deleteProperty(HTMLElement.prototype, name);
});

/** 一条已结束的回合，唯一的已结束步骤改了 `changes`。 */
const changedTurn = (...changes: Change[]) =>
  turn("done", { content: "改好了", steps: [toolStep(11, 0, "edit", changes)] });

/** PROJ 的目录：根下 `src`（内有 `deep/app.ts`）与 `readme.md`。 */
function project(extra: FetchRoutes = {}): FetchRoutes {
  return {
    [ROOT]: listing("", [dir("src"), file("readme.md")]),
    [SRC]: listing("src", [dir("deep")]),
    [DEEP]: listing("src/deep", [file("app.ts")]),
    [fileOf(PROJ.id, APP)]: () => textPreviewResponse(APP_SOURCE),
    [fileOf(PROJ.id, "readme.md")]: () => textPreviewResponse(README_TEXT),
    ...extra,
  };
}

/** 在真实外壳里打开 `snapshot` 的会话页，侧边栏是关的。 */
async function openPage(snapshot: Snapshot, routes: FetchRoutes) {
  const page = await openSession(snapshot, listed, routes);
  await crumb("saved title");
  expect(sidebarRegion()).toBeNull();
  return page;
}

/** `path`（空间内相对路径）那一行的 `查看详情`；卡在模态层后面时照样取得到。 */
function detail(path: string) {
  return screen.getByRole<HTMLButtonElement>("button", {
    hidden: true,
    name: `查看详情 zhangsan/proj/${path}`,
  });
}

/** 焦点先放到按钮上（真实点击会这样），再点它。 */
function clickDetail(path: string) {
  const opener = detail(path);
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

/** 点 `path` 的 `查看详情`，等宽屏的侧边栏出现。 */
async function reveal(path: string) {
  const opener = clickDetail(path);
  return { opener, region: await screen.findByRole("complementary", { name: NAME }) };
}

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole<HTMLButtonElement>("button", { name });

/** 等到名为 `name` 的文件行被选中。 */
async function selected(scope: HTMLElement, name: string) {
  const row = await within(scope).findByRole("button", { name });
  await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
  return row;
}

function selectedRows(scope: HTMLElement) {
  return [...scope.querySelectorAll('button[aria-current="true"]')].map(
    (row) => row.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

const preview = (scope: HTMLElement) => within(scope).getByRole("region", { name: PREVIEW });

/** 等到预览区的文本里出现 `text`（代码预览把一行拆成多个节点，按整段文本比）。 */
function previewShows(scope: HTMLElement, text: string) {
  return waitFor(() => expect(preview(scope).textContent).toContain(text));
}

/** 放行挂住的目录列表 `path`（内容是 `entries`），等它落地。 */
async function arrive(late: { resolve(value: Response): void }, path: string, entries: unknown[]) {
  await act(async () => {
    late.resolve(jsonResponse({ path, entries }));
    await Promise.resolve();
  });
  await settled();
}

function fileRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.includes("/file?"));
}

describe("查看详情定位", () => {
  it("R1 侧边栏关着、树从未加载：依次请求根、src、src/deep，app.ts 被选中并带改动标记，预览是它的源码；地址不变、焦点仍在被点的按钮、过滤开关仍是关的", async () => {
    const { fetchMock, router } = await openPage(changedTurn(edit(APP, 2, 1)), project());
    expect(treeRequests(fetchMock)).toStrictEqual([]);
    // 预览头也是一个 `header`：顶栏按钮在预览出现之前取。
    const top = sidebarButton();

    const { opener, region } = await reveal(APP);

    const row = await selected(region, "app.ts");
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, DEEP]);
    const described = row.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe(MARK);
    await previewShows(region, APP_SOURCE);
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, APP)]);
    expect(currentLocation()).toBe(SESSION);
    expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(SESSION);
    expect(document.activeElement).toBe(opener);
    expect(opener.isConnected).toBe(true);
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("false");
    expect(top.getAttribute("aria-expanded")).toBe("true");
  });

  it("R2 已加载的不重复请求：侧边栏已开、src 已展开时点 查看详情，只多出对 src/deep 的一次 tree", async () => {
    const { fetchMock } = await openPage(changedTurn(edit(APP, 2, 1)), project());
    const { region } = await openSidebar("readme.md");
    fireEvent.click(button(region, "展开 src"));
    await within(region).findByRole("button", { name: "展开 deep" });
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC]);

    clickDetail(APP);

    await selected(region, "app.ts");
    await previewShows(region, APP_SOURCE);
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, DEEP]);
    expect(sidebarRegion()).toBe(region);
  });

  it("R13 定位落地之后点树里的 readme.md：选中的只有它、预览是它的正文，在文件页打开 的地址带的是它，全部落定之后仍是如此（定位只套用一次）", async () => {
    const { fetchMock } = await openPage(changedTurn(edit(APP, 2, 1)), project());
    const { region } = await reveal(APP);
    await selected(region, "app.ts");
    await previewShows(region, APP_SOURCE);

    fireEvent.click(button(region, "readme.md"));

    await selected(region, "readme.md");
    await previewShows(region, README_TEXT);
    expect(selectedRows(region)).toStrictEqual(["readme.md"]);
    await settled();
    expect(selectedRows(region)).toStrictEqual(["readme.md"]);
    expect(preview(region).textContent).toContain(README_TEXT);
    expect(preview(region).textContent).not.toContain(APP_SOURCE);
    // 树的选中在浏览器自己的状态里；侧边栏这一侧的「当前文件」只从这个地址看得出来。
    const link = within(region).getByRole<HTMLAnchorElement>("link", { name: OPEN_IN_FILES });
    expect(`${new URL(link.href).pathname}${new URL(link.href).search}`).toBe(
      `/files?ws=${PROJ.id}&path=readme.md`,
    );
    expect(fileRequests(fetchMock)).toStrictEqual([
      fileOf(PROJ.id, APP),
      fileOf(PROJ.id, "readme.md"),
    ]);
  });
});

describe("最后一次为准", () => {
  it("R3 a/x.md 的目录请求返回之前再点 b/y.md：选中的是 y.md；a 的迟到响应不改变选中，也没有对 a/x.md 的 file 请求", async () => {
    const late = deferred<Response>();
    const { fetchMock } = await openPage(
      changedTurn(write("a/x.md"), write("b/y.md")),
      project({
        [ROOT]: listing("", [dir("a"), dir("b")]),
        [treeOf(PROJ.id, "a")]: () => late.promise,
        [treeOf(PROJ.id, "b")]: listing("b", [file("y.md")]),
        [fileOf(PROJ.id, "a/x.md")]: () => textPreviewResponse("甲的正文"),
        [fileOf(PROJ.id, "b/y.md")]: () => textPreviewResponse("乙的正文"),
      }),
    );

    const { region } = await reveal("a/x.md");
    await waitFor(() =>
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, treeOf(PROJ.id, "a")]),
    );
    clickDetail("b/y.md");

    await selected(region, "y.md");
    await previewShows(region, "乙的正文");

    await arrive(late, "a", [file("x.md")]);

    expect(selectedRows(region)).toStrictEqual(["y.md"]);
    expect(preview(region).textContent).toContain("乙的正文");
    expect(preview(region).textContent).not.toContain("甲的正文");
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "b/y.md")]);
  });

  it("R3 后一次点的是当前已选中的文件：被取代的定位同样放弃，a 的迟到响应不把选中换成 x.md", async () => {
    const late = deferred<Response>();
    const { fetchMock } = await openPage(
      changedTurn(write("a/x.md"), write("readme.md")),
      project({
        [ROOT]: listing("", [dir("a"), file("readme.md")]),
        [treeOf(PROJ.id, "a")]: () => late.promise,
        [fileOf(PROJ.id, "a/x.md")]: () => textPreviewResponse("甲的正文"),
      }),
    );
    const { region } = await openSidebar("readme.md");
    fireEvent.click(button(region, "readme.md"));
    await previewShows(region, README_TEXT);

    clickDetail("a/x.md");
    await waitFor(() =>
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, treeOf(PROJ.id, "a")]),
    );
    clickDetail("readme.md");
    await arrive(late, "a", [file("x.md")]);

    expect(selectedRows(region)).toStrictEqual(["readme.md"]);
    expect(preview(region).textContent).toContain(README_TEXT);
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md")]);
  });
});

describe("窄屏的焦点往返", () => {
  /** 较早一条助手消息改了 `notes.md`，最后一条仍在输出。 */
  function streaming(): Snapshot {
    return {
      ...turn("running"),
      messages: [
        historyUser,
        assistantMessage("done", {
          content: "改好了",
          steps: [toolStep(1, 0, "write", [write("notes.md")])],
        }),
        { ...historyUser, id: 1, content: "写一篇长文", createdAt: 1 },
        assistantMessage("running", { id: 2, content: "起始", createdAt: 2 }),
      ],
    };
  }

  it("R4 回合输出中点较早消息的 查看详情：焦点进层内的 关闭；Escape 后焦点只带 preventScroll 回到被点的按钮，顶栏按钮没有被聚焦，线程仍贴底跟随、没有 回到最新", async () => {
    installNarrowViewport();
    installGeometry();
    const scrolled: Element[] = [];
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function record(
      this: Element,
    ) {
      scrolled.push(this);
    });
    await openPage(
      streaming(),
      project({
        [ROOT]: listing("", [file("notes.md")]),
        [fileOf(PROJ.id, "notes.md")]: () => textPreviewResponse("笔记正文"),
      }),
    );
    const send = await goLive();
    /** 内容长高 `by` 并推一段增量，等线程跟到新的底部。 */
    const grow = async (by: number, delta: string) => {
      act(() => {
        geometry.scrollHeight += by;
      });
      send("text.delta", { messageId: 2, delta });
      await waitFor(() => expect(geometry.scrollTop).toBe(bottom()));
    };
    expect(geometry.scrollTop).toBe(2500);
    const top = vi.spyOn(sidebarButton(), "focus");
    const opener = detail("notes.md");
    opener.focus();
    const focus = vi.spyOn(opener, "focus");

    fireEvent.click(opener);

    const layer = await screen.findByRole("dialog", { name: NAME });
    expect(layer.getAttribute("aria-modal")).toBe("true");
    await selected(layer, "notes.md");
    await yieldMacrotask();
    expect(document.activeElement).toBe(button(layer, CLOSE));
    expect(currentLocation()).toBe(SESSION);

    // 层开着期间回答继续输出：线程跟到新的底部（卡片随之被顶出视口）。
    await grow(400, "，第二段");
    expect(geometry.scrollTop).toBe(2900);

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAME })).toBeNull());
    await focusOn(opener);
    expect(focus.mock.calls).toStrictEqual([[{ preventScroll: true }]]);
    expect(top).not.toHaveBeenCalled();
    expect(scrolled).not.toContain(opener);
    expect(opener.isConnected).toBe(true);
    expect(geometry.scrollTop).toBe(2900);
    expect(jumpButton()).toBeNull();
    await grow(400, "，第三段");
    expect(geometry.scrollTop).toBe(3300);
    expect(jumpButton()).toBeNull();
  });
});

describe("窄屏：焦点还给谁", () => {
  const NOTES = {
    [ROOT]: listing("", [file("notes.md")]),
    [fileOf(PROJ.id, "notes.md")]: () => textPreviewResponse("笔记正文"),
  };

  /** 窄屏下点 `notes.md` 的 `查看详情`，等模态层的初始焦点落定。 */
  async function openFromCard() {
    const opener = detail("notes.md");
    opener.focus();
    fireEvent.click(opener);
    const layer = await screen.findByRole("dialog", { name: NAME });
    await selected(layer, "notes.md");
    await yieldMacrotask();
    return { layer, opener };
  }

  async function pressEscape() {
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: NAME })).toBeNull());
  }

  it("R10 由卡片打开并关闭之后改用顶栏按钮打开：这一次 Escape 把焦点还给顶栏按钮，不是先前的 查看详情", async () => {
    installNarrowViewport();
    await openPage(changedTurn(write("notes.md")), project(NOTES));
    const { opener } = await openFromCard();
    await pressEscape();
    await focusOn(opener);
    const top = sidebarButton();
    top.focus();
    const again = vi.spyOn(opener, "focus");

    fireEvent.click(top);
    const layer = await screen.findByRole("dialog", { name: NAME });
    await within(layer).findByRole("button", { name: "notes.md" });
    await yieldMacrotask();
    expect(selectedRows(layer)).toStrictEqual([]);
    await pressEscape();

    await focusOn(top);
    expect(again).not.toHaveBeenCalled();
  });

  // 模态层盖着会话列表，换会话走路由（真实路径是浏览器的后退 / 前进）。
  it("R11 意图恢复出来的打开（甲 → 未绑定 → 甲）：被点的按钮已不在文档里，Escape 后焦点回顶栏按钮；树里没有选中的文件", async () => {
    installNarrowViewport();
    const snapshot = changedTurn(write("notes.md"));
    const unbound = {
      ...snapshot.session,
      id: "c".repeat(32),
      title: "未绑定会话",
      workspaceId: null,
    };
    const { router } = await openPage(
      snapshot,
      project({
        ...NOTES,
        "/api/sessions": () => jsonResponse({ sessions: [snapshot.session, unbound] }),
        [messagesPath(unbound.id)]: () =>
          jsonResponse({ ...turn("done", { content: "没有空间" }, null), session: unbound }),
      }),
    );
    const { opener } = await openFromCard();

    await act(() => router.navigate(`/?session=${unbound.id}`));
    await crumb(unbound.title);
    expect(screen.queryByRole("dialog", { name: NAME })).toBeNull();
    await act(() => router.navigate(SESSION));
    await crumb("saved title");
    const layer = await screen.findByRole("dialog", { name: NAME });
    await within(layer).findByRole("button", { name: "notes.md" });
    await yieldMacrotask();
    expect(opener.isConnected).toBe(false);
    expect(selectedRows(layer)).toStrictEqual([]);
    await pressEscape();

    await focusOn(sidebarButton());
  });
});

describe("文件已不存在", () => {
  /** 跑一例并断「没有未处理的拒绝、没有 Toast」。 */
  async function withoutNoise(run: () => Promise<void>) {
    const rejections = observeUnhandledRejections();
    try {
      await run();
      await settled();
      expect(rejections.unhandled).toStrictEqual([]);
      expect(document.querySelector(".ui-toast")).toBeNull();
    } finally {
      rejections.stop();
    }
  }

  it("R5 out/gone.md 不在 out 的列表里：侧边栏打开并展开到 out，预览区是 文件不存在，没有对它的 file 请求", () =>
    withoutNoise(async () => {
      const { fetchMock } = await openPage(
        changedTurn(write("out/gone.md")),
        project({
          [ROOT]: listing("", [dir("out"), file("readme.md")]),
          [OUT]: listing("out", [file("b.md")]),
        }),
      );

      const { region } = await reveal("out/gone.md");

      expect(await within(preview(region)).findByText(MISSING, { exact: true })).toBeTruthy();
      expect(button(region, "折叠 out").getAttribute("aria-expanded")).toBe("true");
      expect(rowNames(region)).toStrictEqual(["项目", "out", "b.md", "readme.md"]);
      expect(selectedRows(region)).toStrictEqual([]);
      await settled();
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
      expect(fileRequests(fetchMock)).toStrictEqual([]);
      expect(currentLocation()).toBe(SESSION);
    }));

  it("R5 out 也已不存在：照样请求 out，停在根，预览区是服务端的 404 文案，没有 file 请求", () =>
    withoutNoise(async () => {
      const { fetchMock } = await openPage(
        changedTurn(write("out/gone.md")),
        project({
          [ROOT]: listing("", [file("readme.md")]),
          [OUT]: () => envelope(404, "not_found", NOT_FOUND),
        }),
      );

      const { region } = await reveal("out/gone.md");

      expect(await within(preview(region)).findByText(NOT_FOUND, { exact: true })).toBeTruthy();
      expect(rowNames(region)).toStrictEqual(["项目", "readme.md"]);
      expect(selectedRows(region)).toStrictEqual([]);
      await settled();
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
      expect(fileRequests(fetchMock)).toStrictEqual([]);
    }));

  it("R5 父目录的列表里仍有它而 file 返回 404：该行被选中，预览区是服务端的不存在文案", () =>
    withoutNoise(async () => {
      const { fetchMock } = await openPage(
        changedTurn(write("gone.md")),
        project({
          [ROOT]: listing("", [file("gone.md")]),
          [fileOf(PROJ.id, "gone.md")]: () => envelope(404, "not_found", NOT_FOUND),
        }),
      );

      const { region } = await reveal("gone.md");

      expect(await within(preview(region)).findByText(NOT_FOUND, { exact: true })).toBeTruthy();
      expect(selectedRows(region)).toStrictEqual(["gone.md"]);
      expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "gone.md")]);
    }));
});

describe("路径只是交给浏览器的数据", () => {
  it("R12 改动路径含 .. 段（../x）：既有的 normalizedPath 拦下它，除对根的一次 tree 之外不发任何请求，预览区是 文件不存在", async () => {
    const { fetchMock } = await openPage(changedTurn(write("../x")), project());

    const { region } = await reveal("../x");

    expect(await within(preview(region)).findByText(MISSING, { exact: true })).toBeTruthy();
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
    expect(selectedRows(region)).toStrictEqual([]);
    expect(currentLocation()).toBe(SESSION);
  });
});

describe("只看本会话改动 开着时定位", () => {
  /** 打开侧边栏、选中 `readme.md`（必要时先展开 `src` 与 `deep`），再打开过滤开关。 */
  async function filtered(loadParents: boolean) {
    const page = await openPage(changedTurn(edit(APP, 2, 1)), project());
    const { region } = await openSidebar("readme.md");
    if (loadParents) {
      fireEvent.click(button(region, "展开 src"));
      fireEvent.click(await within(region).findByRole("button", { name: "展开 deep" }));
      await within(region).findByRole("button", { name: "app.ts" });
    }
    fireEvent.click(button(region, "readme.md"));
    await previewShows(region, README_TEXT);
    fireEvent.click(button(region, ONLY));
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(rowNames(region)).toStrictEqual(["项目", "src", "deep", "app.ts"]);
    await settled();
    return { ...page, region };
  }

  it("R6 各级父目录都已加载：照常选中并显示预览，开关仍是开的，不为此请求任何 tree", async () => {
    const { fetchMock, region } = await filtered(true);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, DEEP]);

    clickDetail(APP);

    await selected(region, "app.ts");
    await previewShows(region, APP_SOURCE);
    await settled();
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, DEEP]);
    expect(rowNames(region)).toStrictEqual(["项目", "src", "deep", "app.ts"]);
  });

  it("R6 父目录未加载（已知表现，#1372）：该行可见但不被选中，原选中与预览保持，没有任何文案，不请求 tree 也不请求它的 file", async () => {
    const { fetchMock, region } = await filtered(false);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    const before = preview(region).textContent;

    clickDetail(APP);
    await settled();

    expect(button(region, "app.ts").getAttribute("aria-current")).toBeNull();
    expect(selectedRows(region)).toStrictEqual([]);
    expect(preview(region).textContent).toBe(before);
    expect(preview(region).textContent).toContain(README_TEXT);
    expect(within(region).queryByText(MISSING)).toBeNull();
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md")]);

    // 关掉开关：原来选中的 readme.md 仍是选中的，定位没有留下别的选中。
    fireEvent.click(button(region, ONLY));
    expect(selectedRows(region)).toStrictEqual(["readme.md"]);
  });

  it("R6 父目录已加载而列表里没有它：与开关关着时相同，原选中被清掉，预览区是 文件不存在，开关仍是开的，不请求 tree 也不请求它的 file", async () => {
    const { fetchMock } = await openPage(
      changedTurn(write("out/gone.md")),
      project({
        [ROOT]: listing("", [dir("out"), file("readme.md")]),
        [OUT]: listing("out", [file("b.md")]),
      }),
    );
    const { region } = await openSidebar("readme.md");
    fireEvent.click(button(region, "展开 out"));
    await within(region).findByRole("button", { name: "b.md" });
    fireEvent.click(button(region, "readme.md"));
    await previewShows(region, README_TEXT);
    fireEvent.click(button(region, ONLY));
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    await settled();
    expect(selectedRows(region)).toStrictEqual([]);
    expect(preview(region).textContent).toContain(README_TEXT);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);

    clickDetail("out/gone.md");

    expect(await within(preview(region)).findByText(MISSING, { exact: true })).toBeTruthy();
    await settled();
    expect(preview(region).textContent).not.toContain(README_TEXT);
    expect(selectedRows(region)).toStrictEqual([]);
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, OUT]);
    expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, "readme.md")]);

    // 关掉开关：先前选中的 readme.md 不再是选中的。
    fireEvent.click(button(region, ONLY));
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("false");
    expect(selectedRows(region)).toStrictEqual([]);
  });
});

describe("换会话与关闭后重开", () => {
  it("R7 在甲点 查看详情、src 的 tree 还挂着时切到同空间的乙：乙的树只请求根、没有选中，迟到的响应不改变它；切回甲也不重新定位", async () => {
    const late = deferred<Response>();
    const snapshot = changedTurn(edit(APP, 2, 1));
    const neighbour = { ...snapshot.session, id: "a".repeat(32), title: "邻居会话" };
    const { fetchMock } = await openPage(
      snapshot,
      project({
        ...withNeighbour(snapshot),
        [messagesPath(neighbour.id)]: () =>
          jsonResponse({ ...turn("done", { content: "邻居的回答" }), session: neighbour }),
        [SRC]: () => late.promise,
      }),
    );

    await reveal(APP);
    await waitFor(() => expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC]));
    await selectSession(neighbour);

    const second = await screen.findByRole("complementary", { name: NAME });
    await within(second).findByRole("button", { name: "readme.md" });
    await arrive(late, "src", [dir("deep")]);
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, ROOT]);
    expect(selectedRows(second)).toStrictEqual([]);
    expect(within(preview(second)).getByText("未选择文件")).toBeTruthy();
    expect(fileRequests(fetchMock)).toStrictEqual([]);

    await selectSession({ title: "saved title" });

    const back = await screen.findByRole("complementary", { name: NAME });
    await within(back).findByRole("button", { name: "readme.md" });
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, ROOT, ROOT]);
    expect(selectedRows(back)).toStrictEqual([]);
    expect(fileRequests(fetchMock)).toStrictEqual([]);
  });

  it.each([
    ["头部的 关闭", (region: HTMLElement) => button(region, CLOSE)],
    ["顶栏按钮", (_region: HTMLElement, top: HTMLElement) => top],
  ])(
    "R8 定位之后用%s关掉，再用顶栏按钮打开：没有选中的文件，预览区是 未选择文件",
    async (_name, closer) => {
      const { fetchMock } = await openPage(changedTurn(edit(APP, 2, 1)), project());
      const top = sidebarButton();
      const { region } = await reveal(APP);
      await selected(region, "app.ts");
      await previewShows(region, APP_SOURCE);

      fireEvent.click(closer(region, top));

      expect(sidebarRegion()).toBeNull();
      const reopened = (await openSidebar("readme.md")).region;
      await settled();
      expect(selectedRows(reopened)).toStrictEqual([]);
      expect(within(preview(reopened)).getByText("未选择文件")).toBeTruthy();
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT, SRC, DEEP, ROOT]);
      expect(fileRequests(fetchMock)).toStrictEqual([fileOf(PROJ.id, APP)]);
    },
  );

  it("R8 宽屏头部的 关闭 之后焦点回顶栏按钮，不回被点的 查看详情", async () => {
    await openPage(changedTurn(edit(APP, 2, 1)), project());
    const { opener, region } = await reveal(APP);
    await selected(region, "app.ts");
    expect(document.activeElement).toBe(opener);

    fireEvent.click(button(region, CLOSE));

    expect(sidebarRegion()).toBeNull();
    expect(document.activeElement).toBe(sidebarButton());
  });
});
