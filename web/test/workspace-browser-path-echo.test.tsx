// files-web「浏览器不执行被取代的自身上报回声」（#1542）：宿主把 `onPathChange` 的上报原样写回 `path`，
// 写回晚于浏览器的下一次上报时，那次回声不再清掉选中、不再定位、不再多发 `file`。宿主自己的值（换了
// `pathSeq` 的、浏览器没报过的）照旧套用。测试宿主的 `onPathChange` 只记一笔，回声何时写回由用例
// 显式 `setPath` 决定，不依赖 Scheduler 时机。组件直接渲染、不挂路由；请求取自 fetch 桩的调用记录，
// 对整份记录做相等断言，多发的请求即判红。期望值是规格里的字面量。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import { deferred } from "./chat-stream-support.js";
import { cleanupFilesFixture, type FetchRoutes } from "./files-fixture.js";
import { createFetchMock, jsonResponse, textPreviewResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

const API = "/api/workspaces/workspace-1";
const ROOT = `${API}/tree?path=`;
const fileOf = (path: string) => `${API}/file?path=${encodeURIComponent(path)}`;
const X = "deep/x.md";
const Y = "deep/y.md";

const fileEntry = (name: string) => ({ name, type: "file", size: 4, mtime: 200 });
const notFound = () =>
  jsonResponse({ error: { code: "not_found", message: "请求的资源不存在" } }, 404);
const text = (body: string) => () => textPreviewResponse(body);

/** 普通树：根下 `a.md`、`b.md`、`c.md`，各自答一段正文。 */
const PLAIN: FetchRoutes = {
  [ROOT]: () => jsonResponse({ path: "", entries: ["a.md", "b.md", "c.md"].map(fileEntry) }),
  [fileOf("a.md")]: text("甲的正文"),
  [fileOf("b.md")]: text("乙的正文"),
  [fileOf("c.md")]: text("丙的正文"),
};

/**
 * 宿主的状态是 `path` 与 `pathSeq`（起初 `null` 与 0）。`onPathChange` 只记一笔、不写回；`setPath` 只写
 * `path`（一次回声，或不换 `pathSeq` 的下发），`locate` 写 `path` 并把 `pathSeq` 加一（主动定位）。
 */
function mount(table: FetchRoutes, onlyPaths?: ReadonlySet<string>) {
  const fetchMock = createFetchMock(table);
  vi.stubGlobal("fetch", fetchMock);
  const client = createApiClient();
  const handle = createRef<WorkspaceBrowserHandle>();
  const onPathChange = vi.fn<(path: string | null) => void>();
  const onSelectionChange = vi.fn<(path: string | null) => void>();
  type HostState = { path: string | null; seq: number };
  let write: (update: (now: HostState) => HostState) => void = () => {};

  function Host() {
    const [state, setState] = useState<HostState>({ path: null, seq: 0 });
    write = setState;
    return (
      <WorkspaceBrowser
        account="zhangsan"
        client={client}
        name="设计文档"
        onlyPaths={onlyPaths}
        onPathChange={onPathChange}
        onSelectionChange={onSelectionChange}
        path={state.path}
        pathSeq={state.seq}
        ref={handle}
        workspaceId="workspace-1"
      />
    );
  }

  render(<Host />);
  return {
    browser: () => {
      if (!handle.current) throw new Error("WorkspaceBrowser 没有交出句柄");
      return handle.current;
    },
    locate: (path: string | null) => {
      act(() => write((now) => ({ path, seq: now.seq + 1 })));
    },
    onPathChange,
    onSelectionChange,
    requests: () => fetchMock.mock.calls.map(([path]) => path),
    setPath: (path: string | null) => {
      act(() => write((now) => ({ ...now, path })));
    },
  };
}

const column = () => document.querySelector('aside[aria-label="工作空间文件"]') as HTMLElement;
const pane = () => within(screen.getByRole("region", { name: "文件预览" }));
const row = (name: string) => within(column()).getByRole("button", { name });

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

/** 普通树，等根列出来。 */
async function mountPlain() {
  const mounted = mount(PLAIN);
  await within(column()).findByRole("button", { name: "a.md" });
  return mounted;
}

/** 404 → 点击的前半段：点 y.md 并写回，它答 404 后上报 `null`（先不写回）；再点 x.md。 */
async function missThenClick(mounted: ReturnType<typeof mount>) {
  fireEvent.click(row("y.md"));
  mounted.setPath(Y);
  await waitFor(() => expect(mounted.onPathChange.mock.calls).toStrictEqual([[Y], [null]]));
  expect(selectedRows()).toStrictEqual([]);
  fireEvent.click(row("x.md"));
  expect(selectedRows()).toStrictEqual(["x.md"]);
}

afterEach(cleanupFilesFixture);

describe("被取代的自身上报回声", () => {
  it("A：404 上报 null 的回声晚于下一次点击——x.md 不被清掉，file 恰一次，选中不经过 null", async () => {
    const gate = deferred<void>();
    const mounted = mount(
      {
        [fileOf(X)]: () => gate.promise.then(() => textPreviewResponse("深处的正文")),
        [fileOf(Y)]: notFound,
      },
      new Set([X, Y]),
    );
    await missThenClick(mounted);

    // 陈旧回声：x.md 仍是选中行，它在途的预览不被取消。
    mounted.setPath(null);
    expect(selectedRows()).toStrictEqual(["x.md"]);
    mounted.setPath(X);
    expect(selectedRows()).toStrictEqual(["x.md"]);
    await act(async () => gate.resolve());

    expect(await pane().findByText("深处的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(selectedRows()).toStrictEqual(["x.md"]);
    expect(mounted.requests()).toStrictEqual([fileOf(Y), fileOf(X)]);
    expect(mounted.onPathChange.mock.calls).toStrictEqual([[Y], [null], [X]]);
    expect(mounted.onSelectionChange.mock.calls).toStrictEqual([[Y], [null], [X]]);
  });

  it("B：reveal 落地上报的回声晚于下一次点击——b.md 始终选中，a.md、b.md 各请求一次", async () => {
    const { browser, onPathChange, onSelectionChange, requests, setPath } = await mountPlain();

    act(() => browser().reveal("a.md"));
    expect(selectedRows()).toStrictEqual(["a.md"]);
    fireEvent.click(row("b.md"));
    expect(selectedRows()).toStrictEqual(["b.md"]);

    setPath("a.md");
    expect(selectedRows()).toStrictEqual(["b.md"]);
    setPath("b.md");
    expect(selectedRows()).toStrictEqual(["b.md"]);

    expect(await pane().findByText("乙的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(selectedRows()).toStrictEqual(["b.md"]);
    expect(requests()).toStrictEqual([ROOT, fileOf("a.md"), fileOf("b.md")]);
    expect(onPathChange.mock.calls).toStrictEqual([["a.md"], ["b.md"]]);
    expect(onSelectionChange.mock.calls).toStrictEqual([["a.md"], ["b.md"]]);
  });

  it("D：同值重复（上报 a、b、a 后逐个写回）——选中始终是最后点的 a.md，file 只有三次点击各一次", async () => {
    const { onPathChange, onSelectionChange, requests, setPath } = await mountPlain();

    fireEvent.click(row("a.md"));
    fireEvent.click(row("b.md"));
    fireEvent.click(row("a.md"));
    expect(selectedRows()).toStrictEqual(["a.md"]);

    setPath("a.md");
    expect(selectedRows()).toStrictEqual(["a.md"]);
    setPath("b.md");
    expect(selectedRows()).toStrictEqual(["a.md"]);
    setPath("a.md");
    expect(selectedRows()).toStrictEqual(["a.md"]);

    expect(await pane().findByText("甲的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, fileOf("a.md"), fileOf("b.md"), fileOf("a.md")]);
    expect(onPathChange.mock.calls).toStrictEqual([["a.md"], ["b.md"], ["a.md"]]);
    expect(onSelectionChange.mock.calls).toStrictEqual([["a.md"], ["b.md"], ["a.md"]]);
  });
});

describe("宿主自己的值照旧套用", () => {
  it("C1：上报还没见回声时，宿主以新的 pathSeq 下发 null——选中被清除", async () => {
    const mounted = mount(
      { [fileOf(X)]: text("深处的正文"), [fileOf(Y)]: notFound },
      new Set([X, Y]),
    );
    await missThenClick(mounted);

    mounted.locate(null);
    await settle();
    expect(selectedRows()).toStrictEqual([]);
    expect(pane().getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(mounted.onSelectionChange.mock.calls.at(-1)).toStrictEqual([null]);
    expect(mounted.requests()).toStrictEqual([fileOf(Y), fileOf(X)]);
  });

  it("C2：上报还没见回声时，宿主下发浏览器没报过的 c.md（不换 pathSeq）——定位并选中，file 恰一次", async () => {
    const { onSelectionChange, requests, setPath } = await mountPlain();
    fireEvent.click(row("a.md"));
    fireEvent.click(row("b.md"));

    setPath("c.md");
    expect(await pane().findByText("丙的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(selectedRows()).toStrictEqual(["c.md"]);
    expect(onSelectionChange.mock.calls.at(-1)).toStrictEqual(["c.md"]);
    expect(requests()).toStrictEqual([ROOT, fileOf("a.md"), fileOf("b.md"), fileOf("c.md")]);
  });
});
