import "./radix-platform.js";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type ReactNode, StrictMode, useReducer } from "react";
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type TopbarAction,
  TopbarProvider,
  useTopbar,
  useTopbarActions,
} from "../src/lib/topbar.js";
import { Topbar } from "../src/routes/shell/topbar.js";
import { Icon, type IconName } from "../src/ui/index.js";
import { readRepoFile, ruleBody, stripComments, yieldMacrotask } from "./ui-support.js";

const LABEL = "示例操作";
const NAV = "打开导航";
const SESSION_PATH = "/?session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FILES_PATH = "/files";
const CRUMB = "我的工作 / T";

type Report = { breadcrumb?: string; actions?: readonly TopbarAction[] };

let disposeRouter: (() => void) | undefined;

afterEach(async () => {
  cleanup();
  disposeRouter?.();
  disposeRouter = undefined;
  await yieldMacrotask();
  vi.restoreAllMocks();
});

/** 描述符：默认不含 `expanded` 键（省略，不是 undefined）。 */
function action(overrides: Partial<TopbarAction> = {}): TopbarAction {
  return { key: "sample", label: LABEL, icon: "search", onSelect: () => undefined, ...overrides };
}

/** 测试页面：只做上报，不渲染任何顶栏内容。 */
function Page({ report }: { report: Report }) {
  useTopbar(report);
  return <p>页面</p>;
}

/**
 * 后续会话页的写法：`expanded` 由条件算出，无值时是显式 `undefined` 而不是省略键——
 * `exactOptionalPropertyTypes` 下这个字面量能通过类型检查本身就是断言（`make typecheck` 覆盖测试文件）。
 */
function ConditionalPage({ open }: { open: boolean }) {
  const descriptor: TopbarAction = {
    key: "sample",
    label: LABEL,
    icon: "search",
    expanded: open ? true : undefined,
    onSelect: () => undefined,
  };
  useTopbar({ breadcrumb: "T", actions: [descriptor] });
  return <p>页面</p>;
}

/** 与 AppShell 同构的最小外壳：顶栏在 main 之外；`narrow` 时传入 `打开导航` 回调。 */
function Shell({ narrow, children }: { narrow: boolean; children: ReactNode }) {
  return (
    <TopbarProvider>
      <Topbar onOpenNav={narrow ? () => undefined : undefined} />
      <main>{children}</main>
    </TopbarProvider>
  );
}

function tree(path: string, page: ReactNode, narrow = false) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Shell narrow={narrow}>{page}</Shell>
    </MemoryRouter>
  );
}

/** 挂载外壳 + 测试页面；`report(next)` 以新上报重渲染，`next === null` 卸载上报方。 */
function mount(path: string, initial: Report, narrow = false) {
  const view = render(tree(path, <Page report={initial} />, narrow));
  return {
    report: (next: Report | null) =>
      view.rerender(tree(path, next === null ? null : <Page report={next} />, narrow)),
  };
}

function actionButton(name = LABEL) {
  return within(screen.getByRole("banner")).getByRole("button", { name });
}

function queryActionButton(name = LABEL) {
  return screen.queryByRole("button", { name });
}

/** banner 内 `.topbar-actions` 中各按钮的 accessible name，按 DOM 次序。 */
function actionLabels() {
  return within(screen.getByRole("banner"))
    .queryAllByRole("button")
    .filter((button) => button.closest(".topbar-actions") !== null)
    .map((button) => button.getAttribute("aria-label"));
}

function bannerHeading(name: string) {
  return within(screen.getByRole("banner")).getByRole("heading", { level: 1, name });
}

function expectNoActions() {
  expect(document.querySelector(".topbar-actions")).toBeNull();
  expect(queryActionButton()).toBeNull();
}

describe("顶栏 actions 插槽：渲染契约 (E1–E4)", () => {
  it("E1 第二态：按钮在 heading 之后的 .topbar-actions 内，带 aria-expanded=false 与 Tooltip", async () => {
    mount(SESSION_PATH, { breadcrumb: "T", actions: [action({ expanded: false })] });

    const button = actionButton();
    const heading = bannerHeading(CRUMB);
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([heading]);
    expect(heading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(heading.contains(button)).toBe(false);
    const container = button.closest(".topbar-actions");
    expect(container?.parentElement).toBe(screen.getByRole("banner"));
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.classList.contains("ui-btn--ghost")).toBe(true);
    expect(button.classList.contains("ui-btn--icon")).toBe(true);
    const svg = button.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains("lucide-search")).toBe(true);

    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => button.focus());
    expect((await screen.findByRole("tooltip")).textContent).toBe(LABEL);
    expect(bannerHeading(CRUMB)).toBe(heading);
  });

  it("E2 第三态：省略 expanded 键时按钮没有 aria-expanded，heading 恰为 工作空间", () => {
    const descriptor = action();
    expect("expanded" in descriptor).toBe(false);
    mount(FILES_PATH, { actions: [descriptor] });

    const button = actionButton();
    expect(button.hasAttribute("aria-expanded")).toBe(false);
    const heading = bannerHeading("工作空间");
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([heading]);
    expect(heading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(button.closest(".topbar-actions")).not.toBeNull();
  });

  it("E2 显式 expanded: undefined 与省略键等价：按钮没有 aria-expanded，有值后带上", () => {
    const view = render(tree(SESSION_PATH, <ConditionalPage open={false} />));
    expect(actionButton().hasAttribute("aria-expanded")).toBe(false);

    view.rerender(tree(SESSION_PATH, <ConditionalPage open={true} />));
    expect(actionButton().getAttribute("aria-expanded")).toBe("true");

    view.rerender(tree(SESSION_PATH, <ConditionalPage open={false} />));
    expect(actionButton().hasAttribute("aria-expanded")).toBe(false);
  });

  it.each([
    ["第二态", SESSION_PATH, { breadcrumb: "T" }],
    ["第三态", FILES_PATH, {}],
  ])("E3 %s：点击恰调用一次 onSelect，实参就是该按钮元素", (_state, path, base) => {
    const onSelect = vi.fn();
    mount(path, { ...base, actions: [action({ onSelect })] });

    const button = actionButton();
    const glyph = button.querySelector("svg");
    expect(glyph).not.toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    // 真实点击多半落在图标上：事件从 svg 冒泡，trigger 仍须是按钮本身。
    fireEvent.click(glyph as SVGElement);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]).toHaveLength(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe(button);
  });

  it("E4 多项按数组顺序渲染；调换数组顺序后按钮次序与各自回调随之改变", () => {
    const selectFirst = vi.fn();
    const selectSecond = vi.fn();
    const first = action({ key: "first", label: "操作甲", icon: "search", onSelect: selectFirst });
    const second = action({ key: "second", label: "操作乙", icon: "copy", onSelect: selectSecond });
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [first, second] });

    expect(actionLabels()).toEqual(["操作甲", "操作乙"]);

    view.report({ breadcrumb: "T", actions: [second, first] });
    expect(actionLabels()).toEqual(["操作乙", "操作甲"]);

    fireEvent.click(actionButton("操作乙"));
    expect(selectSecond).toHaveBeenCalledTimes(1);
    expect(selectFirst).not.toHaveBeenCalled();
    fireEvent.click(actionButton("操作甲"));
    expect(selectFirst).toHaveBeenCalledTimes(1);
    expect(selectSecond).toHaveBeenCalledTimes(1);

    view.report({ breadcrumb: "T", actions: [second] });
    expect(actionLabels()).toEqual(["操作乙"]);
    view.report({ breadcrumb: "T", actions: [second, first] });
    expect(actionLabels()).toEqual(["操作乙", "操作甲"]);
  });
});

type TickStats = { renders: number; selected: number[] };

/** 由自身本地 state 驱动重渲染的上报方：每次渲染都是新的 `onSelect` 闭包，其余字段不变。 */
function TickingPage({ stats }: { stats: TickStats }) {
  const [tick, bump] = useReducer((count: number) => count + 1, 0);
  stats.renders += 1;
  useTopbar({
    breadcrumb: "T",
    actions: [action({ expanded: false, onSelect: () => stats.selected.push(tick) })],
  });
  return (
    <button onClick={bump} type="button">
      再渲染
    </button>
  );
}

/** Provider 下元素稳定的兄弟：记录每次渲染读到的 actions 数组。 */
function Probe({ seen }: { seen: (readonly TopbarAction[])[] }) {
  seen.push(useTopbarActions());
  return null;
}

describe("顶栏 actions 插槽：上报与更新 (E5–E6)", () => {
  it("E5 每次渲染新闭包、其余字段不变：不成环、shell 不再更新，点击调用最近一次渲染的闭包", () => {
    const TICKS = 5;
    const consoleError = vi.spyOn(console, "error");
    const stats: TickStats = { renders: 0, selected: [] };
    const seen: (readonly TopbarAction[])[] = [];
    render(
      tree(
        SESSION_PATH,
        <>
          <TickingPage stats={stats} />
          <Probe seen={seen} />
        </>,
      ),
    );

    expect(actionLabels()).toEqual([LABEL]);
    const settledRenders = stats.renders;
    const settledProbeRenders = seen.length;
    const settledActions = seen.at(-1);
    expect(settledActions).toHaveLength(1);

    for (let index = 0; index < TICKS; index += 1) {
      fireEvent.click(screen.getByRole("button", { name: "再渲染" }));
    }

    expect(stats.renders).toBe(settledRenders + TICKS);
    expect(Object.is(seen.at(-1), settledActions)).toBe(true);
    expect(seen).toHaveLength(settledProbeRenders);
    expect(consoleError).not.toHaveBeenCalled();

    fireEvent.click(actionButton());
    expect(stats.selected).toEqual([TICKS]);
    expect(stats.renders).toBe(settledRenders + TICKS);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("E6 expanded 由 false 变 true：aria-expanded 随之变为 true", () => {
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action({ expanded: false })] });
    expect(actionButton().getAttribute("aria-expanded")).toBe("false");

    view.report({ breadcrumb: "T", actions: [action({ expanded: true })] });
    expect(actionButton().getAttribute("aria-expanded")).toBe("true");

    view.report({ breadcrumb: "T", actions: [action()] });
    expect(actionButton().hasAttribute("aria-expanded")).toBe(false);
  });

  it("E6 label 或 icon 变化同样更新按钮", () => {
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action()] });
    expect(actionButton().querySelector("svg")?.classList.contains("lucide-search")).toBe(true);

    view.report({ breadcrumb: "T", actions: [action({ label: "改名后" })] });
    expect(actionLabels()).toEqual(["改名后"]);
    expect(queryActionButton()).toBeNull();

    view.report({ breadcrumb: "T", actions: [action({ label: "改名后", icon: "copy" })] });
    const svg = actionButton("改名后").querySelector("svg");
    expect(svg?.classList.contains("lucide-copy")).toBe(true);
    expect(svg?.classList.contains("lucide-search")).toBe(false);
  });

  it("E6 仅 key 变化同样更新：点击调用新描述符的回调", () => {
    const selectOld = vi.fn();
    const selectNew = vi.fn();
    const view = mount(SESSION_PATH, {
      breadcrumb: "T",
      actions: [action({ key: "old", onSelect: selectOld })],
    });
    expect(actionButton()).toBeTruthy();

    view.report({ breadcrumb: "T", actions: [action({ key: "new", onSelect: selectNew })] });
    fireEvent.click(actionButton());
    expect(selectNew).toHaveBeenCalledTimes(1);
    expect(selectOld).not.toHaveBeenCalled();
  });
});

describe("顶栏 actions 插槽：节点身份 (E14)", () => {
  it("E14 expanded 由 false 变 true：同一 key 的按钮仍是同一个 DOM 节点", () => {
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action({ expanded: false })] });
    const before = actionButton();
    expect(before.getAttribute("aria-expanded")).toBe("false");

    view.report({ breadcrumb: "T", actions: [action({ expanded: true })] });
    expect(actionButton()).toBe(before);
    expect(before.getAttribute("aria-expanded")).toBe("true");
    expect(before.isConnected).toBe(true);
  });

  it("E14 label 变化：同一 key 的按钮仍是同一个 DOM 节点", () => {
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action()] });
    const before = actionButton();

    view.report({ breadcrumb: "T", actions: [action({ label: "改名后" })] });
    expect(actionButton("改名后")).toBe(before);
    expect(before.isConnected).toBe(true);
  });

  it("E14 数组调换顺序：各 key 的按钮仍是各自原来的 DOM 节点", () => {
    const first = action({ key: "first", label: "操作甲" });
    const second = action({ key: "second", label: "操作乙", icon: "copy" });
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [first, second] });
    const firstBefore = actionButton("操作甲");
    const secondBefore = actionButton("操作乙");

    view.report({ breadcrumb: "T", actions: [second, first] });
    expect(actionLabels()).toEqual(["操作乙", "操作甲"]);
    expect(actionButton("操作甲")).toBe(firstBefore);
    expect(actionButton("操作乙")).toBe(secondBefore);
    // 节点没被就地改写成对方：图标仍是各自的。
    expect(firstBefore.querySelector("svg")?.classList.contains("lucide-search")).toBe(true);
    expect(secondBefore.querySelector("svg")?.classList.contains("lucide-copy")).toBe(true);
  });
});

describe("顶栏 actions 插槽：无 actions 与清空 (E7–E9)", () => {
  it.each([
    ["第二态 宽屏", SESSION_PATH, { breadcrumb: "T" }, false, CRUMB],
    ["第二态 窄屏", SESSION_PATH, { breadcrumb: "T" }, true, CRUMB],
    ["第三态 宽屏", FILES_PATH, {}, false, "工作空间"],
    ["第三态 窄屏", FILES_PATH, {}, true, "工作空间"],
  ])(
    "E7 %s 不提供 actions：header 子节点恰为（窄屏 打开导航 +）heading",
    (_state, path, report, narrow, title) => {
      mount(path, report, narrow);

      const banner = screen.getByRole("banner");
      const heading = bannerHeading(title);
      const expected = narrow
        ? [within(banner).getByRole("button", { name: NAV }), heading]
        : [heading];
      expect(Array.from(banner.children)).toEqual(expected);
      expect(document.querySelector(".topbar-actions")).toBeNull();
    },
  );

  it("E8 改为不提供 actions 即清空且面包屑保留；再提供相同描述符后重新出现且点击生效", () => {
    const onSelect = vi.fn();
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action({ expanded: false })] });
    expect(actionButton()).toBeTruthy();

    view.report({ breadcrumb: "T" });
    expectNoActions();
    expect(Array.from(screen.getByRole("banner").children)).toEqual([bannerHeading(CRUMB)]);

    view.report({ breadcrumb: "T", actions: [action({ expanded: false, onSelect })] });
    fireEvent.click(actionButton());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("E8 空数组等同未提供", () => {
    const view = mount(SESSION_PATH, { breadcrumb: "T", actions: [action()] });
    expect(actionButton()).toBeTruthy();

    view.report({ breadcrumb: "T", actions: [] });
    expectNoActions();
    expect(Array.from(screen.getByRole("banner").children)).toEqual([bannerHeading(CRUMB)]);
  });

  it("E8 上报方卸载：按钮与面包屑一同消失；重新挂载同一上报方后重新出现", () => {
    const onSelect = vi.fn();
    const report = { breadcrumb: "T", actions: [action({ onSelect })] };
    const view = mount(SESSION_PATH, report);
    expect(actionButton()).toBeTruthy();

    view.report(null);
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByText(/我的工作/)).toBeNull();
    expectNoActions();

    view.report(report);
    expect(bannerHeading(CRUMB)).toBeTruthy();
    fireEvent.click(actionButton());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("E8 第三态上报方卸载：heading 保留、按钮消失；重新挂载后重新出现", () => {
    const report = { actions: [action()] };
    const view = mount(FILES_PATH, report);
    expect(actionButton()).toBeTruthy();

    view.report(null);
    expect(Array.from(screen.getByRole("banner").children)).toEqual([bannerHeading("工作空间")]);
    expectNoActions();

    view.report(report);
    expect(actionLabels()).toEqual([LABEL]);
  });

  it.each([
    ["宽屏", false],
    ["窄屏", true],
  ])(
    "E9 %s 第二态 → 第一态：停止上报标题后（仍上报 actions）文档中没有该按钮",
    (_width, narrow) => {
      const actions = [action({ expanded: false })];
      const view = mount(SESSION_PATH, { breadcrumb: "T", actions }, narrow);
      expect(actionButton()).toBeTruthy();

      view.report({ actions });
      expectNoActions();
      expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
      if (narrow) {
        const banner = screen.getByRole("banner");
        expect(Array.from(banner.children)).toEqual([
          within(banner).getByRole("button", { name: NAV }),
        ]);
      } else {
        expect(screen.queryByRole("banner")).toBeNull();
      }
    },
  );
});

/** 新增图标名 → lucide 规范导出对应的 svg 类名（design「Must add/change」的映射表）。 */
const NEW_ICONS: [IconName, string][] = [
  ["star", "lucide-star"],
  ["pencil", "lucide-pencil"],
  ["trash", "lucide-trash"],
  ["more-horizontal", "lucide-ellipsis"],
  ["package", "lucide-package"],
  ["download", "lucide-download"],
  ["globe", "lucide-globe"],
  ["palette", "lucide-palette"],
  ["chevron-up", "lucide-chevron-up"],
  ["filter", "lucide-funnel"],
];

describe("图标注册表与样式 (E10)", () => {
  it.each(NEW_ICONS)("E10 Icon name=%s 渲染出 svg（%s）", (name, glyphClass) => {
    const { container } = render(<Icon name={name} />);

    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.classList.contains(glyphClass)).toBe(true);
    expect(svg?.classList.contains("ui-icon-16")).toBe(true);
  });

  it("E10 .topbar-actions 规则靠右且不收缩", () => {
    const rule = ruleBody(
      stripComments(readRepoFile("web/src/routes/shell/topbar.css")),
      ".topbar-actions",
    );
    expect(rule).toContain("margin-left: auto;");
    expect(rule).toContain("flex: none;");
  });
});

/** 路由交接用的两张测试页：组件类型不同，导航时旧页真实卸载、新页真实挂载。 */
function SessionTestPage({ descriptor }: { descriptor: TopbarAction }) {
  useTopbar({ breadcrumb: "T", actions: [descriptor] });
  return <p>会话测试页</p>;
}

function FilesTestPage({ descriptor }: { descriptor: TopbarAction }) {
  useTopbar({ actions: [descriptor] });
  return <p>文件测试页</p>;
}

/** 同一 MemoryRouter 内挂两张测试页（起始在会话页）；返回 `go(path)` 做导航。 */
function mountRoutes(session: TopbarAction, files: TopbarAction, strict = false) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <Shell narrow={false}>
            <Outlet />
          </Shell>
        ),
        children: [
          { path: "/", element: <SessionTestPage descriptor={session} /> },
          { path: FILES_PATH, element: <FilesTestPage descriptor={files} /> },
        ],
      },
    ],
    { initialEntries: [SESSION_PATH] },
  );
  disposeRouter = () => router.dispose();
  const app = <RouterProvider router={router} />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return (path: string) =>
    act(async () => {
      await router.navigate(path);
    });
}

describe("顶栏 actions 插槽：边界 (E11–E13, E15)", () => {
  it("E11 Provider 外：useTopbar({actions}) 不抛，单挂 Topbar 渲染 heading 且无 .topbar-actions", () => {
    const consoleError = vi.spyOn(console, "error");
    render(
      <MemoryRouter initialEntries={[FILES_PATH]}>
        <Topbar />
        <main>
          <Page report={{ actions: [action({ expanded: false })] }} />
        </main>
      </MemoryRouter>,
    );

    const banner = screen.getByRole("banner");
    expect(Array.from(banner.children)).toEqual([bannerHeading("工作空间")]);
    expect(screen.getByText("页面")).toBeTruthy();
    expectNoActions();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("E12 StrictMode 下挂载：按钮恰一份，点击恰调用一次 onSelect", () => {
    const onSelect = vi.fn();
    render(
      <StrictMode>
        {tree(SESSION_PATH, <Page report={{ breadcrumb: "T", actions: [action({ onSelect })] }} />)}
      </StrictMode>,
    );

    expect(screen.getAllByRole("button", { name: LABEL })).toHaveLength(1);
    expect(actionLabels()).toEqual([LABEL]);
    expect(document.querySelectorAll(".topbar-actions")).toHaveLength(1);
    fireEvent.click(actionButton());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("E13 路由交接：旧页卸载清空不擦掉新页的上报，导航回去同理", async () => {
    const selectSession = vi.fn();
    const selectFiles = vi.fn();
    const go = mountRoutes(
      action({ key: "session", label: "会话操作", expanded: false, onSelect: selectSession }),
      action({ key: "files", label: "文件操作", icon: "copy", onSelect: selectFiles }),
    );

    expect(screen.getByText("会话测试页")).toBeTruthy();
    expect(actionLabels()).toEqual(["会话操作"]);
    expect(bannerHeading(CRUMB)).toBeTruthy();

    await go(FILES_PATH);
    expect(screen.getByText("文件测试页")).toBeTruthy();
    expect(screen.queryByText("会话测试页")).toBeNull();
    expect(actionLabels()).toEqual(["文件操作"]);
    expect(queryActionButton("会话操作")).toBeNull();
    expect(bannerHeading("工作空间")).toBeTruthy();
    expect(actionButton("文件操作").hasAttribute("aria-expanded")).toBe(false);
    fireEvent.click(actionButton("文件操作"));
    expect(selectFiles).toHaveBeenCalledTimes(1);
    expect(selectSession).not.toHaveBeenCalled();

    await go(SESSION_PATH);
    expect(screen.getByText("会话测试页")).toBeTruthy();
    expect(actionLabels()).toEqual(["会话操作"]);
    expect(queryActionButton("文件操作")).toBeNull();
    expect(bannerHeading(CRUMB)).toBeTruthy();
    expect(actionButton("会话操作").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(actionButton("会话操作"));
    expect(selectSession).toHaveBeenCalledTimes(1);
    expect(selectFiles).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["", false],
    ["（StrictMode）", true],
  ])(
    "E15%s 路由交接且两页描述符的可比较字段完全相同：点击调用新页的回调，导航回去同理",
    async (_mode, strict) => {
      const consoleError = vi.spyOn(console, "error");
      const selectSession = vi.fn();
      const selectFiles = vi.fn();
      const go = mountRoutes(
        action({ expanded: false, onSelect: selectSession }),
        action({ expanded: false, onSelect: selectFiles }),
        strict,
      );

      expect(screen.getByText("会话测试页")).toBeTruthy();
      expect(bannerHeading(CRUMB)).toBeTruthy();
      expect(actionLabels()).toEqual([LABEL]);
      fireEvent.click(actionButton());
      expect(selectSession).toHaveBeenCalledTimes(1);
      expect(selectFiles).not.toHaveBeenCalled();

      await go(FILES_PATH);
      expect(screen.getByText("文件测试页")).toBeTruthy();
      expect(screen.queryByText("会话测试页")).toBeNull();
      expect(bannerHeading("工作空间")).toBeTruthy();
      expect(actionLabels()).toEqual([LABEL]);
      expect(actionButton().getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(actionButton());
      expect(selectFiles).toHaveBeenCalledTimes(1);
      expect(selectSession).toHaveBeenCalledTimes(1);

      await go(SESSION_PATH);
      expect(screen.getByText("会话测试页")).toBeTruthy();
      expect(screen.queryByText("文件测试页")).toBeNull();
      expect(bannerHeading(CRUMB)).toBeTruthy();
      expect(actionLabels()).toEqual([LABEL]);
      fireEvent.click(actionButton());
      expect(selectSession).toHaveBeenCalledTimes(2);
      expect(selectFiles).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );
});
