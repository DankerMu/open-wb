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
import { chatSnapshot, historyUser } from "./chat-stream-support.js";

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
  vi.useRealTimers();
});

describe("composer dock: position and structure", () => {
  it("D1 keeps three pending cards, one with a 50-line title, in one dock outside the thread scroller and before the composer", async () => {
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
