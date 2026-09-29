import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";

/**
 * #633：视图末条助手已终态时，未知 messageId 的事件不本地追加，而是让投递它的连接 resync
 * 一次完整快照。`getMessages` 次数一律写死：首次加载 1 + open 恢复 1 是基线。
 */

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const REGEN = `/api/sessions/${SESSION_ID}/regenerate`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const LIST = "/api/sessions";
const T0 = 1_750_000_000_000;
const TITLE = "Allow tool: bash\nReason: run ls";
const PENDING = "需要你的确认";

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type Approval = Message["approvals"][number];
type Reply = () => Response | Promise<Response>;

function message(
  id: number,
  role: Message["role"],
  status: Message["status"],
  content = "",
  approvals: Approval[] = [],
): Message {
  return { ...historyUser, id, role, status, content, createdAt: id, approvals };
}

function snapshotOf(status: Snapshot["session"]["status"], messages: Message[], seq: number) {
  const base = chatSnapshot();
  return {
    session: { ...base.session, status },
    messages,
    streamCursor: { epoch: 1, seq },
  } satisfies Snapshot;
}

function approval(id: number): Approval {
  return {
    id,
    tool: "bash",
    title: TITLE,
    requestedAt: T0,
    expiresAt: T0 + 60_000,
    decision: null,
  };
}

async function mount(initial: Snapshot, routes: FetchRoutes = {}, strict = false) {
  const messages: { reply: Reply } = { reply: () => jsonResponse(initial) };
  const { fetchMock } = renderChatPage(
    `/?session=${SESSION_ID}`,
    {
      [LIST]: () => jsonResponse({ sessions: [initial.session] }),
      [MESSAGES]: () => messages.reply(),
      ...routes,
    },
    strict,
  );
  await waitFor(() => expect(screen.queryAllByRole("article").length).toBeGreaterThan(0));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  return { fetchMock, messages, source, reads: () => calls(fetchMock, MESSAGES).length };
}

async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

function assistantArticles() {
  return screen.queryAllByRole("article", { name: "助手" }) as HTMLElement[];
}

function userArticles() {
  return screen.queryAllByRole("article", { name: "用户" }) as HTMLElement[];
}

function bodies(articles: HTMLElement[]) {
  return articles.map((article) => article.querySelector(".chat-md")?.textContent ?? "");
}

function textarea() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function expectUnlockedWithoutAlert() {
  expect(screen.queryAllByRole("alert")).toEqual([]);
  expect(textarea().disabled).toBe(false);
  expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
}

function emitTurn(source: FakeEventSource, id: number, from: number, text: string) {
  act(() => {
    source.emitData("turn.start", `1:${from}`, { messageId: id });
    source.emitData("text.delta", `1:${from + 1}`, { messageId: id, delta: text });
    source.emitData("turn.end", `1:${from + 2}`, { messageId: id, status: "done" });
  });
}

afterEach(() => {
  cleanupChatPage();
  vi.restoreAllMocks();
});

const U1 = message(1, "user", "done", "q1");
/** 其它标签页 regenerate 之前：u1 + done 助手 X（2，"old"）。 */
const BEFORE = snapshotOf("done", [U1, message(2, "assistant", "done", "old")], 0);
/** 权威快照：X 被删，done 助手 Y（3，"new"），游标覆盖三帧 `1:1`–`1:3`。 */
const AFTER_Y = snapshotOf("done", [U1, message(3, "assistant", "done", "new")], 3);
/** 续测：Y 再被替换成 done 助手 Z（4，"newer"），游标覆盖 `1:4`–`1:6`。 */
const AFTER_Z = snapshotOf("done", [U1, message(4, "assistant", "done", "newer")], 6);

async function expectOtherTabRegenerateConverges(strict: boolean) {
  const { messages, reads, source } = await mount(BEFORE, {}, strict);
  const baseline = reads();
  expect(bodies(assistantArticles())).toEqual(["old"]);

  messages.reply = () => jsonResponse(AFTER_Y);
  emitTurn(source, 3, 1, "new");
  await flush();
  expect(assistantArticles()).toHaveLength(1);
  expect(bodies(assistantArticles())).toEqual(["new"]);
  expect(screen.queryByText("old")).toBeNull();
  expectUnlockedWithoutAlert();
  expect(reads()).toBe(baseline + 1);

  // 恢复快照装入后「至多一次」复位：同一连接上的下一个未知回合再恢复一次。
  messages.reply = () => jsonResponse(AFTER_Z);
  emitTurn(source, 4, 4, "newer");
  await flush();
  expect(assistantArticles()).toHaveLength(1);
  expect(bodies(assistantArticles())).toEqual(["newer"]);
  expectUnlockedWithoutAlert();
  expect(reads()).toBe(baseline + 2);
  expect(source.closeCount).toBe(0);
  return baseline;
}

describe("unknown turn resync: other tab", () => {
  it("P1 converges a foreign regenerate to the authoritative snapshot with exactly one GET", async () => {
    const baseline = await expectOtherTabRegenerateConverges(false);
    // 首次加载 + open 恢复；Y、Z 各多一次恢复 GET。
    expect(baseline).toBe(2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("P6 keeps exactly one recovery GET per unknown turn under StrictMode", async () => {
    const baseline = await expectOtherTabRegenerateConverges(true);
    expect(baseline).toBe(3);
  });

  it("P2 reduces a known running turn normally without an extra GET", async () => {
    const running = snapshotOf("running", [U1, message(3, "assistant", "running", "ne")], 0);
    const { reads, source } = await mount(running);
    expect(reads()).toBe(2);
    act(() => {
      source.emitData("text.delta", "1:1", { messageId: 3, delta: "w" });
      source.emitData("turn.end", "1:2", { messageId: 3, status: "done" });
    });
    await flush();
    expect(bodies(assistantArticles())).toEqual(["new"]);
    expectUnlockedWithoutAlert();
    expect(reads()).toBe(2);
  });
});

/** 本页 regenerate：D 为 done 的旧回答（0），N 为对账快照（running 的 5，正文「新」）。 */
const D = snapshotOf("done", [historyUser, message(0, "assistant", "done", "旧回答")], 0);
const N = snapshotOf("running", [historyUser, message(5, "assistant", "running", "新")], 2);

describe("unknown turn resync: own regenerate", () => {
  async function startRegenerate() {
    const regen = deferredResponse();
    const mounted = await mount(D, { [REGEN]: () => regen.promise });
    expect(mounted.reads()).toBe(2);
    mounted.messages.reply = () => jsonResponse(N);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await flush();
    expect(calls(mounted.fetchMock, REGEN)).toHaveLength(1);
    return { ...mounted, regen };
  }

  async function acceptAndReopen(regen: ReturnType<typeof deferredResponse>) {
    regen.resolve(jsonResponse({ assistantMessageId: 5 }, 202));
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    const next = latestSource();
    act(() => next.emitOpen());
    await flush();
    act(() => {
      next.emitData("text.delta", "1:3", { messageId: 5, delta: "回答" });
      next.emitData("turn.end", "1:4", { messageId: 5, status: "done" });
    });
    await flush();
    expect(assistantArticles()).toHaveLength(1);
    expect(bodies(assistantArticles())).toEqual(["新回答"]);
  }

  it("P3 adds no GET when the 202 lands before the new turn's events", async () => {
    const { reads, regen, source } = await startRegenerate();
    await acceptAndReopen(regen);
    expect(source.closeCount).toBe(1);
    // 首次加载 + open 恢复 + 202 对账 + 新连接 open 恢复。
    expect(reads()).toBe(4);
  });

  it("P4 resyncs once when the new turn's events land before the 202", async () => {
    const { reads, regen, source } = await startRegenerate();
    act(() => {
      source.emitData("turn.start", "1:1", { messageId: 5 });
      source.emitData("text.delta", "1:2", { messageId: 5, delta: "新" });
    });
    await flush();
    // 中间窗口：恢复快照已装入、202 仍挂起。
    expect(assistantArticles()).toHaveLength(1);
    expect(bodies(assistantArticles())).toEqual(["新"]);
    expect(screen.queryByText("旧回答")).toBeNull();
    expect(reads()).toBe(3);
    expect(source.closeCount).toBe(0);

    await acceptAndReopen(regen);
    expect(source.closeCount).toBe(1);
    expect(reads()).toBe(5);
  });
});

/** 本页 prompt：DONE 为 done 的旧回合；RUNNING 为权威快照（新用户行 1、running 助手 2 带待审批 9）。 */
const DONE = snapshotOf("done", [historyUser, message(0, "assistant", "done", "earlier")], 0);
const RUNNING = snapshotOf(
  "running",
  [
    ...DONE.messages,
    message(1, "user", "done", "继续"),
    message(2, "assistant", "running", "", [approval(9)]),
  ],
  2,
);

describe("unknown turn resync: own prompt", () => {
  async function sendPrompt() {
    const prompt = deferredResponse();
    const mounted = await mount(DONE, {
      [PROMPT_PATH]: () => prompt.promise,
      [`/api/sessions/${SESSION_ID}/approvals/9`]: () =>
        jsonResponse({ ...approval(9), decision: "allow" }),
    });
    expect(mounted.reads()).toBe(2);
    mounted.messages.reply = () => jsonResponse(RUNNING);
    fireEvent.change(textarea(), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(calls(mounted.fetchMock, PROMPT_PATH)).toHaveLength(1);
    return { ...mounted, prompt };
  }

  function emitApprovalTurn(source: FakeEventSource) {
    act(() => {
      source.emitData("turn.start", "1:1", { messageId: 2 });
      source.emitData("approval.request", "1:2", {
        messageId: 2,
        approvalId: 9,
        tool: "bash",
        title: TITLE,
        expiresAt: T0 + 60_000,
      });
    });
  }

  async function answerPending(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"]) {
    const turn = assistantArticles()[1] as HTMLElement;
    const group = within(turn).getByRole("group", { name: PENDING });
    fireEvent.click(within(group).getByRole("button", { name: "允许" }));
    await flush();
    const posted = calls(fetchMock, `/api/sessions/${SESSION_ID}/approvals/9`);
    expect(posted.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { decision: "allow" },
    ]);
  }

  function expectAuthoritativeRows() {
    expect(bodies(userArticles())).toHaveLength(2);
    expect(userArticles()[1]?.textContent).toContain("继续");
    expect(assistantArticles()).toHaveLength(2);
    expect(bodies(assistantArticles())[0]).toBe("earlier");
  }

  it("P5 shows the approval bar from the recovery snapshot when events precede the 202", async () => {
    const { fetchMock, prompt, reads, source } = await sendPrompt();
    emitApprovalTurn(source);
    await flush();
    expect(reads()).toBe(3);
    expectAuthoritativeRows();
    await answerPending(fetchMock);

    prompt.resolve(jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202));
    await flush();
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latestSource().emitOpen());
    await flush();
    expectAuthoritativeRows();
    // 首次加载 + open 恢复 + 未知回合恢复 + 202 对账 + 新连接 open 恢复。
    expect(reads()).toBe(5);
  });

  it("P5′ shows the approval bar after the 202 reconcile when the 202 comes first", async () => {
    const { fetchMock, prompt, reads, source } = await sendPrompt();
    prompt.resolve(jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202));
    await flush();
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    const next = latestSource();
    act(() => next.emitOpen());
    await flush();
    emitApprovalTurn(next);
    await flush();
    expectAuthoritativeRows();
    await answerPending(fetchMock);
    // 首次加载 + open 恢复 + 202 对账 + 新连接 open 恢复。
    expect(reads()).toBe(4);
  });
});
