// #2038 s2c-kb-visibility 组 12：knowledge-bases「中心「知识库」tab」的范围部分——「范围对话框」「没有部门与没有项目组」
//「当前档已不可选」「新建时设范围」「新建对话框取不到范围」、范围对话框取不到范围（与新建对话框不同）与保存失败态。
// 假 `ApiClient` 经 `KnowledgeBasesPanel({client})` 注入；四档文案逐字取 spec.md:455（demo :2738-2741）。

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type BaseView, type MyScope } from "../src/lib/api.js";
import {
  base,
  chooseOption,
  chooseTemplate,
  fakeKb,
  GROUPS,
  MY_SCOPE,
  openCreate,
  openOptions,
  pageAlerts,
  READY,
  renderPanel,
  rowOf,
} from "./center-kb-support.js";

const DESCRIPTIONS = [
  "只有你能检索与引用，文档留在你的沙箱内",
  "同部门同事可检索与引用，但不能改动内容",
  "指定项目组的成员可检索与引用，可跨部门",
  "全公司可检索与引用，适合口径、规范类文档",
];
const AUDIT_HINT = "共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。";
const NO_DEPT = "你的账号没有部门信息";
const NO_GROUP = "你还不属于任何项目组，请让管理员在「中心 → 账号」中把你加入";
const NAMES = ["仅自己可见", "本部门可见", "项目组可见", "全员可见"];
const G1_OPTION = "内网落地专项（2 人）";
const G2_OPTION = "数据治理（3 人）";
const G1: BaseView["scope"] = { scope: "group", group: { id: "g1", name: "内网落地专项" } };
const UNAVAILABLE = new ApiError(503, "kb_unavailable", "知识库服务暂不可用");

afterEach(() => {
  cleanup();
});

type Option = { name: string; checked: boolean; disabled: boolean };

/** 每个 radio 的 label 文本、是否选中与是否禁用，按显示次序。 */
function scopeOptions(dialog: HTMLElement): Option[] {
  return within(dialog)
    .getAllByRole("radio")
    .map((radio) => ({
      name: document.querySelector(`label[for="${radio.id}"]`)?.textContent ?? "",
      checked: radio.getAttribute("aria-checked") === "true",
      disabled: (radio as HTMLButtonElement).disabled,
    }));
}

/** 四档按次序的期望：`checked` 是选中那一档的下标（-1 为都不选），`disabled` 是禁用的下标。 */
const options = (checked: number, disabled: readonly number[] = []): Option[] =>
  NAMES.map((name, index) => ({
    name,
    checked: index === checked,
    disabled: disabled.includes(index),
  }));

const scopeDialog = (name: string) => screen.findByRole("dialog", { name: `「${name}」可见范围` });

const alertsIn = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("alert")
    .map((alert) => alert.textContent);

const button = (scope: HTMLElement, name: string) =>
  within(scope).getByRole("button", { name }) as HTMLButtonElement;

const radio = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });

const groupTrigger = (dialog: HTMLElement) =>
  within(dialog).queryByRole("combobox", { name: "项目组" });

/** 点 `name` 那一行（第 6 格）的范围按钮 `label`，返回范围对话框。 */
async function openScope(name: string, label: string): Promise<HTMLElement> {
  const row = await waitFor(() => rowOf(name));
  fireEvent.click(within(row).getByRole("button", { name: label }));
  return scopeDialog(name);
}

/** 等读取落定：四档里至少一档可用。 */
const settled = (dialog: HTMLElement) =>
  waitFor(() => expect(scopeOptions(dialog).some((option) => !option.disabled)).toBe(true));

const scopeCell = (name: string) => within(rowOf(name)).getAllByRole("cell")[5] as HTMLElement;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("范围对话框", () => {
  it("点击时读一次范围、不进详情；预选当前档；改为项目组保存；详情头部同一个按钮改回仅自己可见", async () => {
    const a = base("a", { name: "规范库" });
    const fake = fakeKb([READY], [a]);
    renderPanel(fake);
    await screen.findByRole("button", { name: "仅自己可见" });
    expect(fake.getMyScope).toHaveBeenCalledTimes(0);

    const read = deferred<MyScope>();
    fake.getMyScope.mockImplementationOnce(() => read.promise);
    const dialog = await openScope("规范库", "仅自己可见");
    // 对话框开着时页面其余部分 aria-hidden，不带 hidden 的查询恒为 null。
    expect(screen.queryByRole("region", { name: "规范库 · 文档", hidden: true })).toBeNull();
    expect(scopeOptions(dialog)).toEqual(options(-1, [0, 1, 2, 3]));
    expect(button(dialog, "保存").disabled).toBe(true);
    expect(alertsIn(dialog)).toEqual([]);

    read.resolve({ ...MY_SCOPE });
    await waitFor(() => expect(scopeOptions(dialog)).toEqual(options(0)));
    for (const text of [...DESCRIPTIONS, AUDIT_HINT]) {
      expect(within(dialog).getByText(text, { exact: true })).toBeTruthy();
    }
    expect(within(dialog).queryByText(NO_DEPT)).toBeNull();
    expect(groupTrigger(dialog)).toBeNull();

    fireEvent.click(radio(dialog, "项目组可见"));
    expect(groupTrigger(dialog)?.textContent).toBe(G1_OPTION);
    const choices = await openOptions(dialog, "项目组");
    expect(choices.map((item) => item.textContent)).toEqual([G1_OPTION]);
    fireEvent.keyDown(choices[0] as HTMLElement, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());

    const save = deferred<BaseView>();
    fake.setKnowledgeBaseScope.mockImplementationOnce(() => save.promise);
    fireEvent.click(button(dialog, "保存"));
    await waitFor(() => expect(button(dialog, "保存").disabled).toBe(true));
    expect(button(dialog, "取消").disabled).toBe(true);
    expect(scopeOptions(dialog)).toEqual(options(2, [0, 1, 2, 3]));
    expect((groupTrigger(dialog) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button(dialog, "保存"));
    expect(fake.setKnowledgeBaseScope).toHaveBeenCalledTimes(1);

    save.resolve({ ...a, scope: G1, documents: 7 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.setKnowledgeBaseScope.mock.calls).toStrictEqual([
      ["a", { scope: "group", groupId: "g1" }],
    ]);
    const scopeButton = button(scopeCell("规范库"), "项目组可见 · 内网落地专项");
    expect(within(rowOf("规范库")).getAllByRole("cell")[3]?.textContent).toBe("7");
    await waitFor(() => expect(document.activeElement).toBe(scopeButton));
    expect(fake.getMyScope.mock.calls).toStrictEqual([[]]);
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "规范库 · 文档" })).toBeNull();

    fireEvent.click(rowOf("规范库"));
    const detail = await screen.findByRole("region", { name: "规范库 · 文档" });
    fireEvent.click(button(detail, "项目组可见 · 内网落地专项"));
    const again = await scopeDialog("规范库");
    await waitFor(() => expect(scopeOptions(again)).toEqual(options(2)));
    expect(groupTrigger(again)?.textContent).toBe(G1_OPTION);
    fireEvent.click(radio(again, "仅自己可见"));
    expect(groupTrigger(again)).toBeNull();
    fireEvent.click(button(again, "保存"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.setKnowledgeBaseScope.mock.calls[1]).toStrictEqual(["a", { scope: "me" }]);
    expect(button(detail, "仅自己可见")).toBeTruthy();
    expect(button(scopeCell("规范库"), "仅自己可见")).toBeTruthy();
    expect(fake.getMyScope).toHaveBeenCalledTimes(2);
  });

  it("两个项目组：预选当前组（不是首项）；改选项目组时下拉缺省为首项", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("b", {
          name: "组库",
          scope: { scope: "group", group: { id: "g2", name: "数据治理" } },
        }),
        base("c", { name: "私库" }),
      ],
    );
    fake.getMyScope.mockResolvedValue({ department: "平台研发部", groups: GROUPS });
    renderPanel(fake);

    const b = await openScope("组库", "项目组可见 · 数据治理");
    await waitFor(() => expect(scopeOptions(b)).toEqual(options(2)));
    expect(groupTrigger(b)?.textContent).toBe(G2_OPTION);
    const choices = await openOptions(b, "项目组");
    expect(choices.map((item) => item.textContent)).toEqual([G1_OPTION, G2_OPTION]);
    fireEvent.keyDown(choices[1] as HTMLElement, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    fireEvent.click(button(b, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const c = await openScope("私库", "仅自己可见");
    await settled(c);
    fireEvent.click(radio(c, "项目组可见"));
    expect(groupTrigger(c)?.textContent).toBe(G1_OPTION);
    await chooseOption(c, "项目组", (text) => text === G2_OPTION, G2_OPTION);
    fireEvent.click(button(c, "保存"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.setKnowledgeBaseScope.mock.calls).toStrictEqual([
      ["c", { scope: "group", groupId: "g2" }],
    ]);
    expect(button(scopeCell("私库"), "项目组可见 · 数据治理")).toBeTruthy();
  });

  it("原样保存也恰调用一次 setKnowledgeBaseScope（不在前端短路）", async () => {
    const fake = fakeKb([READY], [base("a", { name: "规范库" })]);
    renderPanel(fake);

    const dialog = await openScope("规范库", "仅自己可见");
    await waitFor(() => expect(scopeOptions(dialog)).toEqual(options(0)));
    fireEvent.click(button(dialog, "保存"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.setKnowledgeBaseScope.mock.calls).toStrictEqual([["a", { scope: "me" }]]);
  });

  it("迟到的应答按打开序号丢弃：先前那次打开的读取后到，不改这一次的选项", async () => {
    const fake = fakeKb([READY], [base("a", { name: "规范库" })]);
    const late = deferred<MyScope>();
    fake.getMyScope.mockImplementationOnce(() => late.promise);
    renderPanel(fake);

    fireEvent.click(button(await openScope("规范库", "仅自己可见"), "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const dialog = await openScope("规范库", "仅自己可见");
    await waitFor(() => expect(scopeOptions(dialog)).toEqual(options(0)));
    await act(async () => {
      late.resolve({ department: null, groups: [] });
      await late.promise;
    });

    expect(scopeOptions(dialog)).toEqual(options(0));
    expect(within(dialog).queryByText(NO_DEPT)).toBeNull();
    expect(fake.getMyScope).toHaveBeenCalledTimes(2);
  });
});

describe("没有部门与没有项目组", () => {
  it("本部门可见禁用并有旁注；项目组可见无下拉、有提示、保存禁用；新建对话框同样", async () => {
    const fake = fakeKb([READY], [base("a", { name: "规范库" })]);
    fake.getMyScope.mockResolvedValue({ department: null, groups: [] });
    renderPanel(fake);

    const dialog = await openScope("规范库", "仅自己可见");
    await waitFor(() => expect(scopeOptions(dialog)).toEqual(options(0, [1])));
    expect(within(dialog).getByText(NO_DEPT, { exact: true })).toBeTruthy();
    fireEvent.click(radio(dialog, "本部门可见"));
    expect(scopeOptions(dialog)).toEqual(options(0, [1]));

    fireEvent.click(radio(dialog, "项目组可见"));
    expect(groupTrigger(dialog)).toBeNull();
    expect(within(dialog).getByText(NO_GROUP, { exact: true })).toBeTruthy();
    expect(button(dialog, "保存").disabled).toBe(true);
    fireEvent.click(radio(dialog, "全员可见"));
    expect(within(dialog).queryByText(NO_GROUP)).toBeNull();
    expect(button(dialog, "保存").disabled).toBe(false);
    fireEvent.click(button(dialog, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.setKnowledgeBaseScope).toHaveBeenCalledTimes(0);

    const create = await openCreate();
    await waitFor(() => expect(scopeOptions(create)).toEqual(options(0, [1])));
    expect(within(create).getByText(NO_DEPT, { exact: true })).toBeTruthy();
    fireEvent.click(radio(create, "项目组可见"));
    expect(within(create).getByText(NO_GROUP, { exact: true })).toBeTruthy();
    expect(button(create, "创建").disabled).toBe(true);
  });
});

describe("当前档已不可选", () => {
  it("失去条件的当前档不预选、保存禁用，选一个可选的档后可存；阳性对照与重建中的行", async () => {
    const fake = fakeKb(
      [READY],
      [
        base("a", { name: "规范库", scope: G1 }),
        base("d", { name: "部门库", scope: { scope: "dept", group: null } }),
        base("e", { name: "对照库", scope: { scope: "dept", group: null } }),
        base("r", { name: "重建库", state: "rebuilding" }),
      ],
    );
    fake.getMyScope
      .mockResolvedValueOnce({ department: "平台研发部", groups: [] })
      .mockResolvedValueOnce({ department: null, groups: GROUPS.slice(0, 1) });
    renderPanel(fake);

    const a = await openScope("规范库", "项目组可见 · 内网落地专项");
    await waitFor(() => expect(scopeOptions(a)).toEqual(options(-1)));
    expect(button(a, "保存").disabled).toBe(true);
    expect(groupTrigger(a)).toBeNull();
    expect(within(a).queryByText(NO_GROUP)).toBeNull();
    fireEvent.click(radio(a, "全员可见"));
    expect(button(a, "保存").disabled).toBe(false);
    fireEvent.click(button(a, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const d = await openScope("部门库", "本部门可见");
    await waitFor(() => expect(scopeOptions(d)).toEqual(options(-1, [1])));
    expect(button(d, "保存").disabled).toBe(true);
    fireEvent.click(button(d, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const e = await openScope("对照库", "本部门可见");
    await waitFor(() => expect(scopeOptions(e)).toEqual(options(1)));
    expect(button(e, "保存").disabled).toBe(false);
    fireEvent.click(button(e, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(
      within(rowOf("重建库"))
        .getAllByRole("button")
        .map((item) => item.textContent),
    ).toEqual(["仅自己可见"]);
  });
});

describe("范围对话框取不到范围（与新建对话框不同：四档全部禁用）", () => {
  it("框内 alert，四档与保存禁用、取消可用；不调用 setKnowledgeBaseScope；取消后焦点回行按钮", async () => {
    const fake = fakeKb([READY], [base("a", { name: "规范库" })]);
    fake.getMyScope.mockRejectedValueOnce(UNAVAILABLE);
    renderPanel(fake);

    const dialog = await openScope("规范库", "仅自己可见");
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["知识库服务暂不可用"]));
    expect(scopeOptions(dialog)).toEqual(options(-1, [0, 1, 2, 3]));
    expect(button(dialog, "保存").disabled).toBe(true);
    expect(button(dialog, "取消").disabled).toBe(false);
    fireEvent.click(radio(dialog, "全员可见"));
    fireEvent.click(button(dialog, "保存"));
    expect(fake.setKnowledgeBaseScope).toHaveBeenCalledTimes(0);

    fireEvent.click(button(dialog, "取消"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 页面其余部分在对话框关闭后才不再 aria-hidden：此时页内没有 alert 才有意义。
    expect(pageAlerts()).toEqual([]);
    await waitFor(() =>
      expect(document.activeElement).toBe(button(scopeCell("规范库"), "仅自己可见")),
    );
  });
});

describe("保存失败", () => {
  it("框内显示信封文案、选择保持、保存恢复可用、列表不变；再存一次成功", async () => {
    const fake = fakeKb([READY], [base("a", { name: "规范库" })]);
    fake.setKnowledgeBaseScope.mockRejectedValueOnce(
      new ApiError(400, "bad_request", "请求格式不正确"),
    );
    renderPanel(fake);

    const dialog = await openScope("规范库", "仅自己可见");
    await settled(dialog);
    fireEvent.click(radio(dialog, "全员可见"));
    fireEvent.click(button(dialog, "保存"));

    await waitFor(() => expect(alertsIn(dialog)).toEqual(["请求格式不正确"]));
    expect(screen.getByRole("dialog", { name: "「规范库」可见范围" })).toBe(dialog);
    expect(scopeOptions(dialog)).toEqual(options(3));
    expect(button(dialog, "保存").disabled).toBe(false);
    // 对话框开着时页面其余部分 aria-hidden：行按钮要连隐藏的一起找。
    const rowButton = screen.getByRole("button", { name: "仅自己可见", hidden: true });
    expect(rowButton.closest("tr")?.querySelector("td")?.textContent).toBe("规范库");
    expect(fake.listKnowledgeBases).toHaveBeenCalledTimes(1);

    fireEvent.click(button(dialog, "保存"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(pageAlerts()).toEqual([]);
    expect(button(scopeCell("规范库"), "全员可见")).toBeTruthy();
    expect(fake.setKnowledgeBaseScope).toHaveBeenCalledTimes(2);
  });
});

/** 在新建对话框里填名称、选模板 `手册`，可选地点一档，点 `创建` 并等对话框关闭。 */
async function create(name: string, pick?: (dialog: HTMLElement) => void): Promise<void> {
  const dialog = await openCreate();
  await settled(dialog);
  fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: name } });
  await chooseTemplate(dialog, "手册");
  pick?.(dialog);
  fireEvent.click(button(dialog, "创建"));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

describe("新建时设范围", () => {
  it("初值仅自己可见、四档可用；全员可见带 scope，仅自己可见不带，项目组带 groupId", async () => {
    const fake = fakeKb([READY]);
    renderPanel(fake);

    await create("规范库", (d) => {
      expect(within(d).getByRole("radiogroup", { name: "可见范围" })).toBeTruthy();
      expect(scopeOptions(d)).toEqual(options(0));
      fireEvent.click(radio(d, "全员可见"));
    });
    expect(fake.createKnowledgeBase.mock.calls).toStrictEqual([
      [{ name: "规范库", template: "manual", scope: "all" }],
    ]);
    expect(button(scopeCell("规范库"), "全员可见")).toBeTruthy();

    await create("手册库");
    expect(fake.createKnowledgeBase.mock.calls[1]).toStrictEqual([
      { name: "手册库", template: "manual" },
    ]);

    await create("组库", (d) => {
      fireEvent.click(radio(d, "项目组可见"));
      expect(groupTrigger(d)?.textContent).toBe(G1_OPTION);
    });
    expect(fake.createKnowledgeBase.mock.calls[2]).toStrictEqual([
      { name: "组库", template: "manual", scope: "group", groupId: "g1" },
    ]);
    expect(fake.getMyScope).toHaveBeenCalledTimes(3);
  });
});

describe("新建对话框读取在途", () => {
  it("仅自己可见选中可用、其余三档禁用、没有 alert，创建可用", async () => {
    const fake = fakeKb([READY]);
    const read = deferred<MyScope>();
    fake.getMyScope.mockImplementationOnce(() => read.promise);
    renderPanel(fake);

    const dialog = await openCreate();
    expect(scopeOptions(dialog)).toEqual(options(0, [1, 2, 3]));
    expect(alertsIn(dialog)).toEqual([]);
    expect(button(dialog, "创建").disabled).toBe(false);
    read.resolve({ ...MY_SCOPE });
    await waitFor(() => expect(scopeOptions(dialog)).toEqual(options(0)));
  });
});

describe("新建对话框取不到范围（只留仅自己可见，建库照常）", () => {
  it("框内 alert，仅自己可见选中可用、其余三档禁用、没有旁注；建库不带 scope", async () => {
    const fake = fakeKb([READY]);
    fake.getMyScope.mockRejectedValueOnce(UNAVAILABLE);
    renderPanel(fake);

    const dialog = await openCreate();
    await waitFor(() => expect(alertsIn(dialog)).toEqual(["知识库服务暂不可用"]));
    expect(scopeOptions(dialog)).toEqual(options(0, [1, 2, 3]));
    expect(within(dialog).queryByText(NO_DEPT)).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("名称"), { target: { value: "规范库" } });
    await chooseTemplate(dialog, "手册");
    fireEvent.click(button(dialog, "创建"));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createKnowledgeBase.mock.calls).toStrictEqual([
      [{ name: "规范库", template: "manual" }],
    ]);
  });
});
