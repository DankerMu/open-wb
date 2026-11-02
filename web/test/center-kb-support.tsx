// 中心页「知识库」tab 测试共用的夹具（knowledge-bases「中心「知识库」tab」，s2a-kb-ragflow 任务 15.2）：一个按规格
// 行为应答的假 `ApiClient`（经 `KnowledgeBasesPanel({client})` 注入，不经 fetch），以及按 role + name 定位的助手。

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { KnowledgeBasesPanel } from "../src/features/center/kb/panel.js";
import {
  type ApiClient,
  type BaseView,
  type CreateKnowledgeBaseInput,
  createApiClient,
  type KbStatus,
} from "../src/lib/api.js";
import "./radix-platform.js";

/** 开启、可用、嵌入模型就绪、知识库对话模型已指定。 */
export const READY: Extract<KbStatus, { enabled: true }> = {
  enabled: true,
  available: true,
  embeddingReady: true,
  compileReady: true,
  uploadMaxBytes: 104_857_600,
  uploadMaxFiles: 10,
};

/** 十键 `BaseView`：缺省是两开关都关、就绪、没有文档的 `naive` 库。 */
export function base(id: string, patch: Partial<BaseView> = {}): BaseView {
  return {
    id,
    name: id,
    template: "naive",
    raptor: false,
    graph: false,
    state: "ready",
    stateMessage: null,
    documents: 0,
    compile: { raptor: "off", graph: "off" },
    createdAt: 1_760_000_000_000,
    ...patch,
  };
}

type Call = [method: string, ...args: unknown[]];

/**
 * 假客户端：`statuses` 依次作为每次 `getKbStatus` 的应答（用完后重复最后一个），持有一张知识库表，建库 / 删库按
 * 「知识库端点」的语义改它。每次调用记进 `calls`。其余方法来自真实客户端、不会被调用。
 */
export function fakeKb(statuses: readonly KbStatus[], initial: readonly BaseView[] = []) {
  let bases = [...initial];
  let reads = 0;
  const calls: Call[] = [];
  const methods = {
    getKbStatus: vi.fn(async () => {
      calls.push(["getKbStatus"]);
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      if (!status) throw new Error("fakeKb needs at least one status");
      return status;
    }),
    listKnowledgeBases: vi.fn(async () => {
      calls.push(["listKnowledgeBases"]);
      return bases.map((item) => ({ ...item }));
    }),
    createKnowledgeBase: vi.fn(async (input: CreateKnowledgeBaseInput) => {
      calls.push(["createKnowledgeBase", input]);
      const created = base(`kb-${bases.length + 1}`, {
        name: input.name,
        template: input.template,
        raptor: input.raptor ?? false,
        graph: input.graph ?? false,
        compile: {
          raptor: input.raptor ? "pending" : "off",
          graph: input.graph ? "pending" : "off",
        },
      });
      bases = [...bases, created];
      return created;
    }),
    deleteKnowledgeBase: vi.fn(async (id: string) => {
      calls.push(["deleteKnowledgeBase", id]);
      bases = bases.filter((item) => item.id !== id);
    }),
  };
  const client: ApiClient = { ...createApiClient(), ...methods };
  return { client, calls, ...methods };
}

export type FakeKb = ReturnType<typeof fakeKb>;

/** 注入假客户端渲染面板。 */
export function renderPanel(fake: FakeKb) {
  render(<KnowledgeBasesPanel client={fake.client} />);
}

/** 首列为该名称的那一行。 */
export function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

/** 点 `新建知识库`，返回对话框。 */
export async function openCreate(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "新建知识库" }));
  return screen.findByRole("dialog", { name: "新建知识库" });
}

/** 打开模板下拉（Radix Select 在 jsdom 里以键盘驱动），返回全部选项。 */
export async function openTemplates(dialog: HTMLElement): Promise<HTMLElement[]> {
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "模板" }), { key: "Enter" });
  await screen.findAllByRole("option");
  return screen.getAllByRole("option");
}

/** 选中中文名为 `label` 的模板（选项文案为「中文名 — 说明」）。 */
export async function chooseTemplate(dialog: HTMLElement, label: string): Promise<void> {
  const options = await openTemplates(dialog);
  const option = options.find((item) => item.textContent?.startsWith(`${label} — `));
  if (!option) throw new Error(`no template option ${label}`);
  fireEvent.keyDown(option, { key: "Enter" });
  const trigger = within(dialog).getByRole("combobox", { name: "模板" });
  await waitFor(() => expect(trigger.textContent).toBe(label));
}

/** 对话框里的复选框名称，按显示次序。 */
export function checkboxNames(dialog: HTMLElement): string[] {
  return within(dialog)
    .queryAllByRole("checkbox")
    .map((box) => document.querySelector(`label[for="${box.id}"]`)?.textContent ?? "");
}

/** 面板内、不在对话框里的 `role="alert"`。 */
export function pageAlerts(): string[] {
  return screen
    .queryAllByRole("alert")
    .filter((alert) => !alert.closest('[role="dialog"]') && !alert.closest('[role="alertdialog"]'))
    .map((alert) => alert.textContent ?? "");
}
