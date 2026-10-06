/**
 * Issue #866 — session-todo「任务清单面板」and chat-web「输入框上方停靠区」on the mounted page (fake API
 * and fake EventSource): the read-only task-list panel at the top of the composer dock. jsdom does
 * no layout, so the height rules are asserted as structure (style declarations), never as pixels.
 */
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  approval,
  approvalPath,
  bodies,
  button,
  cards,
  composerInput,
  dock,
  emitRequest,
  emitResolved,
  flush,
  MESSAGES,
  mountPage,
  OTHER_TITLE,
  settledBody,
  slotText,
  snapshotWith,
  stopButton,
  T0,
} from "./chat-approval-support.js";
import { cleanupChatLifecycle, typeDraft } from "./chat-page-lifecycle-support.js";
import { OTHER_MESSAGES, otherSnapshot } from "./chat-page-ownership-support.js";
import { chatSnapshot, type FakeEventSource, latestSource } from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";

type Todo = NonNullable<ChatMessageSnapshot["todo"]>;
type Status = Todo["phases"][number]["tasks"][number]["status"];

const task = (content: string, status: Status) => ({ content, status });

const FIVE: Todo = {
  phases: [
    { name: "准备", tasks: [task("读取需求", "completed"), task("列出要点", "in_progress")] },
    {
      name: "交付",
      tasks: [task("输出结论", "pending"), task("写周报", "abandoned"), task("等评审", "blocked")],
    },
  ],
};
const TWO: Todo = {
  phases: [{ name: "走查", tasks: [task("整理需求", "in_progress"), task("输出结论", "pending")] }],
};
const ALL_CLOSED: Todo = {
  phases: [{ name: "走查", tasks: [task("整理需求", "completed"), task("输出结论", "abandoned")] }],
};
const ONE_DONE: Todo = {
  phases: [{ name: "走查", tasks: [task("整理需求", "completed"), task("输出结论", "pending")] }],
};
const OTHER_TODO: Todo = { phases: [{ name: "另一份", tasks: [task("别的任务", "pending")] }] };
const HUNDREDS: Todo = {
  phases: [
    {
      name: "长清单",
      tasks: Array.from({ length: 200 }, (_, at) => task(`任务 ${at + 1}`, "pending")),
    },
  ],
};
const TWENTY: Todo = {
  phases: [
    {
      name: "中等清单",
      tasks: Array.from({ length: 20 }, (_, at) => task(`任务 ${at + 1}`, "pending")),
    },
  ],
};
const LONG_TITLE = Array.from({ length: 50 }, (_, line) => `line ${line + 1}`).join("\n");

function slot(name: string, root: ParentNode = document) {
  return root.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

function slotTexts(name: string, root: ParentNode = document) {
  return [...root.querySelectorAll(`[data-slot="${name}"]`)].map((el) => el.textContent);
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** 限高与内部滚动的样式声明：Tailwind 类名。 */
function caps(element: Element | null) {
  return [...(element?.classList ?? [])].filter((name) => /^(max-h-|overflow-)/.test(name)).sort();
}

/**
 * jsdom 不做布局：给任务列表一个可见高度（6）与内容高度（列表项个数），200 项的清单超出、五项以内的
 * 不超出（其它元素仍为 0）。数值只用来比大小，不是像素断言。
 */
function stubListHeights() {
  const isList = (el: Element) => el.getAttribute("data-slot") === "todo-list";
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isList(this) ? 6 : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isList(this) ? this.querySelectorAll("li").length : 0;
  });
}

/**
 * 可见高度随限高档位变：小档（`max-h-16`）比 20 项的内容矮，大档（`max-h-40`）比它高。同一份清单
 * 只因档位切换而从被裁剪变成不被裁剪。
 */
function stubListHeightsByTier() {
  const isList = (el: Element) => el.getAttribute("data-slot") === "todo-list";
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    if (!isList(this)) return 0;
    return this.classList.contains("max-h-16") ? 6 : 100;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return isList(this) ? this.querySelectorAll("li").length : 0;
  });
}

/** 名称以 `任务清单` 开头的按钮：面板的头部按钮，整页至多一个。 */
function toggles() {
  return screen.queryAllByRole("button", { name: /^任务清单/ });
}

/** 面板的头部按钮；面板必须在停靠区内、在所有消息之外。 */
function toggle() {
  const found = toggles();
  if (found.length !== 1) throw new Error(`expected one task-list button, found ${found.length}`);
  const [header] = found as [HTMLElement];
  if (!dock()?.contains(header)) throw new Error("task-list panel outside the composer dock");
  if (header.closest("article")) throw new Error("task-list panel inside a message article");
  return header;
}

function panel() {
  return toggle().closest('[data-slot="todo-panel"]') as HTMLElement;
}

/** 面板里的列表项：`[状态可访问文本, 正文]`。 */
function items() {
  return within(panel())
    .queryAllByRole("listitem")
    .map((item) => [textOf(item, "todo-status"), textOf(item, "todo-content")]);
}

function textOf(root: HTMLElement, name: string) {
  return slot(name, root)?.textContent;
}

function doneSnapshot(todo: ChatMessageSnapshot["todo"]) {
  return chatSnapshot({
    status: "done",
    assistantStatus: "done",
    content: "answer",
    cursor: { epoch: 1, seq: 0 },
    todo,
  });
}

function emitTodo(source: FakeEventSource, seq: number, todo: ChatMessageSnapshot["todo"]) {
  act(() => {
    source.emitData("todo.updated", `1:${seq}`, { messageId: 0, todo });
  });
}

async function until(done: () => boolean, what: string) {
  for (let round = 0; round < 200 && !done(); round += 1) {
    await flush(1);
  }
  if (!done()) throw new Error(`timed out waiting for ${what}`);
}

async function select(title: "saved title" | "other session", shown: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  await until(() => screen.queryByText(shown, { exact: true }) !== null, shown);
  await flush();
}

const OTHER_ROUTE = {
  [OTHER_MESSAGES]: () => jsonResponse({ ...otherSnapshot(), todo: OTHER_TODO }),
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanupChatLifecycle();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("task-list panel: content", () => {
  it("T1 sits at the top of the dock above the pending card and the composer, with phases, five items and their status text, read-only", async () => {
    const { fetchMock } = await mountPage({ ...snapshotWith([approval(7)]), todo: FIVE });
    const requests = fetchMock.mock.calls.length;

    const header = toggle();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "任务清单 1/5" })).toBe(header);
    const [card] = cards() as [HTMLElement];
    expect(cards()).toHaveLength(1);
    const list = slot("todo-list", panel()) as HTMLElement;
    const viewport = slot("thread-viewport") as HTMLElement;
    const composer = slot("composer") as HTMLElement;
    // 自上而下：线程、头部按钮、任务列表、提问卡、输入框
    expect(follows(viewport, header)).toBe(true);
    expect(follows(header, list)).toBe(true);
    expect(follows(list, card)).toBe(true);
    expect(follows(card, composer)).toBe(true);
    expect((dock() as HTMLElement).firstElementChild).toBe(panel());
    expect(panel().contains(card)).toBe(false);
    expect(viewport.contains(panel())).toBe(false);

    expect(slotTexts("todo-phase", list)).toEqual(["准备", "交付"]);
    expect(items()).toEqual([
      ["已完成", "读取需求"],
      ["进行中", "列出要点"],
      ["待办", "输出结论"],
      ["已放弃", "写周报"],
      ["受阻", "等评审"],
    ]);
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    // 只读：除头部按钮外没有任何可交互控件。五项的清单没有被限高裁掉（jsdom 里内容高度不超过可见高度），
    // 所以列表也不带 tabindex；被裁掉时列表可聚焦，见 S1。
    expect(within(panel()).getAllByRole("button")).toEqual([header]);
    expect(
      panel().querySelectorAll("a, input, textarea, select, [tabindex], [contenteditable]"),
    ).toHaveLength(0);
    expect(composerInput().disabled).toBe(true);
    expect(stopButton().disabled).toBe(false);

    // 收起与展开都不发请求
    fireEvent.click(header);
    fireEvent.click(header);
    await flush();
    expect(fetchMock.mock.calls.length).toBe(requests);
  });

  it("T2 shows no phase name for a single phase and counts only completed tasks", async () => {
    await mountPage(doneSnapshot(TWO));

    expect(toggle().textContent).toBe("任务清单 0/2");
    expect(screen.getByRole("button", { name: "任务清单 0/2" })).toBe(toggle());
    expect(items()).toEqual([
      ["进行中", "整理需求"],
      ["待办", "输出结论"],
    ]);
    expect(slotTexts("todo-phase")).toEqual([]);
    expect(screen.queryAllByText("走查")).toHaveLength(0);
  });

  it("T3 renders names and contents as text, not as Markdown or HTML", async () => {
    const raw = "**粗体** <b>x</b> [链接](https://example.com)";
    await mountPage(
      doneSnapshot({
        phases: [
          { name: "# <i>阶段</i>", tasks: [task(raw, "pending")] },
          { name: "二", tasks: [task("b", "blocked")] },
        ],
      }),
    );

    expect(slotTexts("todo-phase")).toEqual(["# <i>阶段</i>", "二"]);
    expect(items()[0]).toEqual(["待办", raw]);
    expect(panel().querySelectorAll("b, strong, i, a, h1")).toHaveLength(0);
  });
});

describe("task-list panel: visibility", () => {
  it("V1 hides when every task is completed or abandoned, returns with a pending task and hides again on null, leaving the card and the composer alone", async () => {
    const { source } = await mountPage({ ...snapshotWith([approval(7)]), todo: TWO });
    expect(toggle().textContent).toBe("任务清单 0/2");
    const [card] = cards() as [HTMLElement];
    const input = composerInput();

    emitTodo(source, 1, ALL_CLOSED);
    expect(toggles()).toHaveLength(0);
    expect(slot("todo-panel")).toBeNull();
    expect(cards()).toEqual([card]);
    expect(composerInput()).toBe(input);

    emitTodo(source, 2, ONE_DONE);
    expect(toggle().textContent).toBe("任务清单 1/2");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    emitTodo(source, 3, null);
    expect(toggles()).toHaveLength(0);
    expect(cards()).toEqual([card]);
  });

  it("V2 renders no panel and no dock for todo: null, nor for a list that is closed from the start", async () => {
    await mountPage(doneSnapshot(null));
    expect(toggles()).toHaveLength(0);
    expect(dock()).toBeNull();
    const composer = slot("composer") as HTMLElement;
    expect(composer.previousElementSibling?.contains(slot("thread-viewport"))).toBe(true);

    cleanupChatLifecycle();
    await mountPage(doneSnapshot(ALL_CLOSED));
    expect(toggles()).toHaveLength(0);
    expect(dock()).toBeNull();
  });

  it("V3 keeps a blocked-only list visible and renders the dock for the panel alone", async () => {
    await mountPage(
      doneSnapshot({
        phases: [{ name: "走查", tasks: [task("a", "completed"), task("b", "blocked")] }],
      }),
    );

    expect(toggle().textContent).toBe("任务清单 1/2");
    expect(cards()).toHaveLength(0);
    expect((dock() as HTMLElement).children).toHaveLength(1);
  });

  it("V4 updates in place on todo.updated without touching the draft or the composer focus", async () => {
    const { source } = await mountPage(doneSnapshot(null));
    typeDraft("半句话");
    composerInput().focus();
    expect(toggles()).toHaveLength(0);

    emitTodo(source, 1, TWO);
    expect(toggle().textContent).toBe("任务清单 0/2");
    emitTodo(source, 2, ONE_DONE);
    expect(toggle().textContent).toBe("任务清单 1/2");
    expect(items()).toEqual([
      ["已完成", "整理需求"],
      ["待办", "输出结论"],
    ]);
    expect(composerInput().value).toBe("半句话");
    expect(document.activeElement).toBe(composerInput());
  });

  it("V5 restores the panel from the snapshot alone, and a resync installs the snapshot's list", async () => {
    // 刷新：快照带清单，没有任何 todo.updated
    await mountPage(doneSnapshot(TWO));
    expect(toggle().textContent).toBe("任务清单 0/2");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(items()).toEqual([
      ["进行中", "整理需求"],
      ["待办", "输出结论"],
    ]);

    // 重新同步：非法 payload 触发恰一次历史读取，恢复快照的清单整体安装
    cleanupChatLifecycle();
    const { fetchMock, page, source } = await mountPage(doneSnapshot(null));
    expect(toggles()).toHaveLength(0);
    const reads = calls(fetchMock, MESSAGES).length;
    page.snapshot = { ...doneSnapshot(FIVE), streamCursor: { epoch: 1, seq: 1 } };
    act(() => source.emitData("todo.updated", "1:1", { messageId: 0 }));
    await flush();
    expect(calls(fetchMock, MESSAGES).length).toBe(reads + 1);
    expect(toggle().textContent).toBe("任务清单 1/5");
    expect(items()).toHaveLength(5);
  });
});

describe("task-list panel: expanded state", () => {
  it("E1 keeps the collapsed state per session in memory: not shared with another session, kept across todo.updated, reset by a reload", async () => {
    await mountPage(doneSnapshot(TWO), OTHER_ROUTE);

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(within(panel()).queryAllByRole("listitem")).toHaveLength(0);
    expect(slot("todo-list")).toBeNull();
    expect(toggle().textContent).toBe("任务清单 0/2");

    await select("other session", "other user");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(items()).toEqual([["待办", "别的任务"]]);

    await select("saved title", "answer");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("任务清单 0/2");

    const source = latestSource();
    act(() => source.emitOpen());
    await flush();
    emitTodo(source, 1, ONE_DONE);
    expect(toggle().textContent).toBe("任务清单 1/2");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(within(panel()).queryAllByRole("listitem")).toHaveLength(0);
    expect(window.localStorage.length).toBe(0);
    expect(window.location.search).not.toContain("todo");

    // 重新加载页面：恢复为默认展开
    cleanupChatLifecycle();
    await mountPage(doneSnapshot(ONE_DONE), OTHER_ROUTE);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(items()).toHaveLength(2);
  });

  it("E2 shows nothing in the welcome state and brings the panel back with the session's saved state", async () => {
    await mountPage(doneSnapshot(TWO));
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await until(
      () => screen.queryByRole("heading", { level: 1, name: "WorkBuddy，我帮你" }) !== null,
      "the welcome state",
    );
    expect(toggles()).toHaveLength(0);
    expect(slot("todo-panel")).toBeNull();
    expect(dock()).toBeNull();

    await select("saved title", "answer");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("任务清单 0/2");
    fireEvent.click(toggle());
    expect(items()).toHaveLength(2);
  });
});

describe("task-list panel: structure of the extreme states", () => {
  it("S1 renders 200 items inside the capped, scrolling list with the header button outside it; the cap is the large tier without cards and the small tier while a card is pending; the clipped list is a keyboard-focusable role=list", async () => {
    stubListHeights();
    const { source } = await mountPage({ ...snapshotWith([]), todo: HUNDREDS });

    const container = dock() as HTMLElement;
    const list = slot("todo-list") as HTMLElement;
    const viewport = slot("thread-viewport") as HTMLElement;
    const composer = slot("composer") as HTMLElement;
    expect(toggle().textContent).toBe("任务清单 0/200");
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    expect(within(container).getAllByRole("listitem")).toHaveLength(200);
    expect(document.querySelectorAll('[data-slot="todo-list"]')).toHaveLength(1);
    expect(textOf(list.lastElementChild as HTMLElement, "todo-content")).toBe("任务 200");
    // 列表自己限高并在内部滚动；头部按钮在这个滚动容器之外
    // 没有待决提问卡：较大的一档
    expect(caps(list)).toEqual(["max-h-40", "overflow-y-auto"]);
    // 显式的列表语义；200 项被限高裁掉：列表可由键盘聚焦
    expect(list.getAttribute("role")).toBe("list");
    expect(list.getAttribute("tabindex")).toBe("0");
    // 可聚焦的列表不是控件：面板里的按钮仍只有头部按钮，带 tabindex 的只有列表自己
    expect(within(panel()).getAllByRole("button")).toEqual([toggle()]);
    expect([...panel().querySelectorAll("[tabindex]")]).toEqual([list]);
    expect(list.contains(toggle())).toBe(false);
    expect(panel().contains(list)).toBe(true);
    expect(caps(panel())).toEqual([]);
    // 停靠区：线程滚动容器之外、输入框之前，整体限高并在内部滚动
    expect(container.contains(panel())).toBe(true);
    expect(viewport.contains(container)).toBe(false);
    expect(follows(viewport, container)).toBe(true);
    expect(follows(container, composer)).toBe(true);
    expect(caps(container)).toEqual(["max-h-1/2", "overflow-y-auto"]);

    emitRequest(source, 1, 7);
    const [card] = cards() as [HTMLElement];
    expect(cards()).toHaveLength(1);
    expect(dock()).toBe(container);
    expect(follows(panel(), card)).toBe(true);
    expect(list.contains(button(card, "允许"))).toBe(false);
    expect(list.contains(button(card, "拒绝"))).toBe(false);
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    // 卡出现后换成较小的一档，最后一张卡结算后换回较大的一档；头部按钮始终在滚动容器之外
    expect(caps(list)).toEqual(["max-h-16", "overflow-y-auto"]);
    expect(list.getAttribute("tabindex")).toBe("0");
    expect(list.contains(toggle())).toBe(false);
    emitResolved(source, 2, 7, "allow");
    expect(cards()).toHaveLength(0);
    expect(slot("todo-list")).toBe(list);
    expect(caps(list)).toEqual(["max-h-40", "overflow-y-auto"]);
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    expect(list.getAttribute("tabindex")).toBe("0");

    // 清单换成不超出的两项：同一个列表不再带 tabindex
    emitTodo(source, 3, TWO);
    expect(slot("todo-list")).toBe(list);
    expect(list.getAttribute("role")).toBe("list");
    expect(list.hasAttribute("tabindex")).toBe(false);
  });

  it("S3 measures the list when a panel that mounted collapsed is expanded: a clipped list gets tabindex=0", async () => {
    stubListHeights();
    await mountPage(doneSnapshot(HUNDREDS), OTHER_ROUTE);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    // 切走再切回：面板以收起态出现，列表不在 DOM 里
    await select("other session", "other user");
    expect((slot("todo-list") as HTMLElement).hasAttribute("tabindex")).toBe(false);
    await select("saved title", "answer");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(slot("todo-list")).toBeNull();

    fireEvent.click(toggle());
    const list = slot("todo-list") as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    expect(list.getAttribute("tabindex")).toBe("0");
  });

  it("S4 re-measures the same list when only the cap tier changes: clipped under the small tier, not under the large one", async () => {
    stubListHeightsByTier();
    const { source } = await mountPage({ ...snapshotWith([approval(7)]), todo: TWENTY });

    const list = slot("todo-list") as HTMLElement;
    expect(cards()).toHaveLength(1);
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(caps(list)).toEqual(["max-h-16", "overflow-y-auto"]);
    expect(list.getAttribute("tabindex")).toBe("0");

    // 卡结算：清单与展开状态都没变，只有档位换了
    emitResolved(source, 1, 7, "allow");
    expect(cards()).toHaveLength(0);
    expect(slot("todo-list")).toBe(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(caps(list)).toEqual(["max-h-40", "overflow-y-auto"]);
    expect(list.hasAttribute("tabindex")).toBe(false);
  });

  it("S2 keeps the panel and three pending cards, one with a 50-line title, in one dock: panel first, outside the thread scroller, before the composer", async () => {
    await mountPage({
      ...snapshotWith([
        approval(7, { title: LONG_TITLE }),
        approval(8),
        approval(9, { title: OTHER_TITLE }),
      ]),
      todo: HUNDREDS,
    });

    const container = dock() as HTMLElement;
    const viewport = slot("thread-viewport") as HTMLElement;
    const composer = slot("composer") as HTMLElement;
    const found = cards();
    expect(found).toHaveLength(3);
    expect(document.querySelectorAll('[data-slot="composer-dock"]')).toHaveLength(1);
    expect([...container.children]).toEqual([panel(), ...found]);
    expect(viewport.contains(container)).toBe(false);
    expect(follows(viewport, container)).toBe(true);
    expect(follows(container, composer)).toBe(true);
    expect(container.parentElement).toBe(slot("chat-column"));

    const list = slot("todo-list", panel()) as HTMLElement;
    expect(within(list).getAllByRole("listitem")).toHaveLength(200);
    expect(caps(container)).toEqual(["max-h-1/2", "overflow-y-auto"]);
    // 有待决提问卡：较小的一档
    expect(caps(list)).toEqual(["max-h-16", "overflow-y-auto"]);
    for (const card of found) {
      const title = slot("approval-title", card) as HTMLElement;
      expect(caps(title).filter((name) => name.startsWith("max-h-"))).toHaveLength(1);
      expect(caps(title)).toContain("overflow-y-auto");
      expect(title.contains(button(card, "允许"))).toBe(false);
      expect(title.contains(button(card, "拒绝"))).toBe(false);
      expect(list.contains(card)).toBe(false);
    }
    expect(slotText(found[0] as HTMLElement, "approval-title")).toBe(LONG_TITLE);
    // 面板与卡都不随停靠区收缩
    expect(panel().classList).toContain("flex-none");
  });
});

/** 立即点 `允许`、第 399 毫秒点 `拒绝`：都不发请求、按钮保持可用；返回时恰好过了 400 毫秒。 */
async function expectBlocked(card: HTMLElement, sent: () => unknown[]) {
  fireEvent.click(button(card, "允许"));
  act(() => {
    vi.advanceTimersByTime(399);
  });
  fireEvent.click(button(card, "拒绝"));
  await flush();
  expect(sent()).toEqual([]);
  expect(button(card, "允许").disabled).toBe(false);
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

describe("task-list panel: click guard of the cards below it", () => {
  it("G4 ignores answers for 400 ms after the panel above a shown card appears, changes, is collapsed or is expanded again, then answers once", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([approval(7)]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
    });
    const [card] = cards() as [HTMLElement];
    const sent = () => bodies(fetchMock, approvalPath(7));
    const blockedClick = () => expectBlocked(card, sent);

    // 面板出现在已显示的卡上方
    emitTodo(source, 1, TWO);
    await blockedClick();
    // 展开的清单换了内容
    emitTodo(source, 2, FIVE);
    await blockedClick();
    // 收起
    fireEvent.click(toggle());
    await blockedClick();
    // 重新展开
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await blockedClick();
    // 再收起
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await blockedClick();
    // 收起时清单变化不改变面板的形状：不设防
    emitTodo(source, 3, TWO);
    fireEvent.click(button(card, "允许"));
    await flush();
    expect(sent()).toEqual([{ decision: "allow" }]);
  });

  it("G5 answers at once when a card appears below a panel that was already there", async () => {
    const { fetchMock, source } = await mountPage(
      { ...snapshotWith([]), todo: TWO },
      { [approvalPath(7)]: () => settledBody(7, "deny") },
    );
    expect(toggle().textContent).toBe("任务清单 0/2");

    emitRequest(source, 1, 7);
    fireEvent.click(button(cards()[0] as HTMLElement, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "deny" }]);
  });

  it("G6 ignores answers for 400 ms after the panel above a shown card disappears, whether it was expanded or collapsed, then answers once", async () => {
    // 面板与卡一开始就都在：不设防的起点
    const { fetchMock, source } = await mountPage(
      { ...snapshotWith([approval(7)]), todo: TWO },
      { [approvalPath(7)]: () => settledBody(7, "allow") },
    );
    const [card] = cards() as [HTMLElement];
    const sent = () => bodies(fetchMock, approvalPath(7));
    const blockedClick = () => expectBlocked(card, sent);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    // 展开的面板消失：清单全部结束
    emitTodo(source, 1, ALL_CLOSED);
    expect(toggles()).toHaveLength(0);
    await blockedClick();
    // 重新出现
    emitTodo(source, 2, ONE_DONE);
    await blockedClick();
    // 收起
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await blockedClick();
    // 收起的面板消失：清单为 null
    emitTodo(source, 3, null);
    expect(toggles()).toHaveLength(0);
    expect(cards()).toEqual([card]);
    await blockedClick();

    fireEvent.click(button(card, "允许"));
    await flush();
    expect(sent()).toEqual([{ decision: "allow" }]);
  });
});
