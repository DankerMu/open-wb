import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BrandMark, Icon, type IconName } from "../src/ui/index.js";

afterEach(cleanup);

/** tasks.md 2.6 登记的图标名全集。 */
const ICON_NAMES: IconName[] = [
  "message-square",
  "folder",
  "layout-grid",
  "settings",
  "shield",
  "file-text",
  "file-code",
  "table",
  "image",
  "archive",
  "file",
  "terminal",
  "wrench",
  "send",
  "copy",
  "plus",
  "search",
  "check",
  "x",
  "chevron-down",
  "chevron-right",
  "menu",
  "panel-left",
  "arrow-down",
  "log-out",
  "triangle-alert",
  "info",
  "circle-check",
  "code",
  "file-chart-line",
  "file-spreadsheet",
  "sparkles",
  "zap",
];

describe("Icon", () => {
  it("默认装饰性：aria-hidden 且无 role，默认尺寸 16", () => {
    const { container } = render(<Icon name="folder" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("role")).toBe(false);
    expect(svg?.classList.contains("ui-icon")).toBe(true);
    expect(svg?.classList.contains("ui-icon-16")).toBe(true);
  });

  it("传 label 时为 role=img 且以 label 为可访问名", () => {
    render(<Icon label="目录" name="folder" size={12} />);
    const svg = screen.getByRole("img", { name: "目录" });
    expect(svg.hasAttribute("aria-hidden")).toBe(false);
    expect(svg.classList.contains("ui-icon-12")).toBe(true);
    expect(svg.classList.contains("ui-icon-16")).toBe(false);
  });

  it("label 为空串时按装饰处理：aria-hidden 且无 role", () => {
    const { container } = render(<Icon label="" name="folder" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.hasAttribute("role")).toBe(false);
  });

  it.each([12, 14, 16, 18, 20] as const)("size=%i 输出对应的 ui-icon-<size> 类名", (size) => {
    const { container } = render(<Icon name="check" size={size} />);
    expect(container.querySelector("svg")?.classList.contains(`ui-icon-${size}`)).toBe(true);
  });

  it.each(ICON_NAMES)("%s 渲染 svg", (name) => {
    const { container } = render(<Icon name={name} />);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });
});

describe("BrandMark", () => {
  it("默认只渲染 mark svg，无字标", () => {
    const { container } = render(<BrandMark />);
    const svg = screen.getByRole("img", { name: "WorkBuddy" });
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("width")).toBe("28");
    expect(container.textContent).toBe("");
    expect(screen.queryByText("WorkBuddy")).toBeNull();
  });

  it("wordmark 时渲染字标文本，svg 退为装饰", () => {
    const { container } = render(<BrandMark size={20} wordmark />);
    expect(screen.getByText("WorkBuddy")).toBeTruthy();
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("width")).toBe("20");
    expect(screen.queryByRole("img")).toBeNull();
  });
});
