import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
} from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const REGEN = `/api/sessions/${SESSION_ID}/regenerate`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const STOP = `/api/sessions/${SESSION_ID}/stop`;
const LIST = "/api/sessions";
const B_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const B_REGEN = `/api/sessions/${OTHER_SESSION_ID}/regenerate`;
const REGEN_LABEL = "重新生成";
const REGEN_TOAST = "正在重新生成…";
const GUIDANCE = "请刷新页面后重试";

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type Reply = () => Response | Promise<Response>;

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

const BUSY_B = envelope("session_busy", "B 会话忙");
const UNAVAILABLE = envelope("agent_unavailable", "Agent 运行时不可用");

function message(id: number, role: Message["role"], status: Message["status"], content = "") {
  return { ...historyUser, id, role, status, content, createdAt: id };
}

/** 自建快照：会话状态、消息与游标都直接写进字面量（`stopped` 不在 `chatSnapshot` 选项里）。 */
function snapshotOf(
  status: Snapshot["session"]["status"],
  messages: Message[],
  seq: number | null = 0,
  sessionId = SESSION_ID,
  title = "saved title",
): Snapshot {
  const base = chatSnapshot({ sessionId });
  return {
    session: { ...base.session, status, title },
    messages,
    streamCursor: { epoch: 1, seq },
  };
}

/** D：done 会话，[用户, 助手 0 done `旧回答`]，cursor `1:0`。 */
const D = snapshotOf("done", [historyUser, message(0, "assistant", "done", "旧回答")]);
/** N：对账快照，助手换成 running 的空正文 id 5，cursor `1:3`。 */
const N = snapshotOf("running", [historyUser, message(5, "assistant", "running")], 3);
const B = snapshotOf(
  "done",
  [historyUser, message(0, "assistant", "done", "B 回答")],
  0,
  OTHER_SESSION_ID,
  "other session",
);

const accepted = (assistantMessageId = 5) => jsonResponse({ assistantMessageId }, 202);

/**
 * 以 `?session=A` 挂载、等 source 建好并 open（open 再读一次快照）。`messages.reply` 决定 A 的
 * messages 路由此后返回什么，按阶段替换。
 */
async function mount(initial: Snapshot, routes: FetchRoutes = {}, withB = false) {
  const messages: { reply: Reply } = { reply: () => jsonResponse(initial) };
  const listed = withB ? [initial.session, B.session] : [initial.session];
  const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
    [LIST]: () => jsonResponse({ sessions: listed }),
    [MESSAGES]: () => messages.reply(),
    [B_MESSAGES]: () => jsonResponse(B),
    ...routes,
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  return { fetchMock: mounted.fetchMock, messages, router: mounted.router, source };
}

async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

function regenButtons(scope: HTMLElement = document.body) {
  return within(scope).queryAllByRole("button", { name: REGEN_LABEL }) as HTMLButtonElement[];
}

function regenButton() {
  const [button, ...rest] = regenButtons();
  expect(rest).toHaveLength(0);
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

function bar() {
  const element = document.querySelector<HTMLElement>('form [data-slot="composer-toolbar"]');
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

function textarea() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function assistantArticles() {
  return screen.queryAllByRole("article", { name: "助手" }) as HTMLElement[];
}

function userArticles() {
  return screen.queryAllByRole("article", { name: "用户" }) as HTMLElement[];
}

function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

function expectLocked() {
  expect(textarea().disabled).toBe(true);
  expect(bar().getByText("生成中", { exact: true })).toBeTruthy();
  expect(bar().getByRole("button", { name: "停止" })).toBeTruthy();
  expect(bar().queryByRole("button", { name: "发送" })).toBeNull();
}

function expectUnlocked() {
  expect(textarea().disabled).toBe(false);
  expect(bar().getByRole("button", { name: "发送" })).toBeTruthy();
  expect(bar().queryByRole("button", { name: "停止" })).toBeNull();
  expect(bar().queryByText("生成中")).toBeNull();
}

function expectTranscript(bodies: string[]) {
  const articles = assistantArticles();
  expect(
    articles.map((article) => article.querySelector('[data-slot="message-body"]')?.textContent),
  ).toEqual(bodies);
}

async function selectInNav(title: string, sessionId: string) {
  const nav = screen.getByRole("navigation", { name: "会话列表" });
  fireEvent.click(within(nav).getByRole("button", { name: title }));
  await expectChatLocation(`/?session=${sessionId}`);
  await flush();
}

afterEach(() => {
  cleanupChatLifecycle();
  vi.restoreAllMocks();
});

describe("regenerate button: availability", () => {
  const a = (id: number, status: Message["status"], content = "") =>
    message(id, "assistant", status, content);
  const u = (id: number) => message(id, "user", "done", `q${id}`);
  const eligible = [
    ["(a) done", snapshotOf("done", [historyUser, a(0, "done", "旧回答")])],
    ["(b) failed empty", snapshotOf("failed", [historyUser, a(0, "failed")])],
    ["(c) stopped empty", snapshotOf("stopped", [historyUser, a(0, "stopped")])],
  ] as const;

  it.each(eligible)("R1 %s offers one enabled 重新生成 on the last assistant", async (name, s) => {
    await mount(s);
    const [article, ...others] = assistantArticles();
    expect(others).toHaveLength(0);
    const buttons = regenButtons(article);
    expect(buttons).toHaveLength(1);
    expect(regenButtons()).toHaveLength(1);
    const button = buttons[0] as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.type).toBe("button");
    expect(button.title).toBe(REGEN_LABEL);
    expect(button.querySelector("svg.lucide-refresh-cw")).not.toBeNull();
    if (name === "(a) done") {
      const copy = within(article as HTMLElement).getByRole("button", { name: "复制" });
      expect(copy.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    for (const user of userArticles()) {
      expect(regenButtons(user)).toHaveLength(0);
    }
  });

  const hidden = [
    ["(d) running", snapshotOf("running", [historyUser, a(0, "running", "进行中")])],
    ["(e) idle", snapshotOf("idle", [historyUser, a(0, "done", "x")])],
    ["(g) user last", snapshotOf("done", [historyUser, a(1, "done", "一"), u(2)])],
  ] as const;

  it.each(hidden)("R1 %s renders no 重新生成 anywhere", async (_, s) => {
    await mount(s);
    expect(assistantArticles().length).toBeGreaterThan(0);
    expect(regenButtons()).toHaveLength(0);
    for (const user of userArticles()) {
      expect(regenButtons(user)).toHaveLength(0);
    }
  });

  it("R1 (f) offers 重新生成 only on the last of two assistants", async () => {
    await mount(snapshotOf("done", [historyUser, a(1, "done", "一"), u(2), a(3, "done", "二")]));
    const [a1, a2] = assistantArticles() as [HTMLElement, HTMLElement];
    expect(regenButtons(a1)).toHaveLength(0);
    expect(within(a1).getByRole("button", { name: "复制" })).toBeTruthy();
    expect(regenButtons(a2)).toHaveLength(1);
    expect(regenButtons()).toHaveLength(1);
    for (const user of userArticles()) {
      expect(regenButtons(user)).toHaveLength(0);
    }
  });

  it("R2 gives an empty regenerable last message an action row with only 重新生成", async () => {
    await mount(snapshotOf("stopped", [historyUser, a(1, "stopped"), u(2), a(3, "stopped")]));
    const [a1, a2] = assistantArticles() as [HTMLElement, HTMLElement];
    expect(a1.querySelector(".chat-msg-actions")).toBeNull();
    const row = a2.querySelector<HTMLElement>(".chat-msg-actions");
    expect(row).not.toBeNull();
    const buttons = within(row as HTMLElement).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([REGEN_LABEL]);
    expect(a2.querySelector('[data-slot="message-body"]')?.textContent).toBe("（已停止生成）");
  });

  it("R2 keeps 复制 off empty bodies while the last non-empty answer has both", async () => {
    await mount(snapshotOf("done", [historyUser, a(1, "done"), u(2), a(3, "done", "答")]));
    const [a1, a2] = assistantArticles() as [HTMLElement, HTMLElement];
    expect(a1.querySelector(".chat-msg-actions")).toBeNull();
    const labels = within(a2)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(labels).toEqual(["复制", REGEN_LABEL]);
  });
});

describe("regenerate button: request, lock and reconcile", () => {
  it("R3 posts once, locks the composer and replaces the answer from the snapshot", async () => {
    const regen = deferredResponse();
    const reconcile = deferredResponse();
    const { fetchMock, messages, source } = await mount(D, {
      [REGEN]: () => regen.promise,
      [PROMPT_PATH]: () => jsonResponse({ userMessageId: 6, assistantMessageId: 7 }, 202),
    });
    await waitFor(() => expect(textarea().disabled).toBe(false));
    const reads = calls(fetchMock, MESSAGES).length;
    const lists = calls(fetchMock, LIST).length;
    messages.reply = () => reconcile.promise;

    fireEvent.click(regenButton());
    fireEvent.click(regenButton());
    await flush();
    const posts = calls(fetchMock, REGEN);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[1]?.method).toBe("POST");
    expect(posts[0]?.[1]?.body).toBeUndefined();
    expect(regenButton().disabled).toBe(true);
    expectLocked();
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();

    regen.resolve(accepted());
    await flush();
    expect(screen.queryByText(REGEN_TOAST)).not.toBeNull();
    expect(source.closeCount).toBe(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expectTranscript(["旧回答"]);
    expectLocked();
    expect(regenButton().disabled).toBe(true);

    messages.reply = () => jsonResponse(N);
    reconcile.resolve(jsonResponse(N));
    await flush();
    expect(assistantArticles()).toHaveLength(1);
    expect(userArticles()).toHaveLength(1);
    expect(screen.queryByText("旧回答")).toBeNull();
    expect(regenButtons()).toHaveLength(0);
    expect(calls(fetchMock, LIST)).toHaveLength(lists + 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expectLocked();

    act(() => latestSource().emitOpen());
    await flush();
    act(() => {
      latestSource().emitData("text.delta", "1:4", { messageId: 5, delta: "新" });
      latestSource().emitData("text.delta", "1:5", { messageId: 5, delta: "回答" });
    });
    expectTranscript(["新回答"]);
    act(() => latestSource().emitData("turn.end", "1:6", { messageId: 5, status: "done" }));
    await flush();
    expectUnlocked();
    const [article] = assistantArticles() as [HTMLElement];
    expect(regenButtons(article)).toHaveLength(1);
    expect(within(article).getByRole("button", { name: "复制" })).toBeTruthy();

    const afterReads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    const next = snapshotOf("running", [...N.messages, message(6, "user", "done", "继续")], 7);
    messages.reply = () => jsonResponse(next);
    fireEvent.change(textarea(), { target: { value: "继续" } });
    fireEvent.click(bar().getByRole("button", { name: "发送" }));
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(afterReads + 1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });

  it.each([
    ["409", envelope("session_busy", "会话正在生成，请稍候"), 409],
    ["400", envelope("bad_request", "请求无效"), 400],
    ["503", envelope("agent_capacity", "Agent 容量已满，请稍后重试"), 503],
  ] as const)("R4 shows a %s envelope inline and unlocks", async (_, body, status) => {
    const { fetchMock, source } = await mount(D, { [REGEN]: () => jsonResponse(body, status) });
    await waitFor(() => expect(textarea().disabled).toBe(false));
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(regenButton());
    await flush();
    expect(calls(fetchMock, REGEN)).toHaveLength(1);
    expect(alerts()).toEqual([body.error.message]);
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();
    expectUnlocked();
    expectTranscript(["旧回答"]);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(source.closeCount).toBe(0);
    expect(regenButton().disabled).toBe(false);
  });

  /** 502 may follow a server commit (old row deleted, new row failed): reconcile from the snapshot. */
  async function failWith502(reconciled: Snapshot) {
    const mounted = await mount(D, { [REGEN]: () => jsonResponse(UNAVAILABLE, 502) });
    await waitFor(() => expect(textarea().disabled).toBe(false));
    const reads = calls(mounted.fetchMock, MESSAGES).length;
    mounted.messages.reply = () => jsonResponse(reconciled);
    fireEvent.click(regenButton());
    await flush();
    expect(calls(mounted.fetchMock, REGEN)).toHaveLength(1);
    expect(alerts()).toEqual([UNAVAILABLE.error.message]);
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();
    expectUnlocked();
    expect(calls(mounted.fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(mounted.source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(2);
  }

  it("R4-502a reconciles a pre-commit 502 back to the unchanged transcript", async () => {
    await failWith502(D);
    expectTranscript(["旧回答"]);
    expect(regenButton().disabled).toBe(false);
  });

  it("R4-502b reconciles a post-commit 502 to the failed replacement row", async () => {
    await failWith502(snapshotOf("failed", [historyUser, message(9, "assistant", "failed")]));
    expect(screen.queryByText("旧回答")).toBeNull();
    expect(userArticles()).toHaveLength(1);
    const [article, ...others] = assistantArticles();
    expect(others).toHaveLength(0);
    const buttons = regenButtons(article);
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it("R5 keeps the refresh guidance after a failed reconcile GET but releases the lock", async () => {
    const observer = observeUnhandledRejections();
    try {
      const { messages } = await mount(D, { [REGEN]: () => accepted() }, true);
      await waitFor(() => expect(textarea().disabled).toBe(false));
      messages.reply = () => jsonResponse(UNAVAILABLE, 502);

      fireEvent.click(regenButton());
      await flush();
      expect(alerts()).toEqual([`Agent 运行时不可用。${GUIDANCE}`]);

      messages.reply = () => jsonResponse(D);
      await selectInNav("other session", OTHER_SESSION_ID);
      await selectInNav("saved title", SESSION_ID);
      expect(alerts()).toEqual([]);
      expectTranscript(["旧回答"]);
      expectUnlocked();
      expect(regenButton().disabled).toBe(false);
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });

  it("R6 lets 停止 run while a regenerate is in flight; a 204 does not stop the reconcile", async () => {
    const regen = deferredResponse();
    const { fetchMock, messages } = await mount(D, {
      [REGEN]: () => regen.promise,
      [STOP]: () => new Response(null, { status: 204 }),
    });
    await waitFor(() => expect(textarea().disabled).toBe(false));

    fireEvent.click(regenButton());
    await flush();
    const stop = bar().getByRole("button", { name: "停止" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(1);
    expect(screen.queryByText("已停止生成")).toBeNull();
    expect(alerts()).toEqual([]);

    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    messages.reply = () => jsonResponse(N);
    regen.resolve(accepted());
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
    expectTranscript([""]);
    expect(screen.queryByText("旧回答")).toBeNull();
  });

  it("R7 keeps 重新生成 disabled while a prompt is in flight", async () => {
    const prompt = deferredResponse();
    const { fetchMock, messages } = await mount(D, { [PROMPT_PATH]: () => prompt.promise });
    await waitFor(() => expect(textarea().disabled).toBe(false));

    fireEvent.change(textarea(), { target: { value: "继续" } });
    fireEvent.click(bar().getByRole("button", { name: "发送" }));
    await flush();
    const button = regenButton();
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(calls(fetchMock, REGEN)).toHaveLength(0);

    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    messages.reply = () => jsonResponse(N);
    prompt.resolve(jsonResponse({ userMessageId: 6, assistantMessageId: 7 }, 202));
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });
});

describe("regenerate button: ownership fences", () => {
  const late = [
    ["202", () => accepted()],
    ["409", () => jsonResponse(envelope("session_busy", "A 会话忙"), 409)],
  ] as const;

  it.each(late)("R8 drops a late %s POST for A after switching to B", async (_, reply) => {
    const regenA = deferredResponse();
    const { fetchMock } = await mount(
      D,
      { [REGEN]: () => regenA.promise, [B_REGEN]: () => jsonResponse(BUSY_B, 409) },
      true,
    );
    await waitFor(() => expect(textarea().disabled).toBe(false));
    fireEvent.click(regenButton());
    await flush();

    await selectInNav("other session", OTHER_SESSION_ID);
    const sourceB = latestSource();
    expectUnlocked();
    expect(regenButton().disabled).toBe(false);
    fireEvent.click(regenButton());
    await flush();
    expect(alerts()).toEqual(["B 会话忙"]);

    const readsA = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    regenA.resolve(reply());
    await flush();
    expect(alerts()).toEqual(["B 会话忙"]);
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();
    expect(sourceB.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(readsA);
    expectTranscript(["B 回答"]);
    expectUnlocked();
  });

  it("R9 drops a late 200 reconcile GET for A after switching to B", async () => {
    const getA = deferredResponse();
    const { messages } = await mount(D, { [REGEN]: () => accepted() }, true);
    await waitFor(() => expect(textarea().disabled).toBe(false));
    messages.reply = () => getA.promise;
    fireEvent.click(regenButton());
    await flush();

    await selectInNav("other session", OTHER_SESSION_ID);
    const sourceB = latestSource();
    const sources = FakeEventSource.instances.length;
    getA.resolve(jsonResponse(N));
    await flush();
    expect(sourceB.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expectTranscript(["B 回答"]);
    expect(screen.queryByText("旧回答")).toBeNull();
    expectUnlocked();
  });

  it("R9 drops a late 502 reconcile GET for A without touching B's stream error", async () => {
    const getA = deferredResponse();
    const { messages } = await mount(D, { [REGEN]: () => accepted() }, true);
    await waitFor(() => expect(textarea().disabled).toBe(false));
    messages.reply = () => getA.promise;
    fireEvent.click(regenButton());
    await flush();

    await selectInNav("other session", OTHER_SESSION_ID);
    act(() => latestSource().emitTransport(2));
    await flush();
    const own = alerts();
    expect(own).toHaveLength(1);
    expect(own[0]).toContain(GUIDANCE);

    getA.resolve(jsonResponse(UNAVAILABLE, 502));
    await flush();
    expect(alerts()).toEqual(own);
    expect(textarea().disabled).toBe(true);
    // B 的连接器终止失败只锁定输入框（chat-web「锁定不等于生成中」）。
    expect(bar().queryByText("生成中")).toBeNull();
    expect(bar().queryByRole("button", { name: "停止" })).toBeNull();
    expectTranscript(["B 回答"]);
    expect(screen.queryByText("旧回答")).toBeNull();
  });

  it("R10 releases the regenerate lock by identity, never another session's", async () => {
    const regenA = deferredResponse();
    const regenB = deferredResponse();
    await mount(D, { [REGEN]: () => regenA.promise, [B_REGEN]: () => regenB.promise }, true);
    await waitFor(() => expect(textarea().disabled).toBe(false));
    fireEvent.click(regenButton());
    await flush();

    await selectInNav("other session", OTHER_SESSION_ID);
    fireEvent.click(regenButton());
    await flush();
    expectLocked();

    regenA.resolve(jsonResponse(envelope("session_busy", "A 会话忙"), 409));
    await flush();
    expectLocked();
    expect(alerts()).toEqual([]);

    regenB.resolve(jsonResponse(BUSY_B, 409));
    await flush();
    expectUnlocked();
    expect(alerts()).toEqual(["B 会话忙"]);
  });

  it.each(late)("R11 drops a late %s from the old client after renewal", async (_, reply) => {
    const stale = deferredResponse();
    let posts = 0;
    const { getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      [LIST]: () => jsonResponse({ sessions: [D.session] }),
      [MESSAGES]: () => jsonResponse(D),
      [REGEN]: () => {
        posts += 1;
        return posts === 1
          ? stale.promise
          : jsonResponse(envelope("session_busy", "新账号忙"), 409);
      },
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(textarea().disabled).toBe(false));
    fireEvent.click(regenButton());
    await flush();

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    const current = latestSource();
    fireEvent.click(regenButton());
    await flush();
    expect(posts).toBe(2);
    expect(alerts()).toEqual(["新账号忙"]);

    stale.resolve(reply());
    await flush();
    expect(alerts()).toEqual(["新账号忙"]);
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();
    expect(current.closeCount).toBe(0);
    expectUnlocked();
  });

  it("R12 drops a 202 that lands after the chat page unmounted", async () => {
    const regen = deferredResponse();
    const { fetchMock, router } = await mount(D, { [REGEN]: () => regen.promise });
    await waitFor(() => expect(textarea().disabled).toBe(false));
    fireEvent.click(regenButton());
    await flush();

    await act(async () => {
      await router.navigate("/center");
    });
    expect(await screen.findByText("中心暂不可用")).toBeTruthy();
    const reads = calls(fetchMock, MESSAGES).length;
    const consoleError = vi.spyOn(console, "error");

    regen.resolve(accepted());
    await flush();
    expect(screen.queryByText(REGEN_TOAST)).toBeNull();
    expect(alerts()).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
  });
});
