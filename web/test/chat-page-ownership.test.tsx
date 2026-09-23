import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  AGENT_UNAVAILABLE,
  BASH_RESULT_DETAIL,
  BASH_START_DETAIL,
  BUSINESS_ERROR,
  CREATED_MESSAGES,
  CREATED_PROMPT,
  CREATED_SESSION_ID,
  completedCreatedSnapshot,
  composer,
  emptyCreatedSnapshot,
  envelope,
  exactText,
  findMessageArea,
  freshSnapshot,
  idleCreatedSession,
  mountRunningSnapshot,
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
  PROMPT,
  promptAccepted,
  runningCreatedSnapshot,
  SESSION_BUSY,
  SESSION_MESSAGES,
  SESSION_PROMPT,
  STREAMED_BODY,
  typeAndSend,
  UNKNOWN_MESSAGES,
  UNKNOWN_SESSION_ID,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, expectChatLocation, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  runningSession,
  SESSION_ID,
} from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse, replaceFetchRoutes } from "./support.js";

afterEach(() => {
  cleanupChatPage();
});

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
    expect(within(await findMessageArea()).queryByText(PROMPT, { exact: true })).toBeNull();
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
    expect(within(messages).queryByText(PROMPT, { exact: true })).toBeNull();
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
