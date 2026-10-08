// 工具调用组（chat-web 消息线程「工具调用组默认收起与失败自动展开」；design D4、D13）。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, expandToolGroups, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  historyUser,
  latestSource,
  runningSession,
  SESSION_ID,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

type Message = ChatMessageSnapshot["messages"][number];
type Step = Message["steps"][number];

const messagesPath = `/api/sessions/${SESSION_ID}/messages`;
const GROUP = '[data-slot="tool-group-root"]';

afterEach(() => {
  cleanupChatPage();
});

function step(id: number, name: string, status: Step["status"]): Step {
  return {
    id,
    ordinal: id,
    name,
    detail: `{"path":"${name}.md"}`,
    output: status === "running" ? "" : `${name} output`,
    status,
    changes: null,
  };
}

function assistant(id: number, steps: Step[], status: Message["status"] = "done"): Message {
  return {
    id,
    role: "assistant",
    undo: null,
    attachments: [],
    approvals: [],
    content: `回答 ${id}`,
    status,
    createdAt: id,
    steps,
    thinking: null,
  };
}

function mount(snapshot: ChatMessageSnapshot) {
  return renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [messagesPath]: () => jsonResponse(snapshot),
  });
}

async function assistants(count: number): Promise<HTMLElement[]> {
  await waitFor(() => expect(screen.getAllByRole("article", { name: "助手" })).toHaveLength(count));
  return screen.getAllByRole("article", { name: "助手" });
}

/** 组的展开/收起控件：消息内唯一带 `aria-expanded` 的、文本含步骤数的按钮。 */
function trigger(article: HTMLElement): HTMLElement {
  return within(article).getByRole("button", { name: /个步骤/ });
}

function cardNames(article: HTMLElement): (string | null)[] {
  return within(article)
    .queryAllByRole("region")
    .map((card) => card.getAttribute("aria-label"));
}

async function openStream() {
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  const source = latestSource();
  act(() => source.emitOpen());
  return source;
}

describe("tool-call group: collapsed by default, expanded on failure", () => {
  it("opens a snapshot with the done group collapsed, the failed group expanded and no group without steps", async () => {
    mount({
      session: runningSession("done"),
      messages: [
        historyUser,
        assistant(0, [step(1, "read", "done"), step(2, "bash", "done"), step(3, "write", "done")]),
        { ...historyUser, id: 1, createdAt: 1 },
        assistant(2, [step(4, "read", "done"), step(5, "bash", "failed")], "failed"),
        { ...historyUser, id: 3, createdAt: 3 },
        assistant(4, []),
      ],
      streamCursor: { epoch: 1, seq: 0 },
      todo: null,
    });
    const [allDone, withFailure, noSteps] = (await assistants(3)) as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ];

    expect(allDone.querySelectorAll(GROUP)).toHaveLength(1);
    const collapsed = trigger(allDone);
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    expect(collapsed.textContent).toBe("3 个步骤 · write 已完成");
    expect(cardNames(allDone)).toEqual([]);
    expect(within(allDone).queryAllByRole("status")).toEqual([]);
    expect(allDone.querySelector(GROUP)?.textContent).toBe("3 个步骤 · write 已完成");
    // 组在正文之后（助手块次序）。
    expect(allDone.querySelector('[data-slot="message-body"]')?.nextElementSibling).toBe(
      allDone.querySelector(GROUP),
    );

    fireEvent.click(collapsed);
    expect(collapsed.getAttribute("aria-expanded")).toBe("true");
    expect(cardNames(allDone)).toEqual(["read", "bash", "write"]);
    fireEvent.click(collapsed);
    expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    expect(cardNames(allDone)).toEqual([]);

    expect(trigger(withFailure).getAttribute("aria-expanded")).toBe("true");
    expect(trigger(withFailure).textContent).toBe("2 个步骤 · bash 失败");
    expect(cardNames(withFailure)).toEqual(["read", "bash"]);
    const failedBadge = within(withFailure).getByRole("status", { name: "bash 失败" });
    expect(failedBadge.textContent).toBe("失败");
    expect(failedBadge.className).toContain("text-(--wb-status-error-text)");

    expect(noSteps.querySelector(GROUP)).toBeNull();
    expect(within(noSteps).queryByRole("button", { name: /个步骤/ })).toBeNull();
  });

  it("expands on a failed step.end, stays collapsed after a manual collapse and reopens on a new failure", async () => {
    mount(
      chatSnapshot({
        content: "处理中",
        steps: [
          step(1, "read", "running"),
          step(2, "bash", "running"),
          step(3, "write", "running"),
        ],
        cursor: { epoch: 1, seq: 3 },
      }),
    );
    const [article] = (await assistants(1)) as [HTMLElement];
    const toggle = trigger(article);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("3 个步骤 · write 运行中");
    expect(cardNames(article)).toEqual([]);

    const source = await openStream();
    const end = (seq: number, stepId: number, status: "done" | "failed") =>
      act(() =>
        source.emitData("step.end", `1:${seq}`, { messageId: 0, stepId, status, output: "x" }),
      );

    end(4, 2, "failed");
    await waitFor(() => expect(trigger(article).getAttribute("aria-expanded")).toBe("true"));
    expect(cardNames(article)).toEqual(["read", "bash", "write"]);
    expect(within(article).getByRole("status", { name: "bash 失败" })).toBeTruthy();

    fireEvent.click(trigger(article));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");

    act(() => source.emitData("text.delta", "1:5", { messageId: 0, delta: "……" }));
    end(6, 1, "done");
    await waitFor(() => expect(article.textContent).toContain("处理中……"));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
    expect(cardNames(article)).toEqual([]);

    end(7, 3, "failed");
    await waitFor(() => expect(trigger(article).getAttribute("aria-expanded")).toBe("true"));
    expect(trigger(article).textContent).toBe("3 个步骤 · write 失败");
    expect(within(article).getByRole("status", { name: "read 已完成" })).toBeTruthy();
    expect(within(article).getByRole("status", { name: "write 失败" })).toBeTruthy();
  });

  it("keeps a manual expansion across deltas and follows the last step in the summary", async () => {
    mount(
      chatSnapshot({
        content: "处理中",
        steps: [step(1, "read", "running")],
        cursor: { epoch: 1, seq: 3 },
      }),
    );
    const [article] = (await assistants(1)) as [HTMLElement];
    expect(trigger(article).textContent).toBe("1 个步骤 · read 运行中");
    expandToolGroups(article);
    expect(cardNames(article)).toEqual(["read"]);
    expect(within(article).getByRole("status", { name: "read 运行中" }).className).toContain(
      "text-(--wb-brand-primary-deep)",
    );

    const source = await openStream();
    act(() => {
      source.emitData("text.delta", "1:4", { messageId: 0, delta: "……" });
      source.emitData("step.end", "1:5", { messageId: 0, stepId: 1, status: "done", output: "x" });
      source.emitData("step.start", "1:6", {
        messageId: 0,
        stepId: 2,
        name: "bash",
        detail: '{"command":"ls"}',
      });
    });
    await waitFor(() => expect(trigger(article).textContent).toBe("2 个步骤 · bash 运行中"));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("true");
    expect(cardNames(article)).toEqual(["read", "bash"]);
  });

  it("marks the summary as in progress only while a step is running", async () => {
    mount(
      chatSnapshot({
        content: "处理中",
        steps: [step(1, "read", "running")],
        cursor: { epoch: 1, seq: 3 },
      }),
    );
    const [article] = (await assistants(1)) as [HTMLElement];
    const label = () =>
      article.querySelector('[data-slot="tool-group-trigger-label"]') as HTMLElement;
    const loader = () => article.querySelector('[data-slot="tool-group-trigger-loader"]');
    expect(label().classList.contains("shimmer")).toBe(true);
    expect(label().classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(loader()).not.toBeNull();

    const source = await openStream();
    act(() =>
      source.emitData("step.end", "1:4", { messageId: 0, stepId: 1, status: "done", output: "x" }),
    );
    await waitFor(() => expect(trigger(article).textContent).toBe("1 个步骤 · read 已完成"));
    expect(label().classList.contains("shimmer")).toBe(false);
    expect(loader()).toBeNull();
  });

  it("truncates a long summary inside the trigger and keeps the full text as its name", async () => {
    const name = `mcp__${"very_long_tool_name_".repeat(12)}run`;
    mount({
      session: runningSession("done"),
      messages: [historyUser, assistant(0, [step(1, name, "done")])],
      streamCursor: { epoch: 1, seq: 0 },
      todo: null,
    });
    const [article] = (await assistants(1)) as [HTMLElement];
    const toggle = within(article).getByRole("button", { name: `1 个步骤 · ${name} 已完成` });
    const summary = toggle.querySelector('[data-slot="tool-summary"]') as HTMLElement;
    expect(summary.textContent).toBe(`1 个步骤 · ${name} 已完成`);
    expect([...summary.classList]).toEqual(expect.arrayContaining(["block", "truncate"]));
    // 拷入的 label 是弹性子项，要能收窄省略号才生效，尾部的折叠箭头才留在组内。
    expect(summary.parentElement?.dataset.slot).toBe("tool-group-trigger-label");
    expect(toggle.classList.contains("*:min-w-0")).toBe(true);
  });

  it("starts collapsed again when a new turn resets the steps of an expanded group", async () => {
    mount({
      session: runningSession("failed"),
      messages: [historyUser, assistant(0, [step(1, "bash", "failed")], "failed")],
      streamCursor: { epoch: 1, seq: 3 },
      todo: null,
    });
    const [article] = (await assistants(1)) as [HTMLElement];
    expect(trigger(article).getAttribute("aria-expanded")).toBe("true");

    const source = await openStream();
    act(() => source.emitData("turn.start", "1:4", { messageId: 0 }));
    await waitFor(() => expect(article.querySelector(GROUP)).toBeNull());
    act(() =>
      source.emitData("step.start", "1:5", {
        messageId: 0,
        stepId: 2,
        name: "read",
        detail: "a.md",
      }),
    );
    await waitFor(() => expect(trigger(article).textContent).toBe("1 个步骤 · read 运行中"));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
  });
});
