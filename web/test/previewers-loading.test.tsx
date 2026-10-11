import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodePreviewer } from "../src/features/files/previewers/code.js";
import type { Previewer } from "../src/features/files/previewers/index.js";
import { deferred, observeUnhandledRejections, settle } from "./chat-stream-support.js";
import { jsonResponse, textPreviewResponse } from "./support.js";

/*
 * file-previewers「按需加载」的 `PreviewPane` 级部分。加载函数换成桩（`previewKind` / `textView` 保持原样），
 * 所以「调用次数」数的是 `preview.tsx` 对 `previewers/index.ts` 的调用，不是块请求本身。
 * `preview.tsx` 的缓存在模块级：每条用例重置模块后重新导入，否则前一条留下的已就绪条目会让后一条的次数断言空转。
 */
const stub = vi.hoisted(() => ({ loadPreviewer: vi.fn() }));

vi.mock("../src/features/files/previewers/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/files/previewers/index.js")>()),
  loadPreviewer: stub.loadPreviewer,
}));

beforeEach(() => {
  stub.loadPreviewer.mockReset();
  vi.resetModules();
});

afterEach(cleanup);

async function freshPreviewPane() {
  return (await import("../src/features/files/preview.js")).PreviewPane;
}

type Pane = Awaited<ReturnType<typeof freshPreviewPane>>;

function sourcePreview(PreviewPane: Pane, name: string, text: string) {
  return (
    <PreviewPane
      mtime={1_726_000_000_000}
      name={name}
      path={name}
      preview={{
        data: { kind: "text", size: text.length, text, truncated: false },
        status: "success",
      }}
      size={text.length}
      workspaceId="w1"
    />
  );
}

function sourceLines(): (string | null | undefined)[] {
  return screen.getAllByRole("row").map((row) => within(row).getAllByRole("cell")[1]?.textContent);
}

describe("PreviewPane 的预览器按需加载", () => {
  it("加载挂起时显示带 status 角色的「正在加载预览…」，放行后占位消失并显示源码", async () => {
    const gate = deferred<Previewer>();
    stub.loadPreviewer.mockReturnValue(gate.promise);
    const PreviewPane = await freshPreviewPane();

    render(sourcePreview(PreviewPane, "main.py", "print(1)"));

    expect(screen.getByText("正在加载预览…").getAttribute("role")).toBe("status");
    expect(screen.queryByRole("row")).toBeNull();
    expect(stub.loadPreviewer.mock.calls).toEqual([["code"]]);

    await act(async () => {
      gate.resolve(CodePreviewer);
    });

    expect(screen.queryByText("正在加载预览…")).toBeNull();
    expect(sourceLines()).toEqual(["print(1)"]);
  });

  it("同一类别换一个文件再渲染时不再调用加载函数", async () => {
    stub.loadPreviewer.mockImplementation(() => Promise.resolve(CodePreviewer));
    const PreviewPane = await freshPreviewPane();

    const view = render(sourcePreview(PreviewPane, "a.ts", "const a = 1;"));
    await screen.findAllByRole("row");
    expect(sourceLines()).toEqual(["const a = 1;"]);

    view.rerender(sourcePreview(PreviewPane, "b.ts", "const b = 2;"));
    await screen.findByRole("cell", { name: "const b = 2;" });
    expect(sourceLines()).toEqual(["const b = 2;"]);

    expect(stub.loadPreviewer.mock.calls).toEqual([["code"]]);
  });

  it("StrictMode 的双 effect 共用同一次在途加载，加载函数只被调用一次", async () => {
    const gate = deferred<Previewer>();
    stub.loadPreviewer.mockReturnValue(gate.promise);
    const PreviewPane = await freshPreviewPane();

    render(<StrictMode>{sourcePreview(PreviewPane, "main.py", "print(1)")}</StrictMode>);
    expect(screen.getByText("正在加载预览…")).toBeTruthy();
    await act(async () => {
      gate.resolve(CodePreviewer);
    });

    expect(sourceLines()).toEqual(["print(1)"]);
    expect(stub.loadPreviewer.mock.calls).toEqual([["code"]]);
  });

  it("加载第一次被拒绝时显示「预览组件加载失败」与「重试」，重试后显示源码且没有未处理的拒绝", async () => {
    stub.loadPreviewer
      .mockImplementationOnce(() => Promise.reject(new Error("chunk request failed")))
      .mockImplementation(() => Promise.resolve(CodePreviewer));
    const PreviewPane = await freshPreviewPane();
    const observer = observeUnhandledRejections();
    try {
      render(sourcePreview(PreviewPane, "main.py", "print(1)"));

      expect(await screen.findByText("预览组件加载失败")).toBeTruthy();
      expect(screen.queryByText("正在加载预览…")).toBeNull();
      expect(screen.queryByRole("row")).toBeNull();
      expect(stub.loadPreviewer.mock.calls).toEqual([["code"]]);

      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      await screen.findAllByRole("row");

      expect(sourceLines()).toEqual(["print(1)"]);
      expect(screen.queryByText("预览组件加载失败")).toBeNull();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
      expect(stub.loadPreviewer.mock.calls).toEqual([["code"], ["code"]]);
      await settle();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});

/*
 * 页面级：经整页渲染走到 `PreviewPane`。`files-fixture.js` 在每条用例里动态导入——静态导入会钉住重置之前的
 * 模块图（连同 `preview.tsx` 的缓存），后一条的次数断言就空转；用同一份导入的 `cleanupFilesFixture` 收尾，
 * 文件级的 `afterEach(cleanup)` 不释放 router。
 */
const TREE_ROOT = "/api/workspaces/workspace-1/tree?path=";
const TREE_SRC = "/api/workspaces/workspace-1/tree?path=src";

async function renderSourceWorkspace() {
  const fixture = await import("./files-fixture.js");
  const mounted = fixture.renderFiles(
    "/files?ws=workspace-1",
    fixture.authenticatedFilesRoutes([fixture.workspace], {
      [TREE_ROOT]: () =>
        jsonResponse({
          path: "",
          entries: [
            { name: "src", type: "dir", size: 0, mtime: 101 },
            { name: "main.py", type: "file", size: 8, mtime: 102 },
            { name: "other.ts", type: "file", size: 12, mtime: 103 },
          ],
        }),
      [TREE_SRC]: () => jsonResponse({ path: "src", entries: [] }),
      "/api/workspaces/workspace-1/file?path=main.py": () => textPreviewResponse("print(1)"),
      "/api/workspaces/workspace-1/file?path=other.ts": () => textPreviewResponse("const b = 2;"),
    }),
  );
  return { ...mounted, fixture };
}

describe("文件页的预览器按需加载", () => {
  it("第一次才加载：展开目录不加载预览器，选中 main.py 时源码预览器恰加载一次并显示占位，再选 other.ts 不再加载", async () => {
    const gate = deferred<Previewer>();
    stub.loadPreviewer.mockReturnValue(gate.promise);
    const { fixture } = await renderSourceWorkspace();
    try {
      fireEvent.click(await screen.findByRole("button", { name: "展开 src" }));
      expect(await screen.findByText("空目录", { exact: true })).toBeTruthy();
      expect(stub.loadPreviewer.mock.calls).toStrictEqual([]);

      fireEvent.click(screen.getByRole("button", { name: "main.py" }));
      expect((await screen.findByText("正在加载预览…")).getAttribute("role")).toBe("status");
      expect(screen.queryByRole("row")).toBeNull();
      expect(stub.loadPreviewer.mock.calls).toStrictEqual([["code"]]);

      await act(async () => {
        gate.resolve(CodePreviewer);
      });
      expect(await screen.findByRole("cell", { name: "print(1)" })).toBeTruthy();
      expect(screen.queryByText("正在加载预览…")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "other.ts" }));
      expect(await screen.findByRole("cell", { name: "const b = 2;" })).toBeTruthy();
      expect(sourceLines()).toStrictEqual(["const b = 2;"]);
      expect(stub.loadPreviewer.mock.calls).toStrictEqual([["code"]]);
    } finally {
      fixture.cleanupFilesFixture();
    }
  });

  it("加载失败可重试：失败时显示「预览组件加载失败」「重试」与「下载 main.py」且目录树仍可展开，重试后显示源码且没有未处理的拒绝", async () => {
    stub.loadPreviewer
      .mockImplementationOnce(() => Promise.reject(new Error("chunk request failed")))
      .mockImplementation(() => Promise.resolve(CodePreviewer));
    const { fetchMock, fixture } = await renderSourceWorkspace();
    const observer = observeUnhandledRejections();
    try {
      fireEvent.click(await screen.findByRole("button", { name: "main.py" }));

      expect(await screen.findByText("预览组件加载失败")).toBeTruthy();
      expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
      const link = screen.getByRole("link", { name: "下载 main.py" });
      expect(link.getAttribute("href")).toBe("/api/workspaces/workspace-1/download?path=main.py");
      expect(link.hasAttribute("download")).toBe(true);
      expect(screen.queryByRole("row")).toBeNull();
      expect(stub.loadPreviewer.mock.calls).toStrictEqual([["code"]]);

      expect(fetchMock.mock.calls.filter(([path]) => path === TREE_SRC)).toStrictEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "展开 src" }));
      expect(await screen.findByText("空目录", { exact: true })).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([path]) => path === TREE_SRC)).toHaveLength(1);
      expect(screen.getByText("预览组件加载失败")).toBeTruthy();

      fireEvent.click(screen.getByRole("button", { name: "重试" }));
      expect(await screen.findByRole("cell", { name: "print(1)" })).toBeTruthy();

      expect(sourceLines()).toStrictEqual(["print(1)"]);
      expect(screen.queryByText("预览组件加载失败")).toBeNull();
      expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
      expect(screen.getByRole("link", { name: "下载 main.py" })).toBeTruthy();
      expect(stub.loadPreviewer.mock.calls).toStrictEqual([["code"], ["code"]]);
      await settle();
      expect(observer.unhandled).toStrictEqual([]);
    } finally {
      observer.stop();
      fixture.cleanupFilesFixture();
    }
  });
});
