// 工具调用组（chat-web 消息线程「工具调用组默认收起与失败自动展开」、「工具段摘要与折叠」；design D4、D13，
// change chat-interleaved-segments D11：owner 裁定 B6 归类摘要、B7 含失败也默认收起、只随点击变化）。
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
  settle,
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
    bodyOffset: null,
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
    error: null,
    thinkingMs: null,
    thinkingSegments: [],
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

/** 摘要的可访问名以某一类的计数开头（B6）；展开后步骤卡的 `原始输出` 按钮不匹配。 */
const SUMMARY = /^(执行|读取|新建|修改|搜索|其它) \d+ /u;

/** 组的展开/收起控件：消息内唯一带 `aria-expanded` 的、名字是工具段摘要的按钮。 */
function trigger(article: HTMLElement): HTMLElement {
  return within(article).getByRole("button", { name: SUMMARY });
}

/**
 * 「不着色」（B7；jsdom 不加载 Tailwind，量不到颜色，按结构断言）：后缀与其余摘要是 `tool-summary` 里同一个
 * 文本节点，不单独成元素；该元素不带 `text-*` 类。
 */
function expectUncolouredSummary(toggle: HTMLElement, text: string) {
  const summary = toggle.querySelector('[data-slot="tool-summary"]') as HTMLElement;
  expect([...summary.childNodes].map((node) => [node.nodeType, node.textContent])).toEqual([
    [Node.TEXT_NODE, text],
  ]);
  expect([...summary.classList].filter((name) => name.startsWith("text-"))).toEqual([]);
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

describe("tool-call group: collapsed by default, failed or not; only a click changes it", () => {
  it("opens a snapshot with the done and the failed group collapsed and no group without steps", async () => {
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
    expect(collapsed.textContent).toBe("执行 1 条命令、读取 1 个文件、新建 1 个文件");
    expect(cardNames(allDone)).toEqual([]);
    expect(within(allDone).queryAllByRole("status")).toEqual([]);
    expect(allDone.querySelector(GROUP)?.textContent).toBe(
      "执行 1 条命令、读取 1 个文件、新建 1 个文件",
    );
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

    expect(trigger(withFailure).getAttribute("aria-expanded")).toBe("false");
    expect(trigger(withFailure).textContent).toBe("执行 1 条命令、读取 1 个文件，1 步失败");
    expect(cardNames(withFailure)).toEqual([]);
    fireEvent.click(trigger(withFailure));
    expect(cardNames(withFailure)).toEqual(["read", "bash"]);
    const failedBadge = within(withFailure).getByRole("status", { name: "bash 失败" });
    expect(failedBadge.textContent).toBe("失败");
    expect(failedBadge.className).toContain("text-(--wb-status-error-text)");

    expect(noSteps.querySelector(GROUP)).toBeNull();
    expect(within(noSteps).queryByRole("button", { name: SUMMARY })).toBeNull();
  });

  it("stays collapsed through a failed step.end, deltas and a done step.end; a manual expansion survives a new failure", async () => {
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
    expect(toggle.textContent).toBe("执行 1 条命令、读取 1 个文件、新建 1 个文件，进行中");
    expect(cardNames(article)).toEqual([]);

    const source = await openStream();
    const end = (seq: number, stepId: number, status: "done" | "failed") =>
      act(() =>
        source.emitData("step.end", `1:${seq}`, { messageId: 0, stepId, status, output: "x" }),
      );

    end(4, 2, "failed");
    await waitFor(() =>
      expect(trigger(article).textContent).toBe(
        "执行 1 条命令、读取 1 个文件、新建 1 个文件，1 步失败，进行中",
      ),
    );
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
    expect(cardNames(article)).toEqual([]);
    expect(within(article).queryByRole("status", { name: "bash 失败" })).toBeNull();

    act(() => source.emitData("text.delta", "1:5", { messageId: 0, delta: "……" }));
    end(6, 1, "done");
    await waitFor(() => expect(article.textContent).toContain("处理中……"));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
    expect(cardNames(article)).toEqual([]);

    fireEvent.click(trigger(article));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("true");
    expect(within(article).getByRole("status", { name: "bash 失败" })).toBeTruthy();

    end(7, 3, "failed");
    await waitFor(() =>
      expect(trigger(article).textContent).toBe(
        "执行 1 条命令、读取 1 个文件、新建 1 个文件，2 步失败",
      ),
    );
    expect(trigger(article).getAttribute("aria-expanded")).toBe("true");
    expect(within(article).getByRole("status", { name: "read 已完成" })).toBeTruthy();
    expect(within(article).getByRole("status", { name: "write 失败" })).toBeTruthy();
  });

  it("keeps a manual expansion across deltas and a new step, and counts every step in the summary", async () => {
    mount(
      chatSnapshot({
        content: "处理中",
        steps: [step(1, "read", "running")],
        cursor: { epoch: 1, seq: 3 },
      }),
    );
    const [article] = (await assistants(1)) as [HTMLElement];
    expect(trigger(article).textContent).toBe("读取 1 个文件，进行中");
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
        bodyOffset: 5,
        approvalId: null,
      });
    });
    await waitFor(() =>
      expect(trigger(article).textContent).toBe("执行 1 条命令、读取 1 个文件，进行中"),
    );
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
    await waitFor(() => expect(trigger(article).textContent).toBe("读取 1 个文件"));
    expect(label().classList.contains("shimmer")).toBe(false);
    expect(loader()).toBeNull();
  });

  it("keeps the summary in a truncating span inside the trigger; a long unknown tool name does not reach it", async () => {
    const name = `mcp__${"very_long_tool_name_".repeat(12)}run`;
    mount({
      session: runningSession("done"),
      messages: [historyUser, assistant(0, [step(1, name, "done")])],
      streamCursor: { epoch: 1, seq: 0 },
      todo: null,
    });
    const [article] = (await assistants(1)) as [HTMLElement];
    const toggle = within(article).getByRole("button", { name: "其它 1 步" });
    const summary = toggle.querySelector('[data-slot="tool-summary"]') as HTMLElement;
    expect(summary.textContent).toBe("其它 1 步");
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
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger(article));
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
        bodyOffset: 0,
        approvalId: null,
      }),
    );
    await waitFor(() => expect(trigger(article).textContent).toBe("读取 1 个文件，进行中"));
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
  });

  it("失败与进行中后缀：one uncoloured text node carries both suffixes and the spinner follows running", async () => {
    mount(
      chatSnapshot({
        content: "处理中",
        steps: [step(1, "bash", "failed"), step(2, "bash", "done"), step(3, "read", "running")],
        cursor: { epoch: 1, seq: 3 },
      }),
    );
    const [article] = (await assistants(1)) as [HTMLElement];
    const running = "执行 2 条命令、读取 1 个文件，1 步失败，进行中";
    const toggle = within(article).getByRole("button", { name: running });
    const loader = () => article.querySelector('[data-slot="tool-group-trigger-loader"]');
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(loader()).not.toBeNull();
    expectUncolouredSummary(toggle, running);

    const source = await openStream();
    act(() =>
      source.emitData("step.end", "1:4", { messageId: 0, stepId: 3, status: "done", output: "x" }),
    );
    const ended = "执行 2 条命令、读取 1 个文件，1 步失败";
    await waitFor(() => expect(trigger(article).textContent).toBe(ended));
    expect(loader()).toBeNull();
    expectUncolouredSummary(within(article).getByRole("button", { name: ended }), ended);
    expect(trigger(article).getAttribute("aria-expanded")).toBe("false");
  });

  it("展开态只随用户点击变化：new failures, a new step and an in-place snapshot reinstall keep the user's choice", async () => {
    const live = (steps: Step[], seq: number) =>
      chatSnapshot({ content: "处理中", steps, cursor: { epoch: 1, seq } });
    let current = live([step(1, "read", "running")], 3);
    const page = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [current.session] }),
      [messagesPath]: () => jsonResponse(current),
    });
    const [article] = (await assistants(1)) as [HTMLElement];
    const source = await openStream();
    const expanded = () => trigger(article).getAttribute("aria-expanded");
    const run = (seq: number, item: Step) => {
      source.emitData("step.start", `1:${seq}`, {
        messageId: 0,
        stepId: item.id,
        name: item.name,
        detail: item.detail,
        bodyOffset: 3,
        approvalId: null,
      });
      source.emitData("step.end", `1:${seq + 1}`, {
        messageId: 0,
        stepId: item.id,
        status: item.status,
        output: item.output,
      });
    };
    const bash = step(2, "bash", "failed");
    const write = step(3, "write", "failed");

    // 收起时到达一个新的失败步骤：仍收起。
    act(() => run(4, bash));
    await waitFor(() =>
      expect(trigger(article).textContent).toBe("执行 1 条命令、读取 1 个文件，1 步失败，进行中"),
    );
    expect(expanded()).toBe("false");

    // 手动展开后，同一工具段并入新步骤、又一个失败：仍展开。
    fireEvent.click(trigger(article));
    expect(expanded()).toBe("true");
    act(() => run(6, write));
    await waitFor(() =>
      expect(trigger(article).textContent).toBe(
        "执行 1 条命令、读取 1 个文件、新建 1 个文件，2 步失败，进行中",
      ),
    );
    expect(expanded()).toBe("true");
    expect(cardNames(article)).toEqual(["read", "bash", "write"]);

    // 快照原地重新安装（内容与已收到的相同）：同一个消息元素，展开态不变。
    current = live([step(1, "read", "running"), bash, write], 7);
    const reads = page.fetchMock.mock.calls.length;
    act(() => latestSource().emitGap());
    await waitFor(() => expect(page.fetchMock.mock.calls.length).toBeGreaterThan(reads));
    await act(async () => {
      for (let turns = 0; turns < 3; turns += 1) await settle();
    });
    expect(screen.getAllByRole("article", { name: "助手" })).toEqual([article]);
    expect(expanded()).toBe("true");
    expect(cardNames(article)).toEqual(["read", "bash", "write"]);

    // 用户收起后，新的失败不再把它撑开，直到下一次点击。
    fireEvent.click(trigger(article));
    expect(expanded()).toBe("false");
    const after = latestSource();
    act(() => after.emitOpen());
    act(() =>
      after.emitData("step.end", "1:8", { messageId: 0, stepId: 1, status: "failed", output: "x" }),
    );
    await waitFor(() =>
      expect(trigger(article).textContent).toBe(
        "执行 1 条命令、读取 1 个文件、新建 1 个文件，3 步失败",
      ),
    );
    expect(expanded()).toBe("false");
    fireEvent.click(trigger(article));
    expect(expanded()).toBe("true");
  });
});
