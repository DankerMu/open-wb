import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../src/ui/index.js";
import { yieldMacrotask } from "./ui-support.js";

afterEach(async () => {
  cleanup();
  await yieldMacrotask();
  vi.restoreAllMocks();
});

const OPTIONS = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
] as const;

type Theme = (typeof OPTIONS)[number]["value"];

function ThemeControl({
  value,
  onValueChange,
}: {
  value: Theme;
  onValueChange: (value: Theme) => void;
}) {
  return (
    <SegmentedControl label="主题" onValueChange={onValueChange} options={OPTIONS} value={value} />
  );
}

function renderTheme(value: Theme = "light") {
  const onValueChange = vi.fn();
  render(<ThemeControl onValueChange={onValueChange} value={value} />);
  return { onValueChange };
}

function radio(name: string) {
  return screen.getByRole("radio", { name });
}

describe("角色与状态 (G1)", () => {
  it("radiogroup 名 `主题`，三个 radio，选中态由 aria-checked 与 data-state 表达", () => {
    renderTheme();
    const group = screen.getByRole("radiogroup", { name: "主题" });
    expect(group.className).toBe("ui-seg");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((item) => item.textContent)).toEqual(["浅色", "深色", "跟随系统"]);
    for (const item of radios) {
      expect(item.tagName).toBe("BUTTON");
      expect(item.getAttribute("type")).toBe("button");
      expect(item.className).toBe("ui-seg-item");
    }
    expect(radio("浅色").getAttribute("aria-checked")).toBe("true");
    expect(radio("浅色").getAttribute("data-state")).toBe("checked");
    for (const name of ["深色", "跟随系统"]) {
      expect(radio(name).getAttribute("aria-checked")).toBe("false");
      expect(radio(name).getAttribute("data-state")).toBe("unchecked");
    }
  });
});

describe("点击 (G2)", () => {
  it("点击未选中项 → onValueChange 一次，受控值未变前 aria-checked 不变", () => {
    const { onValueChange } = renderTheme();
    fireEvent.click(radio("深色"));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("dark");
    expect(radio("深色").getAttribute("aria-checked")).toBe("false");
    expect(radio("浅色").getAttribute("aria-checked")).toBe("true");
  });
});

describe("方向键 (G3)", () => {
  it.each([
    ["ArrowRight", "dark"],
    ["ArrowLeft", "system"],
  ] as const)("选中首项上 %s → onValueChange(%s)", async (key, expected) => {
    const { onValueChange } = renderTheme();
    const first = radio("浅色");
    act(() => first.focus());
    fireEvent.keyDown(first, { key });
    await waitFor(() => expect(onValueChange).toHaveBeenCalledWith(expected));
  });
});

describe("roving focus (G4)", () => {
  it("初始根元素 tabIndex=0、各项 -1；根元素获焦后焦点落在选中项", async () => {
    renderTheme("dark");
    const group = screen.getByRole("radiogroup", { name: "主题" });
    expect(group.tabIndex).toBe(0);
    for (const item of screen.getAllByRole("radio")) expect(item.tabIndex).toBe(-1);
    act(() => group.focus());
    await waitFor(() => expect(document.activeElement).toBe(radio("深色")));
    expect(radio("深色").tabIndex).toBe(0);
    expect(radio("浅色").tabIndex).toBe(-1);
    expect(radio("跟随系统").tabIndex).toBe(-1);
  });
});

describe("表单内 (G5)", () => {
  it("包在 form 内渲染不抛错，radio 仍为 3 个", () => {
    render(
      <form>
        <ThemeControl onValueChange={() => {}} value="system" />
      </form>,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
  });
});
