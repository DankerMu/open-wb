// 输入框知识库引用的整页用例共用的夹具与查询（message-attachments「输入框知识库引用」「用户气泡中的知识库引用」，
// s2c-kb-session 任务 8.2、8.3）。seam：整页挂载 + 假 API（`fetch`）；知识库状态缺省关闭（`centerRoutes()`），
// 开启的世界用 `kbRoutes()` 覆盖它。查询一律按可访问名（#1976 ui-walk 用同一组名字）。
import "./radix-platform.js";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { BaseView } from "../src/lib/api.js";
import { base, READY } from "./center-kb-support.js";
import { openMenu } from "./chat-attachments-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { sessionPromptPath } from "./chat-page-lifecycle-support.js";
import { composer, promptAccepted } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  findList,
  messagesPath,
  mountSessions,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import type { FetchRoutes } from "./chat-page-support.js";
import { historyUser } from "./chat-stream-support.js";
import { calls, type FetchMock, jsonResponse } from "./support.js";

export const ITEM = "引用知识库…";
export const DIALOG = "引用知识库";
export const TAGS = "引用的知识库";

export const PRODUCT = base("kb-product", { name: "产品文档" });
export const SUPPORT_QA = base("kb-support", { name: "客服问答", state: "rebuilding" });
export const SA = view(A, "会话甲");
export const SB = view(B, "会话乙");

/** 知识库开启（`READY` 六键），`GET /api/kb/bases` 依次回 `bases`（缺省两库：`产品文档` ready、`客服问答` rebuilding）。 */
export function kbRoutes(bases: readonly BaseView[] = [PRODUCT, SUPPORT_QA]): FetchRoutes {
  return {
    "/api/kb/status": () => jsonResponse(READY),
    "/api/kb/bases": () => jsonResponse({ bases }),
  };
}

type Ref = { id: string; name: string };

/** 一条用户消息 `content`（引用 `refs`，快照里每项恰为 `{id, name}`）与一条已完成的回答；`id` 从 `first` 起。 */
export function exchange(content: string, refs: readonly Ref[], first = 1) {
  return [
    {
      ...historyUser,
      id: first,
      content,
      knowledgeBases: refs.map(({ id, name }) => ({ id, name })),
    },
    {
      ...historyUser,
      id: first + 1,
      role: "assistant" as const,
      undo: null,
      content: "好的",
      createdAt: 0,
    },
  ];
}

/**
 * `session` 的 prompt 与历史：prompt 按 `outcomes` 依次应答，用完后受理；受理后的历史是 `accepted`（缺省是一条
 * 引用 `产品文档` 的 `查一下`），此前是空历史。
 */
export function turn(
  session: SessionView,
  outcomes: (() => Response)[] = [],
  accepted = exchange("查一下", [PRODUCT]),
): FetchRoutes {
  let done = false;
  return {
    [sessionPromptPath(session.id)]: () => {
      const outcome = outcomes.shift();
      if (outcome) return outcome();
      done = true;
      return jsonResponse(promptAccepted, 202);
    },
    [messagesPath(session.id)]: () =>
      jsonResponse({
        session,
        messages: done ? accepted : [],
        streamCursor: { epoch: 1, seq: 0 },
        todo: null,
      }),
  };
}

/** 选中 `会话甲`（列表里另有 `会话乙`），知识库开启；等输入框就绪与首轮读取完成。 */
export async function mountSelected(extra: FetchRoutes = {}) {
  const mounted = mountSessions(`/?session=${A}`, [SA, SB], {
    ...kbRoutes(),
    ...turn(SA),
    ...extra,
  });
  const nav = await findList("会话甲");
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
  return { ...mounted, nav };
}

export function menuItem(menu: HTMLElement) {
  return within(menu).queryByRole("menuitem", { name: ITEM });
}

/** 「+」菜单 → `引用知识库…`，返回打开的选择列表（本次的读取尚未应答时也立即返回）。 */
export async function openPicker() {
  const item = menuItem(await openMenu());
  if (!item) throw new Error("「+」菜单里没有 `引用知识库…`");
  fireEvent.click(item);
  const dialog = await screen.findByRole("dialog", { name: DIALOG });
  await quiesce();
  return dialog;
}

/** 选择列表里的各项：完整文本、是否已选、是否禁用，按文档顺序。 */
export function options(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole<HTMLButtonElement>("button")
    .filter((button) => button.hasAttribute("aria-pressed"))
    .map((button) => ({
      text: button.textContent,
      pressed: button.getAttribute("aria-pressed") === "true",
      disabled: button.disabled,
    }));
}

/** 点选择列表里完整文本以 `name` 开头的一项（不关闭列表）。 */
export function toggle(dialog: HTMLElement, name: string) {
  const target = within(dialog)
    .getAllByRole("button")
    .find((button) => button.hasAttribute("aria-pressed") && button.textContent?.startsWith(name));
  if (!target) throw new Error(`选择列表里没有 ${name}`);
  fireEvent.click(target);
}

export async function closePicker(dialog: HTMLElement) {
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull());
}

/** 打开选择列表、依次点选 `names`、关闭。 */
export async function refer(...names: string[]) {
  const dialog = await openPicker();
  for (const name of names) toggle(dialog, name);
  await closePicker(dialog);
}

/** 输入框里的引用标签区（气泡里有同名列表，所以只在输入框表单内找）；没有时为 null。 */
export function tagArea() {
  const form = document.querySelector<HTMLElement>('form[data-slot="composer"]');
  return form === null ? null : within(form).queryByRole("list", { name: TAGS });
}

/** 引用标签的库名，按文档顺序；没有标签区时为空数组。 */
export function tagNames() {
  const list = tagArea();
  return list === null
    ? []
    : within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent);
}

export function removeTag(name: string) {
  const list = tagArea();
  if (!list) throw new Error("输入框没有引用标签区");
  fireEvent.click(within(list).getByRole("button", { name: `移除 ${name}` }));
}

/** 发往 `sessionId` 的 prompt 的请求体，按调用顺序（解析后逐键比较）。 */
export function promptBodies(fetchMock: FetchMock, sessionId: string) {
  return calls(fetchMock, sessionPromptPath(sessionId)).map(([, init]) =>
    JSON.parse(String(init?.body)),
  );
}

export function baseReads(fetchMock: FetchMock) {
  return calls(fetchMock, "/api/kb/bases").length;
}
