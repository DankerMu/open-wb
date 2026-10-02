// 斜杠命令候选（issue 556）测试的夹具与页面查询：命令目录、`/api/commands` 路由、欢迎态与已选会话的
// 挂载、候选面板的读取、按键与 `scrollIntoView` 记录桩。页面搭法来自 chat-page-support.tsx、
// chat-page-ownership-support.ts 与 chat-page-search-support.tsx（不改它们）。供
// api-commands.test.ts、slash-menu-state.test.ts 与 chat-page-slash.test.tsx 使用。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { Composer } from "../src/features/chat/composer.js";
import type { Command } from "../src/lib/api-commands.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { renderChatPageWithAuthProbe, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer, SESSION_MESSAGES, SESSION_PROMPT } from "./chat-page-ownership-support.js";
import { answered, asked, conversation, SESSION_PATH } from "./chat-page-search-support.js";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { calls, type FetchMock, jsonResponse, paths } from "./support.js";

export const COMMANDS = "/api/commands";
export const PANEL = "命令候选";

/** The two builtins as the server lists them (server/src/sessions/slash-commands.ts). */
export const COMPACT: Command = {
  name: "compact",
  label: "整理上下文",
  description: "压缩较长对话的上下文，保留要点",
  hint: "可选：想保留的重点",
  source: "builtin",
};
export const TODO: Command = {
  name: "todo",
  label: "任务清单",
  description: "查看或修改助手的任务清单",
  hint: "可选：append <任务>",
  source: "builtin",
};

/** A platform skill as the server lists it: the name is the label behind `skill:`. */
export function skill(
  label: string,
  description: string,
  hint: string | null = "可选参数",
): Command {
  return { name: `skill:${label}`, label, description, hint, source: "skill" };
}

export const WEEKLY = skill("weekly-report", "写周报");
/** The catalogue of the spec scenario 斜杠命令候选: the two builtins, then `skill:weekly-report`. */
export const CATALOGUE = [COMPACT, TODO, WEEKLY];
export const LABELS = ["整理上下文", "任务清单", "weekly-report"];

/** A `/api/commands` route that always answers 200 with `commands`. */
export function catalogue(commands: readonly Command[] = CATALOGUE): FetchRoutes[string] {
  return () => jsonResponse({ commands });
}

/**
 * A `/api/commands` route whose answer never arrives and that fails once its request is aborted,
 * as `fetch` does.
 */
export function untilAborted(_path: string, options?: RequestInit) {
  return new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });
}

/** `[element, argument]` of every `scrollIntoView` call of the current case, in order. */
export const scrolls: Array<[Element, unknown]> = [];

/**
 * Registers the hooks of every 斜杠命令候选 case: `scrollIntoView` (a no-op from radix-platform)
 * is replaced by a recorder; afterwards the page, the stubbed globals and the mocks are put back.
 */
export function slashMenuFixture() {
  beforeEach(() => {
    scrolls.length = 0;
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function record(
      this: Element,
      options,
    ) {
      scrolls.push([this, options]);
    });
  });
  afterEach(cleanupSessionMeta);
}

/** Routes of an account without sessions; `commands` answers `/api/commands`. */
export function welcomeRoutes(commands: FetchRoutes[string]): FetchRoutes {
  return { "/api/sessions": () => jsonResponse({ sessions: [] }), [COMMANDS]: commands };
}

/** Waits for the composer of a page that was just mounted and lets its first reads finish. */
export async function composerReady() {
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
}

/** Opens the welcome state inside the real shell; `commands` answers `/api/commands`. */
export async function openWelcome(commands = catalogue(), strict = false) {
  const page = renderChatPage("/", welcomeRoutes(commands), strict);
  await composerReady();
  return page;
}

/** A finished session of one question and one answer. */
function finishedConversation() {
  return conversation([asked(-3, "你好"), answered(0, "回答")]);
}

/**
 * Opens a finished session inside the real shell and waits until its composer is unlocked;
 * `extra` adds or overrides routes.
 */
export async function openSession(commands = catalogue(), extra: FetchRoutes = {}) {
  const snapshot = finishedConversation();
  const page = renderChatPage(SESSION_PATH, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [SESSION_MESSAGES]: () => jsonResponse(snapshot),
    [COMMANDS]: commands,
    ...extra,
  });
  await composerReady();
  return page;
}

/** Types `text` into the composer and lets a catalogue request it starts finish. */
export async function type(text: string) {
  typeDraft(text);
  await quiesce();
}

/** The candidate panel, null while it is hidden. */
export function panel() {
  return screen.queryByRole("listbox", { name: PANEL });
}

function shownPanel() {
  const listbox = panel();
  if (!listbox) throw new Error("候选面板未显示");
  return listbox;
}

/** The option elements of the shown panel, in document order. */
export function options() {
  return within(shownPanel()).getAllByRole("option");
}

function labelOf(option: Element) {
  return option.querySelector(".chat-slash-label")?.textContent;
}

/** The label of every option, in document order. */
export function labels() {
  return options().map(labelOf);
}

/** `aria-selected` of every option, in document order. */
export function selection() {
  return options().map((option) => option.getAttribute("aria-selected"));
}

/**
 * The label of the highlighted option. Fails unless exactly one option carries
 * `aria-selected="true"`, the listbox names it in `aria-activedescendant` and it alone has the
 * highlight class.
 */
export function highlighted() {
  const all = options();
  const selected = all.filter((option) => option.getAttribute("aria-selected") === "true");
  expect(selected).toHaveLength(1);
  const [option] = selected as [HTMLElement];
  expect(option.id).not.toBe("");
  expect(shownPanel().getAttribute("aria-activedescendant")).toBe(option.id);
  expect(all.filter((item) => item.classList.contains("chat-slash-option--active"))).toEqual([
    option,
  ]);
  return labelOf(option);
}

/** The option whose label is `label`. */
export function optionOf(label: string) {
  const option = options().find((item) => labelOf(item) === label);
  if (!option) throw new Error(`没有候选 ${label}`);
  return option;
}

/** A keydown on the composer; false when its default action was prevented. */
export function press(key: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
  return fireEvent.keyDown(composer(), { key, ...init });
}

/** The `/api/commands` requests so far, in call order. */
export function commandCalls(fetchMock: FetchMock) {
  return calls(fetchMock, COMMANDS);
}

/** Asserts that no request of any kind (createSession, prompt, catalogue) followed `requests`. */
export async function expectNothingSent(fetchMock: FetchMock, requests: readonly string[]) {
  await quiesce();
  expect(paths(fetchMock)).toEqual(requests);
}

/** The children of the composer card as `tag.class` (the tag alone without a class). */
export function cardChildren() {
  const card = composer().closest(".chat-composer-card");
  if (!card) throw new Error("expected the composer inside .chat-composer-card");
  return Array.from(card.children, (child) => {
    const tag = child.tagName.toLowerCase();
    return child.classList.length === 0 ? tag : `${tag}.${child.classList[0]}`;
  });
}

/** Opens the welcome state with the three-command catalogue loaded and the panel on `draft`. */
export async function welcomePanel(draft = "/") {
  const page = await openWelcome();
  await type(draft);
  return page;
}

/** Asserts the full panel of the spec scenario: three options, the first one highlighted. */
export function expectThreeCandidates() {
  const listbox = screen.getByRole("listbox", { name: PANEL });
  const all = options();
  expect(labels()).toEqual(["整理上下文", "任务清单", "weekly-report"]);
  expect(all).toHaveLength(3);
  expect(selection()).toEqual(["true", "false", "false"]);
  expect(all[0]?.id).toBeTruthy();
  expect(listbox.getAttribute("aria-activedescendant")).toBe(all[0]?.id);
  expect(new Set(all.map((option) => option.id)).size).toBe(3);
  expect([listbox, ...all].map((element) => element.getAttribute("tabindex"))).toEqual([
    "-1",
    "-1",
    "-1",
    "-1",
  ]);
  expect(all.map((option) => option.querySelector(".chat-slash-desc")?.textContent)).toEqual([
    "压缩较长对话的上下文，保留要点",
    "查看或修改助手的任务清单",
    "写周报",
  ]);
  expect(all.map((option) => option.querySelector(".chat-slash-hint")?.textContent)).toEqual([
    "可选：想保留的重点",
    "可选：append <任务>",
    "可选参数",
  ]);
  expect(all.map((option) => option.textContent)).toEqual([
    "整理上下文压缩较长对话的上下文，保留要点可选：想保留的重点",
    "任务清单查看或修改助手的任务清单可选：append <任务>",
    "weekly-report写周报可选参数",
  ]);
  expect(highlighted()).toBe("整理上下文");
  expect(composer().closest(".chat-composer-card")?.firstElementChild).toBe(listbox);
}

/** A finished session whose next prompt is accepted and answered; `sent` is that prompt. */
export async function openAnswering(sent: string) {
  let snapshot = finishedConversation();
  const after = conversation([...snapshot.messages, asked(1, sent), answered(2, "好的")]);
  const page = await openSession(catalogue(), {
    [SESSION_MESSAGES]: () => jsonResponse(snapshot),
    [SESSION_PROMPT]: () => {
      snapshot = after;
      return jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202);
    },
  });
  await type("/");
  expect(labels()).toEqual(LABELS);
  return page;
}

/** The JSON bodies of the prompts sent so far, once the requests under way have finished. */
export async function sentPrompts(fetchMock: FetchMock) {
  await quiesce();
  return calls(fetchMock, SESSION_PROMPT).map(([, options]) => JSON.parse(String(options?.body)));
}

/** The props of a bare enabled composer holding `draft`; `onSubmit` only prevents the navigation. */
export function composerProps(draft: string): ComponentProps<typeof Composer> {
  return {
    disabled: false,
    draft,
    generating: false,
    onChangeDraft: () => undefined,
    onStop: async () => null,
    onSubmit: (event) => event.preventDefault(),
    placeholder: "",
    sendDisabled: false,
    stopSessionId: null,
  };
}

/** The welcome state beside an auth probe, for `renewAccount`; `commands` answers `/api/commands`. */
export async function openProbed(commands: FetchRoutes[string]) {
  const page = renderChatPageWithAuthProbe("/", welcomeRoutes(commands));
  await composerReady();
  return page;
}
