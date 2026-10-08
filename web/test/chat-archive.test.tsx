// 归档动作与归档视图整页测试（任务 16.1）：session-sidebar「归档视图」三个场景、「归档当前会话」、
// 「标题搜索」的「归档视图里搜索」、「空状态」的 `已归档` 入口。主区的归档只读呈现（
// `该会话已归档，恢复后才能继续对话`、不渲染输入框）属任务 16.2，这里只断言请求、列表与 URL。
import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUSY_MESSAGE,
  closeMenu,
  confirmDescription,
  confirmGone,
  DELETE_REQUEST,
  noContent,
  openDelete,
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
  installNarrowViewport,
  listAlert,
  mountSessions,
  newSessionButton,
  openEntryMenu,
  openNavOverlay,
  PIN,
  PINNED_AT,
  partition,
  partitionTitles,
  patchOf,
  patchPath,
  patchRequests,
  view,
} from "./chat-page-session-meta-support.js";
import { settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";

const ARCHIVED = "已归档";
const BACK = "返回会话列表";
const EMPTY = "没有匹配的任务";
const PINNED_GROUP = "置顶任务";
const ARCHIVE = "归档";
const RESTORE = "恢复";
const ARCHIVED_AT = 1_760_000_000_000;
const OLD_PROJECT = "旧项目";
const ACTIVE = "在办的任务";
const SESSION_A = `/?session=${A}`;

afterEach(cleanupSessionMeta);

function listNav() {
  return screen.findByRole("navigation", { name: "会话列表" });
}

function archivedEntry(nav: HTMLElement) {
  return within(nav).queryByRole("button", { name: ARCHIVED });
}

function archivedHeading(nav: HTMLElement) {
  return within(nav).queryByRole("heading", { name: ARCHIVED });
}

function backButton(nav: HTMLElement) {
  return within(nav).queryByRole("button", { name: BACK });
}

function searchBox(nav: HTMLElement) {
  return within(nav).getByRole<HTMLInputElement>("searchbox", { name: "搜索任务" });
}

/** 默认视图：有 `已归档` 入口与 `分组方式`，没有归档视图的标题与 `返回会话列表`。 */
function expectDefaultView(nav: HTMLElement) {
  expect(archivedEntry(nav)).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: "分组方式" })).toBeTruthy();
  expect(archivedHeading(nav)).toBeNull();
  expect(backButton(nav)).toBeNull();
}

/**
 * 归档视图：标题 `已归档` 与 `返回会话列表` 取代 `分组方式`、分组列表与入口；`新建会话`（仍是 nav 的
 * 第一个直接子按钮）与搜索框保留。
 */
function expectArchivedView(nav: HTMLElement) {
  expect(archivedHeading(nav)).toBeTruthy();
  expect(backButton(nav)).toBeTruthy();
  expect(archivedEntry(nav)).toBeNull();
  expect(within(nav).queryByRole("button", { name: "分组方式" })).toBeNull();
  expect(within(nav).queryAllByRole("group")).toEqual([]);
  expect(nav.querySelector(":scope > button")).toBe(newSessionButton(nav));
  expect(searchBox(nav)).toBeTruthy();
}

/** 点 `已归档` 入口；入口随之卸载，焦点交给 `返回会话列表`（不落回 body）。 */
async function enterArchived(nav: HTMLElement) {
  const entry = archivedEntry(nav);
  if (!entry) throw new Error("没有 已归档 入口");
  fireEvent.click(entry);
  expectArchivedView(nav);
  const back = backButton(nav);
  if (!back) throw new Error("没有 返回会话列表");
  await focusOn(back);
}

function leaveArchived(nav: HTMLElement) {
  const back = backButton(nav);
  if (!back) throw new Error("没有 返回会话列表");
  fireEvent.click(back);
  expectDefaultView(nav);
}

describe("归档视图（session-sidebar）", () => {
  it("查看、恢复", async () => {
    const archived = view(A, OLD_PROJECT, { archivedAt: ARCHIVED_AT, pinnedAt: PINNED_AT });
    const { fetchMock } = mountSessions("/", [archived, view(B, ACTIVE)], {
      [patchPath(A)]: () => jsonResponse({ ...archived, archivedAt: null }),
    });
    const nav = await findList(ACTIVE);

    // 默认视图：已归档且置顶的会话不在 `置顶任务`（也不在任何分组）里。
    expectDefaultView(nav);
    expect(partition(nav, PINNED_GROUP)).toBeNull();
    expect(entryTitles(nav)).toEqual([ACTIVE]);
    expect(nav.querySelector(":scope > button")).toBe(newSessionButton(nav));

    await enterArchived(nav);
    expect(entryTitles(nav)).toEqual([OLD_PROJECT]);
    const { items, menu } = await openEntryMenu(nav, OLD_PROJECT);
    expect(items.map((item) => item.textContent)).toEqual([RESTORE, "删除"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: RESTORE }));

    await within(nav).findByText(EMPTY, { exact: true });
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"archived":false}')]);
    expect(entryTitles(nav)).toEqual([]);
    expectArchivedView(nav);
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();

    leaveArchived(nav);
    expect(partitionTitles(nav, PINNED_GROUP)).toEqual([OLD_PROJECT]);
    expect(entryTitles(nav)).toEqual([OLD_PROJECT, ACTIVE]);
    const entry = archivedEntry(nav);
    if (!entry) throw new Error("没有 已归档 入口");
    await focusOn(entry);
  });

  it("在归档视图删除：独占临时空间的已归档会话，确认文案含文件一并删除，204 后条目消失", async () => {
    const TITLE = "临时草稿";
    const { fetchMock } = mountSessions(
      "/",
      [
        view(A, TITLE, {
          archivedAt: ARCHIVED_AT,
          temporaryWorkspace: true,
          workspaceId: "1".repeat(32),
        }),
        view(B, ACTIVE),
      ],
      { [patchPath(A)]: noContent },
    );
    const nav = await findList(ACTIVE);
    await enterArchived(nav);

    const controls = await openDelete(nav, TITLE);
    expect(confirmDescription(controls.dialog)).toBe(
      `确定要删除「${TITLE}」吗？删除后不可恢复。临时空间里的文件会一并删除。`,
    );
    fireEvent.click(controls.confirm);
    await confirmGone();

    await within(nav).findByText(EMPTY, { exact: true });
    expect(entryTitles(nav)).toEqual([]);
    expect(patchRequests(fetchMock, A)).toEqual([DELETE_REQUEST]);
    expectArchivedView(nav);
    expectNoListToast();
    leaveArchived(nav);
    expect(entryTitles(nav)).toEqual([ACTIVE]);
  });

  it("打开已归档的会话：URL 为 ?session=<id>，条目选中，侧栏留在归档视图；直接打开时侧栏停在默认视图", async () => {
    const sessions = [view(A, OLD_PROJECT, { archivedAt: ARCHIVED_AT }), view(B, ACTIVE)];
    mountSessions("/", sessions);
    const nav = await findList(ACTIVE);
    await enterArchived(nav);

    fireEvent.click(within(nav).getByRole("button", { name: OLD_PROJECT }));
    await waitFor(() => expect(currentLocation()).toBe(SESSION_A));
    expect(await crumb(OLD_PROJECT)).toBeTruthy();
    expect(
      within(nav).getByRole("button", { name: OLD_PROJECT }).getAttribute("aria-current"),
    ).toBe("true");
    expectArchivedView(nav);

    await cleanupSessionMeta();
    mountSessions(SESSION_A, sessions);
    const direct = await findList(ACTIVE);
    expect(await crumb(OLD_PROJECT)).toBeTruthy();
    expectDefaultView(direct);
    expect(entryTitles(direct)).toEqual([ACTIVE]);
  });

  it("归档视图是页面内存状态下的列表区切换：≤760px 覆盖层内进入与返回都不关闭覆盖层", async () => {
    installNarrowViewport();
    mountSessions(`/?session=${B}`, [
      view(A, OLD_PROJECT, { archivedAt: ARCHIVED_AT }),
      view(B, ACTIVE),
    ]);
    await crumb(ACTIVE);
    const { nav, overlay } = await openNavOverlay(ACTIVE);

    await enterArchived(nav);
    expect(entryTitles(nav)).toEqual([OLD_PROJECT]);
    leaveArchived(nav);
    const entry = archivedEntry(nav);
    if (!entry) throw new Error("没有 已归档 入口");
    await focusOn(entry);
    expect(overlay.isConnected).toBe(true);
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
  });
});

describe("归档与恢复动作（session-sidebar「会话条目菜单与重命名」）", () => {
  it("归档当前会话：PATCH {archived:true}，条目离开默认视图，URL 仍选中它，只采用应答的 archivedAt，没有轻提示", async () => {
    const OLD = "季度复盘";
    // 应答视图里的 title、status、pinnedAt 都与列表不同：只有 archivedAt 被采用。
    const reply = view(A, "应答里的旧标题", {
      archivedAt: ARCHIVED_AT,
      pinnedAt: PINNED_AT,
      status: "running",
    });
    const { fetchMock } = mountSessions(SESSION_A, [view(A, OLD), view(B, ACTIVE)], {
      [patchPath(A)]: [jsonResponse(reply), jsonResponse({ ...reply, archivedAt: null })],
    });
    const nav = await findList(OLD);
    await crumb(OLD);

    // `归档` 紧跟置顶项、在 `删除` 之前。
    const { items, menu } = await openEntryMenu(nav, OLD);
    expect(items.map((item) => item.textContent).slice(0, 4)).toEqual([
      "重命名",
      PIN,
      ARCHIVE,
      "删除",
    ]);
    expect(items[2]?.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(within(menu).getByRole("menuitem", { name: ARCHIVE }));

    await waitFor(() => expect(entryTitles(nav)).toEqual([ACTIVE]));
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"archived":true}')]);
    expect(partition(nav, PINNED_GROUP)).toBeNull();
    expect(currentLocation()).toBe(SESSION_A);
    expect(await crumb(OLD)).toBeTruthy();
    expect(listAlert(nav)).toBeNull();
    expectNoListToast();
    expectDefaultView(nav);

    // 它进了归档视图：标题仍是列表里的、仍被选中、状态元素不是应答里的 `运行中`。
    await enterArchived(nav);
    expect(entryTitles(nav)).toEqual([OLD]);
    expect(within(nav).getByRole("button", { name: OLD }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(within(nav).queryByRole("status", { name: `${OLD} 运行中` })).toBeNull();

    // 恢复同样只采用 archivedAt：回到默认视图时不在 `置顶任务` 里，标题不变。
    await chooseEntryAction(nav, OLD, RESTORE);
    await within(nav).findByText(EMPTY, { exact: true });
    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"archived":true}'),
      patchOf('{"archived":false}'),
    ]);
    leaveArchived(nav);
    expect(partition(nav, PINNED_GROUP)).toBeNull();
    expect(entryTitles(nav)).toEqual([OLD, ACTIVE]);
    expect(currentLocation()).toBe(SESSION_A);
    expectNoListToast();
  });

  it("运行中的会话：归档 为禁用项，点击不发请求，条目留在默认视图", async () => {
    const RUNNING = "跑着的";
    const { fetchMock } = mountSessions("/", [
      view(A, RUNNING, { status: "running" }),
      view(B, ACTIVE),
    ]);
    const nav = await findList(RUNNING);

    const { menu } = await openEntryMenu(nav, RUNNING);
    const item = within(menu).getByRole("menuitem", { name: ARCHIVE });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    await act(settle);
    await closeMenu(menu);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
    expect(entryTitles(nav)).toEqual([RUNNING, ACTIVE]);

    // 非运行中的会话上同一项可用。
    const idle = await openEntryMenu(nav, ACTIVE);
    expect(
      within(idle.menu).getByRole("menuitem", { name: ARCHIVE }).hasAttribute("aria-disabled"),
    ).toBe(false);
    await closeMenu(idle.menu);
  });

  it("归档与恢复失败：列表不变，列表区顶部提示显示信封文案，下一次列表动作发起时清除", async () => {
    const UPSTREAM = "上游服务不可用";
    const STORED = "存档";
    const retry = deferredResponse();
    const { fetchMock } = mountSessions(
      "/",
      [view(A, ACTIVE), view(B, "另一条"), view(C, STORED, { archivedAt: ARCHIVED_AT })],
      {
        [patchPath(A)]: [sessionBusy(), retry.promise],
        [patchPath(C)]: () => envelope(502, UPSTREAM),
      },
    );
    const nav = await findList(ACTIVE);

    // 409 `会话正在生成，请稍候`：条目留在默认视图。
    await chooseEntryAction(nav, ACTIVE, ARCHIVE);
    await findListAlert(nav, BUSY_MESSAGE);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"archived":true}')]);
    expect(entryTitles(nav)).toEqual([ACTIVE, "另一条"]);
    expectNoListToast();

    // 再次发起归档即清除提示（响应到达之前）。
    await chooseEntryAction(nav, ACTIVE, ARCHIVE);
    expect(listAlert(nav)).toBeNull();
    expect(nav.querySelector('[role="alert"]')).toBeNull();

    // 恢复失败：条目留在归档视图，提示在列表区顶部。
    await enterArchived(nav);
    await chooseEntryAction(nav, STORED, RESTORE);
    await findListAlert(nav, UPSTREAM);
    expect(patchRequests(fetchMock, C)).toEqual([patchOf('{"archived":false}')]);
    expect(entryTitles(nav)).toEqual([STORED]);
    expectArchivedView(nav);
    expectNoListToast();
  });
});

describe("标题搜索与空状态里的归档（session-sidebar）", () => {
  it("归档视图里搜索：只在已归档的会话里搜，搜索词在两个视图间保留，不发请求", async () => {
    const { fetchMock } = mountSessions("/", [
      view(A, "周报整理"),
      view(B, "月报存档", { archivedAt: ARCHIVED_AT }),
      view(C, "周报存档", { archivedAt: ARCHIVED_AT }),
    ]);
    const nav = await findList("周报整理");
    await enterArchived(nav);
    // 平铺、服务端顺序。
    expect(entryTitles(nav)).toEqual(["月报存档", "周报存档"]);
    const requests = fetchMock.mock.calls.length;

    fireEvent.change(searchBox(nav), { target: { value: "周报" } });
    expect(entryTitles(nav)).toEqual(["周报存档"]);
    expect(within(nav).queryByText(EMPTY, { exact: true })).toBeNull();

    fireEvent.change(searchBox(nav), { target: { value: "不存在" } });
    expect(entryTitles(nav)).toEqual([]);
    expect(within(nav).getByText(EMPTY, { exact: true })).toBeTruthy();

    fireEvent.change(searchBox(nav), { target: { value: " 周报 " } });
    leaveArchived(nav);
    expect(searchBox(nav).value).toBe(" 周报 ");
    expect(entryTitles(nav)).toEqual(["周报整理"]);
    await enterArchived(nav);
    expect(searchBox(nav).value).toBe(" 周报 ");
    expect(entryTitles(nav)).toEqual(["周报存档"]);
    expect(fetchMock.mock.calls).toHaveLength(requests);
  });

  it.each([
    ["账号没有会话", []],
    ["会话全部已归档", [view(A, OLD_PROJECT, { archivedAt: ARCHIVED_AT, pinnedAt: PINNED_AT })]],
  ] as const)(
    "空状态（%s）：已归档 入口仍在，排在 没有匹配的任务 之后",
    async (_case, sessions) => {
      mountSessions("/", sessions);
      const nav = await listNav();

      const empty = await within(nav).findByText(EMPTY, { exact: true });
      expect(within(nav).queryAllByRole("group")).toEqual([]);
      expect(entryTitles(nav)).toEqual([]);
      expectDefaultView(nav);
      const entry = archivedEntry(nav);
      if (!entry) throw new Error("没有 已归档 入口");
      expect(empty.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

      await enterArchived(nav);
      expect(entryTitles(nav)).toEqual(sessions.map((session) => session.title));
      expect(within(nav).queryAllByText(EMPTY, { exact: true })).toHaveLength(
        sessions.length === 0 ? 1 : 0,
      );
    },
  );

  it("读取中与读取失败：已归档 入口仍在，不显示 没有匹配的任务", async () => {
    const pending = deferredResponse();
    mountSessions("/", [], { "/api/sessions": () => pending.promise });
    const loading = await listNav();
    expect(await within(loading).findByText("正在读取会话")).toBeTruthy();
    expectDefaultView(loading);
    expect(within(loading).queryByText(EMPTY, { exact: true })).toBeNull();

    await cleanupSessionMeta();
    mountSessions("/", [], { "/api/sessions": () => envelope(500, "读取失败") });
    const failed = await listNav();
    expect((await within(failed).findByRole("alert")).textContent).toBe("读取失败");
    expectDefaultView(failed);
    expect(within(failed).queryByText(EMPTY, { exact: true })).toBeNull();
  });
});
