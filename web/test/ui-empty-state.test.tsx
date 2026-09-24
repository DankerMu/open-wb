import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyState } from "../src/ui/index.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

afterEach(cleanup);

describe("EmptyState", () => {
  it("(E1) icon/title/description 渲染为约定结构", () => {
    const { container } = render(
      <EmptyState description="拖入文件或新建" icon="folder" title="空目录" />,
    );
    const root = container.firstElementChild;
    expect(root?.className).toBe("ui-empty-state");
    expect(root?.querySelector(".ui-empty-state-icon svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
    expect(root?.querySelector("p.ui-empty-state-title")?.textContent).toBe("空目录");
    expect(root?.querySelector("p.ui-empty-state-desc")?.textContent).toBe("拖入文件或新建");
  });

  it("(E2) 无 icon/description 时不渲染对应节点", () => {
    const { container } = render(<EmptyState title="暂无" />);
    const root = container.firstElementChild;
    expect(root?.querySelector("p.ui-empty-state-title")?.textContent).toBe("暂无");
    expect(root?.querySelector(".ui-empty-state-icon")).toBeNull();
    expect(root?.querySelector(".ui-empty-state-desc")).toBeNull();
    expect(root?.querySelector("svg")).toBeNull();
  });

  it("(E3) children 作为操作区渲染在 description 之后（根的最后子元素）", () => {
    const { container } = render(
      <EmptyState description="拖入文件或新建" icon="folder" title="空目录">
        <button type="button">新建</button>
      </EmptyState>,
    );
    const button = screen.getByRole("button", { name: "新建" });
    const root = container.firstElementChild;
    expect(root?.lastElementChild).toBe(button);
    expect(button.previousElementSibling?.classList.contains("ui-empty-state-desc")).toBe(true);
  });
});

describe("静态契约 (E4)", () => {
  const css = () => stripComments(readRepoFile("web/src/ui/empty-state.css"));

  it.each([
    [".ui-empty-state", /padding:\s*56px 20px/],
    [".ui-empty-state-icon", /width:\s*64px/],
    [".ui-empty-state-icon", /border-radius:\s*20px/],
    [".ui-empty-state-icon .ui-icon", /width:\s*28px/],
    [".ui-empty-state-icon .ui-icon", /height:\s*28px/],
  ])("empty-state.css %s 含 %s", (selector, pattern) => {
    expect(ruleBody(css(), selector)).toMatch(pattern);
  });
});
