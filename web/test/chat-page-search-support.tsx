// 对话内搜索（issue 538）测试的夹具与页面查询：会话快照、顶栏按钮与搜索框的读取、快照重载、
// 转录区的滚动度量与 `scrollIntoView` 记录桩、直接挂载的 FollowTranscript。页面搭法来自
// chat-page-support.tsx 与 chat-page-ownership-support.ts（不改它们）。供 search-match.test.ts 与
// chat-page-search*.test.tsx 使用。
import "./radix-platform.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { FollowTranscript, type TranscriptHandle } from "../src/features/chat/scroll-follow.js";
import {
  assistantMessage,
  type Message,
  quiesce,
  type Snapshot,
} from "./chat-page-file-changes-support.js";
import {
  OTHER_MESSAGES,
  otherIdleSession,
  otherSnapshot,
  SESSION_MESSAGES,
} from "./chat-page-ownership-support.js";
import { cleanupSessionMeta } from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, historyUser, latestSource, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

export const SEARCH = "对话内搜索";
export const SEARCH_INPUT = "搜索对话内容";
export const SESSION_PATH = `/?session=${SESSION_ID}`;
/** The only argument the page may hand to `scrollIntoView`. */
export const CENTER = { block: "center" };
/** Banner buttons of a selected session, in DOM order. */
export const TOPBAR_BUTTONS = ["重命名", SEARCH, "产物面板"];

export const asked = (id: number, content: string): Message => ({
  ...historyUser,
  id,
  content,
  createdAt: id,
});

export const answered = (id: number, content: string, fields: Partial<Message> = {}): Message =>
  assistantMessage("done", { id, content, createdAt: id, ...fields });

/** A session titled `saved title` holding `messages`, with the stream cursor at `1:3`. */
export function conversation(messages: Message[], status: "done" | "running" = "done"): Snapshot {
  return {
    session: chatSnapshot({ status }).session,
    messages,
    streamCursor: { epoch: 1, seq: 3 },
  };
}

/**
 * The conversation of the spec scenario 计数为匹配消息数: `Report` in the first question, `report`
 * twice in the Markdown source of the answer, once more in the output of its step, and a second
 * question without it.
 */
export function reportConversation(): Snapshot {
  const step = {
    id: 11,
    ordinal: 0,
    name: "bash",
    detail: "ls out",
    output: "report.pdf",
    changes: null,
    status: "done" as const,
  };
  return conversation([
    asked(-3, "帮我做 Report"),
    answered(0, "**report** 已生成，report 共 3 页", { steps: [step] }),
    asked(1, "谢谢"),
  ]);
}

/** Four messages; `周报` is in the first, the second and the fourth (ids -3, 0 and 2). */
export function weeklyConversation(): Snapshot {
  return conversation([
    asked(-3, "周报怎么写"),
    answered(0, "**周报**分三段"),
    asked(1, "好的，谢谢"),
    answered(2, "附上周报模板"),
  ]);
}

/** A running turn: `question` (id -3) and the streaming answer (id 0) that starts as `content`. */
export function runningConversation(question: string, content: string): Snapshot {
  return conversation([asked(-3, question), assistantMessage("running", { content })], "running");
}

/** `[data-message-id, argument]` of every `scrollIntoView` call of the current case, in order. */
export const jumps: Array<[string | null, unknown]> = [];

/* jsdom has no layout. The three scroll metrics of every `.chat-transcript` read from `geometry`
   once `installGeometry()` ran; a write (the page only writes `scrollTop`) is clamped to the
   scrollable range as a browser does. */
export const geometry = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
const METRICS = ["scrollHeight", "clientHeight", "scrollTop"] as const;

/**
 * Where the stubbed `scrollIntoView` leaves the transcript; `null` leaves it where it is. The stub
 * moves `geometry.scrollTop` only: no scroll event is dispatched, as a browser dispatches it a frame
 * later.
 */
export const landing: { scrollTop: number | null } = { scrollTop: null };

const inTranscript = (element: Element) => element.matches(".chat-transcript");

export function installGeometry() {
  Object.assign(geometry, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
  for (const name of METRICS) {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get(this: HTMLElement) {
        return inTranscript(this) ? geometry[name] : native?.get?.call(this);
      },
      set(this: HTMLElement, value: number) {
        if (!inTranscript(this)) native?.set?.call(this, value);
        else geometry[name] = Math.min(Math.max(value, 0), bottom());
      },
    });
  }
}

/** The `scrollTop` of a transcript scrolled to its end. */
export function bottom() {
  return Math.max(geometry.scrollHeight - geometry.clientHeight, 0);
}

/**
 * Registers the hooks of every 对话内搜索 case: `scrollIntoView` (a no-op from radix-platform) is
 * replaced by a recorder that lands on `landing.scrollTop`; afterwards the page, the viewport
 * query, the mocks and the scroll metrics are put back.
 */
export function conversationSearchFixture() {
  beforeEach(() => {
    jumps.length = 0;
    landing.scrollTop = null;
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function record(
      this: Element,
      options,
    ) {
      jumps.push([this.getAttribute("data-message-id"), options]);
      if (landing.scrollTop !== null) geometry.scrollTop = landing.scrollTop;
    });
  });
  afterEach(async () => {
    await cleanupSessionMeta();
    for (const name of METRICS) Reflect.deleteProperty(HTMLElement.prototype, name);
  });
}

/** Routes of a page listing `snapshot`'s session and `other session`; `history` answers its reads. */
function conversationRoutes(snapshot: Snapshot, history: FetchRoutes[string]): FetchRoutes {
  return {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session, otherIdleSession()] }),
    [SESSION_MESSAGES]: history,
    [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
  };
}

/** Mounts the shell on `snapshot`'s session while `history` answers the reads of its messages. */
export function mountConversation(snapshot: Snapshot, history: FetchRoutes[string]) {
  return renderChatPage(SESSION_PATH, conversationRoutes(snapshot, history));
}

/**
 * Opens `snapshot`'s session inside the real shell and waits for its transcript. `reload(next)`
 * makes the live connection read `next` as a fresh snapshot (a `replay.gap` frame) and waits until
 * the page installed it.
 */
export async function openConversation(snapshot: Snapshot) {
  let current = snapshot;
  const page = mountConversation(snapshot, () => jsonResponse(current));
  await waitFor(() => expect(messageIds()).toHaveLength(snapshot.messages.length));
  await quiesce();
  const reload = async (next: Snapshot) => {
    current = next;
    const reads = page.fetchMock.mock.calls.length;
    act(() => latestSource().emitGap());
    await waitFor(() => expect(page.fetchMock.mock.calls).toHaveLength(reads + 1));
    await quiesce();
  };
  return { ...page, reload };
}

export function banner() {
  return screen.getByRole("banner");
}

/** `aria-label` of every button in the banner, in document order. */
export function bannerButtons() {
  return within(banner())
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
}

export function searchButton() {
  return within(banner()).getByRole<HTMLButtonElement>("button", { name: SEARCH });
}

/** The search box, null while it is closed. */
export function searchBox() {
  return screen.queryByRole("search", { name: SEARCH });
}

function openBox() {
  const box = searchBox();
  if (!box) throw new Error("搜索框未打开");
  return box;
}

export function searchInput() {
  return within(openBox()).getByRole<HTMLInputElement>("searchbox", { name: SEARCH_INPUT });
}

/** The counter element of the open search box. */
export function counter() {
  const live = openBox().querySelector<HTMLElement>("[aria-live]");
  if (!live) throw new Error("搜索框没有计数器");
  return live;
}

/** The counter text `i/n`. */
export function count() {
  return counter().textContent;
}

export function boxButton(name: string) {
  return within(openBox()).getByRole<HTMLButtonElement>("button", { name });
}

/** Clicks the banner button without focusing it first, as a mouse click in Safari. */
export function toggleSearch() {
  fireEvent.click(searchButton());
}

export function typeQuery(query: string) {
  fireEvent.change(searchInput(), { target: { value: query } });
}

/** A keydown on the search input; false when the page prevented its default action. */
export function press(key: string, init: KeyboardEventInit & { keyCode?: number } = {}) {
  return fireEvent.keyDown(searchInput(), { key, ...init });
}

/** `data-message-id` of every message article, in document order. */
export function messageIds() {
  return Array.from(document.querySelectorAll("article"), (article) =>
    article.getAttribute("data-message-id"),
  );
}

/**
 * `data-message-id` of the highlighted messages. Scoped to `article`: the sidebar button of the
 * selected session carries `aria-current` too. `aria-current` is the highlight's only observable.
 */
export function highlighted() {
  const current = [...document.querySelectorAll("article[aria-current]")];
  expect(current.map((article) => article.getAttribute("aria-current"))).toEqual(
    current.map(() => "true"),
  );
  return current.map((article) => article.getAttribute("data-message-id"));
}

/** Asserts the page shows no search box and no highlight, and the banner button is collapsed. */
export function expectSearchClosed() {
  expect(searchBox()).toBeNull();
  expect(highlighted()).toEqual([]);
  expect(searchButton().getAttribute("aria-expanded")).toBe("false");
}

export function jumpButton() {
  return screen.queryByRole("button", { name: "回到最新" });
}

/** Text of every toast on the page. */
export function toasts() {
  return Array.from(document.querySelectorAll(".ui-toast-message"), (node) => node.textContent);
}

/**
 * A bare FollowTranscript holding the messages 1 and 2, beside an element outside it that carries
 * the id 7. `jump(id)` calls `scrollToMessage(id)` on the handle the transcript filled.
 */
export function renderTranscript() {
  const handle = createRef<TranscriptHandle>();
  render(
    <div>
      <FollowTranscript content={null} handleRef={handle}>
        <section>
          <article data-message-id="1">一</article>
          <article data-message-id="2">二</article>
        </section>
      </FollowTranscript>
      <article data-message-id="7">转录区之外</article>
    </div>,
  );
  return (id: number) => {
    const transcript = handle.current;
    if (!transcript) throw new Error("FollowTranscript 没有填充 handleRef");
    act(() => transcript.scrollToMessage(id));
  };
}
