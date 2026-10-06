/**
 * Issue 538 对话内搜索 (parent tasks 7.7): S1–S7, S12–S16 and S18–S20 of
 * openspec/changes/conversation-search/design.md and its review (S8–S11 and S17 are in
 * chat-page-search-follow.test.tsx). Seams: the jsdom chat page inside the real shell over a
 * stubbed `fetch` and the fake event source, the router, a recorded `scrollIntoView` (jsdom lacks
 * it), the pure `chatTopbar`, and the class tokens of the rendered box. Expected values are
 * literals from the spec deltas.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chatTopbar } from "../src/features/chat/topbar-actions.js";
import { artifactsPanelFixture, openProbedSession } from "./chat-page-artifacts-panel-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { renewAccount, settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import { composer, envelope, SESSION_PROMPT } from "./chat-page-ownership-support.js";
import {
  banner,
  bannerButtons,
  boxButton,
  CENTER,
  conversationSearchFixture,
  count,
  counter,
  expectSearchClosed,
  highlighted,
  jumps,
  messageIds,
  mountConversation,
  openConversation,
  press,
  reportConversation,
  SEARCH,
  SEARCH_INPUT,
  SESSION_PATH,
  searchBox,
  searchButton,
  searchInput,
  TOPBAR_BUTTONS,
  toasts,
  toggleSearch,
  typeQuery,
  weeklyConversation,
} from "./chat-page-search-support.js";
import {
  crumb,
  focusOn,
  installNarrowViewport,
  openTopbarRename,
  renameDialog,
} from "./chat-page-session-meta-support.js";
import { FakeEventSource } from "./chat-stream-support.js";
import { hasLucideGlyph } from "./files-fixture.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";

const WEEKLY = "周报";
const WEEKLY_IDS = ["-3", "0", "1", "2"];
const PREVIOUS = "上一个";
const NEXT = "下一个";
const CLOSE = "关闭";
const WELCOME = "WorkBuddy，我帮你";
const DRAFT = "还没发出去的草稿";

conversationSearchFixture();

/** Opens the four-message conversation and its search box. */
async function searchWeekly() {
  const page = await openConversation(weeklyConversation());
  toggleSearch();
  return page;
}

function pageColumn() {
  const column = document.querySelector('[data-slot="chat-column"]');
  if (!column) throw new Error("expected the chat column");
  return column;
}

/** Asserts a freshly opened search box: empty focused input, `0/0`, nothing highlighted. */
function expectFreshSearch() {
  expect(searchInput().value).toBe("");
  expect(document.activeElement).toBe(searchInput());
  expect(count()).toBe("0/0");
  expect(highlighted()).toEqual([]);
}

describe("搜索框 (S1, S2)", () => {
  it("S1 the banner button opens the search box as the first child of the page column and focuses its input", async () => {
    await openConversation(weeklyConversation());
    const button = searchButton();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(searchBox()).toBeNull();

    toggleSearch();

    const box = screen.getByRole("search", { name: SEARCH });
    expect(screen.getByRole("main").contains(box)).toBe(true);
    expect(banner().contains(box)).toBe(false);
    expect(pageColumn().firstElementChild).toBe(box);
    const input = searchInput();
    expect(document.activeElement).toBe(input);
    expect(input.type).toBe("search");
    expect(input.placeholder).toBe(SEARCH_INPUT);
    expect(input.value).toBe("");

    const buttons = [PREVIOUS, NEXT, CLOSE].map(boxButton);
    const [field, ...rest] = box.children;
    expect(field?.contains(input)).toBe(true);
    expect(rest).toEqual([counter(), ...buttons]);
    expect(buttons.map((item) => item.title)).toEqual([PREVIOUS, NEXT, CLOSE]);
    const glyphs = ["chevron-up", "chevron-down", "x"];
    expect(buttons.map((item) => glyphs.filter((glyph) => hasLucideGlyph(item, glyph)))).toEqual([
      ["chevron-up"],
      ["chevron-down"],
      ["x"],
    ]);
    expect(buttons.map((item) => item.disabled)).toEqual([true, true, false]);

    expect(count()).toBe("0/0");
    expect(counter().getAttribute("aria-live")).toBe("polite");
    // One text node: a non-atomic live region announces only the node that changed.
    expect(counter().childNodes).toHaveLength(1);
    expect(searchButton()).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("S2 counts matching messages, not occurrences or step outputs, and requests nothing", async () => {
    const page = await openConversation(reportConversation());
    const requests = page.fetchMock.mock.calls.length;
    const sources = FakeEventSource.instances.length;

    toggleSearch();
    expect(document.activeElement).toBe(searchInput());
    typeQuery("REPORT");

    expect(count()).toBe("1/2");
    expect(counter().childNodes).toHaveLength(1);
    expect([PREVIOUS, NEXT].map((name) => boxButton(name).disabled)).toEqual([false, false]);

    typeQuery("不存在");

    expect(count()).toBe("0/0");
    expect([PREVIOUS, NEXT].map((name) => boxButton(name).disabled)).toEqual([true, true]);
    expect(highlighted()).toEqual([]);
    await quiesce();
    expect(page.fetchMock.mock.calls).toHaveLength(requests);
    expect(FakeEventSource.instances).toHaveLength(sources);
  });
});

describe("键盘与按钮 (S3, S4, S5)", () => {
  it("S3 Enter and Shift+Enter cycle through three matches and send nothing; Escape closes, clears and returns focus", async () => {
    const page = await searchWeekly();
    fireEvent.change(composer(), { target: { value: DRAFT } });
    typeQuery(WEEKLY);
    expect(count()).toBe("1/3");
    const requests = page.fetchMock.mock.calls.length;

    const counts = [{}, {}, {}, { shiftKey: true }].map((init) => {
      press("Enter", init);
      return count();
    });
    expect(counts).toEqual(["2/3", "3/3", "1/3", "3/3"]);
    expect(highlighted()).toEqual(["2"]);
    // Enter in the search input is not the composer's Enter: nothing is sent, the draft stays.
    await quiesce();
    expect(page.fetchMock.mock.calls).toHaveLength(requests);
    expect(calls(page.fetchMock, SESSION_PROMPT)).toEqual([]);
    expect(composer().value).toBe(DRAFT);

    press("Escape");

    expectSearchClosed();
    expect(document.querySelectorAll("article[aria-current]")).toHaveLength(0);
    expect(document.activeElement).toBe(searchButton());

    toggleSearch();
    expectFreshSearch();
  });

  it("S4 下一个 and 上一个 cycle like the keys; 关闭 and the banner button close and return focus without having been focused", async () => {
    await searchWeekly();
    typeQuery(WEEKLY);

    const counts = [NEXT, NEXT, NEXT, PREVIOUS, PREVIOUS].map((name) => {
      fireEvent.click(boxButton(name));
      return count();
    });
    expect(counts).toEqual(["2/3", "3/3", "1/3", "3/3", "2/3"]);
    expect(highlighted()).toEqual(["0"]);

    fireEvent.click(boxButton(CLOSE));

    expectSearchClosed();
    expect(document.activeElement).toBe(searchButton());

    toggleSearch();
    expectFreshSearch();
    typeQuery(WEEKLY);
    expect(highlighted()).toEqual(["-3"]);

    toggleSearch();

    expectSearchClosed();
    expect(document.activeElement).toBe(searchButton());
    toggleSearch();
    expectFreshSearch();
  });

  it("S5 Enter and Escape do nothing while an input method is composing", async () => {
    await searchWeekly();
    typeQuery(WEEKLY);
    expect(count()).toBe("1/3");

    const composing = [
      press("Enter", { isComposing: true }),
      press("Escape", { isComposing: true }),
      press("Enter", { keyCode: 229 }),
      press("Enter", { isComposing: true, shiftKey: true }),
    ];

    expect(composing).toEqual([true, true, true, true]);
    expect(count()).toBe("1/3");
    expect(searchBox()).not.toBeNull();
    expect(highlighted()).toEqual(["-3"]);
    expect(jumps).toHaveLength(1);

    // Outside a composition both keys are handled and their default action is prevented.
    expect(press("a")).toBe(true);
    expect(press("Enter")).toBe(false);
    expect(count()).toBe("2/3");
    expect(press("Escape")).toBe(false);
    expectSearchClosed();
  });
});

describe("消息标记与跳转调用 (S6, S7)", () => {
  it("S6 every article carries its message id; at most one is marked, the message 0 included", async () => {
    await openConversation(weeklyConversation());
    expect(messageIds()).toEqual(WEEKLY_IDS);
    expect(highlighted()).toEqual([]);

    toggleSearch();
    expect(highlighted()).toEqual([]);
    typeQuery(WEEKLY);
    expect([count(), highlighted()]).toEqual(["1/3", ["-3"]]);
    press("Enter");
    expect([count(), highlighted()]).toEqual(["2/3", ["0"]]);
    press("Enter");
    expect([count(), highlighted()]).toEqual(["3/3", ["2"]]);

    // The only match is the message 0: a truthiness check on the id would lose it.
    typeQuery("分三段");
    expect([count(), highlighted()]).toEqual(["1/1", ["0"]]);
    expect(jumps.at(-1)).toEqual(["0", CENTER]);

    const articles = screen.getAllByRole("article");
    expect(messageIds()).toEqual(WEEKLY_IDS);
    expect(articles.map((article) => article.getAttribute("aria-label"))).toEqual([
      "用户",
      "助手",
      "用户",
      "助手",
    ]);
    expect(articles.map((article) => article.hasAttribute("aria-current"))).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("S7 scrolls the first match into the centre on a query change and the next one on Enter, never without a match, and toasts nothing", async () => {
    await searchWeekly();
    expect(jumps).toEqual([]);

    typeQuery(WEEKLY);
    expect(jumps).toEqual([["-3", CENTER]]);
    press("Enter");
    expect(jumps).toEqual([
      ["-3", CENTER],
      ["0", CENTER],
    ]);
    press("Enter", { shiftKey: true });
    expect(jumps.slice(2)).toEqual([["-3", CENTER]]);

    // The same message stays the current match: a query change and a step still scroll to it.
    typeQuery("周报怎");
    expect(count()).toBe("1/1");
    expect(jumps.slice(3)).toEqual([["-3", CENTER]]);
    press("Enter");
    expect(count()).toBe("1/1");
    expect(jumps.slice(4)).toEqual([["-3", CENTER]]);

    typeQuery("不存在");
    press("Enter");
    fireEvent.click(boxButton(CLOSE));

    expect(jumps).toHaveLength(5);
    await quiesce();
    expect(toasts()).toEqual([]);
  });
});

describe("会话切换与欢迎态 (S12, S13)", () => {
  it("S12 selecting another session closes and clears the search; coming back does not reopen it", async () => {
    await searchWeekly();
    typeQuery(WEEKLY);
    expect(highlighted()).toEqual(["-3"]);
    const nav = screen.getByRole("navigation", { name: "会话列表" });

    fireEvent.click(within(nav).getByRole("button", { name: "other session" }));
    await crumb("other session");
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();

    expectSearchClosed();

    fireEvent.click(within(nav).getByRole("button", { name: "saved title" }));
    await crumb("saved title");
    await waitFor(() => expect(messageIds()).toEqual(WEEKLY_IDS));
    await quiesce();

    expectSearchClosed();
    toggleSearch();
    expectFreshSearch();
  });

  it("S13 leaving for the welcome state closes the search; the session opens closed afterwards", async () => {
    const page = await searchWeekly();
    typeQuery(WEEKLY);

    await act(() => page.router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: WELCOME });

    expect(searchBox()).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^(重命名|对话内搜索|产物面板)$/ })).toEqual([]);

    await act(() => page.router.navigate(SESSION_PATH));
    await waitFor(() => expect(messageIds()).toEqual(WEEKLY_IDS));
    await quiesce();

    expectSearchClosed();
    toggleSearch();
    expectFreshSearch();
  });
});

describe("顶栏全序 (S14, S16)", () => {
  it("S14 a selected session shows 重命名, 对话内搜索, 产物面板 after the heading; the welcome state shows none", async () => {
    const page = await openConversation(weeklyConversation());

    const heading = within(banner()).getByRole("heading", {
      level: 1,
      name: "我的工作 / saved title",
    });
    const buttons = within(banner()).getAllByRole("button");
    expect(bannerButtons()).toEqual(TOPBAR_BUTTONS);
    for (const button of buttons) {
      expect(heading.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
      expect(heading.contains(button)).toBe(false);
    }
    expect(within(banner()).queryByRole("button", { name: "更多" })).toBeNull();
    expect(hasLucideGlyph(searchButton(), "search")).toBe(true);
    expect(buttons.map((button) => button.getAttribute("aria-expanded"))).toEqual([
      null,
      "false",
      null,
    ]);

    await act(() => page.router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: WELCOME });
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^(重命名|对话内搜索|产物面板)$/ })).toEqual([]);
  });

  it("S14 at 760px and below 打开导航 comes first, and is all that is left in the welcome state", async () => {
    installNarrowViewport();
    const page = await openConversation(weeklyConversation());
    await crumb("saved title");

    expect(bannerButtons()).toEqual(["打开导航", ...TOPBAR_BUTTONS]);

    await act(() => page.router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: WELCOME });
    expect(bannerButtons()).toEqual(["打开导航"]);
  });

  it("S16 chatTopbar fills rename, search and artifacts in that order; only search carries expanded and receives its trigger", () => {
    const session = weeklyConversation().session;
    const [openRename, openArtifacts] = [vi.fn(), vi.fn()];
    const closed = { expanded: false, onSelect: vi.fn() };
    const opened = { expanded: true, onSelect: vi.fn() };

    expect(chatTopbar(undefined, openRename, opened, openArtifacts)).toStrictEqual({});

    const report = chatTopbar(session, openRename, closed, openArtifacts);
    expect(report.breadcrumb).toBe("saved title");
    expect(report.actions?.map((action) => action.key)).toEqual(["rename", "search", "artifacts"]);
    expect(report.actions?.map((action) => Object.keys(action).includes("expanded"))).toEqual([
      false,
      true,
      false,
    ]);
    expect(report.actions?.[1]?.expanded).toBe(false);
    expect(chatTopbar(session, openRename, opened, openArtifacts).actions?.[1]?.expanded).toBe(
      true,
    );

    const trigger = document.createElement("button");
    report.actions?.[1]?.onSelect(trigger);
    expect(closed.onSelect.mock.calls).toEqual([[trigger]]);
    expect(opened.onSelect).not.toHaveBeenCalled();
    expect(openRename).not.toHaveBeenCalled();
    expect(openArtifacts).not.toHaveBeenCalled();
    report.actions?.[2]?.onSelect(trigger);
    expect(openArtifacts.mock.calls).toEqual([[trigger]]);
  });
});

describe("历史未读到 (S15)", () => {
  it("S15 opened while the history is still being read: 0/0, then 0/n without a jump once it arrived, and Enter takes the first match", async () => {
    const history = deferredResponse();
    const snapshot = weeklyConversation();
    mountConversation(snapshot, () => history.promise);
    await waitFor(() => expect(bannerButtons()).toEqual(TOPBAR_BUTTONS));
    expect(messageIds()).toEqual([]);

    toggleSearch();
    expect(count()).toBe("0/0");
    typeQuery(WEEKLY);
    expect(count()).toBe("0/0");

    await settleDeferredResponse(history, jsonResponse(snapshot));
    await waitFor(() => expect(messageIds()).toEqual(WEEKLY_IDS));

    expect(searchInput().value).toBe(WEEKLY);
    expect([count(), highlighted()]).toEqual(["0/3", []]);
    expect(jumps).toEqual([]);

    press("Enter");

    expect([count(), highlighted()]).toEqual(["1/3", ["-3"]]);
    expect(jumps).toEqual([["-3", CENTER]]);
  });

  it("S15 opened after the history read failed: the box sits above the alert, counts 0/0 and takes a query", async () => {
    mountConversation(weeklyConversation(), () => envelope(500, "internal", "历史读取失败"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("历史读取失败");
    expect(pageColumn().firstElementChild).toBe(alert);

    toggleSearch();

    const box = searchBox();
    expect(pageColumn().firstElementChild).toBe(box);
    expect(box?.nextElementSibling).toBe(alert);
    expect(count()).toBe("0/0");

    typeQuery(WEEKLY);
    press("Enter");
    press("Enter", { shiftKey: true });

    expect(searchInput().value).toBe(WEEKLY);
    expect(count()).toBe("0/0");
    expect([PREVIOUS, NEXT].map((name) => boxButton(name).disabled)).toEqual([true, true]);
    expect(jumps).toEqual([]);
    expect(screen.getAllByRole("alert")).toEqual([alert]);
  });
});

describe("标题未知与模态层 (S19, S20)", () => {
  // The probed shell of the 产物面板 cases: its hooks dispose that shell's router.
  artifactsPanelFixture();

  it("S19 the search closes when the top bar loses the session title under the same URL, and stays closed once the title is back", async () => {
    const getProbe = await openProbedSession(weeklyConversation());
    toggleSearch();
    typeQuery(WEEKLY);
    expect([count(), highlighted()]).toEqual(["1/3", ["-3"]]);

    // The renewed account owns neither the list nor the history yet: no title, no buttons.
    await renewAccount(getProbe);

    expect(currentLocation()).toBe(SESSION_PATH);
    expect(searchBox()).toBeNull();
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await waitFor(() => expect(messageIds()).toEqual(WEEKLY_IDS));
    await quiesce();
    expect(bannerButtons()).toEqual(TOPBAR_BUTTONS);
    expectSearchClosed();

    toggleSearch();
    expectFreshSearch();
  });

  it("S20 a rename dialog over the open search leaves it as it was and hands focus back to 重命名", async () => {
    await searchWeekly();
    typeQuery(WEEKLY);
    press("Enter");
    expect([count(), highlighted()]).toEqual(["2/3", ["0"]]);

    const rename = await openTopbarRename();
    expect(renameDialog()).toBe(rename.dialog);
    fireEvent.click(rename.cancel);
    await waitFor(() => expect(renameDialog()).toBeNull());
    await focusOn(rename.trigger);

    expect(rename.trigger.getAttribute("aria-label")).toBe("重命名");
    expect(searchInput().value).toBe(WEEKLY);
    expect([count(), highlighted()]).toEqual(["2/3", ["0"]]);
    expect(searchButton().getAttribute("aria-expanded")).toBe("true");
    expect(jumps).toHaveLength(2);

    press("Escape");

    expectSearchClosed();
    expect(document.activeElement).toBe(searchButton());
  });
});

describe("样式契约 (S18)", () => {
  /** The class tokens of every child of the open search box, in DOM order. */
  async function openedBox() {
    await openConversation(weeklyConversation());
    toggleSearch();
    const box = screen.getByRole("search", { name: SEARCH });
    return { box, children: [...box.children].map((child) => [...child.classList]) };
  }

  it("S18 the search box is a fixed row at the end of the page column, never wider than it", async () => {
    const { box } = await openedBox();
    expect([...box.classList]).toEqual(
      expect.arrayContaining(["flex", "flex-none", "items-center", "self-end", "max-w-full"]),
    );
  });

  it("S18 the field alone may shrink: the counter and the icon buttons never do", async () => {
    const { children } = await openedBox();
    const [field, live, ...buttons] = children;
    expect(field).toEqual(expect.arrayContaining(["min-w-0", "shrink"]));
    expect(field).not.toContain("flex-none");
    expect(live).toContain("flex-none");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toContain("shrink-0");
  });

  it("S18 the search box leaves room at its top and on both sides for the focus ring the page column would clip", async () => {
    const { box } = await openedBox();
    expect([...box.classList]).toEqual(expect.arrayContaining(["px-1", "pt-1"]));
  });

  it("S18 the box is built on the copied layer: stable slots, no class of the frozen primitives", async () => {
    const { box } = await openedBox();
    expect(box.dataset.slot).toBe("conversation-search");
    expect(counter().dataset.slot).toBe("search-count");
    expect(searchInput().dataset.slot).toBe("input");
    expect([PREVIOUS, NEXT, CLOSE].map((name) => boxButton(name).dataset.slot)).toEqual([
      "button",
      "button",
      "button",
    ]);
    expect([PREVIOUS, NEXT, CLOSE].map((name) => boxButton(name).type)).toEqual([
      "button",
      "button",
      "button",
    ]);
    expect(box.outerHTML).not.toMatch(/chat-search|ui-btn|ui-input/);
  });
});
