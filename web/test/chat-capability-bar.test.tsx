// 能力栏的工作空间位（chat-web「输入框与能力栏」、session-sidebar「composer footer 工作空间选择」）：已选会话
// 是只读标签的三种文案，回到欢迎态后是可操作的选择器；欢迎态能力栏不渲染权限、上传与专家控件。
// seam：整页挂载 + 假 API。期望文案取自规格条文。
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  C,
  cleanupSessionMeta,
  envelope,
  findList,
  mountSessions,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import {
  footerButton,
  HERO,
  leaveForWelcome,
  openExistingSession,
  PROJECT_A,
  queryFooterButton,
  workspaceList,
} from "./chat-page-welcome-scene-support.js";
import type { FetchMock } from "./support.js";

const GONE = "9".repeat(32);

afterEach(cleanupSessionMeta);

/** 夹具的 `view` 把 `workspaceId` 钉成 null：绑定会话在这里放宽该键。 */
function bound(id: string, title: string, workspaceId: string) {
  return { ...view(id, title), workspaceId } as unknown as SessionView;
}

/** 三个会话：绑定 项目A、未绑定、绑定一个不在列表里的空间。 */
function sessions(): SessionView[] {
  return [bound(A, "绑定会话", PROJECT_A.id), view(B, "未绑定会话"), bound(C, "空间已删", GONE)];
}

function workspaceSlot() {
  const slot = document.querySelector('form [data-slot="composer-workspace"]');
  if (!(slot instanceof HTMLElement)) throw new Error("能力栏没有工作空间位");
  return slot;
}

/** 只读标签：文本恰为 `text`，其内没有任何可操作元素，页面上也没有选择器按钮。 */
async function expectReadOnly(text: string) {
  await waitFor(() => expect(workspaceSlot().textContent).toBe(text));
  expect(within(workspaceSlot()).queryAllByRole("button")).toEqual([]);
  expect(workspaceSlot().querySelector("a, input, select, [tabindex]")).toBeNull();
  expect(queryFooterButton()).toBeNull();
  expect(screen.queryByRole("dialog", { name: "选择工作空间" })).toBeNull();
}

function mutations(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([, options]) => (options?.method ?? "GET") !== "GET");
}

describe("能力栏：已选会话工作空间只读", () => {
  it("绑定 / 未绑定 / 绑定的空间不在列表里 → 三种只读文案；回欢迎态后是选择器，全程没有修改请求", async () => {
    const mounted = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    const nav = await findList("绑定会话");

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    await openExistingSession(nav, "未绑定会话", B);
    await expectReadOnly("任务启动于 未绑定");
    await openExistingSession(nav, "空间已删", C);
    await expectReadOnly("任务启动于 已绑定空间");

    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    const trigger = footerButton("任务启动于 未选择");
    expect(trigger.disabled).toBe(false);
    expect(workspaceSlot().contains(trigger)).toBe(true);
    expect(mutations(mounted.fetchMock)).toEqual([]);
  });

  it("工作空间列表读取失败：绑定会话显示 任务启动于 已绑定空间，未绑定会话仍是 任务启动于 未绑定", async () => {
    mountSessions("/", sessions(), { "/api/workspaces": () => envelope(503, "服务暂不可用") });
    const nav = await findList("绑定会话");

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 已绑定空间");
    await openExistingSession(nav, "未绑定会话", B);
    await expectReadOnly("任务启动于 未绑定");
  });
});

describe("能力栏：欢迎态", () => {
  it("工作空间选择器在能力栏最左，发送键在其后；没有权限、上传与专家控件", async () => {
    mountSessions("/", []);
    await screen.findByRole("heading", { level: 1, name: HERO });
    const toolbar = composer().closest("form")?.querySelector('[data-slot="composer-toolbar"]');
    if (!(toolbar instanceof HTMLElement)) throw new Error("输入框没有工具栏");

    const buttons = within(toolbar).getAllByRole("button");
    expect(
      buttons.map((button) => button.getAttribute("aria-label") ?? button.textContent),
    ).toEqual(["任务启动于 未选择", "技能与命令", "发送"]);
    expect(toolbar.firstElementChild?.firstElementChild).toBe(workspaceSlot());
    for (const text of ["权限", "完全访问", "默认权限", "上传", "专家"]) {
      expect(toolbar.textContent).not.toContain(text);
    }
    expect(toolbar.querySelector('input[type="file"]')).toBeNull();
  });
});
