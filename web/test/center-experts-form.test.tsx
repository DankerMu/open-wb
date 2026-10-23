// experts「中心「专家」tab」：`新建专家` / `编辑专家` 对话框——六键 body、分类 select、标签解析、技能多选（选项、
// 勾选次序、列表外的已有名称、`listSkills` 失败仍可提交）、每次打开恰一次 `listSkills`、在途禁用、失败留在框内、
// Escape 回退（s1d-experts-skills 任务 7.2）。逐字段的客户端校验在 `center-experts-validate.test.tsx`。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type ExpertView, REQUEST_FAILED_MESSAGE } from "../src/lib/api.js";
import {
  BUILTINS,
  callNames,
  cardNames,
  chooseCategory,
  fakeExperts,
  OWN,
  openForm,
  renderPanel,
  save,
  settled,
  skillBoxes,
  skillStates,
  tick,
  type,
} from "./center-experts-support.js";

afterEach(() => {
  cleanup();
});

const field = (dialog: HTMLElement, label: string) =>
  within(dialog).getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement;

/** 技能清单读到（或失败）之后：以 `listSkills` 的结算为准。 */
async function skillsSettled(dialog: HTMLElement, expected: [string, boolean][]) {
  await waitFor(() => expect(skillStates(dialog)).toEqual(expected));
}

describe("新建", () => {
  it("只填名称与提示词：body 恒为六键，name / prompt 去首尾空白，分类缺省「开发」；成功关闭并恰一次重取", async () => {
    const fake = fakeExperts(BUILTINS);
    await renderPanel(fake);

    const dialog = await openForm();
    await skillsSettled(dialog, [
      ["xlsx", false],
      ["pdf", false],
    ]);
    expect(within(dialog).getByRole("combobox", { name: "分类" }).textContent).toBe("开发");
    type(dialog, "名称", "  周报助手  ");
    type(dialog, "提示词", "\n  整理本周进展  \n");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createExpert).toHaveBeenCalledTimes(1);
    expect(fake.createExpert.mock.calls[0]?.[0]).toStrictEqual({
      name: "周报助手",
      description: "",
      category: "开发",
      tags: [],
      prompt: "整理本周进展",
      skills: [],
    });
    expect(callNames(fake)).toEqual(["listExperts", "listSkills", "createExpert", "listExperts"]);
    await waitFor(() => expect(cardNames()).toContain("周报助手"));
  });

  it("描述原样发送；分类由 select 选出；标签按半角或全角逗号切分、去空项、去重保序；技能按勾选次序", async () => {
    const fake = fakeExperts(BUILTINS);
    await renderPanel(fake);

    const dialog = await openForm();
    await skillsSettled(dialog, [
      ["xlsx", false],
      ["pdf", false],
    ]);
    type(dialog, "名称", "海报设计");
    type(dialog, "描述", "  前后空白也保留  ");
    await chooseCategory(dialog, "设计");
    type(dialog, "标签", "海报， 品牌,海报,,  VI ，");
    type(dialog, "提示词", "设计海报");
    tick(dialog, "pdf");
    tick(dialog, "xlsx");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createExpert.mock.calls[0]?.[0]).toStrictEqual({
      name: "海报设计",
      description: "  前后空白也保留  ",
      category: "设计",
      tags: ["海报", "品牌", "VI"],
      prompt: "设计海报",
      skills: ["pdf", "xlsx"],
    });
  });

  it("提交在途：保存与取消禁用，再点保存不重发；结算后关闭", async () => {
    const fake = fakeExperts(BUILTINS);
    let release!: () => void;
    fake.createExpert.mockImplementationOnce(
      (input) =>
        new Promise<ExpertView>((resolve) => {
          release = () => resolve({ ...OWN, ...input, id: "e".repeat(32) });
        }),
    );
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "名称", "甲");
    type(dialog, "提示词", "乙");
    save(dialog);

    const saveButton = within(dialog).getByRole("button", { name: "保存" });
    await waitFor(() => expect(saveButton.hasAttribute("disabled")).toBe(true));
    expect(within(dialog).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    save(dialog);
    expect(fake.createExpert).toHaveBeenCalledTimes(1);

    release();
    await settled(fake, 2);
    expect(fake.createExpert).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["服务端 400", new ApiError(400, "bad_request", "请求格式不正确")],
    ["第 51 个专家（同为 400）", new ApiError(400, "bad_request", "请求格式不正确")],
    ["非信封 500", new ApiError(500, "request_failed", REQUEST_FAILED_MESSAGE)],
  ])("失败（%s）：框内 role=alert 显示 message，对话框不关，不重取", async (_label, error) => {
    const fake = fakeExperts(BUILTINS);
    fake.createExpert.mockRejectedValueOnce(error);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "名称", "甲");
    type(dialog, "提示词", "乙");
    save(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe(error.message);
    expect(screen.getByRole("dialog", { name: "新建专家" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(callNames(fake)).toEqual(["listExperts", "listSkills", "createExpert"]);
  });
});

describe("编辑", () => {
  it("预填六字段；列表外的已有技能仍作为已勾项列出；恰一次 updateExpert(id, 六键 body)，成功后恰一次重取", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    const dialog = await openForm(OWN.name);
    expect(field(dialog, "名称").value).toBe("需求梳理官");
    expect(field(dialog, "描述").value).toBe("把零散想法整理成 PRD");
    expect(within(dialog).getByRole("combobox", { name: "分类" }).textContent).toBe("产品");
    expect(field(dialog, "标签").value).toBe("需求，PRD");
    expect(field(dialog, "提示词").value).toBe("你负责把需求整理成文档。");
    await skillsSettled(dialog, [
      ["xlsx", false],
      ["pdf", true],
      ["retired-skill", true],
    ]);
    type(dialog, "名称", "需求整理官");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateExpert).toHaveBeenCalledTimes(1);
    expect(fake.updateExpert.mock.calls[0]?.[0]).toBe(OWN.id);
    expect(fake.updateExpert.mock.calls[0]?.[1]).toStrictEqual({
      name: "需求整理官",
      description: "把零散想法整理成 PRD",
      category: "产品",
      tags: ["需求", "PRD"],
      prompt: "你负责把需求整理成文档。",
      skills: ["pdf", "retired-skill"],
    });
    expect(callNames(fake)).toEqual(["listExperts", "listSkills", "updateExpert", "listExperts"]);
    await waitFor(() => expect(cardNames()).toContain("需求整理官"));
  });

  it("取消勾选列表外的名称即从 skills 去掉；新勾的排在已有之后", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    const dialog = await openForm(OWN.name);
    await skillsSettled(dialog, [
      ["xlsx", false],
      ["pdf", true],
      ["retired-skill", true],
    ]);
    tick(dialog, "retired-skill");
    tick(dialog, "xlsx");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateExpert.mock.calls[0]?.[1]).toMatchObject({ skills: ["pdf", "xlsx"] });
  });

  it("失败：框内 role=alert 显示 message，对话框不关，不重取", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    fake.updateExpert.mockRejectedValueOnce(new ApiError(404, "not_found", "请求的资源不存在"));
    await renderPanel(fake);

    const dialog = await openForm(OWN.name);
    save(dialog);

    expect((await within(dialog).findByRole("alert")).textContent).toBe("请求的资源不存在");
    expect(screen.getByRole("dialog", { name: "编辑专家" })).toBe(dialog);
    expect(callNames(fake)).toEqual(["listExperts", "listSkills", "updateExpert"]);
  });
});

describe("技能清单读取", () => {
  it("每次打开对话框恰一次 listSkills（新建与编辑各一次），面板挂载不取", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);
    expect(fake.listSkills).not.toHaveBeenCalled();

    const created = await openForm();
    fireEvent.click(within(created).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const edited = await openForm(OWN.name);
    fireEvent.click(within(edited).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    expect(callNames(fake)).toEqual(["listExperts", "listSkills", "listSkills"]);
  });

  it("新建时 listSkills 失败：多选为空、没有错误提示，仍可提交且 skills 为 []", async () => {
    const fake = fakeExperts(BUILTINS);
    fake.listSkills.mockRejectedValueOnce(new ApiError(503, "unavailable", "服务暂不可用"));
    await renderPanel(fake);

    const dialog = await openForm();
    await waitFor(() => expect(fake.listSkills).toHaveBeenCalledTimes(1));
    await screen.findByText("没有可选的技能");
    expect(skillBoxes(dialog)).toEqual([]);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    type(dialog, "名称", "甲");
    type(dialog, "提示词", "乙");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createExpert.mock.calls[0]?.[0]).toMatchObject({ skills: [] });
  });

  it("编辑时 listSkills 失败：只列出已有名称且已勾选，没有错误提示，提交原有的 skills", async () => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    fake.listSkills.mockRejectedValueOnce(new ApiError(503, "unavailable", "服务暂不可用"));
    await renderPanel(fake);

    const dialog = await openForm(OWN.name);
    await waitFor(() => expect(fake.listSkills).toHaveBeenCalledTimes(1));
    await skillsSettled(dialog, [
      ["pdf", true],
      ["retired-skill", true],
    ]);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateExpert.mock.calls[0]?.[1]).toMatchObject({
      skills: ["pdf", "retired-skill"],
    });
  });
});

describe("Escape", () => {
  it.each([
    ["新建", undefined, "新建专家"],
    ["编辑", OWN.name, "编辑专家"],
  ])("%s对话框按一次 Escape：关闭、不发写请求", async (_label, name, title) => {
    const fake = fakeExperts([...BUILTINS, OWN]);
    await renderPanel(fake);

    const dialog = await openForm(name);
    expect(screen.getByRole("dialog", { name: title })).toBe(dialog);
    type(dialog, "名称", "改过的名字");
    fireEvent.keyDown(field(dialog, "名称"), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createExpert).not.toHaveBeenCalled();
    expect(fake.updateExpert).not.toHaveBeenCalled();
    expect(fake.listExperts).toHaveBeenCalledTimes(1);
  });
});
