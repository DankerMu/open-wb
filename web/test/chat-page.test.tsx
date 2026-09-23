import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
} from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";

const BASH_START_DETAIL = '{"command":"echo workbuddy-smoke"}';
const BASH_RESULT_DETAIL = '{"output":"workbuddy-smoke"}';
const SNAPSHOT_ASSISTANT = "Hello ";
const STREAMED_BODY = "Hello \u0000\uFEFF中文 😀";
const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
const messagesPath = `/api/sessions/${SESSION_ID}/messages`;

const runningSnapshot = chatSnapshot({
  content: SNAPSHOT_ASSISTANT,
  steps: [
    {
      id: 11,
      ordinal: 0,
      name: "bash",
      detail: BASH_START_DETAIL,
      status: "running",
    },
  ],
  cursor: { epoch: 1, seq: 3 },
});

afterEach(() => {
  cleanupChatPage();
});

describe("chat page route integration", () => {
  it("loads a deep-linked running snapshot before opening events, then streams later frames to done", async () => {
    const initialMessages = deferredResponse();
    let messageReads = 0;
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": (_path, options) => {
        if (options?.method === "POST") {
          throw new Error("unexpected request POST /api/sessions");
        }
        return jsonResponse({ sessions: [runningSnapshot.session] });
      },
      [messagesPath]: (_path, options) => {
        if (options?.method === "POST") {
          throw new Error(`unexpected request POST ${messagesPath}`);
        }
        messageReads += 1;
        if (messageReads === 1) {
          return initialMessages.promise;
        }
        return jsonResponse(runningSnapshot);
      },
    });

    expect(await screen.findByRole("heading", { level: 1, name: "会话" })).toBeTruthy();
    expect(await screen.findByRole("textbox", { name: "给助手发消息" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "新建会话" })).toBeTruthy();

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([requestPath]) => requestPath === messagesPath),
      ).toHaveLength(1);
    });
    expect(fetchMock.mock.calls.find(([requestPath]) => requestPath === messagesPath)?.[1]).toEqual(
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      },
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(screen.queryByText(historyUser.content, exactText)).toBeNull();
    expect(screen.queryByText(SNAPSHOT_ASSISTANT, exactText)).toBeNull();

    initialMessages.resolve(jsonResponse(runningSnapshot));

    expect(await screen.findByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.getByText(SNAPSHOT_ASSISTANT, exactText)).toBeTruthy();
    expect(screen.getByText("saved title", { exact: true })).toBeTruthy();
    expect(screen.getByText("bash", { exact: true })).toBeTruthy();
    expect(screen.getByText(BASH_START_DETAIL, { exact: true })).toBeTruthy();
    expect(screen.getByRole("status", { name: "bash running" })).toBeTruthy();
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(true);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = latestSource();
    expect(source.url).toBe(`/api/sessions/${SESSION_ID}/events`);
    expect(source.withCredentials).toBe(true);

    act(() => {
      source.emitOpen();
      source.emitData("text.delta", "1:4", { messageId: 0, delta: "\u0000\uFEFF中文" });
    });
    expect(
      await screen.findByText(`${SNAPSHOT_ASSISTANT}\u0000\uFEFF中文`, exactText),
    ).toBeTruthy();

    act(() => {
      source.emitData("text.delta", "1:5", { messageId: 0, delta: " 😀" });
      source.emitData("step.end", "1:6", {
        messageId: 0,
        stepId: 11,
        status: "done",
        detail: BASH_RESULT_DETAIL,
      });
      source.emitData("turn.end", "1:7", { messageId: 0, status: "done" });
    });

    expect(await screen.findByText(STREAMED_BODY, exactText)).toBeTruthy();
    expect(screen.getByText(historyUser.content, exactText)).toBeTruthy();
    expect(screen.getByText(BASH_RESULT_DETAIL, { exact: true })).toBeTruthy();
    expect(screen.queryByText(BASH_START_DETAIL, { exact: true })).toBeNull();
    expect(screen.queryByRole("status", { name: "bash running" })).toBeNull();
    expect(screen.getByRole("status", { name: "bash done" })).toBeTruthy();
    expect(screen.queryByText("生成中", { exact: true })).toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement).disabled,
    ).toBe(false);
    expect(currentLocation()).toBe(`/?session=${SESSION_ID}`);
  });
});
