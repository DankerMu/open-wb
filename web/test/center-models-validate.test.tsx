// model-registry「模型 tab」：提交前的六类客户端校验（s1d-model-registry 任务 10.2）。原因显示在字段旁、不调用客户端。
// 规则的独立来源：`server/src/model-catalog.ts`（id 1–128 UTF-8 字节、name 1–64 码点、无 U+0000–U+001F 与 U+007F，
// maxTokens 1..128000 整数）与 `server/src/agent-config.ts` 的地址正则 `^https?://[^\s#@]+$`。

import { cleanup, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeModels,
  GW,
  KEY,
  M2,
  M3,
  openForm,
  renderPanel,
  SEED,
  save,
  type,
} from "./center-models-support.js";

const MESSAGES = {
  idEmpty: "ID 不能为空",
  idControl: "ID 不能含控制字符",
  idBytes: "ID 不能超过 128 字节",
  name: "名称需为 1–64 个字符且不含控制字符",
  maxTokens: "最大 tokens 需为 1–128000 的整数",
  baseUrl: "上游地址需以 http:// 或 https:// 开头，且不含空白、# 或 @",
  keyRequired: "填了上游地址时必须填密钥",
  urlRequired: "填了密钥时必须填上游地址",
};

afterEach(() => {
  cleanup();
});

type Fields = Record<string, string>;

/** 新增对话框里按 label 填好字段后提交；返回对话框。 */
async function submitCreate(fields: Fields) {
  const fake = fakeModels([SEED]);
  await renderPanel(fake);
  const dialog = await openForm();
  for (const [label, value] of Object.entries(fields)) type(dialog, label, value);
  save(dialog);
  return { fake, dialog };
}

/** 字段的说明文字（经 `aria-describedby` 关联的那段）。 */
function describedBy(dialog: HTMLElement, label: string): string | null {
  const field = within(dialog).getByLabelText(label);
  const id = field.getAttribute("aria-describedby");
  return id ? (dialog.ownerDocument.getElementById(id)?.textContent ?? null) : null;
}

describe("新增的客户端校验", () => {
  it.each<[string, Fields, string, string]>([
    ["空 ID", {}, "ID", MESSAGES.idEmpty],
    ["ID 含 U+0007", { ID: "m\u0007" }, "ID", MESSAGES.idControl],
    ["ID 含 U+007F", { ID: "m\u007f" }, "ID", MESSAGES.idControl],
    // 43 个三字节汉字 = 129 字节，只有 43 个字符：按字节算才超。
    ["ID 129 字节", { ID: "模".repeat(43) }, "ID", MESSAGES.idBytes],
    ["名称 65 个码点", { ID: "m", 名称: "名".repeat(65) }, "名称", MESSAGES.name],
    ["名称含制表符", { ID: "m", 名称: "a\tb" }, "名称", MESSAGES.name],
    ["最大 tokens 0", { ID: "m", "最大 tokens": "0" }, "最大 tokens", MESSAGES.maxTokens],
    ["最大 tokens 128001", { ID: "m", "最大 tokens": "128001" }, "最大 tokens", MESSAGES.maxTokens],
    ["最大 tokens 1.5", { ID: "m", "最大 tokens": "1.5" }, "最大 tokens", MESSAGES.maxTokens],
    ["ftp 地址", { ID: "m", 上游地址: "ftp://x", 密钥: KEY }, "上游地址", MESSAGES.baseUrl],
    [
      "带 userinfo 的地址",
      { ID: "m", 上游地址: "https://u:p@gw.example/v1", 密钥: KEY },
      "上游地址",
      MESSAGES.baseUrl,
    ],
    [
      "带 fragment 的地址",
      { ID: "m", 上游地址: `${GW}#x`, 密钥: KEY },
      "上游地址",
      MESSAGES.baseUrl,
    ],
    [
      "带空白的地址",
      { ID: "m", 上游地址: "https://gw .example", 密钥: KEY },
      "上游地址",
      MESSAGES.baseUrl,
    ],
    ["有地址无密钥", { ID: "m", 上游地址: GW }, "密钥", MESSAGES.keyRequired],
    ["有密钥无地址", { ID: "m", 密钥: KEY }, "上游地址", MESSAGES.urlRequired],
  ])("%s：字段旁显示原因，不调用 createModel", async (_label, fields, field, message) => {
    const { fake, dialog } = await submitCreate(fields);

    expect(within(dialog).getByText(message)).toBeTruthy();
    expect(describedBy(dialog, field)).toBe(message);
    expect(within(dialog).getByLabelText(field).getAttribute("aria-invalid")).toBe("true");
    expect(fake.createModel).not.toHaveBeenCalled();
    expect(dialog.isConnected).toBe(true);
  });

  it("边界值都通过：128 字节 ID、64 码点名称、最大 tokens 1 与 128000、带路径与查询串的 http 地址", async () => {
    const { fake } = await submitCreate({
      ID: `${"模".repeat(42)}ab`,
      名称: "名".repeat(64),
      "最大 tokens": "128000",
      上游地址: "http://gw.example/v1?org=a",
      密钥: KEY,
    });

    await expect.poll(() => fake.createModel.mock.calls.length).toBe(1);
    expect(fake.createModel.mock.calls[0]?.[0]).toMatchObject({
      maxTokens: 128000,
      upstream: { baseUrl: "http://gw.example/v1?org=a", apiKey: KEY },
    });
  });

  it("新增时空名称与空最大 tokens 不校验（不发）", async () => {
    const { fake, dialog } = await submitCreate({ ID: "m", "最大 tokens": "1" });

    expect(within(dialog).queryByText(MESSAGES.name)).toBeNull();
    await expect.poll(() => fake.createModel.mock.calls[0]?.[0]).toEqual({ id: "m", maxTokens: 1 });
  });

  it("多个字段同时出错：各自显示，修正后再提交才发请求", async () => {
    const { fake, dialog } = await submitCreate({ 名称: "a\u0000", 密钥: KEY });

    expect(within(dialog).getByText(MESSAGES.idEmpty)).toBeTruthy();
    expect(within(dialog).getByText(MESSAGES.name)).toBeTruthy();
    expect(within(dialog).getByText(MESSAGES.urlRequired)).toBeTruthy();
    expect(fake.createModel).not.toHaveBeenCalled();

    type(dialog, "ID", "m");
    type(dialog, "名称", "好");
    type(dialog, "上游地址", GW);
    save(dialog);
    await expect.poll(() => fake.createModel.mock.calls.length).toBe(1);
  });
});

describe("编辑的客户端校验", () => {
  it.each<[string, string, Fields, string, string]>([
    ["清空名称", "m2", { 名称: "" }, "名称", MESSAGES.name],
    ["清空最大 tokens", "m2", { "最大 tokens": "" }, "最大 tokens", MESSAGES.maxTokens],
    ["没有上游的模型只填地址", "m3", { 上游地址: GW }, "密钥", MESSAGES.keyRequired],
    ["清空地址却填了密钥", "m2", { 上游地址: "", 密钥: KEY }, "上游地址", MESSAGES.urlRequired],
  ])("%s：字段旁显示原因，不调用 updateModel", async (_label, id, fields, field, message) => {
    const fake = fakeModels([SEED, M2, M3]);
    await renderPanel(fake);
    const dialog = await openForm(id);
    for (const [label, value] of Object.entries(fields)) type(dialog, label, value);
    save(dialog);

    expect(describedBy(dialog, field)).toBe(message);
    expect(fake.updateModel).not.toHaveBeenCalled();
  });

  it("有已存密钥的模型改地址、密钥留空：不要求密钥", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);
    const dialog = await openForm("m2");
    type(dialog, "上游地址", "https://gw3.example/v1");
    save(dialog);

    expect(within(dialog).queryByText(MESSAGES.keyRequired)).toBeNull();
    await expect.poll(() => fake.updateModel.mock.calls.length).toBe(1);
  });
});
