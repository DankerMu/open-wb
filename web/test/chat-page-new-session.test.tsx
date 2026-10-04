import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer, mountRunningSnapshot } from "./chat-page-ownership-support.js";
import {
  A,
  cleanupSessionMeta,
  entryTitles,
  findList,
  focusOn,
  installNarrowViewport,
  openNavOverlay,
  view,
} from "./chat-page-session-meta-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  promptRequests,
  sceneGroup,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { currentLocation, type FetchMock } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 「新建会话」只回欢迎态，会话在欢迎态首次发送时才创建（s1f-chat-surface 组 4，#826）。

const EXISTING = "既有会话";
const DRAFT = "半句话";

// 覆盖层的 FocusScope 在卸载后的宏任务里归还焦点，清理里先让出一轮。
afterEach(cleanupSessionMeta);

/** 至今发出的请求总数（任意路径、任意方法）。 */
function requestCount(fetchMock: FetchMock) {
  return fetchMock.mock.calls.length;
}

function hero() {
  return screen.queryByRole("heading", { level: 1, name: HERO });
}

function newSessionButton(scope: HTMLElement) {
  return within(scope).getByRole("button", { name: "新建会话" });
}

/** 挂载在 `path`，列表里有一个已完成的既有会话 A（历史为空快照）。 */
async function mountWithExisting(path: string) {
  const mounted = renderChatPage(path, welcomeRoutes({ existing: [view(A, EXISTING)] }));
  const nav = await findList(EXISTING);
  return { ...mounted, nav };
}

describe("新建会话只回欢迎态", () => {
  it("N1 宽视口：replace 清除 session 并保留无关 search/hash，零请求、草稿不动、聚焦输入框；欢迎态再点只聚焦；首次发送恰一次创建加一次 prompt", async () => {
    const { fetchMock, nav, router } = await mountWithExisting("/?x=1#h");
    fireEvent.click(within(nav).getByRole("button", { name: EXISTING }));
    await waitFor(() => expect(currentLocation()).toBe(`/?x=1&session=${A}#h`));
    await waitFor(() => expect(composer().disabled).toBe(false));
    typeDraft(DRAFT);
    await act(yieldMacrotask);
    const requests = requestCount(fetchMock);
    const entries = window.history.length;
    expect(document.activeElement).not.toBe(composer());

    fireEvent.click(newSessionButton(nav));
    await waitFor(() => expect(currentLocation()).toBe("/?x=1#h"));
    expect(hero()).not.toBeNull();
    await focusOn(composer());
    expect(composer().value).toBe(DRAFT);
    await act(yieldMacrotask);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(createRequests(fetchMock)).toEqual([]);
    expect(entryTitles(nav)).toEqual([EXISTING]);
    // replace：历史栈没有新增一格，会话那一格被欢迎态取代。
    expect(window.history.length).toBe(entries);

    composer().blur();
    expect(document.activeElement).not.toBe(composer());
    fireEvent.click(newSessionButton(nav));
    expect(document.activeElement).toBe(composer());
    await act(yieldMacrotask);
    expect(currentLocation()).toBe("/?x=1#h");
    expect(composer().value).toBe(DRAFT);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(window.history.length).toBe(entries);

    typeDraft("你好");
    clickSend();
    const created = `${CREATED_IDS[0]}`;
    await waitFor(() => expect(currentLocation()).toBe(`/?x=1&session=${created}#h`));
    await waitFor(() => expect(promptRequests(fetchMock, created)).toHaveLength(1));
    await act(yieldMacrotask);
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    expect(promptRequests(fetchMock, created)).toEqual([["POST", '{"message":"你好"}']]);
    // 会话在首次发送后才出现在列表里，且只出现一次。
    await waitFor(() => expect(entryTitles(nav)).toEqual(["新会话", EXISTING]));
    expect(sceneGroup()).toBeNull();

    // 后退两格（新会话 → 欢迎态 → 挂载时的欢迎态）：既有会话那一格已被 replace 掉。
    await act(() => router.navigate(-2));
    await waitFor(() => expect(currentLocation()).toBe("/?x=1#h"));
    await act(yieldMacrotask);
    expect(currentLocation()).toBe("/?x=1#h");
    expect(hero()).not.toBeNull();
  });

  it("N2 宽视口、会话生成中（输入框锁定）：点击后回欢迎态，输入框解锁并获得焦点，事件连接关闭，零请求", async () => {
    const snapshot = chatSnapshot({ content: "Hello ", cursor: { epoch: 1, seq: 3 } });
    const { fetchMock, source } = await mountRunningSnapshot(snapshot);
    await waitFor(() => expect(composer().disabled).toBe(true));
    await act(yieldMacrotask);
    const requests = requestCount(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(hero()).not.toBeNull();
    await focusOn(composer());
    expect(composer().disabled).toBe(false);
    expect(source.closeCount).toBe(1);
    await act(yieldMacrotask);
    expect(requestCount(fetchMock)).toBe(requests);
  });

  it("N3 窄视口（侧栏是覆盖层）：覆盖层关闭、回欢迎态、零请求、草稿不动，焦点回到 打开导航 而不在输入框", async () => {
    installNarrowViewport();
    const { fetchMock } = renderChatPage(
      `/?session=${A}`,
      welcomeRoutes({ existing: [view(A, EXISTING)] }),
    );
    await waitFor(() => expect(composer().disabled).toBe(false));
    typeDraft(DRAFT);
    const { nav } = await openNavOverlay(EXISTING);
    await act(yieldMacrotask);
    const requests = requestCount(fetchMock);

    fireEvent.click(newSessionButton(nav));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "导航" })).toBeNull());
    expect(currentLocation()).toBe("/");
    await focusOn(screen.getByRole("button", { name: "打开导航" }));
    await act(yieldMacrotask);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "打开导航" }));
    expect(document.activeElement).not.toBe(composer());
    expect(hero()).not.toBeNull();
    expect(composer().value).toBe(DRAFT);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(createRequests(fetchMock)).toEqual([]);
  });
});
