// 中心页「连接器」tab 各测试文件共用的夹具（connectors「中心「连接器」tab」，s1d-connectors 任务 6.2）：一个按
// 「连接器管理端点」「连接器账号缺省」语义应答的假 `ApiClient`（经 `ConnectorsPanel({client, admin})` 注入，不经
// fetch），调用记录，以及按 role + name 定位的助手。普通用户的 `listConnectors` 只给启用的行、恰三键（服务端
// `rest.ts` 的 GET 语义）；七个连接器方法之外的客户端方法一律换成会抛错的 spy。

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import { ConnectorsPanel } from "../src/features/center/connectors/panel.js";
import {
  type ApiClient,
  ApiError,
  type ConnectorListing,
  type ConnectorView,
  type CreateConnectorInput,
  createApiClient,
  REQUEST_FAILED_MESSAGE,
  type UpdateConnectorInput,
} from "../src/lib/api.js";
import "./radix-platform.js";

/** 低熵哨兵（gitleaks）：表单里输入的凭证值。 */
export const TOKEN = "wb-issue1675-token";
export const GITLAB_COMMAND = "/usr/local/bin/gitlab-mcp";
export const DOCS_URL = "https://docs.example/mcp";
export const WIKI_URL = "https://wiki.example/mcp";
export const PROBED_AT = 1_760_000_123_000;
const NEVER = { status: "never", at: null, message: null } as const;

export function stdioView(name: string, patch: Partial<ConnectorView> = {}): ConnectorView {
  return {
    name,
    type: "stdio",
    description: "",
    enabled: true,
    command: `/opt/${name}-mcp`,
    args: [],
    envKeys: [],
    url: null,
    headerKeys: null,
    probe: NEVER,
    updatedAt: 1_760_000_000_000,
    ...patch,
  };
}

export function httpView(name: string, patch: Partial<ConnectorView> = {}): ConnectorView {
  return {
    name,
    type: "http",
    description: "",
    enabled: true,
    command: null,
    args: null,
    envKeys: null,
    url: `https://${name}.example/mcp`,
    headerKeys: [],
    probe: NEVER,
    updatedAt: 1_760_000_000_000,
    ...patch,
  };
}

/** 规格「启用开关与空态」的那一行：stdio `gitlab`，描述 `代码库`、参数 `--stdio`、凭证键 `TOKEN`、启用。 */
export const GITLAB = stdioView("gitlab", {
  description: "代码库",
  command: GITLAB_COMMAND,
  args: ["--stdio"],
  envKeys: ["TOKEN"],
});
/** 停用的 http 连接器，探活失败过，带一个请求头。 */
export const DOCS = httpView("docs", {
  description: "文档",
  enabled: false,
  url: DOCS_URL,
  headerKeys: ["authorization"],
  probe: { status: "failed", at: 1_760_000_000_500, message: "HTTP 401：bad token" },
});
/** 探活正常的 stdio 连接器，没有凭证。 */
export const LINT = stdioView("lint", {
  probe: { status: "ok", at: 1_760_000_000_700, message: null },
});

/** 非信封的 500（发布失败）：`api.ts` 构造的 `request_failed`。 */
export const publishFailed = () => new ApiError(500, "request_failed", REQUEST_FAILED_MESSAGE);
/** 服务端取值规则的 400（固定文案）。 */
export const badRequest = () => new ApiError(400, "bad_request", "请求格式不正确");

type Call = [method: string, ...args: unknown[]];

function created(input: CreateConnectorInput): ConnectorView {
  const common = { description: input.description ?? "", enabled: input.enabled ?? true };
  return input.type === "stdio"
    ? stdioView(input.name, {
        ...common,
        command: input.command,
        args: input.args ?? [],
        envKeys: Object.keys(input.env ?? {}).sort(),
      })
    : httpView(input.name, {
        ...common,
        url: input.url,
        headerKeys: Object.keys(input.headers ?? {}).sort(),
      });
}

function updated(view: ConnectorView, input: UpdateConnectorInput): ConnectorView {
  const common = { description: input.description, enabled: input.enabled, probe: view.probe };
  return "command" in input
    ? { ...view, ...common, command: input.command, args: input.args, envKeys: keysOf(input.env) }
    : { ...view, ...common, url: input.url, headerKeys: keysOf(input.headers) };
}

const keysOf = (entries: Readonly<Record<string, unknown>>) => Object.keys(entries).sort();

/**
 * 假客户端：持有连接器表与账号缺省；七个方法按端点语义改它并返回结果，每次调用记进 `calls`（次序即调用次序）。
 * `admin` 只决定 `listConnectors` 的应答形状（管理员视图 / 恰三键的启用行）；用例另以 `renderPanel` 决定界面身份。
 */
export function fakeConnectors(
  initial: readonly ConnectorView[],
  { admin = true, disabled = [] as readonly string[] } = {},
) {
  let connectors = [...initial];
  let defaults = [...disabled];
  const calls: Call[] = [];
  const find = (name: string) => {
    const found = connectors.find((connector) => connector.name === name);
    if (!found) throw new ApiError(404, "not_found", "请求的资源不存在");
    return found;
  };
  const replace = (next: ConnectorView) => {
    connectors = connectors.map((connector) => (connector.name === next.name ? next : connector));
    return next;
  };
  const methods = {
    listConnectors: vi.fn(async (): Promise<ConnectorListing> => {
      calls.push(["listConnectors"]);
      return admin
        ? { admin: true, connectors: structuredClone(connectors) }
        : {
            admin: false,
            connectors: connectors
              .filter((connector) => connector.enabled)
              .map(({ name, type, description }) => ({ name, type, description })),
          };
    }),
    createConnector: vi.fn(async (input: CreateConnectorInput) => {
      calls.push(["createConnector", input]);
      const view = created(input);
      connectors = [...connectors, view].sort((a, b) => (a.name < b.name ? -1 : 1));
      return view;
    }),
    updateConnector: vi.fn(async (name: string, input: UpdateConnectorInput) => {
      calls.push(["updateConnector", name, input]);
      return replace(updated(find(name), input));
    }),
    deleteConnector: vi.fn(async (name: string) => {
      calls.push(["deleteConnector", name]);
      find(name);
      connectors = connectors.filter((connector) => connector.name !== name);
    }),
    probeConnector: vi.fn(async (name: string) => {
      calls.push(["probeConnector", name]);
      return replace({ ...find(name), probe: { status: "ok", at: PROBED_AT, message: null } });
    }),
    getConnectorDefaults: vi.fn(async () => {
      calls.push(["getConnectorDefaults"]);
      return [...defaults];
    }),
    putConnectorDefaults: vi.fn(async (names: readonly string[]) => {
      calls.push(["putConnectorDefaults", names]);
      defaults = [...new Set(names)].sort();
      return [...defaults];
    }),
  };
  const base = createApiClient();
  const others = Object.fromEntries(
    Object.keys(base)
      .filter((name) => !(name in methods))
      .map((name) => [
        name,
        vi.fn(async () => {
          throw new Error(`unexpected ${name}`);
        }),
      ]),
  );
  const client = { ...base, ...others, ...methods } as ApiClient;
  const otherCalls = () =>
    Object.entries(others)
      .filter(([, spy]) => spy.mock.calls.length > 0)
      .map(([name]) => name);
  return { client, calls, otherCalls, admin, ...methods };
}

export type FakeConnectors = ReturnType<typeof fakeConnectors>;

/** 只看调用名的序列。 */
export const callNames = (fake: FakeConnectors) => fake.calls.map(([name]) => name);

/** 注入假客户端渲染面板（界面身份缺省同假客户端的应答形状），等到读取结束。 */
export async function renderPanel(fake: FakeConnectors, admin = fake.admin): Promise<void> {
  render(<ConnectorsPanel admin={admin} client={fake.client} />);
  await waitFor(() => expect(screen.queryByText("正在读取连接器")).toBeNull());
}

/** 首列为该名称的那一行。 */
export function rowOf(name: string): HTMLElement {
  const row = screen
    .getAllByRole("row")
    .find((candidate) => within(candidate).queryAllByRole("cell")[0]?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

export function rowButton(name: string, label: string): HTMLElement {
  return within(rowOf(name)).getByRole("button", { name: label });
}

export function defaultSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name: `默认启用 ${name}` });
}

export function enabledSwitch(name: string): HTMLElement {
  return screen.getByRole("switch", { name: `启用 ${name}` });
}

/** 各开关的 `[accessible name, 是否开, 是否 aria-disabled]`，按显示次序。 */
export function switchStates(): [string, boolean, boolean][] {
  return screen
    .queryAllByRole("switch")
    .map((element) => [
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("aria-checked") === "true",
      element.getAttribute("aria-disabled") === "true",
    ]);
}

/** 打开 `新增连接器` 或某行的 `编辑`，返回对话框。 */
export async function openForm(name?: string): Promise<HTMLElement> {
  if (name === undefined) {
    fireEvent.click(screen.getByRole("button", { name: "新增连接器" }));
    return screen.findByRole("dialog", { name: "新增连接器" });
  }
  fireEvent.click(rowButton(name, "编辑"));
  return screen.findByRole("dialog", { name: "编辑连接器" });
}

export function type(dialog: HTMLElement, label: string, value: string): void {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

/** 在类型 select 里选一项（写法同 `center-experts-support.tsx` 的分类）。 */
export async function chooseType(dialog: HTMLElement, value: "stdio" | "http"): Promise<void> {
  const trigger = within(dialog).getByRole("combobox", { name: "类型" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const option = await screen.findByRole("option", { name: value });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(trigger.textContent).toBe(value));
}

/** 加一行键值对并填上；返回该行的序号（从 1 起）。`noun` 为 `变量` 或 `请求头`。 */
export function addEntry(
  dialog: HTMLElement,
  noun: "变量" | "请求头",
  key: string,
  value: string,
): void {
  const add = noun === "变量" ? "添加环境变量" : "添加请求头";
  fireEvent.click(within(dialog).getByRole("button", { name: add }));
  const keys = within(dialog).getAllByLabelText(new RegExp(`^${noun}名 \\d+$`));
  const index = keys.length;
  type(dialog, `${noun}名 ${index}`, key);
  type(dialog, `${noun}值 ${index}`, value);
}

export function save(dialog: HTMLElement): void {
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
}

/** 对话框关闭且之后的请求（探活、重取）都已结算：以 `listConnectors` 的调用次数为准。 */
export async function settled(fake: FakeConnectors, lists: number): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fake.listConnectors).toHaveBeenCalledTimes(lists);
  });
}

/** 页顶的提示：不在表内、不在对话框内的 `role="alert"`。 */
export function pageAlerts(): string[] {
  return screen
    .queryAllByRole("alert")
    .filter((alert) => !alert.closest("table") && !alert.closest('[role="dialog"]'))
    .map((alert) => alert.textContent ?? "");
}

/** 让挂起的微任务跑完（不结算任何 deferred）。 */
export async function flush(): Promise<void> {
  await act(async () => {});
}

/** 可由用例手动结算的 promise。 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 探活时刻的显示：与模型 tab 同一本地化写法。 */
export const probeTime = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });
