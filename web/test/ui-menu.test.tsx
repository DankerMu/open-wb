import "./radix-platform.js";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Menu, type MenuItem } from "../src/ui/index.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
  vi.restoreAllMocks();
});

/** 三项菜单（首项带图标、末项 danger）+ 页面上另一个按钮 `其他`（非模态断言用）。 */
function renderMenu() {
  const handlers = [vi.fn(), vi.fn(), vi.fn()] as const;
  const items: MenuItem[] = [
    { label: "新建文件夹", onSelect: handlers[0], icon: "folder" },
    { label: "新建工作空间", onSelect: handlers[1] },
    { label: "删除", onSelect: handlers[2], danger: true },
  ];
  render(
    <>
      <Menu items={items} trigger={<Button>新建</Button>} />
      <button type="button">其他</button>
    </>,
  );
  return { trigger: screen.getByRole("button", { name: "新建" }), handlers };
}

function menuItems() {
  return within(screen.getByRole("menu")).getAllByRole("menuitem");
}

function focusedOn(element: Element) {
  return waitFor(() => expect(document.activeElement).toBe(element));
}

/** Enter 打开并等首项获焦（Radix 经 document keydown 记下键盘模式，入场聚焦落到首项）。 */
async function openByKeyboard(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  await screen.findByRole("menu");
  const items = menuItems();
  await focusedOn(items[0] as HTMLElement);
  return items;
}

/** 在当前焦点项上按键并等焦点落到 `expected`。 */
async function press(key: string, expected: Element) {
  fireEvent.keyDown(document.activeElement as Element, { key });
  await focusedOn(expected);
}

describe("关闭态 (M1)", () => {
  it("无 menu，trigger 带 aria-haspopup=menu 与 aria-expanded=false", () => {
    const { trigger } = renderMenu();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("键盘打开 (M2)", () => {
  it("Enter 打开：menu portal 到 body、labelledby 指向 trigger、项数一致、首项获焦", async () => {
    const { trigger } = renderMenu();
    const items = await openByKeyboard(trigger);
    const menu = screen.getByRole("menu");
    expect(menu.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(document.body);
    expect(menu.getAttribute("aria-labelledby")).toBe(trigger.id);
    expect(trigger.id).not.toBe("");
    expect(items).toHaveLength(3);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("方向键 (M3)", () => {
  it("ArrowDown/End/Home 移动焦点", async () => {
    const [first, second, last] = await openByKeyboard(renderMenu().trigger);
    await press("ArrowDown", second as HTMLElement);
    await press("End", last as HTMLElement);
    await press("Home", first as HTMLElement);
  });

  it("loop：首项 ArrowUp → 末项，末项 ArrowDown → 首项", async () => {
    const [first, , last] = await openByKeyboard(renderMenu().trigger);
    await press("ArrowUp", last as HTMLElement);
    await press("ArrowDown", first as HTMLElement);
  });
});

describe("选择与关闭 (M4/M5)", () => {
  it("焦点项 Enter → 该项 onSelect 一次、菜单关闭、焦点回 trigger", async () => {
    const { trigger, handlers } = renderMenu();
    const [, second] = await openByKeyboard(trigger);
    await press("ArrowDown", second as HTMLElement);
    fireEvent.keyDown(second as HTMLElement, { key: "Enter" });
    expect(handlers[1]).toHaveBeenCalledTimes(1);
    expect(handlers[0]).not.toHaveBeenCalled();
    expect(handlers[2]).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await focusedOn(trigger);
  });

  it("Escape → 关闭、无 onSelect、焦点回 trigger", async () => {
    const { trigger, handlers } = renderMenu();
    const [first] = await openByKeyboard(trigger);
    fireEvent.keyDown(first as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await focusedOn(trigger);
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
  });
});

describe("指针 (M6)", () => {
  it("左键 pointerdown 打开；点击项 → onSelect 一次并关闭", async () => {
    const { trigger, handlers } = renderMenu();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await screen.findByRole("menu");
    fireEvent.click(menuItems()[2] as HTMLElement);
    expect(handlers[2]).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("项外观 (M7)", () => {
  it("danger 项加 --danger 类，icon 项含 14px aria-hidden svg，普通项无 --danger", async () => {
    const [folder, workspace, remove] = await openByKeyboard(renderMenu().trigger);
    expect(remove?.className).toBe("ui-menu-item ui-menu-item--danger");
    expect(workspace?.className).toBe("ui-menu-item");
    expect(workspace?.querySelector("svg")).toBeNull();
    const svg = folder?.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("ui-icon-14")).toBe(true);
  });
});

describe("非模态 (M8)", () => {
  it("打开期间 body 可点、其它元素未被 aria-hidden；外点序列后关闭", async () => {
    await openByKeyboard(renderMenu().trigger);
    expect(document.body.style.pointerEvents).toBe("");
    expect(screen.getByRole("button", { name: "其他" })).toBeTruthy();
    await yieldMacrotask();
    pressPointer(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});
