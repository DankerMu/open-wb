import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  composer,
  FOLLOW_UP,
  findMessageArea,
  freshSnapshot,
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  olderListedSession,
  otherIdleSession,
  otherSnapshot,
  PROMPT,
  promptAccepted,
  SESSION_MESSAGES,
  SESSION_PROMPT,
  typeAndSend,
} from "./chat-page-ownership-support.js";
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
import { deferredResponse, jsonResponse } from "./support.js";

afterEach(() => {
  cleanupChatPage();
});

function listTitles(list: HTMLElement) {
  return within(list)
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-label") !== null)
    .map((button) => button.getAttribute("aria-label"));
}

async function expectListTitles(list: HTMLElement, titles: string[]) {
  await waitFor(() => {
    expect(listTitles(list)).toEqual(titles);
  });
}

describe("chat page confirmed ownership gaps", () => {
  it("keeps one completed pair when terminal events arrive before prompt 202", async () => {
    const pendingInitial = deferredResponse();
    const pendingOpenRecovery = deferredResponse();
    const pendingPrompt = deferredResponse();
    const pendingReconcile = deferredResponse();
    let messageReads = 0;
    const priorUser = {
      id: -9,
      role: "user" as const,
      content: "prior distinct user",
      status: "done" as const,
      createdAt: -5,
      steps: [] as [],
    };
    const idleSnapshot: ChatMessageSnapshot = {
      session: { ...runningSession("idle"), title: "saved title" },
      messages: [priorUser],
      streamCursor: { epoch: 1, seq: 0 },
    };
    const acceptedSnapshot: ChatMessageSnapshot = {
      session: { ...runningSession("done"), title: PROMPT, updatedAt: 1_740_000_000_080 },
      messages: [
        priorUser,
        {
          id: -4,
          role: "user",
          content: PROMPT,
          status: "done",
          createdAt: 1,
          steps: [],
        },
        {
          id: 1,
          role: "assistant",
          content: COMPLETED_BODY,
          status: "done",
          createdAt: 2,
          steps: [],
        },
      ],
      streamCursor: { epoch: 2, seq: 3 },
    };
    let currentSnapshot: ChatMessageSnapshot = idleSnapshot;
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [idleSnapshot.session] }),
      [SESSION_MESSAGES]: () => {
        messageReads += 1;
        if (messageReads === 1) {
          return pendingInitial.promise;
        }
        if (messageReads === 2) {
          return pendingOpenRecovery.promise;
        }
        if (messageReads === 3) {
          return pendingReconcile.promise;
        }
        return jsonResponse(currentSnapshot);
      },
      [SESSION_PROMPT]: pendingPrompt.promise,
    });

    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    await waitFor(() => {
      expect(messageReads).toBe(1);
    });
    await act(async () => {
      pendingInitial.resolve(jsonResponse(idleSnapshot));
    });
    const messages = await findMessageArea();
    expect(await within(messages).findByText("prior distinct user", { exact: true })).toBeTruthy();
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const source = latestSource();
    act(() => {
      source.emitOpen();
    });
    await waitFor(() => {
      expect(messageReads).toBe(2);
    });
    await act(async () => {
      pendingOpenRecovery.resolve(jsonResponse(idleSnapshot));
    });
    await waitFor(() => {
      expect(within(messages).getByText("prior distinct user", { exact: true })).toBeTruthy();
    });
    await typeAndSend(PROMPT);
    expect(composer().disabled).toBe(true);

    act(() => {
      source.emitData("turn.start", "2:1", { messageId: 1 });
      source.emitData("text.delta", "2:2", { messageId: 1, delta: COMPLETED_BODY });
      source.emitData("turn.end", "2:3", { messageId: 1, status: "done" });
    });
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();

    currentSnapshot = acceptedSnapshot;
    await act(async () => {
      pendingPrompt.resolve(jsonResponse({ userMessageId: -4, assistantMessageId: 1 }, 202));
    });
    await waitFor(() => {
      expect(messageReads).toBe(3);
    });
    expect(source.closeCount).toBeGreaterThan(0);
    await act(async () => {
      pendingReconcile.resolve(jsonResponse(currentSnapshot));
    });
    await waitFor(() => {
      const articles = within(messages).getAllByRole("article");
      expect(articles.map((article) => article.getAttribute("aria-label"))).toEqual([
        "用户",
        "用户",
        "助手",
      ]);
      expect(
        within(articles[0] as HTMLElement).getByText("prior distinct user", { exact: true }),
      ).toBeTruthy();
      expect(within(articles[1] as HTMLElement).getByText(PROMPT, { exact: true })).toBeTruthy();
      expect(
        within(articles[2] as HTMLElement).getByText(COMPLETED_BODY, { exact: true }),
      ).toBeTruthy();
      expect(within(messages).getAllByText(PROMPT, { exact: true })).toHaveLength(1);
      expect(composer().disabled).toBe(false);
      expect(screen.queryByText("生成中", { exact: true })).toBeNull();
      expect(FakeEventSource.instances.at(-1)).not.toBe(source);
    });
  });

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

    const messages = await findMessageArea();
    expect(await within(messages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();
    await typeAndSend(FOLLOW_UP);
    await waitFor(() => {
      expect(prompts).toBe(1);
    });
    currentSnapshot = firstFollowUp;
    firstAccept.resolve(jsonResponse({ userMessageId: -4, assistantMessageId: 1 }, 202));
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

    const staleMessages = await findMessageArea();
    expect(await within(staleMessages).findByText(COMPLETED_BODY, { exact: true })).toBeTruthy();
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
    await expectListTitles(list, ["other session", "older title"]);
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
    await expectListTitles(list, [PROMPT, "other session"]);
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
