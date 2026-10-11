import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodePreviewer } from "../src/features/files/previewers/code.js";
import type { Previewer } from "../src/features/files/previewers/index.js";
import { deferred, observeUnhandledRejections, settle } from "./chat-stream-support.js";

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
