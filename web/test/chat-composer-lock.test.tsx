// 会话页「锁定不等于生成中」的输入框一半（chat-web 会话页；design D1、D6）：历史加载中与连接器终止失败
// 只让输入框禁用，不出现 `生成中` 状态元素与 `停止` 按钮。分叉进行中的一例在 chat-thread-runtime.test.tsx。
// seam：整页挂载 + 假 API / 假 EventSource。
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { composer, mountRunningSnapshot, SESSION_MESSAGES } from "./chat-page-ownership-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { CLOSED, chatSnapshot, SESSION_ID } from "./chat-stream-support.js";
import { deferredResponse, jsonResponse } from "./support.js";

const GUIDANCE = /请刷新页面后重试/;

afterEach(cleanupChatPage);

/** 输入框禁用，但既不是「生成中」也给不出「停止」；发送键仍在原位（禁用）。 */
function expectLockedNotGenerating() {
  expect(composer().disabled).toBe(true);
  expect(screen.queryByText("生成中", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(true);
}

describe("会话页：锁定不等于生成中（输入框）", () => {
  it("历史加载中：输入框禁用，没有 生成中 与 停止；历史返回后恢复可用", async () => {
    const history = deferredResponse();
    const snapshot = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: "已完成的回答",
      cursor: { epoch: 1, seq: null },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });

    await waitFor(() => expect(composer().disabled).toBe(true));
    expectLockedNotGenerating();

    history.resolve(jsonResponse(snapshot));
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(screen.queryByText("生成中", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
  });

  it("连接器终止失败而最近快照仍为 running：显示刷新指引，输入框保持锁定，没有 生成中 与 停止", async () => {
    const snapshot = chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } });
    const { source } = await mountRunningSnapshot(snapshot);
    act(() => {
      source.emitOpen();
    });
    // 失败之前这是一个进行中的回合：生成中与停止都在。
    expect(await screen.findByRole("button", { name: "停止" })).toBeTruthy();
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();

    act(() => {
      source.emitTransport(CLOSED);
    });

    expect(await screen.findByText(GUIDANCE)).toBeTruthy();
    expectLockedNotGenerating();
    // 快照仍是 running：锁定不随时间解除，只能重新加载。
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expectLockedNotGenerating();
    expect(screen.getByText(GUIDANCE)).toBeTruthy();
  });
});
