// model-registry「模型 tab」：`新增模型` / `编辑模型` 对话框——新增只发碰过的键、编辑的 PUT 映射、保存后的自动探活
// 判定、`efforts` 为 null 的种子行、密钥框、在途禁用与 Escape 回退、错误分流（s1d-model-registry 任务 10.2）。
// 六类客户端校验在 `center-models-validate.test.tsx`。假 `ApiClient` 经 `ModelsPanel({client})` 注入。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, REQUEST_FAILED_MESSAGE } from "../src/lib/api.js";
import {
  callNames,
  fakeModels,
  GW,
  GW2,
  KEY,
  M2,
  M3,
  openForm,
  pageAlerts,
  publishFailed,
  renderPanel,
  rowButton,
  SEED,
  save,
  settled,
  tick,
  type,
} from "./center-models-support.js";

const NOTE = "不勾选即不声明强度集合，界面列全部档位";

afterEach(() => {
  cleanup();
});

describe("新增：只发碰过的键", () => {
  it("规格例子：id m2、勾推理与 high / low、填地址与密钥 → input 恰为四键、efforts 按固定次序；随后恰一次 probeModel(m2)，全部结算后恰一次 listModels", async () => {
    const fake = fakeModels([SEED]);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "ID", "m2");
    tick(dialog, "推理");
    tick(dialog, "high");
    tick(dialog, "low");
    type(dialog, "上游地址", GW);
    type(dialog, "密钥", KEY);
    save(dialog);

    await settled(fake, 2);
    expect(fake.createModel.mock.calls).toEqual([
      [
        {
          id: "m2",
          reasoning: true,
          efforts: ["low", "high"],
          upstream: { baseUrl: GW, apiKey: KEY },
        },
      ],
    ]);
    expect(fake.calls).toEqual([
      ["listModels"],
      ["createModel", expect.anything()],
      ["probeModel", "m2"],
      ["listModels"],
    ]);
  });

  it("改了又改回的值不发：名称与最大 tokens 清空、看图取消、取消推理丢弃已勾的强度；没有地址就没有 upstream、不探活", async () => {
    const fake = fakeModels([SEED]);
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "ID", "m3");
    type(dialog, "名称", "临时");
    type(dialog, "名称", "");
    type(dialog, "最大 tokens", "4096");
    type(dialog, "最大 tokens", "");
    tick(dialog, "看图");
    tick(dialog, "看图");
    tick(dialog, "推理");
    tick(dialog, "medium");
    tick(dialog, "推理");
    expect(
      within(dialog).getByRole("checkbox", { name: "medium" }).getAttribute("data-state"),
    ).toBe("unchecked");
    expect(within(dialog).getByRole("checkbox", { name: "medium" }).hasAttribute("disabled")).toBe(
      true,
    );
    save(dialog);

    await settled(fake, 2);
    expect(fake.createModel.mock.calls).toEqual([[{ id: "m3" }]]);
    expect(callNames(fake)).toEqual(["listModels", "createModel", "listModels"]);
  });

  it("名称、看图、最大 tokens 给了就发；推理一个强度都不勾：带旁注、不发 efforts", async () => {
    const fake = fakeModels([SEED]);
    await renderPanel(fake);

    const dialog = await openForm();
    expect(within(dialog).queryByText(NOTE)).toBeNull();
    type(dialog, "ID", "m4");
    type(dialog, "名称", "深度");
    tick(dialog, "看图");
    tick(dialog, "推理");
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    type(dialog, "最大 tokens", "4096");
    save(dialog);

    await settled(fake, 2);
    expect(fake.createModel.mock.calls).toEqual([
      [{ id: "m4", name: "深度", reasoning: true, vision: true, maxTokens: 4096 }],
    ]);
  });

  it("密钥框是 password、新增时为空；关闭再打开，上次输入的内容不在", async () => {
    const fake = fakeModels([SEED]);
    await renderPanel(fake);

    const dialog = await openForm();
    const key = within(dialog).getByLabelText("密钥") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.value).toBe("");
    type(dialog, "ID", "m9");
    type(dialog, "密钥", KEY);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "新增模型" }));

    const reopened = await openForm();
    expect((within(reopened).getByLabelText("密钥") as HTMLInputElement).value).toBe("");
    expect((within(reopened).getByLabelText("ID") as HTMLInputElement).value).toBe("");
    expect(document.body.innerHTML).not.toContain(KEY);
    expect(fake.createModel).not.toHaveBeenCalled();
  });
});

describe("编辑：PUT 映射与自动探活", () => {
  it("预填视图、ID 只读、密钥框为空且 placeholder 为「留空保留现有密钥」；只改名 → upstream 只带 baseUrl、不探活", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    const dialog = await openForm("m2");
    const id = within(dialog).getByLabelText("ID") as HTMLInputElement;
    expect(id.value).toBe("m2");
    expect(id.readOnly).toBe(true);
    const key = within(dialog).getByLabelText("密钥") as HTMLInputElement;
    expect([key.type, key.value, key.placeholder]).toEqual(["password", "", "留空保留现有密钥"]);
    expect((within(dialog).getByLabelText("上游地址") as HTMLInputElement).value).toBe(GW);
    const states: [string, string][] = [
      ["推理", "checked"],
      ["看图", "unchecked"],
      ["low", "checked"],
      ["high", "checked"],
      ["medium", "unchecked"],
    ];
    for (const [name, state] of states) {
      expect(within(dialog).getByRole("checkbox", { name }).getAttribute("data-state"), name).toBe(
        state,
      );
    }
    type(dialog, "名称", "千问 2");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls).toEqual([
      [
        "m2",
        {
          name: "千问 2",
          reasoning: true,
          vision: false,
          maxTokens: 8192,
          efforts: ["low", "high"],
          upstream: { baseUrl: GW },
        },
      ],
    ]);
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "listModels"]);
    expect(document.activeElement).toBe(rowButton("m2", "编辑"));
  });

  it("改地址不填密钥 → upstream {baseUrl}，探活一次", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    const dialog = await openForm("m2");
    type(dialog, "上游地址", GW2);
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls[0]?.[1]).toMatchObject({ upstream: { baseUrl: GW2 } });
    expect(fake.updateModel.mock.calls[0]?.[1].upstream).not.toHaveProperty("apiKey");
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "probeModel", "listModels"]);
  });

  it("只填密钥 → upstream {baseUrl, apiKey}，探活一次", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    const dialog = await openForm("m2");
    type(dialog, "密钥", KEY);
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls[0]?.[1].upstream).toEqual({ baseUrl: GW, apiKey: KEY });
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "probeModel", "listModels"]);
  });

  it("清空地址 → upstream null，不探活", async () => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    const dialog = await openForm("m2");
    type(dialog, "上游地址", "");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls[0]?.[1].upstream).toBeNull();
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "listModels"]);
  });

  it("没有上游的模型填地址与密钥 → upstream {baseUrl, apiKey}，探活一次", async () => {
    const fake = fakeModels([SEED, M3]);
    await renderPanel(fake);

    const dialog = await openForm("m3");
    type(dialog, "上游地址", GW);
    type(dialog, "密钥", KEY);
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls[0]?.[1].upstream).toEqual({ baseUrl: GW, apiKey: KEY });
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "probeModel", "listModels"]);
  });

  it("种子行（推理、efforts null）：强度一个都不勾并带旁注；提交不带 efforts", async () => {
    const fake = fakeModels([SEED]);
    await renderPanel(fake);

    const dialog = await openForm(SEED.id);
    for (const effort of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
      const box = within(dialog).getByRole("checkbox", { name: effort });
      expect(box.getAttribute("data-state"), effort).toBe("unchecked");
      expect(box.hasAttribute("disabled"), effort).toBe(false);
    }
    expect(within(dialog).getByText(NOTE)).toBeTruthy();
    type(dialog, "名称", "深度求索");
    save(dialog);

    await settled(fake, 2);
    expect(fake.updateModel.mock.calls).toEqual([
      [
        SEED.id,
        {
          name: "深度求索",
          reasoning: true,
          vision: true,
          maxTokens: 32768,
          upstream: { baseUrl: "https://host.example/v1" },
        },
      ],
    ]);
    expect(callNames(fake)).toEqual(["listModels", "updateModel", "listModels"]);
  });
});

describe("在途与 Escape", () => {
  it("提交在途：保存与取消禁用，Escape 关不掉；结算后关闭", async () => {
    const fake = fakeModels([SEED]);
    let release!: () => void;
    fake.createModel.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve({ ...M3, id: input.id });
        }),
    );
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "ID", "m3");
    save(dialog);
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
    expect(within(dialog).getByRole("button", { name: "取消" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(within(dialog).getByLabelText("ID"), { key: "Escape" });
    save(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(fake.createModel).toHaveBeenCalledTimes(1);

    release();
    await settled(fake, 2);
  });

  it.each([
    ["新增", undefined],
    ["编辑", "m2"],
  ])("%s对话框按一次 Escape：关闭、不发请求、焦点回到打开它的按钮", async (_label, id) => {
    const fake = fakeModels([SEED, M2]);
    await renderPanel(fake);

    const dialog = await openForm(id);
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.createModel).not.toHaveBeenCalled();
    expect(fake.updateModel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(
      id === undefined ? screen.getByRole("button", { name: "新增模型" }) : rowButton(id, "编辑"),
    );
  });
});

describe("错误分流", () => {
  it.each([
    ["400", new ApiError(400, "bad_request", "请求格式不正确")],
    ["409", new ApiError(409, "conflict", "同名资源已存在")],
  ])(
    "新增的信封错误 %s：对话框保持打开，对话框内 role=alert 显示其 message；不探活、不重取",
    async (_label, error) => {
      const fake = fakeModels([SEED]);
      fake.createModel.mockRejectedValueOnce(error);
      await renderPanel(fake);

      const dialog = await openForm();
      type(dialog, "ID", "m2");
      type(dialog, "上游地址", GW);
      type(dialog, "密钥", KEY);
      save(dialog);

      expect((await within(dialog).findByRole("alert")).textContent).toBe(error.message);
      expect(within(dialog).getByRole("button", { name: "保存" }).hasAttribute("disabled")).toBe(
        false,
      );
      expect(fake.probeModel).not.toHaveBeenCalled();
      expect(fake.listModels).toHaveBeenCalledTimes(1);
      expect(pageAlerts()).toEqual([]);
      expect(dialog.textContent).not.toContain(KEY);
    },
  );

  it.each([
    ["新增", undefined],
    ["编辑", "m2"],
  ])(
    "%s收到非信封 500：关闭对话框、不自动探活、重取一次、页顶显示 REQUEST_FAILED_MESSAGE",
    async (_label, id) => {
      const fake = fakeModels([SEED, M2]);
      fake.createModel.mockRejectedValueOnce(publishFailed());
      fake.updateModel.mockRejectedValueOnce(publishFailed());
      await renderPanel(fake);

      const dialog = await openForm(id);
      if (id === undefined) type(dialog, "ID", "m5");
      type(dialog, "上游地址", GW2);
      type(dialog, "密钥", KEY);
      save(dialog);

      await settled(fake, 2);
      expect(pageAlerts()).toEqual([REQUEST_FAILED_MESSAGE]);
      expect(fake.probeModel).not.toHaveBeenCalled();
    },
  );

  it("保存后的自动探活抛 ApiError：页顶显示其 message，照样重取", async () => {
    const fake = fakeModels([SEED]);
    fake.probeModel.mockRejectedValueOnce(new ApiError(404, "not_found", "请求的资源不存在"));
    await renderPanel(fake);

    const dialog = await openForm();
    type(dialog, "ID", "m2");
    type(dialog, "上游地址", GW);
    type(dialog, "密钥", KEY);
    save(dialog);

    await settled(fake, 2);
    expect(fake.probeModel).toHaveBeenCalledWith("m2");
    expect(pageAlerts()).toEqual(["请求的资源不存在"]);
  });
});
