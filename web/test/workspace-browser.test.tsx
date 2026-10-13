// files-web「工作空间浏览器组件」：场景「受控路径与定位」「标记与子树」「两处同一份实现」。
// 组件直接渲染、不挂路由（最后一组页面级用例除外）；请求数取自 fetch 桩的调用记录。路由值是函数：
// 每次请求给一份新应答，多发的请求不会抛错而是留在记录里，由对整份记录的相等断言判红。

import { posix } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, createRef, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBrowser, type WorkspaceBrowserHandle } from "../src/features/files/index.js";
import { createApiClient } from "../src/lib/api.js";
import {
  authenticatedFilesRoutes,
  cleanupFilesFixture,
  type FetchRoutes,
  imagePreviewResponse,
  renderFiles,
  secondWorkspace,
  stubBlobUrls,
  workspace,
} from "./files-fixture.js";
import { createFetchMock, deferredResponse, jsonResponse, textPreviewResponse } from "./support.js";
import {
  listRepoFiles,
  pressPointer,
  readRepoFile,
  stripTsComments,
  yieldMacrotask,
} from "./ui-support.js";

const TREE = "/api/workspaces/workspace-1/tree?path=";
const FILE = "/api/workspaces/workspace-1/file?path=";
const ROOT = TREE;
const OUT = `${TREE}out`;
const SRC = `${TREE}src`;
const DEEP = `${TREE}src%2Fdeep`;
const BAD = `${TREE}bad`;
const FILE_A = `${FILE}out%2Fa.md`;
const FILE_APP = `${FILE}src%2Fdeep%2Fapp.ts`;
const FILE_README = `${FILE}readme.md`;
const MARK = "本会话已改动";

const dirEntry = (name: string) => ({ name, type: "dir", size: 0, mtime: 100 });
const fileEntry = (name: string, size = 4) => ({ name, type: "file", size, mtime: 200 });

/** 根下 `out`、`src`、`x`、`bad` 四个目录与 `readme.md`；`x` 与 `bad` 的列表不在表里（`bad` 另给）。 */
function routes(extra: FetchRoutes = {}): FetchRoutes {
  return {
    [ROOT]: () =>
      jsonResponse({
        path: "",
        entries: [
          dirEntry("bad"),
          dirEntry("out"),
          dirEntry("src"),
          dirEntry("x"),
          fileEntry("readme.md", 8),
        ],
      }),
    [OUT]: () => jsonResponse({ path: "out", entries: [fileEntry("a.md"), fileEntry("b.md")] }),
    [SRC]: () => jsonResponse({ path: "src", entries: [dirEntry("deep")] }),
    [DEEP]: () => jsonResponse({ path: "src/deep", entries: [fileEntry("app.ts", 12)] }),
    [FILE_A]: () => textPreviewResponse("甲的正文"),
    [FILE_APP]: () => textPreviewResponse("const app = 1;"),
    [FILE_README]: () => textPreviewResponse("自述正文"),
    ...extra,
  };
}

type BrowserProps = ComponentProps<typeof WorkspaceBrowser>;
type Extra = Partial<Omit<BrowserProps, "client" | "onPathChange" | "path" | "ref">>;

/**
 * 以页面那样的宿主渲染：`path` 是宿主的状态，`onPathChange` 先记一笔再写回。`setPath` 供用例从外面
 * 改 `path` 属性；`update` 换其余属性（宿主不重挂）。
 */
function mount(initialPath: string | null, extra: Extra = {}, table = routes(), strict = false) {
  const fetchMock = createFetchMock(table);
  vi.stubGlobal("fetch", fetchMock);
  const client = createApiClient();
  const handle = createRef<WorkspaceBrowserHandle>();
  const onPathChange = vi.fn<(path: string | null) => void>();
  let setPath: (path: string | null) => void = () => {};

  function Host(props: Extra) {
    const [path, set] = useState(initialPath);
    setPath = set;
    return (
      <WorkspaceBrowser
        account="zhangsan"
        dir="design-docs"
        name="设计文档"
        workspaceId="workspace-1"
        {...props}
        client={client}
        onPathChange={(next) => {
          onPathChange(next);
          set(next);
        }}
        path={path}
        ref={handle}
      />
    );
  }

  const wrap = (props: Extra) =>
    strict ? (
      <StrictMode>
        <Host {...props} />
      </StrictMode>
    ) : (
      <Host {...props} />
    );
  const view = render(wrap(extra));
  const requests = () => fetchMock.mock.calls.map(([path]) => path);
  return {
    browser: () => {
      if (!handle.current) throw new Error("WorkspaceBrowser 没有交出句柄");
      return handle.current;
    },
    onPathChange,
    requests,
    setPath: (path: string | null) => act(() => setPath(path)),
    treeRequests: () => requests().filter((path) => path.startsWith(TREE)),
    update: (props: Extra) => view.rerender(wrap(props)),
  };
}

function tree() {
  return screen.getByRole("navigation", { name: "工作空间目录树" });
}

/** 树上各行的名字，自上而下。 */
function rowNames() {
  return [...tree().querySelectorAll('[data-slot="tree-name"]')].map((node) => node.textContent);
}

function fileRow(name: string) {
  return within(tree()).getByRole("button", { name }) as HTMLButtonElement;
}

async function selectedRow(name: string) {
  await waitFor(() => {
    expect(fileRow(name).getAttribute("aria-current")).toBe("true");
  });
  return fileRow(name);
}

function previewRegion() {
  return within(screen.getByRole("region", { name: "文件预览" }));
}

/** 源码预览的正文。着色后一行拆成多个元素（着色是异步的），所以比容器的 `textContent`，不按文本取元素。 */
async function codePreview(text: string) {
  await waitFor(() => {
    const body = document.querySelector('[data-slot="files-preview"] [data-slot="preview-code"]');
    expect(body?.textContent).toContain(text);
  });
}

/** 带标记的行：标记元素、它所在 `<li>` 里的行按钮与该行的名字。 */
function markedRows() {
  return [...tree().querySelectorAll('[data-slot="tree-mark"]')].map((mark) => {
    const button = mark.parentElement?.querySelector(":scope > button") ?? null;
    return {
      button,
      mark,
      name: button?.querySelector('[data-slot="tree-name"]')?.textContent ?? null,
    };
  });
}

/** 让已经发出的请求与随后的渲染都落地：没有更多请求要等时，用它之后再断「没有新请求」。 */
async function settle() {
  await act(async () => {
    await yieldMacrotask();
  });
}

afterEach(() => {
  cleanupFilesFixture();
});

describe("WorkspaceBrowser 受控路径与定位", () => {
  /** 场景的前两步：以 `path="out/a.md"` 渲染并等它选中，再 `reveal("src/deep/app.ts")` 并等它选中。 */
  async function mountAndReveal() {
    const mounted = mount("out/a.md");
    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    expect(mounted.requests()).toStrictEqual([ROOT, OUT, FILE_A]);
    act(() => mounted.browser().reveal("src/deep/app.ts"));
    await selectedRow("app.ts");
    await codePreview("const app = 1;");
    return mounted;
  }

  it("以 path 渲染：展开到 out 并选中 a.md，各层与文件各请求一次，初始渲染后回调零次", async () => {
    const { onPathChange, requests } = mount("out/a.md");

    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    expect(previewRegion().getByText("out/a.md", { exact: true })).toBeTruthy();
    expect(within(tree()).getByRole("button", { name: "折叠 out" })).toBeTruthy();
    // 没被定位的目录不展开。
    expect(within(tree()).getByRole("button", { name: "展开 src" })).toBeTruthy();
    expect(rowNames()).toStrictEqual([
      "设计文档",
      "bad",
      "out",
      "a.md",
      "b.md",
      "src",
      "x",
      "readme.md",
    ]);
    expect(tree().querySelector('[data-slot="tree-root-path"]')?.textContent).toBe(
      "zhangsan/design-docs",
    );
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A]);
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("reveal 依次请求 src、src/deep（前一层落地才请求后一层，已加载的根不重取），以叶子路径回调一次", async () => {
    const src = deferredResponse();
    const { browser, onPathChange, requests } = mount(
      "out/a.md",
      {},
      routes({ [SRC]: () => src.promise }),
    );
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A]);

    act(() => browser().reveal("src/deep/app.ts"));
    await settle();
    // `src` 的列表还没回来：只发了这一个请求，选中与回调都还没发生。
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");
    expect(onPathChange.mock.calls).toStrictEqual([]);

    await act(async () => {
      src.resolve(jsonResponse({ path: "src", entries: [dirEntry("deep")] }));
    });
    await selectedRow("app.ts");
    await codePreview("const app = 1;");
    expect(within(tree()).getByRole("button", { name: "折叠 src" })).toBeTruthy();
    expect(within(tree()).getByRole("button", { name: "折叠 deep" })).toBeTruthy();
    expect(fileRow("a.md").getAttribute("aria-current")).toBeNull();
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC, DEEP, FILE_APP]);
    expect(onPathChange.mock.calls).toStrictEqual([["src/deep/app.ts"]]);
  });

  it("refresh(paths) 只对根与 out 重新请求：别的已加载层与不在 paths 里的当前文件都不重取", async () => {
    const { browser, requests } = await mountAndReveal();
    const before = [ROOT, OUT, FILE_A, SRC, DEEP, FILE_APP];
    expect(requests()).toStrictEqual(before);

    act(() => browser().refresh(["out/b.md"]));
    await waitFor(() => {
      expect(requests()).toHaveLength(before.length + 2);
    });
    await settle();
    expect(requests()).toStrictEqual([...before, ROOT, OUT]);
    // 展开与选中不动。
    expect(fileRow("app.ts").getAttribute("aria-current")).toBe("true");
    expect(within(tree()).getByRole("button", { name: "折叠 out" })).toBeTruthy();
  });

  it("refresh(paths) 含当前文件时另重取它的预览；不带参数时重取每一个已加载层与当前文件", async () => {
    const { browser, requests } = await mountAndReveal();
    const before = [ROOT, OUT, FILE_A, SRC, DEEP, FILE_APP];
    expect(requests()).toStrictEqual(before);

    act(() => browser().refresh(["src/deep/app.ts"]));
    await waitFor(() => {
      expect(requests()).toHaveLength(before.length + 4);
    });
    await settle();
    const afterPaths = [...before, ROOT, SRC, DEEP, FILE_APP];
    expect(requests()).toStrictEqual(afterPaths);

    act(() => browser().refresh());
    await waitFor(() => {
      expect(requests()).toHaveLength(afterPaths.length + 5);
    });
    await settle();
    expect(requests().slice(afterPaths.length).sort()).toStrictEqual(
      [ROOT, OUT, SRC, DEEP, FILE_APP].sort(),
    );
  });

  it("点击文件行选中并回调一次；再点已选中的文件重取预览", async () => {
    const { onPathChange, requests } = mount(null);

    fireEvent.click(await within(tree()).findByRole("button", { name: "readme.md" }));
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    expect(requests()).toStrictEqual([ROOT, FILE_README]);
    expect(onPathChange.mock.calls).toStrictEqual([["readme.md"]]);

    fireEvent.click(fileRow("readme.md"));
    await waitFor(() => {
      expect(requests()).toHaveLength(3);
    });
    await settle();
    expect(requests()).toStrictEqual([ROOT, FILE_README, FILE_README]);
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    expect(onPathChange.mock.calls).toStrictEqual([["readme.md"], ["readme.md"]]);
  });

  it("定位还在等目录列表时点了别的文件：以点击为准，列表回来后不再走下去", async () => {
    const src = deferredResponse();
    const { browser, onPathChange, requests } = mount(
      null,
      {},
      routes({ [SRC]: () => src.promise }),
    );
    await within(tree()).findByRole("button", { name: "readme.md" });
    act(() => browser().reveal("src/deep/app.ts"));
    await settle();
    expect(requests()).toStrictEqual([ROOT, SRC]);

    fireEvent.click(fileRow("readme.md"));
    await act(async () => {
      src.resolve(jsonResponse({ path: "src", entries: [dirEntry("deep")] }));
    });
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, SRC, FILE_README]);
    expect(fileRow("readme.md").getAttribute("aria-current")).toBe("true");
    expect(onPathChange.mock.calls).toStrictEqual([["readme.md"]]);
  });

  it("path 指向目录：逐级展开并列出它，不选中、不请求 file、不回调", async () => {
    const { onPathChange, requests } = mount("src/deep");

    expect(await within(tree()).findByRole("button", { name: "app.ts" })).toBeTruthy();
    expect(within(tree()).getByRole("button", { name: "折叠 deep" })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, SRC, DEEP]);
    expect(previewRegion().getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("末级不在列表里：停在父目录，预览区显示 文件不存在；某一级读取失败：停在该级，错误行与预览区都显示它的文案，不重复请求", async () => {
    const missing = mount("out/missing.md");
    expect(await within(tree()).findByRole("button", { name: "a.md" })).toBeTruthy();
    await settle();
    expect(missing.requests()).toStrictEqual([ROOT, OUT]);
    expect(previewRegion().getByRole("alert").textContent).toBe("文件不存在");
    expect(missing.onPathChange.mock.calls).toStrictEqual([]);
    cleanupFilesFixture();

    const failed = mount(
      "bad/inner/x.md",
      {},
      routes({
        [BAD]: () => jsonResponse({ error: { code: "internal", message: "目录读取失败" } }, 500),
      }),
    );
    expect((await within(tree()).findByRole("alert")).textContent).toBe("目录读取失败");
    expect(within(tree()).getByRole("button", { name: "折叠 bad" })).toBeTruthy();
    await settle();
    expect(failed.requests()).toStrictEqual([ROOT, BAD]);
    expect(previewRegion().getByRole("alert").textContent).toBe("目录读取失败");
  });

  it("path 改成 null 清掉选中；改成另一个文件则定位过去，两种都不回调", async () => {
    const { onPathChange, requests, setPath } = mount("out/a.md");
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });

    setPath(null);
    expect(await previewRegion().findByText("未选择文件", { exact: true })).toBeTruthy();
    expect(tree().querySelector('[aria-current="true"]')).toBeNull();

    setPath("readme.md");
    await selectedRow("readme.md");
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, FILE_README]);
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("path 改成 null 时放掉选中图片的 blob 地址：恰好 revoke 一次", async () => {
    const blobUrls = stubBlobUrls(["blob:pic"]);
    const { setPath } = mount(
      "out/pic.png",
      {},
      routes({
        [OUT]: () => jsonResponse({ path: "out", entries: [fileEntry("pic.png", 8)] }),
        [`${FILE}out%2Fpic.png`]: () => imagePreviewResponse(),
      }),
    );
    const image = await previewRegion().findByRole("img", { name: "pic.png" });
    expect(image.getAttribute("src")).toBe("blob:pic");
    await settle();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([]);

    setPath(null);
    expect(await previewRegion().findByText("未选择文件", { exact: true })).toBeTruthy();
    await settle();
    expect(blobUrls.revokeObjectURL.mock.calls).toStrictEqual([["blob:pic"]]);
  });

  it("path 改去别处、目录列表还没回来又改回当前选中：放弃那次定位，列表回来后选中与预览不动、不再请求", async () => {
    const src = deferredResponse();
    const { onPathChange, requests, setPath } = mount(
      "out/a.md",
      {},
      routes({ [SRC]: () => src.promise }),
    );
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });

    setPath("src/deep/app.ts");
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");

    setPath("out/a.md");
    await act(async () => {
      src.resolve(jsonResponse({ path: "src", entries: [dirEntry("deep")] }));
    });
    // `src` 的列表确实落地了（它在等的时候已被展开）；`deep` 没有被走下去。
    expect(await within(tree()).findByRole("button", { name: "展开 deep" })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("reveal 还在等目录列表时 path 改回当前选中：同样放弃，不选中 reveal 的目标、不回调", async () => {
    const src = deferredResponse();
    const { browser, onPathChange, requests, setPath } = mount(
      "out/a.md",
      {},
      routes({ [SRC]: () => src.promise }),
    );
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });
    // 先让 `path` 离开当前选中：指向还没加载的层，定位在等 `src` 的列表，选中不动。
    setPath("src/deep/app.ts");
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");

    act(() => browser().reveal("src/deep/app.ts"));
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);

    setPath("out/a.md");
    await act(async () => {
      src.resolve(jsonResponse({ path: "src", entries: [dirEntry("deep")] }));
    });
    expect(await within(tree()).findByRole("button", { name: "展开 deep" })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, SRC]);
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });

  it("StrictMode 下以 path 渲染同样选中 a.md，不回调", async () => {
    const { onPathChange, requests } = mount("out/a.md", {}, routes(), true);

    await selectedRow("a.md");
    expect(await previewRegion().findByText("甲的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests().filter((path) => path === FILE_A)).toHaveLength(1);
    expect(requests().filter((path) => path === OUT)).toHaveLength(1);
    expect(onPathChange.mock.calls).toStrictEqual([]);
  });
});

describe("WorkspaceBrowser 标记与子树", () => {
  const marked = { label: MARK, paths: new Set(["out/a.md"]) };
  // 插入顺序故意与显示顺序（同级按名字）相反：不排序的话 `x` 会排在 `out` 前面。
  const only = new Set(["x/y.md", "out/a.md"]);

  it("标记与子树：out 与 out/a.md 两行带标记；传入 onlyPaths 之后树恰为 out → a.md 与 x → y.md，没有新的 tree 请求", async () => {
    const { treeRequests, requests, update } = mount(null, { markedPaths: marked });
    fireEvent.click(await within(tree()).findByRole("button", { name: "展开 out" }));
    await within(tree()).findByRole("button", { name: "a.md" });

    expect(markedRows().map((row) => row.name)).toStrictEqual(["out", "a.md"]);
    for (const row of markedRows()) {
      expect(row.mark.textContent).toBe(MARK);
    }
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT, OUT]);

    update({ markedPaths: marked, onlyPaths: only });
    expect(await within(tree()).findByRole("button", { name: "y.md" })).toBeTruthy();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a.md", "x", "y.md"]);
    // 各级目录都展开。
    for (const name of ["设计文档", "out", "x"]) {
      expect(within(tree()).getByRole("button", { name: `折叠 ${name}` })).toBeTruthy();
    }
    expect(markedRows().map((row) => row.name)).toStrictEqual(["out", "a.md"]);
    // 父目录加载过的行沿用它的大小；没加载过的（`x` 从未展开）没有大小，照样可选（#1372）。
    expect(fileRow("a.md").querySelector('[data-slot="tree-size"]')?.textContent).toBe("4 B");
    expect(fileRow("y.md").querySelector('[data-slot="tree-size"]')).toBeNull();
    expect(fileRow("y.md").disabled).toBe(false);
    expect(fileRow("a.md").disabled).toBe(false);
    await settle();
    expect(treeRequests()).toStrictEqual([ROOT, OUT]);
    expect(requests()).toStrictEqual([ROOT, OUT]);
  });

  it("带标记的行可访问名仍恰为文件名：标记是行按钮的兄弟元素，经 aria-describedby 关联", async () => {
    mount("out/a.md", { markedPaths: marked });
    await selectedRow("a.md");

    const rows = markedRows();
    expect(rows.map((row) => row.name)).toStrictEqual(["out", "a.md"]);
    // 按可访问名取行：标记若在按钮里，名字会多出标记文本，这两个查询就找不到。
    expect(rows[0]?.button).toBe(within(tree()).getByRole("button", { name: "折叠 out" }));
    expect(rows[1]?.button).toBe(within(tree()).getByRole("button", { name: "a.md" }));
    for (const { button, mark } of rows) {
      expect(button?.contains(mark)).toBe(false);
      expect(mark.parentElement?.tagName).toBe("LI");
      expect(mark.id).not.toBe("");
      expect(button?.getAttribute("aria-describedby")).toBe(mark.id);
    }
    // 没有标记的行没有这个属性。
    expect(fileRow("b.md").getAttribute("aria-describedby")).toBeNull();
    expect(
      within(tree()).getByRole("button", { name: "展开 src" }).getAttribute("aria-describedby"),
    ).toBeNull();
    expect(
      within(tree())
        .getByRole("button", { name: "折叠 设计文档" })
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("onlyPaths 下点目录行、refresh() 与 reveal 未加载的层都不请求 tree；reveal 选中父目录未加载的 y.md 并上报，随后的 refresh() 重取它的预览", async () => {
    const FILE_Y = `${FILE}x%2Fy.md`;
    const table = routes({ [FILE_Y]: () => textPreviewResponse("乙的正文") });
    const { browser, onPathChange, requests, update } = mount("out/a.md", {}, table);
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A]);

    update({ onlyPaths: only });
    await within(tree()).findByRole("button", { name: "y.md" });
    fireEvent.click(within(tree()).getByRole("button", { name: "折叠 x" }));
    fireEvent.click(within(tree()).getByRole("button", { name: "折叠 out" }));
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a.md", "x", "y.md"]);
    act(() => browser().reveal("x/y.md"));
    act(() => browser().refresh());
    await waitFor(() => {
      expect(requests()).toHaveLength(5);
    });
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A, FILE_Y, FILE_Y]);
    expect(fileRow("y.md").getAttribute("aria-current")).toBe("true");
    expect(fileRow("a.md").getAttribute("aria-current")).toBeNull();
    expect(onPathChange.mock.calls).toStrictEqual([["x/y.md"]]);
  });

  it("挂载时就带着 onlyPaths：连根也不请求；撤掉之后才请求根", async () => {
    // 根下的文件最先插入、名字又排在 `x` 前面：目录在前，同类再按名字。
    const { requests, update } = mount(null, {
      onlyPaths: new Set(["readme.md", "x/y.md", "out/a.md"]),
    });

    expect(await within(tree()).findByRole("button", { name: "y.md" })).toBeTruthy();
    expect(rowNames()).toStrictEqual(["设计文档", "out", "a.md", "x", "y.md", "readme.md"]);
    await settle();
    expect(requests()).toStrictEqual([]);

    update({});
    expect(await within(tree()).findByRole("button", { name: "展开 bad" })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT]);
  });

  it("撤掉 onlyPaths 后原展开与选中复原：没被展开过的目录仍是折叠的，期间与之后都没有新的请求", async () => {
    const { requests, update } = mount("out/a.md");
    await selectedRow("a.md");
    await previewRegion().findByText("甲的正文", { exact: true });
    const full = ["设计文档", "bad", "out", "a.md", "b.md", "src", "x", "readme.md"];
    expect(rowNames()).toStrictEqual(full);
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A]);

    update({ onlyPaths: only });
    await within(tree()).findByRole("button", { name: "y.md" });
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();

    update({});
    await waitFor(() => {
      expect(rowNames()).toStrictEqual(full);
    });
    expect(within(tree()).getByRole("button", { name: "折叠 out" })).toBeTruthy();
    for (const name of ["bad", "src", "x"]) {
      expect(within(tree()).getByRole("button", { name: `展开 ${name}` })).toBeTruthy();
    }
    expect(fileRow("a.md").getAttribute("aria-current")).toBe("true");
    expect(previewRegion().getByText("甲的正文", { exact: true })).toBeTruthy();
    await settle();
    expect(requests()).toStrictEqual([ROOT, OUT, FILE_A]);
  });
});

describe("WorkspaceBrowser 外框与可选槽位", () => {
  const frame = () => document.querySelector('[data-slot="files-layout"]') as HTMLElement;

  it("layout 缺省是分栏的网格类，stacked 换成上下排列的类（布局效果本身在 jsdom 里看不到）", async () => {
    const { update } = mount(null);
    await within(tree()).findByRole("button", { name: "readme.md" });
    expect(frame().classList.contains("grid")).toBe(true);
    expect(frame().classList.contains("flex-col")).toBe(false);

    update({ layout: "stacked" });
    expect(frame().classList.contains("grid")).toBe(false);
    expect(frame().classList.contains("flex")).toBe(true);
    expect(frame().classList.contains("flex-col")).toBe(true);
    // 同一棵树，没有重挂。
    expect(within(tree()).getByRole("button", { name: "readme.md" })).toBeTruthy();
  });

  it("不给 name / dir / onNewWorkspace：根行叫 工作空间、没有逻辑路径行，＋ 菜单只有 新建文件夹", async () => {
    mount(null, { dir: undefined, name: undefined });

    expect(await within(tree()).findByRole("button", { name: "折叠 工作空间" })).toBeTruthy();
    await within(tree()).findByRole("button", { name: "readme.md" });
    expect(tree().querySelector('[data-slot="tree-root-path"]')).toBeNull();
    await yieldMacrotask();
    pressPointer(screen.getByRole("button", { name: "新建" }));
    await screen.findByRole("menuitem", { name: "新建文件夹" });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toStrictEqual([
      "新建文件夹",
    ]);
  });

  it("给了 onNewWorkspace：＋ 菜单是 新建文件夹 与 新建工作空间 两项，后者带着触发器回调", async () => {
    const onNewWorkspace = vi.fn<(trigger: HTMLElement | null) => void>();
    mount(null, { onNewWorkspace });

    await within(tree()).findByRole("button", { name: "readme.md" });
    await yieldMacrotask();
    const trigger = screen.getByRole("button", { name: "新建" });
    pressPointer(trigger);
    await screen.findByRole("menuitem", { name: "新建文件夹" });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toStrictEqual([
      "新建文件夹",
      "新建工作空间",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "新建工作空间" }));
    expect(onNewWorkspace.mock.calls).toStrictEqual([[trigger]]);
  });
});

describe("两处同一份实现（静态）", () => {
  const FILES = "web/src/features/files";
  const CHAT = "web/src/features/chat";
  const isSource = (path: string) => /\.tsx?$/.test(path);
  const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g;

  /** `dir` 下每个源文件导入的模块：`[文件, 模块]`，模块是去掉后缀的仓库相对路径；包名不计。 */
  function importsUnder(dir: string): [string, string][] {
    return listRepoFiles(dir, isSource).flatMap((from) =>
      [...stripTsComments(readRepoFile(from)).matchAll(SPECIFIER)].flatMap(
        ([, specifier = ""]): [string, string][] => {
          const bare = specifier.replace(/\.(?:js|tsx?)$/, "");
          if (bare.startsWith("@/")) return [[from, posix.normalize(`web/src/${bare.slice(2)}`)]];
          if (bare.startsWith(".")) return [[from, posix.join(posix.dirname(from), bare)]];
          return [];
        },
      ),
    );
  }

  const under = (module: string, dir: string) => module === dir || module.startsWith(`${dir}/`);

  it("features/files 下没有文件导入 features/chat", () => {
    const imports = importsUnder(FILES);
    // 扫描没有放空：新组件对同目录模块的导入被扫到了。
    expect(imports).toContainEqual([`${FILES}/workspace-browser.tsx`, `${FILES}/tree`]);
    expect(imports.filter(([, module]) => under(module, CHAT))).toStrictEqual([]);
  });

  it("features/chat 导入文件页的东西只经 features/files/index，没有例外", () => {
    const imports = importsUnder(CHAT);
    const direct = imports.filter(
      ([, module]) => under(module, FILES) && module !== FILES && module !== `${FILES}/index`,
    );
    // 扫描没有放空：`formatSize` / `logicalPath` 经 index 的那几处导入被扫到了。
    expect(imports).toContainEqual([`${CHAT}/message-thread.tsx`, `${FILES}/index`]);
    expect(direct).toStrictEqual([]);
  });

  it("目录树的行组件与预览面板在 web/src 里各只有一个定义", () => {
    const sources = listRepoFiles("web/src", isSource).map(
      (path) => [path, stripTsComments(readRepoFile(path))] as const,
    );
    const definedIn = (pattern: RegExp) =>
      sources.flatMap(([path, code]) => (code.match(pattern) ?? []).map(() => path));
    expect(definedIn(/\bfunction DirectoryNode\b/g)).toStrictEqual([`${FILES}/tree.tsx`]);
    expect(definedIn(/\bfunction PreviewPane\b/g)).toStrictEqual([`${FILES}/preview.tsx`]);
  });

  it("workspace-browser.tsx 不导入路由、不碰地址与历史记录，预览只经 preview.js", () => {
    const code = stripTsComments(readRepoFile(`${FILES}/workspace-browser.tsx`));
    expect(code).not.toContain("react-router");
    expect(code).not.toMatch(/\blocation\b/);
    expect(code).not.toMatch(/\bhistory\b/);
    expect(code).not.toContain("previewers/");
    expect(readRepoFile(`${FILES}/index.ts`)).toContain("WorkspaceBrowser");
  });
});

describe("文件页包装", () => {
  it("换工作空间不带着上一个空间的当前路径：新空间里同名的文件不被选中、不请求它的 file", async () => {
    const rootWithReadme = () => jsonResponse({ path: "", entries: [fileEntry("readme.md", 8)] });
    const { fetchMock, router } = renderFiles(
      "/files?ws=workspace-1",
      authenticatedFilesRoutes([workspace, secondWorkspace], {
        [ROOT]: rootWithReadme,
        [FILE_README]: () => textPreviewResponse("自述正文"),
        "/api/workspaces/workspace-2/tree?path=": rootWithReadme,
      }),
    );
    const fileRequests = () =>
      fetchMock.mock.calls.map(([path]) => path).filter((path) => path.includes("/file?path="));

    fireEvent.click(await screen.findByRole("button", { name: "readme.md" }));
    expect(await previewRegion().findByText("自述正文", { exact: true })).toBeTruthy();
    expect(fileRequests()).toStrictEqual([FILE_README]);

    await act(async () => {
      await router.navigate("/files?ws=workspace-2");
    });
    await waitFor(() => {
      expect(
        within(screen.getByRole("button", { name: "选择工作空间" })).getByText(
          "zhangsan/data-analysis",
          { exact: true },
        ),
      ).toBeTruthy();
    });
    expect(await screen.findByRole("button", { name: "readme.md" })).toBeTruthy();
    await settle();
    expect(
      screen.getByRole("button", { name: "readme.md" }).getAttribute("aria-current"),
    ).toBeNull();
    expect(previewRegion().getByText("未选择文件", { exact: true })).toBeTruthy();
    expect(fileRequests()).toStrictEqual([FILE_README]);
  });
});
