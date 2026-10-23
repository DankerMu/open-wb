// experts「专家校验与可见性」的客户端一侧（中心「专家」tab 的对话框，s1d-experts-skills 任务 7.2）：提交前逐字段
// 校验，原因显示在字段旁；有任一不过就不调用客户端。规则与服务端同一份（`server/src/experts/store.ts`）：长度按码点，
// `name` / `prompt` 计 trim 后的码点，`description` 不 trim；标签以半角或全角逗号分隔、各项 trim、丢空项后先按项数
//（去重之前）再按每项码点判。各条给边界两侧与 CJK / emoji 码点计数例。

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SkillList } from "../src/lib/api.js";
import {
  BUILTINS,
  fakeExperts,
  OWN,
  openForm,
  renderPanel,
  save,
  skillStates,
  type,
} from "./center-experts-support.js";

const NAME = "名称需为 1–32 个字符";
const DESCRIPTION = "描述不能超过 200 个字符";
const TAG_COUNT = "标签最多 5 个";
const TAG_LENGTH = "每个标签不超过 12 个字符";
const PROMPT = "提示词需为 1–8000 个字符";
const SKILLS = "最多选择 32 个技能";
const MESSAGES = [NAME, DESCRIPTION, TAG_COUNT, TAG_LENGTH, PROMPT, SKILLS];

/** 一个 emoji 是一个码点、两个 UTF-16 单元：按 `.length` 计数的实现在这些例子上会错。 */
const EMOJI = "😀";

afterEach(() => {
  cleanup();
});

type Fields = Partial<Record<"名称" | "描述" | "标签" | "提示词", string>>;

/** 打开 `新建专家`，先填合法的名称与提示词，再按 `fields` 覆盖，提交；返回对话框与假客户端。 */
async function submit(fields: Fields) {
  const fake = fakeExperts(BUILTINS);
  await renderPanel(fake);
  const dialog = await openForm();
  const values: Fields = { 名称: "专家", 提示词: "提示", ...fields };
  for (const [label, value] of Object.entries(values)) type(dialog, label, value);
  save(dialog);
  return { dialog, fake };
}

/** 页面上出现的校验原因（只看六条规则文案）。 */
function shownMessages(dialog: HTMLElement): string[] {
  return MESSAGES.filter((message) => within(dialog).queryByText(message) !== null);
}

async function expectRejected(fields: Fields, message: string, label?: string) {
  const { dialog, fake } = await submit(fields);
  await within(dialog).findByText(message);
  expect(shownMessages(dialog)).toEqual([message]);
  if (label) {
    expect(within(dialog).getByLabelText(label).getAttribute("aria-invalid")).toBe("true");
  }
  expect(fake.createExpert).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "新建专家" })).toBe(dialog);
}

async function expectAccepted(fields: Fields, expected: Record<string, unknown>) {
  const { dialog, fake } = await submit(fields);
  await waitFor(() => expect(fake.createExpert).toHaveBeenCalledTimes(1));
  expect(shownMessages(dialog)).toEqual([]);
  expect(fake.createExpert.mock.calls[0]?.[0]).toMatchObject(expected);
}

describe("名称：trim 后 1..32 码点", () => {
  it.each([
    ["32 个 CJK", "名".repeat(32)],
    ["32 个 emoji", EMOJI.repeat(32)],
    ["首尾空白不计", `  ${"名".repeat(32)}  `],
  ])("%s 通过", async (_label, name) => {
    await expectAccepted({ 名称: name }, { name: name.trim() });
  });

  it.each([
    ["33 个 CJK", "名".repeat(33)],
    ["33 个 emoji", EMOJI.repeat(33)],
    ["只有空白", "   "],
    ["空", ""],
  ])("%s 被拒", async (_label, name) => {
    await expectRejected({ 名称: name }, NAME, "名称");
  });
});

describe("描述：0..200 码点，不 trim", () => {
  it.each([
    ["200 个 CJK", "述".repeat(200)],
    ["200 个 emoji", EMOJI.repeat(200)],
    ["空", ""],
  ])("%s 通过", async (_label, description) => {
    await expectAccepted({ 描述: description }, { description });
  });

  it.each([
    ["201 个 CJK", "述".repeat(201)],
    ["201 个空白（不 trim）", " ".repeat(201)],
  ])("%s 被拒", async (_label, description) => {
    await expectRejected({ 描述: description }, DESCRIPTION, "描述");
  });
});

describe("标签：逗号分隔，至多 5 项（去重之前），每项至多 12 码点", () => {
  it.each([
    ["5 项", "一,二,三,四,五", ["一", "二", "三", "四", "五"]],
    ["空项不计", "一,, 二 ，，三, ", ["一", "二", "三"]],
    ["12 个 CJK", "标".repeat(12), ["标".repeat(12)]],
    ["12 个 emoji", EMOJI.repeat(12), [EMOJI.repeat(12)]],
    ["重复项去重保序", "乙,甲,乙", ["乙", "甲"]],
    ["全空", " ， , ", []],
  ])("%s 通过", async (_label, tags, expected) => {
    await expectAccepted({ 标签: tags }, { tags: expected });
  });

  it.each([
    ["6 项", "一,二,三,四,五,六", TAG_COUNT],
    ["6 项（重复也算）", "甲,甲,甲,甲,甲,甲", TAG_COUNT],
    ["全角逗号 6 项", "一，二，三，四，五，六", TAG_COUNT],
    ["13 个 CJK", "标".repeat(13), TAG_LENGTH],
    ["13 个 emoji", EMOJI.repeat(13), TAG_LENGTH],
  ])("%s 被拒", async (_label, tags, message) => {
    await expectRejected({ 标签: tags }, message, "标签");
  });
});

describe("提示词：trim 后 1..8000 码点", () => {
  it.each([
    ["8000 个 CJK", "提".repeat(8000)],
    ["8000 个 emoji", EMOJI.repeat(8000)],
  ])("%s 通过", async (_label, prompt) => {
    await expectAccepted({ 提示词: prompt }, { prompt });
  });

  it.each([
    ["8001 个 CJK", "提".repeat(8001)],
    ["只有空白", " \n\t "],
  ])("%s 被拒", async (_label, prompt) => {
    await expectRejected({ 提示词: prompt }, PROMPT, "提示词");
  });
});

describe("技能：至多勾选 32 项", () => {
  const many: SkillList = {
    skills: Array.from({ length: 33 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: "",
      enabledByDefault: true,
    })),
    disabledSkills: [],
  };
  const names = many.skills.map((skill) => skill.name);

  /**
   * 打开一位已持有 `skills` 的自建专家的 `编辑`（勾选来自预填，不逐项点击：33 次点击在 CI 覆盖率下会超时），
   * 等多选列出全部 33 项且已持有的那些已勾，再提交。「点一下即加入 skills」由 center-experts-form 覆盖。
   */
  async function submitEdit(skills: string[]) {
    const fake = fakeExperts([...BUILTINS, { ...OWN, skills }], many);
    await renderPanel(fake);
    const dialog = await openForm(OWN.name);
    await waitFor(() =>
      expect(skillStates(dialog)).toEqual(names.map((name) => [name, skills.includes(name)])),
    );
    save(dialog);
    return { dialog, fake };
  }

  it("32 项通过", async () => {
    const { dialog, fake } = await submitEdit(names.slice(0, 32));
    await waitFor(() => expect(fake.updateExpert).toHaveBeenCalledTimes(1));
    expect(shownMessages(dialog)).toEqual([]);
    expect(fake.updateExpert.mock.calls[0]?.[1]).toMatchObject({ skills: names.slice(0, 32) });
  });

  it("33 项被拒", async () => {
    const { dialog, fake } = await submitEdit(names);
    await within(dialog).findByText(SKILLS);
    expect(shownMessages(dialog)).toEqual([SKILLS]);
    expect(fake.updateExpert).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "编辑专家" })).toBe(dialog);
  });
});

it("多个字段同时不过：各自显示原因，不调用客户端", async () => {
  const { dialog, fake } = await submit({
    名称: "",
    描述: "述".repeat(201),
    标签: "一,二,三,四,五,六",
    提示词: "",
  });
  await within(dialog).findByText(NAME);
  expect(shownMessages(dialog)).toEqual([NAME, DESCRIPTION, TAG_COUNT, PROMPT]);
  expect(fake.createExpert).not.toHaveBeenCalled();
});
