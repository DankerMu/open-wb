// 中心页「专家」tab 各测试文件共用的夹具（experts「中心「专家」tab」，s1d-experts-skills 任务 7.2）：一个按规格
// 行为应答的假 `ApiClient`（经 `ExpertsPanel({client})` 注入，不经 fetch），调用记录，带位置探针的内存路由，
// 以及按 role + name 定位的助手。

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { expect, vi } from "vitest";
import { ExpertsPanel } from "../src/features/center/experts/panel.js";
import {
  type ApiClient,
  ApiError,
  createApiClient,
  type ExpertInput,
  type ExpertView,
  type SkillList,
} from "../src/lib/api.js";
import "./radix-platform.js";

/** 四位内置专家（`server/src/experts/builtin.ts` 的名称、分类、描述与标签；提示词与本 tab 无关，取短文本）。 */
export const FRONTEND: ExpertView = {
  id: "builtin:frontend-architect",
  name: "前端架构师",
  description: "精通 React/Vue 架构设计、性能优化与工程化体系建设，擅长大型前端项目重构。",
  category: "开发",
  tags: ["前端", "架构", "性能"],
  prompt: "你是一位前端架构师。",
  skills: [],
  builtin: true,
};
export const ANALYST: ExpertView = {
  id: "builtin:data-analyst",
  name: "数据分析师",
  description: "擅长数据清洗、指标体系建设与可视化看板搭建，输出结构化分析报告。",
  category: "办公",
  tags: ["数据分析", "报表"],
  prompt: "你是一位数据分析师。",
  skills: [],
  builtin: true,
};
export const DESIGNER: ExpertView = {
  id: "builtin:brand-designer",
  name: "品牌视觉设计师",
  description: "品牌 VI、海报、社交媒体视觉全案设计，支持多风格探索与快速迭代。",
  category: "设计",
  tags: ["品牌", "海报", "VI"],
  prompt: "你是一位品牌视觉设计师。",
  skills: [],
  builtin: true,
};
export const TESTER: ExpertView = {
  id: "builtin:test-engineer",
  name: "测试工程师",
  description: "自动化测试用例设计、接口测试与回归测试方案输出，覆盖主流测试框架。",
  category: "开发",
  tags: ["测试", "自动化"],
  prompt: "你是一位测试工程师。",
  skills: [],
  builtin: true,
};
export const BUILTINS = [FRONTEND, ANALYST, DESIGNER, TESTER] as const;

/** 本账号的一位自建专家（产品类，带技能）。 */
export const OWN: ExpertView = {
  id: "0123456789abcdef0123456789abcdef",
  name: "需求梳理官",
  description: "把零散想法整理成 PRD",
  category: "产品",
  tags: ["需求", "PRD"],
  prompt: "你负责把需求整理成文档。",
  skills: ["pdf", "retired-skill"],
  builtin: false,
};

/** `GET /api/skills` 的缺省应答：两个平台技能。 */
const SKILLS: SkillList = {
  skills: [
    { name: "xlsx", description: "表格", enabledByDefault: true },
    { name: "pdf", description: "PDF", enabledByDefault: false },
  ],
  disabledSkills: ["pdf"],
};

const FAKED = [
  "listExperts",
  "createExpert",
  "updateExpert",
  "deleteExpert",
  "listSkills",
] as const;

/**
 * 假客户端：持有一张专家表，四个专家方法按「专家管理端点」的语义改它并返回视图；`listSkills` 应答 `skills`。
 * 用例用 `mockImplementationOnce` / `mockRejectedValueOnce` 改写某一次应答。其余方法（会话等）全部换成会抛错的
 * spy：`otherCalls()` 列出被调用过的那些。
 */
export function fakeExperts(initial: readonly ExpertView[], skills: SkillList = SKILLS) {
  let experts = [...initial];
  let created = 0;
  const find = (id: string) => {
    const found = experts.find((expert) => expert.id === id);
    if (!found) throw new ApiError(404, "not_found", "请求的资源不存在");
    return found;
  };
  const view = (id: string, input: ExpertInput): ExpertView => ({
    id,
    ...input,
    skills: [...new Set(input.skills)].sort(),
    builtin: false,
  });
  const methods = {
    listExperts: vi.fn(async () => {
      return experts.map((expert) => ({ ...expert }));
    }),
    createExpert: vi.fn(async (input: ExpertInput) => {
      created += 1;
      const next = view(`${created}`.padStart(32, "f"), input);
      experts = [...experts, next];
      return next;
    }),
    updateExpert: vi.fn(async (id: string, input: ExpertInput) => {
      find(id);
      const next = view(id, input);
      experts = experts.map((expert) => (expert.id === id ? next : expert));
      return next;
    }),
    deleteExpert: vi.fn(async (id: string) => {
      find(id);
      experts = experts.filter((expert) => expert.id !== id);
    }),
    listSkills: vi.fn(async () => {
      return { skills: skills.skills.map((skill) => ({ ...skill })), disabledSkills: [] };
    }),
  };
  const base = createApiClient();
  const others = Object.fromEntries(
    Object.keys(base)
      .filter((name) => !(FAKED as readonly string[]).includes(name))
      .map((name) => [
        name,
        vi.fn(async () => {
          throw new Error(`unexpected ${name}`);
        }),
      ]),
  );
  const client = { ...base, ...others, ...methods } as ApiClient;
  const otherCalls = () =>
    Object.entries(others)
      .filter(([, spy]) => spy.mock.calls.length > 0)
      .map(([name]) => name);
  return { client, otherCalls, ...methods };
}

export type FakeExperts = ReturnType<typeof fakeExperts>;

/** 五个专家 / 技能方法的调用名，按调用次序（取自各 spy 的全局调用序号，改写过的应答也计入）。 */
export function callNames(fake: FakeExperts): string[] {
  return FAKED.flatMap((name) =>
    fake[name].mock.invocationCallOrder.map((order) => [order, name] as const),
  )
    .sort(([a], [b]) => a - b)
    .map(([, name]) => name);
}

/** `/` 上的位置探针：显示 pathname 与 `location.state`。 */
function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="位置">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </output>
  );
}

/** 内存路由：`/center` 挂注入假客户端的面板，`/` 挂位置探针。 */
export function renderExperts(fake: FakeExperts) {
  return render(
    <MemoryRouter initialEntries={["/center?tab=experts"]}>
      <Routes>
        <Route element={<ExpertsPanel client={fake.client} />} path="/center" />
        <Route element={<LocationProbe />} path="/" />
      </Routes>
    </MemoryRouter>,
  );
}

/** 渲染并等到卡片列表或无匹配文案出现。 */
export async function renderPanel(fake: FakeExperts) {
  renderExperts(fake);
  await screen.findByRole("button", { name: "新建专家" });
}

/** 卡片名称，按显示次序。 */
export function cardNames(): string[] {
  const list = screen.queryByRole("list", { name: "专家列表" });
  if (!list) return [];
  return within(list)
    .queryAllByRole("listitem")
    .map((card) => card.querySelector("h3")?.textContent ?? "");
}

export function cardOf(name: string): HTMLElement {
  return screen.getByRole("listitem", { name });
}

export function cardButton(name: string, button: string): HTMLElement {
  return within(cardOf(name)).getByRole("button", { name: button });
}

export function chip(name: string): HTMLElement {
  return within(screen.getByRole("group", { name: "分类" })).getByRole("button", { name });
}

export function search(query: string): void {
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索专家" }), {
    target: { value: query },
  });
}

/** 打开 `新建专家` 或某张卡的 `编辑`，返回对话框。 */
export async function openForm(name?: string): Promise<HTMLElement> {
  if (name === undefined) {
    fireEvent.click(screen.getByRole("button", { name: "新建专家" }));
    return screen.findByRole("dialog", { name: "新建专家" });
  }
  fireEvent.click(cardButton(name, "编辑"));
  return screen.findByRole("dialog", { name: "编辑专家" });
}

export function type(dialog: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

export function skillBoxes(dialog: HTMLElement): HTMLElement[] {
  const group = within(dialog).queryByRole("group", { name: "技能" });
  return group ? within(group).queryAllByRole("checkbox") : [];
}

/** 技能多选里各项的 `[名称, 是否勾选]`，按显示次序。 */
export function skillStates(dialog: HTMLElement): [string, boolean][] {
  return skillBoxes(dialog).map((box) => [
    document.querySelector(`label[for="${box.id}"]`)?.textContent ?? "",
    box.getAttribute("aria-checked") === "true",
  ]);
}

export function tick(dialog: HTMLElement, name: string): void {
  fireEvent.click(within(dialog).getByRole("checkbox", { name }));
}

/** 经键盘打开分类下拉并选中一项（Radix Select 在 jsdom 里以键盘驱动）。 */
export async function chooseCategory(dialog: HTMLElement, category: string): Promise<void> {
  const trigger = within(dialog).getByRole("combobox", { name: "分类" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: category });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(trigger.textContent).toBe(category));
}

export function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
}

/** 对话框关闭且之后的重取已结算：以 `listExperts` 的调用次数为准。 */
export async function settled(fake: FakeExperts, lists: number): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.listExperts).toHaveBeenCalledTimes(lists);
  });
}

/** 面板内、不在对话框里的 `role="alert"`。 */
export function pageAlerts(): string[] {
  return screen
    .queryAllByRole("alert")
    .filter((alert) => !alert.closest('[role="dialog"]') && !alert.closest('[role="alertdialog"]'))
    .map((alert) => alert.textContent ?? "");
}
