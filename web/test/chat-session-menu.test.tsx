import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
import {
  BUSY_MESSAGE,
  closeMenu,
  confirmBox,
  confirmDescription,
  confirmGone,
  DELETE_REQUEST,
  expectConfirmBusy,
  expectConfirmIdle,
  expectWelcome,
  findStream,
  noContent,
  openDelete,
  selectEntry,
  sessionBusy,
} from "./chat-page-session-delete-support.js";
import {
  A,
  B,
  C,
  chooseEntryAction,
  cleanupSessionMeta,
  crumb,
  entryTitles,
  envelope,
  expectNoListToast,
  findList,
  findListAlert,
  focusOn,
  listAlert,
  messagesPath,
  moreButton,
  mountSessions,
  newSessionButton,
  openEntryMenu,
  openRename,
  openTopbarRename,
  PIN,
  PINNED_AT,
  partition,
  partitionTitles,
  patchOf,
  patchPath,
  patchRequests,
  renameDialog,
  saveTitle,
  typeTitle,
  UNPIN,
  view,
} from "./chat-page-session-meta-support.js";
import { CLOSED, chatSnapshot, settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// session-sidebar「会话条目菜单与重命名」的九个场景（任务 15.4）。每条都断言页面不出现
// `已重命名` / `已更新置顶状态` / `任务已删除`（`expectNoListToast`）。其余菜单、重命名、置顶、删除
// 的用例在 `chat-page-session-*.test.tsx`。

const OLD = "季度复盘";
const OTHER = "需求评审";
const THIRD = "发布清单";
const NEW = "周报整理";
const BAD_REQUEST = "请求格式不正确";
const SESSION_A = `/?session=${A}`;
const PINNED_GROUP = "置顶任务";
const TEMPORARY_GROUP = "临时空间";
const SESSIONS = [view(A, OLD), view(B, OTHER), view(C, THIRD)];

afterEach(cleanupSessionMeta);

async function dialogGone() {
  await waitFor(() => expect(renameDialog()).toBeNull());
}

function bannerButtons() {
  return within(screen.getByRole("banner"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
}

function listReads(fetchMock: Parameters<typeof calls>[0]) {
  return calls(fetchMock, "/api/sessions").length;
}

describe("会话条目菜单与重命名（session-sidebar）", () => {
  it("从条目菜单重命名", async () => {
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, {
      [patchPath(A)]: () => jsonResponse(view(A, NEW)),
      [patchPath(B)]: () => jsonResponse(view(B, "评审纪要")),
    });
    const nav = await findList(OLD);
    await crumb(OLD);

    const controls = await openRename(nav, OLD);
    expect(controls.input.value).toBe(OLD);
    await focusOn(controls.input);
    saveTitle(controls, `  ${NEW}  `);
    await dialogGone();

    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"title":"周报整理"}')]);
    await focusOn(moreButton(nav, NEW));
    expect(moreButton(nav, NEW)).toBe(controls.trigger);
    expect(entryTitles(nav)).toEqual([NEW, OTHER, THIRD]);
    expect(await crumb(NEW)).toBeTruthy();
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();

    // 全空白时 `保存` 禁用；输入框内 Enter（jsdom 里即表单的 submit 事件）等价于 `保存`。
    const second = await openRename(nav, OTHER);
    typeTitle(second, "   ");
    expect(second.save.disabled).toBe(true);
    fireEvent.submit(second.form);
    await act(settle);
    expect(calls(fetchMock, patchPath(B))).toEqual([]);
    typeTitle(second, "评审纪要");
    expect(second.save.disabled).toBe(false);
    fireEvent.submit(second.form);
    await dialogGone();
    expect(patchRequests(fetchMock, B)).toEqual([patchOf('{"title":"评审纪要"}')]);
    expect(entryTitles(nav)).toEqual([NEW, "评审纪要", THIRD]);
    expectNoListToast();
  });

  it("重命名失败保留对话框", async () => {
    mountSessions(SESSION_A, SESSIONS, { [patchPath(A)]: () => envelope(400, BAD_REQUEST) });
    const nav = await findList(OLD);
    await crumb(OLD);

    const controls = await openRename(nav, OLD);
    saveTitle(controls, NEW);
    const alert = await within(controls.dialog).findByRole("alert");

    expect(alert.textContent).toBe(BAD_REQUEST);
    expect(renameDialog()).toBe(controls.dialog);
    expect(entryTitles(nav)).toEqual([OLD, OTHER, THIRD]);
    expect(await crumb(OLD)).toBeTruthy();
    // 对话框开着：失败只在对话框内显示，不另走列表区顶部提示。
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
  });

  it("重命名请求中", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, {
      [patchPath(A)]: [first.promise, second.promise],
    });
    const nav = await findList(OLD);
    await crumb(OLD);

    const controls = await openRename(nav, OLD);
    saveTitle(controls, NEW);
    expect(controls.save.disabled).toBe(true);
    fireEvent.submit(controls.form);
    fireEvent.click(controls.save);
    await act(settle);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    fireEvent.click(controls.cancel);
    await dialogGone();
    expect(entryTitles(nav)).toEqual([OLD, OTHER, THIRD]);

    await settleDeferredResponse(first, jsonResponse(view(A, NEW)));
    expect(await crumb(NEW)).toBeTruthy();
    expect(entryTitles(nav)).toEqual([NEW, OTHER, THIRD]);
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();

    // 同样在请求中关闭，而响应为 400 信封：对话框已不在，失败走列表区顶部提示。
    const again = await openRename(nav, NEW);
    saveTitle(again, "再改一次");
    fireEvent.click(again.cancel);
    await dialogGone();
    await settleDeferredResponse(second, envelope(400, BAD_REQUEST));
    await findListAlert(nav, BAD_REQUEST);
    expect(entryTitles(nav)).toEqual([NEW, OTHER, THIRD]);
    expect(await crumb(NEW)).toBeTruthy();
    expect(renameDialog()).toBeNull();
    expectNoListToast();

    fireEvent.click(within(nav).getByRole("button", { name: "关闭提示" }));
    expect(listAlert(nav)).toBeNull();
    expect(within(nav).queryByRole("alert")).toBeNull();
    // `关闭提示` 随提示卸载：焦点留在列表区，不落回 body。
    expect(document.activeElement).toBe(newSessionButton(nav));
  });

  it("顶栏重命名入口", async () => {
    const { fetchMock, router } = mountSessions(SESSION_A, SESSIONS);
    await findList(OLD);
    await crumb(OLD);

    const banner = screen.getByRole("banner");
    const heading = within(banner).getByRole("heading", { level: 1, name: `我的工作 / ${OLD}` });
    const rename = within(banner).getByRole("button", { name: "重命名" });
    expect(heading.compareDocumentPosition(rename) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);
    expect(within(banner).queryByRole("button", { name: "更多" })).toBeNull();

    const controls = await openTopbarRename();
    expect(controls.trigger).toBe(rename);
    expect(within(controls.dialog).getByRole("heading", { name: "重命名任务" })).toBeTruthy();
    expect(controls.input.value).toBe(OLD);
    await focusOn(controls.input);
    fireEvent.click(controls.cancel);
    await dialogGone();
    await focusOn(rename);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);

    await act(() => router.navigate("/"));
    await expectWelcome();
    expect(screen.queryByRole("banner")).toBeNull();
    for (const name of ["重命名", "对话内搜索", "产物面板"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expectNoListToast();
  });

  it("置顶菜单文案与提示", async () => {
    const UPSTREAM = "上游服务不可用";
    const { fetchMock } = mountSessions("/", SESSIONS, {
      [patchPath(B)]: () => jsonResponse(view(B, OTHER, { pinnedAt: PINNED_AT })),
      [patchPath(C)]: () => envelope(502, UPSTREAM),
    });
    const nav = await findList(OLD);
    expect(partition(nav, PINNED_GROUP)).toBeNull();

    await chooseEntryAction(nav, OTHER, PIN);
    await waitFor(() => expect(partitionTitles(nav, PINNED_GROUP)).toEqual([OTHER]));
    expect(patchRequests(fetchMock, B)).toEqual([patchOf('{"pinned":true}')]);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([OLD, THIRD]);
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
    const reopened = await openEntryMenu(nav, OTHER);
    expect(reopened.items.map((item) => item.textContent)).toEqual([
      "重命名",
      UNPIN,
      "归档",
      "删除",
      "导出记录",
    ]);
    await closeMenu(reopened.menu);

    // 置顶的 PATCH 返回 502：列表不变，列表区顶部出现信封文案。
    await chooseEntryAction(nav, THIRD, PIN);
    await findListAlert(nav, UPSTREAM);
    expect(patchRequests(fetchMock, C)).toEqual([patchOf('{"pinned":true}')]);
    expect(partitionTitles(nav, PINNED_GROUP)).toEqual([OTHER]);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([OLD, THIRD]);
    expectNoListToast();

    // 随后发起任一列表动作（这里是打开另一条的 `重命名`）时该提示消失。
    const rename = await openRename(nav, OLD);
    expect(listAlert(nav)).toBeNull();
    expect(nav.querySelector('[role="alert"]')).toBeNull();
    fireEvent.click(rename.cancel);
    await dialogGone();
    expectNoListToast();
  });

  it("迟到的元数据响应", async () => {
    const pin = deferredResponse();
    const running = view(B, OTHER, { status: "running" });
    let sessions = [view(A, OLD), running, view(C, THIRD)];
    const { fetchMock } = mountSessions("/", sessions, {
      "/api/sessions": () => jsonResponse({ sessions }),
      [patchPath(B)]: () => pin.promise,
      [patchPath(C)]: sessionBusy,
    });
    const nav = await findList(OLD);
    expect(within(nav).getByRole("status", { name: `${OTHER} 运行中` })).toBeTruthy();
    await chooseEntryAction(nav, OTHER, PIN);
    expect(patchRequests(fetchMock, B)).toEqual([patchOf('{"pinned":true}')]);

    // 置顶响应返回前列表被重新读取（另一条的删除失败触发），重读时 B 已为 done。
    sessions = [view(A, OLD), view(B, OTHER), view(C, THIRD)];
    const reads = listReads(fetchMock);
    fireEvent.click((await openDelete(nav, THIRD)).confirm);
    await confirmGone();
    await waitFor(() => expect(listReads(fetchMock)).toBe(reads + 1));
    expect(await within(nav).findByRole("status", { name: `${OTHER} 已完成` })).toBeTruthy();
    expect(partition(nav, PINNED_GROUP)).toBeNull();

    await settleDeferredResponse(pin, jsonResponse({ ...running, pinnedAt: PINNED_AT }));
    expect(partitionTitles(nav, PINNED_GROUP)).toEqual([OTHER]);
    expect(partitionTitles(nav, TEMPORARY_GROUP)).toEqual([OLD, THIRD]);
    const mark = within(nav).getByRole("status", { name: new RegExp(`^${OTHER} `) });
    expect(mark.getAttribute("aria-label")?.endsWith("已完成")).toBe(true);
    expect(within(nav).queryByRole("status", { name: `${OTHER} 运行中` })).toBeNull();
    expectNoListToast();
  });

  it("删除确认文案", async () => {
    const FORMAL = "1".repeat(32);
    const SOLE = "2".repeat(32);
    const SHARED = "3".repeat(32);
    const D = "d".repeat(32);
    const E = "e".repeat(32);
    const { fetchMock } = mountSessions("/", [
      view(A, "正式空间的任务", { workspaceId: FORMAL }),
      // 与 A 共用正式空间：正式空间不看共用，仍是普通文案。
      view(E, "同一正式空间", { workspaceId: FORMAL }),
      view(B, "独占临时空间", { temporaryWorkspace: true, workspaceId: SOLE }),
      view(C, "共用临时空间", { temporaryWorkspace: true, workspaceId: SHARED }),
      // 与 C 共用临时空间的另一个会话已归档：不在默认视图里，但在已加载的列表里。
      view(D, "已归档的同伴", {
        archivedAt: 1_750_000_000_000,
        temporaryWorkspace: true,
        workspaceId: SHARED,
      }),
    ]);
    const nav = await findList("正式空间的任务");
    expect(entryTitles(nav)).not.toContain("已归档的同伴");
    const requests = fetchMock.mock.calls.length;

    for (const [title, description] of [
      ["正式空间的任务", "确定要删除「正式空间的任务」吗？删除后不可恢复。"],
      [
        "独占临时空间",
        "确定要删除「独占临时空间」吗？删除后不可恢复。临时空间里的文件会一并删除。",
      ],
      [
        "共用临时空间",
        "确定要删除「共用临时空间」吗？删除后不可恢复。它与其它会话共用临时空间，文件会保留到最后一个会话被删除。",
      ],
    ] as const) {
      const controls = await openDelete(nav, title);
      expect(within(controls.dialog).getByRole("heading", { name: "删除任务" })).toBeTruthy();
      expect(confirmDescription(controls.dialog)).toBe(description);
      expectConfirmIdle(controls);
      fireEvent.click(controls.cancel);
      await confirmGone();
      await focusOn(controls.trigger);
    }
    expect(fetchMock.mock.calls).toHaveLength(requests);
    expectNoListToast();
  });

  it("删除当前会话", async () => {
    const path = `/?from=keep&session=${A}#hash`;
    const request = deferredResponse();
    const running = view(A, OLD, { status: "running" });
    const { fetchMock } = mountSessions(path, [running, view(B, OTHER), view(C, THIRD)], {
      [messagesPath(A)]: () =>
        jsonResponse({ ...chatSnapshot({ content: "生成到一半" }), session: running }),
      [patchPath(A)]: () => request.promise,
      [patchPath(B)]: noContent,
      [patchPath(C)]: sessionBusy,
    });
    const nav = await findList(OLD);
    const source = await findStream(A);
    await crumb(OLD);

    // 删除一个非当前选中的会话：条目消失，URL 与主区当前会话不变。
    fireEvent.click((await openDelete(nav, OTHER)).confirm);
    await confirmGone();
    await waitFor(() => expect(entryTitles(nav)).toEqual([OLD, THIRD]));
    expect(patchRequests(fetchMock, B)).toEqual([DELETE_REQUEST]);
    expect(currentLocation()).toBe(path);
    expect(await crumb(OLD)).toBeTruthy();
    expect(source.readyState).not.toBe(CLOSED);
    expectNoListToast();

    // `取消` 不发请求；DELETE 返回 409：确认框关闭、列表区顶部显示信封文案、列表被重新读取。
    const cancelled = await openDelete(nav, THIRD);
    fireEvent.click(cancelled.cancel);
    await confirmGone();
    expect(calls(fetchMock, patchPath(C))).toEqual([]);
    const reads = listReads(fetchMock);
    const refused = await openDelete(nav, THIRD);
    fireEvent.click(refused.confirm);
    await confirmGone();
    await findListAlert(nav, BUSY_MESSAGE);
    await waitFor(() => expect(listReads(fetchMock)).toBe(reads + 1));
    expect(patchRequests(fetchMock, C)).toEqual([DELETE_REQUEST]);
    await focusOn(refused.trigger);
    expectNoListToast();

    // 当前选中且 running 的会话：一次 DELETE，请求中确认按钮忙碌禁用；204 后回欢迎态。
    const controls = await openDelete(nav, OLD);
    expect(listAlert(nav)).toBeNull();
    fireEvent.click(controls.confirm);
    expectConfirmBusy(controls);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expect(currentLocation()).toBe(path);

    await settleDeferredResponse(request, noContent());
    await confirmGone();
    await within(nav).findByRole("button", { name: THIRD });
    await waitFor(() => expect(currentLocation()).toBe("/?from=keep#hash"));
    expect(entryTitles(nav)).not.toContain(OLD);
    expect(source.readyState).toBe(CLOSED);
    await expectWelcome();
    // 被删条目的「更多」按钮已卸载：焦点落到列表区的 `新建会话`，不落回 body。
    await focusOn(newSessionButton(nav));
    await yieldMacrotask();
    expect(document.activeElement).toBe(newSessionButton(nav));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expectNoListToast();
  });

  it("删除请求中", async () => {
    const other = deferredResponse();
    const current = deferredResponse();
    const { fetchMock } = mountSessions(SESSION_A, SESSIONS, {
      [patchPath(A)]: () => current.promise,
      [patchPath(B)]: () => other.promise,
    });
    const nav = await findList(OLD);
    await findStream(A);

    // 确认删除而 DELETE 尚未返回：取消按钮文案为 `关闭`；关闭后重开仍忙碌，没有第二个 DELETE。
    const controls = await openDelete(nav, OTHER);
    fireEvent.click(controls.confirm);
    expectConfirmBusy(controls);
    fireEvent.click(controls.cancel);
    await confirmGone();
    await focusOn(controls.trigger);
    const reopened = await openDelete(nav, OTHER);
    expectConfirmBusy(reopened);
    fireEvent.click(reopened.confirm);
    await act(settle);
    expect(patchRequests(fetchMock, B)).toEqual([DELETE_REQUEST]);

    await settleDeferredResponse(other, noContent());
    await confirmGone();
    expect(confirmBox()).toBeNull();
    expect(entryTitles(nav)).toEqual([OLD, THIRD]);
    expect(patchRequests(fetchMock, B)).toEqual([DELETE_REQUEST]);
    await focusOn(newSessionButton(nav));
    expectNoListToast();

    // 删除请求发出时当前会话是它，响应到达前已切到另一会话：204 后 URL 与主区停在另一会话。
    const own = await openDelete(nav, OLD);
    fireEvent.click(own.confirm);
    fireEvent.click(own.cancel);
    await confirmGone();
    const stream = await selectEntry(nav, THIRD, C);
    await crumb(THIRD);
    await settleDeferredResponse(current, noContent());
    await waitFor(() => expect(entryTitles(nav)).toEqual([THIRD]));
    await yieldMacrotask();
    expect(currentLocation()).toBe(`/?session=${C}`);
    expect(await crumb(THIRD)).toBeTruthy();
    expect(stream.readyState).not.toBe(CLOSED);
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
  });
});
