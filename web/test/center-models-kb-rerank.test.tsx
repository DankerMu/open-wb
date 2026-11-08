// model-registry「模型 tab」的重排模型一行（s2b-kb-retrieval 任务 9.2）：未配置只有编辑；对话框与嵌入模型同一形式、
// 没有重建确认；保存后上游有改动时恰一次 `probeKbModel("rerank")`；`探活`；`清除` 的取消与确认；失败的去处；与嵌入
// 探活互不阻塞。接缝：`ModelsPanel({client})` 注入假 `ApiClient`（不经 fetch）。期望值抄自 model-registry「模型 tab」
//「重排模型」场景、design D8 与 `server/src/core/errors/index.ts` 的信封文案。

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError, type KbSettingsView } from "../src/lib/api.js";
import {
  fakeSettings,
  GW,
  KEY,
  renderReady,
  save,
  settings,
  type,
} from "./center-models-support.js";

const DIALOG = "知识库重排模型";
const CLEAR = "清除重排模型？";
const UNAVAILABLE = "知识库服务暂不可用";
const QWEN: NonNullable<KbSettingsView["rerank"]> = {
  name: "qwen3-rerank",
  baseUrl: GW,
  probe: { status: "never", message: null, at: null },
};

afterEach(() => {
  cleanup();
});

/** 重排一行的按钮：可访问名称是 `<动作>重排模型`，显示文字仍是动作本身。 */
const rerankButton = (section: HTMLElement, action: "编辑" | "探活" | "清除") =>
  within(section).getByRole("button", { name: `${action}重排模型` }) as HTMLButtonElement;

async function openRerank(section: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(rerankButton(section, "编辑"));
  return screen.findByRole("dialog", { name: DIALOG });
}

function fill(dialog: HTMLElement, key?: string): void {
  type(dialog, "名称", QWEN.name);
  type(dialog, "上游地址", GW);
  if (key !== undefined) type(dialog, "密钥", key);
}

function expectNoKey(): void {
  expect(document.body.textContent).not.toContain(KEY);
}

describe("重排模型", () => {
  it("未配置：显示「未配置」，只有「编辑」，没有「探活」「清除」", async () => {
    const section = await renderReady(fakeSettings(settings()));

    expect(rerankButton(section, "编辑").textContent).toBe("编辑");
    expect(within(section).queryByRole("button", { name: "探活重排模型" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "清除重排模型" })).toBeNull();
    expect(within(section).getAllByText("未配置")).toHaveLength(1);
    expectNoKey();
  });

  it("首次配置不填密钥：字段旁显示「首次配置必须填密钥」，不发请求", async () => {
    const fake = fakeSettings(settings());
    const dialog = await openRerank(await renderReady(fake));
    expect((within(dialog).getByLabelText("密钥") as HTMLInputElement).placeholder).toBe("");

    fill(dialog);
    save(dialog);
    expect(await within(dialog).findByText("首次配置必须填密钥")).toBeTruthy();
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
    expect(fake.probeKbModel).not.toHaveBeenCalled();
    expectNoKey();
  });

  it('有知识库（bases:2）时保存不弹重建确认：恰一次 {rerank:{name,baseUrl,apiKey}}，随后恰一次 probeKbModel("rerank")', async () => {
    const fake = fakeSettings(settings({ bases: 2, documents: 5 }));
    const section = await renderReady(fake);
    const dialog = await openRerank(section);

    fill(dialog, KEY);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(fake.probeKbModel).toHaveBeenCalledTimes(1));
    expect(fake.probeKbModel).toHaveBeenCalledWith("rerank");
    expect(fake.updateKbSettings.mock.calls).toEqual([
      [{ rerank: { name: QWEN.name, baseUrl: GW, apiKey: KEY } }],
    ]);
    expect(await within(section).findByText("正常")).toBeTruthy();
    expect(within(section).getByText(QWEN.name)).toBeTruthy();
    expectNoKey();
  });

  it("名称与地址都没改、密钥留空：恰一次保存（不带 apiKey），不探活", async () => {
    const fake = fakeSettings(settings({ rerank: QWEN }));
    const dialog = await openRerank(await renderReady(fake));
    const key = within(dialog).getByLabelText("密钥") as HTMLInputElement;
    expect(key.placeholder).toBe("留空保留现有密钥");
    expect((within(dialog).getByLabelText("名称") as HTMLInputElement).value).toBe(QWEN.name);

    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.updateKbSettings.mock.calls).toEqual([
      [{ rerank: { name: QWEN.name, baseUrl: GW } }],
    ]);
    expect(fake.probeKbModel).not.toHaveBeenCalled();
    expectNoKey();
  });

  it("只换密钥：有知识库也不弹确认，恰一次保存，随后恰一次探活", async () => {
    const fake = fakeSettings(settings({ rerank: QWEN, bases: 2, documents: 5 }));
    const dialog = await openRerank(await renderReady(fake));

    type(dialog, "密钥", KEY);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(fake.probeKbModel.mock.calls).toEqual([["rerank"]]));
    expect(fake.updateKbSettings.mock.calls).toEqual([
      [{ rerank: { name: QWEN.name, baseUrl: GW, apiKey: KEY } }],
    ]);
    expectNoKey();
  });

  it('「探活」恰一次 probeKbModel("rerank")，显示「正常」', async () => {
    const fake = fakeSettings(settings({ rerank: QWEN }));
    const section = await renderReady(fake);

    fireEvent.click(rerankButton(section, "探活"));
    expect(await within(section).findByText("正常")).toBeTruthy();
    expect(fake.probeKbModel.mock.calls).toEqual([["rerank"]]);
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
    expectNoKey();
  });

  it("「清除」先取消不发请求；再确认恰一次 {rerank:null}，回到「未配置」，焦点回到「编辑」", async () => {
    const fake = fakeSettings(settings({ rerank: QWEN }));
    const section = await renderReady(fake);

    fireEvent.click(rerankButton(section, "清除"));
    const confirm = await screen.findByRole("alertdialog", { name: CLEAR });
    expect(within(confirm).getByText("清除后检索不再重排。")).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
    expect(within(section).getByText(QWEN.name)).toBeTruthy();

    fireEvent.click(rerankButton(section, "清除"));
    const again = await screen.findByRole("alertdialog", { name: CLEAR });
    fireEvent.click(within(again).getByRole("button", { name: "清除" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.updateKbSettings.mock.calls).toEqual([[{ rerank: null }]]);
    expect(within(section).getAllByText("未配置")).toHaveLength(1);
    expect(within(section).queryByText(QWEN.name)).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(rerankButton(section, "编辑")));
    expectNoKey();
  });

  it("保存得 503：对话框内 role=alert 显示信封文案，不探活；清除得 503：确认框内显示文案，框不关，一行不变", async () => {
    const fake = fakeSettings(settings());
    fake.updateKbSettings.mockRejectedValueOnce(new ApiError(503, "kb_unavailable", UNAVAILABLE));
    const dialog = await openRerank(await renderReady(fake));
    fill(dialog, KEY);
    save(dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    expect(screen.getByRole("dialog", { name: DIALOG })).toBe(dialog);
    expect(fake.probeKbModel).not.toHaveBeenCalled();
    expectNoKey();
    cleanup();

    const configured = fakeSettings(settings({ rerank: QWEN }));
    configured.updateKbSettings.mockRejectedValueOnce(
      new ApiError(503, "kb_unavailable", UNAVAILABLE),
    );
    const section = await renderReady(configured);
    fireEvent.click(rerankButton(section, "清除"));
    const confirm = await screen.findByRole("alertdialog", { name: CLEAR });
    fireEvent.click(within(confirm).getByRole("button", { name: "清除" }));
    expect((await within(confirm).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    expect(screen.getByRole("alertdialog", { name: CLEAR })).toBe(confirm);
    expect(configured.updateKbSettings.mock.calls).toEqual([[{ rerank: null }]]);
    expect(within(section).getByText(QWEN.name)).toBeTruthy();
    expectNoKey();
  });

  it.each([
    ["rerank", "embedding"],
    ["embedding", "rerank"],
  ] as const)("%s 探活挂起时点 %s 的「探活」仍恰发一次（两者互不阻塞）", async (held, other) => {
    const fake = fakeSettings(settings({ rerank: QWEN }));
    fake.probeKbModel.mockImplementationOnce(() => new Promise<KbSettingsView>(() => {}));
    const section = await renderReady(fake);
    const button = (target: "embedding" | "rerank") =>
      target === "rerank"
        ? rerankButton(section, "探活")
        : (within(section).getByRole("button", { name: "探活" }) as HTMLButtonElement);

    fireEvent.click(button(held));
    await waitFor(() => expect(button(held).disabled).toBe(true));
    expect(button(other).disabled).toBe(false);
    fireEvent.click(button(other));
    expect(await within(section).findByText("正常")).toBeTruthy();
    expect(fake.probeKbModel.mock.calls).toEqual([[held], [other]]);
    expectNoKey();
  });
});
