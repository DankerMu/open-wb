// 能力栏的工作空间位（chat-web「输入框与能力栏」、session-sidebar「composer footer 工作空间选择」）：已选会话
// 是只读标签的四种文案（临时空间的判定在最前，不看工作空间列表），回到欢迎态后是可操作的选择器；欢迎态
// 能力栏不渲染权限、上传与专家控件。临时空间会话以其 workspaceId 取命令目录与项目配置。
// seam：整页挂载 + 假 API。期望文案取自规格条文。
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  C,
  cleanupSessionMeta,
  envelope,
  findList,
  messagesPath,
  mountSessions,
  type SessionView,
  view,
} from "./chat-page-session-meta-support.js";
import { cataloguePaths, commandsOf, type } from "./chat-page-slash-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  footerButton,
  HERO,
  leaveForWelcome,
  openExistingSession,
  openPicker,
  options,
  PROJECT_A,
  PROJECT_A_OPTION,
  queryFooterButton,
  SUPPORT,
  SUPPORT_OPTION,
  workspaceList,
} from "./chat-page-welcome-scene-support.js";
import { currentLocation, type FetchMock, jsonResponse, paths } from "./support.js";
import { pressPointer } from "./ui-support.js";

const D = "d".repeat(32);
const GONE = "9".repeat(32);
/** 临时空间的 id：不在任何一次 `GET /api/workspaces` 的返回里。 */
const TEMP = "7".repeat(32);
const CONFIG = "/api/project-config";

afterEach(cleanupSessionMeta);

/** 夹具的 `view` 把 `workspaceId` 钉成 null：绑定会话在这里放宽该键。 */
function bound(id: string, title: string, workspaceId: string) {
  return { ...view(id, title), workspaceId } as unknown as SessionView;
}

/** 四个会话：绑定 项目A、未绑定、绑定一个不在列表里的空间、用临时空间（同样不在列表里）。 */
function sessions(): SessionView[] {
  return [
    bound(A, "绑定会话", PROJECT_A.id),
    view(B, "未绑定会话"),
    bound(C, "空间已删", GONE),
    view(D, "临时会话", { temporaryWorkspace: true, workspaceId: TEMP }),
  ];
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
  it("绑定 / 未绑定 / 绑定的空间不在列表里 / 临时空间 → 四种只读文案；回欢迎态后是选择器，全程没有修改请求", async () => {
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
    await openExistingSession(nav, "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");

    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    const trigger = footerButton("任务启动于 未选择");
    expect(trigger.disabled).toBe(false);
    expect(workspaceSlot().contains(trigger)).toBe(true);
    expect(mutations(mounted.fetchMock)).toEqual([]);
  });

  it("点击只读标签：不出现弹层，没有新请求", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    await openExistingSession(await findList("绑定会话"), "绑定会话", A);
    await expectReadOnly("任务启动于 项目A");
    await quiesce();
    const before = paths(fetchMock);
    const text = within(workspaceSlot()).getByText("任务启动于 项目A", { exact: true });

    for (const target of [text, workspaceSlot()]) {
      pressPointer(target);
      fireEvent.keyDown(target, { key: "Enter" });
    }
    await quiesce();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(screen.queryByRole("textbox", { name: "搜索工作空间" })).toBeNull();
    expect(workspaceSlot().textContent).toBe("任务启动于 项目A");
    expect(paths(fetchMock)).toEqual(before);
  });

  it("工作空间列表读取失败：绑定会话显示 任务启动于 已绑定空间，未绑定会话仍是 任务启动于 未绑定，临时空间会话仍是 任务启动于 临时空间", async () => {
    mountSessions("/", sessions(), { "/api/workspaces": () => envelope(503, "服务暂不可用") });
    const nav = await findList("绑定会话");

    await openExistingSession(nav, "绑定会话", A);
    await expectReadOnly("任务启动于 已绑定空间");
    await openExistingSession(nav, "未绑定会话", B);
    await expectReadOnly("任务启动于 未绑定");
    await openExistingSession(nav, "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");
  });

  it("点击临时空间的只读标签：不出现弹层，没有新请求", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
    });
    await openExistingSession(await findList("临时会话"), "临时会话", D);
    await expectReadOnly("任务启动于 临时空间");
    await quiesce();
    const before = paths(fetchMock);

    pressPointer(within(workspaceSlot()).getByText("任务启动于 临时空间", { exact: true }));
    await quiesce();

    expect(screen.queryAllByRole("dialog", { hidden: true })).toEqual([]);
    expect(paths(fetchMock)).toEqual(before);
  });
});

describe("能力栏：临时空间会话", () => {
  it("未选择空间发送：创建请求不带 workspaceId，返回临时空间会话后标签是 任务启动于 临时空间，条目在 临时空间 分组", async () => {
    const created = `${CREATED_IDS[0]}`;
    const session = view(created, null, {
      status: "idle",
      temporaryWorkspace: true,
      workspaceId: TEMP,
    });
    let listed = false;
    const { fetchMock } = renderChatPage("/", {
      "/api/sessions": (_path, options) => {
        if (options?.method !== "POST") return jsonResponse({ sessions: listed ? [session] : [] });
        listed = true;
        return jsonResponse(session, 201);
      },
      "/api/workspaces": () => workspaceList(PROJECT_A, SUPPORT),
      [messagesPath(created)]: () =>
        jsonResponse({ session, messages: [], streamCursor: { epoch: 1, seq: 0 }, todo: null }),
      [`/api/sessions/${created}/prompt`]: () => new Promise<Response>(() => {}),
    });
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(footerButton("任务启动于 未选择").disabled).toBe(false);
    const dialog = await openPicker();
    await waitFor(() =>
      expect(options(dialog).map(([text]) => text)).toEqual([
        "未选择",
        PROJECT_A_OPTION,
        SUPPORT_OPTION,
      ]),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "选择工作空间" })).toBeNull());

    typeDraft("你好");
    clickSend();

    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"office"}')]);
    await expectReadOnly("任务启动于 临时空间");
    const group = await within(await findList("新会话")).findByRole("group", { name: "临时空间" });
    expect(within(group).getByRole("button", { name: "新会话" })).toBeTruthy();
  });

  it("临时空间会话以其 workspaceId 请求项目配置与命令目录（该 id 不在工作空间列表里）", async () => {
    const { fetchMock } = mountSessions("/", sessions(), {
      "/api/workspaces": () => workspaceList(PROJECT_A),
      [`${CONFIG}?workspaceId=${TEMP}`]: () => jsonResponse({ files: [] }),
      [commandsOf(TEMP)]: () => jsonResponse({ commands: [] }),
    });
    await openExistingSession(await findList("临时会话"), "临时会话", D);
    await waitFor(() => expect(composer().disabled).toBe(false));

    await type("/");

    const asked = (base: string) => paths(fetchMock).filter((path) => path.split("?")[0] === base);
    expect(asked(CONFIG)).toEqual([`${CONFIG}?workspaceId=${TEMP}`]);
    expect(cataloguePaths(fetchMock)).toEqual([commandsOf(TEMP)]);
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
