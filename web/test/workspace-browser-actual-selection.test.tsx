// files-web「工作空间浏览器组件」里 #1380 的那一部分（s1-followups-batch 11b.1）：`WorkspaceBrowser` 向
// 宿主上报树里实际选中的文件（`onSelectionChange`），以及宿主以同一路径再次发起定位的触发（`pathSeq`）。
// 场景「实际选中的上报与重复定位」。组件直接渲染、不挂路由；宿主照页面那样把 `onPathChange` 写回
// `path`，另记下每一次上报。请求取自 fetch 桩的调用记录，路由值是函数。期望值是规格里的字面量。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { cleanupFilesFixture, type FetchRoutes } from "./files-fixture.js";
import { createFetchMock, jsonResponse, paths, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
const ROOT = `${API}/tree?path=`;
const OUT = `${ROOT}out`;
const BAD = `${ROOT}bad`;
const fileOf = (path: string) => `${API}/file?path=${encodeURIComponent(path)}`;
const README = fileOf("readme.md");
const GONE = fileOf("out/gone.md");
const MISSING = "文件不存在";
const EMPTY = "未选择文件";
const FAILED = "目录读取失败";

const dirEntry = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
const fileEntry = (name: string) => ({ name, type: "file", size: 4, mtime: 200 });

type Extra = Pick<ComponentProps<typeof WorkspaceBrowser>, "clearMissing">;

/**
 * 根下是目录 `bad`（列它答 500）、`out` 与 `readme.md`；`out` 里起初只有 `b.md`，`disk.gone` 置真后
 * 多出 `gone.md`。宿主的 `locate(path)` 是一次定位：写 `path` 并把 `pathSeq` 加一（会话页侧边栏的
 * 做法）；`setPath` 只写 `path`。
 */
function mount(extra: Extra = {}) {
  const disk = { gone: false };
  const table: FetchRoutes = {
    [ROOT]: () =>
      jsonResponse({
        path: "",
        entries: [dirEntry("bad"), dirEntry("out"), fileEntry("readme.md")],
      }),
    [OUT]: () =>
      jsonResponse({
        path: "out",
        entries: disk.gone ? [fileEntry("b.md"), fileEntry("gone.md")] : [fileEntry("b.md")],
      }),
    [BAD]: () => jsonResponse({ error: { code: "internal", message: FAILED } }, 500),
    [README]: () => textPreviewResponse("自述正文"),
    [GONE]: () => textPreviewResponse("重写的正文"),
  };
  const fetchMock = createFetchMock(table);
  vi.stubGlobal("fetch", fetchMock);
  const client = createApiClient();
  const handle = createRef<WorkspaceBrowserHandle>();
  const onPathChange = vi.fn<(path: string | null) => void>();
  const onSelectionChange = vi.fn<(path: string | null) => void>();
  type HostState = { path: string | null; seq: number | undefined };
  let write: (next: HostState) => void = () => {};
  let current: HostState = { path: null, seq: 0 };
  let located = 0;

  function Host() {
    const [state, setState] = useState(current);
    current = state;
    write = setState;
    return (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        name="设计文档"
        onPathChange={(path) => {
          onPathChange(path);
          setState((now) => ({ ...now, path }));
        }}
        onSelectionChange={onSelectionChange}
        path={state.path}
        pathSeq={state.seq}
        ref={handle}
        workspaceId="workspace-1"
        {...extra}
      />
    );
  }

  const view = render(<Host />);
  return {
    browser: () => {
      if (!handle.current) throw new Error("WorkspaceBrowser 没有交出句柄");
      return handle.current;
    },
    disk,
    locate: (path: string) => {
      located += 1;
      return act(() => write({ path, seq: located }));
    },
    onPathChange,
    onSelectionChange,
    rerender: () => view.rerender(<Host />),
    requests: () => paths(fetchMock),
    setPath: (path: string | null) => act(() => write({ ...current, path })),
    /** 宿主撤掉 `pathSeq`（不传）。 */
    withdrawSeq: () => act(() => write({ ...current, seq: undefined })),
  };
}

const column = () => document.querySelector('aside[aria-label="工作空间文件"]') as HTMLElement;
const pane = () => within(screen.getByRole("region", { name: "文件预览" }));

function selectedRows() {
  return [...column().querySelectorAll('button[aria-current="true"]')].map(
    (node) => node.querySelector('[data-slot="tree-name"]')?.textContent,
  );
}

async function settle() {
  await act(async () => {
    await yieldMacrotask();
    await yieldMacrotask();
  });
}

/** 挂上并点选 `readme.md`，等到它的预览出现：此时恰上报过一次 `readme.md`。 */
async function withReadme(extra: Extra = {}) {
  const mounted = mount(extra);
  fireEvent.click(await within(column()).findByRole("button", { name: "readme.md" }));
  expect(await pane().findByText("自述正文", { exact: true })).toBeTruthy();
  await settle();
  expect(mounted.onSelectionChange.mock.calls).toStrictEqual([["readme.md"]]);
  return mounted;
}

/** 这个页面的地址与历史条数：组件不读写 `location`，两次定位前后都不变。 */
const address = () => `${window.location.href}#${window.history.length}`;

afterEach(cleanupFilesFixture);

describe("实际选中的上报与重复定位", () => {
  it.each([
    ["不给 clearMissing：第一次定位之后预览区是 文件不存在", false],
    ["给了 clearMissing：第一次定位之后预览区是空态、没有文案", true],
  ])(
    "%s；宿主收到的实际选中为空，refresh 把它读进列表后不自己选中，以同一路径再定位一次才选中它并上报；onPathChange 不因定位被调用，两次都没有读写 location",
    async (_, clearMissing) => {
      const { browser, disk, locate, onPathChange, onSelectionChange, requests } = await withReadme(
        {
          clearMissing,
        },
      );
      const before = address();

      await locate("out/gone.md");

      await waitFor(() =>
        expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null]]),
      );
      await settle();
      expect(selectedRows()).toStrictEqual([]);
      if (clearMissing) {
        expect(pane().getByText(EMPTY, { exact: true })).toBeTruthy();
        expect(pane().queryByRole("alert")).toBeNull();
        expect(screen.queryByText(MISSING)).toBeNull();
      } else {
        expect(pane().getByRole("alert").textContent).toBe(MISSING);
      }
      expect(requests()).toStrictEqual([ROOT, README, OUT]);

      // 文件被建出，`refresh` 把它读进 `out` 的列表：行出现，选中不因此改变，也没有新的上报。
      disk.gone = true;
      act(() => browser().refresh(["out/gone.md"]));
      expect(await within(column()).findByRole("button", { name: "gone.md" })).toBeTruthy();
      await settle();
      expect(selectedRows()).toStrictEqual([]);
      expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null]]);
      expect(requests()).toStrictEqual([ROOT, README, OUT, ROOT, OUT]);

      await locate("out/gone.md");

      expect(await pane().findByText("重写的正文", { exact: true })).toBeTruthy();
      await settle();
      expect(selectedRows()).toStrictEqual(["gone.md"]);
      expect(screen.queryByText(MISSING)).toBeNull();
      expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null], ["out/gone.md"]]);
      expect(onPathChange.mock.calls).toStrictEqual([["readme.md"]]);
      expect(requests()).toStrictEqual([ROOT, README, OUT, ROOT, OUT, GONE]);
      expect(address()).toBe(before);
    },
  );

  it("触发是 pathSeq 的新值：定位落空之后宿主照原样重渲染、只把同一个 path 再写一遍、或把 pathSeq 撤成不传，都不重新定位", async () => {
    const { browser, disk, onSelectionChange, requests, rerender, setPath, locate, withdrawSeq } =
      await withReadme();
    await locate("out/gone.md");
    await waitFor(() =>
      expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null]]),
    );
    disk.gone = true;
    act(() => browser().refresh(["out/gone.md"]));
    await within(column()).findByRole("button", { name: "gone.md" });
    await settle();
    const listed = [ROOT, README, OUT, ROOT, OUT];
    expect(requests()).toStrictEqual(listed);

    rerender();
    await setPath("out/gone.md");
    await withdrawSeq();
    await settle();

    expect(selectedRows()).toStrictEqual([]);
    expect(pane().getByRole("alert").textContent).toBe(MISSING);
    expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null]]);
    expect(requests()).toStrictEqual(listed);
  });

  it("再定位到已选中的那个文件：不重取预览、不上报（选中没有变）", async () => {
    const { locate, onSelectionChange, requests } = await withReadme();

    await locate("readme.md");
    await locate("readme.md");
    await settle();

    expect(selectedRows()).toStrictEqual(["readme.md"]);
    expect(pane().getByText("自述正文", { exact: true })).toBeTruthy();
    expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"]]);
    expect(requests()).toStrictEqual([ROOT, README]);
  });

  it.each([
    ["path 指向目录", "out", [OUT]],
    ["某一级父目录请求失败", "bad/a.md", [BAD]],
  ])("%s：宿主收到的实际选中同样为空，恰上报一次", async (_, target, asked) => {
    const { locate, onPathChange, onSelectionChange, requests } = await withReadme();

    await locate(target);

    await waitFor(() => expect(requests()).toStrictEqual([ROOT, README, ...asked]));
    await settle();
    expect(selectedRows()).toStrictEqual([]);
    expect(onSelectionChange.mock.calls).toStrictEqual([["readme.md"], [null]]);
    expect(onPathChange.mock.calls).toStrictEqual([["readme.md"]]);
  });

  it("没有选中时定位落空：实际选中没有变（一直为空），不上报；挂载本身也不上报", async () => {
    const { locate, onSelectionChange, requests } = mount();
    await within(column()).findByRole("button", { name: "readme.md" });
    expect(onSelectionChange.mock.calls).toStrictEqual([]);

    await locate("out/gone.md");

    expect((await pane().findByRole("alert")).textContent).toBe(MISSING);
    await settle();
    expect(onSelectionChange.mock.calls).toStrictEqual([]);
    expect(requests()).toStrictEqual([ROOT, OUT]);
  });
});
