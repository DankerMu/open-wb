import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { clickSend, sessionPromptPath, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  envelope,
  messagesPath,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { calls, currentLocation, type FetchMock, jsonResponse } from "./support.js";

// 欢迎页场景胶囊与 composer footer 空间选择（#533）的夹具与查询。

export const HERO = "WorkBuddy，我帮你";
const PICKER = "选择工作空间";
export const SEARCH = "搜索工作空间";
export const UNSELECTED = "未选择";
export const LOADING = "正在读取工作空间";
export const NO_MATCH = "没有匹配的工作空间";
export const CREATE_REJECTED = "创建会话被拒绝";

export const OFFICE_LABELS = [
  "文档处理",
  "内部汇报",
  "数据分析及可视化",
  "资料归档",
  "幻灯片",
  "产品需求",
];
export const CODE_LABELS = ["日常开发", "网站开发", "Agent 应用", "Skill 开发", "CI/CD"];
export const DESIGN_LABELS = ["网站设计", "PPT 设计", "视觉海报", "移动端 App", "设计系统"];

/** 两个空间的 `root` 都带这个前缀：页面任何位置出现它即渲染了绝对根路径。 */
export const ROOT_MARK = "/srv/ws-root";

function workspace(id: string, name: string, dir: string, root: string) {
  return { id, name, dir, root, createdAt: 1_740_000_000_000 };
}

type WorkspaceView = ReturnType<typeof workspace>;

export const PROJECT_A = workspace("1".repeat(32), "项目A", "项目A", `${ROOT_MARK}-a`);
export const SUPPORT = workspace("2".repeat(32), "客服", "kefu", `${ROOT_MARK}-b`);
export const ALPHA = workspace("3".repeat(32), "Alpha", "misc", `${ROOT_MARK}-c`);

/** 弹层里各选项按钮的完整文本（名称紧接逻辑路径，账号为 `zhangsan`）。 */
export const PROJECT_A_OPTION = "项目Azhangsan/项目A";
export const SUPPORT_OPTION = "客服zhangsan/kefu";
export const ALPHA_OPTION = "Alphazhangsan/misc";

/** `POST /api/sessions` 依次返回的会话 id。 */
export const CREATED_IDS = ["d", "e", "f"].map((digit) => digit.repeat(32));

/**
 * 不带 `workspaceId` 的创建依次得到的临时空间 id（与 `CREATED_IDS` 逐位对应）：服务端为每次这样的创建
 * 新铸一个空间，它不在任何一次 `GET /api/workspaces` 的返回里。
 */
export const TEMP_WORKSPACE_IDS = ["4d", "4e", "4f"].map((pair) => pair.repeat(16));

export function workspaceList(...workspaces: WorkspaceView[]) {
  return jsonResponse({ workspaces });
}

export function createRejected() {
  return envelope(400, CREATE_REJECTED);
}

type WelcomeFixture = {
  /** 取代缺省的 `POST /api/sessions` 处理（挂起、拒绝）。 */
  create?: () => Promise<Response> | Response;
  /** 挂载时已在列表里的会话（排在首次发送建出的会话之后），各带一份空历史快照。 */
  existing?: readonly SessionView[];
  /** `/api/workspaces` 路由；缺省恒返回 项目A 与 客服。 */
  workspaces?: FetchRoutes[string];
};

/**
 * 欢迎态路由：`POST /api/sessions` 像服务端那样建会话并排到列表首位——请求体带 `workspaceId` 时绑定
 * 该空间（`temporaryWorkspace: false`），不带时用新铸的临时空间（`TEMP_WORKSPACE_IDS` 的下一个，
 * `temporaryWorkspace: true`）；`scene` 照写。REST 不再建出 `workspaceId` 为 null 的会话：存量未绑定行
 * 用 `existing: [view(...)]` 表达。各会话的历史为空快照，新会话的 prompt 挂起；临时空间的项目配置与
 * 命令目录为空。
 */
export function welcomeRoutes({
  create,
  existing = [],
  workspaces = () => workspaceList(PROJECT_A, SUPPORT),
}: WelcomeFixture = {}): FetchRoutes {
  const created: (Omit<SessionView, "scene"> & { scene: string | null })[] = [];
  const routes: FetchRoutes = {
    "/api/sessions": (_path, options) => {
      if (options?.method !== "POST") {
        return jsonResponse({ sessions: [...[...created].reverse(), ...existing] });
      }
      if (create) return create();
      const id = CREATED_IDS[created.length];
      const minted = TEMP_WORKSPACE_IDS[created.length];
      if (id === undefined || minted === undefined) throw new Error("夹具的会话 id 已用完");
      const input = JSON.parse(typeof options.body === "string" ? options.body : "{}") as {
        scene?: string;
        workspaceId?: string;
      };
      const temporaryWorkspace = input.workspaceId === undefined;
      const workspaceId = input.workspaceId ?? minted;
      const session = {
        ...view(id, null, { status: "idle", temporaryWorkspace, workspaceId }),
        scene: input.scene ?? null,
      };
      created.push(session);
      return jsonResponse(session, 201);
    },
    "/api/workspaces": workspaces,
  };
  const snapshotOf = (session: unknown) =>
    jsonResponse({ session, messages: [], streamCursor: { epoch: 1, seq: 0 }, todo: null });
  for (const session of existing) {
    routes[messagesPath(session.id)] = () => snapshotOf(session);
  }
  for (const id of CREATED_IDS) {
    routes[messagesPath(id)] = () => snapshotOf(created.find((session) => session.id === id));
    routes[sessionPromptPath(id)] = () => new Promise<Response>(() => {});
  }
  for (const id of TEMP_WORKSPACE_IDS) {
    routes[`/api/project-config?workspaceId=${id}`] = () => jsonResponse({ files: [] });
    routes[`/api/commands?workspaceId=${id}`] = () => jsonResponse({ commands: [] });
  }
  return routes;
}

export async function mountWelcome(fixture: WelcomeFixture = {}) {
  const mounted = renderChatPage("/", welcomeRoutes(fixture));
  await screen.findByRole("heading", { level: 1, name: HERO });
  return mounted;
}

export function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export function workspaceRequests(fetchMock: FetchMock) {
  return calls(fetchMock, "/api/workspaces").length;
}

/** 等到第 `count` 次工作空间读取已发出且其响应（若已就绪）已被页面消化。 */
export async function workspacesRead(fetchMock: FetchMock, count: number) {
  await waitFor(() => expect(workspaceRequests(fetchMock)).toBe(count));
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** 发往 `POST /api/sessions` 的创建请求，按调用顺序。 */
export function createRequests(fetchMock: FetchMock) {
  return calls(fetchMock, "/api/sessions")
    .filter(([, options]) => options?.method === "POST")
    .map(([, options]) => ({
      body: options?.body,
      contentType: new Headers(options?.headers).get("Content-Type"),
    }));
}

/** 一次创建请求的期望形状：请求体文本逐字节相等。 */
export function createOf(body: string) {
  return { body, contentType: "application/json" };
}

/** 发往 `POST /api/sessions/<id>/prompt` 的请求的 `[method, body]`，按调用顺序。 */
export function promptRequests(fetchMock: FetchMock, sessionId: string) {
  return calls(fetchMock, sessionPromptPath(sessionId)).map(([, options]) => [
    options?.method,
    options?.body,
  ]);
}

/** composer 的 `<form>`。 */
export function composerForm() {
  const form = composer().closest("form");
  if (!form) throw new Error("输入框不在表单内");
  return form;
}

/** 会话页的卡片结构：卡片与工具栏都存在（不对 `undefined` 做恒真比较），工具栏是卡片的最后一个子元素。 */
export function expectToolbarEndsCard() {
  const card = composer().closest('[data-slot="composer-card"]');
  if (!card) throw new Error("输入框不在输入卡内");
  const toolbar = card.querySelector('[data-slot="composer-toolbar"]');
  expect(toolbar).not.toBeNull();
  expect(card.lastElementChild).toBe(toolbar);
}

/** 从侧栏选中既有会话 `title`（id 为 `sessionId`），等欢迎态的胶囊与 footer 卸载。 */
export async function openExistingSession(nav: HTMLElement, title: string, sessionId: string) {
  fireEvent.click(within(nav).getByRole("button", { name: title }));
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${sessionId}`));
  await waitFor(() => expect(sceneGroup()).toBeNull());
  expect(queryFooterButton()).toBeNull();
}

export function sceneGroup() {
  return screen.queryByRole("group", { name: "场景" });
}

export function scenePills() {
  const group = screen.getByRole("group", { name: "场景" });
  return within(group).getAllByRole<HTMLButtonElement>("button");
}

/** 三个胶囊的 `aria-pressed`，按文档顺序。 */
export function pressedScenes() {
  return scenePills().map((pill) => pill.getAttribute("aria-pressed"));
}

export function selectScene(label: string) {
  const group = screen.getByRole("group", { name: "场景" });
  fireEvent.click(within(group).getByRole("button", { name: label }));
}

export function quickRow() {
  return screen.getByRole("group", { name: "快捷任务" });
}

export function quickLabels() {
  return within(quickRow())
    .getAllByRole("button")
    .map((chip) => chip.textContent);
}

/** footer 按钮；`name` 缺省匹配任意选择。 */
export function footerButton(name: RegExp | string = /^任务启动于 /) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

export function queryFooterButton() {
  return screen.queryByRole("button", { name: /^任务启动于/ });
}

export function pickerDialog() {
  return screen.queryByRole("dialog", { name: PICKER });
}

export async function openPicker() {
  fireEvent.click(footerButton());
  return screen.findByRole("dialog", { name: PICKER });
}

export function searchBox(dialog: HTMLElement) {
  return within(dialog).getByRole<HTMLInputElement>("textbox", { name: SEARCH });
}

export function search(dialog: HTMLElement, query: string) {
  fireEvent.change(searchBox(dialog), { target: { value: query } });
}

/** 弹层内各按钮的 `[完整文本, aria-pressed]`，按文档顺序。 */
export function options(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("button")
    .map((option) => [option.textContent, option.getAttribute("aria-pressed")]);
}

/** 点选弹层里完整文本为 `option` 的一项，等弹层关闭。 */
export async function choose(dialog: HTMLElement, option: string) {
  const target = within(dialog)
    .getAllByRole("button")
    .find((candidate) => candidate.textContent === option);
  if (!target) throw new Error(`弹层里没有 ${option}`);
  fireEvent.click(target);
  await waitFor(() => expect(pickerDialog()).toBeNull());
}

/** 打开弹层（等列表里出现该项）并点选它。 */
export async function pickOption(option: string) {
  const dialog = await openPicker();
  await waitFor(() => expect(options(dialog).map(([text]) => text)).toContain(option));
  await choose(dialog, option);
}

/** 经 URL（replace）回到欢迎态：`新建会话` 在「创建—发送」交接未完成时不导航。 */
export async function leaveForWelcome({ router }: ReturnType<typeof renderChatPage>) {
  await act(() => router.navigate("/", { replace: true }));
  await waitFor(() => expect(currentLocation()).toBe("/"));
}

/**
 * 欢迎态首次发送建会话成功后页面重读会话列表与工作空间列表（第 `read` 次工作空间读取），再回到欢迎态。
 * 夹具里新会话的 prompt 挂起，「创建—发送」交接未完成时 `新建会话` 不导航，所以经 URL 回去
 * （它不发请求）。返回时该次读取的响应可能仍挂起。
 */
export async function rereadBySend(mounted: ReturnType<typeof renderChatPage>, read: number) {
  typeDraft("你好");
  clickSend();
  await waitFor(() => expect(currentLocation()).toMatch(/^\/\?session=[def]{32}$/));
  await workspacesRead(mounted.fetchMock, read);
  await leaveForWelcome(mounted);
  await screen.findByRole("heading", { level: 1, name: HERO });
}
