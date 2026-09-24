import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../src/ui/index.js";
import { blockBody, readRepoFile, ruleBody, stripComments } from "./ui-support.js";

type Show = ReturnType<typeof useToast>["show"];

/** 探针：把 `useToast().show` 交给测试直接调用。 */
function Probe({ onReady }: { onReady: (show: Show) => void }) {
  onReady(useToast().show);
  return null;
}

function renderToasts() {
  let show!: Show;
  render(
    <ToastProvider>
      <Probe
        onReady={(value) => {
          show = value;
        }}
      />
    </ToastProvider>,
  );
  return (type: "success" | "error" | "info", message: string) =>
    act(() => show({ type, message }));
}

const toasts = () => Array.from(document.querySelectorAll<HTMLElement>(".ui-toast"));
const onlyToast = () => {
  const [toast] = toasts();
  if (!toast) throw new Error("未渲染 .ui-toast");
  return toast;
};
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const region = () => screen.getByRole("region", { name: "通知" });

describe("ToastProvider / useToast (jsdom, fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("(A1) 无 toast 时 region 名 通知 存在、列表为空、无 status", () => {
    renderToasts();
    const list = region().querySelector("ol");
    expect(list?.classList.contains("ui-toast-viewport")).toBe(true);
    expect(list?.querySelectorAll("li")).toHaveLength(0);
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it.each([
    ["success", "已复制"],
    ["error", "复制失败"],
    ["info", "已切换"],
  ] as const)(
    "(A2) show %s（%s）→ ui-toast--<type>、消息、aria-hidden 图标、polite 播报区",
    (type, message) => {
      const show = renderToasts();
      show(type, message);
      const toast = onlyToast();
      expect(toast.classList.contains(`ui-toast--${type}`)).toBe(true);
      expect(toast.textContent).toContain(message);
      expect(toast.querySelector(".ui-toast-message")?.textContent).toBe(message);
      expect(toast.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      expect(within(region()).getByText(message)).toBe(toast.querySelector(".ui-toast-message"));
      const statuses = screen.getAllByRole("status");
      expect(statuses.some((element) => element.getAttribute("aria-live") === "polite")).toBe(true);
      expect(statuses.some((element) => element.getAttribute("aria-live") === "assertive")).toBe(
        false,
      );
    },
  );

  it("(A3) 2399ms 仍在，2400ms 到期后从队列移除", () => {
    const show = renderToasts();
    show("success", "已复制");
    advance(2399);
    expect(toasts()).toHaveLength(1);
    advance(1);
    expect(toasts()).toHaveLength(0);
  });

  it("(A4) 连发四条只保留后三条（丢最旧），到期后全部消失", () => {
    const show = renderToasts();
    for (const message of ["m1", "m2", "m3", "m4"]) show("info", message);
    expect(toasts().map((toast) => toast.textContent)).toEqual(["m2", "m3", "m4"]);
    advance(2400);
    expect(toasts()).toHaveLength(0);
  });

  it("(A5) 指针悬停暂停计时，region 上 pointerleave 后恢复", () => {
    const show = renderToasts();
    show("success", "已复制");
    fireEvent.pointerMove(onlyToast());
    advance(5000);
    expect(toasts()).toHaveLength(1);
    fireEvent.pointerLeave(region());
    advance(2400);
    expect(toasts()).toHaveLength(0);
  });

  it("(A5) 聚焦暂停计时，失焦（focusout）后恢复", () => {
    const show = renderToasts();
    show("success", "已复制");
    fireEvent.focus(onlyToast());
    advance(5000);
    expect(toasts()).toHaveLength(1);
    fireEvent.blur(onlyToast());
    advance(2400);
    expect(toasts()).toHaveLength(0);
  });

  it("(A6) Provider 外调用 useToast 抛出含 ToastProvider 的错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe onReady={() => undefined} />)).toThrow(/ToastProvider/);
  });

  it("(A7) Escape 关闭", () => {
    const show = renderToasts();
    show("error", "复制失败");
    fireEvent.keyDown(onlyToast(), { key: "Escape" });
    expect(toasts()).toHaveLength(0);
  });
});

describe("静态契约 (A8)", () => {
  it.each(["web/src/main.tsx", "web/test/render-app-router.tsx"])(
    "%s 以 <ToastProvider> 包裹 <RouterProvider",
    (path) => {
      const source = readRepoFile(path);
      const start = source.indexOf("<ToastProvider>");
      const end = source.indexOf("</ToastProvider>");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(source.slice(start, end)).toContain("<RouterProvider");
    },
  );

  const toastCss = () => stripComments(readRepoFile("web/src/ui/toast.css"));

  it.each([
    [".ui-toast-viewport", /z-index:\s*2000\b/],
    [".ui-toast-viewport", /top:\s*52px/],
    [".ui-toast--success .ui-icon", /color:\s*var\(--wb-status-success-text\)/],
    [".ui-toast--error .ui-icon", /color:\s*var\(--wb-status-error-text\)/],
    [".ui-toast--info .ui-icon", /color:\s*var\(--wb-brand-primary\)/],
    [".ui-toast:focus-visible", /border-radius:\s*10px/],
  ])("toast.css %s 含 %s", (selector, pattern) => {
    expect(ruleBody(toastCss(), selector)).toMatch(pattern);
  });

  it("toast.css reduced-motion 块把 .ui-toast 置为 animation: none", () => {
    const reduced = blockBody(toastCss(), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(reduced).toMatch(/\.ui-toast\s*\{[^}]*animation:\s*none/);
  });

  it("ui.css 汇总 toast.css 与 empty-state.css；出口导出 ToastProvider/useToast（EmptyState 见 E1）", () => {
    const ui = readRepoFile("web/src/ui/ui.css");
    expect(ui).toContain('@import "./toast.css";');
    expect(ui).toContain('@import "./empty-state.css";');
    expect(ToastProvider).toBeTypeOf("function");
    expect(useToast).toBeTypeOf("function");
  });
});
