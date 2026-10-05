/**
 * Issue #534 `thinking.delta` decoding/reduction and the 深度思考过程 fold (parent tasks 7.4),
 * T1–T12 of openspec/changes/thinking-fold-block/design.md. Seams: `chatStateFromSnapshot` /
 * `applyChatEvent` on frozen inputs, `connectSessionEvents` over the fake EventSource, the jsdom
 * chat page. Expected values are literals from the spec deltas.
 * F1–F7 close the evidence gaps of review round 1 (resync snapshots, covered replay, unknown turn).
 * Since s1f-chat-surface the fold is composed from the copied `reasoning` parts: it is found by
 * `data-slot`, its control by role and accessible name, its state by `aria-expanded`. A collapsed
 * fold has no body in the DOM, so body text is read after expanding.
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
import { calls, deferredResponse, jsonResponse } from "./support.js";

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

/** Session in `status` holding `historyUser` (id -3) and `later`; stream cursor `1:3`. */
function sessionSnapshot(status: Snapshot["session"]["status"], ...later: Message[]) {
  const snapshot: Snapshot = {
    streamCursor: { epoch: 1, seq: 3 },
    session: { ...chatSnapshot().session, status },
    messages: [historyUser, ...later],
  };
  return snapshot;
}

/** `snapshot` with its stream cursor moved to `1:seq`. */
function atSeq(snapshot: Snapshot, seq: number): Snapshot {
  return { ...snapshot, streamCursor: { epoch: 1, seq } };
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

  it("F5 drops replayed frames the snapshot covers and appends only the successor delta", async () => {
    const snapshot = atSeq(turnSnapshot("running", { thinking: "旧" }), 5);
    const connector = connectChat(snapshot);
    connector.source.emitOpen();
    connector.source.emitData("turn.start", "1:2", { messageId: 0 });
    connector.source.emitData("thinking.delta", "1:5", { messageId: 0, delta: "旧" });
    connector.source.emitData("thinking.delta", "1:6", { messageId: 0, delta: "想" });
    expect(connector.events).toEqual([]);

    connector.loads.at(-1)?.resolve(snapshot);
    await settle();

    expect(connector.events).toStrictEqual([
      { type: "thinking.delta", data: { messageId: 0, delta: "想" } },
    ]);
    expect(messageOf(connector.state).thinking).toBe("旧想");
    expect([connector.loads.length, connector.snapshots.length]).toEqual([1, 1]);
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
  let reply = (): Response | Promise<Response> => jsonResponse(snapshot);
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [MESSAGES]: () => reply(),
  });
  await screen.findAllByRole("article", { name: "助手" });
  const source = latestSource();
  await reopen(source);
  return {
    source,
    reads: () => calls(fetchMock, MESSAGES).length,
    /** Every later `/messages` read is answered by `next`. */
    serve(next: typeof reply) {
      reply = next;
    },
  };
}

type Thread = Awaited<ReturnType<typeof mountThread>>;

async function flush() {
  for (let round = 0; round < 3; round += 1) {
    await act(settle);
  }
}

/** A (re)opened source reloads the full snapshot: the page's resync path. */
async function reopen(source: FakeEventSource) {
  act(() => source.emitOpen());
  await flush();
}

/** The source reopens while `/messages` answers `next`: exactly one more snapshot read. */
async function resyncWith(thread: Thread, next: Snapshot) {
  const before = thread.reads();
  thread.serve(() => jsonResponse(next));
  await reopen(thread.source);
  expect(thread.reads()).toBe(before + 1);
}

function emit(source: FakeEventSource, seq: number, type: string, data: Record<string, unknown>) {
  act(() => source.emitData(type, `1:${seq}`, { messageId: 0, ...data }));
}

function articles() {
  return screen.getAllByRole("article", { name: "助手" });
}

function mainOf(article: HTMLElement) {
  const main = article.querySelector('[data-slot="message-content"]');
  if (!main) throw new Error("助手消息缺少 message-content");
  return main;
}

const FOLD = '[data-slot="reasoning-root"]';

function foldOf(article = articles()[0]) {
  return article?.querySelector<HTMLElement>(FOLD) ?? null;
}

/** The fold of the first assistant; throws when it is not rendered. */
function fold() {
  const block = foldOf();
  if (!block) throw new Error("未渲染思考折叠块");
  return block;
}

/** The expand/collapse control, found by role and accessible name. */
function control(block = fold()) {
  return within(block).getByRole("button", { name: SUMMARY });
}

function isOpen(block = fold()) {
  return control(block).getAttribute("aria-expanded") === "true";
}

function bodyOf(block = fold()) {
  return block.querySelector<HTMLElement>('[data-slot="reasoning-text"]');
}

/** Body text of an expanded fold; `undefined` while collapsed (the body is not in the DOM). */
function bodyText(block = fold()) {
  return bodyOf(block)?.textContent;
}

/** Expands a collapsed fold and returns its body text. */
function expandedText(block = fold()) {
  expect(isOpen(block)).toBe(false);
  expect(bodyOf(block)).toBeNull();
  toggle(block);
  expect(isOpen(block)).toBe(true);
  return bodyText(block);
}

/** Rendered answer text (`message-body`) of the first assistant. */
function answerText() {
  return articles()[0]?.querySelector('[data-slot="message-body"]')?.textContent;
}

function toggle(block = fold()) {
  fireEvent.click(control(block));
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
    const text = main.querySelector('[data-slot="message-body"]') as Element;
    expect(main.firstElementChild).toBe(block);
    expect(block.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const summary = control(block);
    expect(summary.textContent).toBe(SUMMARY);
    const icon = summary.firstElementChild as Element;
    expect(icon.localName).toBe("svg");
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(isOpen(block)).toBe(true);
    expect(bodyText()).toBe("先想一想");
    expect(block.getAttribute("data-running")).toBe("");

    emit(source, 5, "text.delta", { delta: "答案" });
    emit(source, 6, "turn.end", { status: "done" });

    expect(fold()).toBe(block);
    expect(block.hasAttribute("data-running")).toBe(false);
    expect(expandedText()).toBe("先想一想");
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
    expect(block.hasAttribute("data-running")).toBe(false);

    expect(expandedText()).toBe("想了很久很久…（已截断）");
    expect(block.hasAttribute("data-running")).toBe(false);
    expect(bodyText()?.endsWith("…（已截断）")).toBe(true);
  });

  it("T8 keeps the fold collapsed by the user while more events arrive", async () => {
    const { source } = await mountThread(turnSnapshot("running"));
    emit(source, 4, "thinking.delta", { delta: "一" });
    const block = fold();
    expect(isOpen(block)).toBe(true);

    toggle();
    expect(isOpen(block)).toBe(false);
    emit(source, 5, "thinking.delta", { delta: "二" });
    emit(source, 6, "thinking.delta", { delta: "三" });
    emit(source, 7, "text.delta", { delta: "正文" });
    emit(source, 8, "step.start", { stepId: 21, name: "bash", detail: "ls" });

    expect(screen.getByRole("region", { name: "bash" })).toBeTruthy();
    expect(fold()).toBe(block);
    expect(isOpen(block)).toBe(false);

    toggle();

    expect(isOpen(block)).toBe(true);
    expect(bodyText()).toBe("一二三");
  });

  it("F1 keeps a done fold expanded by the user when a resync installs a changed answer", async () => {
    const thread = await mountThread(turnSnapshot("done", { content: "答", thinking: "想过" }));
    const block = fold();
    expect(isOpen(block)).toBe(false);
    toggle();
    expect(isOpen(block)).toBe(true);
    expect(answerText()).toBe("答");

    await resyncWith(thread, turnSnapshot("done", { content: "答复", thinking: "想过" }));

    expect(answerText()).toBe("答复");
    expect(fold()).toBe(block);
    expect(isOpen(block)).toBe(true);
    expect(bodyText()).toBe("想过");
  });

  it("F2 keeps a running fold collapsed by the user when a resync brings longer thinking", async () => {
    const thread = await mountThread(turnSnapshot("running", { thinking: "想到一半" }));
    const block = fold();
    expect(isOpen(block)).toBe(true);
    toggle();
    expect(isOpen(block)).toBe(false);

    await resyncWith(thread, turnSnapshot("running", { thinking: "想到一半，又想了一步" }));

    expect(fold()).toBe(block);
    expect(expandedText()).toBe("想到一半，又想了一步");
  });

  it("F3 collapses an untouched running fold when a resync finds the turn done", async () => {
    const thread = await mountThread(turnSnapshot("running", { thinking: "断线前的思考" }));
    const block = fold();
    expect(isOpen(block)).toBe(true);

    await resyncWith(thread, turnSnapshot("done", { content: "答", thinking: "断线前的思考" }));

    expect(answerText()).toBe("答");
    expect(fold()).toBe(block);
    expect(expandedText()).toBe("断线前的思考");
  });

  it("F4 keeps the fold collapsed by the user through approval and step.end events", async () => {
    const step: Message["steps"][number] = { ...BASH_STEP, output: "", status: "running" };
    const { source } = await mountThread(
      turnSnapshot("running", { thinking: "先想一想", steps: [step] }),
    );
    const article = within(articles()[0] as HTMLElement);
    const block = fold();
    toggle();
    const expectStillCollapsed = () => expect([fold(), isOpen(block)]).toEqual([block, false]);
    expectStillCollapsed();
    expect(article.getByRole("status", { name: "bash 运行中" })).toBeTruthy();

    const { id: approvalId, tool, title, expiresAt } = SETTLED_APPROVAL;
    emit(source, 4, "approval.request", { approvalId, tool, title, expiresAt });
    expect(article.getByRole("group", { name: "需要你的确认" })).toBeTruthy();
    expectStillCollapsed();

    emit(source, 5, "approval.resolved", { approvalId, decision: "allow" });
    expect(article.getByRole("group", { name: "已允许执行" })).toBeTruthy();
    expectStillCollapsed();

    emit(source, 6, "step.end", { stepId: step.id, status: "done", output: "a.md" });
    expect(article.getByRole("status", { name: "bash 已完成" })).toBeTruthy();
    expectStillCollapsed();
    expect(expandedText()).toBe("先想一想");
  });

  it("F6 resyncs on a thinking.delta for an unknown turn instead of fabricating a message", async () => {
    const thread = await mountThread(turnSnapshot("done", { content: "答" }));
    const pending = deferredResponse();
    thread.serve(() => pending.promise);
    const before = thread.reads();

    emit(thread.source, 4, "thinking.delta", { messageId: 2, delta: "新一轮的思考" });
    await flush();

    expect(thread.reads()).toBe(before + 1);
    expect(articles()).toHaveLength(1);
    expect(answerText()).toBe("答");
    expect(document.querySelector(FOLD)).toBeNull();

    const followUp: Message = { ...historyUser, id: 1, content: "再问", createdAt: 1 };
    const next = sessionSnapshot(
      "running",
      assistant(0, "done", { content: "答" }),
      followUp,
      assistant(2, "running", { thinking: "新一轮的思考" }),
    );
    pending.resolve(jsonResponse(atSeq(next, 4)));
    await flush();

    expect(thread.reads()).toBe(before + 1);
    expect(articles()).toHaveLength(2);
    expect(foldOf(articles()[0])).toBeNull();
    const block = foldOf(articles()[1]) as HTMLElement;
    expect(isOpen(block)).toBe(true);
    expect(bodyText(block)).toBe("新一轮的思考");
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });

  it("T9 opens a running snapshot message and collapses on turn.end stopped", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "快照里的思考" }));
    const block = fold();
    expect(isOpen(block)).toBe(true);
    expect(bodyText()).toBe("快照里的思考");

    emit(source, 4, "turn.end", { status: "stopped" });

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "助手消息 已停止" })).toBeTruthy(),
    );
    expect(expandedText()).toBe("快照里的思考");
  });

  it("T9 F7 collapses on error then turn.end failed, fold above answer above error", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "想到一半" }));
    const block = fold();
    expect(isOpen(block)).toBe(true);

    emit(source, 4, "error", { message: "上游失败" });
    expect(screen.getByRole("alert").textContent).toBe("上游失败");
    expect(isOpen(block)).toBe(false);
    emit(source, 5, "turn.end", { status: "failed" });

    expect(fold()).toBe(block);
    expect(expandedText()).toBe("想到一半");
    const main = mainOf(articles()[0] as HTMLElement);
    expect(
      [...main.children].map(
        (part) => part.getAttribute("data-slot") ?? `${part.localName}.${part.className}`,
      ),
    ).toEqual(["reasoning-root", "message-body", "message-error", "div.chat-msg-actions"]);
    expect(screen.getByRole("alert")).toBe(main.children[2]);
  });

  it("T9 removes the fold when the same message starts a new turn", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "上一轮的思考" }));
    expect(isOpen()).toBe(true);

    emit(source, 4, "turn.start", {});

    expect(articles()).toHaveLength(1);
    expect(foldOf()).toBeNull();
  });

  it("T10 orders fold, body, step, approvals, stopped badge and actions", async () => {
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

    expect(
      parts.map((part) => part.getAttribute("data-slot") ?? `${part.localName}.${part.className}`),
    ).toEqual([
      "reasoning-root",
      "message-body",
      "section.chat-step",
      "div.chat-approvals",
      "message-stopped",
      "div.chat-msg-actions",
    ]);
    expect(isOpen()).toBe(false);
    expect(within(parts[3] as HTMLElement).getAllByRole("group")).toHaveLength(1);
    expect(parts[1]?.textContent).toBe("部分回答");
    expect(within(article).getByRole("region", { name: "bash" })).toBe(parts[2]);
    expect(within(article).getByRole("status", { name: "助手消息 已停止" })).toBe(parts[4]);
    expect(await copiedTexts(writeText)).toEqual([["部分回答"]]);
  });

  it("T11 renders thinking as plain text, never as Markdown or HTML", async () => {
    await mountThread(turnSnapshot("done", { content: "答", thinking: PLAIN }));
    const block = fold();

    expect(expandedText()).toBe("**粗** <b>x</b>\n  缩进");
    expect(block.querySelectorAll("strong, b")).toHaveLength(0);
    expect(bodyOf()?.classList.contains("whitespace-pre-wrap")).toBe(true);
  });

  it("caps the body of a settled fold at 12rem and leaves a running one uncapped (#725)", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "想" }));
    const block = fold();
    const capOf = () =>
      [...(bodyOf()?.classList ?? [])].filter((name) => /^(max-h-|overflow-)/.test(name)).sort();

    expect(block.getAttribute("data-running")).toBe("");
    expect(capOf()).toEqual(["max-h-none", "overflow-y-auto"]);

    emit(source, 4, "turn.end", { status: "done" });
    expect(block.hasAttribute("data-running")).toBe(false);
    toggle();

    expect(capOf()).toEqual(["max-h-48", "overflow-auto"]);
  });

  it("shimmers the title only while the turn runs (tw-shimmer `shimmer` class)", async () => {
    const { source } = await mountThread(turnSnapshot("running", { thinking: "想" }));
    const label = () => control().querySelector('[data-slot="reasoning-trigger-label"]');

    expect([...(label()?.classList ?? [])]).toEqual(
      expect.arrayContaining(["shimmer", "motion-reduce:animate-none"]),
    );

    emit(source, 4, "turn.end", { status: "done" });

    expect(label()?.textContent).toBe(SUMMARY);
    expect(label()?.classList.contains("shimmer")).toBe(false);
  });

  it("hides the copied component's top fade mask on an expanded fold", async () => {
    await mountThread(turnSnapshot("running", { thinking: "想" }));
    const content = fold().querySelector('[data-slot="reasoning-content"]');
    const fades = [...fold().querySelectorAll('[data-slot="reasoning-fade"]')];

    expect(isOpen()).toBe(true);
    expect(fades).toHaveLength(1);
    // The hiding class is an arbitrary variant on the fade's parent; resolve it as a selector.
    const hiding = [...(content?.classList ?? [])].filter((name) => name.endsWith(":hidden"));
    expect(hiding).toEqual(["[&>[data-slot=reasoning-fade]]:hidden"]);
    const selector = hiding[0]?.slice(1, -"]:hidden".length).replace("&", ":scope") ?? "";
    expect([...(content?.querySelectorAll(selector) ?? [])]).toEqual(fades);
  });

  it("T12 keeps the control's icons decorative and honours reduced motion", async () => {
    await mountThread(turnSnapshot("running", { thinking: "想" }));
    const chevron = control().querySelector('[data-slot="reasoning-trigger-chevron"]');

    expect(chevron?.classList.contains("motion-reduce:transition-none")).toBe(true);
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(bodyOf()?.classList.contains("motion-reduce:animate-none")).toBe(true);
    expect(fold().querySelector('[data-slot="reasoning-content"]')?.classList).toContain(
      "motion-reduce:animate-none",
    );
  });
});
