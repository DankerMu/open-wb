import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { settleDeferredResponse } from "./chat-page-lifecycle-support.js";
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
  FIRST_ACCOUNT_TASK,
  findList,
  findListAlert,
  focusOn,
  installNarrowViewport,
  leaveChatPage,
  listAlert,
  moreButton,
  mountSessions,
  mountTwoAccounts,
  openEntryMenu,
  openNavOverlay,
  openRename,
  openTopbarRename,
  PIN,
  PINNED_AT,
  partitionTitles,
  patchOf,
  patchPath,
  patchRequests,
  REQUEST_FAILED,
  type RenameControls,
  renameDialog,
  SECOND_ACCOUNT_TASK,
  saveTitle,
  toasts,
  typeTitle,
  UNPIN,
  view,
} from "./chat-page-session-meta-support.js";
import { settle } from "./chat-stream-support.js";
import { calls, currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { pressPointer, yieldMacrotask } from "./ui-support.js";

const OLD = "季度复盘";
const OTHER = "需求评审";
const NEW = "周报整理";
const BAD_REQUEST = "请求格式不正确";
const CONFLICT = "会话状态冲突";
const SESSION_A = `/?session=${A}`;
const D = "d".repeat(32);

afterEach(cleanupSessionMeta);

/** 当前会话 A（`季度复盘`）与另一条 B；`extra` 给出 PATCH 路由。 */
function mountSelected(extra: Parameters<typeof mountSessions>[2] = {}, strict = false) {
  return mountSessions(SESSION_A, [view(A, OLD), view(B, OTHER)], extra, strict);
}

async function selectedList() {
  const nav = await findList(OLD);
  await crumb(OLD);
  return nav;
}

function bannerButtons() {
  return within(screen.getByRole("banner"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
}

async function dialogGone() {
  await waitFor(() => expect(renameDialog()).toBeNull());
}

/** A 的重命名已生效：顶栏与条目为新标题，没有轻提示。 */
async function expectRenamed(nav: HTMLElement) {
  expect(await crumb(NEW)).toBeTruthy();
  expect(entryTitles(nav)).toEqual([NEW, OTHER]);
  expectNoListToast();
}

/** 迟到的失败走列表区顶部提示：恰为 `请求格式不正确`，A 的标题不变，没有轻提示。 */
async function expectLateFailure(nav: HTMLElement) {
  await findListAlert(nav, BAD_REQUEST);
  expect(entryTitles(nav)).toEqual([OLD, OTHER]);
  expectNoListToast();
}

describe("条目「更多」菜单 (M1, M16)", () => {
  it("M1 每个条目恰一个同级「更多」按钮；菜单恰为 重命名 + 置顶任务|取消置顶 + 删除，任何状态可用", async () => {
    mountSessions("/", [
      view(A, OLD),
      view(B, OTHER, { pinnedAt: PINNED_AT }),
      view(C, "跑着的", { status: "running" }),
      view(D, null, { status: "idle" }),
    ]);
    const nav = await findList(OLD);

    const rows = Array.from(nav.querySelectorAll('ul[role="list"] > li'));
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const [select, more] = Array.from(row.children);
      expect(row.children).toHaveLength(2);
      expect(row.querySelectorAll("button")).toHaveLength(2);
      expect(select?.matches('button[data-slot="session-select"]')).toBe(true);
      expect(more?.tagName).toBe("BUTTON");
      expect(more?.getAttribute("aria-label")).toBe(
        `更多操作：${select?.getAttribute("aria-label")}`,
      );
      expect(more?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
      // Icon 注册表里 `more-horizontal` 对应 lucide 的 Ellipsis。
      expect(more?.querySelector("svg")?.getAttribute("class")).toContain("lucide-ellipsis");
    }
    // 无标题会话按回退标题命名。
    expect(within(nav).getAllByRole("button", { name: /^更多操作：/ })).toEqual([
      moreButton(nav, OTHER),
      moreButton(nav, OLD),
      moreButton(nav, "跑着的"),
      moreButton(nav, "新会话"),
    ]);

    for (const [title, second] of [
      [OLD, PIN],
      [OTHER, UNPIN],
      ["跑着的", PIN],
      ["新会话", PIN],
    ] as const) {
      const { items, menu } = await openEntryMenu(nav, title);
      expect(items.map((item) => item.textContent)).toEqual([
        "重命名",
        second,
        "归档",
        "删除",
        "导出记录",
      ]);
      expect(items.map((item) => item.querySelector("svg")?.getAttribute("class"))).toEqual([
        expect.stringContaining("lucide-pencil"),
        expect.stringContaining("lucide-star"),
        expect.stringContaining("lucide-archive"),
        expect.stringContaining("lucide-trash"),
        expect.stringContaining("lucide-download"),
      ]);
      // 只有 `归档` 会被禁用，且只在 running 的会话上；其余项对任何状态可用。
      const disabled = title === "跑着的" ? ["归档"] : [];
      expect(
        items.filter((item) => item.hasAttribute("aria-disabled")).map((item) => item.textContent),
      ).toEqual(disabled);
      expect(
        items.filter((item) => item.hasAttribute("data-disabled")).map((item) => item.textContent),
      ).toEqual(disabled);
      fireEvent.keyDown(menu, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    }
  });

  it("M16 保持项：点击选择按钮仍选择该会话（?session= 改变）", async () => {
    mountSessions("/", [view(A, OLD), view(B, OTHER)]);
    const nav = await findList(OLD);

    fireEvent.click(within(nav).getByRole("button", { name: OTHER }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${B}`));
    await crumb(OTHER);
    expect(within(nav).getByRole("button", { name: OTHER }).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("M16 「更多」按钮与菜单项不选择会话：?session= 不变、不读取该会话的历史", async () => {
    const { fetchMock } = mountSelected({
      [patchPath(B)]: () => jsonResponse(view(B, OTHER, { pinnedAt: PINNED_AT })),
    });
    const nav = await selectedList();
    const requests = fetchMock.mock.calls.length;

    const { trigger } = await openEntryMenu(nav, OTHER);
    fireEvent.click(trigger);
    expect(currentLocation()).toBe(SESSION_A);
    fireEvent.click(screen.getByRole("menuitem", { name: PIN }));
    await waitFor(() => expect(partitionTitles(nav, "置顶任务")).toEqual([OTHER]));
    expectNoListToast();

    expect(currentLocation()).toBe(SESSION_A);
    expect(within(nav).getByRole("button", { name: OLD }).getAttribute("aria-current")).toBe(
      "true",
    );
    expect(fetchMock.mock.calls.slice(requests).map(([path]) => path)).toEqual([patchPath(B)]);
  });

  it("M1 静态样式：「更多」按钮只在可悬停的宽屏上以透明度弱化，悬停、聚焦与菜单打开时显现，从不 display:none / visibility:hidden", async () => {
    mountSessions("/", [view(A, OLD)]);
    const nav = await findList(OLD);
    const more = moreButton(nav, OLD);
    const tokens = more.className.split(/\s+/);
    // 弱化只在「可悬停且 ≥761px」的媒体条件下；媒体条件之外（触屏、窄屏）没有 opacity 类。
    expect(tokens.filter((token) => token.endsWith("opacity-0"))).toEqual([
      "[@media(hover:hover)_and_(min-width:761px)]:opacity-0",
    ]);
    // 显现：条目（`group/session`）悬停、其内有焦点、菜单打开。
    expect(tokens.filter((token) => token.endsWith("opacity-100")).sort()).toEqual([
      "data-[state=open]:opacity-100",
      "group-focus-within/session:opacity-100",
      "group-hover/session:opacity-100",
    ]);
    expect(more.closest("li")?.classList.contains("group/session")).toBe(true);
    for (const token of tokens) {
      expect(token).not.toMatch(/(^|:)(hidden|invisible|collapse)$/);
    }
    // 菜单打开时触发按钮带 Radix 的 data-state="open"（显现类的挂点）。
    const { menu, trigger } = await openEntryMenu(nav, OLD);
    expect(trigger.getAttribute("data-state")).toBe("open");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("从条目菜单重命名 (M2, M3, M5)", () => {
  it.each([
    ["默认渲染", false],
    ["StrictMode", true],
  ] as const)(
    "M2 行菜单重命名成功（%s）：trim 后恰一次 PATCH {title}，条目与顶栏更新、无轻提示、焦点回「更多」按钮，不重读列表",
    async (_mode, strict) => {
      const { fetchMock } = mountSelected(
        { [patchPath(A)]: () => jsonResponse(view(A, NEW)) },
        strict,
      );
      const nav = await selectedList();
      const lists = calls(fetchMock, "/api/sessions").length;

      const controls = await openRename(nav, OLD);
      expect(controls.input.value).toBe(OLD);
      await focusOn(controls.input);
      saveTitle(controls, `  ${NEW}  `);
      await dialogGone();

      expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
      await expectRenamed(nav);
      expect(within(nav).getByRole("button", { name: NEW })).toBeTruthy();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      await focusOn(moreButton(nav, NEW));
      expect(moreButton(nav, NEW)).toBe(controls.trigger);
      expect(calls(fetchMock, "/api/sessions")).toHaveLength(lists);
    },
  );

  it("M3 全空白时 保存 禁用且 Enter 不发请求；无标题会话输入为空；有效文本 Enter 恰一次 PATCH", async () => {
    const { fetchMock } = mountSessions("/", [view(A, OLD), view(D, null, { status: "idle" })], {
      [patchPath(A)]: () => jsonResponse(view(A, NEW)),
    });
    const nav = await findList(OLD);

    const untitled = await openRename(nav, "新会话");
    expect(untitled.input.value).toBe("");
    expect(untitled.save.disabled).toBe(true);
    fireEvent.submit(untitled.form);
    fireEvent.click(untitled.cancel);
    await dialogGone();
    await focusOn(untitled.trigger);

    const controls = await openRename(nav, OLD);
    expect(controls.save.disabled).toBe(false);
    typeTitle(controls, "   ");
    expect(controls.save.disabled).toBe(true);
    fireEvent.submit(controls.form);
    await act(settle);
    expect(renameDialog()).toBe(controls.dialog);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
    expect(calls(fetchMock, patchPath(D))).toEqual([]);

    // jsdom 不做隐式提交：Enter 的可测试输入是表单的 submit 事件。
    typeTitle(controls, NEW);
    expect(controls.save.disabled).toBe(false);
    fireEvent.submit(controls.form);
    await dialogGone();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    expect(entryTitles(nav)).toEqual([NEW, "新会话"]);
    expectNoListToast();
  });

  it("M5 400 信封：Dialog 保持打开并在其内 alert 显示 message，标题不变；再次 保存 时 alert 立即消失，随后成功", async () => {
    const retry = deferredResponse();
    const { fetchMock } = mountSelected({
      [patchPath(A)]: [envelope(400, BAD_REQUEST), retry.promise],
    });
    const nav = await selectedList();

    const controls = await openRename(nav, OLD);
    saveTitle(controls, NEW);
    const alert = await within(controls.dialog).findByRole("alert");
    expect(alert.textContent).toBe(BAD_REQUEST);
    expect(renameDialog()).toBe(controls.dialog);
    expect(controls.input.value).toBe(NEW);
    expect(controls.save.disabled).toBe(false);
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);
    expect(await crumb(OLD)).toBeTruthy();
    expect(toasts()).toEqual([]);

    fireEvent.click(controls.save);
    expect(within(controls.dialog).queryByRole("alert")).toBeNull();
    expect(controls.save.disabled).toBe(true);
    expect(patchRequests(fetchMock, A)).toHaveLength(2);

    await settleDeferredResponse(retry, jsonResponse(view(A, NEW)));
    await dialogGone();
    await expectRenamed(nav);
  });

  it("M5 非信封失败（500 非 JSON）：alert 为 请求失败，请稍后重试", async () => {
    mountSelected({ [patchPath(A)]: () => new Response("upstream exploded", { status: 500 }) });
    const nav = await selectedList();

    const controls = await openRename(nav, OLD);
    saveTitle(controls, NEW);
    expect((await within(controls.dialog).findByRole("alert")).textContent).toBe(REQUEST_FAILED);
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);
    expect(toasts()).toEqual([]);
  });

  it("M5 取消：Dialog 消失、不发请求、焦点回到打开它的「更多」按钮", async () => {
    const { fetchMock } = mountSelected();
    const nav = await selectedList();

    const controls = await openRename(nav, OLD);
    typeTitle(controls, NEW);
    fireEvent.click(controls.cancel);
    await dialogGone();

    await focusOn(controls.trigger);
    expect(controls.trigger).toBe(moreButton(nav, OLD));
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);
    expect(toasts()).toEqual([]);
  });
});

describe("重命名请求中 (M4)", () => {
  /** 当前会话 A 的重命名 PATCH 挂起；`close` 给出时随即以它关闭 Dialog。 */
  async function pendingRename(close?: (controls: RenameControls) => unknown) {
    const patch = deferredResponse();
    const { fetchMock } = mountSelected({ [patchPath(A)]: () => patch.promise });
    const nav = await selectedList();
    const controls = await openRename(nav, OLD);
    saveTitle(controls, NEW);
    expect(controls.save.disabled).toBe(true);
    if (close) {
      await close(controls);
      await dialogGone();
      await focusOn(controls.trigger);
    }
    return { controls, fetchMock, nav, patch };
  }

  /** A 的请求中关闭后打开 `title` 会话（A 自己或另一条 B）的重命名，并在输入框里键入 `草稿`。 */
  async function reopenedRename(title: string) {
    const pending = await pendingRename(({ cancel }) => fireEvent.click(cancel));
    const reopened = await openRename(pending.nav, title);
    expect(reopened.input.value).toBe(title);
    expect(reopened.save.disabled).toBe(false);
    expect(within(reopened.dialog).queryByRole("alert")).toBeNull();
    typeTitle(reopened, "草稿");
    return { ...pending, reopened };
  }

  it("M4 请求中 保存 禁用、再次提交不发第二个 PATCH；200 后关闭并更新", async () => {
    const { controls, fetchMock, nav, patch } = await pendingRename();

    fireEvent.submit(controls.form);
    fireEvent.click(controls.save);
    await act(settle);
    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    expect(renameDialog()).toBe(controls.dialog);
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);

    await settleDeferredResponse(patch, jsonResponse(view(A, NEW)));
    await dialogGone();
    await expectRenamed(nav);
    await focusOn(moreButton(nav, NEW));
    expect(patchRequests(fetchMock, A)).toHaveLength(1);
  });

  it("M4 请求中点 取消：Dialog 消失；迟到的 200 照常更新且无轻提示，Dialog 不重新出现", async () => {
    const { nav, patch } = await pendingRename(({ cancel }) => fireEvent.click(cancel));
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);
    expect(toasts()).toEqual([]);

    await settleDeferredResponse(patch, jsonResponse(view(A, NEW)));
    await expectRenamed(nav);
    await yieldMacrotask();
    expect(renameDialog()).toBeNull();
  });

  it("M4 请求中点 关闭：迟到的 400 信封改在列表区顶部提示显示 message，标题不变", async () => {
    const { nav, patch } = await pendingRename(({ dialog }) =>
      fireEvent.click(within(dialog).getByRole("button", { name: "关闭" })),
    );

    await settleDeferredResponse(patch, envelope(400, BAD_REQUEST));
    await expectLateFailure(nav);
    expect(await crumb(OLD)).toBeTruthy();
    expect(renameDialog()).toBeNull();
    // 页面上唯一的 alert 就是列表区顶部那一条。
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toEqual([BAD_REQUEST]);
  });

  /** 重开的 Dialog 不受旧请求结果影响：仍是同一元素、无 alert、已键入文本不变、`保存` 可用。 */
  async function expectReopenedIntact({ dialog, input, save }: RenameControls) {
    await yieldMacrotask();
    expect(renameDialog()).toBe(dialog);
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(input.value).toBe("草稿");
    expect(save.disabled).toBe(false);
  }

  /** 关闭后再打开的是同一会话，或另一会话：迟到的结果都只属于发起它的那次打开。 */
  const REOPENED = [
    ["同一会话", OLD],
    ["另一会话", OTHER],
  ] as const;

  it.each(REOPENED)(
    "M4 请求中关闭后重开（%s）：旧请求的 200 更新条目与顶栏且无轻提示，重开的 Dialog 仍在、已键入文本不变、无 alert",
    async (_which, title) => {
      const { nav, patch, reopened } = await reopenedRename(title);

      await settleDeferredResponse(patch, jsonResponse(view(A, NEW)));
      await expectRenamed(nav);
      await expectReopenedIntact(reopened);
    },
  );

  it.each(REOPENED)(
    "M4 请求中关闭后重开（%s）：旧请求的 400 走列表区顶部提示，重开的 Dialog 内无 alert、保存 仍可用",
    async (_which, title) => {
      const { fetchMock, nav, patch, reopened } = await reopenedRename(title);

      await settleDeferredResponse(patch, envelope(400, BAD_REQUEST));
      await expectLateFailure(nav);
      await expectReopenedIntact(reopened);
      expect(patchRequests(fetchMock, A)).toHaveLength(1);
    },
  );

  it("M4 请求中点遮罩（完整指针序列）也能关闭 Dialog；迟到的 200 照常更新且无轻提示", async () => {
    const { nav, patch } = await pendingRename(async () => {
      // DismissableLayer 的 document pointerdown 监听在挂载后的 setTimeout(0) 里才注册。
      await yieldMacrotask();
      const mask = document.querySelector('[data-slot="dialog-overlay"]');
      if (!mask) throw new Error("缺遮罩");
      pressPointer(mask);
    });
    expect(entryTitles(nav)).toEqual([OLD, OTHER]);

    await settleDeferredResponse(patch, jsonResponse(view(A, NEW)));
    await expectRenamed(nav);
    await yieldMacrotask();
    expect(renameDialog()).toBeNull();
  });

  it("M4 请求中 Escape 也能关闭 Dialog，请求不取消", async () => {
    const { fetchMock, nav, patch } = await pendingRename(({ input }) =>
      fireEvent.keyDown(input, { key: "Escape" }),
    );
    expect(calls(fetchMock, patchPath(A)).at(0)?.[1]?.signal?.aborted).toBe(false);

    await settleDeferredResponse(patch, jsonResponse(view(A, NEW)));
    await expectRenamed(nav);
  });
});

describe("顶栏重命名入口 (M6, M7)", () => {
  it("M6 banner 内 heading 之后有 重命名、无 更多；打开同一 Dialog，成功后 heading 更新、焦点回顶栏按钮", async () => {
    const { fetchMock } = mountSelected({ [patchPath(A)]: () => jsonResponse(view(A, NEW)) });
    const nav = await selectedList();

    const banner = screen.getByRole("banner");
    const heading = within(banner).getByRole("heading", { level: 1, name: `我的工作 / ${OLD}` });
    const rename = within(banner).getByRole("button", { name: "重命名" });
    expect(heading.compareDocumentPosition(rename) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(heading.contains(rename)).toBe(false);
    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);
    expect(within(banner).queryByRole("button", { name: "更多" })).toBeNull();
    expect(rename.querySelector("svg")?.getAttribute("class")).toContain("lucide-pencil");

    const controls = await openTopbarRename();
    expect(controls.trigger).toBe(rename);
    expect(controls.input.value).toBe(OLD);
    await focusOn(controls.input);
    saveTitle(controls, NEW);
    await dialogGone();

    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    expect(within(banner).getByRole("heading", { level: 1, name: `我的工作 / ${NEW}` })).toBe(
      screen.getByRole("heading", { level: 1 }),
    );
    await expectRenamed(nav);
    await focusOn(within(banner).getByRole("button", { name: "重命名" }));
    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);
  });

  it("M6 切换会话后顶栏 重命名 作用于当前会话：输入初值为 B 的标题，PATCH 发往 B", async () => {
    const { fetchMock } = mountSelected({ [patchPath(B)]: () => jsonResponse(view(B, NEW)) });
    const nav = await selectedList();
    fireEvent.click(within(nav).getByRole("button", { name: OTHER }));
    await crumb(OTHER);

    const controls = await openTopbarRename();
    expect(controls.input.value).toBe(OTHER);
    saveTitle(controls, NEW);
    await dialogGone();

    expect(patchRequests(fetchMock, B)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    expect(calls(fetchMock, patchPath(A))).toEqual([]);
    expect(await crumb(NEW)).toBeTruthy();
    expect(entryTitles(nav)).toEqual([OLD, NEW]);
    expectNoListToast();
  });

  it("M6 顶栏入口失败同 M5：400 信封在 Dialog 内 alert，heading 不变", async () => {
    mountSelected({ [patchPath(A)]: () => envelope(400, BAD_REQUEST) });
    await selectedList();

    const controls = await openTopbarRename();
    saveTitle(controls, NEW);
    expect((await within(controls.dialog).findByRole("alert")).textContent).toBe(BAD_REQUEST);
    expect(renameDialog()).toBe(controls.dialog);
    expect(await crumb(OLD)).toBeTruthy();
    expect(toasts()).toEqual([]);

    fireEvent.click(controls.cancel);
    await dialogGone();
    await focusOn(controls.trigger);
  });

  it("M6 欢迎态不上报 actions：≥761px 离开会话后无 banner 与 重命名", async () => {
    const { router } = mountSelected();
    await selectedList();
    expect(bannerButtons()).toEqual(["重命名", "对话内搜索", "产物面板"]);

    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
  });

  it("M6 欢迎态不上报 actions：≤760px 会话态为 打开导航 + 重命名，欢迎态只剩 打开导航", async () => {
    installNarrowViewport();
    const { router } = mountSelected();
    await crumb(OLD);
    expect(bannerButtons()).toEqual(["打开导航", "重命名", "对话内搜索", "产物面板"]);

    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });
    expect(bannerButtons()).toEqual(["打开导航"]);
    expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
  });

  it("M7 列表读取 503 而快照就绪：顶栏 重命名 成功后 heading 以响应标题更新（快照路径）", async () => {
    const { fetchMock } = mountSelected({
      "/api/sessions": () =>
        jsonResponse({ error: { code: "unavailable", message: "会话列表不可用" } }, 503),
      [patchPath(A)]: () => jsonResponse(view(A, NEW)),
    });
    await crumb(OLD);
    const nav = await screen.findByRole("navigation", { name: "会话列表" });
    expect((await within(nav).findByRole("alert")).textContent).toBe("会话列表不可用");
    expect(entryTitles(nav)).toEqual([]);

    const controls = await openTopbarRename();
    expect(controls.input.value).toBe(OLD);
    saveTitle(controls, NEW);
    await dialogGone();

    expect(await crumb(NEW)).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expectNoListToast();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);
    expect(calls(fetchMock, "/api/sessions")).toHaveLength(1);
  });
});

describe("fence：账号切换与卸载 (M13)", () => {
  it("M13 重命名 PATCH 挂起时续期为另一 client：旧响应到达后无提示、新账号的列表不变、没有 Dialog；新账号的重命名是全新 Dialog 并发往新 client", async () => {
    const patch = deferredResponse();
    const { fetchMock, nav, renew } = await mountTwoAccounts([
      patch.promise,
      jsonResponse(view(A, "乙改的名字")),
    ]);
    saveTitle(await openRename(nav, FIRST_ACCOUNT_TASK), "甲改的名字");
    expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"title":"甲改的名字"}')]);

    const list = await renew();
    await dialogGone();
    expect(screen.queryByRole("dialog")).toBeNull();

    await settleDeferredResponse(patch, jsonResponse(view(A, "甲改的名字")));
    await yieldMacrotask();
    expectNoListToast();
    expect(listAlert(list)).toBeNull();
    expect(entryTitles(list)).toEqual([SECOND_ACCOUNT_TASK]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(patchRequests(fetchMock, A)).toHaveLength(1);

    // 上一账号那次打开停在忙碌态；新账号看到的是全新状态，其请求不被 fence 当作旧 client 丢弃。
    const fresh = await openRename(list, SECOND_ACCOUNT_TASK);
    expect(fresh.input.value).toBe(SECOND_ACCOUNT_TASK);
    expect(fresh.save.disabled).toBe(false);
    expect(fresh.save.getAttribute("aria-busy")).toBeNull();
    expect(within(fresh.dialog).queryByRole("alert")).toBeNull();
    saveTitle(fresh, "乙改的名字");
    await dialogGone();
    expect(patchRequests(fetchMock, A)).toEqual([
      patchOf('{"title":"甲改的名字"}'),
      patchOf('{"title":"乙改的名字"}'),
    ]);
    expect(entryTitles(list)).toEqual(["乙改的名字"]);
    expectNoListToast();
  });

  it.each([
    ["200", () => jsonResponse(view(A, NEW))],
    ["400 信封", () => envelope(400, BAD_REQUEST)],
  ] as const)(
    "M13 PATCH 挂起时离开会话页：请求被 abort，迟到的 %s 不提示、不抛错、无 React 警告",
    async (_kind, response) => {
      const patch = deferredResponse();
      const { fetchMock, router } = mountSelected({ [patchPath(A)]: () => patch.promise });
      const nav = await selectedList();
      saveTitle(await openRename(nav, OLD), NEW);
      const signal = calls(fetchMock, patchPath(A)).at(0)?.[1]?.signal;
      expect(signal?.aborted).toBe(false);

      await leaveChatPage(router);
      expect(renameDialog()).toBeNull();
      expect(signal?.aborted).toBe(true);
      const consoleError = vi.spyOn(console, "error");

      await settleDeferredResponse(patch, response());
      await yieldMacrotask();
      expect(toasts()).toEqual([]);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
    },
  );
});

describe("≤760px 导航覆盖层 (M14)", () => {
  it("M14 覆盖层内「更多」→ 重命名 / 置顶任务 都不关闭 导航：Dialog 打开与保存后 导航 仍在，条目已更新", async () => {
    installNarrowViewport();
    const { fetchMock } = mountSelected({
      [patchPath(A)]: () => jsonResponse(view(A, NEW)),
      [patchPath(B)]: () => jsonResponse(view(B, OTHER, { pinnedAt: PINNED_AT })),
    });
    await crumb(OLD);
    const { nav, overlay } = await openNavOverlay(OLD);

    // 完整指针序列：菜单在 portal 里（覆盖层 DOM 之外），覆盖层的外点判定要真的跑到。
    // DismissableLayer 的 document pointerdown 监听在挂载后的 setTimeout(0) 里才注册。
    const { menu, trigger } = await openEntryMenu(nav, OLD);
    await yieldMacrotask();
    pressPointer(within(menu).getByRole("menuitem", { name: "重命名" }));
    const dialog = await screen.findByRole("dialog", { name: "重命名任务" });
    await yieldMacrotask();
    // Dialog 打开期间覆盖层元素自身被 hideOthers 标为 aria-hidden：其可访问名算作空串，按名称
    // 查不到（`hidden: true` 也一样），故按元素断言它仍在 DOM 中。
    expect(screen.getAllByRole("dialog", { hidden: true })).toEqual([overlay, dialog]);
    expect(overlay.isConnected).toBe(true);
    expect(trigger.isConnected).toBe(true);

    const input = within(dialog).getByRole("textbox", { name: "任务名称" });
    fireEvent.change(input, { target: { value: NEW } });
    pressPointer(within(dialog).getByRole("button", { name: "保存" }));
    await dialogGone();
    await yieldMacrotask();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    expect(entryTitles(nav)).toEqual([NEW, OTHER]);
    expect(within(nav).getByRole("button", { name: NEW })).toBeTruthy();
    expect(patchRequests(fetchMock, A)).toEqual([patchOf(`{"title":"${NEW}"}`)]);

    const pin = await openEntryMenu(nav, OTHER);
    await yieldMacrotask();
    pressPointer(within(pin.menu).getByRole("menuitem", { name: PIN }));
    await waitFor(() => expect(partitionTitles(nav, "置顶任务")).toEqual([OTHER]));
    expectNoListToast();
    await yieldMacrotask();
    expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    expect(partitionTitles(nav, "置顶任务")).toEqual([OTHER]);
    expect(partitionTitles(nav, "临时空间")).toEqual([NEW]);
    expect(currentLocation()).toBe(SESSION_A);
  });

  it.each([
    ["无提示", false],
    ["Dialog 打开后出现列表区顶部提示", true],
  ] as const)(
    "M14 覆盖层内重命名 Dialog 按 Escape（%s）：只关 Dialog，导航 仍是同一元素、焦点回该行「更多」按钮，随后 置顶任务 仍可用",
    async (_case, withAlert) => {
      installNarrowViewport();
      const pinOther = deferredResponse();
      const { fetchMock } = mountSelected({
        [patchPath(A)]: () => jsonResponse(view(A, OLD, { pinnedAt: PINNED_AT })),
        [patchPath(B)]: () => pinOther.promise,
      });
      await crumb(OLD);
      const { nav, overlay } = await openNavOverlay(OLD);
      const shown = withAlert ? CONFLICT : null;
      if (withAlert) await chooseEntryAction(nav, OTHER, PIN);

      const controls = await openRename(nav, OLD);
      await focusOn(controls.input);
      // 另一条的置顶在 Dialog 打开之后才失败：提示出现在 Dialog 背后的列表区顶部，Dialog 不受影响。
      if (withAlert) await settleDeferredResponse(pinOther, envelope(409, CONFLICT));
      await waitFor(() => expect(listAlert(nav)).toBe(shown));
      expect(within(controls.dialog).queryByRole("alert")).toBeNull();

      fireEvent.keyDown(controls.input, { key: "Escape" });
      await dialogGone();
      await focusOn(controls.trigger);
      await yieldMacrotask();
      expect(controls.trigger).toBe(moreButton(nav, OLD));
      // 按名称能查到：覆盖层仍是同一元素，且 hideOthers 加上的 aria-hidden 已撤掉。
      expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
      // 关闭 Dialog 不是列表动作：提示原样保留。
      expect(listAlert(nav)).toBe(shown);
      expect(calls(fetchMock, patchPath(A))).toEqual([]);

      await chooseEntryAction(nav, OLD, PIN);
      // 下一次列表动作发起即清除提示。
      expect(listAlert(nav)).toBeNull();
      await waitFor(() => expect(partitionTitles(nav, "置顶任务")).toContain(OLD));
      expectNoListToast();
      expect(patchRequests(fetchMock, A)).toEqual([patchOf('{"pinned":true}')]);
      expect(screen.getByRole("dialog", { name: "导航" })).toBe(overlay);
    },
  );
});
