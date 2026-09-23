import { fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";
import type { ChatMessageSnapshot, ChatSession } from "../src/lib/session-contract.js";
import { renderChatPage } from "./chat-page-support.js";
import { latestSource, SESSION_ID } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

export const CREATED_SESSION_ID = "fedcba9876543210fedcba9876543210";
export const OTHER_SESSION_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const UNKNOWN_SESSION_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const PROMPT = "你好";
export const FOLLOW_UP = "再问一次";
export const AGENT_UNAVAILABLE = "Agent 运行时不可用";
export const SESSION_BUSY = "会话正在生成，请稍候";
export const BUSINESS_ERROR = "Agent execution failed";
export const BASH_START_DETAIL = '{"command":"echo workbuddy-smoke"}';
export const BASH_RESULT_DETAIL = '{"output":"workbuddy-smoke"}';
export const STREAMED_BODY = "Hello \u0000\uFEFF中文 😀";
export const exactText = { exact: true, collapseWhitespace: false, trim: false } as const;
export const promptAccepted = { userMessageId: -3, assistantMessageId: 0 };
export const CREATED_MESSAGES = `/api/sessions/${CREATED_SESSION_ID}/messages`;
export const CREATED_PROMPT = `/api/sessions/${CREATED_SESSION_ID}/prompt`;
export const SESSION_MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
export const SESSION_PROMPT = `/api/sessions/${SESSION_ID}/prompt`;
export const OTHER_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
export const UNKNOWN_MESSAGES = `/api/sessions/${UNKNOWN_SESSION_ID}/messages`;

export function composer() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function sendButton() {
  return screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
}

export async function findMessageArea() {
  return screen.findByRole("region", { name: "消息" });
}

export async function mountRunningSnapshot(snapshot: ChatMessageSnapshot) {
  const mounted = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [SESSION_MESSAGES]: () => jsonResponse(snapshot),
  });
  const messages = await findMessageArea();
  expect(await within(messages).findByText("Hello ", exactText)).toBeTruthy();
  return { ...mounted, messages, source: latestSource() };
}

export function envelope(status: number, code: string, message: string) {
  return jsonResponse({ error: { code, message } }, status);
}

export function idleCreatedSession(): ChatSession {
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

export function emptyCreatedSnapshot(): ChatMessageSnapshot {
  return {
    session: idleCreatedSession(),
    messages: [],
    streamCursor: { epoch: 1, seq: 0 },
  };
}

export function runningCreatedSnapshot(): ChatMessageSnapshot {
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

export function completedCreatedSnapshot(): ChatMessageSnapshot {
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

export function otherIdleSession(): ChatSession {
  return {
    id: OTHER_SESSION_ID,
    title: "other session",
    status: "idle",
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_100,
  };
}

export function otherSnapshot(): ChatMessageSnapshot {
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

export function olderListedSession(): ChatSession {
  return {
    id: SESSION_ID,
    title: "older title",
    status: "idle",
    createdAt: 1_740_000_000_000,
    updatedAt: 1_740_000_000_010,
  };
}

export async function typeAndSend(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
  fireEvent.click(sendButton());
}

export function freshSnapshot(body: ChatMessageSnapshot) {
  return () => jsonResponse(body);
}
