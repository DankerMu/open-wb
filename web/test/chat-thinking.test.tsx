/**
 * Issue #534 `thinking.delta` decoding/reduction and the 深度思考过程 fold (parent tasks 7.4),
 * T1–T12 of openspec/changes/thinking-fold-block/design.md. Seams: `chatStateFromSnapshot` /
 * `applyChatEvent` on frozen inputs, `connectSessionEvents` over the fake EventSource, the jsdom
 * chat page, and the static CSS text. Expected values are literals from the spec deltas.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  connectChat,
  type FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";
import { blockBody, readRepoFile, ruleBody, stripComments } from "./ui-support.js";

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type Status = Message["status"];

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const SUMMARY = "深度思考过程";
const TRUNCATED = "想了很久很久…（已截断）";
const PLAIN = "**粗** <b>x</b>\n  缩进";
const BASH_STEP: Message["steps"][number] = {
  id: 11,
  ordinal: 0,
  name: "bash",
  detail: '{"command":"ls"}',
  output: "a.md",
  status: "done",
  changes: null,
};
const SETTLED_APPROVAL: Message["approvals"][number] = {
  id: 7,
  tool: "bash",
  title: "Allow tool: bash",
  requestedAt: 1_750_000_000_000,
  expiresAt: 1_750_000_060_000,
  decision: "allow",
};

function assistant(id: number, status: Status, fields: Partial<Message> = {}): Message {
  const base = { content: "", thinking: null, createdAt: id, steps: [], approvals: [] };
  return { id, role: "assistant", status, ...base, ...fields };
}

/** Session in `status` holding `historyUser` (id -3) and `assistants`; stream cursor `1:3`. */
function sessionSnapshot(status: Snapshot["session"]["status"], ...assistants: Message[]) {
  const snapshot: Snapshot = {
    streamCursor: { epoch: 1, seq: 3 },
    session: { ...chatSnapshot().session, status },
    messages: [historyUser, ...assistants],
  };
  return snapshot;
}

/** One assistant (id 0) whose status follows the session's. */
function turnSnapshot(status: "running" | "done" | "stopped", fields: Partial<Message> = {}) {
  return sessionSnapshot(status, assistant(0, status, fields));
}

/** Freezes every nested object so a reducer that mutates its input throws. */
function frozen<T>(value: T): T {
  for (const child of typeof value === "object" && value !== null ? Object.values(value) : []) {
    frozen(child);
  }
  Object.freeze(value);
  return value;
}

const frozenView = (snapshot: Snapshot): ChatState => frozen(chatStateFromSnapshot(snapshot));

function thinkingDelta(messageId: number, delta: string): ChatEvent {
  return { type: "thinking.delta", data: { messageId, delta } };
}

function messageOf(state: ChatState, id = 0) {
  const found = state.messages.find((message) => message.id === id);
  if (!found) throw new Error(`视图里没有消息 ${id}`);
  return found;
}

/** Connector with the `1:3` snapshot installed: one snapshot load so far, no events. */
async function installedConnector() {
  const snapshot = turnSnapshot("running");
  const connector = connectChat(snapshot);
  connector.source.emitOpen();
  connector.loads.at(-1)?.resolve(snapshot);
  await settle();
  expect([connector.loads.length, connector.snapshots.length]).toEqual([1, 1]);
  return connector;
}

afterEach(() => {
  cleanupChatPage();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

describe("thinking.delta through the connector", () => {
  it("T1 drops thinking.delta at the snapshot cursor and delivers its successor", async () => {
    const connector = await installedConnector();

    connector.source.emitData("thinking.delta", "1:3", { messageId: 0, delta: "旧" });
    expect(connector.events).toEqual([]);
    connector.source.emitData("thinking.delta", "1:4", { messageId: 0, delta: "想" });

    expect(connector.events).toStrictEqual([
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
    ]);
    expect(messageOf(connector.state).thinking).toBe("想");
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  it("T1 ignores an unknown event type without a resync (regression guard)", async () => {
    const connector = await installedConnector();

    connector.source.emitData("foo.bar", "1:5", { messageId: 0, delta: "x" });

    expect(connector.events).toEqual([]);
    expect(connector.loads).toHaveLength(1);
    expect(connector.errors).toEqual([]);
  });

  const rejected: Array<[string, string]> = [
    ["an empty delta", JSON.stringify({ messageId: 0, delta: "" })],
    ["a numeric delta", JSON.stringify({ messageId: 0, delta: 1 })],
    ["a missing delta", JSON.stringify({ messageId: 0 })],
    ["an extra key", JSON.stringify({ messageId: 0, delta: "想", extra: 1 })],
    ["messageId 1.5", JSON.stringify({ messageId: 1.5, delta: "想" })],
    ["a string messageId", JSON.stringify({ messageId: "0", delta: "想" })],
    ["an unsafe messageId", JSON.stringify({ messageId: 2 ** 53, delta: "想" })],
    ["data that is not JSON", "{not json"],
  ];

  it.each(rejected)("T2 %s triggers a snapshot resync and is not delivered", async (_name, raw) => {
    const connector = await installedConnector();

    connector.source.emitNamed("thinking.delta", raw, "1:4");

    expect(connector.loads).toHaveLength(2);
    expect(connector.events).toEqual([]);
    expect(connector.errors).toEqual([]);
  });
});

describe("thinking snapshot mapping and reduction", () => {
  it("T3 appends deltas to the running assistant and changes nothing else", () => {
    const snapshot = turnSnapshot("running", { content: "正文", steps: [BASH_STEP] });
    const state = frozenView(snapshot);
    const before = structuredClone(state);

    const first = frozen(applyChatEvent(state, thinkingDelta(0, "先")));
    const second = applyChatEvent(first, thinkingDelta(0, "想"));

    expect(messageOf(first).thinking).toBe("先");
    const message = messageOf(second);
    expect(message.thinking).toBe("先想");
    expect(message.content).toBe("正文");
    expect(message.status).toBe("running");
    expect(message.steps).toBe(messageOf(state).steps);
    expect(second.status).toBe("running");
    expect(second.messages).toHaveLength(2);
    expect(second.messages[0]).toBe(state.messages[0]);
    expect(state).toEqual(before);
    expect(messageOf(state).thinking).toBeNull();
  });

  it("T3 treats a null snapshot thinking as empty and leaves the session status alone", () => {
    const state = frozenView(turnSnapshot("done", { content: "答" }));

    const next = applyChatEvent(state, thinkingDelta(0, "x"));

    expect(messageOf(next).thinking).toBe("x");
    expect(messageOf(next).status).toBe("done");
    expect(next.status).toBe("done");
  });

  it("T4 carries the snapshot thinking value for value", () => {
    const snapshot = sessionSnapshot(
      "done",
      assistant(0, "done", { thinking: "想过" }),
      assistant(1, "done"),
      assistant(2, "done", { thinking: "" }),
    );

    const state = chatStateFromSnapshot(frozen(structuredClone(snapshot)));

    expect(state.messages.map((message) => [message.role, message.thinking])).toStrictEqual([
      ["user", null],
      ["assistant", "想过"],
      ["assistant", null],
      ["assistant", ""],
    ]);
  });

  it("T5 a repeated turn.start resets thinking to null and clears the steps", () => {
    const state = frozenView(turnSnapshot("running", { thinking: "先想", steps: [BASH_STEP] }));

    const restarted = applyChatEvent(state, { type: "turn.start", data: { messageId: 0 } });

    expect(messageOf(restarted).thinking).toBeNull();
    expect(messageOf(restarted).steps).toEqual([]);
    expect(restarted.messages[0]).toBe(state.messages[0]);
  });

  it("T5 a thinking.delta aimed at a user message returns the same state reference", () => {
    const state = frozenView(turnSnapshot("running", { thinking: "先" }));

    expect(applyChatEvent(state, thinkingDelta(historyUser.id, "y"))).toBe(state);
  });

  it("T5 an unknown messageId appends a running assistant holding that delta", () => {
    const state = frozenView(turnSnapshot("done", { content: "答" }));

    const next = applyChatEvent(state, thinkingDelta(99, "y"));

    expect(next.messages).toHaveLength(3);
    expect(next.messages.at(-1)).toStrictEqual({
      id: 99,
      role: "assistant",
      status: "running",
      content: "",
      thinking: "y",
      steps: [],
      approvals: [],
      error: null,
    });
    expect(next.status).toBe("done");
    expect(next.messages[0]).toBe(state.messages[0]);
    expect(next.messages[1]).toBe(state.messages[1]);
  });
});

/** Opens the session, lets the live source recover once; events then start at `1:4`. */
async function mountThread(snapshot: Snapshot) {
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [MESSAGES]: () => jsonResponse(snapshot),
  });
  await screen.findAllByRole("article", { name: "助手" });
  const source = latestSource();
  await reopen(source);
  return { source, reads: () => calls(fetchMock, MESSAGES).length };
}

/** A (re)opened source reloads the full snapshot: the page's resync path. */
async function reopen(source: FakeEventSource) {
  act(() => source.emitOpen());
  for (let round = 0; round < 3; round += 1) {
    await act(settle);
  }
}

function emit(source: FakeEventSource, seq: number, type: string, data: Record<string, unknown>) {
  act(() => source.emitData(type, `1:${seq}`, { messageId: 0, ...data }));
}

function articles() {
  return screen.getAllByRole("article", { name: "助手" });
}

function mainOf(article: HTMLElement) {
  const main = article.querySelector(".chat-msg-main");
  if (!main) throw new Error("助手消息缺少 .chat-msg-main");
  return main;
}

function foldOf(article = articles()[0]) {
  return article?.querySelector<HTMLDetailsElement>("details.thinking-block") ?? null;
}

/** The fold of the first assistant; throws when it is not rendered. */
function fold() {
  const block = foldOf();
  if (!block) throw new Error("未渲染 details.thinking-block");
  return block;
}

function bodyText(block = fold()) {
  return block.querySelector("div.thinking-body")?.textContent;
}

function toggle(block = fold()) {
  fireEvent.click(block.querySelector("summary") as HTMLElement);
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/** Clicks 复制 on the first assistant and returns every `writeText` argument list. */
async function copiedTexts(writeText: ReturnType<typeof stubClipboard>) {
  fireEvent.click(within(articles()[0] as HTMLElement).getByRole("button", { name: "复制" }));
  await screen.findByText("已复制到剪贴板");
  return writeText.mock.calls;
}

describe("深度思考过程 fold on the chat page", () => {
  it("T6 opens while streaming, collapses on turn.end and stays out of 复制", async () => {
    const writeText = stubClipboard();
    const { source } = await mountThread(turnSnapshot("running"));
    expect(foldOf()).toBeNull();

    emit(source, 4, "thinking.delta", { delta: "先想一想" });

    const block = fold();
    const main = mainOf(articles()[0] as HTMLElement);
    const text = main.querySelector(".chat-md") as Element;
    expect(main.firstElementChild).toBe(block);
    expect(block.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const summary = block.querySelector("summary") as HTMLElement;
    expect(summary.textContent).toBe(SUMMARY);
    const icon = summary.firstElementChild as Element;
    expect(icon.matches("svg.ui-icon.lucide-chevron-right")).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(block.open).toBe(true);
    expect(bodyText()).toBe("先想一想");

    emit(source, 5, "text.delta", { delta: "答案" });
    emit(source, 6, "turn.end", { status: "done" });

    expect(fold()).toBe(block);
    expect(block.open).toBe(false);
    expect(bodyText()).toBe("先想一想");
    expect(text.textContent).toBe("答案");
    expect(await copiedTexts(writeText)).toEqual([["答案"]]);
  });

  it("T7 renders a collapsed fold only for non-empty snapshot thinking, marker verbatim", async () => {
    await mountThread(
      sessionSnapshot(
        "done",
        assistant(0, "done", { content: "一", thinking: TRUNCATED }),
        assistant(1, "done", { content: "二" }),
        assistant(2, "done", { content: "三", thinking: "" }),
      ),
    );

    expect(articles()).toHaveLength(3);
    expect(articles().map((article) => foldOf(article) !== null)).toEqual([true, false, false]);
    const block = fold();
    expect(block.open).toBe(false);

    toggle();

    expect(block.open).toBe(true);
    expect(bodyText()).toBe("想了很久很久…（已截断）");
    expect(bodyText()?.endsWith("…（已截断）")).toBe(true);
  });

  it("T8 keeps the fold collapsed by the user while more events arrive", async () => {
    const { source } = await mountThread(turnSnapshot("running"));
    emit(source, 4, "thinking.delta", { delta: "一" });
    const block = fold();
    expect(block.open).toBe(true);

    toggle();
    expect(block.open).toBe(false);
    emit(source, 5, "thinking.delta", { delta: "二" });
    emit(source, 6, "thinking.delta", { delta: "三" });
    emit(source, 7, "text.delta", { delta: "正文" });
    emit(source, 8, "step.start", { stepId: 21, name: "bash", detail: "ls" });

    expect(screen.getByRole("region", { name: "bash" })).toBeTruthy();
    expect(fold()).toBe(block);
    expect(block.open).toBe(false);

    toggle();

    expect(block.open).toBe(true);
    expect(bodyText()).toBe("一二三");
  });

  it("T8 keeps a done fold expanded by the user across a same-snapshot resync", async () => {
    const { reads, source } = await mountThread(
      turnSnapshot("done", { content: "答", thinking: "想过" }),
    );
    const block = fold();
    expect(block.open).toBe(false);
    toggle();
    expect(block.open).toBe(true);
    const before = reads();

    await reopen(source);

    expect(reads()).toBe(before + 1);
    expect(fold()).toBe(block);
    expect(block.open).toBe(true);
    expect(bodyText()).toBe("想过");
  });

  it("T9 opens a running snapshot message and collapses on turn.end stopped", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "快照里的思考" }));
    const block = fold();
    expect(block.open).toBe(true);
    expect(bodyText()).toBe("快照里的思考");

    emit(source, 4, "turn.end", { status: "stopped" });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "助手消息 已停止" })).toBeTruthy(),
    );
    expect(block.open).toBe(false);
    expect(bodyText()).toBe("快照里的思考");
  });

  it("T9 collapses on error followed by turn.end failed", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "想到一半" }));
    const block = fold();
    expect(block.open).toBe(true);

    emit(source, 4, "error", { message: "上游失败" });
    expect(screen.getByRole("alert").textContent).toBe("上游失败");
    expect(block.open).toBe(false);
    emit(source, 5, "turn.end", { status: "failed" });

    expect(fold()).toBe(block);
    expect(block.open).toBe(false);
    expect(bodyText()).toBe("想到一半");
  });

  it("T9 removes the fold when the same message starts a new turn", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "上一轮的思考" }));
    expect(fold().open).toBe(true);

    emit(source, 4, "turn.start", {});

    expect(articles()).toHaveLength(1);
    expect(foldOf()).toBeNull();
  });

  it("T10 orders fold, approvals, body, step, stopped badge and actions", async () => {
    const writeText = stubClipboard();
    await mountThread(
      turnSnapshot("stopped", {
        content: "部分回答",
        thinking: "先想一想",
        steps: [BASH_STEP],
        approvals: [SETTLED_APPROVAL],
      }),
    );
    const article = articles()[0] as HTMLElement;
    const parts = [...mainOf(article).children];

    expect(parts.map((part) => `${part.localName}.${part.className}`)).toEqual([
      "details.thinking-block",
      "div.chat-approvals",
      "div.chat-md",
      "section.chat-step",
      "p.chat-msg-stopped",
      "div.chat-msg-actions",
    ]);
    expect(fold().open).toBe(false);
    expect(within(parts[1] as HTMLElement).getAllByRole("group")).toHaveLength(1);
    expect(parts[2]?.textContent).toBe("部分回答");
    expect(within(article).getByRole("region", { name: "bash" })).toBe(parts[3]);
    expect(within(article).getByRole("status", { name: "助手消息 已停止" })).toBe(parts[4]);
    expect(await copiedTexts(writeText)).toEqual([["部分回答"]]);
  });

  it("T11 renders thinking as plain text, never as Markdown or HTML", async () => {
    await mountThread(turnSnapshot("done", { content: "答", thinking: PLAIN }));
    const block = fold();

    expect(bodyText()).toBe("**粗** <b>x</b>\n  缩进");
    expect(block.querySelectorAll("strong, b")).toHaveLength(0);
    expect(block.querySelector("div.thinking-body")?.childElementCount).toBe(0);
    const css = stripComments(readRepoFile("web/src/features/chat/messages.css"));
    expect(ruleBody(css, ".thinking-body")).toContain("white-space: pre-wrap");
  });
});

describe("thinking fold static styles", () => {
  const css = () => stripComments(readRepoFile("web/src/features/chat/messages.css"));

  it("T12 hides the default marker, rotates the open chevron and honours reduced motion", () => {
    expect(ruleBody(css(), ".thinking-summary")).toContain("list-style: none");
    expect(ruleBody(css(), ".thinking-summary::-webkit-details-marker")).toContain("display: none");
    expect(ruleBody(css(), ".thinking-summary .ui-icon")).toContain("transition: transform 0.2s");
    expect(ruleBody(css(), ".thinking-block[open] .thinking-summary .ui-icon")).toContain(
      "transform: rotate(90deg)",
    );
    const reduce = blockBody(css(), /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
    expect(ruleBody(reduce, ".thinking-summary .ui-icon")).toContain("transition: none");
  });

  it("T12 keeps thinking styles out of chat.css (regression guard)", () => {
    expect(readRepoFile("web/src/features/chat/chat.css")).not.toContain("thinking-");
  });
});
