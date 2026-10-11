import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../src/features/files/preview.js";
import { ArchivePreviewer } from "../src/features/files/previewers/archive.js";
import { type ApiClient, ApiError } from "../src/lib/api.js";
import { ToastProvider } from "../src/ui/index.js";
import { hasLucideGlyph } from "./files-fixture.js";
import { readRepoFile, stripTsComments } from "./ui-support.js";

/*
 * file-previewers「压缩包列表」的三个场景，模块级：静态导入预览器直接渲染，`load` 是测试给的函数
 *（页面上它是 `client.listArchive` 的一次调用）。表格与文案在 `load` 落定之后才有，一律 `findBy…`。
 * 「选中压缩包发一次 archive、零次 file」是页面的事，钉在 files-page / files-empty-layout /
 * files-preview-states 三个文件里。
 */

type Listing = Awaited<ReturnType<ApiClient["listArchive"]>>;
type Entry = Listing["entries"][number];
type Load = (signal: AbortSignal) => Promise<Listing>;

const fetchStub = vi.fn(() => Promise.reject(new Error("the archive previewer must not fetch")));

beforeEach(() => {
  fetchStub.mockClear();
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function listing(entries: Entry[], truncated = false, format: Listing["format"] = "zip"): Listing {
  return { format, entries, truncated };
}

function file(path: string, size: number | null): Entry {
  return { path, type: "file", size };
}

/** 落定为 `value` 的 `load`；调用时收到的 signal 记在 `mock.calls` 里。 */
function loadOf(value: Listing) {
  return vi.fn<Load>(() => Promise.resolve(value));
}

function failing(error: unknown) {
  return vi.fn<Load>(() => Promise.reject(error));
}

/** 由测试决定何时落定的 `load`。 */
function pendingLoad() {
  let resolve: (value: Listing) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<Listing>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { load: vi.fn<Load>(() => promise), resolve, reject };
}

function signalOf(load: ReturnType<typeof vi.fn<Load>>, call = 0) {
  return load.mock.calls[call]?.[0] as AbortSignal;
}

async function rows() {
  return within(await screen.findByRole("table")).getAllByRole("row");
}

function cellsOf(row: HTMLElement) {
  return within(row).getAllByRole("cell");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("压缩包预览器：列表与截断", () => {
  it("三项的列表：「共 3 项」在表格之前，三行，大小格依次为 5 B、空、7 B，只有目录行带文件夹图标，表格里没有按钮或链接", async () => {
    const load = loadOf(
      listing([file("a.txt", 5), { path: "dir/", type: "dir", size: 0 }, file("dir/b.md", 7)]),
    );
    render(<ArchivePreviewer load={load} />);

    const table = await screen.findByRole("table");
    const count = screen.getByText("共 3 项", { exact: true });
    expect(count.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const all = within(table).getAllByRole("row");
    expect(all.map((row) => cellsOf(row).length)).toStrictEqual([2, 2, 2]);
    expect(all.map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual([
      "a.txt",
      "dir/",
      "dir/b.md",
    ]);
    expect(all.map((row) => cellsOf(row)[1]?.textContent)).toStrictEqual(["5 B", "", "7 B"]);
    expect(all.map((row) => hasLucideGlyph(row, "folder"))).toStrictEqual([false, true, false]);
    expect(within(table).queryAllByRole("button")).toStrictEqual([]);
    expect(within(table).queryAllByRole("link")).toStrictEqual([]);
    expect(screen.queryByText(/^仅显示前/)).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("1000 项且 truncated：显示「仅显示前 1000 项」与 1000 行，不同时写「共 1000 项」", async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => file(`f${index}.txt`, index));
    render(<ArchivePreviewer load={loadOf(listing(entries, true))} />);

    expect(await rows()).toHaveLength(1000);
    expect(screen.getByText("仅显示前 1000 项", { exact: true })).toBeTruthy();
    expect(screen.queryByText("共 1000 项")).toBeNull();
    expect(screen.queryByText(/^共 /)).toBeNull();
  });

  // 截断与否只看 `truncated`：服务端的上限可配，项数不到 1000 也可以是截断的。
  it("3 项且 truncated：显示「仅显示前 3 项」，没有「共 …」；1536 字节的成员大小格是「1.5 KB」", async () => {
    render(
      <ArchivePreviewer
        load={loadOf(listing([file("a.txt", 5), file("b.bin", 1536), file("c.md", 7)], true))}
      />,
    );

    const all = await rows();
    expect(all.map((row) => cellsOf(row)[1]?.textContent)).toStrictEqual(["5 B", "1.5 KB", "7 B"]);
    expect(screen.getByText("仅显示前 3 项", { exact: true })).toBeTruthy();
    expect(screen.queryByText(/^共 /)).toBeNull();
  });

  it("大小未知（gz 的单个成员，size 为 null）显示「—」；tar 里带大小的目录仍不显示大小", async () => {
    render(
      <ArchivePreviewer
        load={loadOf(
          listing([file("data.csv", null), { path: "d/", type: "dir", size: 1024 }], false, "gz"),
        )}
      />,
    );

    const all = await rows();
    expect(all.map((row) => cellsOf(row)[1]?.textContent)).toStrictEqual(["—", ""]);
    expect(screen.getByText("共 2 项", { exact: true })).toBeTruthy();
  });

  it.each([
    ["truncated 为 false", false],
    ["truncated 为 true", true],
  ])("空包（%s）：只显示「压缩包内没有文件」，没有表格也没有计数行", async (_label, truncated) => {
    render(<ArchivePreviewer load={loadOf(listing([], truncated))} />);

    expect(await screen.findByText("压缩包内没有文件", { exact: true })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/项$/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("读取中显示「正在读取文件」，落定后它消失", async () => {
    const pending = pendingLoad();
    render(<ArchivePreviewer load={pending.load} />);

    expect(screen.getByRole("status").textContent).toBe("正在读取文件");
    expect(screen.queryByRole("table")).toBeNull();

    pending.resolve(listing([file("a.txt", 5)]));
    expect(await rows()).toHaveLength(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("压缩包预览器：恶意成员名只是文字", () => {
  const HOSTILE = [
    "../../etc/passwd",
    "/abs/x",
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    " a ",
    "é",
    "é",
    "",
    "../../etc/passwd",
  ];

  it("路径格的文本与 title 都是成员名原样（首尾空格、空串、合成与分解形式的 é、重复项），行数等于项数，文档里没有 img 或 script", async () => {
    render(
      <ArchivePreviewer load={loadOf(listing(HOSTILE.map((path, index) => file(path, index))))} />,
    );

    const all = await rows();
    // 逐行按下标比：`getByText` 会折叠空白，证不了首尾空格。
    expect(all).toHaveLength(HOSTILE.length);
    for (const [index, path] of HOSTILE.entries()) {
      const cell = cellsOf(all[index] as HTMLElement)[0];
      expect(cell?.textContent, `row ${index} text`).toBe(path);
      expect(cell?.getAttribute("title"), `row ${index} title`).toBe(path);
    }
    expect(all.map((row) => cellsOf(row)[1]?.textContent)).toStrictEqual(
      HOSTILE.map((_, index) => `${index} B`),
    );
    expect(document.querySelector("img, script")).toBeNull();
    expect(screen.getByText(`共 ${HOSTILE.length} 项`, { exact: true })).toBeTruthy();
  });

  it("点击任何一格都不发请求：load 仍恰一次、全局 fetch 零次，地址不变", async () => {
    const load = loadOf(
      listing([
        file("../../etc/passwd", 5),
        { path: "dir/", type: "dir", size: 0 },
        file("<img src=x onerror=alert(1)>", 7),
      ]),
    );
    render(<ArchivePreviewer load={load} />);

    const all = await rows();
    // 先断起点：下面「不变」比的是已经发生过一次的 load。
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(0);
    const href = window.location.href;

    for (const row of all) {
      fireEvent.click(row);
      for (const cell of cellsOf(row)) {
        fireEvent.click(cell);
        fireEvent.doubleClick(cell);
      }
    }
    await flush();

    expect(load).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(0);
    expect(window.location.href).toBe(href);
    expect(await rows()).toHaveLength(3);
  });

  it("模块源码里没有可点的元素，也没有任何取文件或下载的入口", () => {
    const code = stripTsComments(readRepoFile("web/src/features/files/previewers/archive.tsx"));
    expect(code).not.toMatch(/<a[\s>]/);
    expect(code).not.toMatch(/<button\b/);
    for (const needle of ["onClick", "fetch", "fileUrl", "downloadUrl", "href"]) {
      expect(code, needle).not.toContain(needle);
    }
  });
});

describe("压缩包预览器：损坏的压缩包与其它失败", () => {
  function archivePane(load: Load) {
    return (
      <ToastProvider>
        <PreviewPane
          mtime={1_700_000_000_000}
          name="x.zip"
          path="uploads/x.zip"
          preview={{ status: "archive", load }}
          previewToken={{ status: "idle" }}
          size={2048}
          workspaceId="w1"
        />
      </ToastProvider>
    );
  }

  it("损坏的压缩包：load 以 415 preview_unsupported 拒绝时显示「无法读取该压缩包」，下载链接仍在，没有 Toast", async () => {
    // 挂在 ToastProvider 之下：通知区在场，「没有 Toast」才不是空话。
    const load = failing(new ApiError(415, "preview_unsupported", "该类型不支持预览"));
    render(archivePane(load));
    const toasts = screen.getByRole("region", { name: "通知" });

    expect((await screen.findByRole("alert")).textContent).toBe("无法读取该压缩包");
    const link = screen.getByRole("link", { name: "下载 x.zip" });
    expect(link.getAttribute("href")).toBe("/api/workspaces/w1/download?path=uploads%2Fx.zip");
    expect(link.hasAttribute("download")).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText("该类型不支持预览")).toBeNull();
    // 让出一轮：Toast 若有，是在文案之后的一次状态更新里才进通知区的。
    await flush();
    expect(within(toasts).queryByRole("listitem")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "413 的信封 message（客户端映射；不是不支持态）",
      new ApiError(413, "preview_too_large", "文件过大，无法预览"),
      "文件过大，无法预览",
    ],
    ["404 的信封 message", new ApiError(404, "not_found", "文件不存在"), "文件不存在"],
    [
      "信封残缺的 415（code 不是 preview_unsupported）按请求失败算",
      new ApiError(415, "request_failed", "请求失败，请稍后重试"),
      "请求失败，请稍后重试",
    ],
    ["不是 ApiError 的拒绝时的安全文案", new TypeError("Failed to fetch"), "请求失败，请稍后重试"],
  ])("其它失败显示%s", async (_label, error, expected) => {
    render(<ArchivePreviewer load={failing(error)} />);

    expect((await screen.findByRole("alert")).textContent).toBe(expected);
    expect(screen.queryByText("无法读取该压缩包")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("401 交给认证守卫：仍是「正在读取文件」，没有 alert", async () => {
    const load = failing(new ApiError(401, "unauthorized", "未登录"));
    render(<ArchivePreviewer load={load} />);

    await flush();
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("正在读取文件");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("没有 load（不经页面直接渲染）：显示请求失败的安全文案，零请求", async () => {
    render(<ArchivePreviewer />);

    expect((await screen.findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    expect(screen.queryByRole("status")).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });
});

describe("压缩包预览器：请求归属", () => {
  it("卸载即中止在途的 load", () => {
    const first = pendingLoad();
    const view = render(<ArchivePreviewer load={first.load} />);
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(signalOf(first.load).aborted).toBe(false);

    view.unmount();
    expect(signalOf(first.load).aborted).toBe(true);

    // 第二个实例：中止的是各自那一次调用的 signal。
    const second = pendingLoad();
    const again = render(<ArchivePreviewer load={second.load} />);
    expect(signalOf(second.load).aborted).toBe(false);
    again.unmount();
    expect(signalOf(second.load).aborted).toBe(true);
    expect(second.load).toHaveBeenCalledTimes(1);
  });

  it("换一个 load（刷新或再点同一行）：旧 signal 中止、新 load 恰调一次，等待期间是读取态，迟到的旧结果不顶掉新列表", async () => {
    const old = pendingLoad();
    const shown = loadOf(listing([file("old.txt", 1)]));
    const view = render(<ArchivePreviewer load={shown} />);
    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual(["old.txt"]);

    view.rerender(<ArchivePreviewer load={old.load} />);
    expect(signalOf(shown).aborted).toBe(true);
    expect(old.load).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe("正在读取文件");
    expect(screen.queryByRole("table")).toBeNull();

    const next = pendingLoad();
    view.rerender(<ArchivePreviewer load={next.load} />);
    expect(signalOf(old.load).aborted).toBe(true);
    expect(signalOf(next.load).aborted).toBe(false);
    expect(next.load).toHaveBeenCalledTimes(1);

    old.resolve(listing([file("stale.txt", 2)]));
    await flush();
    expect(screen.queryByText("stale.txt")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("正在读取文件");

    next.resolve(listing([file("new-1.txt", 3), file("new-2.txt", 4)]));
    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual([
      "new-1.txt",
      "new-2.txt",
    ]);
    expect(screen.getByText("共 2 项", { exact: true })).toBeTruthy();
    expect(shown).toHaveBeenCalledTimes(1);
    expect(old.load).toHaveBeenCalledTimes(1);
  });

  // StrictMode 把 effect 跑两遍，两遍拿的是同一个 load：第一遍的结果只能靠它自己的 signal 认出来。
  it("StrictMode 下第一遍被中止的那次调用迟到的拒绝不顶掉列表（客户端对被中止的请求以 request_failed 拒绝）", async () => {
    const late = pendingLoad();
    const load = vi
      .fn<Load>()
      .mockImplementationOnce(late.load)
      .mockImplementation(() => Promise.resolve(listing([file("fresh.txt", 1)])));
    render(
      <StrictMode>
        <ArchivePreviewer load={load} />
      </StrictMode>,
    );

    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual(["fresh.txt"]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(signalOf(load, 0).aborted).toBe(true);
    expect(signalOf(load, 1).aborted).toBe(false);

    late.reject(new ApiError(0, "request_failed", "请求失败，请稍后重试"));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual(["fresh.txt"]);
  });

  it("StrictMode 下第一遍被中止的那次调用迟到的列表不顶掉第二遍的列表", async () => {
    const late = pendingLoad();
    const load = vi
      .fn<Load>()
      .mockImplementationOnce(late.load)
      .mockImplementation(() => Promise.resolve(listing([file("fresh.txt", 1)])));
    render(
      <StrictMode>
        <ArchivePreviewer load={load} />
      </StrictMode>,
    );

    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual(["fresh.txt"]);
    late.resolve(listing([file("stale.txt", 2)]));
    await flush();
    expect(screen.queryByText("stale.txt")).toBeNull();
    expect((await rows()).map((row) => cellsOf(row)[0]?.textContent)).toStrictEqual(["fresh.txt"]);
  });

  it("失败之后换一个 load：错误文案让位给读取态，再让位给新列表", async () => {
    const view = render(
      <ArchivePreviewer
        load={failing(new ApiError(415, "preview_unsupported", "该类型不支持预览"))}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("无法读取该压缩包");

    view.rerender(<ArchivePreviewer load={loadOf(listing([file("a.txt", 5)]))} />);
    expect(await rows()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
