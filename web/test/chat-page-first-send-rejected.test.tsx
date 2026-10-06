import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clickSend,
  sessionPromptPath,
  settleDeferredResponse,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import {
  AGENT_UNAVAILABLE,
  composer,
  envelope,
  findMessageArea,
  PROMPT,
  promptAccepted,
  runningCreatedSnapshot,
  SESSION_BUSY,
} from "./chat-page-ownership-support.js";
import {
  A,
  cleanupSessionMeta,
  findList,
  messagesPath,
  REQUEST_FAILED,
  view,
} from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickOption,
  promptRequests,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { FakeEventSource, latestSource } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 欢迎态首次发送的 prompt 未被受理：页面补读一次新会话的历史并显示它的正常状态
// （s1f-chat-followups 组 1；chat-web「会话页」场景「首次发送被拒后显示新会话」）。

const CREATED = `${CREATED_IDS[0]}`;
const EMPTY = "还没有消息，发一条开始吧";
const CAPACITY = "Agent 容量已满，请稍后重试";
const EXISTING = "既有会话";
const HISTORY_FAILED = "历史读取失败";
const PROMPT_BODY = `{"message":"${PROMPT}"}`;

type Outcome = () => Response;

afterEach(cleanupSessionMeta);

function capacityFull() {
  return envelope(503, "agent_capacity", CAPACITY);
}

/** 挂起的 prompt 路由：`release` 之后每个在途请求按 `outcome` 落定（抛错即网络失败）。 */
function heldPrompt(outcome: Outcome) {
  const gate = deferredResponse();
  return {
    route: () => gate.promise.then(outcome),
    release: () => settleDeferredResponse(gate, new Response(null)),
  };
}

function historyReads(fetchMock: Parameters<typeof calls>[0], sessionId = CREATED) {
  return calls(fetchMock, messagesPath(sessionId));
}

/** 欢迎态选中 项目A 后发送 `你好`：创建已返回、URL 选中新会话、prompt 已发出。 */
async function firstSend(routes: FetchRoutes) {
  const mounted = renderChatPage("/", routes);
  await screen.findByRole("heading", { level: 1, name: HERO });
  await pickOption(PROJECT_A_OPTION);
  typeDraft(PROMPT);
  clickSend();
  await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED}`));
  await waitFor(() => expect(promptRequests(mounted.fetchMock, CREATED)).toHaveLength(1));
  await act(yieldMacrotask);
  return mounted;
}

/** 首次发送，prompt 挂起到交接未落定的状态被断言过之后再按 `outcome` 落定。 */
async function firstSendRejected(outcome: Outcome, extra: FetchRoutes = {}) {
  const prompt = heldPrompt(outcome);
  const mounted = await firstSend({
    ...welcomeRoutes(),
    [sessionPromptPath(CREATED)]: prompt.route,
    ...extra,
  });
  // 交接期间页面不读新会话的历史、不开事件连接：之后的「恰一次」才是被拒带来的那一次。
  expect(historyReads(mounted.fetchMock)).toEqual([]);
  expect(FakeEventSource.instances).toEqual([]);
  await prompt.release();
  return mounted;
}

async function findEmptyState() {
  const line = await within(await findMessageArea()).findByText(EMPTY, { exact: true });
  if (!line.parentElement) throw new Error("空态文本没有容器");
  return line.parentElement;
}

function expectNotGenerating() {
  expect(screen.queryByText("生成中", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "停止" })).toBeNull();
}

/** 被拒之后的界面与请求序列：新会话的空态、信封文案、草稿恢复、恰一次历史读取与事件连接。 */
async function expectNewSessionShown(
  fetchMock: Parameters<typeof calls>[0],
  message: string,
): Promise<void> {
  const empty = await findEmptyState();
  expect(
    within(empty)
      .getAllByText(/^工作空间/)
      .map((node) => node.textContent),
  ).toEqual([`工作空间 ${PROJECT_A.name}`]);
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  await waitFor(() => expect(composer().disabled).toBe(false));
  await act(yieldMacrotask);

  expect(currentLocation()).toBe(`/?session=${CREATED}`);
  expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([message]);
  expect(composer().value).toBe(PROMPT);
  expectNotGenerating();
  expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();
  expect(historyReads(fetchMock)).toHaveLength(1);
  expect(FakeEventSource.instances).toHaveLength(1);
  expect(latestSource().closeCount).toBe(0);
  expect(createRequests(fetchMock)).toEqual([
    createOf(`{"scene":"office","workspaceId":"${PROJECT_A.id}"}`),
  ]);
  expect(promptRequests(fetchMock, CREATED)).toEqual([["POST", PROMPT_BODY]]);
}

describe("欢迎态首次发送被拒后显示新会话的状态", () => {
  it("R1 prompt 收到 503 agent_capacity：恰一次历史读取与事件连接，空态带工作空间行，信封文案内联、草稿恢复、输入框可用", async () => {
    const { fetchMock } = await firstSendRejected(capacityFull);
    await expectNewSessionShown(fetchMock, CAPACITY);
  });

  it.each<[string, Outcome, string]>([
    ["400", () => envelope(400, "invalid_request", "消息不合法"), "消息不合法"],
    ["409", () => envelope(409, "session_busy", SESSION_BUSY), SESSION_BUSY],
    ["502", () => envelope(502, "agent_unavailable", AGENT_UNAVAILABLE), AGENT_UNAVAILABLE],
    [
      "网络失败",
      () => {
        throw new TypeError("fetch failed");
      },
      REQUEST_FAILED,
    ],
  ])("R2 prompt %s：结果同 R1，文案为其信封或安全文案", async (_, outcome, message) => {
    const { fetchMock } = await firstSendRejected(outcome);
    await expectNewSessionShown(fetchMock, message);
  });

  it("R3 被拒后直接再次发送：恰新增一次 prompt、没有第二次创建；受理后空态消失、出现用户消息", async () => {
    const routes = welcomeRoutes();
    const emptyHistory = routes[messagesPath(CREATED)];
    if (typeof emptyHistory !== "function") throw new Error("夹具的历史路由不是函数路由");
    let prompts = 0;
    const first = heldPrompt(capacityFull);
    routes[sessionPromptPath(CREATED)] = () => {
      prompts += 1;
      return prompts === 1 ? first.route() : jsonResponse(promptAccepted, 202);
    };
    routes[messagesPath(CREATED)] = (path, options) =>
      prompts > 1
        ? jsonResponse({
            ...runningCreatedSnapshot(),
            session: view(CREATED, PROMPT, { status: "running" }),
          })
        : emptyHistory(path, options);
    const { fetchMock } = await firstSend(routes);
    await first.release();
    await expectNewSessionShown(fetchMock, CAPACITY);

    clickSend();
    expect(await screen.findByRole("article", { name: "用户" })).toBeTruthy();
    await act(yieldMacrotask);
    expect(screen.queryByText(EMPTY, { exact: true })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(promptRequests(fetchMock, CREATED)).toEqual([
      ["POST", PROMPT_BODY],
      ["POST", PROMPT_BODY],
    ]);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(currentLocation()).toBe(`/?session=${CREATED}`);
  });

  it("R4 历史已加载的既有会话里 prompt 收到 503：没有新的历史读取，事件连接没有被关掉重开", async () => {
    const routes = welcomeRoutes({ existing: [view(A, EXISTING)] });
    routes[sessionPromptPath(A)] = capacityFull;
    const { fetchMock } = renderChatPage(`/?session=${A}`, routes);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(historyReads(fetchMock, A)).toHaveLength(1);

    typeDraft(PROMPT);
    clickSend();
    expect((await screen.findByRole("alert")).textContent).toBe(CAPACITY);
    await act(yieldMacrotask);
    expect(composer().value).toBe(PROMPT);
    expect(composer().disabled).toBe(false);
    expect(promptRequests(fetchMock, A)).toEqual([["POST", PROMPT_BODY]]);
    expect(historyReads(fetchMock, A)).toHaveLength(1);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latestSource().closeCount).toBe(0);
  });

  // 交接未落定时 `新建会话` 不导航，回欢迎态经路由（replace）驱动；切到别的会话是侧栏的普通选择。
  it.each<[string, string, (mounted: ReturnType<typeof renderChatPage>) => Promise<void>]>([
    [
      "已切到别的会话",
      `/?session=${A}`,
      async () => {
        fireEvent.click(within(await findList(EXISTING)).getByRole("button", { name: EXISTING }));
        await waitFor(() => expect(currentLocation()).toBe(`/?session=${A}`));
        await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      },
    ],
    ["已回欢迎态", "/", leaveForWelcome],
  ])("R5 prompt 被拒之前%s：不为新会话读历史，当前界面没有它的错误", async (_, location, leave) => {
    const prompt = heldPrompt(capacityFull);
    const mounted = await firstSend({
      ...welcomeRoutes({ existing: [view(A, EXISTING)] }),
      [sessionPromptPath(CREATED)]: prompt.route,
    });
    const { fetchMock } = mounted;

    await leave(mounted);
    await waitFor(() => expect(composer().disabled).toBe(false));
    await act(yieldMacrotask);
    const requests = fetchMock.mock.calls.length;
    const sources = FakeEventSource.instances.length;

    await prompt.release();
    await act(yieldMacrotask);
    expect(historyReads(fetchMock)).toEqual([]);
    expect(fetchMock.mock.calls).toHaveLength(requests);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composer().value).toBe("");
    expect(currentLocation()).toBe(location);
  });

  it("R6 补读的历史读取失败：历史错误与输入框错误都显示，不显示空态", async () => {
    const { fetchMock } = await firstSendRejected(capacityFull, {
      [messagesPath(CREATED)]: () => envelope(500, "internal", HISTORY_FAILED),
    });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .map((alert) => alert.textContent)
          .sort(),
      ).toEqual([CAPACITY, HISTORY_FAILED].sort()),
    );
    await act(yieldMacrotask);
    expect(screen.queryByText(EMPTY, { exact: true })).toBeNull();
    expect(composer().value).toBe(PROMPT);
    expectNotGenerating();
    expect(historyReads(fetchMock)).toHaveLength(1);
    expect(FakeEventSource.instances).toEqual([]);
    expect(currentLocation()).toBe(`/?session=${CREATED}`);
  });

  it("R7 补读返回 404：回到欢迎态，不留新会话的错误", async () => {
    const { fetchMock } = await firstSendRejected(capacityFull, {
      [messagesPath(CREATED)]: () => envelope(404, "not_found", "会话不存在"),
    });
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(await screen.findByRole("heading", { level: 1, name: HERO })).toBeTruthy();
    await act(yieldMacrotask);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(EMPTY, { exact: true })).toBeNull();
    expect(historyReads(fetchMock)).toHaveLength(1);
    expect(FakeEventSource.instances).toEqual([]);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(promptRequests(fetchMock, CREATED)).toHaveLength(1);
  });
});
