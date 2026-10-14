// issue 909 task 7.5：chat-web「消息线程」错误文本段落的两个场景——「失败消息的分类说明与原文」与
// 「重试提示」。seam：整页挂载 + 假 API / 假 EventSource；期望值取自场景字面量。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  composer,
  findMessageArea,
  mountRunningSnapshot,
  SESSION_MESSAGES,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { chatSnapshot, historyUser } from "./chat-stream-support.js";
import { jsonResponse } from "./support.js";

afterEach(cleanupChatPage);

const AUTH_LINE = "鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）";
const TIMEOUT_LINE = "上游超时：模型服务没有及时响应";
const RETRYING = "上游出错，正在重试…";

function failedAssistant(id: number, error: unknown) {
  return {
    ...historyUser,
    id,
    role: "assistant" as const,
    undo: null,
    content: "",
    status: "failed" as const,
    createdAt: id,
    error,
  };
}

/** 一个 failed 会话：三问三答，三条助手消息各带一种 `error`，末条为 `null`。 */
function failedSnapshot() {
  const base = chatSnapshot({ status: "failed", assistantStatus: "failed" });
  const user = (id: number) => ({ ...historyUser, id, createdAt: id });
  return {
    ...base,
    messages: [
      user(1),
      failedAssistant(2, {
        reason: "auth_failed",
        message: "鉴权失败：模型服务拒绝了配置的 API 密钥",
        status: 401,
        detail: "401 Incorrect API key provided\n<b>x</b>",
      }),
      user(3),
      failedAssistant(4, {
        reason: "upstream_timeout",
        message: TIMEOUT_LINE,
        status: null,
        detail: "",
      }),
      user(5),
      failedAssistant(6, null),
    ],
    streamCursor: { epoch: 1, seq: null },
  };
}

async function assistants() {
  const area = await findMessageArea();
  await waitFor(() =>
    expect(within(area).getAllByRole("article", { name: "助手" })).toHaveLength(3),
  );
  return within(area).getAllByRole("article", { name: "助手" });
}

describe("chat-web「失败消息的分类说明与原文」", () => {
  it("shows the sentence with HTTP status and a folded plain-text original; null status and null error differ", async () => {
    const snapshot = failedSnapshot();
    renderChatPage(`/?session=${snapshot.session.id}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
    });
    const [auth, timeout, none] = await assistants();
    if (auth === undefined || timeout === undefined || none === undefined)
      throw new Error("expected three assistant messages");

    const first = within(auth);
    expect(first.getByRole("alert").textContent).toBe(AUTH_LINE);
    const toggle = first.getByRole("button", { name: "查看原文" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(auth.querySelector('[data-slot="message-error-detail"]')).toBeNull();
    expect(auth.textContent).not.toContain("401 Incorrect API key provided");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const detail = auth.querySelector('[data-slot="message-error-detail"]');
    expect(detail?.textContent).toBe("401 Incorrect API key provided\n<b>x</b>");
    expect(detail?.textContent?.split("\n")).toEqual([
      "401 Incorrect API key provided",
      "<b>x</b>",
    ]);
    expect(auth.querySelector("b")).toBeNull();
    // 亮暗主题都走同一个状态色令牌（design D19：沿用既有 --wb-status-error-text）。
    expect(auth.querySelector('[data-slot="message-error"]')?.className).toContain(
      "text-(--wb-status-error-text)",
    );

    const second = within(timeout);
    expect(second.getByRole("alert").textContent).toBe(TIMEOUT_LINE);
    expect(timeout.textContent).not.toContain("（HTTP");
    expect(second.queryByRole("button", { name: "查看原文" })).toBeNull();

    expect(within(none).queryByRole("alert")).toBeNull();
    expect(none.querySelector('[data-slot="message-error"]')).toBeNull();

    // 重新生成只在末条助手消息上，输入框不因失败锁定。
    expect(screen.getAllByRole("button", { name: "重新生成" })).toHaveLength(1);
    expect(within(none).getByRole("button", { name: "重新生成" })).toBeTruthy();
    expect(composer().disabled).toBe(false);
  });
});

describe("chat-web「重试提示」", () => {
  it("turn.retry shows the status line in the error slot; text.delta removes it", async () => {
    const { messages, source } = await mountRunningSnapshot(
      chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } }),
    );
    act(() => {
      source.emitOpen();
      source.emitData("turn.retry", "1:4", { messageId: 0 });
    });
    const hint = await within(messages).findByText(RETRYING);
    expect(hint.getAttribute("role")).toBe("status");
    expect(hint.closest('[data-slot="message-content"]')).not.toBeNull();

    act(() => {
      source.emitData("text.delta", "1:5", { messageId: 0, delta: "world" });
    });
    await waitFor(() => expect(within(messages).queryByText(RETRYING)).toBeNull());
  });

  it("turn.retry then error and turn.end failed: the hint gives way to the sentence", async () => {
    const { messages, source } = await mountRunningSnapshot(
      chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } }),
    );
    act(() => {
      source.emitOpen();
      source.emitData("turn.retry", "1:4", { messageId: 0 });
    });
    expect(await within(messages).findByText(RETRYING)).toBeTruthy();

    act(() => {
      source.emitData("error", "1:5", {
        messageId: 0,
        reason: "upstream_error",
        message: "上游出错：模型服务内部错误",
        status: 503,
        detail: "模型服务返回 HTTP 503",
      });
      source.emitData("turn.end", "1:6", { messageId: 0, status: "failed" });
    });
    const alert = await within(messages).findByRole("alert");
    expect(alert.textContent).toBe("上游出错：模型服务内部错误（HTTP 503）");
    expect(within(messages).queryByText(RETRYING)).toBeNull();
  });
});
