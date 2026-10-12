/**
 * Issue #1106 侧边栏的本会话改动（tasks 24.1、24.2，分摊的 24.4）：workspace-sidebar「本会话改动标记与
 * 过滤」的三个场景，以及「内容与文件操作」的「没有空间级入口」「在文件页打开」与树区的折叠。接缝：
 * 真实外壳里的整页（桩掉的 `fetch` 与事件连接）；请求数取自 `fetch` 桩的调用记录。期望值是规格里的
 * 字面量；过滤后各行的次序按 files-web「工作空间浏览器组件」的规定写出（同级目录在前，再按名字）。
 *
 * jsdom 没有布局：折叠后预览区是否占满只在功能验收清单 CH-101 里看；这里证到树栏带 `hidden` 属性
 * （按角色查不到）而节点还在。
 */
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantMessage,
  edit,
  goLive,
  listed,
  openSession,
  PROJ,
  quiesce,
  type Snapshot,
  toolStep,
  turn,
  write,
} from "./chat-page-file-changes-support.js";
import { envelope } from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, crumb } from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { historyUser, observeUnhandledRejections } from "./chat-stream-support.js";
import {
  BOUND,
  CLOSE,
  dir,
  file,
  fileOf,
  listing,
  mountSidebarPage,
  NAME,
  OPEN_IN_FILES,
  openSidebar,
  SAME_SPACE,
  selectSession,
  TEMPORARY,
  treeOf,
} from "./chat-workspace-sidebar-support.js";
import { issued, shownFrame } from "./files-site-fixture.js";
import { type FetchMock, paths, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const MARK = "本会话已改动";
const ONLY = "只看本会话改动";
const COLLAPSE = "折叠文件树";
const EXPAND = "展开文件树";
const NO_CHANGES = "本会话暂无文件改动";
const TREE = "工作空间目录树";
/** 服务端 `not_found` 信封的文案。 */
const NOT_FOUND = "请求的资源不存在";
const ROOT = treeOf(PROJ.id);
const SRC = treeOf(PROJ.id, "src");
const OUT = treeOf(PROJ.id, "out");

afterEach(cleanupSessionMeta);

/**
 * PROJ 的目录：根下 `deep`、`out`、`src` 三个目录与 `draft.md`、`readme.md`；`out` 里是 `b.md` 与
 * `index.html`，`src` 里是 `app.ts` 与 `util.ts`，`deep` 里是 `x.md`（用例都不展开它）。
 */
function project(extra: FetchRoutes = {}): FetchRoutes {
  return {
    [ROOT]: listing("", [dir("deep"), dir("out"), dir("src"), file("draft.md"), file("readme.md")]),
    [treeOf(PROJ.id, "deep")]: listing("deep", [file("x.md")]),
    [OUT]: listing("out", [file("b.md"), file("index.html")]),
    [SRC]: listing("src", [file("app.ts"), file("util.ts")]),
    [fileOf(PROJ.id, "readme.md")]: () => textPreviewResponse("自述正文"),
    [`/api/workspaces/${PROJ.id}/preview-token`]: () => issued(),
    ...extra,
  };
}

/**
 * 规格场景「标记」的会话：第一条助手消息的已结束步骤改了 `src/app.ts` 与 `more`；第二条（id 2，状态
 * `last`）的已结束步骤改了 `src/app.ts`、`out/index.html`，`last` 为 running 时另有一个 running 步骤
 * （id 3）带着 `draft.md`。`more` 只在第一条消息里：只看最后一条消息的聚合会漏掉它。
 */
function twoTurns(last: "done" | "running", ...more: ReturnType<typeof write>[]): Snapshot {
  const pending = toolStep(3, 1, "write", [write("draft.md")], "running");
  return {
    ...turn(last),
    messages: [
      historyUser,
      assistantMessage("done", {
        steps: [toolStep(1, 0, "edit", [edit("src/app.ts", 1, 0), ...more])],
      }),
      { ...historyUser, id: 1, content: "再改一次", createdAt: 1 },
      assistantMessage(last, {
        id: 2,
        createdAt: 2,
        steps: [
          toolStep(2, 0, "write", [edit("src/app.ts", 2, 1), write("out/index.html")]),
          ...(last === "running" ? [pending] : []),
        ],
      }),
    ],
  };
}

/** 在 PROJ 上打开 `snapshot` 的会话页与侧边栏，等到根目录里的 `readme.md` 出现。 */
async function openChanges(snapshot: Snapshot, extra: FetchRoutes = {}) {
  const page = await openSession(snapshot, listed, project(extra));
  await crumb("saved title");
  const { region } = await openSidebar("readme.md");
  return { ...page, region };
}

/** 展开 `out` 与 `src`，等到两层的文件行都出现。 */
async function expandOutAndSrc(region: HTMLElement) {
  fireEvent.click(within(region).getByRole("button", { name: "展开 out" }));
  fireEvent.click(within(region).getByRole("button", { name: "展开 src" }));
  await within(region).findByRole("button", { name: "index.html" });
  await within(region).findByRole("button", { name: "app.ts" });
}

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole<HTMLButtonElement>("button", { name });

/** 对 PROJ 发出的全部 `tree` 请求，按调用顺序。 */
function treeRequests(fetchMock: FetchMock) {
  return paths(fetchMock).filter((path) => path.startsWith(`/api/workspaces/${PROJ.id}/tree?`));
}

/** 树上各行的名字，自上而下；树栏收起时照样读（直接在 DOM 里找）。 */
function rowNames(scope: HTMLElement) {
  return [...scope.querySelectorAll('[data-slot="tree-name"]')].map((node) => node.textContent);
}

/** 带标记的行，自上而下：`[行名, 标记的文本]`。 */
function markedRows(scope: HTMLElement) {
  return [...scope.querySelectorAll('[data-slot="tree-mark"]')].map((mark) => [
    mark.parentElement?.querySelector(':scope > button [data-slot="tree-name"]')?.textContent,
    mark.textContent,
  ]);
}

/** 行按钮经 `aria-describedby` 得到的描述；没有该属性时为 `null`。 */
function description(row: HTMLElement) {
  const id = row.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? "");
}

/** 让已发出的请求与随后的渲染落地，之后再断「没有新的请求」。 */
async function settled() {
  await quiesce();
  await yieldMacrotask();
}

describe("本会话改动标记与过滤", () => {
  it("C1 标记：两条助手消息的已结束步骤改过的文件与其各级父目录带 本会话已改动，running 步骤的不带；该步骤结束后带上", async () => {
    const { region } = await openChanges(twoTurns("running"));
    const send = await goLive();
    await expandOutAndSrc(region);

    const FOUR = [
      ["out", MARK],
      ["index.html", MARK],
      ["src", MARK],
      ["app.ts", MARK],
    ];
    expect(markedRows(region)).toStrictEqual(FOUR);
    // 标记不改行的可访问名：文件行恰为文件名，目录行仍是「折叠 <名字>」。
    expect(description(button(region, "app.ts"))).toBe(MARK);
    expect(description(button(region, "index.html"))).toBe(MARK);
    expect(description(button(region, "折叠 src"))).toBe(MARK);
    expect(description(button(region, "折叠 out"))).toBe(MARK);
    for (const name of ["draft.md", "readme.md", "util.ts", "b.md", "展开 deep", "折叠 项目"]) {
      expect(description(button(region, name))).toBeNull();
    }

    send("step.end", { messageId: 2, stepId: 3, status: "done", output: "ok" });

    await waitFor(() => expect(markedRows(region)).toStrictEqual([...FOUR, ["draft.md", MARK]]));
    expect(description(button(region, "draft.md"))).toBe(MARK);
  });

  it("C2 只看改动：树恰为改动路径的三支且各级展开，打开开关与其后的 刷新 都不请求 tree；关掉后完整的树、原展开与过滤期间的选中都在", async () => {
    const { fetchMock, region } = await openChanges(twoTurns("running", write("deep/x.md")));
    await expandOutAndSrc(region);
    const FULL = [
      "项目",
      "deep",
      "out",
      "b.md",
      "index.html",
      "src",
      "app.ts",
      "util.ts",
      "draft.md",
      "readme.md",
    ];
    const LOADED = [ROOT, OUT, SRC];
    expect(rowNames(region)).toStrictEqual(FULL);
    expect(treeRequests(fetchMock)).toStrictEqual(LOADED);
    const toggle = button(region, ONLY);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(rowNames(region)).toStrictEqual([
      "项目",
      "deep",
      "x.md",
      "out",
      "index.html",
      "src",
      "app.ts",
    ]);
    for (const name of ["deep", "out", "src"]) {
      expect(button(region, `折叠 ${name}`).getAttribute("aria-expanded")).toBe("true");
    }
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual(LOADED);

    fireEvent.click(button(region, "刷新"));
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual(LOADED);

    fireEvent.click(button(region, "index.html"));
    expect(region.contains(await shownFrame("index.html"))).toBe(true);
    expect(button(region, "index.html").getAttribute("aria-current")).toBe("true");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(rowNames(region)).toStrictEqual(FULL));
    expect(button(region, "index.html").getAttribute("aria-current")).toBe("true");
    expect(region.contains(await shownFrame("index.html"))).toBe(true);
    expect(button(region, "展开 deep").getAttribute("aria-expanded")).toBe("false");
    expect(button(region, "折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(button(region, "折叠 src").getAttribute("aria-expanded")).toBe("true");
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual(LOADED);
  });

  it("C3 空集合：没有任何改动的会话打开开关后树的位置是 本会话暂无文件改动，不是空工作空间的提示，也不请求 tree；关掉后树回来", async () => {
    const { fetchMock, region } = await openChanges(turn("done", { content: "只有文字的回答" }));
    expect(markedRows(region)).toStrictEqual([]);

    fireEvent.click(button(region, ONLY));

    expect(within(region).getByText(NO_CHANGES, { exact: true })).toBeTruthy();
    expect(within(region).queryByRole("navigation", { name: TREE })).toBeNull();
    expect(within(region).queryByText("该工作空间暂无目录")).toBeNull();
    expect(within(region).queryByRole("button", { name: "readme.md" })).toBeNull();
    await settled();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);

    fireEvent.click(button(region, ONLY));

    expect(within(region).queryByText(NO_CHANGES)).toBeNull();
    expect(button(region, "readme.md")).toBeTruthy();
    expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
  });

  it("C4 已删除的文件：列表里还有的 gone.md 可以选中，预览区是服务端的不存在文案，没有未处理的拒绝；从未展开的 deep 下的 x.md 列出但选不了", async () => {
    const rejections = observeUnhandledRejections();
    try {
      const changed = [write("gone.md"), write("deep/x.md")];
      const { fetchMock, region } = await openChanges(
        turn("done", { steps: [toolStep(1, 0, "write", changed)] }),
        {
          [ROOT]: listing("", [dir("deep"), file("gone.md"), file("readme.md")]),
          [fileOf(PROJ.id, "gone.md")]: () => envelope(404, "not_found", NOT_FOUND),
        },
      );

      fireEvent.click(button(region, ONLY));

      expect(rowNames(region)).toStrictEqual(["项目", "deep", "x.md", "gone.md"]);
      expect(button(region, "折叠 deep").getAttribute("aria-expanded")).toBe("true");
      expect(button(region, "x.md").disabled).toBe(true);
      expect(button(region, "gone.md").disabled).toBe(false);

      fireEvent.click(button(region, "x.md"));
      fireEvent.click(button(region, "gone.md"));

      expect(await within(region).findByText(NOT_FOUND, { exact: true })).toBeTruthy();
      expect(button(region, "gone.md").getAttribute("aria-current")).toBe("true");
      expect(button(region, "x.md").getAttribute("aria-current")).toBeNull();
      await settled();
      expect(treeRequests(fetchMock)).toStrictEqual([ROOT]);
      expect(paths(fetchMock).filter((path) => path.includes("/file?"))).toStrictEqual([
        fileOf(PROJ.id, "gone.md"),
      ]);
      expect(rejections.unhandled).toStrictEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("C5 切换会话重置：打开开关并收起树之后换到同空间的另一个会话，开关是关的、树是展开的；换回来也是", async () => {
    await mountSidebarPage(BOUND);
    const { region } = await openSidebar("readme.md");
    fireEvent.click(button(region, ONLY));
    fireEvent.click(button(region, COLLAPSE));
    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("true");
    expect(button(region, EXPAND)).toBeTruthy();

    for (const session of [SAME_SPACE, BOUND]) {
      await selectSession(session);
      const next = await screen.findByRole("complementary", { name: NAME });
      expect(button(next, ONLY).getAttribute("aria-pressed")).toBe("false");
      expect(button(next, COLLAPSE)).toBeTruthy();
      expect(within(next).queryByRole("button", { name: EXPAND })).toBeNull();
      expect(await within(next).findByRole("button", { name: "readme.md" })).toBeTruthy();
    }
  });
});

describe("内容与文件操作", () => {
  it("C6 折叠文件树：树栏连同 刷新 收起而不卸载，预览还在，焦点留在同一个按钮上；展开后是原来的树，展开与选中不变，没有新的请求", async () => {
    const { fetchMock, region } = await openChanges(twoTurns("done"));
    await expandOutAndSrc(region);
    fireEvent.click(button(region, "readme.md"));
    expect(await within(region).findByText("自述正文")).toBeTruthy();
    const tree = within(region).getByRole("navigation", { name: TREE });
    const rows = rowNames(region);
    const requests = paths(fetchMock);
    const toggle = button(region, COLLAPSE);
    toggle.focus();

    fireEvent.click(toggle);

    expect(within(region).queryByRole("navigation", { name: TREE })).toBeNull();
    expect(within(region).queryByRole("button", { name: "刷新" })).toBeNull();
    expect(within(region).queryByRole("button", { name: "新建" })).toBeNull();
    expect(within(region).queryByRole("button", { name: COLLAPSE })).toBeNull();
    expect(button(region, EXPAND)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(tree.isConnected).toBe(true);
    expect(within(region).getByText("自述正文")).toBeTruthy();
    expect(button(region, ONLY)).toBeTruthy();
    expect(button(region, CLOSE)).toBeTruthy();

    fireEvent.click(toggle);

    expect(within(region).getByRole("navigation", { name: TREE })).toBe(tree);
    expect(button(region, COLLAPSE)).toBe(toggle);
    expect(document.activeElement).toBe(toggle);
    expect(rowNames(region)).toStrictEqual(rows);
    expect(button(region, "折叠 out").getAttribute("aria-expanded")).toBe("true");
    expect(button(region, "折叠 src").getAttribute("aria-expanded")).toBe("true");
    expect(button(region, "readme.md").getAttribute("aria-current")).toBe("true");
    expect(within(region).getByText("自述正文")).toBeTruthy();
    expect(button(region, "刷新")).toBeTruthy();
    await settled();
    expect(paths(fetchMock)).toStrictEqual(requests);
  });

  it("C7 没有空间级入口：有 刷新、只看本会话改动、折叠文件树、关闭工作空间侧边栏；没有 新建工作空间、选择工作空间 与上传", async () => {
    const { region } = await openChanges(twoTurns("done"));

    for (const name of ["刷新", ONLY, COLLAPSE, CLOSE]) {
      expect(within(region).getAllByRole("button", { name })).toHaveLength(1);
    }
    for (const name of ["新建工作空间", "选择工作空间"]) {
      expect(within(region).queryByRole("button", { name })).toBeNull();
      expect(within(region).queryByRole("link", { name })).toBeNull();
    }
    expect(within(region).queryByRole("button", { name: /上传/ })).toBeNull();
    expect(within(region).queryByText(/上传/)).toBeNull();
    expect(region.querySelector('input[type="file"]')).toBeNull();

    // `＋` 菜单里只许有与空间无关的项：`新建文件夹` 在，`新建工作空间` 不在。按下的位置给一个离开原点的
    // 坐标：jsdom 里元素的矩形都在原点，不带坐标的按下会被分栏库当成落在分隔线上（实测，jsdom：焦点
    // 落到分隔线、菜单保持关闭；分栏库在捕获阶段对命中分隔线的 pointerdown 调 `preventDefault` 是读它
    // 的源码得出的）。
    await yieldMacrotask();
    fireEvent.pointerDown(button(region, "新建"), { button: 0, clientX: 500, clientY: 500 });
    expect(await screen.findByRole("menuitem", { name: "新建文件夹" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /工作空间/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /上传/ })).toBeNull();
  });

  it("C8 在文件页打开：过滤下选中的文件进链接的 path；临时空间的会话有开关与折叠，没有这个链接", async () => {
    const page = await openChanges(twoTurns("done"));
    await expandOutAndSrc(page.region);
    fireEvent.click(button(page.region, ONLY));
    fireEvent.click(button(page.region, "index.html"));
    await shownFrame("index.html");

    const link = within(page.region).getByRole<HTMLAnchorElement>("link", { name: OPEN_IN_FILES });
    expect(`${new URL(link.href).pathname}${new URL(link.href).search}`).toBe(
      `/files?ws=${PROJ.id}&path=out%2Findex.html`,
    );

    page.view.unmount();
    await mountSidebarPage(TEMPORARY);
    const { region } = await openSidebar("scratch.txt");

    expect(button(region, ONLY).getAttribute("aria-pressed")).toBe("false");
    expect(button(region, COLLAPSE)).toBeTruthy();
    expect(within(region).queryByRole("link")).toBeNull();
  });
});
