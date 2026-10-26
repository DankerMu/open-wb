// files-web「工作空间浏览器组件」里 #1372 的那一部分：`onlyPaths` 下行都可选中、已不存在的路径不成行
// 或被移出（两种记录与它们的作废），`clearMissing`（会话页侧边栏专用）与句柄 `reported`。规则的全文在
// workspace-sidebar「本会话改动标记与过滤」；整页的场景在 chat-workspace-sidebar-filter-select.test.tsx。
// 组件直接渲染、不挂路由；请求取自 fetch 桩的调用记录，路由值是函数（多发的请求留在记录里，由对整份
// 记录的相等断言判红）。
// 「键盘可选中」在这里证到行是没有 `disabled` 的原生 `button`、拿得到焦点：jsdom 不把 Enter / 空格
// 合成为 click，按键激活是浏览器对原生按钮的行为，真实浏览器里的那一步在功能验收清单 CH-101。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { deferred, observeUnhandledRejections } from "./chat-stream-support.js";
import { cleanupFilesFixture, type FetchRoutes } from "./files-fixture.js";
import { createFetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
const ROOT = `${API}/tree?path=`;
const fileOf = (path: string) => `${API}/file?path=${encodeURIComponent(path)}`;
const ARCHIVE = `${API}/archive?path=a.zip`;
const EMPTY_TEXT = "这里没有要显示的文件";
const MISSING = "文件不存在";
/** 服务端 `not_found` 信封的文案。 */
const NOT_FOUND = "请求的资源不存在";
const FAILED = "文件读取失败";

const dirEntry = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
const fileEntry = (name: string) => ({ name, type: "file", size: 4, mtime: 200 });
const notFound = () => jsonResponse({ error: { code: "not_found", message: NOT_FOUND } }, 404);
const failed = () => jsonResponse({ error: { code: "internal", message: FAILED } }, 500);
const text = (body: string) => () => textPreviewResponse(body);
const listing = (path: string, names: readonly string[], dirs: readonly string[] = []) =>
  jsonResponse({ path, entries: [...dirs.map(dirEntry), ...names.map(fileEntry)] });

type Extra = Pick<ComponentProps<typeof WorkspaceBrowser>, "clearMissing" | "onlyPaths">;

/**
 * 以页面那样的宿主渲染：`path` 是宿主的状态，`onPathChange` 先记一笔再写回；`onlyPathsEmpty` 恒给。
 * `setPath` 从外面改 `path` 属性，`update` 换 `onlyPaths` / `clearMissing`（不重挂）。
 */
function mount(table: FetchRoutes, extra: Extra = {}) {
  const fetchMock = createFetchMock(table);
  vi.stubGlobal("fetch", fetchMock);
  const client = createApiClient();
  const handle = createRef<WorkspaceBrowserHandle>();
  const onPathChange = vi.fn<(path: string | null) => void>();
  let setPath: (path: string | null) => void = () => {};

  function Host(props: Extra) {
    const [path, set] = useState<string | null>(null);
    setPath = set;
    return (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        name="设计文档"
        onlyPathsEmpty={EMPTY_TEXT}
        onPathChange={(next) => {
          onPathChange(next);
          set(next);
        }}
        path={path}
        ref={handle}
        workspaceId="workspace-1"
        {...props}
      />
    );
  }

  const view = render(<Host {...extra} />);
  return {
    browser: () => {
      if (!handle.current) throw new Error("WorkspaceBrowser 没有交出句柄");
      return handle.current;
    },
    onPathChange,
    requests: () => paths(fetchMock),
    setPath: (path: string | null) => act(() => setPath(path)),
    update: (props: Extra) => view.rerender(<Host {...props} />),
  };
}

const column = () => document.querySelector('aside[aria-label="工作空间文件"]') as HTMLElement;
const pane = () => within(screen.getByRole("region", { name: "文件预览" }));

/** 树上各行的名字，自上而下；树的位置上是空集文案时为空数组。 */
function rows() {
  return [...column().querySelectorAll('[data-slot="tree-name"]')].map((node) => node.textContent);
}

function row(name: string) {
  return within(column()).getByRole<HTMLButtonElement>("button", { name });
}

function selectedRows() {
  return [...column().querySelectorAll('button[aria-current="true"]')].map(
    (node) => node.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

/** 预览区是未选状态：没有文案、没有预览头；页面上没有 `文件不存在` 与服务端的不存在文案。 */
function expectCleared() {
  expect(pane().getByText("未选择文件", { exact: true })).toBeTruthy();
  expect(pane().queryByRole("alert")).toBeNull();
  expect(document.querySelector('[data-slot="preview-header"]')).toBeNull();
  expect(selectedRows()).toStrictEqual([]);
  expect(screen.queryByText(MISSING)).toBeNull();
  expect(screen.queryByText(NOT_FOUND)).toBeNull();
}

async function settle() {
  await act(async () => {
    await yieldMacrotask();
    await yieldMacrotask();
  });
}

afterEach(cleanupFilesFixture);

describe("onlyPaths 下的行", () => {
  it("父目录未加载的行不带 disabled、拿得到焦点，点选后恰一次 file、上报路径，预览头没有大小与修改时间；全程没有 tree 请求", async () => {
    const { onPathChange, requests } = mount(
      { [fileOf("deep/x.md")]: text("深处的正文") },
      { onlyPaths: new Set(["deep/x.md"]) },
    );

    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]);
    expect(row("x.md").disabled).toBe(false);
    expect(row("x.md").tagName).toBe("BUTTON");
    row("x.md").focus();
    expect(document.activeElement).toBe(row("x.md"));
    fireEvent.click(row("x.md"));

    expect(await pane().findByText("深处的正文", { exact: true })).toBeTruthy();
    expect(selectedRows()).toStrictEqual(["x.md"]);
    expect(document.querySelector('[data-slot="preview-path"]')?.textContent).toBe("deep/x.md");
    expect(document.querySelector('[data-slot="preview-meta"]')).toBeNull();
    expect(pane().getByRole("link", { name: "下载 x.md" })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([fileOf("deep/x.md")]);
    expect(onPathChange.mock.calls).toStrictEqual([["deep/x.md"]]);
  });

  it("父目录已加载而列表里没有的路径不成行，没有对它的请求；path 与句柄 reveal 定位到它都清掉选中，不请求", async () => {
    const { browser, onPathChange, requests, setPath, update } = mount({
      [ROOT]: () => listing("", ["keep.md"]),
      [fileOf("keep.md")]: text("留下的正文"),
    });
    await within(column()).findByRole("button", { name: "keep.md" });

    update({ onlyPaths: new Set(["keep.md", "old.md"]) });

    expect(rows()).toStrictEqual(["设计文档", "keep.md"]);
    fireEvent.click(row("keep.md"));
    expect(await pane().findByText("留下的正文", { exact: true })).toBeTruthy();

    // 句柄的定位上报：清掉了选中就报一次 `null`。
    act(() => browser().reveal("old.md"));
    await settle();
    expect(pane().getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(selectedRows()).toStrictEqual([]);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], [null]]);

    // `path` 属性的定位不上报；没有 `clearMissing` 时预览区是既有的 `文件不存在`。
    fireEvent.click(row("keep.md"));
    expect(await pane().findByText("留下的正文", { exact: true })).toBeTruthy();
    await setPath("old.md");
    await settle();
    expect(pane().getByRole("alert").textContent).toBe(MISSING);
    expect(selectedRows()).toStrictEqual([]);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], [null], ["keep.md"]]);
    expect(requests()).toStrictEqual([ROOT, fileOf("keep.md"), fileOf("keep.md")]);
  });

  it("选中后 file 答 404 的行从树里消失、onPathChange(null) 恰一次、预览区是未选状态；目录之下不剩文件时目录行也消失，全部不剩时是 onlyPathsEmpty 的文案", async () => {
    let xGone = false;
    const { browser, onPathChange, requests } = mount(
      {
        [fileOf("deep/x.md")]: () => (xGone ? notFound() : textPreviewResponse("甲的正文")),
        [fileOf("deep/y.md")]: notFound,
      },
      { onlyPaths: new Set(["deep/x.md", "deep/y.md"]) },
    );
    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md", "y.md"]);

    fireEvent.click(row("y.md"));

    await waitFor(() => expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]));
    expectCleared();
    expect(onPathChange.mock.calls).toStrictEqual([["deep/y.md"], [null]]);
    expect(requests()).toStrictEqual([fileOf("deep/y.md")]);

    fireEvent.click(row("x.md"));
    expect(await pane().findByText("甲的正文", { exact: true })).toBeTruthy();
    xGone = true;
    act(() => browser().refresh());

    expect(await within(column()).findByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
    expect(rows()).toStrictEqual([]);
    expect(screen.queryByRole("navigation", { name: "工作空间目录树" })).toBeNull();
    expectCleared();
    await settle();
    expect(onPathChange.mock.calls).toStrictEqual([["deep/y.md"], [null], ["deep/x.md"], [null]]);
    expect(requests()).toStrictEqual([
      fileOf("deep/y.md"),
      fileOf("deep/x.md"),
      fileOf("deep/x.md"),
    ]);
  });

  it("refresh() 与 refresh([该路径]) 都不使已移出的行重新出现，也不为它发请求；reported([该路径]) 使它重新出现", async () => {
    const { browser, requests } = mount(
      { [fileOf("deep/x.md")]: text("甲的正文"), [fileOf("deep/y.md")]: notFound },
      { onlyPaths: new Set(["deep/x.md", "deep/y.md"]) },
    );
    fireEvent.click(row("y.md"));
    await waitFor(() => expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]));

    act(() => browser().refresh());
    await settle();
    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]);
    act(() => browser().refresh(["deep/y.md"]));
    await settle();
    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]);
    expect(requests()).toStrictEqual([fileOf("deep/y.md")]);

    act(() => browser().reported(["deep/y.md"]));

    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md", "y.md"]);
    expect(row("y.md").disabled).toBe(false);
    await settle();
    expect(requests()).toStrictEqual([fileOf("deep/y.md")]);
  });

  it("压缩包：选中 a.zip 而 archive 答 404，与 file 的 404 同样移出并清除选中，没有未处理的拒绝", async () => {
    const rejections = observeUnhandledRejections();
    try {
      const { onPathChange, requests } = mount(
        { [ARCHIVE]: notFound },
        { onlyPaths: new Set(["a.zip"]) },
      );

      fireEvent.click(row("a.zip"));

      expect(await within(column()).findByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
      expect(rows()).toStrictEqual([]);
      expectCleared();
      await settle();
      expect(onPathChange.mock.calls).toStrictEqual([["a.zip"], [null]]);
      expect(requests()).toStrictEqual([ARCHIVE]);
      expect(rejections.unhandled).toStrictEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("压缩包：再点同一行之后，被中止的那一次 archive 迟到的 404 不记账、不清选中；新的一次答 200 照常列出成员", async () => {
    const rejections = observeUnhandledRejections();
    try {
      const late = deferred<Response>();
      let asked = 0;
      const members = () =>
        jsonResponse({
          entries: [{ path: "inner.txt", size: 3, type: "file" }],
          format: "zip",
          truncated: false,
        });
      const { onPathChange, requests } = mount(
        {
          [ARCHIVE]: () => {
            asked += 1;
            return asked === 1 ? late.promise : members();
          },
        },
        { onlyPaths: new Set(["a.zip"]) },
      );

      fireEvent.click(row("a.zip"));
      await waitFor(() => expect(requests()).toStrictEqual([ARCHIVE]));
      fireEvent.click(row("a.zip"));
      expect(await pane().findByText("inner.txt")).toBeTruthy();
      await act(async () => {
        late.resolve(notFound());
        await yieldMacrotask();
      });
      await settle();

      expect(rows()).toStrictEqual(["设计文档", "a.zip"]);
      expect(selectedRows()).toStrictEqual(["a.zip"]);
      expect(pane().getByText("inner.txt")).toBeTruthy();
      expect(onPathChange.mock.calls).toStrictEqual([["a.zip"], ["a.zip"]]);
      expect(requests()).toStrictEqual([ARCHIVE, ARCHIVE]);
      expect(rejections.unhandled).toStrictEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("压缩包：选中已换成别的文件、预览器还没来得及中止旧请求时到达的 404 不算数——不记账，不清新的选中，不上报 null", async () => {
    const late = deferred<Response>();
    const { browser, onPathChange, requests } = mount(
      { [ARCHIVE]: () => late.promise, [fileOf("keep.md")]: text("留下的正文") },
      { onlyPaths: new Set(["a.zip", "keep.md"]) },
    );
    fireEvent.click(row("a.zip"));
    await waitFor(() => expect(requests()).toStrictEqual([ARCHIVE]));

    // 同一个 `act` 里先换选中（句柄的定位：状态更新排着队，预览器的清理还没跑、旧请求的信号还没中止），
    // 再让旧的 404 到达：拦它的只有「它已不是当前文件」。
    await act(async () => {
      browser().reveal("keep.md");
      late.resolve(notFound());
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });

    expect(await pane().findByText("留下的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(rows()).toStrictEqual(["设计文档", "a.zip", "keep.md"]);
    expect(selectedRows()).toStrictEqual(["keep.md"]);
    expect(onPathChange.mock.calls).toStrictEqual([["a.zip"], ["keep.md"]]);
    expect(requests()).toStrictEqual([ARCHIVE, fileOf("keep.md")]);
  });

  it("句柄 reveal 定位到不成行的路径而当时没有选中：没有什么可清，不上报", async () => {
    const { browser, onPathChange, requests, update } = mount({
      [ROOT]: () => listing("", ["keep.md"]),
    });
    await within(column()).findByRole("button", { name: "keep.md" });
    update({ onlyPaths: new Set(["keep.md", "old.md"]) });

    act(() => browser().reveal("old.md"));
    await settle();

    expect(selectedRows()).toStrictEqual([]);
    expect(onPathChange.mock.calls).toStrictEqual([]);
    expect(requests()).toStrictEqual([ROOT]);
  });

  it("非 404 的失败不移出：file 答 500，行仍在、选中仍在，预览区是既有的失败文案", async () => {
    const { onPathChange, requests } = mount(
      { [fileOf("keep.md")]: failed },
      { clearMissing: true, onlyPaths: new Set(["keep.md"]) },
    );

    fireEvent.click(row("keep.md"));

    expect((await pane().findByRole("alert")).textContent).toBe(FAILED);
    await settle();
    expect(rows()).toStrictEqual(["设计文档", "keep.md"]);
    expect(selectedRows()).toStrictEqual(["keep.md"]);
    expect(document.querySelector('[data-slot="preview-header"]')).not.toBeNull();
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"]]);
    expect(requests()).toStrictEqual([fileOf("keep.md")]);
  });

  it("范围：onlyPaths 之外的路径不适用——句柄 reveal 与 path 指向集合之外、父目录未加载的路径时零新请求，原选中不变，不上报", async () => {
    const { browser, onPathChange, requests, setPath, update } = mount({
      [ROOT]: () => listing("", ["keep.md"], ["src"]),
      [fileOf("keep.md")]: text("留下的正文"),
    });
    fireEvent.click(await within(column()).findByRole("button", { name: "keep.md" }));
    expect(await pane().findByText("留下的正文", { exact: true })).toBeTruthy();
    update({ onlyPaths: new Set(["keep.md"]) });

    act(() => browser().reveal("src/app.ts"));
    await setPath("src/other.ts");
    await settle();

    expect(requests()).toStrictEqual([ROOT, fileOf("keep.md")]);
    expect(selectedRows()).toStrictEqual(["keep.md"]);
    expect(pane().getByText("留下的正文", { exact: true })).toBeTruthy();
    expect(pane().queryByRole("alert")).toBeNull();
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"]]);
  });

  it("path 定位到父目录未加载的行：选中并取 file，不请求 tree，那一层不进展开集合——撤掉 onlyPaths 后它仍是折叠的", async () => {
    const { onPathChange, requests, setPath, update } = mount({
      [ROOT]: () => listing("", ["keep.md"], ["x"]),
      [fileOf("x/y.md")]: text("乙的正文"),
    });
    await within(column()).findByRole("button", { name: "keep.md" });
    update({ onlyPaths: new Set(["x/y.md"]) });

    await setPath("x/y.md");

    expect(await pane().findByText("乙的正文", { exact: true })).toBeTruthy();
    expect(selectedRows()).toStrictEqual(["y.md"]);
    expect(document.querySelector('[data-slot="preview-meta"]')).toBeNull();
    await settle();
    expect(requests()).toStrictEqual([ROOT, fileOf("x/y.md")]);
    // `path` 属性的定位不上报。
    expect(onPathChange.mock.calls).toStrictEqual([]);

    update({});
    expect(within(column()).getByRole("button", { name: "展开 x" })).toBeTruthy();
    expect(pane().getByText("乙的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, fileOf("x/y.md")]);
  });
});

describe("陈旧列表与 reported", () => {
  it("根已加载、列表里没有 new.md：reported 之前不成行，之后成行、不带 disabled、没有 tree 请求，选中后恰一次 file、预览头没有大小；撤掉 onlyPaths 后 refresh() 读到仍没有它的根列表，再给回 onlyPaths 不成行", async () => {
    const only = new Set(["new.md"]);
    const { browser, requests, update } = mount({
      [ROOT]: () => listing("", ["keep.md"]),
      [fileOf("new.md")]: text("新写的正文"),
    });
    await within(column()).findByRole("button", { name: "keep.md" });
    update({ onlyPaths: only });
    expect(within(column()).getByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
    expect(rows()).toStrictEqual([]);

    act(() => browser().reported(["new.md"]));

    expect(rows()).toStrictEqual(["设计文档", "new.md"]);
    expect(row("new.md").disabled).toBe(false);
    await settle();
    expect(requests()).toStrictEqual([ROOT]);

    fireEvent.click(row("new.md"));
    expect(await pane().findByText("新写的正文", { exact: true })).toBeTruthy();
    expect(document.querySelector('[data-slot="preview-meta"]')).toBeNull();
    await settle();
    expect(requests()).toStrictEqual([ROOT, fileOf("new.md")]);

    update({});
    act(() => browser().refresh());
    await waitFor(() => expect(requests()).toHaveLength(4));
    await settle();
    expect(requests()).toStrictEqual([ROOT, fileOf("new.md"), ROOT, fileOf("new.md")]);
    update({ onlyPaths: only });

    expect(within(column()).getByText(EMPTY_TEXT, { exact: true })).toBeTruthy();
    expect(rows()).toStrictEqual([]);
    await settle();
    expect(requests()).toHaveLength(4);
  });
});

describe("记录的作废只及于被列的那一层", () => {
  it("deep/y.md 记下 404 之后撤掉 onlyPaths、refresh() 只重列根（deep 没加载过）：给回 onlyPaths，y.md 仍不成行", async () => {
    const only = new Set(["deep/x.md", "deep/y.md"]);
    const { browser, requests, update } = mount(
      {
        [ROOT]: () => listing("", ["keep.md"], ["deep"]),
        [fileOf("deep/y.md")]: notFound,
      },
      { onlyPaths: only },
    );
    fireEvent.click(row("y.md"));
    await waitFor(() => expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]));

    // 撤掉 `onlyPaths`：根还没加载过，补一次；随后 `refresh()` 再列一次根，`deep` 从未加载、不在其中。
    update({});
    await within(column()).findByRole("button", { name: "keep.md" });
    act(() => browser().refresh());
    await waitFor(() => expect(requests()).toStrictEqual([fileOf("deep/y.md"), ROOT, ROOT]));
    await settle();
    update({ onlyPaths: only });

    expect(rows()).toStrictEqual(["设计文档", "deep", "x.md"]);
    await settle();
    expect(requests()).toStrictEqual([fileOf("deep/y.md"), ROOT, ROOT]);
  });
});

describe("clearMissing（不给 onlyPaths）", () => {
  const BAD = `${ROOT}bad`;
  const GHOST = `${ROOT}ghost`;
  const table = (): FetchRoutes => ({
    [ROOT]: () => listing("", ["gone.md", "keep.md"], ["bad"]),
    [BAD]: () => jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
    [GHOST]: notFound,
    [fileOf("keep.md")]: text("留下的正文"),
    [fileOf("gone.md")]: notFound,
  });

  /** 挂上并点选 `keep.md`，等到它的预览出现。 */
  async function withSelection(extra: Extra) {
    const mounted = mount(table(), extra);
    fireEvent.click(await within(column()).findByRole("button", { name: "keep.md" }));
    expect(await pane().findByText("留下的正文", { exact: true })).toBeTruthy();
    return mounted;
  }

  it.each([
    ["列表里没有的文件", "old.md", []],
    ["404 的父目录之下", "ghost/a.md", [GHOST]],
    ["含 .. 段", "../x", []],
    ["以 500 失败的父目录之下", "bad/a.md", [BAD]],
  ])("path 指向%s：预览区是空态、没有文案，此前的选中被清除，不上报", async (_, target, asked) => {
    const { onPathChange, requests, setPath } = await withSelection({ clearMissing: true });

    await setPath(target);
    await waitFor(() => expect(requests()).toStrictEqual([ROOT, fileOf("keep.md"), ...asked]));
    await settle();

    expectCleared();
    // 失败的那一级在树上有行时，它的失败文案照常在树区（design D14-9）；树上没有行的那一级没有。
    const treeAlerts = within(column())
      .queryAllByRole("alert")
      .map((node) => node.textContent);
    expect(treeAlerts).toStrictEqual(target === "bad/a.md" ? ["目录读取失败"] : []);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"]]);
    expect(requests()).toStrictEqual([ROOT, fileOf("keep.md"), ...asked]);
  });

  it("选中列表里仍有而 file 答 404 的行：选中被清除、onPathChange(null) 恰一次，该行仍在树里", async () => {
    const { onPathChange, requests } = await withSelection({ clearMissing: true });

    fireEvent.click(row("gone.md"));

    await waitFor(() =>
      expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], ["gone.md"], [null]]),
    );
    await settle();
    expectCleared();
    expect(rows()).toStrictEqual(["设计文档", "bad", "gone.md", "keep.md"]);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], ["gone.md"], [null]]);
    expect(requests()).toStrictEqual([ROOT, fileOf("keep.md"), fileOf("gone.md")]);
  });

  it("记账不分开关：只给 clearMissing 时记下的 404，给上 onlyPaths 后该路径不成行；所在目录的 tree 应答到达后记录作废，再给 onlyPaths 重新成行", async () => {
    const only = new Set(["gone.md", "keep.md"]);
    const { browser, requests, update } = await withSelection({ clearMissing: true });
    fireEvent.click(row("gone.md"));
    await waitFor(() => expect(selectedRows()).toStrictEqual([]));
    await settle();

    update({ clearMissing: true, onlyPaths: only });

    expect(rows()).toStrictEqual(["设计文档", "keep.md"]);

    update({ clearMissing: true });
    act(() => browser().refresh());
    await waitFor(() => expect(requests().filter((path) => path === ROOT)).toHaveLength(2));
    await settle();
    update({ clearMissing: true, onlyPaths: only });

    expect(rows()).toStrictEqual(["设计文档", "gone.md", "keep.md"]);
    expect(requests()).toStrictEqual([ROOT, fileOf("keep.md"), fileOf("gone.md"), ROOT]);
  });

  it("对照：clearMissing 与 onlyPaths 都不给时，同一个 404 仍是信封文案、行不消失、不上报 null；path 落空仍是 文件不存在", async () => {
    const { onPathChange, setPath } = await withSelection({});

    fireEvent.click(row("gone.md"));

    expect((await pane().findByRole("alert")).textContent).toBe(NOT_FOUND);
    await settle();
    expect(selectedRows()).toStrictEqual(["gone.md"]);
    expect(rows()).toStrictEqual(["设计文档", "bad", "gone.md", "keep.md"]);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], ["gone.md"]]);

    await setPath("old.md");
    await settle();
    expect(pane().getByRole("alert").textContent).toBe(MISSING);
    expect(selectedRows()).toStrictEqual([]);
    expect(onPathChange.mock.calls).toStrictEqual([["keep.md"], ["gone.md"]]);
  });
});
