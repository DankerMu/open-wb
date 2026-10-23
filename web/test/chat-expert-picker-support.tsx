// 输入框专家选择各测试文件共用的夹具与查询（s1d-experts-skills 任务 9.2）：`chat-expert-picker.test.tsx` 与
// `chat-expert-picker-timing.test.tsx`。seam 同两者：整页挂载 + 假 API（`fetch`）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { ExpertView } from "../src/lib/api.js";
import { ANALYST, DESIGNER, FRONTEND, OWN, TESTER } from "./center-experts-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { composer } from "./chat-page-ownership-support.js";
import { A, B, findList, mountSessions, view } from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue } from "./chat-page-slash-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { HERO, openExistingSession, welcomeRoutes } from "./chat-page-welcome-scene-support.js";
import { calls, type FetchMock, jsonResponse } from "./support.js";

export const EXPERTS = "/api/experts";
const OPTIONS = "/api/composer/options";
export const PICK = "选择专家…";
export const NONE = "不使用专家";
const REMOVE = "移除专家";
export const LOADING = "正在读取专家…";
export const FAILED = "专家读取失败，关闭后重新打开可重试";
export const NO_MATCH = "没有匹配的专家";
export const COMMAND_TEXTS = [
  "整理上下文压缩较长对话的上下文，保留要点",
  "任务清单查看或修改助手的任务清单",
  "weekly-report写周报",
];
/** 服务端次序：内置在前（固定次序），自建在后。 */
const LIST = [FRONTEND, ANALYST, DESIGNER, TESTER, OWN];
export const SA = view(A, "会话甲");
export const SB = view(B, "会话乙");

export function capsPath(id: string) {
  return `/api/sessions/${id}/capabilities`;
}

export function caps(expertId: string | null) {
  return jsonResponse({ expertId, disabledSkills: [] });
}

export function experts(list: readonly ExpertView[] = LIST) {
  return jsonResponse({ experts: list });
}

/** 一项的完整文本：名称、`内置` / `自建`、描述。 */
export function item(expert: ExpertView) {
  return `${expert.name}${expert.builtin ? "内置" : "自建"}${expert.description}`;
}

export function expertCalls(fetchMock: FetchMock) {
  return calls(fetchMock, EXPERTS).length;
}

export function optionCalls(fetchMock: FetchMock) {
  return calls(fetchMock, OPTIONS).length;
}

/** 发往 `…/capabilities` 的 GET 路径，按调用顺序（PUT 不算）。 */
export function capsReads(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([path, init]) => path.endsWith("/capabilities") && (init?.method ?? "GET") === "GET")
    .map(([path]) => path);
}

/** 发往 `…/capabilities` 的 PUT：`[路径, body]`，按调用顺序。 */
export function capsWrites(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([path, init]) => path.endsWith("/capabilities") && init?.method === "PUT")
    .map(([path, init]) => [path, init?.body]);
}

export function plusButton() {
  return screen.getByRole<HTMLButtonElement>("button", { hidden: true, name: "添加文件或命令" });
}

export async function openMenu() {
  fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  await quiesce();
  return menu;
}

export function pickItem(menu: HTMLElement) {
  return within(menu).getByRole("menuitem", { name: PICK });
}

/** 「+」菜单 → `选择专家…`，返回打开的专家对话框。 */
export async function openExperts() {
  fireEvent.click(pickItem(await openMenu()));
  return screen.findByRole("dialog", { name: "选择专家" });
}

export function dialogGone() {
  return waitFor(() => expect(screen.queryByRole("dialog", { name: "选择专家" })).toBeNull());
}

/** 对话框里的分组：`[分类, 各项完整文本]`，按文档顺序。 */
export function groups(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("group")
    .map((group) => [
      group.querySelector("legend")?.textContent,
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ]);
}

/** 对话框里的全部选项（含 `不使用专家`）的完整文本，按文档顺序。 */
export function choices(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("button")
    .filter((button) => button.textContent !== "关闭")
    .map((button) => button.textContent);
}

/** 点对话框里完整文本以 `text` 开头的一项，等对话框关闭。 */
export async function choose(dialog: HTMLElement, text: string) {
  const target = within(dialog)
    .getAllByRole("button")
    .find((button) => button.textContent?.startsWith(text));
  if (!target) throw new Error(`对话框里没有 ${text}`);
  fireEvent.click(target);
  await dialogGone();
}

export function search(dialog: HTMLElement, query: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "搜索专家" }), {
    target: { value: query },
  });
}

/** 能力行的专家标签（没有时为 null）。 */
export function label() {
  return document.querySelector<HTMLElement>('form [data-slot="composer-expert"]');
}

/** 标签的可见文字（没有标签时为 null）。 */
export function labelText() {
  const found = label();
  return found === null ? null : found.textContent;
}

export function removeButton() {
  const found = label();
  if (!found) throw new Error("能力行没有专家标签");
  return within(found).getByRole<HTMLButtonElement>("button", { name: REMOVE });
}

export function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

/** 欢迎态挂载（没有会话），专家清单缺省为 `LIST`；等输入框就绪与首轮读取完成。 */
export async function mountWelcome(extra: FetchRoutes = {}) {
  const mounted = renderChatPage("/", {
    ...welcomeRoutes({ existing: [SA] }),
    [EXPERTS]: () => experts(),
    [COMMANDS]: catalogue(),
    ...extra,
  });
  await screen.findByRole("heading", { level: 1, name: HERO });
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
  return mounted;
}

/** 选中会话 `id`（`SA`、`SB` 都在列表里），专家清单缺省为 `LIST`。 */
export async function mountSelected(id: string, extra: FetchRoutes = {}) {
  const mounted = mountSessions(`/?session=${id}`, [SA, SB], {
    [EXPERTS]: () => experts(),
    [COMMANDS]: catalogue(),
    ...extra,
  });
  const nav = await findList("会话甲");
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
  return { ...mounted, nav };
}

export async function select(nav: HTMLElement, title: string, id: string) {
  await openExistingSession(nav, title, id);
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
}
