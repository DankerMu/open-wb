import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clickSend,
  renderObservedChatPage,
  sessionPromptPath,
  settleDeferredResponse,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import {
  composer,
  findMessageArea,
  mountRunningSnapshot,
  promptAccepted,
  runningCreatedSnapshot,
} from "./chat-page-ownership-support.js";
import {
  A,
  C,
  cleanupSessionMeta,
  entryTitles,
  findList,
  focusOn,
  installNarrowViewport,
  messagesPath,
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
import { chatSnapshot, FakeEventSource } from "./chat-stream-support.js";
import {
  authenticatedPrincipal,
  calls,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
} from "./support.js";
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

function unauthorized() {
  return jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401);
}

/** `path` 上那一次请求的 AbortSignal。 */
function onlySignal(fetchMock: FetchMock, path: string) {
  const requests = calls(fetchMock, path);
  expect(requests).toHaveLength(1);
  const signal = requests[0]?.[1]?.signal;
  if (!signal) throw new Error(`${path} 的请求没有带 signal`);
  return signal;
}

/** 欢迎态首次发送的夹具：`created` 的 prompt 与历史读取各由调用方决定。 */
function firstSendRoutes(
  created: string,
  prompt: () => Promise<Response> | Response,
  history: () => Promise<Response> | Response,
) {
  const routes = welcomeRoutes();
  routes[sessionPromptPath(created)] = prompt;
  routes[messagesPath(created)] = history;
  return routes;
}

function runningCreated(created: string) {
  return jsonResponse({
    ...runningCreatedSnapshot(),
    session: view(created, "你好", { status: "running" }),
  });
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

  it("N4 创建—发送交接未完成（创建已返回、prompt 在途）：点击不导航、不中止 prompt、零请求；prompt 受理后恰一次 prompt，转录含 你好", async () => {
    const created = `${CREATED_IDS[0]}`;
    const held = deferredResponse();
    const routes = welcomeRoutes();
    routes[sessionPromptPath(created)] = () => held.promise;
    routes[messagesPath(created)] = () =>
      jsonResponse({
        ...runningCreatedSnapshot(),
        session: view(created, "你好", { status: "running" }),
      });
    const { fetchMock } = renderChatPage("/", routes);
    await screen.findByRole("heading", { level: 1, name: HERO });

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    await waitFor(() => expect(promptRequests(fetchMock, created)).toHaveLength(1));
    await act(yieldMacrotask);
    const signal = onlySignal(fetchMock, sessionPromptPath(created));
    const requests = requestCount(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await act(yieldMacrotask);
    expect(currentLocation()).toBe(`/?session=${created}`);
    expect(signal.aborted).toBe(false);
    expect(requestCount(fetchMock)).toBe(requests);

    await settleDeferredResponse(held, jsonResponse(promptAccepted, 202));
    expect(await within(await findMessageArea()).findByText("你好", { exact: true })).toBeTruthy();
    expect(promptRequests(fetchMock, created)).toEqual([["POST", '{"message":"你好"}']]);
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(currentLocation()).toBe(`/?session=${created}`);
    expect(signal.aborted).toBe(false);
  });

  it("N4b prompt 已受理、随后的历史读取仍挂起：点击回欢迎态，输入框可用，点击之后零请求；侧栏条目已是受理后的标题；迟到的快照不把页面带回会话", async () => {
    const created = `${CREATED_IDS[0]}`;
    const held = deferredResponse();
    let prompted = false;
    const routes = firstSendRoutes(
      created,
      () => {
        prompted = true;
        return jsonResponse(promptAccepted, 202);
      },
      () => held.promise,
    );
    // 服务端在受理 prompt 时给会话起标题：此后的列表读取返回带标题、生成中的条目。
    const sessions = routes["/api/sessions"];
    if (typeof sessions !== "function") throw new Error("夹具的 /api/sessions 不是函数路由");
    routes["/api/sessions"] = (path, options) =>
      prompted && options?.method !== "POST"
        ? jsonResponse({ sessions: [view(created, "你好", { status: "running" })] })
        : sessions(path, options);
    const { fetchMock } = renderChatPage("/", routes);
    await screen.findByRole("heading", { level: 1, name: HERO });

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    await waitFor(() => expect(calls(fetchMock, messagesPath(created))).toHaveLength(1));
    await act(yieldMacrotask);
    expect(promptRequests(fetchMock, created)).toEqual([["POST", '{"message":"你好"}']]);
    const requests = requestCount(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(hero()).not.toBeNull();
    await act(yieldMacrotask);
    expect(composer().disabled).toBe(false);
    expect(requestCount(fetchMock)).toBe(requests);
    // 列表在受理后、历史读取之前就已重读：离开会话不会让条目停在 `新会话`。
    expect(entryTitles(await findList("你好"))).toEqual(["你好"]);

    await settleDeferredResponse(held, runningCreated(created));
    await act(yieldMacrotask);
    expect(currentLocation()).toBe("/");
    expect(hero()).not.toBeNull();
    expect(requestCount(fetchMock)).toBe(requests);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("N4c prompt 已受理、随后的历史读取失败之后：点击回欢迎态，点击之后零请求", async () => {
    const created = `${CREATED_IDS[0]}`;
    const { fetchMock } = renderChatPage(
      "/",
      firstSendRoutes(
        created,
        () => jsonResponse(promptAccepted, 202),
        () => jsonResponse({ error: { code: "unavailable", message: "历史不可用" } }, 503),
      ),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    expect((await screen.findByRole("alert")).textContent).toContain("历史不可用");
    await act(yieldMacrotask);
    expect(promptRequests(fetchMock, created)).toEqual([["POST", '{"message":"你好"}']]);
    expect(calls(fetchMock, messagesPath(created))).toHaveLength(1);
    const requests = requestCount(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(hero()).not.toBeNull();
    await act(yieldMacrotask);
    expect(requestCount(fetchMock)).toBe(requests);
  });

  it("N4d prompt 被拒绝（502）之后：交接已落定，点击回欢迎态，点击之后零请求", async () => {
    const created = `${CREATED_IDS[0]}`;
    const { fetchMock } = renderChatPage(
      "/",
      firstSendRoutes(
        created,
        () => jsonResponse({ error: { code: "bad_gateway", message: "上游不可用" } }, 502),
        () =>
          jsonResponse({
            session: view(created, null, { status: "idle" }),
            messages: [],
            streamCursor: { epoch: 1, seq: 0 },
            todo: null,
          }),
      ),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    expect((await screen.findByRole("alert")).textContent).toBe("上游不可用");
    await act(yieldMacrotask);
    expect(promptRequests(fetchMock, created)).toEqual([["POST", '{"message":"你好"}']]);
    const requests = requestCount(fetchMock);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(hero()).not.toBeNull();
    await act(yieldMacrotask);
    expect(requestCount(fetchMock)).toBe(requests);
  });

  it("N5 既有会话的 prompt 在途：点击回欢迎态并中止该请求；迟到的 202 不读历史、不重开事件连接，输入框可用、无错误", async () => {
    const held = deferredResponse();
    const routes = welcomeRoutes({ existing: [view(A, EXISTING)] });
    routes[sessionPromptPath(A)] = () => held.promise;
    const { fetchMock } = renderChatPage(`/?session=${A}`, routes);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(composer().disabled).toBe(false));

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(promptRequests(fetchMock, A)).toHaveLength(1));
    const signal = onlySignal(fetchMock, sessionPromptPath(A));
    expect(signal.aborted).toBe(false);
    expect(composer().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(signal.aborted).toBe(true);
    expect(hero()).not.toBeNull();
    await act(yieldMacrotask);
    const historyReads = calls(fetchMock, messagesPath(A)).length;
    const sources = FakeEventSource.instances.length;
    const requests = requestCount(fetchMock);

    await settleDeferredResponse(held, jsonResponse(promptAccepted, 202));
    await act(yieldMacrotask);
    expect(calls(fetchMock, messagesPath(A))).toHaveLength(historyReads);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(sources).toBe(1);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(currentLocation()).toBe("/");
    expect(composer().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(promptRequests(fetchMock, A)).toHaveLength(1);
  });

  it("N6 分叉在途：点击回欢迎态；迟到的 201 不导航到分叉会话，草稿不被 fork.draft 覆盖", async () => {
    const forkPath = `/api/sessions/${A}/fork`;
    const held = deferredResponse();
    const routes = welcomeRoutes({ existing: [view(A, EXISTING)] });
    routes[messagesPath(A)] = () =>
      jsonResponse({
        ...chatSnapshot({ assistantStatus: "done", content: "回答", status: "done" }),
        session: view(A, EXISTING),
      });
    routes[forkPath] = () => held.promise;
    const { fetchMock } = renderChatPage(`/?session=${A}`, routes);
    const fork = await screen.findByRole("button", { name: "从此处分叉" });
    await waitFor(() => expect(composer().disabled).toBe(false));
    typeDraft(DRAFT);

    fireEvent.click(fork);
    await waitFor(() => expect(calls(fetchMock, forkPath)).toHaveLength(1));
    await waitFor(() => expect(composer().disabled).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(hero()).not.toBeNull();
    await act(yieldMacrotask);
    const requests = requestCount(fetchMock);

    await settleDeferredResponse(
      held,
      jsonResponse({ session: view(C, "分叉会话"), draft: "分叉草稿", attachments: [] }, 201),
    );
    await act(yieldMacrotask);
    expect(currentLocation()).toBe("/");
    expect(hero()).not.toBeNull();
    expect(composer().value).toBe(DRAFT);
    expect(composer().disabled).toBe(false);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(calls(fetchMock, messagesPath(C))).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("N7 首次发送的创建请求 401：进入登录页，任何一次提交都没有行内错误，URL 无 session，零 prompt 请求", async () => {
    let expired = false;
    const commits: string[] = [];
    const routes = welcomeRoutes({
      create: () => {
        expired = true;
        return unauthorized();
      },
    });
    // 登录失效后 `/api/auth/me` 同样回 401。
    routes["/api/auth/me"] = () =>
      expired ? unauthorized() : jsonResponse(authenticatedPrincipal);
    const { fetchMock } = renderObservedChatPage("/", routes, (html) => commits.push(html));
    await screen.findByRole("heading", { level: 1, name: HERO });

    typeDraft("你好");
    clickSend();
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await act(yieldMacrotask);
    // 会话页被登录页取代之前的每一次提交都算：行内错误一闪而过也不行。
    expect(commits.filter((html) => html.includes('role="alert"'))).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(currentLocation()).toBe("/");
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    expect(fetchMock.mock.calls.filter(([path]) => path.endsWith("/prompt"))).toEqual([]);
  });
});
