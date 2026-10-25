// 输入框「能力」弹层各测试文件共用的夹具与查询（s1d-experts-skills 任务 10.2）：`chat-capability-popover.test.tsx`
// 与 `chat-capability-popover-welcome.test.tsx`。seam 同两者：整页挂载 + 假 API（`fetch`）。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { openMenu } from "./chat-expert-picker-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { COMPACT, labels, panel, project, skill, TODO, type } from "./chat-page-slash-support.js";
import { calls, type FetchMock, jsonResponse } from "./support.js";

export const SKILLS = "/api/skills";
const DIALOG = "能力";
export const LOADING = "正在读取技能…";
export const SESSION_FAILED = "技能读取失败，重新选中该会话可重试";
export const WELCOME_FAILED = "技能读取失败，关闭后重新打开可重试";
export const EMPTY = "暂无可用技能";
export const FOOTER = "改动从下一条消息起生效";
export const DEPLOY = skill("deploy", "部署");
export const WEEKLY = skill("weekly-report", "写周报");
/** `overrides` 为真的项目技能：与平台技能同名。 */
export const WEEKLY_OVER = project("weekly-report", "写周报", true);
export const LINT = project("lint", "检查");
/** 两条内建、平台技能 `deploy`、覆盖平台技能的项目技能 `weekly-report`。 */
export const CATALOG = [COMPACT, TODO, DEPLOY, WEEKLY_OVER];

export function capsBody(disabledSkills: readonly string[], expertId: string | null = null) {
  return jsonResponse({ expertId, disabledSkills, disabledConnectors: [] });
}

export function skillsBody(disabledSkills: readonly string[]) {
  return jsonResponse({ skills: [], disabledSkills });
}

export function capabilityButton() {
  return screen.getByRole<HTMLButtonElement>("button", { name: DIALOG });
}

/** 打开着的弹层（没有时为 null）。 */
export function skillsDialog() {
  return screen.queryByRole("dialog", { name: DIALOG });
}

export async function openSkills() {
  fireEvent.click(capabilityButton());
  const dialog = await screen.findByRole("dialog", { name: DIALOG });
  await quiesce();
  return dialog;
}

export async function closeSkills(dialog: HTMLElement) {
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(skillsDialog()).toBeNull());
}

/** 弹层的开关：`[accessible name, aria-checked, aria-disabled]`，按文档顺序。 */
export function switches(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("switch")
    .map((item) => [
      item.getAttribute("aria-label"),
      item.getAttribute("aria-checked"),
      item.getAttribute("aria-disabled"),
    ]);
}

export function switchOf(dialog: HTMLElement, name: string) {
  return within(dialog).getByRole<HTMLButtonElement>("switch", { name });
}

export function rows(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("listitem")
    .map((row) => row.textContent);
}

export function skillReads(fetchMock: FetchMock) {
  return calls(fetchMock, SKILLS).length;
}

/** 「+」菜单命令段各项的名称（`上传文件`、`选择专家…` 之后），按文档顺序；关菜单后返回。 */
export async function menuCommands() {
  const menu = await openMenu();
  const items = within(menu)
    .getAllByRole("menuitem")
    .slice(2)
    .map((item) => item.querySelector("span")?.textContent);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  return items;
}

/** 输入 `/` 时斜杠候选的名称；之后清空草稿。 */
export async function slashLabels() {
  await type("/");
  const shown = panel() === null ? [] : labels();
  await type("");
  return shown;
}
