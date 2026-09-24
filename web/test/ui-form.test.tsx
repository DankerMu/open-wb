import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Button,
  type ButtonProps,
  Chip,
  Input,
  Switch,
  Tag,
  type TagProps,
} from "../src/ui/index.js";
import {
  blockBody,
  COLOR_LITERAL_PATTERNS,
  readRepoFile,
  stripComments,
  topLevelBlocks,
} from "./ui-support.js";

afterEach(cleanup);

const COMPONENTS = ["button", "input", "switch", "tag", "chip"];
const VARIANTS: NonNullable<ButtonProps["variant"]>[] = ["primary", "secondary", "ghost", "danger"];
const TONES: NonNullable<TagProps["tone"]>[] = ["brand", "success", "warning", "error", "neutral"];

/** 文件内所有规则（含 @media 内）的逗号拆分后的选择器。 */
function selectors(css: string): string[] {
  return [...css.matchAll(/([^{}]+)\{/g)].flatMap(([, prelude = ""]) =>
    prelude.split(",").map((selector) => selector.trim()),
  );
}

/** 渲染后把 ref.current 交给 `report`，证明 `ref` 作为普通 prop 落到原生元素上。 */
function RefProbe({
  kind,
  report,
}: {
  kind: "button" | "input" | "search";
  report: (node: unknown) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => report(kind === "button" ? buttonRef.current : inputRef.current));
  if (kind === "button") return <Button ref={buttonRef}>x</Button>;
  if (kind === "search") return <Input aria-label="x" ref={inputRef} variant="search" />;
  return <Input aria-label="x" ref={inputRef} />;
}

describe("Button", () => {
  it("默认 secondary/md、type=button", () => {
    render(<Button>保存</Button>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.className).toBe("ui-btn ui-btn--secondary ui-btn--md");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });

  it("variant/size 映射类名，调用方可覆盖 type 并透传原生属性", () => {
    const onClick = vi.fn();
    render(
      <Button className="extra" onClick={onClick} size="lg" type="submit" variant="primary">
        提交
      </Button>,
    );
    const button = screen.getByRole("button", { name: "提交" });
    expect(button.className).toBe("ui-btn ui-btn--primary ui-btn--lg extra");
    expect(button.getAttribute("type")).toBe("submit");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it.each(VARIANTS)("variant=%s", (variant) => {
    render(<Button variant={variant}>x</Button>);
    expect(screen.getByRole("button").classList.contains(`ui-btn--${variant}`)).toBe(true);
  });

  it("size=icon 以 aria-label 为可访问名", () => {
    render(<Button aria-label="发送" size="icon" />);
    const button = screen.getByRole("button", { name: "发送" });
    expect(button.classList.contains("ui-btn--icon")).toBe(true);
  });

  it("loading：禁用、aria-busy、label 仍在 DOM、指示器 aria-hidden、点击不触发", () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    const button = screen.getByRole("button", { name: "保存" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("ui-btn--loading")).toBe(true);
    expect(screen.getByText("保存")).toBeTruthy();
    const spinner = container.querySelector(".ui-btn-spinner");
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(spinner?.classList.contains("ui-spin")).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabled 透传且不渲染指示器", () => {
    const { container } = render(<Button disabled>保存</Button>);
    expect(screen.getByRole("button").hasAttribute("disabled")).toBe(true);
    expect(container.querySelector(".ui-btn-spinner")).toBeNull();
  });

  it("ref 落到 <button>", () => {
    const report = vi.fn();
    render(<RefProbe kind="button" report={report} />);
    expect(report.mock.lastCall?.[0]).toBeInstanceOf(HTMLButtonElement);
  });
});

describe("Input", () => {
  it("默认渲染 ui-input 文本框并透传属性", () => {
    const onChange = vi.fn();
    render(<Input aria-label="账号" onChange={onChange} />);
    const input = screen.getByRole("textbox", { name: "账号" });
    expect(input.className).toBe("ui-input");
    fireEvent.change(input, { target: { value: "a" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("variant=search 渲染容器 + 图标 + searchbox", () => {
    const { container } = render(<Input placeholder="搜索" variant="search" />);
    const field = screen.getByRole("searchbox");
    expect(field.getAttribute("placeholder")).toBe("搜索");
    expect(field.classList.contains("ui-input-search-field")).toBe(true);
    const wrapper = container.querySelector(".ui-input.ui-input--search");
    expect(wrapper?.contains(field)).toBe(true);
    expect(wrapper?.querySelector("svg")).not.toBeNull();
  });

  it("disabled 透传", () => {
    render(<Input aria-label="账号" disabled />);
    expect(screen.getByRole("textbox", { name: "账号" }).hasAttribute("disabled")).toBe(true);
  });

  it.each(["input", "search"] as const)("ref 落到内层 <input>（%s）", (kind) => {
    const report = vi.fn();
    render(<RefProbe kind={kind} report={report} />);
    const node = report.mock.lastCall?.[0];
    expect(node).toBeInstanceOf(HTMLInputElement);
    expect(node).toBe(screen.getByRole(kind === "search" ? "searchbox" : "textbox"));
  });
});

describe("Switch", () => {
  it("受控：role=switch，点击回调 true 且状态不自变", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="深色" checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole("switch", { name: "深色" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("data-state")).toBe("unchecked");
    expect(control.classList.contains("ui-switch")).toBe(true);
    expect(control.querySelector(".ui-switch-thumb")).not.toBeNull();
    fireEvent.click(control);
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(control.getAttribute("data-state")).toBe("unchecked");
  });

  it("checked 时 data-state=checked", () => {
    render(<Switch aria-label="深色" checked onCheckedChange={() => {}} />);
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("data-state")).toBe("checked");
  });

  it("非受控：defaultChecked 透传，点击切换", () => {
    render(<Switch aria-label="深色" defaultChecked />);
    const control = screen.getByRole("switch");
    expect(control.getAttribute("data-state")).toBe("checked");
    fireEvent.click(control);
    expect(control.getAttribute("data-state")).toBe("unchecked");
  });

  it("disabled 时点击不触发", () => {
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="深色" disabled onCheckedChange={onCheckedChange} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("Tag", () => {
  it("默认 neutral", () => {
    render(<Tag>默认</Tag>);
    expect(screen.getByText("默认").className).toBe("ui-tag ui-tag--neutral");
  });

  it.each(TONES)("tone=%s", (tone) => {
    render(<Tag tone={tone}>标签</Tag>);
    expect(screen.getByText("标签").className).toBe(`ui-tag ui-tag--${tone}`);
  });
});

describe("Chip", () => {
  it("选中：aria-pressed=true、ui-chip--selected，点击触发 onSelect 一次", () => {
    const onSelect = vi.fn();
    render(
      <Chip onSelect={onSelect} selected>
        日常
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "日常" });
    expect(chip.getAttribute("type")).toBe("button");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.className).toBe("ui-chip ui-chip--selected");
    fireEvent.click(chip);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("未选中：aria-pressed=false、无 selected 类", () => {
    render(<Chip>全部</Chip>);
    const chip = screen.getByRole("button", { name: "全部" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.className).toBe("ui-chip");
  });

  it("disabled：禁用且点击不触发 onSelect", () => {
    const onSelect = vi.fn();
    render(
      <Chip disabled onSelect={onSelect}>
        日常
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "日常" });
    expect(chip.hasAttribute("disabled")).toBe(true);
    fireEvent.click(chip);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("表单基元 css 静态契约", () => {
  const buttonCss = () => stripComments(readRepoFile("web/src/ui/button.css"));

  it("loading 指示器绝对定位", () => {
    const spinner = topLevelBlocks(buttonCss()).find(
      (block) => block.prelude === ".ui-btn-spinner",
    );
    expect(spinner?.body).toMatch(/position:\s*absolute/);
  });

  it.each([
    ".ui-btn--primary .ui-btn-spinner",
    ".ui-btn--danger .ui-btn-spinner",
    '[data-theme="dark"] .ui-btn--primary .ui-btn-spinner',
  ])("实底按钮的指示器按变体取色：%s", (selector) => {
    const rule = topLevelBlocks(buttonCss()).find((block) =>
      block.prelude.split(",").some((part) => part.trim() === selector),
    );
    expect(rule?.body).toMatch(/border-color:\s*var\(--wb-/);
    expect(rule?.body).toMatch(/border-top-color:\s*transparent/);
  });

  it("button.css 最后一个规则块为 .ui-btn.ui-btn--loading 且文字透明", () => {
    const last = topLevelBlocks(buttonCss()).at(-1);
    expect(last?.prelude).toBe(".ui-btn.ui-btn--loading");
    expect(last?.body).toMatch(/color:\s*transparent/);
  });

  it("button.css 每个 :hover 选择器都带 :not(:disabled)", () => {
    const hovers = selectors(buttonCss()).filter((selector) => selector.includes(":hover"));
    expect(hovers.length).toBeGreaterThan(0);
    expect(hovers.filter((selector) => !selector.includes(":hover:not(:disabled)"))).toEqual([]);
  });

  it("tag.css 含深色 brand 覆盖", () => {
    const tag = stripComments(readRepoFile("web/src/ui/tag.css"));
    expect(selectors(tag)).toContain('[data-theme="dark"] .ui-tag--brand');
  });

  it.each(["button", "input", "switch", "chip"])(
    "%s.css 自带重申圆角的 :focus-visible 规则",
    (name) => {
      const css = stripComments(readRepoFile(`web/src/ui/${name}.css`));
      const focusRules = topLevelBlocks(css).filter((block) =>
        block.prelude.includes(":focus-visible"),
      );
      expect(focusRules.some((block) => /border-radius:/.test(block.body))).toBe(true);
    },
  );

  it.each([
    ["button", [".ui-btn"]],
    ["input", [".ui-input"]],
    ["switch", [".ui-switch", ".ui-switch-thumb"]],
    ["chip", [".ui-chip"]],
  ])("%s.css 在 reduced-motion 下关闭过渡", (name, expected) => {
    const css = stripComments(readRepoFile(`web/src/ui/${name}.css`));
    const body = blockBody(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(selectors(body)).toEqual(expect.arrayContaining(expected));
    expect(body).toMatch(/transition:\s*none/);
  });

  it("五个组件 css/tsx（含注释）无颜色字面量", () => {
    const hits = COMPONENTS.flatMap((name) => [`${name}.css`, `${name}.tsx`]).flatMap((file) =>
      readRepoFile(`web/src/ui/${file}`)
        .split("\n")
        .filter((line) => COLOR_LITERAL_PATTERNS.some((pattern) => pattern.test(line)))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("ui.css 汇总五个组件 css", () => {
    const ui = readRepoFile("web/src/ui/ui.css");
    for (const name of COMPONENTS) expect(ui).toContain(`@import "./${name}.css";`);
  });
});
