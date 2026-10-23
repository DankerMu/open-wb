// experts「中心「专家」tab」：卡片（名称、`内置` / `自建`、描述、标签）、分类 chip 单选、搜索与无匹配、首次读取
// 失败、内置卡没有 `编辑` / `删除`、`开始会话` 的 navigate state、删除确认（s1d-experts-skills 任务 7.2）。
// 假 `ApiClient` 经 `ExpertsPanel({client})` 注入；新建 / 编辑在 `center-experts-form.test.tsx`。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api.js";
import {
  ANALYST,
  BUILTINS,
  callNames,
  cardButton,
  cardNames,
  cardOf,
  chip,
  DESIGNER,
  FRONTEND,
  fakeExperts,
  OWN,
  pageAlerts,
  renderExperts,
  renderPanel,
  search,
  settled,
  TESTER,
} from "./center-experts-support.js";

const NO_MATCH = "没有匹配的专家";
const ALL_NAMES = ["前端架构师", "数据分析师", "品牌视觉设计师", "测试工程师", "需求梳理官"];

afterEach(() => {
  cleanup();
});

function pressed(): [string, string | null][] {
  return within(screen.getByRole("group", { name: "分类" }))
    .getAllByRole("button")
    .map((button) => [button.textContent ?? "", button.getAttribute("aria-pressed")]);
}

describe("浏览", () => {
  it("挂载恰一次 listExperts、不取技能清单；内置在前、自建在后，每张卡有名称、标记、描述与标签", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    expect(cardNames()).toEqual(ALL_NAMES);
    expect(callNames(fake)).toEqual(["listExperts"]);
    const frontend = cardOf("前端架构师");
    expect(within(frontend).getByText("内置", { exact: true })).toBeTruthy();
    expect(within(frontend).queryByText("自建", { exact: true })).toBeNull();
    expect(within(frontend).getByText(FRONTEND.description, { exact: true })).toBeTruthy();
    for (const tag of ["前端", "架构", "性能"]) {
      expect(within(frontend).getByText(tag, { exact: true })).toBeTruthy();
    }
    const own = cardOf("需求梳理官");
    expect(within(own).getByText("自建", { exact: true })).toBeTruthy();
    expect(within(own).queryByText("内置", { exact: true })).toBeNull();
    expect(within(own).getByText("把零散想法整理成 PRD", { exact: true })).toBeTruthy();
    expect(within(own).getByText("PRD", { exact: true })).toBeTruthy();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });

  it("内置卡只有 开始会话；自建卡另有 编辑 与 删除", async () => {
    await renderPanel(fakeExperts([...BUILTINS, OWN]));

    for (const { name } of BUILTINS) {
      const buttons = within(cardOf(name)).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(["开始会话"]);
    }
    const own = within(cardOf("需求梳理官")).getAllByRole("button");
    expect(own.map((button) => button.textContent)).toEqual(["开始会话", "编辑", "删除"]);
  });

  it("没有专家时显示「没有匹配的专家」", async () => {
    await renderPanel(fakeExperts([]));

    expect(screen.getByText(NO_MATCH)).toBeTruthy();
    expect(cardNames()).toEqual([]);
  });

  it("listExperts 失败：面板内 role=alert 显示其 message，没有卡片与新建按钮", async () => {
    const fake = fakeExperts(BUILTINS);
    fake.listExperts.mockRejectedValueOnce(new ApiError(503, "unavailable", "服务暂不可用"));
    renderExperts(fake);

    expect((await screen.findByRole("alert")).textContent).toBe("服务暂不可用");
    expect(cardNames()).toEqual([]);
    expect(screen.queryByRole("button", { name: "新建专家" })).toBeNull();
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });
});

describe("分类 chip 与搜索", () => {
  it("chip 依次为 全部 开发 办公 设计 产品，缺省选中 全部；单选过滤", async () => {
    await renderPanel(fakeExperts([...BUILTINS, OWN]));

    expect(pressed()).toEqual([
      ["全部", "true"],
      ["开发", "false"],
      ["办公", "false"],
      ["设计", "false"],
      ["产品", "false"],
    ]);
    fireEvent.click(chip("开发"));
    expect(cardNames()).toEqual([FRONTEND.name, TESTER.name]);
    expect(pressed().filter(([, state]) => state === "true")).toEqual([["开发", "true"]]);
    fireEvent.click(chip("办公"));
    expect(cardNames()).toEqual([ANALYST.name]);
    fireEvent.click(chip("设计"));
    expect(cardNames()).toEqual([DESIGNER.name]);
    fireEvent.click(chip("产品"));
    expect(cardNames()).toEqual(["需求梳理官"]);
    expect(pressed().filter(([, state]) => state === "true")).toEqual([["产品", "true"]]);
    fireEvent.click(chip("全部"));
    expect(cardNames()).toEqual(ALL_NAMES);
  });

  it.each([
    ["标签", "海报", [DESIGNER.name]],
    ["名称", "分析", [ANALYST.name]],
    ["描述（不区分大小写）", "REACT", [FRONTEND.name]],
    ["标签（不区分大小写）", "prd", ["需求梳理官"]],
    ["描述与标签都可命中", "自动化", [TESTER.name]],
  ])("搜索框 placeholder 为「搜索专家」，按%s子串匹配：%s", async (_label, query, names) => {
    await renderPanel(fakeExperts([...BUILTINS, OWN]));

    const box = screen.getByRole("searchbox", { name: "搜索专家" });
    expect(box.getAttribute("placeholder")).toBe("搜索专家");
    search(query);
    expect(cardNames()).toEqual(names);
  });

  it("chip 与搜索取交集；没有匹配项时显示「没有匹配的专家」，清空搜索后恢复", async () => {
    await renderPanel(fakeExperts([...BUILTINS, OWN]));

    fireEvent.click(chip("开发"));
    search("自动化");
    expect(cardNames()).toEqual([TESTER.name]);
    search("海报");
    expect(cardNames()).toEqual([]);
    expect(screen.getByText(NO_MATCH)).toBeTruthy();
    search("");
    expect(cardNames()).toEqual([FRONTEND.name, TESTER.name]);
    expect(screen.queryByText(NO_MATCH)).toBeNull();
  });
});

describe("开始会话", () => {
  it("navigate 到 / 并带 state {expertId}；点击前后没有任何会话请求", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);
    expect(fake.otherCalls()).toEqual([]);

    fireEvent.click(cardButton(DESIGNER.name, "开始会话"));

    const probe = await screen.findByRole("status", { name: "位置" });
    expect(JSON.parse(probe.textContent ?? "")).toEqual({
      pathname: "/",
      state: { expertId: "builtin:brand-designer" },
    });
    expect(fake.otherCalls()).toEqual([]);
    expect(callNames(fake)).toEqual(["listExperts"]);
  });

  it("自建专家同样带它的 id", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    fireEvent.click(cardButton("需求梳理官", "开始会话"));

    const probe = await screen.findByRole("status", { name: "位置" });
    expect(JSON.parse(probe.textContent ?? "")).toEqual({
      pathname: "/",
      state: { expertId: OWN.id },
    });
    expect(fake.otherCalls()).toEqual([]);
  });
});

describe("删除", () => {
  it("确认框标题「删除专家 <名称>？」；取消不调用；删除恰一次 deleteExpert，成功后恰一次 listExperts", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    fireEvent.click(cardButton("需求梳理官", "删除"));
    const first = await screen.findByRole("alertdialog", { name: "删除专家 需求梳理官？" });
    fireEvent.click(within(first).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.deleteExpert).not.toHaveBeenCalled();

    fireEvent.click(cardButton("需求梳理官", "删除"));
    const second = await screen.findByRole("alertdialog", { name: "删除专家 需求梳理官？" });
    fireEvent.click(within(second).getByRole("button", { name: "删除" }));

    await settled(fake, 2);
    expect(fake.deleteExpert).toHaveBeenCalledTimes(1);
    expect(fake.deleteExpert).toHaveBeenCalledWith(OWN.id);
    expect(callNames(fake)).toEqual(["listExperts", "deleteExpert", "listExperts"]);
    await waitFor(() => expect(cardNames()).toEqual(ALL_NAMES.slice(0, 4)));
    expect(pageAlerts()).toEqual([]);
  });

  it("删除失败：面板内 role=alert 显示 ApiError.message，不重取，卡片仍在", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    fake.deleteExpert.mockRejectedValueOnce(new ApiError(404, "not_found", "请求的资源不存在"));
    await renderPanel(fake);

    fireEvent.click(cardButton("需求梳理官", "删除"));
    const dialog = await screen.findByRole("alertdialog", { name: "删除专家 需求梳理官？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(pageAlerts()).toEqual(["请求的资源不存在"]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(callNames(fake)).toEqual(["listExperts", "deleteExpert"]);
    expect(cardNames()).toEqual(ALL_NAMES);
  });
});
