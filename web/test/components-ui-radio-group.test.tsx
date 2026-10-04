import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "./radix-platform.js";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

afterEach(cleanup);

/*
 * 拷入层允许的第六类修改：渲染被 registry 原文丢弃的调用方 children（只增不改）。
 * Radix 的 Indicator 只在选中时挂载，所以「只有指示器」一例必须渲染选中项。
 */
describe("拷入层 RadioGroupItem 渲染调用方 children", () => {
  it("带 children：文字在 role=radio 元素内，可访问名来自内容，指示器仍在", () => {
    render(
      <RadioGroup aria-label="主题" value="dark">
        <RadioGroupItem value="light">浅色</RadioGroupItem>
        <RadioGroupItem value="dark">深色</RadioGroupItem>
      </RadioGroup>,
    );

    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["浅色", "深色"]);
    const dark = screen.getByRole("radio", { name: "深色" });
    expect(dark).toBe(radios[1]);
    expect(dark.getAttribute("aria-checked")).toBe("true");
    expect(dark.firstElementChild?.getAttribute("data-slot")).toBe("radio-group-indicator");
    // 未选中项不挂指示器，内容只有调用方的文字。
    expect(radios[0]?.childNodes).toHaveLength(1);
    expect(radios[0]?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  });

  it("不带 children：选中项的内容只有指示器槽，未选中项为空", () => {
    render(
      <RadioGroup aria-label="主题" value="dark">
        <RadioGroupItem aria-label="浅色" value="light" />
        <RadioGroupItem aria-label="深色" value="dark" />
      </RadioGroup>,
    );

    const dark = screen.getByRole("radio", { name: "深色" });
    expect(dark.childNodes).toHaveLength(1);
    expect(dark.firstElementChild?.getAttribute("data-slot")).toBe("radio-group-indicator");
    expect(dark.textContent).toBe("");
    expect(screen.getByRole("radio", { name: "浅色" }).childNodes).toHaveLength(0);
  });
});
