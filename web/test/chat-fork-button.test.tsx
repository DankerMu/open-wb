import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot, ChatSession } from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
} from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  FakeEventSource,
  historyUser,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import {
  calls,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";

const FORK_ID = "c".repeat(32);
const FORK = `/api/sessions/${SESSION_ID}/fork`;
const B_FORK = `/api/sessions/${OTHER_SESSION_ID}/fork`;
const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const B_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const N_MESSAGES = `/api/sessions/${FORK_ID}/messages`;
const REGEN = `/api/sessions/${SESSION_ID}/regenerate`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const LIST = "/api/sessions";
const QUERY = "&tab=x#frag";
const A_URL = `/?session=${SESSION_ID}${QUERY}`;
const FORK_LABEL = "从此处分叉";

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type Cursor = Snapshot["streamCursor"];

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

const BUSY_B = envelope("session_busy", "B 会话忙");

function message(id: number, role: Message["role"], status: Message["status"], content: string) {
  return { ...historyUser, id, role, status, content, createdAt: id };
}

function session(id: string, status: ChatSession["status"], title: string, updatedAt: number) {
  return { id, title, status, createdAt: 1_740_000_000_000, updatedAt, ...NULL_SESSION_META };
}

function snapshotOf(
  s: ChatSession,
  messages: Message[],
  streamCursor: Cursor = { epoch: 1, seq: 0 },
) {
  return { session: s, messages, streamCursor };
}

/** S：A 的 done 会话，u1/a2/u3/a4，cursor `1:0`。 */
const S = snapshotOf(session(SESSION_ID, "done", "saved title", 1_740_000_000_023), [
  message(1, "user", "done", "first question"),
  message(2, "assistant", "done", "一"),
  message(3, "user", "done", "second question"),
  message(4, "assistant", "done", "二"),
]);
/** N：分叉出的 done 会话（复制 u1/a2），updatedAt 大于 A。 */
const N = snapshotOf(
  session(FORK_ID, "done", "saved title", 1_740_000_000_099),
  [message(10, "user", "done", "first question"), message(11, "assistant", "done", "一")],
  { epoch: 0, seq: null },
);
/** N0：从首条用户消息分叉，无历史的 idle 会话。 */
const N0 = snapshotOf(session(FORK_ID, "idle", "saved title", 1_740_000_000_099), [], {
  epoch: 0,
  seq: null,
});
const B = snapshotOf(session(OTHER_SESSION_ID, "done", "other session", 1_740_000_000_010), [
  message(21, "user", "done", "B 问"),
  message(22, "assistant", "done", "B 回答"),
]);

const forked = (s: Snapshot, draft: string) => jsonResponse({ session: s.session, draft }, 201);

/** 以 `?session=A&tab=x#frag` 挂载并 open。`listing.sessions` 决定此后列表 GET 的回复。 */
async function mount(initial: Snapshot, routes: FetchRoutes = {}, withB = false) {
  const listing = { sessions: withB ? [initial.session, B.session] : [initial.session] };
  const mounted = renderChatPage(`/?session=${SESSION_ID}${QUERY}`, {
    [LIST]: () => jsonResponse({ sessions: listing.sessions }),
    [MESSAGES]: () => jsonResponse(initial),
    [B_MESSAGES]: () => jsonResponse(B),
    [N_MESSAGES]: () => jsonResponse(N),
    ...routes,
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  await waitFor(() => expect(textarea().disabled).toBe(initial.session.status === "running"));
  return { fetchMock: mounted.fetchMock, listing, router: mounted.router, source };
}

async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

function listGets(fetchMock: FetchMock) {
  return calls(fetchMock, LIST).filter(([, init]) => init?.method !== "POST").length;
}

function expectNothingSent(fetchMock: FetchMock) {
  expect(paths(fetchMock).filter((path) => path.endsWith("/prompt"))).toEqual([]);
  expect(calls(fetchMock, LIST).filter(([, init]) => init?.method === "POST")).toEqual([]);
}

function forkButtons(scope: HTMLElement = document.body) {
  return within(scope).queryAllByRole("button", { name: FORK_LABEL }) as HTMLButtonElement[];
}

function forkButton(scope: HTMLElement) {
  const [button, ...rest] = forkButtons(scope);
  expect(rest).toHaveLength(0);
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

function regenButton() {
  return screen.getByRole("button", { name: "重新生成" }) as HTMLButtonElement;
}

function bar() {
  const element = document.querySelector<HTMLElement>("form .chat-composer-toolbar");
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

function sendButton() {
  return bar().getByRole("button", { name: "发送" }) as HTMLButtonElement;
}

function textarea() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function typeDraft(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

function userArticles() {
  return screen.queryAllByRole("article", { name: "用户" }) as HTMLElement[];
}

function assistantArticles() {
  return screen.queryAllByRole("article", { name: "助手" }) as HTMLElement[];
}

function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

/** 消息区内按序的正文：用户取 `p.chat-msg-body`，助手取 `.chat-md`。 */
function transcript() {
  const region = screen.queryByRole("region", { name: "消息" });
  if (!region) {
    return [];
  }
  return within(region)
    .queryAllByRole("article")
    .map((article) => article.querySelector(".chat-msg-body, .chat-md")?.textContent ?? "");
}

function nav() {
  return screen.getByRole("navigation", { name: "会话列表" });
}

async function selectInNav(title: string, sessionId: string) {
  fireEvent.click(within(nav()).getByRole("button", { name: title }));
  await expectChatLocation(`/?session=${sessionId}${QUERY}`);
  await flush();
}

async function clickFork(scope: HTMLElement) {
  fireEvent.click(forkButton(scope));
  await flush();
}

afterEach(() => {
  cleanupChatLifecycle();
  vi.restoreAllMocks();
});

describe("fork button: availability", () => {
  it("F1 puts exactly one enabled 从此处分叉 at the end of every user bubble only", async () => {
    await mount(S);
    const users = userArticles();
    expect(users).toHaveLength(2);
    for (const user of users) {
      const button = forkButton(user);
      expect(within(user).getAllByRole("button")).toEqual([button]);
      expect(button.disabled).toBe(false);
      expect(button.type).toBe("button");
      expect(button.title).toBe(FORK_LABEL);
      expect(button.querySelector("svg.lucide-git-branch")).not.toBeNull();
      const row = button.closest(".chat-msg-actions");
      expect(row).not.toBeNull();
      expect(user.lastElementChild).toBe(row);
      const body = user.querySelector("p.chat-msg-body");
      expect(user.querySelector("p")).toBe(body);
      expect(
        (body as Node).compareDocumentPosition(row as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    const assistants = assistantArticles();
    expect(assistants).toHaveLength(2);
    for (const assistant of assistants) {
      expect(forkButtons(assistant)).toHaveLength(0);
    }
  });

  it("F1 renders 从此处分叉 disabled while the snapshot is running", async () => {
    const running = snapshotOf(session(SESSION_ID, "running", "saved title", 1_740_000_000_023), [
      message(1, "user", "done", "first question"),
      message(2, "assistant", "running", ""),
    ]);
    const { fetchMock } = await mount(running, { [FORK]: () => forked(N, "x") });
    const [user] = userArticles() as [HTMLElement];
    const button = forkButton(user);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(calls(fetchMock, FORK)).toHaveLength(0);
  });
});

describe("fork button: request, navigation and draft", () => {
  it("F2 forks u3 once, navigates with search/hash, refreshes the list and never sends", async () => {
    const fork = deferredResponse();
    const { fetchMock, listing, source } = await mount(S, { [FORK]: () => fork.promise });
    typeDraft("旧草稿");
    const [, u3] = userArticles() as [HTMLElement, HTMLElement];
    fireEvent.click(forkButton(u3));
    fireEvent.click(forkButton(u3));
    await flush();

    const posts = calls(fetchMock, FORK);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[1]?.method).toBe("POST");
    expect(posts[0]?.[1]?.body).toBe('{"messageId":3}');
    expect(forkButtons().map((button) => button.disabled)).toEqual([true, true]);
    expect(regenButton().disabled).toBe(true);
    expect(textarea().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(bar().queryByRole("button", { name: "停止" })).toBeNull();
    expect(bar().queryByText("生成中")).toBeNull();
    expect(currentLocation()).toBe(A_URL);

    const lists = listGets(fetchMock);
    listing.sessions = [N.session, S.session];
    fork.resolve(forked(N, "second question"));
    await flush();
    expect(currentLocation()).toBe(`/?session=${FORK_ID}${QUERY}`);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(source.closeCount).toBe(1);
    expect(calls(fetchMock, N_MESSAGES)).toHaveLength(1);
    const next = latestSource();
    expect(next.url).toBe(`/api/sessions/${FORK_ID}/events`);
    expect(transcript()).toEqual(["first question", "一"]);
    expect(regenButton().disabled).toBe(false);
    expect(listGets(fetchMock)).toBe(lists + 1);
    expect(within(nav()).getAllByRole("button", { name: "saved title" })).toHaveLength(2);
    const current = within(nav()).getByRole("button", { current: true });
    expect(within(current).getByRole("status").getAttribute("aria-label")).toBe(
      "saved title 已完成",
    );
    expect(textarea().value).toBe("second question");
    expect(textarea().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);

    act(() => next.emitOpen());
    await flush();
    expect(textarea().value).toBe("second question");
    expectNothingSent(fetchMock);
    expect(alerts()).toEqual([]);
  });

  it("F3 forks the first user message into an idle session with the draft only", async () => {
    const { fetchMock, listing } = await mount(S, {
      [FORK]: () => forked(N0, "first question"),
      [N_MESSAGES]: () => jsonResponse(N0),
    });
    listing.sessions = [N0.session, S.session];
    const [u1] = userArticles() as [HTMLElement];
    await clickFork(u1);

    const posts = calls(fetchMock, FORK);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[1]?.method).toBe("POST");
    expect(posts[0]?.[1]?.body).toBe('{"messageId":1}');
    await expectChatLocation(`/?session=${FORK_ID}${QUERY}`);
    await waitFor(() => expect(calls(fetchMock, N_MESSAGES)).toHaveLength(1));
    await flush();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "重新生成" })).toBeNull();
    const current = within(nav()).getByRole("button", { current: true });
    expect(within(current).getByRole("status").getAttribute("aria-label")).toBe(
      "saved title 未开始",
    );
    expect(textarea().value).toBe("first question");
    expect(textarea().disabled).toBe(false);
    expectNothingSent(fetchMock);
  });

  it.each([
    ["(a) a pending prompt", "prompt"],
    ["(b) a pending regenerate", "regen"],
  ] as const)("F4 keeps every 从此处分叉 disabled during %s", async (_, kind) => {
    const pending = deferredResponse();
    const { fetchMock } = await mount(S, {
      [PROMPT_PATH]: () => pending.promise,
      [REGEN]: () => pending.promise,
      [FORK]: () => forked(N, "x"),
    });
    if (kind === "prompt") {
      typeDraft("继续");
      fireEvent.click(sendButton());
    } else {
      fireEvent.click(regenButton());
    }
    await flush();
    const buttons = forkButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    await flush();
    expect(calls(fetchMock, FORK)).toHaveLength(0);
  });

  it.each([
    ["400", () => jsonResponse(envelope("bad_request", "请求无效"), 400), "请求无效"],
    ["409", () => jsonResponse(envelope("session_busy", "会话正在生成"), 409), "会话正在生成"],
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502), "Agent 不可用"],
    [
      "503",
      () => jsonResponse(envelope("agent_capacity", "Agent 容量已满，请稍后重试"), 503),
      "Agent 容量已满，请稍后重试",
    ],
    ["network", () => new TypeError("offline"), "请求失败，请稍后重试"],
  ] as const)("F5 shows a %s failure inline and changes nothing else", async (_, reply, text) => {
    const { fetchMock, source } = await mount(S, { [FORK]: reply });
    typeDraft("我的草稿");
    const lists = listGets(fetchMock);
    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    const [, u3] = userArticles() as [HTMLElement, HTMLElement];
    await clickFork(u3);

    expect(calls(fetchMock, FORK)).toHaveLength(1);
    expect(alerts()).toEqual([text]);
    expect(currentLocation()).toBe(A_URL);
    expect(textarea().value).toBe("我的草稿");
    expect(textarea().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(listGets(fetchMock)).toBe(lists);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(source.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(transcript()).toEqual(["first question", "一", "second question", "二"]);
    expect(forkButtons().map((button) => button.disabled)).toEqual([false, false]);
  });
});

describe("fork button: ownership fences", () => {
  const late = [
    ["201", () => forked(N, "second question")],
    ["409", () => jsonResponse(envelope("session_busy", "A 会话忙"), 409)],
  ] as const;

  it.each(late)("F6 drops a late %s for A after switching to B", async (_, reply) => {
    const forkA = deferredResponse();
    const { fetchMock, listing } = await mount(
      S,
      { [FORK]: () => forkA.promise, [B_FORK]: () => jsonResponse(BUSY_B, 409) },
      true,
    );
    const [, u3] = userArticles() as [HTMLElement, HTMLElement];
    await clickFork(u3);

    await selectInNav("other session", OTHER_SESSION_ID);
    const sourceB = latestSource();
    const [u21] = userArticles() as [HTMLElement];
    expect(textarea().disabled).toBe(false);
    expect(forkButton(u21).disabled).toBe(false);
    typeDraft("B 草稿");
    await clickFork(u21);
    expect(alerts()).toEqual(["B 会话忙"]);

    const lists = listGets(fetchMock);
    const sources = FakeEventSource.instances.length;
    listing.sessions = [N.session, S.session, B.session];
    forkA.resolve(reply());
    await flush();
    expect(alerts()).toEqual(["B 会话忙"]);
    expect(currentLocation()).toBe(`/?session=${OTHER_SESSION_ID}${QUERY}`);
    expect(textarea().value).toBe("B 草稿");
    expect(listGets(fetchMock)).toBe(lists);
    expect(calls(fetchMock, N_MESSAGES)).toHaveLength(0);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(sourceB.closeCount).toBe(0);
    expect(transcript()).toEqual(["B 问", "B 回答"]);
  });

  it("F7 releases the fork lock by identity, never another session's", async () => {
    const forkA = deferredResponse();
    const forkB = deferredResponse();
    await mount(S, { [FORK]: () => forkA.promise, [B_FORK]: () => forkB.promise }, true);
    const [, u3] = userArticles() as [HTMLElement, HTMLElement];
    await clickFork(u3);
    await selectInNav("other session", OTHER_SESSION_ID);
    const [u21] = userArticles() as [HTMLElement];
    await clickFork(u21);
    expect(textarea().disabled).toBe(true);

    forkA.resolve(jsonResponse(envelope("session_busy", "A 会话忙"), 409));
    await flush();
    expect(textarea().disabled).toBe(true);
    expect(forkButton(u21).disabled).toBe(true);
    expect(alerts()).toEqual([]);

    forkB.resolve(jsonResponse(BUSY_B, 409));
    await flush();
    expect(textarea().disabled).toBe(false);
    expect(forkButton(u21).disabled).toBe(false);
    expect(alerts()).toEqual(["B 会话忙"]);
  });

  it("F8 drops a late 201 after leaving A and coming back (ABA)", async () => {
    const forkA = deferredResponse();
    const { fetchMock, listing } = await mount(S, { [FORK]: () => forkA.promise }, true);
    const [, u3] = userArticles() as [HTMLElement, HTMLElement];
    await clickFork(u3);
    await selectInNav("other session", OTHER_SESSION_ID);
    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(["first question", "一", "second question", "二"]);
    expect(textarea().disabled).toBe(true);

    const lists = listGets(fetchMock);
    listing.sessions = [N.session, S.session, B.session];
    forkA.resolve(forked(N, "second question"));
    await flush();
    expect(currentLocation()).toBe(A_URL);
    expect(listGets(fetchMock)).toBe(lists);
    expect(calls(fetchMock, N_MESSAGES)).toHaveLength(0);
    expect(textarea().disabled).toBe(false);
    expect(textarea().value).toBe("");
  });

  it.each(late)("F9 drops a late %s from the old client after renewal", async (_, reply) => {
    const stale = deferredResponse();
    let posts = 0;
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      [LIST]: () => jsonResponse({ sessions: [S.session] }),
      [MESSAGES]: () => jsonResponse(S),
      [N_MESSAGES]: () => jsonResponse(N),
      [FORK]: () => {
        posts += 1;
        return posts === 1
          ? stale.promise
          : jsonResponse(envelope("session_busy", "新账号忙"), 409);
      },
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(textarea().disabled).toBe(false));
    await clickFork((userArticles() as [HTMLElement, HTMLElement])[1]);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    typeDraft("新草稿");
    await clickFork((userArticles() as [HTMLElement, HTMLElement])[1]);
    expect(posts).toBe(2);
    expect(alerts()).toEqual(["新账号忙"]);

    const lists = listGets(fetchMock);
    stale.resolve(reply());
    await flush();
    expect(alerts()).toEqual(["新账号忙"]);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
    expect(textarea().value).toBe("新草稿");
    expect(calls(fetchMock, N_MESSAGES)).toHaveLength(0);
    expect(listGets(fetchMock)).toBe(lists);
  });

  it("F10 drops a 201 that lands after the chat page unmounted", async () => {
    const observer = observeUnhandledRejections();
    try {
      const fork = deferredResponse();
      const { fetchMock, router } = await mount(S, { [FORK]: () => fork.promise });
      await clickFork((userArticles() as [HTMLElement, HTMLElement])[1]);

      await act(async () => {
        await router.navigate("/center");
      });
      expect(await screen.findByText("中心暂不可用")).toBeTruthy();
      const lists = listGets(fetchMock);
      const consoleError = vi.spyOn(console, "error");

      fork.resolve(forked(N, "second question"));
      await flush();
      expect(currentLocation().startsWith("/center")).toBe(true);
      expect(listGets(fetchMock)).toBe(lists);
      expect(calls(fetchMock, N_MESSAGES)).toHaveLength(0);
      expect(consoleError).not.toHaveBeenCalled();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});
