// 会话页消费列表事件的整页测试：session-list-push「web 列表事件消费」七个场景（用例名即场景名），
// 外加通知读取与页面动作读取共用一个在途槽位的两条、通知读取失败静默的一条。
import "./radix-platform.js";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderChatPageWithAuthProbe,
  renewAccount,
  settleDeferredResponse,
} from "./chat-page-lifecycle-support.js";
import { promptAccepted, typeAndSend } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  cleanupSessionMeta,
  envelope,
  findList,
  messagesPath,
  PIN,
  PINNED_AT,
  partition,
  partitionTitles,
  patchPath,
  type SessionView,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import {
  type FetchRoutes,
  renderChatPage,
  renderChatPageWithoutEventSource,
} from "./chat-page-support.js";
import {
  CLOSED,
  chatSnapshot,
  FakeEventSource,
  latestListSource,
  settle,
} from "./chat-stream-support.js";
import { calls, deferredResponse, type FetchMock, jsonResponse } from "./support.js";

const LIST = "/api/sessions";
const WORKSPACES = "/api/workspaces";
const LIST_EVENTS = "/api/sessions/events";
const CHANGED = "sessions.changed";
const REWOUND = "session.rewound";
const FIRST = "任务一";
const SECOND = "任务二";
const THIRD = "任务三";
const BEFORE = "撤回之前的回答";
const AFTER = "撤回之后的回答";
const LIST_FAILED = "列表读取失败";
const W1 = "1".repeat(32);

type Reply = () => Response | Promise<Response>;

afterEach(cleanupSessionMeta);

/** 可在用例中途改写的响应：路由每次请求时读取当前值。 */
function replies(initial: Reply) {
  const state = { next: initial };
  return { route: () => state.next(), state };
}

function listOf(
  ...sessions: (Omit<SessionView, "workspaceId"> & { workspaceId: string | null })[]
): Reply {
  return () => jsonResponse({ sessions });
}

function snapshotOf(session: SessionView, content: string) {
  const running = session.status === "running";
  return {
    ...chatSnapshot({ assistantStatus: running ? "running" : "done", content }),
    session,
  };
}

function count(fetchMock: FetchMock, path: string) {
  return calls(fetchMock, path).length;
}

/** 在列表连接上派发，并让由此发起的请求与渲染落定。 */
async function dispatch(run: (source: FakeEventSource) => void, source = latestListSource()) {
  await act(async () => {
    run(source);
    await settle();
  });
}

const open = (source: FakeEventSource) => source.emitOpen();
const changed = (source: FakeEventSource) => source.emitNamed(CHANGED, "{}");
const rewound = (sessionId: string) => (source: FakeEventSource) =>
  source.emitNamed(REWOUND, JSON.stringify({ sessionId }));

function alerts() {
  return screen.queryAllByRole("alert").map((node) => node.textContent);
}

/** 选中会话 A（`status` 给定）并等它的线程出现；`messages` 是其后各次快照读取的响应。 */
async function mountSelected(status: "done" | "running", list = replies(listOf())) {
  const session = view(A, FIRST, { status });
  list.state.next = listOf(session);
  const messages = replies(() => jsonResponse(snapshotOf(session, BEFORE)));
  const mounted = renderChatPage(`/?session=${A}`, {
    [LIST]: list.route,
    [messagesPath(A)]: messages.route,
    [`/api/sessions/${A}/prompt`]: () => jsonResponse(promptAccepted, 202),
  });
  await findList(FIRST);
  const main = screen.getByRole("main");
  await within(main).findByText(BEFORE, { exact: true });
  return { ...mounted, list, main, messages, session };
}

describe("web 列表事件消费", () => {
  it("打开与通知触发重取：恰一条列表连接；open 与 sessions.changed 之后各读一次会话列表与工作空间，状态变化反映在侧栏", async () => {
    const list = replies(listOf(view(A, FIRST)));
    const { fetchMock } = renderChatPage("/", { [LIST]: list.route });
    const nav = await findList(FIRST);

    expect(FakeEventSource.listInstances).toHaveLength(1);
    expect(latestListSource().url).toBe(LIST_EVENTS);
    expect(latestListSource().withCredentials).toBe(true);
    expect(FakeEventSource.instances).toEqual([]);
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([1, 1]);

    await dispatch(open);
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([2, 2]);
    expect(nav.querySelector('[data-status-mark="running"]')).toBeNull();

    list.state.next = listOf(view(A, FIRST, { status: "running" }));
    await dispatch(changed);
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([3, 3]);
    expect(nav.querySelectorAll('[data-status-mark="running"]')).toHaveLength(1);
    expect(FakeEventSource.listInstances).toHaveLength(1);
    expect(alerts()).toEqual([]);
  });

  it("单飞与尾随重取：读取在途时的三条 sessions.changed 不发新请求，在途读取返回后恰再读一次", async () => {
    const list = replies(listOf(view(A, FIRST)));
    const { fetchMock } = renderChatPage("/", { [LIST]: list.route });
    const nav = await findList(FIRST);

    const inFlight = deferredResponse();
    list.state.next = () => inFlight.promise;
    await dispatch(open);
    expect(count(fetchMock, LIST)).toBe(2);

    const trailing = deferredResponse();
    list.state.next = () => trailing.promise;
    await dispatch((source) => {
      changed(source);
      changed(source);
      changed(source);
    });
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([2, 2]);

    await settleDeferredResponse(inFlight, jsonResponse({ sessions: [view(B, SECOND)] }));
    expect(await within(nav).findByRole("button", { name: SECOND })).toBeTruthy();
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([3, 3]);

    // 尾随读取之后没有欠账：它返回后不再读。
    await settleDeferredResponse(trailing, jsonResponse({ sessions: [view(C, THIRD)] }));
    expect(await within(nav).findByRole("button", { name: THIRD })).toBeTruthy();
    await act(settle);
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([3, 3]);
  });

  it("重连后重取：连接出错后再次 open 再读一次列表，页面没有与列表连接有关的错误文案", async () => {
    const list = replies(listOf(view(A, FIRST)));
    const { fetchMock } = renderChatPage("/", { [LIST]: list.route });
    const nav = await findList(FIRST);
    await dispatch(open);
    expect(count(fetchMock, LIST)).toBe(2);

    await dispatch((source) => source.emitTransport());
    expect(count(fetchMock, LIST)).toBe(2);
    expect(alerts()).toEqual([]);

    list.state.next = listOf(view(A, FIRST), view(B, SECOND));
    await dispatch(open);
    expect(count(fetchMock, LIST)).toBe(3);
    expect(within(nav).getByRole("button", { name: SECOND })).toBeTruthy();
    expect(FakeEventSource.listInstances).toHaveLength(1);
    expect(alerts()).toEqual([]);

    // 连接进入终止的错误状态：仍然没有错误文案，列表照常在。
    await dispatch((source) => source.emitTransport(CLOSED));
    expect(alerts()).toEqual([]);
    expect(within(nav).getByRole("button", { name: FIRST })).toBeTruthy();
    expect(count(fetchMock, LIST)).toBe(3);
  });

  describe("重连补读所选会话", () => {
    it("选中 done 会话：首次 open 不读消息；出错后再次 open 恰读一次快照并替换线程", async () => {
      const { fetchMock, main, messages } = await mountSelected("done");
      expect(count(fetchMock, messagesPath(A))).toBe(1);

      await dispatch(open);
      expect(count(fetchMock, LIST)).toBe(2);
      expect(count(fetchMock, messagesPath(A))).toBe(1);

      // 断开期间另一个标签页撤回了这条消息：补读的快照里已经没有它。
      messages.state.next = () =>
        jsonResponse({ ...snapshotOf(view(A, FIRST, { status: "idle" }), ""), messages: [] });
      await dispatch((source) => source.emitTransport());
      await dispatch(open);
      expect(count(fetchMock, LIST)).toBe(3);
      expect(count(fetchMock, messagesPath(A))).toBe(2);
      await waitFor(() => expect(within(main).queryByText(BEFORE, { exact: true })).toBeNull());
      expect(alerts()).toEqual([]);
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    it("重连时所选会话在页面视图里为 running：不因 open 读消息", async () => {
      const { fetchMock, main } = await mountSelected("running");

      await dispatch(open);
      await dispatch((source) => source.emitTransport());
      await dispatch(open);

      expect(count(fetchMock, LIST)).toBe(3);
      expect(count(fetchMock, messagesPath(A))).toBe(1);
      expect(within(main).getByText(BEFORE, { exact: true })).toBeTruthy();
    });
  });

  it("另一个标签页的撤回：session.rewound 是选中会话时恰读一次快照并替换线程，是别的会话时不读消息", async () => {
    const { fetchMock, main, messages, session } = await mountSelected("done");
    await dispatch(open);
    const lists = count(fetchMock, LIST);

    await dispatch(rewound(B));
    expect(count(fetchMock, messagesPath(A))).toBe(1);
    expect(within(main).getByText(BEFORE, { exact: true })).toBeTruthy();

    messages.state.next = () => jsonResponse(snapshotOf(session, AFTER));
    await dispatch(rewound(A));
    expect(count(fetchMock, messagesPath(A))).toBe(2);
    expect(await within(main).findByText(AFTER, { exact: true })).toBeTruthy();
    expect(within(main).queryByText(BEFORE, { exact: true })).toBeNull();

    await dispatch(rewound(C));
    expect(count(fetchMock, messagesPath(A))).toBe(2);
    // session.rewound 只管消息，不触发列表读取。
    expect(count(fetchMock, LIST)).toBe(lists);
    expect(alerts()).toEqual([]);
  });

  it("无 EventSource 时静默降级：页面没有错误文案，列表照常渲染，置顶成功后条目移入置顶区", async () => {
    const { fetchMock } = renderChatPageWithoutEventSource("/", {
      [LIST]: listOf(view(A, FIRST), view(B, SECOND)),
      [patchPath(B)]: () => jsonResponse(view(B, SECOND, { pinnedAt: PINNED_AT })),
    });
    const nav = await findList(SECOND);

    expect(FakeEventSource.listInstances).toEqual([]);
    expect(alerts()).toEqual([]);
    expect(partition(nav, PIN)).toBeNull();

    await chooseEntryAction(nav, SECOND, PIN);
    await waitFor(() => expect(partitionTitles(nav, PIN)).toEqual([SECOND]));
    expect(toasts()).toEqual([]);
    expect(within(nav).getAllByRole("button", { name: FIRST })).toHaveLength(1);
    expect(alerts()).toEqual([]);
    expect(count(fetchMock, LIST)).toBe(1);
  });

  describe("卸载与换账号后关闭", () => {
    it("页面卸载：原连接被 close()，其后在它上面派发的 sessions.changed 与 open 不触发任何请求", async () => {
      const { fetchMock, view: page } = renderChatPage("/", { [LIST]: listOf(view(A, FIRST)) });
      await findList(FIRST);
      const source = latestListSource();
      await dispatch(open);
      expect(source.closeCount).toBe(0);

      page.unmount();
      expect(source.closeCount).toBe(1);
      const requests = fetchMock.mock.calls.length;
      await dispatch((closed) => {
        changed(closed);
        open(closed);
        rewound(A)(closed);
      }, source);
      expect(fetchMock.mock.calls).toHaveLength(requests);
      expect(FakeEventSource.listInstances).toHaveLength(1);
    });

    it("账号切换为另一个 Principal：原连接被 close()、其后的通知被丢弃，新账号持有恰一条新连接", async () => {
      const { fetchMock, getProbe } = renderChatPageWithAuthProbe("/", {
        [LIST]: listOf(view(A, FIRST)),
      });
      await findList(FIRST);
      const first = latestListSource();
      await dispatch(open);

      await renewAccount(getProbe);
      await act(settle);
      expect(first.closeCount).toBe(1);
      expect(FakeEventSource.listInstances).toHaveLength(2);
      const second = latestListSource();
      expect(second).not.toBe(first);
      expect(second.closeCount).toBe(0);

      const lists = count(fetchMock, LIST);
      await dispatch(changed, first);
      expect(count(fetchMock, LIST)).toBe(lists);
      await dispatch(changed, second);
      expect(count(fetchMock, LIST)).toBe(lists + 1);
    });
  });
});

describe("通知读取与页面动作读取", () => {
  it("通知触发的读取失败：保留当前列表与分组，不显示错误；下一条通知再读", async () => {
    const bound = { ...view(A, FIRST), workspaceId: W1 };
    const list = replies(listOf(bound));
    const workspaces = replies(() =>
      jsonResponse({
        workspaces: [{ id: W1, name: "W1", dir: "W1", root: "/srv/w1", createdAt: 1 }],
      }),
    );
    const routes: FetchRoutes = { [LIST]: list.route, [WORKSPACES]: workspaces.route };
    const { fetchMock } = renderChatPage("/", routes);
    const nav = await findList(FIRST);
    await dispatch(open);
    expect(partitionTitles(nav, "W1")).toEqual([FIRST]);

    list.state.next = () => envelope(500, LIST_FAILED);
    workspaces.state.next = () => envelope(500, LIST_FAILED);
    await dispatch(changed);
    expect([count(fetchMock, LIST), count(fetchMock, WORKSPACES)]).toEqual([3, 3]);
    expect(alerts()).toEqual([]);
    expect(screen.queryByText(LIST_FAILED)).toBeNull();
    expect(partitionTitles(nav, "W1")).toEqual([FIRST]);

    list.state.next = listOf(bound, view(B, SECOND));
    await dispatch(changed);
    expect(within(nav).getByRole("button", { name: SECOND })).toBeTruthy();
    expect(partitionTitles(nav, "W1")).toEqual([FIRST]);
    expect(alerts()).toEqual([]);
  });

  it("页面动作顶替在途的通知读取：被顶替的响应作废且不报错，动作读取失败照常置错误，欠下的「再读一次」在它之后恰补一次", async () => {
    const { fetchMock, list, session } = await mountSelected("done");
    const nav = await findList(FIRST);

    const notified = deferredResponse();
    list.state.next = () => notified.promise;
    await dispatch(open);
    await dispatch((source) => {
      changed(source);
      changed(source);
    });
    expect(count(fetchMock, LIST)).toBe(2);

    // 发送被受理后页面重取列表：中止并重发。
    const action = deferredResponse();
    list.state.next = () => action.promise;
    await typeAndSend("你好");
    await waitFor(() => expect(count(fetchMock, LIST)).toBe(3));
    expect(calls(fetchMock, LIST)[1]?.[1]?.signal?.aborted).toBe(true);
    expect(calls(fetchMock, LIST)[2]?.[1]?.signal?.aborted).toBe(false);

    await settleDeferredResponse(notified, jsonResponse({ sessions: [view(B, SECOND)] }));
    expect(count(fetchMock, LIST)).toBe(3);
    expect(within(nav).queryByRole("button", { name: SECOND })).toBeNull();
    expect(within(nav).queryByRole("alert")).toBeNull();

    const trailing = deferredResponse();
    list.state.next = () => trailing.promise;
    await settleDeferredResponse(action, envelope(500, LIST_FAILED));
    expect(within(nav).getByRole("alert").textContent).toBe(LIST_FAILED);
    expect(count(fetchMock, LIST)).toBe(4);

    await settleDeferredResponse(trailing, jsonResponse({ sessions: [session, view(C, THIRD)] }));
    expect(await within(nav).findByRole("button", { name: THIRD })).toBeTruthy();
    expect(within(nav).queryByRole("alert")).toBeNull();
    await act(settle);
    expect(count(fetchMock, LIST)).toBe(4);
  });

  it("页面动作的读取在途时到达的通知：不顶替它、不发新请求，它返回后恰再读一次", async () => {
    const { fetchMock, list, session } = await mountSelected("done");
    const nav = await findList(FIRST);

    const action = deferredResponse();
    list.state.next = () => action.promise;
    await typeAndSend("你好");
    await waitFor(() => expect(count(fetchMock, LIST)).toBe(2));

    list.state.next = listOf(session, view(C, THIRD));
    await dispatch((source) => {
      open(source);
      changed(source);
    });
    expect(count(fetchMock, LIST)).toBe(2);
    expect(calls(fetchMock, LIST)[1]?.[1]?.signal?.aborted).toBe(false);

    await settleDeferredResponse(action, jsonResponse({ sessions: [session, view(B, SECOND)] }));
    expect(await within(nav).findByRole("button", { name: THIRD })).toBeTruthy();
    expect(count(fetchMock, LIST)).toBe(3);
  });
});
