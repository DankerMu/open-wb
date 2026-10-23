// skill-switches「中心「技能」tab」（s1d-experts-skills 任务 8.2）：平台技能列表（名称、描述、`默认启用` 开关与
// 其初值）、页顶说明与空态、首次读取失败；切换恰一次 `putSkillDefaults`，body 为最近一次取得的 `disabledSkills`
// 加上 / 去掉该名称后去重、按 JS 缺省 `.sort()` 排序（服务端 `normalizeSkillNames` 同一比较），列表外的名称
//（`ghost`）不丢；在途禁用全部开关；成功以应答为准；失败回滚并提示。假 `ApiClient` 经 `SkillsPanel({client})`
// 注入，其余方法全部换成会抛错的 spy。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../src/features/center/skills/list.js";
import { type ApiClient, ApiError, createApiClient, type SkillList } from "../src/lib/api.js";
import "./radix-platform.js";

const NOTE = "只影响新建的会话；已有会话在输入框的「能力」里修改";
const EMPTY = "尚未安装平台技能";
const SERVER_ERROR = new ApiError(500, "request_failed", "服务器内部错误");

type Skill = SkillList["skills"][number];

const DEPLOY: Skill = { name: "deploy", description: "部署到生产环境", enabledByDefault: true };
const WEEKLY: Skill = { name: "weekly-report", description: "", enabledByDefault: true };
const LINT: Skill = { name: "lint", description: "代码检查", enabledByDefault: true };

/** 规格「切换账号缺省」的起点：两个平台技能都开，账号缺省停用只有列表外的 `ghost`。 */
const GHOST_ONLY: SkillList = { skills: [DEPLOY, WEEKLY], disabledSkills: ["ghost"] };

/** 服务端 `view` 的语义：`enabledByDefault` 为名称不在停用列表里。 */
function viewOf(skills: readonly Skill[], disabledSkills: string[]): SkillList {
  return {
    skills: skills.map((skill) => ({
      ...skill,
      enabledByDefault: !disabledSkills.includes(skill.name),
    })),
    disabledSkills,
  };
}

/** 假客户端：`listSkills` 应答 `initial`；`putSkillDefaults` 缺省按服务端语义（同一张技能表、停用列表原样）应答。 */
function fakeSkills(initial: SkillList) {
  const methods = {
    listSkills: vi.fn(async () => structuredClone(initial)),
    putSkillDefaults: vi.fn(async (disabledSkills: readonly string[]) =>
      viewOf(initial.skills, [...disabledSkills]),
    ),
  };
  const base = createApiClient();
  const others = Object.fromEntries(
    Object.keys(base)
      .filter((name) => !(name in methods))
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

type Fake = ReturnType<typeof fakeSkills>;

/** 可由用例手动结算的 promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
});

/** 渲染并等到第一个开关出现。 */
async function renderReady(fake: Fake) {
  render(<SkillsPanel client={fake.client} />);
  await screen.findAllByRole("switch");
}

function toggle(name: string): HTMLElement {
  return screen.getByRole("switch", { name: `默认启用 ${name}` });
}

function click(name: string): void {
  fireEvent.click(toggle(name));
}

/** 列表各项的名称，按显示次序。 */
function itemNames(): string[] {
  const list = screen.queryByRole("list", { name: "技能列表" });
  if (!list) return [];
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.querySelector("h3")?.textContent ?? "");
}

/** 各开关的 `[accessible name, 是否开, 是否禁用]`，按显示次序。 */
function switchStates(): [string, boolean, boolean][] {
  return screen
    .queryAllByRole("switch")
    .map((element) => [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("aria-checked") === "true",
      (element as HTMLButtonElement).disabled,
    ]);
}

/** 等到不再在途（所有开关可用）。 */
async function settled(): Promise<void> {
  await waitFor(() => {
    expect(switchStates().every(([, , disabled]) => !disabled)).toBe(true);
  });
}

function alerts(): string[] {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent ?? "");
}

describe("列表", () => {
  it("挂载恰一次 listSkills；每项名称、非空描述与开关，初值为名称不在 disabledSkills 里；页顶说明", async () => {
    const fake = fakeSkills(viewOf([DEPLOY, WEEKLY], ["ghost", "weekly-report"]));
    await renderReady(fake);

    expect(itemNames()).toEqual(["deploy", "weekly-report"]);
    expect(switchStates()).toEqual([
      ["默认启用 deploy", true, false],
      ["默认启用 weekly-report", false, false],
    ]);
    const deploy = screen.getByRole("listitem", { name: "deploy" });
    expect(within(deploy).getByText(DEPLOY.description, { exact: true })).toBeTruthy();
    expect(deploy.querySelectorAll("p")).toHaveLength(1);
    // 空描述不渲染描述行。
    expect(
      screen.getByRole("listitem", { name: "weekly-report" }).querySelectorAll("p"),
    ).toHaveLength(0);
    expect(screen.getByText(NOTE, { exact: true })).toBeTruthy();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(alerts()).toEqual([]);
    expect(fake.listSkills).toHaveBeenCalledTimes(1);
    expect(fake.putSkillDefaults).not.toHaveBeenCalled();
    expect(fake.otherCalls()).toEqual([]);
  });

  it("没有平台技能：显示「尚未安装平台技能」，说明仍在，没有列表与开关", async () => {
    const fake = fakeSkills({ skills: [], disabledSkills: ["ghost"] });
    render(<SkillsPanel client={fake.client} />);

    expect(await screen.findByText(EMPTY, { exact: true })).toBeTruthy();
    expect(screen.getByText(NOTE, { exact: true })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "技能列表" })).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(alerts()).toEqual([]);
    expect(fake.listSkills).toHaveBeenCalledTimes(1);
  });

  it("listSkills 失败：面板内 role=alert 显示 ApiError.message，没有列表与开关", async () => {
    const fake = fakeSkills(GHOST_ONLY);
    fake.listSkills.mockRejectedValueOnce(SERVER_ERROR);
    render(<SkillsPanel client={fake.client} />);

    expect((await screen.findByRole("alert")).textContent).toBe("服务器内部错误");
    expect(screen.queryByRole("list", { name: "技能列表" })).toBeNull();
    expect(screen.queryAllByRole("switch")).toEqual([]);
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(fake.listSkills).toHaveBeenCalledTimes(1);
  });
});

describe("切换", () => {
  it("关闭 deploy 的 body 保留列表外的 ghost；接在应答之后重新打开，body 恰为 [ghost]；不重取 listSkills", async () => {
    const fake = fakeSkills(GHOST_ONLY);
    await renderReady(fake);

    click("deploy");
    await settled();
    expect(fake.putSkillDefaults.mock.calls.map(([body]) => body)).toEqual([["deploy", "ghost"]]);
    expect(switchStates()).toEqual([
      ["默认启用 deploy", false, false],
      ["默认启用 weekly-report", true, false],
    ]);

    click("deploy");
    await settled();
    expect(fake.putSkillDefaults.mock.calls.map(([body]) => body)).toEqual([
      ["deploy", "ghost"],
      ["ghost"],
    ]);
    expect(toggle("deploy").getAttribute("aria-checked")).toBe("true");
    expect(fake.listSkills).toHaveBeenCalledTimes(1);
    expect(fake.otherCalls()).toEqual([]);
  });

  it("body 去重并按 JS 缺省 .sort()（UTF-16 码元序：大写在小写之前）排序", async () => {
    const zulu: Skill = { name: "Zulu", description: "", enabledByDefault: true };
    const fake = fakeSkills({ skills: [DEPLOY, zulu], disabledSkills: ["ghost", "ghost"] });
    await renderReady(fake);

    click("Zulu");
    await settled();
    // localeCompare 会排成 ["ghost","Zulu"]；服务端 normalizeSkillNames 是 `[...new Set()].sort()`。
    expect(fake.putSkillDefaults.mock.calls.map(([body]) => body)).toEqual([["Zulu", "ghost"]]);
  });
});

describe("在途", () => {
  it("全部开关禁用，被切换的开关显示切换后的状态；应答前再点任何开关不发请求；应答后恢复可用", async () => {
    const fake = fakeSkills(GHOST_ONLY);
    const pending = deferred<SkillList>();
    fake.putSkillDefaults.mockReturnValueOnce(pending.promise);
    await renderReady(fake);

    click("deploy");
    await waitFor(() =>
      expect(switchStates()).toEqual([
        ["默认启用 deploy", false, true],
        ["默认启用 weekly-report", true, true],
      ]),
    );
    click("weekly-report");
    click("deploy");
    expect(fake.putSkillDefaults).toHaveBeenCalledTimes(1);

    pending.resolve(viewOf([DEPLOY, WEEKLY], ["deploy", "ghost"]));
    await settled();
    expect(switchStates()).toEqual([
      ["默认启用 deploy", false, false],
      ["默认启用 weekly-report", true, false],
    ]);
    expect(fake.putSkillDefaults).toHaveBeenCalledTimes(1);
  });
});

describe("成功", () => {
  it("以应答的 skills 与 disabledSkills 替换（应答多一项、再少一项），之后的 body 基于应答", async () => {
    const fake = fakeSkills(GHOST_ONLY);
    // 应答比本地预期多一个技能 lint，停用列表多一个 weekly-report。
    fake.putSkillDefaults.mockResolvedValueOnce(
      viewOf([DEPLOY, LINT, WEEKLY], ["deploy", "ghost", "weekly-report"]),
    );
    // 第二次应答少了 weekly-report（技能被卸载），停用列表仍带着它。
    fake.putSkillDefaults.mockResolvedValueOnce(
      viewOf([DEPLOY, LINT], ["deploy", "ghost", "lint", "weekly-report"]),
    );
    await renderReady(fake);

    click("deploy");
    await settled();
    expect(itemNames()).toEqual(["deploy", "lint", "weekly-report"]);
    expect(switchStates()).toEqual([
      ["默认启用 deploy", false, false],
      ["默认启用 lint", true, false],
      ["默认启用 weekly-report", false, false],
    ]);

    click("lint");
    await settled();
    expect(fake.putSkillDefaults.mock.calls.map(([body]) => body)).toEqual([
      ["deploy", "ghost"],
      ["deploy", "ghost", "lint", "weekly-report"],
    ]);
    expect(itemNames()).toEqual(["deploy", "lint"]);
    expect(switchStates()).toEqual([
      ["默认启用 deploy", false, false],
      ["默认启用 lint", false, false],
    ]);

    click("deploy");
    await settled();
    expect(fake.putSkillDefaults.mock.calls[2]?.[0]).toEqual(["ghost", "lint", "weekly-report"]);
    expect(fake.listSkills).toHaveBeenCalledTimes(1);
  });
});

describe("失败", () => {
  it.each([
    ["500", SERVER_ERROR],
    ["400", new ApiError(400, "bad_request", "请求格式不正确")],
  ])(
    "%s：开关回到切换前、停用列表不变、role=alert 显示 ApiError.message；下一次切换开始时清掉提示",
    async (_status, error) => {
      const fake = fakeSkills(GHOST_ONLY);
      fake.putSkillDefaults.mockRejectedValueOnce(error);
      await renderReady(fake);

      click("deploy");
      expect((await screen.findByRole("alert")).textContent).toBe(error.message);
      await settled();
      expect(switchStates()).toEqual([
        ["默认启用 deploy", true, false],
        ["默认启用 weekly-report", true, false],
      ]);

      const pending = deferred<SkillList>();
      fake.putSkillDefaults.mockReturnValueOnce(pending.promise);
      click("weekly-report");
      await waitFor(() => expect(alerts()).toEqual([]));
      // 停用列表没有被失败的那次切换改动：body 仍以 GET 的 [ghost] 为基。
      expect(fake.putSkillDefaults.mock.calls.map(([body]) => body)).toEqual([
        ["deploy", "ghost"],
        ["ghost", "weekly-report"],
      ]);
      pending.resolve(viewOf([DEPLOY, WEEKLY], ["ghost", "weekly-report"]));
      await settled();
      expect(fake.listSkills).toHaveBeenCalledTimes(1);
    },
  );
});
