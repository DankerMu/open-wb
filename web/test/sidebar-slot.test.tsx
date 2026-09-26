import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SidebarNavigateProvider,
  SidebarSlotProvider,
  useSidebarNavigate,
  useSidebarSlot,
  useSidebarSlotContent,
} from "../src/lib/sidebar-slot.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Reporter({ label }: { label: string }) {
  useSidebarSlot(<p>{label}</p>);
  return null;
}

function Host() {
  const onNavigate = useSidebarNavigate();
  return (
    <aside aria-label="槽位">
      {useSidebarSlotContent()}
      <span>{onNavigate ? "有关闭回调" : "无关闭回调"}</span>
    </aside>
  );
}

function Tree({ label }: { label: string | null }) {
  return (
    <SidebarSlotProvider>
      {label === null ? null : <Reporter label={label} />}
      <Host />
    </SidebarSlotProvider>
  );
}

describe("sidebar slot", () => {
  it("Provider 外：上报 no-op、读取为 null、关闭回调为 undefined，且无报错", () => {
    const consoleError = vi.spyOn(console, "error");
    render(
      <>
        <Reporter label="列表" />
        <Host />
      </>,
    );
    expect(screen.queryByText("列表")).toBeNull();
    expect(screen.getByText("无关闭回调")).toBeTruthy();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("上报随渲染更新，卸载上报方即清空", () => {
    const view = render(<Tree label="甲" />);
    expect(screen.getByRole("complementary", { name: "槽位" }).textContent).toContain("甲");
    view.rerender(<Tree label="乙" />);
    expect(screen.queryByText("甲")).toBeNull();
    expect(screen.getByText("乙")).toBeTruthy();
    view.rerender(<Tree label={null} />);
    expect(screen.queryByText("乙")).toBeNull();
  });

  it("StrictMode 双挂载后节点仍在且只有一份", () => {
    render(
      <StrictMode>
        <Tree label="甲" />
      </StrictMode>,
    );
    expect(screen.getAllByText("甲")).toHaveLength(1);
  });

  it("SidebarNavigateProvider 把关闭回调交给其内的节点", () => {
    render(
      <SidebarNavigateProvider onNavigate={() => undefined}>
        <Host />
      </SidebarNavigateProvider>,
    );
    expect(screen.getByText("有关闭回调")).toBeTruthy();
  });
});
