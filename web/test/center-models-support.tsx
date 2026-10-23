// 中心页「模型」tab 各测试文件共用的夹具（model-registry「模型 tab」，s1d-model-registry 任务 10.2）：一个按规格
// 行为应答的假 `ApiClient`（经 `ModelsPanel({client})` 注入，不经 fetch），调用记录，以及按 role + name 定位的助手。

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ModelsPanel } from "../src/features/center/models/panel.js";
import {
  type ApiClient,
  ApiError,
  type CreateModelInput,
  createApiClient,
  type ModelView,
  REQUEST_FAILED_MESSAGE,
  type UpdateModelInput,
} from "../src/lib/api.js";
import "./radix-platform.js";

/** 低熵哨兵（gitleaks）：表单里输入的密钥。 */
export const KEY = "wb-issue1651-api-key";
export const GW = "https://gw.example/v1";
export const GW2 = "https://gw2.example/v1";
export const PROBED_AT = 1_760_000_123_000;

function view(id: string, patch: Partial<ModelView> = {}): ModelView {
  return {
    id,
    name: id,
    reasoning: false,
    vision: false,
    maxTokens: 32768,
    efforts: null,
    upstream: null,
    isDefault: false,
    probe: { status: "never", at: null, message: null },
    updatedAt: 1_760_000_000_000,
    ...patch,
  };
}

/** 零配置种子行：推理 + 看图、`efforts` null、缺省；这里带一个上游。 */
export const SEED = view("deepseek-v4.1-flash", {
  reasoning: true,
  vision: true,
  isDefault: true,
  upstream: { baseUrl: "https://host.example/v1", hasApiKey: true },
});
/** 一个声明了强度、配了上游、探活失败过的非缺省模型。 */
export const M2 = view("m2", {
  name: "千问",
  reasoning: true,
  maxTokens: 8192,
  efforts: ["low", "high"],
  upstream: { baseUrl: GW, hasApiKey: true },
  probe: { status: "failed", at: 1_760_000_000_500, message: "HTTP 401：bad key" },
});
/** 没有上游的模型。 */
export const M3 = view("m3", { name: "本地" });

/** 非信封的 500（发布失败）：`api.ts` 构造的 `request_failed`。 */
export const publishFailed = () => new ApiError(500, "request_failed", REQUEST_FAILED_MESSAGE);

type Call = [method: string, ...args: unknown[]];

/**
 * 假客户端：持有一张表，六个方法按「模型管理端点」的语义改它并返回视图；每次调用记进 `calls`（次序即调用次序）。
 * 用例用 `mockImplementationOnce` / `mockRejectedValueOnce` 改写某一次应答。其余方法来自真实客户端、不会被调用。
 */
export function fakeModels(initial: readonly ModelView[]) {
  let models = [...initial];
  const calls: Call[] = [];
  const find = (id: string) => {
    const found = models.find((model) => model.id === id);
    if (!found) throw new ApiError(404, "not_found", "请求的资源不存在");
    return found;
  };
  const replace = (next: ModelView) => {
    models = models.map((model) => (model.id === next.id ? next : model));
    return next;
  };
  const methods = {
    listModels: vi.fn(async () => {
      calls.push(["listModels"]);
      return models.map((model) => ({ ...model }));
    }),
    createModel: vi.fn(async (input: CreateModelInput) => {
      calls.push(["createModel", input]);
      const { upstream, ...fields } = input;
      const created = view(input.id, {
        ...fields,
        name: input.name ?? input.id,
        efforts: input.efforts ?? null,
        upstream: upstream ? { baseUrl: upstream.baseUrl, hasApiKey: true } : null,
      });
      models = [...models, created];
      return created;
    }),
    updateModel: vi.fn(async (id: string, input: UpdateModelInput) => {
      calls.push(["updateModel", id, input]);
      const { upstream, ...fields } = input;
      return replace({
        ...find(id),
        ...fields,
        efforts: input.efforts ?? null,
        upstream: upstream ? { baseUrl: upstream.baseUrl, hasApiKey: true } : null,
      });
    }),
    deleteModel: vi.fn(async (id: string) => {
      calls.push(["deleteModel", id]);
      find(id);
      models = models.filter((model) => model.id !== id);
    }),
    setDefaultModel: vi.fn(async (id: string) => {
      calls.push(["setDefaultModel", id]);
      find(id);
      models = models.map((model) => ({ ...model, isDefault: model.id === id }));
      return find(id);
    }),
    probeModel: vi.fn(async (id: string) => {
      calls.push(["probeModel", id]);
      return replace({ ...find(id), probe: { status: "ok", at: PROBED_AT, message: null } });
    }),
  };
  const client: ApiClient = { ...createApiClient(), ...methods };
  return { client, calls, ...methods };
}

export type FakeModels = ReturnType<typeof fakeModels>;

/** 只看调用名的序列。 */
export const callNames = (fake: FakeModels) => fake.calls.map(([name]) => name);

/** 注入假客户端渲染面板，等到表出现。 */
export async function renderPanel(fake: FakeModels) {
  render(<ModelsPanel client={fake.client} />);
  return screen.findByRole("table");
}

/** 首列为该 id 的那一行。 */
export function rowOf(id: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

export function rowButton(id: string, name: string): HTMLElement {
  return within(rowOf(id)).getByRole("button", { name });
}

/** 打开 `新增模型` 或某行的 `编辑`，返回对话框。 */
export async function openForm(id?: string): Promise<HTMLElement> {
  if (id === undefined) {
    fireEvent.click(screen.getByRole("button", { name: "新增模型" }));
    return screen.findByRole("dialog", { name: "新增模型" });
  }
  fireEvent.click(rowButton(id, "编辑"));
  return screen.findByRole("dialog", { name: "编辑模型" });
}

export function type(dialog: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

export function tick(dialog: HTMLElement, name: string): void {
  fireEvent.click(within(dialog).getByRole("checkbox", { name }));
}

export function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
}

/**
 * 对话框关闭且之后的请求（探活、重取）都已结算：以 `listModels` 的调用次数为准。用 RTL `waitFor`，经
 * `asyncWrapper` 与 #1541 Scheduler 屏障（`scheduler-drain-setup.ts`）。不等焦点归还等 timer 副作用，
 * 要断言它们的用例须自己等结果本身（#1718）。
 */
export async function settled(fake: FakeModels, lists: number): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.listModels).toHaveBeenCalledTimes(lists);
  });
}

/** 页顶的提示：不在表内、不在对话框内的 `role="alert"`。 */
export function pageAlerts(): string[] {
  return screen
    .queryAllByRole("alert")
    .filter((alert) => !alert.closest("table") && !alert.closest('[role="dialog"]'))
    .map((alert) => alert.textContent ?? "");
}

/** 探活时刻的显示：规格给定的本地化写法。 */
export const probeTime = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });
