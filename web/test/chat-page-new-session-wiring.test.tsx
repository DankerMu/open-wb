import "./radix-platform.js";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blocksNewSession } from "../src/features/chat/ownership.js";
import { composer } from "./chat-page-ownership-support.js";
import { A, cleanupSessionMeta, findList, view } from "./chat-page-session-meta-support.js";
import { renderChatPage } from "./chat-page-support.js";
import { HERO, welcomeRoutes } from "./chat-page-welcome-scene-support.js";
import { currentLocation } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

/*
 * fix-new-session-handoff 1.3 的退路（#872）。「创建已返回、URL 已带新会话 id、prompt 尚未发出」的窗口
 * 在 jsdom 下不可达：新会话的提交与派发 prompt 的 passive effect 在同一段同步调用里完成，真实调度器下
 * 逐宏任务轮询（setTimeout / setImmediate）与 MutationObserver 都只看到「欢迎态仍在、0 次 prompt」
 * 紧接「欢迎态已不在、1 次 prompt」。该窗口因此没有行为级测试：判定本身由
 * chat-new-session-block.test.ts 的状态表承担，这里只钉接线——`新建会话` 导航与否完全跟随该判定，
 * 不看 prompt 请求的控制器。为此把判定换成桩（本仓库唯一一处 mock 自家模块）。
 */
vi.mock("../src/features/chat/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/features/chat/ownership.js")>()),
  blocksNewSession: vi.fn(),
}));

const EXISTING = "既有会话";

afterEach(cleanupSessionMeta);

/** 选中既有会话 A 并等它就绪：没有任何发送在途，prompt 请求的控制器不存在。 */
async function mountOnExisting(blocked: boolean) {
  vi.mocked(blocksNewSession).mockReset().mockReturnValue(blocked);
  const mounted = renderChatPage(
    `/?session=${A}`,
    welcomeRoutes({ existing: [view(A, EXISTING)] }),
  );
  await findList(EXISTING);
  await waitFor(() => expect(composer().disabled).toBe(false));
  await act(yieldMacrotask);
  return mounted;
}

describe("新建会话 导航与否跟随「交接未落定」判定", () => {
  it("判定为真：已选中会话时点击不导航、零请求；判定收到的是页面选中的会话 id", async () => {
    const { fetchMock } = await mountOnExisting(true);
    const requests = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await act(yieldMacrotask);
    expect(currentLocation()).toBe(`/?session=${A}`);
    expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(requests);
    expect(
      vi.mocked(blocksNewSession).mock.calls.map(([pending, , sessionId]) => [pending, sessionId]),
    ).toEqual([[null, A]]);
  });

  it("判定为假：同样的页面点击回欢迎态", async () => {
    await mountOnExisting(false);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(screen.getByRole("heading", { level: 1, name: HERO })).toBeTruthy();
    expect(vi.mocked(blocksNewSession)).toHaveBeenCalledTimes(1);
  });
});
