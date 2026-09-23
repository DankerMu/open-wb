import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot, ChatSession } from "../src/lib/session-contract.js";
import { cleanupChatPage, expectChatLocation, renderChatPage } from "./chat-page-support.js";
import {
  COMPLETED_BODY,
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  runningSession,
  SESSION_ID,
} from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse, replaceFetchRoutes } from "./support.js";

const CREATED_SESSION_ID = "fedcba9876543210fedcba9876543210";
const OTHER_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_SESSION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROMPT = "你好";
const FOLLOW_UP = "再问一次";
const AGENT_UNAVAILABLE = "Agent 运行时不可用";
const SESSION_BUSY = "会话正在生成，请稍候";
const BUSINESS_ERROR = "Agent execution failed";
const BASH_START_DETAIL = '{"command":"echo workbuddy-smoke"}';
const BASH_RESULT_DETAIL = '{"output":"workbuddy-smoke"}';
const STREAMED_BODY = "Hello \u0000\uFEFF中文 😀";
const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
const promptAccepted = { userMessageId: -3, assistantMessageId: 0 };
const CREATED_MESSAGES = `/api/sessions/${CREATED_SESSION_ID}/messages`;
const CREATED_PROMPT = `/api/sessions/${CREATED_SESSION_ID}/prompt`;
const SESSION_MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const SESSION_PROMPT = `/api/sessions/${SESSION_ID}/prompt`;
const OTHER_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const UNKNOWN_MESSAGES = `/api/sessions/${UNKNOWN_SESSION_ID}/messages`;

afterEach(() => {
  cleanupChatPage();
});

function composer() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function sendButton() {
  return screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
}

async function findMessageArea() {
  return screen.findByRole("region", { name: "消息" });
}

async function mountRunningSnapshot(snapshot: ChatMessageSnapshot) {
  const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [SESSION_MESSAGES]: () => jsonResponse(snapshot),
  });
  const messages = await findMessageArea();
  expect(await within(messages).findByText("Hello ", exactText)).toBeTruthy();
  return { ...mounted, messages, source: latestSource() };
}

function envelope(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

function idleCreatedSession(): ChatSession {
  return {
    id: CREATED_SESSION_ID,
    title: null,
    status: "idle",
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_000,
  };
}

function titledCreatedSession(): ChatSession {
  return {
    ...idleCreatedSession(),
    title: PROMPT,
    status: "done",
    updatedAt: 1_740_000_000_050,
  };
}

function emptyCreatedSnapshot(): ChatMessageSnapshot {
  return {
    session: idleCreatedSession(),
    messages: [],
    streamCursor: { epoch: 1, seq: 0 },
  };
}

function runningCreatedSnapshot(): ChatMessageSnapshot {
  return {
    session: {
      ...idleCreatedSession(),
      title: PROMPT,
      status: "running",
      updatedAt: 1_740_000_000_040,
    },
    messages: [
      {
        id: -3,
        role: "user",
        content: PROMPT,
        status: "done",
        createdAt: -1,
        steps: [],
      },
      {
        id: 0,
        role: "assistant",
        content: "",
        status: "running",
        createdAt: 0,
        steps: [],
      },
    ],
    streamCursor: { epoch: 1, seq: 0 },
  };
}

function completedCreatedSnapshot(): ChatMessageSnapshot {
  return {
    session: titledCreatedSession(),
    messages: [
      {
        id: -3,
        role: "user",
        content: PROMPT,
        status: "done",
        createdAt: -1,
        steps: [],
      },
      {
        id: 0,
        role: "assistant",
        content: STREAMED_BODY,
        status: "done",
        createdAt: 0,
        steps: [
          {
            id: 11,
            ordinal: 0,
            name: "bash",
            detail: BASH_RESULT_DETAIL,
            status: "done",
          },
        ],
      },
    ],
    streamCursor: { epoch: 1, seq: 7 },
  };
}

function otherIdleSession(): ChatSession {
  return {
    id: OTHER_SESSION_ID,
    title: "other session",
    status: "idle",
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_100,
  };
}

function otherSnapshot(): ChatMessageSnapshot {
  return {
    session: otherIdleSession(),
    messages: [
      {
        id: -5,
        role: "user",
        content: "other user",
        status: "done",
        createdAt: -2,
        steps: [],
      },
    ],
    streamCursor: { epoch: 1, seq: null },
  };
}

function olderListedSession(): ChatSession {
  return {
    id: SESSION_ID,
    title: "older title",
    status: "idle",
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_010,
  };
}

async function typeAndSend(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(sendButton());
}

function freshSnapshot(body: ChatMessageSnapshot) {
  return () => jsonResponse(body);
}

describe("chat page create and acceptance ownership", () => {
  it("creates once from an empty send, streams the turn, then unlocks after authoritative done", async () => {
    let creates = 0;
    let prompts = 0;
    let currentSnapshot: ChatMessageSnapshot = emptyCreatedSnapshot();
    const pendingAccept = deferredResponse();
    const pendingReconcile = deferredResponse();
    let messageReads = 0;
    renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          creates += 1;
          return jsonResponse(idleCreatedSession(), 201);
        }
        return jsonResponse({
          sessions: currentSnapshot.session.title ? [currentSnapshot.session] : [],
        });
      },
      [CREATED_PROMPT]: (_path, options) => {
        prompts += 1;
        expect(options?.body).toBe(JSON.stringify({ message: PROMPT }));
        return pendingAccept.promise;
      },
      [CREATED_MESSAGES]: () => {
        messageReads += 1;
        if (messageReads === 1) {
          return pendingReconcile.promise;
        }
        return jsonResponse(currentSnapshot);
      },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "会话" })).toBeTruthy();
    await screen.findByRole("button", { name: "新建会话" });
    await typeAndSend(PROMPT);
    await expectChatLocation(`/?session=${CREATED_SESSION_ID}`);
    await waitFor(() => {
      expect(prompts).toBe(1);
    });
    expect(creates).toBe(1);
    expect(composer().disabled).toBe(true);
    currentSnapshot = runningCreatedSnapshot();
    pendingAccept.resolve(jsonResponse(promptAccepted, 202));
    await waitFor(() => {
      expect(messageReads).toBe(1);
    });
    pendingReconcile.resolve(jsonResponse(currentSnapshot));
    const messages = await findMessageArea();
    expect(await within(messages).findByText(PROMPT, { exact: true })).toBeTruthy();
    expect(composer().disabled).toBe(true);
    const source = latestSource();
    expect(source.url).toBe(`/api/sessions/${CREATED_SESSION_ID}/events`);

    act(() => {
      source.emitOpen();
      source.emitData("turn.start", "1:1", { messageId: 0 });
      source.emitData("step.start", "1:2", {
        messageId: 0,
        stepId: 11,
        name: "bash",
        detail: BASH_START_DETAIL,
      });
      source.emitData("step.end", "1:3", {
        messageId: 0,
        stepId: 11,
        status: "done",
        detail: BASH_RESULT_DETAIL,
      });
      source.emitData("text.delta", "1:4", { messageId: 0, delta: "Hello " });
      source.emitData("text.delta", "1:5", { messageId: 0, delta: "\u0000\uFEFF中文" });
      source.emitData("text.delta", "1:6", { messageId: 0, delta: " 😀" });
      source.emitData("turn.end", "1:7", { messageId: 0, status: "done" });
    });
    currentSnapshot = completedCreatedSnapshot();

    expect(await within(messages).findByText(STREAMED_BODY, exactText)).toBeTruthy();
    expect(within(messages).getByText(PROMPT, { exact: true })).toBeTruthy();
    expect(within(messages).getByText("bash", { exact: true })).toBeTruthy();
    expect(within(messages).getByText(BASH_RESULT_DETAIL, { exact: true })).toBeTruthy();
    expect(composer().disabled).toBe(false);
  });

  it("keeps one completed pair when terminal events arrive before prompt 202", async () => {
    const pendingPrompt = deferredResponse();
    let currentSnapshot: ChatMessageSnapshot = {
      session: { ...runningSession("idle"), title: "saved title" },
      messages: [historyUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [currentSnapshot.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(currentSnapshot),
      [SESSION_PROMPT]: pendingPrompt.promise,
    });

    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const source = latestSource();
    await typeAndSend(PROMPT);
    expect(composer().disabled).toBe(true);

    act(() => {
      source.emitOpen();
      source.emitData("turn.start", "1:1", { messageId: 0 });
      source.emitData("text.delta", "1:2", { messageId: 0, delta: COMPLETED_BODY });
      source.emitData("turn.end", "1:3", { messageId: 0, status: "done" });
    });
    const messages = await findMessageArea();
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();

    currentSnapshot = chatSnapshot({
      status: "done",
      content: COMPLETED_BODY,
      assistantStatus: "done",
      cursor: { epoch: 1, seq: 3 },
    });
    pendingPrompt.resolve(jsonResponse(promptAccepted, 202));
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();
    expect(within(messages).getAllByText(historyUser.content, exactText)).toHaveLength(1);
    expect(composer().disabled).toBe(false);
    expect(screen.queryByText("生成中", { exact: true })).toBeNull();
  });

  it("does not lose the create-send prompt across its own session URL handoff", async () => {
    const pendingCreate = deferredResponse();
    const pendingPrompt = deferredResponse();
    let creates = 0;
    let prompts = 0;
    let currentSnapshot: ChatMessageSnapshot = emptyCreatedSnapshot();
    renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          creates += 1;
          return pendingCreate.promise;
        }
        return jsonResponse({ sessions: [] });
      },
      [CREATED_PROMPT]: () => {
        prompts += 1;
        return pendingPrompt.promise;
      },
      [CREATED_MESSAGES]: () => jsonResponse(currentSnapshot),
    });

    await screen.findByRole("button", { name: "新建会话" });
    await typeAndSend(PROMPT);
    expect(creates).toBe(1);
    expect(prompts).toBe(0);

    pendingCreate.resolve(jsonResponse(idleCreatedSession(), 201));
    await expectChatLocation(`/?session=${CREATED_SESSION_ID}`);
    await waitFor(() => {
      expect(prompts).toBe(1);
    });
    currentSnapshot = completedCreatedSnapshot();
    pendingPrompt.resolve(jsonResponse(promptAccepted, 202));
    const messages = await findMessageArea();
    expect(await within(messages).findByText(PROMPT, { exact: true })).toBeTruthy();
    expect(creates).toBe(1);
    expect(prompts).toBe(1);
  });
});

describe("chat page isolation and errors", () => {
  it("discards a stale create after the user selects another session", async () => {
    const pendingCreate = deferredResponse();
    let prompts = 0;
    renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          return pendingCreate.promise;
        }
        return jsonResponse({ sessions: [otherIdleSession()] });
      },
      [CREATED_PROMPT]: () => {
        prompts += 1;
        return jsonResponse(promptAccepted, 202);
      },
      [OTHER_MESSAGES]: freshSnapshot(otherSnapshot()),
    });

    await screen.findByRole("button", { name: "other session" });
    await typeAndSend(PROMPT);
    fireEvent.click(screen.getByRole("button", { name: "other session" }));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    const messages = await findMessageArea();
    expect(await within(messages).findByText("other user", { exact: true })).toBeTruthy();

    pendingCreate.resolve(jsonResponse(idleCreatedSession(), 201));
    await waitFor(() => {
      expect(currentLocation()).toBe(`/?session=${OTHER_SESSION_ID}`);
    });
    expect(prompts).toBe(0);
    expect(within(messages).queryByText(PROMPT, { exact: true })).toBeNull();
  });

  it("replaces an inaccessible deep link without opening EventSource and keeps other search", async () => {
    renderChatPage(`/?from=keep&session=${UNKNOWN_SESSION_ID}#hash`, {
      "/api/sessions": () => jsonResponse({ sessions: [otherIdleSession()] }),
      [UNKNOWN_MESSAGES]: envelope(404, "not_found", "会话不存在"),
    });

    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    await expectChatLocation(`/?from=keep#hash`);
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByText("other user", { exact: true })).toBeNull();
    expect(screen.getByText("选择一个会话，或直接发送开始新对话", { exact: true })).toBeTruthy();
  });

  it("shows a 502 envelope without speculative rows and keeps 409 on the busy session", async () => {
    const idle = runningSession("idle");
    const idleSnapshot: ChatMessageSnapshot = {
      session: idle,
      messages: [historyUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [idle] }),
      [SESSION_MESSAGES]: freshSnapshot(idleSnapshot),
      [SESSION_PROMPT]: envelope(502, "agent_unavailable", AGENT_UNAVAILABLE),
    });

    await screen.findByRole("button", { name: "新建会话" });
    await typeAndSend(PROMPT);
    expect((await screen.findByRole("alert")).textContent).toBe(AGENT_UNAVAILABLE);
    expect(screen.queryByText(PROMPT, { exact: true })).toBeNull();
    expect(composer().disabled).toBe(false);

    cleanupChatPage();
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [idle] }),
      [SESSION_MESSAGES]: freshSnapshot(idleSnapshot),
      [SESSION_PROMPT]: envelope(409, "session_busy", SESSION_BUSY),
    });
    await screen.findByRole("button", { name: "新建会话" });
    await typeAndSend(PROMPT);
    expect((await screen.findByRole("alert")).textContent).toBe(SESSION_BUSY);
  });

  it("keeps idle history locked after accepted 202 when snapshot reconciliation fails", async () => {
    const idle = runningSession("idle");
    const idleSnapshot: ChatMessageSnapshot = {
      session: idle,
      messages: [historyUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    let messageReads = 0;
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [idle] }),
      [SESSION_MESSAGES]: () => {
        messageReads += 1;
        if (messageReads === 1) {
          return jsonResponse(idleSnapshot);
        }
        return envelope(503, "unavailable", "controlled snapshot unavailable");
      },
      [SESSION_PROMPT]: jsonResponse(promptAccepted, 202),
    });

    await screen.findByRole("button", { name: "新建会话" });
    const messages = await findMessageArea();
    expect(await within(messages).findByText(historyUser.content, exactText)).toBeTruthy();
    await typeAndSend(PROMPT);
    expect(await screen.findByText(/controlled snapshot unavailable/)).toBeTruthy();
    expect(await screen.findByText(/请刷新页面后重试/)).toBeTruthy();
    expect(within(messages).getByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.queryByText(PROMPT, { exact: true })).toBeNull();
    expect(composer().disabled).toBe(true);
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
  });

  it("keeps business error on the message and locks a still-running snapshot after terminal stream failure", async () => {
    const snapshot = chatSnapshot({
      content: "Hello ",
      steps: [{ id: 11, ordinal: 0, name: "bash", detail: BASH_START_DETAIL, status: "running" }],
      cursor: { epoch: 1, seq: 3 },
    });
    const { messages, source } = await mountRunningSnapshot(snapshot);
    act(() => {
      source.emitOpen();
      source.emitData("error", "1:4", { messageId: 0, message: BUSINESS_ERROR });
    });
    expect(await within(messages).findByText(BUSINESS_ERROR, { exact: true })).toBeTruthy();
    expect(within(messages).getByText("Hello ", exactText)).toBeTruthy();

    act(() => {
      source.emitTransport(2);
    });
    expect(within(messages).getByRole("alert").textContent).toBe(BUSINESS_ERROR);
    expect(await screen.findByText(/请刷新页面后重试/)).toBeTruthy();
    expect(composer().disabled).toBe(true);
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
  });

  it("hands a current 401 to login and closes the live source", async () => {
    const snapshot = chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } });
    const { fetchMock, source } = await mountRunningSnapshot(snapshot);
    expect(source.closeCount).toBe(0);

    replaceFetchRoutes(fetchMock, {
      "/api/auth/me": jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
      "/api/sessions": jsonResponse(
        { error: { code: "unauthorized", message: "登录已失效" } },
        401,
      ),
      [SESSION_MESSAGES]: jsonResponse(
        { error: { code: "unauthorized", message: "登录已失效" } },
        401,
      ),
    });
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await waitFor(() => {
      expect(source.closeCount).toBe(1);
    });
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
  });

  it("closes the source on unmount under StrictMode without leaving EventSource instances open", async () => {
    const snapshot = chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } });
    const { view } = renderChatPage(
      `/?session=${SESSION_ID}`,
      {
        "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
        [SESSION_MESSAGES]: freshSnapshot(snapshot),
      },
      true,
    );
    const messages = await findMessageArea();
    expect(await within(messages).findByText("Hello ", exactText)).toBeTruthy();
    const source = latestSource();
    view.unmount();
    expect(source.closeCount).toBeGreaterThan(0);
  });
});

describe("chat page confirmed ownership gaps", () => {
  it("accepts a second independent prompt after the first turn completes", async () => {
    const firstAccept = deferredResponse();
    const secondAccept = deferredResponse();
    let prompts = 0;
    let currentSnapshot: ChatMessageSnapshot = chatSnapshot({
      status: "done",
      content: COMPLETED_BODY,
      assistantStatus: "done",
      cursor: { epoch: 1, seq: 3 },
    });
    const firstFollowUp: ChatMessageSnapshot = {
      session: { ...currentSnapshot.session, status: "done", updatedAt: 1_740_000_000_080 },
      messages: [
        ...currentSnapshot.messages,
        {
          id: -4,
          role: "user",
          content: FOLLOW_UP,
          status: "done",
          createdAt: 1,
          steps: [],
        },
        {
          id: 1,
          role: "assistant",
          content: "second",
          status: "done",
          createdAt: 2,
          steps: [],
        },
      ],
      streamCursor: { epoch: 1, seq: 6 },
    };
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [currentSnapshot.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(currentSnapshot),
      [SESSION_PROMPT]: () => {
        prompts += 1;
        return prompts === 1 ? firstAccept.promise : secondAccept.promise;
      },
    });

    await screen.findByRole("button", { name: "新建会话" });
    const messages = await findMessageArea();
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();
    await typeAndSend(FOLLOW_UP);
    await waitFor(() => {
      expect(prompts).toBe(1);
    });
    currentSnapshot = firstFollowUp;
    firstAccept.resolve(jsonResponse(promptAccepted, 202));
    expect(await within(messages).findByText(FOLLOW_UP, { exact: true })).toBeTruthy();
    expect(composer().disabled).toBe(false);

    const secondUser = "第三次";
    const secondFollowUp: ChatMessageSnapshot = {
      session: { ...currentSnapshot.session, status: "done", updatedAt: 1_740_000_000_090 },
      messages: [
        ...currentSnapshot.messages,
        {
          id: -6,
          role: "user",
          content: secondUser,
          status: "done",
          createdAt: 3,
          steps: [],
        },
        {
          id: 2,
          role: "assistant",
          content: "third",
          status: "done",
          createdAt: 4,
          steps: [],
        },
      ],
      streamCursor: { epoch: 1, seq: 9 },
    };
    await typeAndSend(secondUser);
    await waitFor(() => {
      expect(prompts).toBe(2);
    });
    currentSnapshot = secondFollowUp;
    secondAccept.resolve(jsonResponse({ userMessageId: -6, assistantMessageId: 2 }, 202));
    expect(await within(messages).findByText(secondUser, { exact: true })).toBeTruthy();
    expect(within(messages).getByText("third", { exact: true })).toBeTruthy();
    expect(composer().disabled).toBe(false);
    expect(prompts).toBe(2);
  });

  it("aborts a pending existing-session prompt after navigating to another session", async () => {
    const pendingPrompt = deferredResponse();
    const staleSnapshot = chatSnapshot({
      status: "done",
      content: COMPLETED_BODY,
      assistantStatus: "done",
      cursor: { epoch: 1, seq: 3 },
    });
    const { fetchMock, router } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () =>
        jsonResponse({ sessions: [staleSnapshot.session, otherIdleSession()] }),
      [SESSION_MESSAGES]: freshSnapshot(staleSnapshot),
      [SESSION_PROMPT]: pendingPrompt.promise,
      [OTHER_MESSAGES]: freshSnapshot(otherSnapshot()),
    });

    await screen.findByRole("button", { name: "新建会话" });
    await typeAndSend(PROMPT);
    const promptCall = fetchMock.mock.calls.find(([path]) => path === SESSION_PROMPT);
    await act(async () => {
      await router.navigate(`/?session=${OTHER_SESSION_ID}`);
    });
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    const messages = await findMessageArea();
    expect(await within(messages).findByText("other user", { exact: true })).toBeTruthy();
    const otherSourceCount = FakeEventSource.instances.length;
    pendingPrompt.resolve(jsonResponse(promptAccepted, 202));
    await waitFor(() => {
      expect(promptCall?.[1]?.signal?.aborted).toBe(true);
    });
    expect(within(messages).queryByText(COMPLETED_BODY, { exact: true })).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(otherSourceCount);
  });

  it("shows server-owned title and order after an accepted prompt refreshes the list", async () => {
    let lists = 0;
    let currentSnapshot: ChatMessageSnapshot = {
      session: olderListedSession(),
      messages: [historyUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    const pendingAccept = deferredResponse();
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => {
        lists += 1;
        if (lists === 1) {
          return jsonResponse({ sessions: [otherIdleSession(), olderListedSession()] });
        }
        return jsonResponse({ sessions: [currentSnapshot.session, otherIdleSession()] });
      },
      [SESSION_MESSAGES]: () => jsonResponse(currentSnapshot),
      [SESSION_PROMPT]: pendingAccept.promise,
    });

    const list = await screen.findByRole("navigation", { name: "会话列表" });
    expect(
      within(list)
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-label") !== null)
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["other session", "older title"]);
    await typeAndSend(PROMPT);
    currentSnapshot = {
      session: {
        ...olderListedSession(),
        title: PROMPT,
        status: "done",
        updatedAt: 1_740_000_000_200,
      },
      messages: [
        historyUser,
        {
          id: -4,
          role: "user",
          content: PROMPT,
          status: "done",
          createdAt: 1,
          steps: [],
        },
        {
          id: 0,
          role: "assistant",
          content: COMPLETED_BODY,
          status: "done",
          createdAt: 2,
          steps: [],
        },
      ],
      streamCursor: { epoch: 1, seq: 3 },
    };
    pendingAccept.resolve(jsonResponse(promptAccepted, 202));
    const messages = await findMessageArea();
    expect(await within(messages).findByText(PROMPT, { exact: true })).toBeTruthy();
    await waitFor(() => {
      expect(
        within(list)
          .getAllByRole("button")
          .filter((button) => button.getAttribute("aria-label") !== null)
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual([PROMPT, "other session"]);
    });
    expect(within(list).getByRole("status", { name: `${PROMPT} done` })).toBeTruthy();
  });

  it("closes the live source before post-202 reconciliation history resolves", async () => {
    const pendingReconcile = deferredResponse();
    let messageReads = 0;
    const initial: ChatMessageSnapshot = {
      session: { ...runningSession("idle"), title: "saved title" },
      messages: [historyUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    const completed = chatSnapshot({
      status: "done",
      content: COMPLETED_BODY,
      assistantStatus: "done",
      cursor: { epoch: 1, seq: 3 },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [initial.session] }),
      [SESSION_MESSAGES]: () => {
        messageReads += 1;
        if (messageReads === 1) {
          return jsonResponse(initial);
        }
        return pendingReconcile.promise;
      },
      [SESSION_PROMPT]: jsonResponse(promptAccepted, 202),
    });

    await screen.findByRole("button", { name: "新建会话" });
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const source = latestSource();
    await typeAndSend(PROMPT);
    await waitFor(() => {
      expect(messageReads).toBeGreaterThan(1);
    });
    expect(source.closeCount).toBeGreaterThan(0);
    pendingReconcile.resolve(jsonResponse(completed));
    const messages = await findMessageArea();
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();
  });
});
