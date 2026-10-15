// issue 1447（issue 910 切片 6a）：thinking-fold「深度思考折叠块呈现」第二段的标题三态，场景「流式展开、终态
// 收起」「标题三态与多段思考」「用户手动切换保留」。seam：整页挂载 + 假 API / 假 EventSource，期望值取自场景
// 字面量与规则 N = max(1, round(thinkingMs ÷ 1000))。控件按 `reasoning-trigger*` slot 定位；每次读标题都另经
// role + 可访问名找回同一个按钮（可见文本即可访问名），并确认折叠块内没有 `role="status"`（标题与等待指示同为
// `正在思考…`，带 status 角色会被 page-notices 的 STATE_MARKS 一并滤掉）。jsdom 不加载样式表，流光只钉工具类。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

type Message = ChatMessageSnapshot["messages"][number];

const ACTIVE = "正在思考…";
const NO_DURATION = "深度思考过程";

afterEach(() => {
  cleanupChatPage();
  Reflect.deleteProperty(window.navigator, "clipboard");
});

/**
 * 会话 `status` 的快照：`historyUser` 之后依次是各助手消息（第 i 条 id 为 2i），相邻两条之间插一条用户消息。
 * 助手消息缺省为 running、无正文、无思考、`thinkingMs` 为 null，由 `fields` 覆盖。
 */
function transcript(status: "running" | "done", ...assistants: Partial<Message>[]) {
  const base = chatSnapshot({ status });
  const template = base.messages[1] as Message;
  const messages = assistants.flatMap((fields, index): Message[] => {
    const id = index * 2;
    const asked = { ...historyUser, id: id - 1, content: `追问 ${index}`, createdAt: id - 1 };
    return [index === 0 ? historyUser : asked, { ...template, id, createdAt: id, ...fields }];
  });
  return { ...base, messages };
}

/** 打开会话并让事件源连上；`emit` 从 `1:1` 起编号，`resync` 让事件源重开并按 `next` 重装快照。 */
async function openSession(first: ChatMessageSnapshot) {
  let served = first;
  renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [first.session] }),
    [`/api/sessions/${SESSION_ID}/messages`]: () => jsonResponse(served),
  });
  await screen.findAllByRole("article", { name: "助手" });
  await waitFor(() => expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`));
  const source = latestSource();
  act(() => source.emitOpen());
  // 连上即按快照重装：等它落定，之后每个事件同步生效，逐事件读标题。
  for (let round = 0; round < 3; round += 1) await act(settle);
  let seq = 0;
  return {
    emit(type: string, data: Record<string, unknown> = {}) {
      seq += 1;
      act(() => source.emitData(type, `1:${String(seq)}`, { messageId: 0, ...data }));
    },
    resync(next: ChatMessageSnapshot) {
      served = next;
      act(() => source.emitOpen());
    },
  };
}

function assistantAt(index = 0) {
  const article = screen.getAllByRole("article", { name: "助手" })[index];
  if (!article) throw new Error(`没有第 ${String(index)} 条助手消息`);
  return article;
}

function triggerOf(article: HTMLElement) {
  const trigger = article.querySelector<HTMLElement>('[data-slot="reasoning-trigger"]');
  if (!trigger) throw new Error("未渲染折叠块控件");
  return trigger;
}

/** `[标题, 是否带流光]`；标题即控件的可见文本，也经可访问名找回同一个按钮。 */
function title(article = assistantAt()): [string, boolean] {
  const trigger = triggerOf(article);
  const label = trigger.querySelector('[data-slot="reasoning-trigger-label"]');
  const text = label?.textContent ?? "";
  expect(trigger.textContent).toBe(text);
  expect(within(article).getByRole("button", { name: text })).toBe(trigger);
  const fold = trigger.closest<HTMLElement>('[data-slot="reasoning-root"]') as HTMLElement;
  expect(within(fold).queryAllByRole("status")).toEqual([]);
  return [text, label?.classList.contains("shimmer") === true];
}

function expanded(article = assistantAt()) {
  return triggerOf(article).getAttribute("aria-expanded") === "true";
}

function thinkingShown(article = assistantAt()) {
  return article.querySelector('[data-slot="reasoning-text"]')?.textContent;
}

function answerShown(article = assistantAt()) {
  return article.querySelector('[data-slot="message-body"]')?.textContent;
}

describe("thinking-fold「流式展开、终态收起」", () => {
  it("正在思考…（流光）→ thinking.end 1400 后 已思考 1 秒 → turn.end done 收起、标题不变，主体与复制不变", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const session = await openSession(transcript("running", {}));

    session.emit("thinking.delta", { delta: "先想一想" });
    const content = assistantAt().querySelector('[data-slot="message-content"]');
    expect(content?.firstElementChild?.getAttribute("data-slot")).toBe("reasoning-root");
    expect([title(), expanded(), thinkingShown()]).toEqual([[ACTIVE, true], true, "先想一想"]);

    session.emit("thinking.end", { thinkingMs: 1400 });
    expect([title(), expanded()]).toEqual([["已思考 1 秒", false], true]);

    session.emit("text.delta", { delta: "答案" });
    session.emit("turn.end", { status: "done" });
    expect([title(), expanded(), thinkingShown()]).toEqual([
      ["已思考 1 秒", false],
      false,
      undefined,
    ]);

    fireEvent.click(triggerOf(assistantAt()));
    expect([title(), expanded(), thinkingShown()]).toEqual([
      ["已思考 1 秒", false],
      true,
      "先想一想",
    ]);
    expect(answerShown()).toBe("答案");
    fireEvent.click(within(assistantAt()).getByRole("button", { name: "复制" }));
    await screen.findByText("已复制");
    expect(writeText.mock.calls).toEqual([["答案"]]);
  });
});

describe("thinking-fold「标题三态与多段思考」", () => {
  it("delta、end 400、step.start、delta、end 2600、turn.end：正在思考… → 已思考 1 秒 → 正在思考… → 已思考 3 秒，终态后不变", async () => {
    const session = await openSession(transcript("running", {}));
    const seen: Array<[string, boolean]> = [];
    const events: Array<[string, Record<string, unknown>]> = [
      ["thinking.delta", { delta: "先" }],
      ["thinking.end", { thinkingMs: 400 }],
      ["step.start", { stepId: 21, name: "bash", detail: "ls" }],
      ["thinking.delta", { delta: "再想" }],
      ["thinking.end", { thinkingMs: 2600 }],
      ["turn.end", { status: "done" }],
    ];
    for (const [type, data] of events) {
      session.emit(type, data);
      seen.push(title());
    }

    expect(seen).toEqual([
      [ACTIVE, true],
      ["已思考 1 秒", false],
      ["已思考 1 秒", false],
      [ACTIVE, true],
      ["已思考 3 秒", false],
      ["已思考 3 秒", false],
    ]);
  });

  it("快照：done 61500 → 已思考 62 秒；done 且 null → 深度思考过程；running 且 null → 正在思考…", async () => {
    await openSession(
      transcript(
        "running",
        { status: "done", content: "一", thinking: "想过", thinkingMs: 61_500 },
        { status: "done", content: "二", thinking: "旧消息的思考", thinkingMs: null },
        { status: "running", thinking: "想到一半", thinkingMs: null },
      ),
    );

    expect([0, 1, 2].map((index) => title(assistantAt(index)))).toEqual([
      ["已思考 62 秒", false],
      [NO_DURATION, false],
      [ACTIVE, true],
    ]);
    expect([0, 1, 2].map((index) => expanded(assistantAt(index)))).toEqual([false, false, true]);
  });

  it("取整：thinkingMs 0、1499、1500 依次为 已思考 1 秒、已思考 1 秒、已思考 2 秒（不出现 0 秒）", async () => {
    await openSession(
      transcript(
        "done",
        { status: "done", content: "一", thinking: "想", thinkingMs: 0 },
        { status: "done", content: "二", thinking: "想", thinkingMs: 1499 },
        { status: "done", content: "三", thinking: "想", thinkingMs: 1500 },
      ),
    );

    expect([0, 1, 2].map((index) => title(assistantAt(index)))).toEqual([
      ["已思考 1 秒", false],
      ["已思考 1 秒", false],
      ["已思考 2 秒", false],
    ]);
  });

  it("终态消息迟到一条 thinking.delta：不是 running，标题仍按时长、不带流光", async () => {
    const session = await openSession(
      transcript("done", { status: "done", content: "答", thinking: "想过", thinkingMs: 1400 }),
    );
    expect(title()).toEqual(["已思考 1 秒", false]);

    session.emit("thinking.delta", { delta: "迟到" });

    expect(title()).toEqual(["已思考 1 秒", false]);
  });

  it("思考进行中回合以 turn.end stopped 结束、没有 thinking.end：深度思考过程，不带流光", async () => {
    const session = await openSession(transcript("running", {}));
    session.emit("thinking.delta", { delta: "想到一半" });
    expect(title()).toEqual([ACTIVE, true]);

    session.emit("turn.end", { status: "stopped" });

    expect(title()).toEqual([NO_DURATION, false]);
  });
});

describe("thinking-fold「用户手动切换保留」", () => {
  it("running 期间收起后又到两条 thinking.delta 与一条 thinking.end：保持收起，标题按三态更新，展开后含新增文本", async () => {
    const session = await openSession(transcript("running", {}));
    session.emit("thinking.delta", { delta: "一" });
    expect(expanded()).toBe(true);
    fireEvent.click(triggerOf(assistantAt()));
    expect(expanded()).toBe(false);

    session.emit("thinking.delta", { delta: "二" });
    session.emit("thinking.delta", { delta: "三" });
    expect([title(), expanded()]).toEqual([[ACTIVE, true], false]);
    session.emit("thinking.end", { thinkingMs: 2600 });
    expect([title(), expanded()]).toEqual([["已思考 3 秒", false], false]);

    fireEvent.click(triggerOf(assistantAt()));
    expect([expanded(), thinkingShown()]).toEqual([true, "一二三"]);
  });

  it("展开一条 done 消息的折叠块后以正文不同的同状态快照重新同步：正文更新，折叠块保持展开，标题不变", async () => {
    const done = { status: "done" as const, thinking: "想过", thinkingMs: 2600 };
    const session = await openSession(transcript("done", { ...done, content: "答" }));
    fireEvent.click(triggerOf(assistantAt()));
    expect([title(), expanded(), answerShown()]).toEqual([["已思考 3 秒", false], true, "答"]);

    session.resync(transcript("done", { ...done, content: "答复" }));

    await waitFor(() => expect(answerShown()).toBe("答复"));
    expect([title(), expanded(), thinkingShown()]).toEqual([["已思考 3 秒", false], true, "想过"]);
  });
});
