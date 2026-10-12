/**
 * Issue #1105 工作空间侧边栏外壳（tasks 23.4）：workspace-sidebar「顶栏入口与可用性」的两个场景与
 * 「布局与开合」里 jsdom 证得了的部分，另有头部的 `在文件页打开`。接缝：真实外壳里的整页（桩掉的
 * `fetch` 与事件连接）、`localStorage`，以及 `useWorkspaceSidebar` 与 `chatTopbar` 这两个导出。期望值
 * 是规格里的字面量。
 *
 * jsdom 没有布局：并排、无横向溢出、分隔线的拖动与方向键、宽度在刷新后沿用都只在 `make ui-walk`
 * 里证明；这里对宽度只证到 hook 读出与写回的那个数。
 */
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatTopbar } from "../src/features/chat/topbar-actions.js";
import { useWorkspaceSidebar } from "../src/features/chat/use-workspace-sidebar.js";
import {
  goLive,
  listed,
  openSession,
  PROJ,
  ROOT_PREFIX,
  turn,
} from "./chat-page-file-changes-support.js";
import { composer } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, crumb, focusOn } from "./chat-page-session-meta-support.js";
import { FakeEventSource, latestSource } from "./chat-stream-support.js";
import {
  BOUND,
  bannerButtons,
  CLOSE,
  file,
  fileOf,
  listing,
  mountSidebarPage,
  NAME,
  OPEN_IN_FILES,
  OTHER,
  openSidebar,
  SAME_SPACE,
  STORAGE_KEY,
  selectSession,
  sidebarButton,
  sidebarHead,
  sidebarRegion,
  TEMP,
  TEMPORARY,
  treeCalls,
  treeOf,
  UNBOUND,
  W1,
  W2,
} from "./chat-workspace-sidebar-support.js";
import { hasLucideGlyph } from "./files-fixture.js";
import { currentLocation, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";

const WELCOME = "WorkBuddy，我帮你";
const TWO_BUTTONS = ["重命名", "对话内搜索"];
const DEFAULT_SHARE = 40;

afterEach(cleanupSessionMeta);

/** 文件行里被选中的那些的名字。 */
function selectedRows(scope: HTMLElement) {
  return [...scope.querySelectorAll('button[aria-current="true"]')].map(
    (row) => row.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

describe("顶栏入口与可用性", () => {
  it("L1 按钮只在有工作空间的会话上：绑定会话末位是 工作空间侧边栏，未绑定会话与欢迎态没有该按钮，也没有该区域", async () => {
    const { router } = await mountSidebarPage(BOUND);

    expect(bannerButtons()).toEqual([...TWO_BUTTONS, NAME]);
    const button = sidebarButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("title") ?? button.getAttribute("aria-label")).toBe(NAME);
    expect(hasLucideGlyph(button, "folder")).toBe(true);
    expect(sidebarRegion()).toBeNull();

    // 打开之后再离开：下面两处「没有」是在意图为打开时断的。
    await openSidebar("readme.md");
    expect(sidebarButton().getAttribute("aria-expanded")).toBe("true");

    await selectSession(UNBOUND);
    expect(bannerButtons()).toEqual(TWO_BUTTONS);
    expect(sidebarRegion()).toBeNull();
    expect(screen.queryByRole("dialog", { name: NAME })).toBeNull();

    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: WELCOME });
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: NAME })).toBeNull();
    expect(sidebarRegion()).toBeNull();
  });

  it.each([
    ["会话用的是临时空间", TEMPORARY, TEMP, "scratch.txt", {}],
    [
      "工作空间列表读取失败",
      BOUND,
      W1.id,
      "readme.md",
      {
        "/api/workspaces": () =>
          jsonResponse({ error: { code: "internal", message: "服务器内部错误" } }, 500),
      },
    ],
  ])(
    "L2 不在列表里的空间（%s）：照常打开并请求 tree，头部只有 工作空间，没有逻辑路径与 在文件页打开",
    async (_label, session, workspaceId, entry, extra) => {
      const errors = vi.spyOn(console, "error");
      const { fetchMock } = await mountSidebarPage(session, extra);

      const { region } = await openSidebar(entry);

      expect(treeCalls(fetchMock, workspaceId)).toHaveLength(1);
      const head = sidebarHead(region);
      expect(within(head).getByRole("heading", { level: 2 }).textContent).toBe("工作空间");
      expect(head.querySelector("p")).toBeNull();
      expect(region.textContent).not.toContain("zhangsan/");
      expect(within(region).queryByRole("link", { name: OPEN_IN_FILES })).toBeNull();
      expect(within(region).queryByRole("alert")).toBeNull();
      expect(errors).not.toHaveBeenCalled();
    },
  );

  it("L2 空间在列表里时头部是空间名与逻辑路径；页面任何位置不出现空间的磁盘根路径", async () => {
    await mountSidebarPage(BOUND);

    const { region } = await openSidebar("readme.md");

    const head = sidebarHead(region);
    expect(within(head).getByRole("heading", { level: 2 }).textContent).toBe("项目甲");
    expect(head.querySelector("p")?.textContent).toBe("zhangsan/proj-a");
    expect(document.documentElement.innerHTML).not.toContain(ROOT_PREFIX);
  });

  it("useWorkspaceSidebar：未绑定（null）与欢迎态（undefined）没有槽位、不打开，意图留到回到绑定会话时", () => {
    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string | null | undefined }) =>
        useWorkspaceSidebar(workspaceId),
      { initialProps: { workspaceId: W1.id as string | null | undefined } },
    );
    expect([result.current.open, result.current.slot?.expanded]).toEqual([false, false]);

    act(() => result.current.slot?.onSelect(document.createElement("button")));
    expect([result.current.open, result.current.slot?.expanded]).toEqual([true, true]);

    for (const workspaceId of [null, undefined]) {
      rerender({ workspaceId });
      expect(result.current.slot).toBeUndefined();
      expect(result.current.open).toBe(false);
    }

    rerender({ workspaceId: W2.id });
    expect([result.current.open, result.current.slot?.expanded]).toEqual([true, true]);
  });

  it("chatTopbar 在没有选中会话时什么都不上报，给了 workspace 槽位也一样", () => {
    const workspace = { expanded: true, onSelect: vi.fn() };
    expect(
      chatTopbar(undefined, vi.fn(), { expanded: false, onSelect: vi.fn() }, workspace),
    ).toStrictEqual({});
  });

  it("chatTopbar 把 workspace 槽位排在末位，expanded 是真键，触发元素原样交给它", () => {
    const workspace = { expanded: false, onSelect: vi.fn() };

    const report = chatTopbar(BOUND, vi.fn(), { expanded: false, onSelect: vi.fn() }, workspace);

    const last = report.actions?.at(-1);
    expect({ ...last, onSelect: undefined }).toStrictEqual({
      expanded: false,
      icon: "folder",
      key: "workspace",
      label: NAME,
      onSelect: undefined,
    });
    expect(report.actions?.map((action) => action.key)).toEqual(["rename", "search", "workspace"]);
    const trigger = document.createElement("button");
    last?.onSelect(trigger);
    expect(workspace.onSelect.mock.calls).toEqual([[trigger]]);
  });
});

describe("布局与开合", () => {
  it("L3 宽屏：打开后是 complementary 区域与一条分隔线，区域内恰一个 刷新；头部关闭后焦点回顶栏按钮；重新挂载后初始为关闭", async () => {
    const page = await mountSidebarPage(BOUND);

    const { region, trigger } = await openSidebar("readme.md");

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(region.getAttribute("aria-modal")).toBeNull();
    expect(screen.queryByRole("dialog", { name: NAME })).toBeNull();
    expect(screen.getAllByRole("separator")).toHaveLength(1);
    expect(region.contains(screen.getByRole("separator"))).toBe(false);

    // 头部不另放 刷新：浏览器树栏的那一个就是，点它重取根目录。
    const refresh = within(region).getAllByRole("button", { name: "刷新" });
    expect(refresh).toHaveLength(1);
    expect(treeCalls(page.fetchMock, W1.id)).toHaveLength(1);
    fireEvent.click(refresh[0] as HTMLElement);
    await waitFor(() => expect(treeCalls(page.fetchMock, W1.id)).toHaveLength(2));

    const focus = vi.spyOn(trigger, "focus");
    fireEvent.click(within(region).getByRole("button", { name: CLOSE }));

    expect(sidebarRegion()).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(sidebarButton()).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await focusOn(trigger);
    expect(focus.mock.calls).toStrictEqual([[{ preventScroll: true }]]);

    // 再点一次打开，然后整页重新挂载（刷新页面）：开合不跨页面加载保留。
    fireEvent.click(trigger);
    expect(sidebarRegion()).not.toBeNull();
    page.view.unmount();
    await mountSidebarPage(BOUND);

    expect(sidebarButton().getAttribute("aria-expanded")).toBe("false");
    expect(sidebarRegion()).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("L3 再点一次顶栏按钮即关闭（开合切换）", async () => {
    await mountSidebarPage(BOUND);
    const { trigger } = await openSidebar("readme.md");

    fireEvent.click(trigger);

    expect(sidebarRegion()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("L3 没有 ResizeObserver 的运行环境：侧边栏照常出现在对话区之后，没有分隔线，输入框不重挂", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    await mountSidebarPage(BOUND);
    const input = composer();

    const { region } = await openSidebar("readme.md");

    expect(screen.queryByRole("separator")).toBeNull();
    expect(composer()).toBe(input);
    expect(input.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("L4 切换会话保持打开：换成新会话的空间并重置，未绑定会话没有侧边栏，切回后恢复；同空间的两个会话互切也重置", async () => {
    const late = deferredResponse();
    const { fetchMock } = await mountSidebarPage(BOUND, {
      [treeOf(W1.id, "out")]: () => late.promise,
    });
    const { region, trigger } = await openSidebar("readme.md");
    fireEvent.click(within(region).getByRole("button", { name: "readme.md" }));
    expect(await within(region).findByText("自述正文")).toBeTruthy();
    expect(selectedRows(region)).toEqual(["readme.md"]);
    // W1 的 `out` 列表在途时离开。
    fireEvent.click(within(region).getByRole("button", { name: "展开 out" }));
    await waitFor(() => expect(treeCalls(fetchMock, W1.id, "out")).toHaveLength(1));

    await selectSession(OTHER);

    const second = await screen.findByRole("complementary", { name: NAME });
    expect(await within(second).findByRole("button", { name: "w2.txt" })).toBeTruthy();
    expect(sidebarButton()).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(treeCalls(fetchMock, W2.id)).toHaveLength(1);
    expect(selectedRows(second)).toEqual([]);
    expect(within(second).queryByText("自述正文")).toBeNull();
    expect(within(second).queryByRole("button", { name: "readme.md" })).toBeNull();
    expect(treeCalls(fetchMock, W1.id, "out")[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve(jsonResponse({ path: "out", entries: [file("late.md")] }));
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "late.md" })).toBeNull();

    await selectSession(UNBOUND);
    expect(sidebarRegion()).toBeNull();
    expect(bannerButtons()).toEqual(TWO_BUTTONS);

    await selectSession(BOUND);
    const restored = await screen.findByRole("complementary", { name: NAME });
    expect(await within(restored).findByRole("button", { name: "readme.md" })).toBeTruthy();
    expect(sidebarButton().getAttribute("aria-expanded")).toBe("true");
    expect(treeCalls(fetchMock, W1.id)).toHaveLength(2);
    expect(selectedRows(restored)).toEqual([]);

    // 同空间的两个会话互切：选中的文件与预览同样重置（规格「目录树、当前文件与预览重置」）。
    fireEvent.click(within(restored).getByRole("button", { name: "readme.md" }));
    expect(await within(restored).findByText("自述正文")).toBeTruthy();
    await selectSession(SAME_SPACE);
    const same = await screen.findByRole("complementary", { name: NAME });
    expect(await within(same).findByRole("button", { name: "readme.md" })).toBeTruthy();
    expect(selectedRows(same)).toEqual([]);
    expect(within(same).queryByText("自述正文")).toBeNull();
    expect(treeCalls(fetchMock, W1.id)).toHaveLength(3);
  });

  it("L5 不打断回合：生成中打开再关闭，事件连接还是那一条，回答继续输出，草稿与输入框节点不变，生成中 与 停止 一直在", async () => {
    await openSession(turn("running", { content: "前半句" }), listed, {
      [treeOf(PROJ.id)]: listing("", [file("readme.md")]),
    });
    await crumb("saved title");
    const send = await goLive();
    const source = latestSource();
    const connections = FakeEventSource.instances.length;
    expect(connections).toBeGreaterThan(0);
    const input = composer();
    fireEvent.change(input, { target: { value: "没写完的草稿" } });
    const generating = () => [
      screen.queryAllByText("生成中").length,
      screen.queryAllByRole("button", { name: "停止" }).length,
    ];
    expect(generating()).toEqual([1, 1]);

    const { region } = await openSidebar("readme.md");
    send("text.delta", { delta: "，后半句" });

    expect(await screen.findByText("前半句，后半句")).toBeTruthy();
    expect(generating()).toEqual([1, 1]);

    fireEvent.click(within(region).getByRole("button", { name: CLOSE }));
    send("text.delta", { delta: "。" });

    expect(await screen.findByText("前半句，后半句。")).toBeTruthy();
    expect(sidebarRegion()).toBeNull();
    expect(generating()).toEqual([1, 1]);
    expect(composer()).toBe(input);
    expect(input.value).toBe("没写完的草稿");
    expect(FakeEventSource.instances).toHaveLength(connections);
    expect(latestSource()).toBe(source);
    expect(source.closeCount).toBe(0);
  });

  describe("L6 存储值不合法", () => {
    const share = () => renderHook(() => useWorkspaceSidebar(W1.id)).result.current.share;

    it.each([
      ["无法解析的字符串", "abc"],
      ["空串", ""],
      ["NaN", "NaN"],
      ["负数", "-5"],
      ["零", "0"],
      ["一百", "100"],
      ["大于一百", "100.5"],
      ["超大值", "1e9"],
      ["十六进制写法", "0x21"],
      ["科学计数法", "3.3e1"],
      ["带空白", " 33 "],
      ["JSON 对象", '{"share":40}'],
    ])("%s 回缺省宽度，侧边栏照常打开，没有 console error", async (_label, raw) => {
      const errors = vi.spyOn(console, "error");
      window.localStorage.setItem(STORAGE_KEY, raw);

      expect(share()).toBe(DEFAULT_SHARE);

      await mountSidebarPage(BOUND);
      await openSidebar("readme.md");
      expect(errors).not.toHaveBeenCalled();
    });

    it("localStorage 读取抛错回缺省宽度，侧边栏照常打开，没有 console error", async () => {
      const errors = vi.spyOn(console, "error");
      const read = Storage.prototype.getItem;
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(function guarded(
        this: Storage,
        key,
      ) {
        if (key === STORAGE_KEY) throw new DOMException("denied", "SecurityError");
        return read.call(this, key);
      });

      expect(share()).toBe(DEFAULT_SHARE);

      await mountSidebarPage(BOUND);
      await openSidebar("readme.md");
      expect(errors).not.toHaveBeenCalled();
    });

    it.each([
      ["贴近零", "0.5", 0.5],
      ["贴近一百", "99.5", 99.5],
      ["带小数", "33.5", 33.5],
    ])("0 与 100 之间的值（%s）原样读出", (_label, raw, expected) => {
      window.localStorage.setItem(STORAGE_KEY, raw);

      expect(share()).toBe(expected);
    });

    it("resize 写回存储，下一次挂载读出同一个数；写入抛错时这一页仍用新宽度，没有 console error", () => {
      const errors = vi.spyOn(console, "error");
      const first = renderHook(() => useWorkspaceSidebar(W1.id));
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

      act(() => first.result.current.resize(52.25));

      expect(first.result.current.share).toBe(52.25);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("52.25");
      expect(share()).toBe(52.25);

      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError");
      });
      act(() => first.result.current.resize(30));

      expect(first.result.current.share).toBe(30);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("52.25");
      expect(errors).not.toHaveBeenCalled();
    });
  });
});

describe("在文件页打开", () => {
  /** 链接地址里的查询参数，按出现顺序。 */
  function linkParams(scope: HTMLElement) {
    const link = within(scope).getByRole<HTMLAnchorElement>("link", { name: OPEN_IN_FILES });
    const url = new URL(link.href);
    return { path: url.pathname, query: [...url.searchParams.entries()] };
  }

  it("L7 没有选中文件时只带 ws；选中后带上该文件的路径，点它到文件页并选中同一个文件", async () => {
    await mountSidebarPage(BOUND);
    const { region } = await openSidebar("readme.md");

    expect(linkParams(region)).toStrictEqual({ path: "/files", query: [["ws", W1.id]] });

    fireEvent.click(within(region).getByRole("button", { name: "展开 out" }));
    fireEvent.click(await within(region).findByRole("button", { name: "a.md" }));
    expect(await within(region).findByText("甲的正文")).toBeTruthy();

    expect(linkParams(region)).toStrictEqual({
      path: "/files",
      query: [
        ["ws", W1.id],
        ["path", "out/a.md"],
      ],
    });
    // 当前文件不进会话页的地址。
    expect(currentLocation()).toBe(`/?session=${BOUND.id}`);

    fireEvent.click(within(region).getByRole("link", { name: OPEN_IN_FILES }));

    await waitFor(() => expect(currentLocation()).toBe(`/files?ws=${W1.id}&path=out%2Fa.md`));
    const tree = await screen.findByRole("navigation", { name: "工作空间目录树" });
    const row = await within(tree).findByRole("button", { name: "a.md" });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
  });

  it.each([
    ["首尾空格", " 首尾 空格.md "],
    ["前导斜杠、.. 段、合成与分解字符、& 与 #", "/../é é&ws=x#h.md"],
  ])("L7 路径原样进查询参数（%s）", async (_label, name) => {
    await mountSidebarPage(BOUND, {
      [treeOf(W1.id)]: listing("", [file(name)]),
      [fileOf(W1.id, name)]: () => textPreviewResponse("怪名字的正文"),
    });
    fireEvent.click(sidebarButton());
    const region = await screen.findByRole("complementary", { name: NAME });
    const row = await waitFor(() => {
      const found = [...region.querySelectorAll("button")].find(
        (button) => button.getAttribute("title") === name,
      );
      if (!found) throw new Error("文件行还没出现");
      return found;
    });

    fireEvent.click(row);
    expect(await within(region).findByText("怪名字的正文")).toBeTruthy();

    expect(linkParams(region).query).toStrictEqual([
      ["ws", W1.id],
      ["path", name],
    ]);
  });
});
