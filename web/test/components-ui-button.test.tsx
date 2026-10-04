import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

afterEach(cleanup);

describe("拷入层 Button（经 @/ 别名导入）", () => {
  it("渲染为原生 button，默认变体与尺寸写在 data 属性上", () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("default");
    expect(button.getAttribute("data-size")).toBe("default");
    expect(button.classList.contains("bg-primary")).toBe(true);
  });

  it("asChild 把按钮属性合并到子元素，不再多包一层 button", () => {
    render(
      <Button asChild variant="link">
        <a href="/files">工作空间</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "工作空间" });
    expect(link.getAttribute("data-slot")).toBe("button");
    expect(link.getAttribute("data-variant")).toBe("link");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("调用方 className 覆盖变体里同组的 Tailwind 类", () => {
    render(<Button className="h-12">提交</Button>);
    const button = screen.getByRole("button", { name: "提交" });
    expect(button.classList.contains("h-12")).toBe(true);
    expect(button.classList.contains("h-8")).toBe(false);
  });
});

describe("cn", () => {
  it("展开条件写法并丢弃假值", () => {
    expect(cn("a", false, null, undefined, { b: true, c: false }, ["d"])).toBe("a b d");
  });

  it("同组 Tailwind 类后者胜出，不同组并存", () => {
    expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
    expect(cn("text-sm", "font-medium")).toBe("text-sm font-medium");
  });
});
