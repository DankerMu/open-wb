import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  BUSY_MESSAGE,
  CURRENT,
  confirmBox,
  confirmGone,
  confirmPending,
  DELETE_REQUEST,
  DELETED_TOAST,
  deleteEntry,
  expectConfirmBusy,
  expectConfirmIdle,
  expectRemoved,
  expectReturnedToWelcome,
  expectStreamOpen,
  expectWelcome,
  findStream,
  installShellViewport,
  noContent,
  OTHER,
  openDelete,
  pendingDelete,
  SESSION_A,
  SESSIONS,
  sessionBusy,
  snapshotRoute,
  stream,
  THIRD,
  toastTypes,
  watchCurrent,
} from "./chat-page-session-delete-support.js";
import {
  A,
  B,
  cleanupSessionMeta,
  crumb,
  entryTitles,
  findList,
  installNarrowViewport,
  messagesPath,
  mountSessions,
  openNavOverlay,
  openTopbarRename,
  patchPath,
  patchRequests,
  renameDialog,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import { FakeEventSource, settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 条目菜单删除（#532）评审后补充的证据 F1–F6：在途标记、提示类型、两个会话同时在途、槽位节点
// 卸载、顶栏重命名、历史读取在途。R1–R13 在 `chat-page-session-delete.test.tsx`。

const LIST = { name: "会话列表" };

afterEach(cleanupSessionMeta);

/** 挂起的 DELETE 以 204 返回，等 `任务已删除` 出现（`shown` 为此刻全部提示）。 */
async function deleted(request: ReturnType<typeof deferredResponse>, shown = [DELETED_TOAST]) {
  await settleDeferredResponse(request, noContent());
  await waitFor(() => expect(toasts()).toEqual(shown));
}

describe("成功后的在途标记与提示类型 (F1, F2)", () => {
  /**
   * 欢迎态：A 的 DELETE 得 204（条目移除），随后 B 的 DELETE 得 409——失败触发的列表重读把 A 带回
   * （列表路由始终返回 A、B、C）。
   */
  async function deletedThenListedAgain() {
    const mounted = mountSessions("/", SESSIONS, {
      [patchPath(A)]: noContent,
      [patchPath(B)]: sessionBusy,
    });
    const nav = await findList(CURRENT);
    await deleteEntry(nav, CURRENT);
    expectRemoved(nav);
    await deleteEntry(nav, OTHER);
    await within(nav).findByRole("button", { name: CURRENT });
    expect(entryTitles(nav)).toEqual([CURRENT, OTHER, THIRD]);
    expect(toasts()).toEqual([DELETED_TOAST, BUSY_MESSAGE]);
    return { ...mounted, nav };
  }

  it("F1 成功也清在途标记：A 得 204 后被另一会话删除失败的列表重读带回，再开 A 的 删除 确认按钮可用，确认发出第二个 DELETE", async () => {
    const { fetchMock, nav } = await deletedThenListedAgain();
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);

    const again = await openDelete(nav, CURRENT);
    expectConfirmIdle(again);
    fireEvent.click(again.confirm);
    await confirmGone();
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST, DELETE_REQUEST]);
    expect(entryTitles(nav)).toEqual([OTHER, THIRD]);
    expect(toasts()).toEqual([DELETED_TOAST, BUSY_MESSAGE, DELETED_TOAST]);
  });

  it("F2 提示类型：204 的 任务已删除 是 ui-toast--success，失败的 message 是 ui-toast--error", async () => {
    await deletedThenListedAgain();
    expect(toastTypes()).toEqual([
      [DELETED_TOAST, ["ui-toast--success"]],
      [BUSY_MESSAGE, ["ui-toast--error"]],
    ]);
  });
});

describe("两个会话的 DELETE 同时在途 (F3)", () => {
  it.each([
    ["A 先得 204", CURRENT, OTHER],
    ["镜像：B 先得 204", OTHER, CURRENT],
  ] as const)(
    "F3 A、B 的 DELETE 都挂起且确认框各自关闭，%s：重开另一会话的确认框仍忙碌，它仍恰一个 DELETE，随后各自成功",
    async (_order, first, second) => {
      const other = deferredResponse();
      const { fetchMock, nav, request } = await pendingDelete("/", {
        close: true,
        extra: { [patchPath(B)]: () => other.promise },
      });
      await confirmPending(nav, OTHER, true);
      const pending = { [CURRENT]: request, [OTHER]: other };
      const oneEach = () => [patchRequests(fetchMock, A), patchRequests(fetchMock, B)];
      expect(oneEach()).toEqual([[DELETE_REQUEST], [DELETE_REQUEST]]);

      await deleted(pending[first]);
      expect(entryTitles(nav)).toEqual([second, THIRD]);

      const reopened = await openDelete(nav, second);
      expectConfirmBusy(reopened);
      fireEvent.click(reopened.confirm);
      await act(settle);
      expect(confirmBox()).toBe(reopened.dialog);
      expect(oneEach()).toEqual([[DELETE_REQUEST], [DELETE_REQUEST]]);

      await deleted(pending[second], [DELETED_TOAST, DELETED_TOAST]);
      await confirmGone();
      expect(entryTitles(nav)).toEqual([THIRD]);
      expect(oneEach()).toEqual([[DELETE_REQUEST], [DELETE_REQUEST]]);
    },
  );
});

describe("槽位节点卸载 (F4)", () => {
  it("F4 宽屏：DELETE 挂起时关闭确认框并折叠侧栏（列表区卸载），204 后提示、当前会话回欢迎态；展开后条目已消失", async () => {
    const { nav, request } = await pendingDelete(SESSION_A, { close: true });
    const watched = watchCurrent(stream(A));
    const aside = screen.getByRole("complementary", { name: "侧栏" });
    fireEvent.click(within(aside).getByRole("button", { name: "折叠侧栏" }));
    expect(nav.isConnected).toBe(false);
    expect(screen.queryByRole("navigation", LIST)).toBeNull();

    await deleted(request);
    await expectReturnedToWelcome(watched);
    expect(screen.queryByRole("navigation", LIST)).toBeNull();

    fireEvent.click(within(aside).getByRole("button", { name: "展开侧栏" }));
    expectRemoved(await findList(OTHER));
  });

  it("F4 ≤760px：覆盖层内确认删除当前会话，关闭确认框再关闭覆盖层，204 后提示、回欢迎态；重开覆盖层条目已消失", async () => {
    installNarrowViewport();
    const request = deferredResponse();
    mountSessions(SESSION_A, SESSIONS, { [patchPath(A)]: () => request.promise });
    const watched = watchCurrent(await findStream(A));
    const { nav, overlay } = await openNavOverlay(CURRENT);
    await confirmPending(nav, CURRENT, true);
    fireEvent.click(within(overlay).getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(overlay.isConnected).toBe(false));
    expect(nav.isConnected).toBe(false);
    expect(toasts()).toEqual([]);

    await deleted(request);
    await expectReturnedToWelcome(watched);
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();

    expectRemoved((await openNavOverlay(OTHER)).nav);
  });

  it.each([
    ["窄 → 宽：覆盖层连同其中的列表卸载，列表改在文档流侧栏重挂", true],
    ["宽 → 窄：文档流侧栏卸载而覆盖层未打开，列表不在 DOM 中", false],
  ] as const)(
    "F4 确认框开着时视口跨越 760px（%s）：确认框不随槽位节点消失，取消 可关闭，不发 DELETE",
    async (_case, narrow) => {
      const viewport = installShellViewport(narrow);
      const { fetchMock } = mountSessions(SESSION_A, SESSIONS);
      const source = await findStream(A);
      const nav = narrow ? (await openNavOverlay(CURRENT)).nav : await findList(CURRENT);
      const controls = await openDelete(nav, CURRENT);

      act(() => viewport.emit(!narrow));
      expect(nav.isConnected).toBe(false);
      expect(controls.trigger.isConnected).toBe(false);
      expect(screen.queryAllByRole("navigation", { ...LIST, hidden: true })).toHaveLength(
        narrow ? 1 : 0,
      );
      expect(confirmBox()).toBe(controls.dialog);
      expectConfirmIdle(controls);

      fireEvent.click(controls.cancel);
      await confirmGone();
      await yieldMacrotask();
      expect(calls(fetchMock, patchPath(A))).toEqual([]);
      expect(toasts()).toEqual([]);
      expect(currentLocation()).toBe(SESSION_A);
      expectStreamOpen(source);
      // 列表在另一个呈现面（窄屏须先打开覆盖层），条目不变。
      const list = narrow ? await findList(CURRENT) : (await openNavOverlay(CURRENT)).nav;
      expect(list).not.toBe(nav);
      expect(entryTitles(list)).toEqual([CURRENT, OTHER, THIRD]);
    },
  );
});

describe("顶栏 重命名 随删除关闭 (F5)", () => {
  it("F5 当前会话的 DELETE 挂起时关闭确认框并从顶栏打开 重命名：204 后 重命名任务 Dialog 消失、回欢迎态", async () => {
    const { nav, request } = await pendingDelete(SESSION_A, { close: true });
    const watched = watchCurrent(stream(A));
    await crumb(CURRENT);
    const rename = await openTopbarRename();
    expect(rename.input.value).toBe(CURRENT);

    await deleted(request);
    await waitFor(() => expect(renameDialog()).toBeNull());
    await expectReturnedToWelcome(watched);
    expectRemoved(nav);
    // 欢迎态宽屏不渲染顶栏：打开 Dialog 的按钮已卸载。
    expect(screen.queryByRole("banner")).toBeNull();
  });
});

describe("历史读取在途时删除当前会话 (F6)", () => {
  it("F6 A 的快照读取挂起时删除 A：同一 act 内先 204 后快照，不为已删会话打开事件流，回欢迎态无错误", async () => {
    const snapshot = deferredResponse();
    const request = deferredResponse();
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, {
      [messagesPath(A)]: () => snapshot.promise,
      [patchPath(A)]: () => request.promise,
    });
    const nav = await findList(CURRENT);
    await confirmPending(nav, CURRENT, false);
    // 历史读取仍在途：只发过一次、未被中止，还没有事件流。
    expect(calls(fetchMock, messagesPath(A))).toHaveLength(1);
    expect(calls(fetchMock, messagesPath(A))[0]?.[1]?.signal?.aborted).toBe(false);
    expect(FakeEventSource.instances).toEqual([]);

    // 一个 act 内不渲染：204 处理完（URL 已 replace）而页面还没按新 location 渲染时，快照 200 到达。
    await act(async () => {
      request.resolve(noContent());
      await settle();
      expect(currentLocation()).toBe("/");
      snapshot.resolve(snapshotRoute(view(A, CURRENT), "迟到的回答")());
      await settle();
    });

    expect(FakeEventSource.instances).toEqual([]);
    expect(currentLocation()).toBe("/");
    await expectWelcome();
    expectRemoved(nav);
    await yieldMacrotask();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("迟到的回答")).toBeNull();
    expect(FakeEventSource.instances).toEqual([]);
    expect(calls(fetchMock, messagesPath(A))).toHaveLength(1);
  });
});
