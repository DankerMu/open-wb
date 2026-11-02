// model-registry「模型 tab」的「知识库模型」段（s2a-kb-ragflow 任务 17.2）：知识库开关、设置读取失败与重试、嵌入模型
// 对话框（首次配置密钥必填、留空保留、更换需确认）、知识库对话模型下拉与锁定、重建状态与重试，以及删除被引用的对话
// 模型的 409。接缝：`ModelsPanel({client})` 注入假 `ApiClient`（不经 fetch）。期望值抄自 model-registry「模型 tab」、
// ragflow-backend「知识库模型设置」「嵌入模型更换与全量重建」与 `server/src/core/errors/index.ts` 的信封文案。

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsPanel } from "../src/features/center/models/panel.js";
import {
  ApiError,
  type KbSettingsView,
  type KbStatus,
  type ModelView,
  type UpdateKbSettingsInput,
} from "../src/lib/api.js";
import { chooseOption, openOptions, READY } from "./center-kb-support.js";
import {
  fakeModels,
  GW,
  GW2,
  KEY,
  M2,
  M3,
  PROBED_AT,
  probeTime,
  rowButton,
  rowOf,
  SEED,
  type,
} from "./center-models-support.js";

const SECTION = "知识库模型";
const DIALOG = "知识库嵌入模型";
const CONFIRM = "更换嵌入模型？";
const CHAT = "知识库对话模型";
const UNAVAILABLE = "知识库服务暂不可用";
const KB_MODEL_IN_USE = "该模型是知识库对话模型，先在知识库模型设置里换掉它";
const KB_CHAT_MODEL_LOCKED = "已有开启 RAPTOR 或知识图谱的知识库，不能更换或取消知识库对话模型";
const KB_REBUILDING = "知识库正在重建，请稍后再试";

afterEach(() => {
  cleanup();
});

const BGE: NonNullable<KbSettingsView["embedding"]> = {
  name: "bge-m3",
  baseUrl: GW,
  probe: { status: "never", message: null, at: null },
};

function settings(patch: Partial<KbSettingsView> = {}): KbSettingsView {
  return {
    embedding: BGE,
    chatModelId: null,
    bases: 0,
    compileBases: 0,
    documents: 0,
    rebuilding: 0,
    rebuildFailed: 0,
    ...patch,
  };
}

/**
 * 模型表的假客户端加四个设置方法：`updateKbSettings` 按 body 改读视图（嵌入模型换了即探活重置为 `never`），
 * `probeKbEmbedding` 写回 `ok`，`retryKbRebuild` 把失败的库计入重建中。读视图不含密钥（规格：永不包含任何密钥）。
 */
function fakeSettings(
  initial: KbSettingsView | null,
  status: KbStatus = READY,
  models: readonly ModelView[] = [SEED, M2, M3],
) {
  const fake = fakeModels(models);
  let view = initial ?? settings({ embedding: null });
  const methods = {
    getKbStatus: vi.fn(async () => status),
    getKbSettings: vi.fn(async () => ({ ...view })),
    updateKbSettings: vi.fn(async (input: UpdateKbSettingsInput) => {
      const { embedding } = input;
      view = {
        ...view,
        ...(embedding
          ? {
              embedding: {
                name: embedding.name,
                baseUrl: embedding.baseUrl,
                probe: { status: "never", message: null, at: null },
              },
            }
          : {}),
        ...(input.chatModelId === undefined ? {} : { chatModelId: input.chatModelId }),
        ...(input.confirmRebuild ? { rebuilding: view.bases } : {}),
      };
      return { ...view };
    }),
    probeKbEmbedding: vi.fn(async () => {
      if (view.embedding) {
        view = {
          ...view,
          embedding: { ...view.embedding, probe: { status: "ok", message: null, at: PROBED_AT } },
        };
      }
      return { ...view };
    }),
    retryKbRebuild: vi.fn(async () => {
      view = { ...view, rebuilding: view.rebuilding + view.rebuildFailed, rebuildFailed: 0 };
      return { ...view };
    }),
  };
  return { ...fake, ...methods, client: { ...fake.client, ...methods } };
}

type FakeSettings = ReturnType<typeof fakeSettings>;

async function renderSection(fake: FakeSettings): Promise<HTMLElement> {
  render(<ModelsPanel client={fake.client} />);
  return screen.findByRole("region", { name: SECTION });
}

/** 段内已读到设置（`编辑` 出现）。 */
async function renderReady(fake: FakeSettings): Promise<HTMLElement> {
  const section = await renderSection(fake);
  await within(section).findByRole("button", { name: "编辑" });
  return section;
}

async function openEmbedding(section: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(within(section).getByRole("button", { name: "编辑" }));
  return screen.findByRole("dialog", { name: DIALOG });
}

function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
}

/** 段内、不在对话框里的 `role="alert"`。 */
function sectionAlerts(section: HTMLElement): string[] {
  return within(section)
    .queryAllByRole("alert")
    .map((alert) => alert.textContent ?? "");
}

const chatTrigger = (section: HTMLElement) =>
  within(section).getByRole("combobox", { name: CHAT }) as HTMLButtonElement;

describe("知识库开关与读取", () => {
  it("知识库关闭（enabled:false）时整段不渲染，也不读设置", async () => {
    const fake = fakeSettings(settings(), { enabled: false });
    render(<ModelsPanel client={fake.client} />);

    await screen.findByRole("table");
    await waitFor(() => expect(fake.getKbStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: SECTION })).toBeNull();
    expect(screen.queryByText(SECTION)).toBeNull();
    expect(fake.getKbSettings).not.toHaveBeenCalled();
  });

  it("只看 enabled、不看 available：available:false 时照常渲染并读一次设置", async () => {
    const fake = fakeSettings(settings(), { ...READY, available: false });
    const section = await renderReady(fake);

    expect(within(section).getByText("bge-m3")).toBeTruthy();
    expect(fake.getKbSettings).toHaveBeenCalledTimes(1);
  });

  it("设置读取失败：段内显示「知识库服务暂不可用」与「重试」；点「重试」恰再读一次并渲染设置", async () => {
    const fake = fakeSettings(settings());
    fake.getKbSettings.mockRejectedValueOnce(new ApiError(503, "kb_unavailable", UNAVAILABLE));
    const section = await renderSection(fake);

    await waitFor(() => expect(sectionAlerts(section)).toEqual([UNAVAILABLE]));
    expect(within(section).queryByRole("button", { name: "编辑" })).toBeNull();
    fireEvent.click(within(section).getByRole("button", { name: "重试" }));

    expect(await within(section).findByText("bge-m3")).toBeTruthy();
    expect(fake.getKbSettings).toHaveBeenCalledTimes(2);
    expect(sectionAlerts(section)).toEqual([]);
  });

  it("嵌入模型显示名称、上游地址、密钥「已配置」与探活状态；知识库数与文档数；未配置时显示「未配置」", async () => {
    const probed = { status: "failed" as const, message: "HTTP 401：bad key", at: PROBED_AT };
    const fake = fakeSettings(settings({ embedding: { ...BGE, probe: probed }, bases: 2 }));
    const section = await renderReady(fake);

    expect(within(section).getByText("bge-m3")).toBeTruthy();
    expect(within(section).getByText(GW)).toBeTruthy();
    expect(within(section).getByText("已配置")).toBeTruthy();
    expect(within(section).getByText("失败：HTTP 401：bad key")).toBeTruthy();
    expect(within(section).getByText(probeTime(PROBED_AT))).toBeTruthy();
    expect(within(section).getByText("知识库 2 个，文档 0 份")).toBeTruthy();
    cleanup();

    const empty = await renderReady(fakeSettings(null));
    expect(within(empty).getByText("未配置")).toBeTruthy();
    expect(within(empty).queryByRole("button", { name: "探活" })).toBeNull();
  });
});

describe("嵌入模型对话框", () => {
  it("首次配置密钥必填：没填密钥不发请求、字段旁显示原因；填上后恰一次保存（带密钥）并紧接恰一次探活", async () => {
    const fake = fakeSettings(null);
    const section = await renderReady(fake);
    const dialog = await openEmbedding(section);
    const key = within(dialog).getByLabelText("密钥") as HTMLInputElement;
    expect(key.type).toBe("password");
    expect(key.placeholder).toBe("");

    type(dialog, "名称", "bge-m3");
    type(dialog, "上游地址", GW);
    save(dialog);
    expect(await within(dialog).findByText("首次配置必须填密钥")).toBeTruthy();
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(fake.updateKbSettings).not.toHaveBeenCalled();

    type(dialog, "密钥", KEY);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.probeKbEmbedding).toHaveBeenCalledTimes(1));
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    expect(fake.updateKbSettings.mock.calls[0]?.[0]).toEqual({
      embedding: { name: "bge-m3", baseUrl: GW, apiKey: KEY },
    });
    expect(await within(section).findByText("正常")).toBeTruthy();
    expect(document.body.textContent).not.toContain(KEY);
  });

  it("名称含 @、地址不合法、密钥只有空白：字段旁显示原因，不发请求", async () => {
    const fake = fakeSettings(null);
    const dialog = await openEmbedding(await renderReady(fake));

    type(dialog, "名称", "a@b");
    type(dialog, "上游地址", "ftp://x");
    type(dialog, "密钥", "   ");
    save(dialog);

    for (const label of ["名称", "上游地址", "密钥"]) {
      expect(within(dialog).getByLabelText(label).getAttribute("aria-invalid")).toBe("true");
    }
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
  });

  it("已配置时密钥框为空、提示「留空保留现有密钥」；留空保存即不带 apiKey（从不发空串）", async () => {
    const fake = fakeSettings(settings());
    const section = await renderReady(fake);
    const dialog = await openEmbedding(section);
    const key = within(dialog).getByLabelText("密钥") as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
    expect(key.placeholder).toBe("留空保留现有密钥");
    expect((within(dialog).getByLabelText("名称") as HTMLInputElement).value).toBe("bge-m3");
    expect((within(dialog).getByLabelText("上游地址") as HTMLInputElement).value).toBe(GW);

    type(dialog, "上游地址", GW2);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(fake.probeKbEmbedding).toHaveBeenCalledTimes(1));
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    const sent = fake.updateKbSettings.mock.calls[0]?.[0];
    expect(sent).toEqual({ embedding: { name: "bge-m3", baseUrl: GW2 } });
    expect(sent?.embedding && "apiKey" in sent.embedding).toBe(false);
  });

  it("名称与地址都没改、密钥留空：恰一次保存，不探活", async () => {
    const fake = fakeSettings(settings({ bases: 2, documents: 5 }));
    const dialog = await openEmbedding(await renderReady(fake));

    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    expect(fake.updateKbSettings.mock.calls[0]?.[0]).toEqual({
      embedding: { name: "bge-m3", baseUrl: GW },
    });
    expect(fake.probeKbEmbedding).not.toHaveBeenCalled();
  });

  it("只换密钥不是身份变化：有知识库也不弹确认，恰一次保存（不带 confirmRebuild），随后恰一次探活", async () => {
    const fake = fakeSettings(settings({ bases: 2, documents: 5 }));
    const dialog = await openEmbedding(await renderReady(fake));

    type(dialog, "密钥", KEY);
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(fake.probeKbEmbedding).toHaveBeenCalledTimes(1));
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    expect(fake.updateKbSettings.mock.calls[0]?.[0]).toEqual({
      embedding: { name: "bge-m3", baseUrl: GW, apiKey: KEY },
    });
  });

  it("更换嵌入模型需确认：确认框写明知识库数与文档数；取消不发请求；「重建并保存」恰一次带 confirmRebuild:true 的保存，随后恰一次探活", async () => {
    const fake = fakeSettings(settings({ bases: 2, documents: 5 }));
    const section = await renderReady(fake);
    const dialog = await openEmbedding(section);

    type(dialog, "名称", "text-embedding-3-small");
    save(dialog);
    const confirm = await screen.findByRole("alertdialog", { name: CONFIRM });
    expect(within(confirm).getByText(/2 个知识库（共 5 份文档）/u).textContent).toBe(
      "更换嵌入模型会重建全部 2 个知识库（共 5 份文档），重建期间不能入库。",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
    // 表单仍开着、值还在：「再保存」不用重填。
    const still = screen.getByRole("dialog", { name: DIALOG });
    expect((within(still).getByLabelText("名称") as HTMLInputElement).value).toBe(
      "text-embedding-3-small",
    );

    save(still);
    const again = await screen.findByRole("alertdialog", { name: CONFIRM });
    fireEvent.click(within(again).getByRole("button", { name: "重建并保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(fake.probeKbEmbedding).toHaveBeenCalledTimes(1));
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    expect(fake.updateKbSettings.mock.calls[0]?.[0]).toEqual({
      embedding: { name: "text-embedding-3-small", baseUrl: GW },
      confirmRebuild: true,
    });
    expect(await within(section).findByText("重建中 2 个")).toBeTruthy();
  });

  it("没有知识库时换地址不弹确认，保存不带 confirmRebuild", async () => {
    const fake = fakeSettings(settings({ bases: 0 }));
    const dialog = await openEmbedding(await renderReady(fake));

    type(dialog, "名称", "text-embedding-3-small");
    save(dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.updateKbSettings.mock.calls).toEqual([
      [{ embedding: { name: "text-embedding-3-small", baseUrl: GW } }],
    ]);
  });

  it("确认后服务端拒绝（409 kb_rebuilding）：确认框关闭，表单内 role=alert 显示信封文案，不探活", async () => {
    const fake = fakeSettings(settings({ bases: 2, documents: 5 }));
    fake.updateKbSettings.mockRejectedValueOnce(new ApiError(409, "kb_rebuilding", KB_REBUILDING));
    const dialog = await openEmbedding(await renderReady(fake));

    type(dialog, "上游地址", GW2);
    save(dialog);
    const confirm = await screen.findByRole("alertdialog", { name: CONFIRM });
    fireEvent.click(within(confirm).getByRole("button", { name: "重建并保存" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(KB_REBUILDING);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fake.updateKbSettings).toHaveBeenCalledTimes(1);
    expect(fake.probeKbEmbedding).not.toHaveBeenCalled();
  });

  it("「探活」恰一次 probeKbEmbedding，显示返回的探活状态", async () => {
    const fake = fakeSettings(settings());
    const section = await renderReady(fake);

    fireEvent.click(within(section).getByRole("button", { name: "探活" }));
    expect(await within(section).findByText("正常")).toBeTruthy();
    expect(fake.probeKbEmbedding).toHaveBeenCalledTimes(1);
    expect(fake.updateKbSettings).not.toHaveBeenCalled();
  });
});

describe("知识库对话模型", () => {
  it("下拉只列带上游的模型加「不使用」；选一项恰一次 updateKbSettings({chatModelId})，选「不使用」恰一次 null", async () => {
    const fake = fakeSettings(settings());
    const section = await renderReady(fake);
    expect(chatTrigger(section).textContent).toBe("不使用");

    const options = await openOptions(section, CHAT);
    expect(options.map((option) => option.textContent)).toEqual(["不使用", SEED.id, "m2"]);
    fireEvent.keyDown(options[0] as HTMLElement, { key: "Escape" });

    await chooseOption(section, CHAT, (text) => text === "m2", "m2");
    expect(fake.updateKbSettings.mock.calls).toEqual([[{ chatModelId: "m2" }]]);

    await chooseOption(section, CHAT, (text) => text === "不使用", "不使用");
    expect(fake.updateKbSettings.mock.calls).toEqual([
      [{ chatModelId: "m2" }],
      [{ chatModelId: null }],
    ]);
  });

  it.each([
    [{ chatModelId: "m2", compileBases: 1 }, true],
    [{ chatModelId: "m2", compileBases: 0 }, false],
    [{ chatModelId: null, compileBases: 1 }, false],
  ] as const)("开编译的库锁定对话模型下拉：%o → 禁用 %s", async (patch, locked) => {
    const section = await renderReady(fakeSettings(settings(patch)));
    const note = "已有 1 个开启 RAPTOR 或知识图谱的知识库，不能更换或取消";

    expect(chatTrigger(section).disabled).toBe(locked);
    expect(within(section).queryByText(note) !== null).toBe(locked);
  });

  it("服务端 409 kb_chat_model_locked：段内显示信封文案，下拉仍为原值", async () => {
    const fake = fakeSettings(settings({ chatModelId: "m2" }));
    fake.updateKbSettings.mockRejectedValueOnce(
      new ApiError(409, "kb_chat_model_locked", KB_CHAT_MODEL_LOCKED),
    );
    const section = await renderReady(fake);

    const options = await openOptions(section, CHAT);
    const none = options.find((option) => option.textContent === "不使用");
    fireEvent.keyDown(none as HTMLElement, { key: "Enter" });

    await waitFor(() => expect(sectionAlerts(section)).toEqual([KB_CHAT_MODEL_LOCKED]));
    expect(fake.updateKbSettings.mock.calls).toEqual([[{ chatModelId: null }]]);
    expect(chatTrigger(section).textContent).toBe("m2");
  });
});

describe("重建状态", () => {
  it("显示「重建中 N 个」「重建失败 N 个」；「重试失败的重建」恰一次 retryKbRebuild，显示返回的视图", async () => {
    const fake = fakeSettings(
      settings({ bases: 3, documents: 7, rebuilding: 1, rebuildFailed: 2 }),
    );
    const section = await renderReady(fake);

    expect(within(section).getByText("重建中 1 个")).toBeTruthy();
    expect(within(section).getByText("重建失败 2 个")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "重试失败的重建" }));

    expect(await within(section).findByText("重建中 3 个")).toBeTruthy();
    expect(within(section).queryByText(/重建失败/u)).toBeNull();
    expect(within(section).queryByRole("button", { name: "重试失败的重建" })).toBeNull();
    expect(fake.retryKbRebuild).toHaveBeenCalledTimes(1);
  });

  it("没有失败的库时不显示「重试失败的重建」，也不显示重建状态", async () => {
    const section = await renderReady(fakeSettings(settings({ bases: 2, documents: 3 })));

    expect(within(section).queryByRole("button", { name: "重试失败的重建" })).toBeNull();
    expect(within(section).queryByText(/重建/u)).toBeNull();
  });
});

describe("删除被引用的对话模型", () => {
  it("409 kb_model_in_use：该行显示信封文案，行仍在，不重取", async () => {
    const fake = fakeSettings(settings({ chatModelId: "m2" }));
    fake.deleteModel.mockRejectedValueOnce(new ApiError(409, "kb_model_in_use", KB_MODEL_IN_USE));
    await renderReady(fake);

    fireEvent.click(rowButton("m2", "删除"));
    const confirm = await screen.findByRole("alertdialog", { name: "删除模型 千问？" });
    fireEvent.click(within(confirm).getByRole("button", { name: "删除" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(rowOf("m2")).getByRole("alert").textContent).toBe(KB_MODEL_IN_USE);
    expect(fake.deleteModel).toHaveBeenCalledTimes(1);
    expect(fake.listModels).toHaveBeenCalledTimes(1);
  });
});
