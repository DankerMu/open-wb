import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  ALLOWED,
  approval,
  approvalPath,
  assistantRow,
  assistants,
  bodies,
  button,
  cards,
  composerInput,
  countdowns,
  DENIED,
  dock,
  emitRequest,
  emitResolved,
  expectRecord,
  flush,
  mountPage,
  OTHER_TITLE,
  records,
  settledBody,
  slotText,
  snapshotWith,
  stopButton,
  T0,
  TIMED_OUT,
  TITLE,
} from "./chat-approval-support.js";
import { cleanupChatLifecycle } from "./chat-page-lifecycle-support.js";
import { chatSnapshot, type FakeEventSource, historyUser } from "./chat-stream-support.js";

const LONG_TITLE = Array.from({ length: 50 }, (_, line) => `line ${line + 1}`).join("\n");

function slot(name: string) {
  return document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

/** 限高与内部滚动的样式声明：Tailwind 类名（jsdom 不做布局，不作像素断言）。 */
function caps(element: Element | null | undefined) {
  return [...(element?.classList ?? [])].filter((name) => /^(max-h-|overflow-)/.test(name)).sort();
}

const OVERFLOW_HINT = "内容较长，请滚动查看全部";

/**
 * jsdom 不做布局：给 `title` 正文一个内容高度与可见高度，50 行的那段超出、其余不超出（其它元素仍为 0）。
 * 数值只用来比大小，不是像素断言。
 */
function stubTitleHeights() {
  const isTitle = (el: Element) => el.getAttribute("data-slot") === "approval-title";
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return isTitle(this) ? 6 : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    if (!isTitle(this)) return 0;
    return this.textContent === LONG_TITLE ? 50 : 2;
  });
}

function passClickGuard(ms = 400) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const WRITE_TITLE = "Allow tool: write\nPath: notes.md";

/** 回合结束：`停止` 卸载、输入框解锁。 */
async function endTurn(source: FakeEventSource, seq: number) {
  act(() => {
    source.emitData("turn.end", `1:${seq}`, { messageId: 0, status: "done" });
  });
  await flush();
}

/** 焦点在按钮上作答（键盘 Enter / Space 在浏览器里就是一次 click）。 */
async function answerFocused(target: HTMLButtonElement) {
  target.focus();
  expect(document.activeElement).toBe(target);
  fireEvent.click(target);
  await flush();
}

/**
 * 作答后焦点掉到 body：浏览器在按钮被禁用时把焦点收走。jsdom 不做这一步，也不让已禁用的按钮 `blur()`，
 * 所以在点击处理之后、按钮被禁用的那次提交之前显式 `blur()`（document 上的监听晚于 React 的处理，
 * 早于 act 结束时的提交）。
 */
async function answerThenLoseFocus(target: HTMLButtonElement) {
  target.focus();
  document.addEventListener("click", () => target.blur(), { once: true });
  fireEvent.click(target);
  await flush();
  expect(target.disabled).toBe(true);
  expect(document.activeElement).toBe(document.body);
}

function sessionSnapshot(
  status: "running" | "done",
  rows: ChatMessageSnapshot["messages"],
): ChatMessageSnapshot {
  return {
    ...chatSnapshot({ status, cursor: { epoch: 1, seq: status === "done" ? null : 0 } }),
    messages: [historyUser, ...rows],
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanupChatLifecycle();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("composer dock: position and structure", () => {
  it("D1 keeps three pending cards, one with a 50-line title, in one dock outside the thread scroller and before the composer", async () => {
    stubTitleHeights();
    await mountPage(
      snapshotWith([
        approval(7, { title: LONG_TITLE }),
        approval(8),
        approval(9, { title: OTHER_TITLE }),
      ]),
    );

    const container = dock() as HTMLElement;
    const viewport = slot("thread-viewport") as HTMLElement;
    const composer = slot("composer") as HTMLElement;
    const column = slot("chat-column") as HTMLElement;
    const found = cards();
    expect(found).toHaveLength(3);
    expect(document.querySelectorAll('[data-slot="composer-dock"]')).toHaveLength(1);
    expect(found.map((card) => slotText(card, "approval-title"))).toEqual([
      LONG_TITLE,
      TITLE,
      OTHER_TITLE,
    ]);
    // 停靠区：线程滚动容器之外、所有消息之外，文档顺序在线程之后、输入框之前，与二者同属会话页列
    expect(viewport.contains(container)).toBe(false);
    expect(container.closest("article")).toBeNull();
    expect(container.querySelector("article")).toBeNull();
    expect(follows(viewport, container)).toBe(true);
    expect(follows(container, composer)).toBe(true);
    expect(composer.contains(container)).toBe(false);
    expect(container.parentElement).toBe(column);
    expect(composer.parentElement).toBe(column);
    for (const article of screen.getAllByRole("article")) {
      expect(viewport.contains(article)).toBe(true);
      expect(within(article).queryAllByRole("group")).toHaveLength(0);
    }

    // 停靠区整体限高（列高的一半）并在内部滚动
    expect(caps(container)).toEqual(["max-h-1/2", "overflow-y-auto"]);
    for (const card of found) {
      const titles = card.querySelectorAll('[data-slot="approval-title"]');
      expect(titles).toHaveLength(1);
      const title = titles[0] as HTMLElement;
      // 每张卡的 title 正文另有自己的限高与内部滚动；按钮与倒计时句不在它里面
      expect(caps(title).filter((name) => name.startsWith("max-h-"))).toHaveLength(1);
      expect(caps(title)).toContain("overflow-y-auto");
      expect(caps(title)).not.toContain("max-h-none");
      expect(title.classList).toContain("whitespace-pre-wrap");
      expect(title.contains(button(card, "允许"))).toBe(false);
      expect(title.contains(button(card, "拒绝"))).toBe(false);
      expect(countdowns(card)).toHaveLength(1);
      expect(title.contains(countdowns(card)[0] as HTMLElement)).toBe(false);
      expect(within(title).queryAllByRole("button")).toHaveLength(0);
    }
    expect(slotText(found[0] as HTMLElement, "approval-title")?.split("\n")).toHaveLength(50);

    // 只有正文被限高裁掉的那张卡（id 7）有可见提示，且正文可由键盘聚焦；提示在正文之外、倒计时句之前
    const hints = found.map((card) => [
      ...card.querySelectorAll('[data-slot="approval-overflow"]'),
    ]);
    expect(hints.map((list) => list.map((hint) => hint.textContent))).toEqual([
      [OVERFLOW_HINT],
      [],
      [],
    ]);
    expect(
      found.map((card) =>
        card.querySelector('[data-slot="approval-title"]')?.getAttribute("tabindex"),
      ),
    ).toEqual(["0", null, null]);
    const [long] = found as [HTMLElement];
    const longTitle = long.querySelector('[data-slot="approval-title"]') as HTMLElement;
    const hint = hints[0]?.[0] as HTMLElement;
    expect(longTitle.contains(hint)).toBe(false);
    expect(follows(longTitle, hint)).toBe(true);
    expect(follows(hint, countdowns(long)[0] as HTMLElement)).toBe(true);
    expect(screen.getAllByText(OVERFLOW_HINT)).toEqual([hint]);
  });

  it("D2 stacks pending approvals of different messages by ascending id and renders none inside the messages", async () => {
    await mountPage(
      sessionSnapshot("running", [
        assistantRow(0, [approval(12, { title: OTHER_TITLE })]),
        { ...historyUser, id: 1, createdAt: 1 },
        assistantRow(2, [approval(9)], "running"),
      ]),
    );

    const found = cards();
    expect(found.map((card) => slotText(card, "approval-title"))).toEqual([TITLE, OTHER_TITLE]);
    expect(assistants()).toHaveLength(2);
    for (const article of assistants()) {
      expect(within(article).queryAllByRole("group")).toHaveLength(0);
      expect(records(article)).toHaveLength(0);
      expect(within(article).queryAllByRole("button", { name: /^(允许|拒绝)$/ })).toHaveLength(0);
    }
  });

  it("D3 renders no dock between the thread and the composer when nothing is pending", async () => {
    await mountPage(
      sessionSnapshot("done", [assistantRow(0, [approval(7, { decision: "allow" })])]),
    );

    expect(dock()).toBeNull();
    expect(cards()).toHaveLength(0);
    const column = slot("chat-column") as HTMLElement;
    const composer = slot("composer") as HTMLElement;
    // 线程（滚动层的包裹元素）之后紧接输入框
    expect(composer.previousElementSibling?.contains(slot("thread-viewport"))).toBe(true);
    expect(composer.parentElement).toBe(column);
    expect(composerInput().disabled).toBe(false);
  });
});

describe("composer dock: reload recovery", () => {
  it("R1 restores a pending card with the remaining seconds, still answerable, composer locked and 停止 usable", async () => {
    const restored = approval(7, { requestedAt: T0 - 20_000, expiresAt: T0 + 40_000 });
    const { fetchMock, source } = await mountPage(snapshotWith([restored]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
    });

    const [card] = cards() as [HTMLElement];
    expect(cards()).toHaveLength(1);
    expect(countdowns(card).map((sentence) => sentence.textContent)).toEqual([
      "（40s 内未操作将自动允许）",
    ]);
    expect(composerInput().disabled).toBe(true);
    expect(stopButton().disabled).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdowns(card)[0]?.textContent).toBe("（39s 内未操作将自动允许）");

    fireEvent.click(button(card, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 1, 7, "allow");
    expect(cards()).toHaveLength(0);
    expectRecord(records()[0], ALLOWED);
  });

  it("R2 shows 0s, never a negative number, for a pending approval that already expired, and keeps it answerable", async () => {
    const expired = approval(7, { requestedAt: T0 - 63_000, expiresAt: T0 - 3000 });
    const { fetchMock } = await mountPage(snapshotWith([expired]), {
      [approvalPath(7)]: () => settledBody(7, "deny"),
    });

    const [card] = cards() as [HTMLElement];
    expect(countdowns(card).map((sentence) => sentence.textContent)).toEqual([
      "（0s 内未操作将自动允许）",
    ]);
    expect(card.textContent).not.toContain("-");
    expect(button(card, "允许").disabled).toBe(false);
    fireEvent.click(button(card, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "deny" }]);
  });

  it("R3 restores timeout, deny and allow as records inside their own messages and nothing for approvals: []", async () => {
    await mountPage(
      sessionSnapshot("done", [
        assistantRow(0, [approval(7, { decision: "timeout" })]),
        assistantRow(1, [approval(8, { decision: "deny", title: OTHER_TITLE })]),
        assistantRow(2, [approval(9, { decision: "allow" })]),
        assistantRow(3, []),
      ]),
    );

    const [first, second, third, fourth] = assistants() as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];
    expect(records(first)).toHaveLength(1);
    expectRecord(records(first)[0], TIMED_OUT, first);
    expectRecord(records(second)[0], DENIED, second);
    expectRecord(records(third)[0], ALLOWED, third);
    expect(slotText(records(first)[0] as HTMLElement, "approval-tool")).toBe("bash");
    expect(slotText(records(first)[0] as HTMLElement, "approval-title")).toBe(TITLE);
    expect(slotText(records(second)[0] as HTMLElement, "approval-title")).toBe(OTHER_TITLE);
    expect(within(fourth).queryAllByRole("group")).toHaveLength(0);
    expect(fourth.querySelector('[data-slot="approval-records"]')).toBeNull();
    expect(dock()).toBeNull();
    expect(cards()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R4 keeps a message's settled record in place while its other approval is still a docked card", async () => {
    await mountPage(snapshotWith([approval(7, { decision: "deny" }), approval(8)]));

    expect(cards()).toHaveLength(1);
    expect(records()).toHaveLength(1);
    expectRecord(records()[0], DENIED);
    expect(composerInput().disabled).toBe(true);
    expect(stopButton().disabled).toBe(false);
  });
});

describe("composer dock: click guard after the cards move", () => {
  it("G1 ignores a click on the remaining card within 400 ms of another card leaving, then answers it once", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([approval(7), approval(8)]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
      [approvalPath(8)]: () => settledBody(8, "allow"),
    });
    const [seven, eight] = cards() as [HTMLElement, HTMLElement];

    // 两张卡随快照一起出现（停靠区从空到有）：立即点击照常作答
    fireEvent.click(button(eight, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(8))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 1, 8, "allow");
    expect(cards()).toEqual([seven]);

    fireEvent.click(button(seven, "允许"));
    passClickGuard(399);
    fireEvent.click(button(seven, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([]);
    expect(button(seven, "允许").disabled).toBe(false);
    expect(button(seven, "拒绝").disabled).toBe(false);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);

    passClickGuard(1);
    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    expect(button(seven, "允许").disabled).toBe(true);
  });

  it("G2 arms the guard for every card when a new card joins one that is already shown", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([approval(7)]), {
      [approvalPath(7)]: () => settledBody(7, "deny"),
      [approvalPath(8)]: () => settledBody(8, "allow"),
    });
    emitRequest(source, 1, 8, { title: OTHER_TITLE });
    const [seven, eight] = cards() as [HTMLElement, HTMLElement];

    fireEvent.click(button(seven, "拒绝"));
    fireEvent.click(button(eight, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([]);
    expect(bodies(fetchMock, approvalPath(8))).toEqual([]);
    expect(button(seven, "拒绝").disabled).toBe(false);
    expect(button(eight, "允许").disabled).toBe(false);

    passClickGuard();
    fireEvent.click(button(seven, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "deny" }]);
    expect(bodies(fetchMock, approvalPath(8))).toEqual([]);
  });

  it("G3 answers a single card at once when it appears in an empty dock, also after the dock emptied before", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
      [approvalPath(8)]: () => settledBody(8, "deny"),
    });
    emitRequest(source, 1, 7);
    fireEvent.click(button(cards()[0] as HTMLElement, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 2, 7, "allow");
    expect(dock()).toBeNull();

    emitRequest(source, 3, 8, { title: OTHER_TITLE });
    fireEvent.click(button(cards()[0] as HTMLElement, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(8))).toEqual([{ decision: "deny" }]);
  });
});

describe("composer dock: what distinguishes one card from another", () => {
  it("A1 describes each pending card by its own tool badge and title, in that order, and leaves names and settled records alone", async () => {
    await mountPage(
      snapshotWith([
        approval(6, { decision: "allow" }),
        approval(7),
        approval(8, { tool: "write", title: WRITE_TITLE }),
      ]),
    );
    const found = cards();
    expect(found).toHaveLength(2);
    const described = found.map((card) => (card.getAttribute("aria-describedby") ?? "").split(" "));
    for (const [at, card] of found.entries()) {
      const ids = described[at] as string[];
      expect(ids).toHaveLength(2);
      expect(ids.map((id) => document.getElementById(id))).toEqual([
        card.querySelector('[data-slot="approval-tool"]'),
        card.querySelector('[data-slot="approval-title"]'),
      ]);
      for (const id of ids) {
        expect(document.querySelectorAll(`[id="${id}"]`)).toHaveLength(1);
      }
    }
    expect(new Set(described.flat()).size).toBe(4);
    const text = (ids: string[] | undefined) =>
      (ids ?? []).map((id) => document.getElementById(id)?.textContent);
    expect(text(described[0])).toEqual(["bash", TITLE]);
    expect(text(described[1])).toEqual(["write", WRITE_TITLE]);

    // 卡名与四个按钮名不变；已结算记录没有描述关联
    expect(screen.getAllByRole("group", { name: "需要你的确认" })).toEqual(found);
    expect(screen.getAllByRole("button", { name: "允许" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "拒绝" })).toHaveLength(2);
    expect(
      found.flatMap((card) =>
        within(card)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ),
    ).toEqual(["允许", "拒绝", "允许", "拒绝"]);
    expect(records()).toHaveLength(1);
    expectRecord(records()[0], ALLOWED);
    expect((records()[0] as HTMLElement).hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("composer dock: focus after a card leaves", () => {
  it("F1 moves focus from an answered card to the next higher id, then to the first remaining, then to the composer once it unlocks; a moved focus is still click-guarded", async () => {
    const { fetchMock, source } = await mountPage(
      snapshotWith([approval(7), approval(8), approval(9, { title: OTHER_TITLE })]),
      {
        [approvalPath(7)]: () => settledBody(7, "allow"),
        [approvalPath(8)]: () => settledBody(8, "deny"),
        [approvalPath(9)]: () => settledBody(9, "allow"),
      },
    );
    const [seven, eight, nine] = cards() as [HTMLElement, HTMLElement, HTMLElement];

    await answerFocused(button(eight, "拒绝"));
    expect(bodies(fetchMock, approvalPath(8))).toEqual([{ decision: "deny" }]);
    emitResolved(source, 1, 8, "deny");
    expect(cards()).toEqual([seven, nine]);
    expect(document.activeElement).toBe(button(nine, "允许"));

    // 移过去的焦点不豁免防误点：400 毫秒内对它的点击不作答
    fireEvent.click(button(nine, "允许"));
    passClickGuard(399);
    fireEvent.click(button(nine, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(9))).toEqual([]);
    expect(button(nine, "允许").disabled).toBe(false);
    expect(document.activeElement).toBe(button(nine, "允许"));

    passClickGuard(1);
    fireEvent.click(button(nine, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(9))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 2, 9, "allow");
    expect(cards()).toEqual([seven]);
    expect(document.activeElement).toBe(button(seven, "允许"));

    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([]);
    passClickGuard();
    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 3, 7, "allow");
    expect(cards()).toHaveLength(0);
    // 回合仍在进行：输入框锁定，焦点还没有给它
    expect(composerInput().disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);

    await endTurn(source, 4);
    expect(composerInput().disabled).toBe(false);
    expect(document.activeElement).toBe(composerInput());
  });

  it("F2 gives the same result when the disabled button loses focus to the body right after the answer", async () => {
    const { source } = await mountPage(snapshotWith([approval(7), approval(8)]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
      [approvalPath(8)]: () => settledBody(8, "allow"),
    });
    const [seven, eight] = cards() as [HTMLElement, HTMLElement];

    await answerThenLoseFocus(button(seven, "允许"));
    emitResolved(source, 1, 7, "allow");
    expect(document.activeElement).toBe(button(eight, "允许"));

    passClickGuard();
    await answerThenLoseFocus(button(eight, "允许"));
    emitResolved(source, 2, 8, "allow");
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
    await endTurn(source, 3);
    expect(document.activeElement).toBe(composerInput());
  });

  it("F3 leaves focus where it is when it was outside the card: on 停止 while a card times out, or moved to 停止 after answering", async () => {
    const { source } = await mountPage(snapshotWith([approval(7), approval(8), approval(9)]), {
      [approvalPath(8)]: () => settledBody(8, "allow"),
    });
    const [, eight, nine] = cards() as [HTMLElement, HTMLElement, HTMLElement];

    stopButton().focus();
    emitResolved(source, 1, 7, "timeout");
    expect(cards()).toEqual([eight, nine]);
    expect(document.activeElement).toBe(stopButton());

    // 在卡内作答，结算到达之前把焦点移到了 停止
    passClickGuard();
    await answerFocused(button(eight, "允许"));
    stopButton().focus();
    emitResolved(source, 2, 8, "allow");
    expect(cards()).toEqual([nine]);
    expect(document.activeElement).toBe(stopButton());

    // 最后一张也因超时消失、回合结束：焦点不去输入框
    emitResolved(source, 3, 9, "timeout");
    expect(cards()).toHaveLength(0);
    expect(document.activeElement).toBe(stopButton());
    await endTurn(source, 4);
    expect(composerInput().disabled).toBe(false);
    expect(document.activeElement).not.toBe(composerInput());
  });

  it("F4 drops the deferred composer focus once focus lands elsewhere, even if that element is gone by the time the composer unlocks", async () => {
    const { source } = await mountPage(snapshotWith([approval(7)]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
    });
    await answerFocused(button(cards()[0] as HTMLElement, "允许"));
    emitResolved(source, 1, 7, "allow");
    expect(cards()).toHaveLength(0);
    expect(composerInput().disabled).toBe(true);

    // 等解锁期间用户把焦点移到 停止；回合结束时 停止 卸载，焦点掉回 body
    stopButton().focus();
    expect(document.activeElement).toBe(stopButton());
    await endTurn(source, 2);
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
    expect(composerInput().disabled).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("F5 never takes focus when a card appears", async () => {
    const { source } = await mountPage(snapshotWith([]));
    stopButton().focus();
    emitRequest(source, 1, 7);
    expect(cards()).toHaveLength(1);
    expect(document.activeElement).toBe(stopButton());
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    expect(cards()).toHaveLength(2);
    expect(document.activeElement).toBe(stopButton());

    // 焦点在一张卡上时另一张卡出现：也不动
    const [seven] = cards() as [HTMLElement];
    button(seven, "拒绝").focus();
    emitRequest(source, 3, 9);
    expect(cards()).toHaveLength(3);
    expect(document.activeElement).toBe(button(seven, "拒绝"));
  });

  it("F6 moves focus to the remaining card when the focused, unanswered card times out, still click-guarded", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([approval(7), approval(8)]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
    });
    const [seven, eight] = cards() as [HTMLElement, HTMLElement];

    button(eight, "拒绝").focus();
    emitResolved(source, 1, 8, "timeout");
    expect(cards()).toEqual([seven]);
    expect(document.activeElement).toBe(button(seven, "允许"));

    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([]);
    passClickGuard();
    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
  });
});
