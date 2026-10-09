import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

/*
 * 拷入层 `resizable` 此刻没有应用层调用方：本文件是它（连同 `react-resizable-panels`）的唯一导入方。
 * 库在 Group 挂载时无条件 new 一个 ResizeObserver，jsdom 没有它，桩只写在这里。
 */
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderGroup(withHandle: boolean) {
  return render(
    <ResizablePanelGroup aria-label="分栏" className="caller-group">
      <ResizablePanel aria-label="左栏">左</ResizablePanel>
      <ResizableHandle aria-label="调整宽度" className="caller-handle" withHandle={withHandle} />
      <ResizablePanel aria-label="右栏">右</ResizablePanel>
    </ResizablePanelGroup>,
  );
}

const slot = (container: HTMLElement, name: string) => [
  ...container.querySelectorAll(`[data-slot="${name}"]`),
];

describe("拷入层 resizable", () => {
  it("三个部件各带 data-slot：一个组、两个面板、一条分隔线", () => {
    const { container } = renderGroup(true);

    expect(slot(container, "resizable-panel-group")).toHaveLength(1);
    expect(slot(container, "resizable-panel").map((panel) => panel.textContent)).toEqual([
      "左",
      "右",
    ]);
    expect(slot(container, "resizable-handle")).toEqual([screen.getByRole("separator")]);
  });

  it("分隔线是 role=separator 且可聚焦", () => {
    renderGroup(true);

    const separator = screen.getByRole("separator");
    separator.focus();
    expect(document.activeElement).toBe(separator);
  });

  it("withHandle：分隔线内恰有一个子 div；不带时为空", () => {
    const withHandle = renderGroup(true);
    const children = [...screen.getByRole("separator").children];
    expect(children.map((child) => child.tagName)).toEqual(["DIV"]);
    withHandle.unmount();

    renderGroup(false);
    expect(screen.getByRole("separator").children).toHaveLength(0);
  });

  it("调用方 className 透传到组与分隔线，与组件自带的类并存", () => {
    const { container } = renderGroup(true);

    const group = slot(container, "resizable-panel-group")[0];
    expect(group?.classList.contains("caller-group")).toBe(true);
    expect(group?.classList.contains("flex")).toBe(true);
    const separator = screen.getByRole("separator");
    expect(separator.classList.contains("caller-handle")).toBe(true);
    expect(separator.classList.contains("bg-border")).toBe(true);
  });

  it("className 之外的调用方属性原样落到三个部件的元素上", () => {
    const { container } = renderGroup(false);

    const label = (name: string) =>
      slot(container, name).map((element) => element.getAttribute("aria-label"));
    expect(label("resizable-panel-group")).toEqual(["分栏"]);
    expect(label("resizable-panel")).toEqual(["左栏", "右栏"]);
    expect(label("resizable-handle")).toEqual(["调整宽度"]);
  });
});
