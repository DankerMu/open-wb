import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import { cleanupSessionMeta, findList } from "./chat-page-session-meta-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createRequests,
  HERO,
  promptRequests,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { currentLocation } from "./support.js";

// 欢迎态首次发送的「创建—发送」交接紧接着被另一次导航跟上（#1543）：创建续延里的导航须同步提交，
// 否则两次导航合并成一次提交，页面停在禁用的「停止」、prompt 不发，之后选中该会话时才补发。

const [FIRST, SECOND] = CREATED_IDS as [string, string];
const TITLE_FALLBACK = "新会话";

type Leave = (router: ReturnType<typeof renderChatPage>["router"]) => Promise<unknown>;

/** 在 act 内让出一个宏任务（不经 RTL `waitFor`：它会在两次检查之间让 act 队列提前冲刷）。 */
function macrotask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** 在 act 内轮询到 `predicate` 成立；超过 `limit` 个宏任务仍不成立即失败。 */
async function until(predicate: () => boolean, what: string, limit = 50) {
  for (let turn = 0; turn < limit; turn += 1) {
    if (predicate()) return;
    await macrotask();
  }
  throw new Error(`等待超时：${what}`);
}

/**
 * 第一次创建挂在闸门上，放行后才按夹具建会话；后续创建照常立即返回。各新会话的 prompt 由夹具挂起
 * （请求已发出、应答不到），离开时作废的只是客户端对应答的处理。
 */
function mountGated() {
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const routes = welcomeRoutes();
  const sessions = routes["/api/sessions"];
  if (typeof sessions !== "function") throw new Error("欢迎态夹具缺少 /api/sessions 路由");
  let creates = 0;
  routes["/api/sessions"] = (path, options) => {
    if (options?.method !== "POST") return sessions(path, options);
    creates += 1;
    if (creates > 1) return sessions(path, options);
    // 放行时才按夹具建会话（排进列表），与服务端「创建落定才可见」一致。
    return createGate.then(() => {
      const created = sessions(path, options);
      if (created instanceof Error) throw created;
      return created;
    });
  };
  const mounted = renderChatPage("/", routes);
  return { mounted, releaseCreate };
}

function stopButton() {
  return screen.queryByRole("button", { name: "停止" });
}

function sendButton() {
  return screen.getByRole<HTMLButtonElement>("button", { name: "发送" });
}

/**
 * 欢迎态发送 `你好`、等创建请求发出（输入框为禁用的「停止」），然后在同一个 act 里放行创建、等它的续延
 * 把 URL 换成 `?session=FIRST`，再立即 `leave`，并等 URL 回到 `/`。
 */
async function sendThenLeave(leave: Leave) {
  const { mounted, releaseCreate } = mountGated();
  const { fetchMock, router } = mounted;
  await screen.findByRole("heading", { level: 1, name: HERO });
  typeDraft("你好");
  clickSend();
  await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(1));
  expect(stopButton()).not.toBeNull();

  await act(async () => {
    releaseCreate();
    await until(() => currentLocation() === `/?session=${FIRST}`, "创建续延导航到新会话");
    await leave(router);
    await until(() => currentLocation() === "/", "离开后 URL 回到 /");
  });
  return mounted;
}

/** 回到欢迎态之后：URL 为 `/`，向 FIRST 恰一次 prompt `你好`，输入框可发送、没有「停止」。 */
async function expectWelcomeReady(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"]) {
  expect(currentLocation()).toBe("/");
  await screen.findByRole("heading", { level: 1, name: HERO });
  expect(promptRequests(fetchMock, FIRST)).toEqual([["POST", '{"message":"你好"}']]);
  expect(stopButton()).toBeNull();
  expect(sendButton()).toBeTruthy();
}

/** 再发 `再来`：建出 SECOND，向它恰一次 prompt；FIRST 仍只有那一次。 */
async function expectNextSend(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"]) {
  typeDraft("再来");
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${SECOND}`));
  await waitFor(() => expect(promptRequests(fetchMock, SECOND)).toHaveLength(1));
  expect(createRequests(fetchMock)).toHaveLength(2);
  expect(promptRequests(fetchMock, SECOND)).toEqual([["POST", '{"message":"再来"}']]);
  expect(promptRequests(fetchMock, FIRST)).toEqual([["POST", '{"message":"你好"}']]);
}

const replaceToWelcome: Leave = (router) => router.navigate("/", { replace: true });
const historyBack: Leave = (router) => router.navigate(-1);

afterEach(cleanupSessionMeta);

describe("welcome-state create-send handoff followed by another navigation (#1543)", () => {
  it("A: a replace right after the create resolves still sends the prompt exactly once", async () => {
    const { fetchMock } = await sendThenLeave(replaceToWelcome);
    await expectWelcomeReady(fetchMock);
    await expectNextSend(fetchMock);
  });

  it("B: a history back right after the create resolves still sends the prompt exactly once", async () => {
    const { fetchMock } = await sendThenLeave(historyBack);
    await expectWelcomeReady(fetchMock);
    await expectNextSend(fetchMock);
  });

  it("C: selecting the created session afterwards does not send its prompt again", async () => {
    const { fetchMock } = await sendThenLeave(replaceToWelcome);
    await expectWelcomeReady(fetchMock);
    const nav = await findList(TITLE_FALLBACK);
    fireEvent.click(within(nav).getByRole("button", { name: TITLE_FALLBACK }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${FIRST}`));
    await screen.findByRole("region", { name: "消息" });
    await act(macrotask);
    expect(promptRequests(fetchMock, FIRST)).toEqual([["POST", '{"message":"你好"}']]);
  });
});
