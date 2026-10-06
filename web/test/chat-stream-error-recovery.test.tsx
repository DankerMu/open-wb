// 流错误恢复（s1f-chat-followups 5.1；chat-web 输入框「失败引导优先」）：最近快照为 running 时事件连接终态
// 失败，`生成中` 与 `停止` 让位给刷新指引；切到别的会话再切回、历史重读仍为 running，两者重新出现、流错误
// 消失。seam：整页挂载 + 假 API + 假 EventSource；历史读取与事件连接的次数按字面值计。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  composer,
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
  SESSION_MESSAGES,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, expectChatLocation, renderChatPage } from "./chat-page-support.js";
import {
  CLOSED,
  chatSnapshot,
  FakeEventSource,
  latestSource,
  SESSION_ID,
} from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";

const GUIDANCE = "请刷新页面后重试";
const EVENTS = `/api/sessions/${SESSION_ID}/events`;

afterEach(cleanupChatPage);

function generatingStatus() {
  return screen.queryByText("生成中", { exact: true });
}

function stopButton() {
  return screen.queryByRole("button", { name: "停止" });
}

describe("流错误恢复", () => {
  it("running 会话的事件连接终态失败后没有 生成中 与 停止；切到别的会话再切回、历史重读为 running：两者重新出现，流错误消失", async () => {
    const running = chatSnapshot({ content: "起始" });
    const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [running.session, otherIdleSession()] }),
      [SESSION_MESSAGES]: () => jsonResponse(running),
      [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
    });
    const nav = await screen.findByRole("navigation", { name: "会话列表" });
    // 失败之前确在生成中，之后的「没有」才有意义。
    await screen.findByRole("button", { name: "停止" });
    expect(generatingStatus()).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
    const failed = latestSource();
    expect(failed.url).toBe(EVENTS);

    act(() => {
      failed.emitTransport(CLOSED);
    });

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(GUIDANCE));
    expect(generatingStatus()).toBeNull();
    expect(stopButton()).toBeNull();
    expect(composer().disabled).toBe(true);
    expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(1);

    fireEvent.click(within(nav).getByRole("button", { name: "other session" }));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    expect(await screen.findByText("other user", { exact: true })).toBeTruthy();
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(within(nav).getByRole("button", { name: "saved title" }));
    await expectChatLocation(`/?session=${SESSION_ID}`);

    expect(await screen.findByRole("button", { name: "停止" })).toBeTruthy();
    expect(generatingStatus()).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composer().disabled).toBe(true);
    expect(calls(fetchMock, SESSION_MESSAGES)).toHaveLength(2);
    // 重读之后是一条新连接，不是那条已失败的。
    expect(latestSource()).not.toBe(failed);
    expect(latestSource().url).toBe(EVENTS);
    expect(latestSource().closeCount).toBe(0);
  });
});
