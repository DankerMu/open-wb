import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  BUSY_MESSAGE,
  CURRENT,
  closeMenu,
  confirmBox,
  confirmDescription,
  confirmGone,
  DELETE_REQUEST,
  deleteEntry,
  expectConfirmBusy,
  expectConfirmIdle,
  expectRemoved,
  expectReturnedToWelcome,
  expectStreamOpen,
  expectWelcome,
  findStream,
  HERO,
  mountTwoAccountsOnCurrent,
  noContent,
  OTHER,
  openDelete,
  pendingDelete,
  SESSION_A,
  SESSION_B,
  SESSIONS,
  selectEntry,
  sessionBusy,
  snapshotRoute,
  stream,
  THIRD,
  watchCurrent,
} from "./chat-page-session-delete-support.js";
import {
  A,
  B,
  C,
  cleanupSessionMeta,
  crumb,
  entryTitles,
  expectNoListToast,
  FIRST_ACCOUNT_TASK,
  findList,
  findListAlert,
  focusOn,
  installNarrowViewport,
  leaveChatPage,
  listAlert,
  messagesPath,
  moreButton,
  mountSessions,
  newSessionButton,
  openEntryMenu,
  openNavOverlay,
  openRename,
  PIN,
  PINNED_AT,
  patchPath,
  patchRequests,
  REQUEST_FAILED,
  renameDialog,
  SECOND_ACCOUNT_TASK,
  toasts,
  UNPIN,
  view,
} from "./chat-page-session-meta-support.js";
import { CLOSED, chatSnapshot, FakeEventSource, settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const D = "d".repeat(32);
const UNTITLED = "新会话";

afterEach(cleanupSessionMeta);

function listReads(fetchMock: Parameters<typeof calls>[0]) {
  return calls(fetchMock, "/api/sessions").length;
}

/** 挂起的 A 的 DELETE 以 204 返回：等条目移除并让出一轮宏任务，没有轻提示。 */
async function deletedLate(request: ReturnType<typeof deferredResponse>, nav: HTMLElement) {
  await settleDeferredResponse(request, noContent());
  await waitFor(() => expect(entryTitles(nav)).toEqual([OTHER, THIRD]));
  await yieldMacrotask();
  expectRemoved(nav);
}

describe("条目菜单第三项 删除 (R1)", () => {
  it("R1 未置顶、已置顶、running、无标题四种会话的菜单恰为 重命名、置顶任务|取消置顶、删除；删除 为危险样式、trash 图标、可用", async () => {
    const kinds = [
      { second: PIN, session: view(A, CURRENT) },
      { second: UNPIN, session: view(B, OTHER, { pinnedAt: PINNED_AT }) },
      { second: PIN, session: view(C, "跑着的", { status: "running" }) },
      { second: PIN, session: view(D, null, { status: "idle" }) },
    ];
    mountSessions(
      "/",
      kinds.map(({ session }) => session),
    );
    const nav = await findList(CURRENT);

    for (const { second, session } of kinds) {
      const { items, menu } = await openEntryMenu(nav, session.title ?? UNTITLED);
      expect(items.map((item) => item.textContent)).toEqual(["重命名", second, "删除"]);
      const remove = within(menu).getByRole("menuitem", { name: "删除" });
      expect(remove).toBe(items[2]);
      expect(remove.getAttribute("data-variant")).toBe("destructive");
      expect(remove.querySelector("svg")?.getAttribute("class")).toContain("lucide-trash");
      expect(remove.hasAttribute("aria-disabled")).toBe(false);
      expect(remove.hasAttribute("data-disabled")).toBe(false);
      // 只有 `删除` 是危险样式项。
      expect(menu.querySelectorAll('[data-variant="destructive"]')).toHaveLength(1);
      expect(within(menu).queryByRole("menuitem", { name: "导出记录" })).toBeNull();
      await closeMenu(menu);
    }
    // 条目行仍恰有两个同级按钮（选择 + 更多）。
    const rows = Array.from(nav.querySelectorAll('ul[role="list"] > li'));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.children).toHaveLength(2);
      expect(row.querySelectorAll("button")).toHaveLength(2);
    }
  });
});

describe("确认框与取消 (R2)", () => {
  it.each([
    ["有标题的会话，点 取消", CURRENT, false],
    ["无标题会话（「新会话」），按 Escape", UNTITLED, true],
  ] as const)(
    "R2 %s：alertdialog 删除任务 的说明与按钮恰为规定文案；关闭后不发 DELETE、焦点回「更多」按钮、列表不变",
    async (_case, title, byEscape) => {
      const { fetchMock } = mountSessions("/", [
        view(A, CURRENT),
        view(D, null, { status: "idle" }),
      ]);
      const nav = await findList(CURRENT);
      const requests = fetchMock.mock.calls.length;

      const controls = await openDelete(nav, title);
      expect(controls.trigger).toBe(moreButton(nav, title));
      expect(confirmDescription(controls.dialog)).toBe(
        `确定要删除「${title}」吗？删除后不可恢复。`,
      );
      expectConfirmIdle(controls);

      if (byEscape) fireEvent.keyDown(controls.cancel, { key: "Escape" });
      else fireEvent.click(controls.cancel);
      await confirmGone();
      await focusOn(controls.trigger);
      await yieldMacrotask();

      expect(fetchMock.mock.calls).toHaveLength(requests);
      expect(calls(fetchMock, patchPath(A))).toEqual([]);
      expect(calls(fetchMock, patchPath(D))).toEqual([]);
      expect(entryTitles(nav)).toEqual([CURRENT, UNTITLED]);
      expect(toasts()).toEqual([]);
      expect(currentLocation()).toBe("/");
    },
  );
});

describe("删除当前会话回欢迎态 (R3, R5)", () => {
  it("R3 当前且 running 的会话：恰一次无 body 的 DELETE；挂起期间确认框忙碌而列表、URL、事件流不动；204 后条目消失、无轻提示、先关事件流再 replace 回欢迎态，不再读取", async () => {
    const path = `/?from=keep&session=${A}#hash`;
    const request = deferredResponse();
    const running = view(A, CURRENT, { status: "running" });
    const { fetchMock } = mountSessions(path, [running, view(B, OTHER), view(C, THIRD)], {
      [messagesPath(A)]: () =>
        jsonResponse({ ...chatSnapshot({ content: "生成到一半" }), session: running }),
      [patchPath(A)]: () => request.promise,
    });
    const nav = await findList(CURRENT);
    const source = await findStream(A);
    // 事件流已连接：open 触发一次快照恢复读取。
    act(() => source.emitOpen());
    await waitFor(() => expect(calls(fetchMock, messagesPath(A))).toHaveLength(2));
    await act(settle);
    expect(within(nav).getByRole("status", { name: `${CURRENT} 运行中` })).toBeTruthy();
    const watched = watchCurrent(source);

    const controls = await openDelete(nav, CURRENT);
    expect(confirmDescription(controls.dialog)).toBe(
      `确定要删除「${CURRENT}」吗？删除后不可恢复。`,
    );
    fireEvent.click(controls.confirm);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    const [, sent] = calls(fetchMock, patchPath(A))[0] ?? [];
    expect(sent && "body" in sent).toBe(false);
    expect(sent && "headers" in sent).toBe(false);

    expectConfirmBusy(controls);
    await act(settle);
    expect(confirmBox()).toBe(controls.dialog);
    expect(entryTitles(nav)).toEqual([CURRENT, OTHER, THIRD]);
    expect(currentLocation()).toBe(path);
    expectStreamOpen(source);
    expect(watched.closedAt).toEqual([]);
    expect(toasts()).toEqual([]);
    const sources = FakeEventSource.instances.length;
    const reads = [calls(fetchMock, messagesPath(A)).length, listReads(fetchMock)];

    await settleDeferredResponse(request, noContent());
    await confirmGone();
    expectRemoved(nav);
    // 其它 search 与 hash 保留；replace、关闭先于导航、欢迎态无错误提示。
    await expectReturnedToWelcome(watched, "/?from=keep#hash");
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect([calls(fetchMock, messagesPath(A)).length, listReads(fetchMock)]).toEqual(reads);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
  });

  it("R5 当前且 done 的会话：204 后同样关闭事件流、以 replace 回欢迎态", async () => {
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, { [patchPath(A)]: noContent });
    const nav = await findList(CURRENT);
    const source = await findStream(A);
    await crumb(CURRENT);
    expect(within(nav).getByRole("status", { name: `${CURRENT} 已完成` })).toBeTruthy();
    const watched = watchCurrent(source);
    const reads = listReads(fetchMock);

    await deleteEntry(nav, CURRENT);

    expectRemoved(nav);
    await expectReturnedToWelcome(watched);
    // 被删条目的「更多」按钮已卸载：焦点落到列表区的 `新建会话`，不落回 body。
    await focusOn(newSessionButton(nav));
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expect(listReads(fetchMock)).toBe(reads);
  });
});

describe("删除非当前会话 (R4)", () => {
  it("R4 当前为 A 时删除 B：B 的条目消失且无轻提示；URL、顶栏、A 的内容与事件流不变，不发任何读取", async () => {
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, {
      [messagesPath(A)]: snapshotRoute(view(A, CURRENT), "A 的回答"),
      [patchPath(B)]: noContent,
    });
    const nav = await findList(CURRENT);
    const source = await findStream(A);
    await screen.findByText("A 的回答");
    const depth = window.history.length;
    const requests = fetchMock.mock.calls.length;

    await deleteEntry(nav, OTHER);

    expect(entryTitles(nav)).toEqual([CURRENT, THIRD]);
    expectNoListToast();
    expect(listAlert(nav)).toBeNull();
    await yieldMacrotask();
    expect(currentLocation()).toBe(SESSION_A);
    expect(window.history.length).toBe(depth);
    expect(await crumb(CURRENT)).toBeTruthy();
    expect(screen.getByText("A 的回答")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();
    expectStreamOpen(source);
    expect(FakeEventSource.instances).toEqual([source]);
    expect(patchRequests(fetchMock, B)).toEqual([DELETE_REQUEST]);
    expect(fetchMock.mock.calls.slice(requests).map(([path]) => path)).toEqual([patchPath(B)]);
  });

  it("R4 欢迎态下删除：条目消失且无轻提示，URL 仍为 /、hero 仍在，不打开事件流", async () => {
    const { fetchMock } = mountSessions("/", SESSIONS, { [patchPath(A)]: noContent });
    const nav = await findList(CURRENT);
    await expectWelcome();
    const depth = window.history.length;

    await deleteEntry(nav, CURRENT);

    expectRemoved(nav);
    await yieldMacrotask();
    expect(currentLocation()).toBe("/");
    expect(window.history.length).toBe(depth);
    await expectWelcome();
    expect(FakeEventSource.instances).toEqual([]);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
  });
});

describe("删除失败 (R6, R7, R11)", () => {
  /** 当前会话 A；每次列表读取返回不同的 A 标题（`复盘 v<n>`），用来证明重读的结果被装入。 */
  function mountVersioned(responses: Response[]) {
    let reads = 0;
    return mountSessions(SESSION_A, SESSIONS, {
      "/api/sessions": () => {
        reads += 1;
        return jsonResponse({ sessions: [view(A, `复盘 v${reads}`), view(B, OTHER)] });
      },
      [patchPath(A)]: responses,
    });
  }

  it("R6 409 信封与非信封失败：确认框关闭、焦点回「更多」按钮、列表区顶部提示显示 message、列表重读并装入；条目仍在、URL 与事件流不变；失败后可再次确认并发出第二个 DELETE", async () => {
    const { fetchMock } = mountVersioned([
      sessionBusy(),
      new Response("upstream exploded", { status: 500 }),
    ]);
    const nav = await findList("复盘 v1");
    const source = await findStream(A);
    expect(listReads(fetchMock)).toBe(1);

    const first = await openDelete(nav, "复盘 v1");
    fireEvent.click(first.confirm);
    await confirmGone();
    await focusOn(first.trigger);
    await findListAlert(nav, BUSY_MESSAGE);
    expectNoListToast();
    await within(nav).findByRole("button", { name: "复盘 v2" });
    expect(listReads(fetchMock)).toBe(2);
    expect(entryTitles(nav)).toEqual(["复盘 v2", OTHER]);
    expect(moreButton(nav, "复盘 v2")).toBe(first.trigger);
    expect(currentLocation()).toBe(SESSION_A);
    expectStreamOpen(source);
    expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();

    // 在途标记已清：重开的确认框可用，再次确认发出第二个 DELETE（这次是 500 非 JSON）。
    const second = await openDelete(nav, "复盘 v2");
    // 打开确认框是下一次列表动作：上一条提示已清除。
    expect(listAlert(nav)).toBeNull();
    expectConfirmIdle(second);
    fireEvent.click(second.confirm);
    await confirmGone();
    await focusOn(second.trigger);
    await findListAlert(nav, REQUEST_FAILED);
    expectNoListToast();
    await within(nav).findByRole("button", { name: "复盘 v3" });
    expect(listReads(fetchMock)).toBe(3);
    expect(entryTitles(nav)).toEqual(["复盘 v3", OTHER]);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST, DELETE_REQUEST]);
    expect(currentLocation()).toBe(SESSION_A);
    expectStreamOpen(source);
    expect(FakeEventSource.instances).toEqual([source]);
  });

  it("R7 200 不算成功：列表区顶部提示 请求失败，请稍后重试、列表重读、条目仍在、URL 与事件流不变", async () => {
    const { fetchMock } = mountVersioned([jsonResponse(view(A, CURRENT))]);
    const nav = await findList("复盘 v1");
    const source = await findStream(A);

    const controls = await openDelete(nav, "复盘 v1");
    fireEvent.click(controls.confirm);
    await confirmGone();
    await findListAlert(nav, REQUEST_FAILED);
    expectNoListToast();
    await within(nav).findByRole("button", { name: "复盘 v2" });
    expect(listReads(fetchMock)).toBe(2);
    expect(entryTitles(nav)).toEqual(["复盘 v2", OTHER]);
    expect(currentLocation()).toBe(SESSION_A);
    expectStreamOpen(source);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
  });

  it("R11 401：交给既有的登录失效处理，不显示该失败、不重读列表", async () => {
    const { fetchMock } = mountSessions("/", SESSIONS, {
      [patchPath(A)]: () =>
        jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    });
    const nav = await findList(CURRENT);
    const reads = listReads(fetchMock);

    const controls = await openDelete(nav, CURRENT);
    fireEvent.click(controls.confirm);
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await yieldMacrotask();
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expect(toasts()).toEqual([]);
    expect(screen.queryByRole("button", { name: "关闭提示" })).toBeNull();
    expect(listReads(fetchMock)).toBe(reads);
  });
});

describe("删除请求中 (R8, R9, R12)", () => {
  it("R8 请求中点 关闭 后重开同一会话的 删除：确认框仍忙碌、全程恰一个 DELETE；204 后重开的确认框消失、条目消失且无轻提示", async () => {
    const { fetchMock, nav, request } = await pendingDelete("/", { close: true });
    expect(calls(fetchMock, patchPath(A)).at(0)?.[1]?.signal?.aborted).toBe(false);
    expect(entryTitles(nav)).toEqual([CURRENT, OTHER, THIRD]);
    expect(toasts()).toEqual([]);

    const reopened = await openDelete(nav, CURRENT);
    expectConfirmBusy(reopened);
    fireEvent.click(reopened.confirm);
    await act(settle);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);

    await settleDeferredResponse(request, noContent());
    await confirmGone();
    expectRemoved(nav);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
  });

  it("R8 请求中关闭后不重开：迟到的 409 在列表区顶部提示显示 message 并重读列表，没有确认框", async () => {
    const { fetchMock, nav, request } = await pendingDelete("/", { close: true });
    const reads = listReads(fetchMock);

    await settleDeferredResponse(request, sessionBusy());
    await findListAlert(nav, BUSY_MESSAGE);
    expectNoListToast();
    await waitFor(() => expect(listReads(fetchMock)).toBe(reads + 1));
    await yieldMacrotask();
    expect(confirmBox()).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(entryTitles(nav)).toEqual([CURRENT, OTHER, THIRD]);
  });

  it.each([
    ["204", noContent, [OTHER, THIRD], null],
    ["409", sessionBusy, [CURRENT, OTHER, THIRD], BUSY_MESSAGE],
  ] as const)(
    "R8 跨会话：A 的 DELETE 挂起时关闭并打开 B 的 删除（可用、取消、无提示）；A 的 %s 到达后 B 的确认框仍在且仍可用",
    async (_kind, response, titles, alert) => {
      const { fetchMock, nav, request } = await pendingDelete("/", {
        close: true,
        extra: { [patchPath(B)]: noContent },
      });
      const other = await openDelete(nav, OTHER);
      expect(confirmDescription(other.dialog)).toBe(`确定要删除「${OTHER}」吗？删除后不可恢复。`);
      expectConfirmIdle(other);

      await settleDeferredResponse(request, response());
      // 204 没有任何提示；409 走列表区顶部提示（B 的确认框开着，提示在它背后）。
      await waitFor(() => expect(entryTitles(nav)).toEqual(titles));
      await waitFor(() => expect(listAlert(nav)).toBe(alert));
      await yieldMacrotask();
      expect(entryTitles(nav)).toEqual(titles);
      expectNoListToast();
      expect(confirmBox()).toBe(other.dialog);
      expect(confirmDescription(other.dialog)).toBe(`确定要删除「${OTHER}」吗？删除后不可恢复。`);
      expectConfirmIdle(other);
      expect(calls(fetchMock, patchPath(B))).toEqual([]);

      // 仍可用：确认后 B 的 DELETE 发出并成功。
      fireEvent.click(other.confirm);
      await confirmGone();
      expect(patchRequests(fetchMock, B)).toEqual([DELETE_REQUEST]);
      expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
      expect(entryTitles(nav)).toEqual(titles.filter((title) => title !== OTHER));
      // 确认 B 的删除是下一次列表动作：A 的提示已清除；B 成功没有提示。
      expect(listAlert(nav)).toBeNull();
      expectNoListToast();
    },
  );

  it("R9 发出时 A 是当前会话、响应前已切到 B：204 后 A 的条目消失且无轻提示，URL、B 的内容与事件流不变", async () => {
    const { nav, request } = await pendingDelete(SESSION_A, {
      close: true,
      extra: { [messagesPath(B)]: snapshotRoute(view(B, OTHER), "B 的回答") },
    });
    const source = await selectEntry(nav, OTHER, B);
    await screen.findByText("B 的回答");
    await crumb(OTHER);
    const depth = window.history.length;

    await deletedLate(request, nav);
    expect(currentLocation()).toBe(SESSION_B);
    expect(window.history.length).toBe(depth);
    expectStreamOpen(source);
    expect(stream(B)).toBe(source);
    expect(screen.getByText("B 的回答")).toBeTruthy();
    expect(await crumb(OTHER)).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1, name: HERO })).toBeNull();
  });

  it("R9 镜像：发出时当前会话是 B、响应前已切到 A：204 后以 replace 回欢迎态，A 的事件流已关闭", async () => {
    const { nav, request } = await pendingDelete(SESSION_B, { close: true });
    const source = await selectEntry(nav, CURRENT, A);
    await crumb(CURRENT);
    const watched = watchCurrent(source);
    expect(watched.from).toBe(SESSION_A);

    await settleDeferredResponse(request, noContent());
    await expectReturnedToWelcome(watched);
    expectRemoved(nav);
  });

  it("R12 A 的 DELETE 挂起时关闭确认框并打开 A 的 重命名：204 后 重命名任务 Dialog 消失", async () => {
    const { nav, request } = await pendingDelete("/", { close: true });
    const rename = await openRename(nav, CURRENT);
    expect(renameDialog()).toBe(rename.dialog);

    await settleDeferredResponse(request, noContent());
    await waitFor(() => expect(renameDialog()).toBeNull());
    expectRemoved(nav);
  });

  it("R12 此时打开的是 B 的 重命名：A 的 204 后它仍在、输入不变", async () => {
    const { nav, request } = await pendingDelete("/", { close: true });
    const rename = await openRename(nav, OTHER);
    fireEvent.change(rename.input, { target: { value: "草稿" } });

    await deletedLate(request, nav);
    expect(renameDialog()).toBe(rename.dialog);
    expect(rename.input.value).toBe("草稿");
    expect(rename.save.disabled).toBe(false);
  });
});

describe("fence：账号切换与卸载 (R10)", () => {
  /** 第一个账号确认删除 A 而 DELETE 挂起，随后续期为第二个账号。 */
  async function renewedWhilePending(later: Response[] = []) {
    const request = deferredResponse();
    const mounted = await mountTwoAccountsOnCurrent([request.promise, ...later]);
    const controls = await openDelete(mounted.nav, FIRST_ACCOUNT_TASK);
    fireEvent.click(controls.confirm);
    expectConfirmBusy(controls);
    const renewed = await mounted.renew();
    // 上一个 client 的确认框不属于新 client。
    await confirmGone();
    expect(patchRequests(mounted.fetchMock, A)).toEqual([DELETE_REQUEST]);
    return { ...renewed, fetchMock: mounted.fetchMock, request };
  }

  it("R10 DELETE 挂起时续期为另一 client：旧 204 到达后无提示、新账号的列表与 URL 不变、新 client 的事件流未关闭", async () => {
    const { fetchMock, list, request, source } = await renewedWhilePending();
    const requests = fetchMock.mock.calls.length;

    await settleDeferredResponse(request, noContent());
    await yieldMacrotask();
    expect(toasts()).toEqual([]);
    expect(entryTitles(list)).toEqual([SECOND_ACCOUNT_TASK]);
    expect(currentLocation()).toBe(SESSION_A);
    expectStreamOpen(source);
    expect(stream(A)).toBe(source);
    expect(screen.getByText(`${SECOND_ACCOUNT_TASK}的回答`)).toBeTruthy();
    expect(fetchMock.mock.calls).toHaveLength(requests);
  });

  it("R10 DELETE 挂起时续期为另一 client：旧 409 到达后无提示、不重读列表", async () => {
    const { fetchMock, list, request, source } = await renewedWhilePending();
    const reads = listReads(fetchMock);

    await settleDeferredResponse(request, sessionBusy());
    await yieldMacrotask();
    expect(toasts()).toEqual([]);
    expect(listAlert(list)).toBeNull();
    expect(listReads(fetchMock)).toBe(reads);
    expect(entryTitles(list)).toEqual([SECOND_ACCOUNT_TASK]);
    expect(currentLocation()).toBe(SESSION_A);
    expectStreamOpen(source);
  });

  it("R10 旧 client 的在途标记不沿用：续期后新 client 上 A 的 删除 可用，确认后发出自己的 DELETE 并成功；其后旧 204 仍被丢弃", async () => {
    const { fetchMock, list, request, source } = await renewedWhilePending([noContent()]);

    const fresh = await openDelete(list, SECOND_ACCOUNT_TASK);
    expect(confirmDescription(fresh.dialog)).toBe(
      `确定要删除「${SECOND_ACCOUNT_TASK}」吗？删除后不可恢复。`,
    );
    expectConfirmIdle(fresh);
    fireEvent.click(fresh.confirm);
    await confirmGone();
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST, DELETE_REQUEST]);
    await waitFor(() => expect(entryTitles(list)).toEqual([]));
    expectNoListToast();
    await waitFor(() => expect(currentLocation()).toBe("/"));
    expect(source.readyState).toBe(CLOSED);
    await expectWelcome();

    await settleDeferredResponse(request, noContent());
    await yieldMacrotask();
    expectNoListToast();
    expect(currentLocation()).toBe("/");
  });

  it.each([
    ["204", noContent],
    ["409 信封", sessionBusy],
  ] as const)(
    "R10 DELETE 挂起时离开会话页：请求被 abort，迟到的 %s 不提示、不导航、不抛错、无 React 警告",
    async (_kind, response) => {
      const { fetchMock, request, router } = await pendingDelete(SESSION_A);
      const signal = calls(fetchMock, patchPath(A)).at(0)?.[1]?.signal;
      expect(signal?.aborted).toBe(false);

      await leaveChatPage(router);
      expect(confirmBox()).toBeNull();
      expect(signal?.aborted).toBe(true);
      const consoleError = vi.spyOn(console, "error");
      const requests = fetchMock.mock.calls.length;

      await settleDeferredResponse(request, response());
      await yieldMacrotask();
      expect(toasts()).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(currentLocation()).toBe("/center");
      expect(fetchMock.mock.calls).toHaveLength(requests);
      expect(consoleError).not.toHaveBeenCalled();
    },
  );
});

describe("≤760px 导航覆盖层 (R13)", () => {
  it("R13 覆盖层内「更多」→ 删除：确认框出现而 导航 仍在；Escape 只关确认框；再次删除当前会话，204 后 导航 仍是同一元素、条目消失、URL 不含 ?session=", async () => {
    installNarrowViewport();
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, { [patchPath(A)]: noContent });
    await crumb(CURRENT);
    await findStream(A);
    const { nav, overlay } = await openNavOverlay(CURRENT);

    // 完整指针序列：菜单在 portal 里（覆盖层 DOM 之外），覆盖层的外点判定要真的跑到。
    const { menu, trigger } = await openEntryMenu(nav, CURRENT);
    await yieldMacrotask();
    pressPointer(within(menu).getByRole("menuitem", { name: "删除" }));
    const dialog = await screen.findByRole("alertdialog", { name: "删除任务" });
    await yieldMacrotask();
    // 确认框打开期间覆盖层被 hideOthers 标为 aria-hidden：按元素断言它仍在 DOM 中（同 7.2a M14）。
    expect(screen.getAllByRole("dialog", { hidden: true })).toEqual([overlay]);
    expect(overlay.isConnected).toBe(true);
    expect(trigger.isConnected).toBe(true);

    fireEvent.keyDown(within(dialog).getByRole("button", { name: "取消" }), { key: "Escape" });
    await confirmGone();
    await focusOn(trigger);
    await yieldMacrotask();
    expect(trigger).toBe(moreButton(nav, CURRENT));
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
    expect(entryTitles(nav)).toEqual([CURRENT, OTHER, THIRD]);
    expect(currentLocation()).toBe(SESSION_A);

    const again = await openDelete(nav, CURRENT);
    await yieldMacrotask();
    pressPointer(again.confirm);
    await confirmGone();
    await waitFor(() => expect(currentLocation()).toBe("/"));
    await yieldMacrotask();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    expectRemoved(nav);
    // 被删条目的「更多」按钮已卸载：焦点留在覆盖层内（列表区的 `新建会话`）。
    await focusOn(newSessionButton(nav));
    expect(overlay.contains(document.activeElement)).toBe(true);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expect(stream(A).readyState).toBe(CLOSED);
  });
});
