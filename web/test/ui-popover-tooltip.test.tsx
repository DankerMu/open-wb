import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Menu, Popover, SegmentedControl, Tooltip } from "../src/ui/index.js";
import {
  blockBody,
  pressPointer,
  readRepoFile,
  ruleBody,
  stripComments,
  yieldMacrotask,
} from "./ui-support.js";

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
  vi.restoreAllMocks();
});

type PopoverExtras = Omit<ComponentProps<typeof Popover>, "trigger" | "children">;

/** 触发器 `切换` + content 内首个可聚焦元素为 input。 */
function renderPopover(extras: PopoverExtras = {}) {
  const view = render(
    <Popover trigger={<Button>切换</Button>} {...extras}>
      <input aria-label="搜索" />
      <button type="button">条目</button>
    </Popover>,
  );
  return { view, trigger: screen.getByRole("button", { name: "切换" }) };
}

async function openPopover(extras: PopoverExtras = {}) {
  const { trigger } = renderPopover(extras);
  fireEvent.click(trigger);
  await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
  return trigger;
}

function popoverContent() {
  return document.querySelector(".ui-popover") as HTMLElement | null;
}

function focusedOn(element: Element) {
  return waitFor(() => expect(document.activeElement).toBe(element));
}

describe("Popover 默认角色 (P1)", () => {
  it("非受控点击打开：content 为 Radix 默认 dialog、portal 到 body、无 aria-label", async () => {
    const { trigger } = renderPopover();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.classList.contains("ui-popover")).toBe(true);
    expect(dialog.closest("[data-radix-popper-content-wrapper]")?.parentElement).toBe(
      document.body,
    );
    expect(dialog.hasAttribute("aria-label")).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Popover contentRole/contentLabel (P2)", () => {
  it("contentRole=dialog + contentLabel → 具名 dialog", async () => {
    await openPopover({ contentLabel: "工作空间切换器", contentRole: "dialog" });
    expect(screen.getByRole("dialog", { name: "工作空间切换器" })).toBe(popoverContent());
  });

  it("contentRole=group + contentLabel → 具名 group，且无 dialog", async () => {
    await openPopover({ contentLabel: "模型", contentRole: "group" });
    expect(screen.getByRole("group", { name: "模型" })).toBe(popoverContent());
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Popover 焦点与关闭 (P3/P4)", () => {
  it("打开聚焦 content 内首个 input；Escape 关闭并归还 trigger", async () => {
    const trigger = await openPopover();
    await focusedOn(screen.getByRole("textbox", { name: "搜索" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(popoverContent()).toBeNull());
    await focusedOn(trigger);
  });

  it("内点不关闭，外点序列关闭", async () => {
    await openPopover();
    await yieldMacrotask();
    pressPointer(screen.getByRole("button", { name: "条目" }));
    await yieldMacrotask();
    expect(popoverContent()).not.toBeNull();
    pressPointer(document.body);
    await waitFor(() => expect(popoverContent()).toBeNull());
  });
});

describe("Popover 受控 (P5)", () => {
  it("open=true 直接渲染；Escape 只回调 onOpenChange(false)；open=false 后消失", async () => {
    const onOpenChange = vi.fn();
    const { view } = renderPopover({ onOpenChange, open: true });
    expect(screen.getByRole("dialog")).toBe(popoverContent());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(popoverContent()).not.toBeNull();
    view.rerender(
      <Popover onOpenChange={onOpenChange} open={false} trigger={<Button>切换</Button>}>
        <input aria-label="搜索" />
      </Popover>,
    );
    await waitFor(() => expect(popoverContent()).toBeNull());
  });
});

describe("Popover 定位属性 (P6)", () => {
  it("content 带 Radix Popper 输出的 data-side/data-align", async () => {
    await openPopover();
    const content = popoverContent();
    expect(content?.getAttribute("data-side")).toBe("bottom");
    expect(content?.getAttribute("data-align")).toBe("center");
  });
});

function renderTooltip(side?: "top" | "right") {
  render(
    <Tooltip label="展开侧栏" side={side}>
      <Button aria-label="展开" size="icon" />
    </Tooltip>,
  );
  return screen.getByRole("button", { name: "展开" });
}

async function focusTooltip(trigger: HTMLElement) {
  act(() => trigger.focus());
  return screen.findByRole("tooltip");
}

function tooltipGone(trigger: HTMLElement) {
  return waitFor(() => {
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  });
}

describe("Tooltip 焦点 (T1–T4)", () => {
  it("初始无 tooltip、trigger 无 aria-describedby", () => {
    const trigger = renderTooltip();
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.hasAttribute("aria-describedby")).toBe(false);
  });

  it("focus 立即显示：可见 content 本身即 tooltip，describedby 指向它", async () => {
    const trigger = renderTooltip();
    const tooltip = await focusTooltip(trigger);
    expect(tooltip.textContent).toBe("展开侧栏");
    expect(tooltip.id).not.toBe("");
    expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
    expect(tooltip.classList.contains("ui-tooltip")).toBe(true);
  });

  it("blur 后隐藏并移除 aria-describedby", async () => {
    const trigger = renderTooltip();
    await focusTooltip(trigger);
    act(() => trigger.blur());
    await tooltipGone(trigger);
  });

  it("Escape 后隐藏", async () => {
    const trigger = renderTooltip();
    await focusTooltip(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    await tooltipGone(trigger);
  });
});

describe("Tooltip side (T5)", () => {
  it.each([
    ["right", "right"],
    [undefined, "top"],
  ] as const)("side=%s → data-side=%s", async (side, expected) => {
    await focusTooltip(renderTooltip(side));
    expect(document.querySelector(".ui-tooltip")?.getAttribute("data-side")).toBe(expected);
  });
});

describe("Tooltip hover (T6)", () => {
  it("pointerMove 300ms 后显示，pointerLeave 即隐藏", async () => {
    const trigger = renderTooltip();
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 350)));
    expect(screen.getByRole("tooltip").textContent).toBe("展开侧栏");
    fireEvent.pointerLeave(trigger);
    await tooltipGone(trigger);
  });
});

describe("静态契约 (S)", () => {
  const css = (name: string) => stripComments(readRepoFile(`web/src/ui/${name}.css`));
  const reduced = (name: string) =>
    blockBody(css(name), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);

  it.each([
    ["menu", ".ui-menu", /animation:\s*none/],
    ["menu", ".ui-menu-item", /transition:\s*none/],
    ["popover", ".ui-popover", /animation:\s*none/],
    ["tooltip", ".ui-tooltip", /animation:\s*none/],
    ["segmented-control", ".ui-seg-item", /transition:\s*none/],
  ])("%s.css reduced-motion 块：%s 含 %s", (name, selector, pattern) => {
    expect(ruleBody(reduced(name), selector)).toMatch(pattern);
  });

  it.each([
    ["menu", ".ui-menu", /z-index:\s*1600\b/],
    ["popover", ".ui-popover", /z-index:\s*1300\b/],
    ["tooltip", ".ui-tooltip", /z-index:\s*1700\b/],
    ["menu", ".ui-menu-item[data-highlighted]", /background:\s*var\(--wb-bg-hover\)/],
    ["segmented-control", '[data-theme="dark"] .ui-seg-item[data-state="checked"]', /background/],
    ["segmented-control", ".ui-seg-item:focus-visible", /border-radius:\s*99px/],
    ["tooltip", '[data-theme="dark"] .ui-tooltip', /background/],
  ])("%s.css %s 含 %s", (name, selector, pattern) => {
    expect(ruleBody(css(name), selector)).toMatch(pattern);
  });

  it("ui.css 汇总四个新 css", () => {
    const ui = readRepoFile("web/src/ui/ui.css");
    for (const name of ["menu", "popover", "tooltip", "segmented-control"]) {
      expect(ui).toContain(`@import "./${name}.css";`);
    }
  });
});

describe("出口 (X)", () => {
  it("四组件经 ui/index 导出", () => {
    for (const component of [Menu, Popover, Tooltip, SegmentedControl]) {
      expect(typeof component).toBe("function");
    }
  });
});
