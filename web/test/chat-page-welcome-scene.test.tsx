import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WELCOME_QUICK_PROMPTS, WELCOME_SCENES } from "../src/features/chat/welcome-content.js";
import {
  clickSend,
  renderChatPageWithAuthProbe,
  renewAccount,
  settleDeferredResponse,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  cleanupSessionMeta,
  entryTitles,
  envelope,
  findList,
  focusOn,
  leaveChatPage,
  mountSessions,
  partitionTitles,
  REQUEST_FAILED,
  toasts,
  view,
} from "./chat-page-session-meta-support.js";
import {
  ALPHA,
  ALPHA_OPTION,
  CODE_LABELS,
  CREATE_REJECTED,
  CREATED_IDS,
  choose,
  composerForm,
  createOf,
  createRejected,
  createRequests,
  DESIGN_LABELS,
  expectToolbarEndsCard,
  follows,
  footerButton,
  HERO,
  LOADING,
  mountWelcome,
  NO_MATCH,
  OFFICE_LABELS,
  openExistingSession,
  openPicker,
  options,
  PROJECT_A,
  PROJECT_A_OPTION,
  pickerDialog,
  pickOption,
  pressedScenes,
  promptRequests,
  queryFooterButton,
  quickLabels,
  quickRow,
  ROOT_MARK,
  rereadByCreate,
  SEARCH,
  SUPPORT,
  SUPPORT_OPTION,
  sceneGroup,
  scenePills,
  search,
  searchBox,
  selectScene,
  UNSELECTED,
  welcomeRoutes,
  workspaceList,
  workspaceRequests,
  workspacesRead,
} from "./chat-page-welcome-scene-support.js";
import { settle } from "./chat-stream-support.js";
import { currentLocation, deferredResponse, type FetchMock } from "./support.js";
import {
  blockBody,
  readRepoFile,
  ruleBody,
  stripComments,
  topLevelBlocks,
  yieldMacrotask,
} from "./ui-support.js";

const UNSELECTED_BUTTON = "任务启动于 未选择";
const PROJECT_A_BUTTON = "任务启动于 项目A";
const OFFICE_BODY = '{"scene":"office"}';
const UNAVAILABLE = "服务暂不可用";
/** 续期后侧栏账号区的标记（`renewAccount` 登录为 `lisi`）。 */
const NEW_ACCOUNT = 'data-slot="sidebar-user-account">lisi</span>';

// 弹层的 FocusScope 在卸载后的宏任务里归还焦点，清理里先让出一轮。
afterEach(cleanupSessionMeta);

function pageText() {
  return document.body.textContent ?? "";
}

/** 整页标记（含属性与 portal 内容）：绝对根路径不得以任何形式进入 DOM。 */
function pageHtml() {
  return document.body.innerHTML;
}

/** 至今发出的请求总数（任意路径、任意方法）。 */
function requestCount(fetchMock: FetchMock) {
  return fetchMock.mock.calls.length;
}

function send(text: string) {
  typeDraft(text);
  clickSend();
}

function unavailable() {
  return envelope(503, UNAVAILABLE);
}

describe("场景胶囊 (W1–W4)", () => {
  it("W1 胶囊渲染：hero 之后、快捷任务之前的 场景 组，三个按钮带各自图标，日常办公 选中，快捷任务为日常办公六项", async () => {
    await mountWelcome();
    const group = sceneGroup();
    if (!group) throw new Error("未渲染 场景 组");
    expect(follows(screen.getByRole("heading", { level: 1, name: HERO }), group)).toBe(true);
    expect(follows(group, quickRow())).toBe(true);

    const pills = scenePills();
    expect(pills.map((pill) => pill.textContent)).toEqual(["日常办公", "代码开发", "创意设计"]);
    expect(pills.map((pill) => pill.type)).toEqual(["button", "button", "button"]);
    const icons = ["lucide-file-text", "lucide-code", "lucide-palette"];
    expect(
      pills.map((pill, index) => pill.querySelector("svg")?.classList.contains(icons[index] ?? "")),
    ).toEqual([true, true, true]);
    expect(pressedScenes()).toEqual(["true", "false", "false"]);
    expect(quickLabels()).toEqual(OFFICE_LABELS);
  });

  it("W2 切换到 代码开发（X7 不发任何请求）：选中态与快捷任务替换、一条 info Toast；点 网站开发 只填草稿不发送；再点已选场景无变化", async () => {
    const { fetchMock } = await mountWelcome();
    await workspacesRead(fetchMock, 1);
    const requests = requestCount(fetchMock);
    const expectCodeSceneWithOneToast = () => {
      expect(pressedScenes()).toEqual(["false", "true", "false"]);
      expect(quickLabels()).toEqual(CODE_LABELS);
      expect(toasts()).toEqual(["已切换到「代码开发」场景"]);
    };
    selectScene("代码开发");
    expectCodeSceneWithOneToast();
    const shown = Array.from(document.querySelectorAll(".ui-toast"));
    expect(shown.map((toast) => toast.classList.contains("ui-toast--info"))).toEqual([true]);
    await act(settle);
    expect(requestCount(fetchMock)).toBe(requests);

    fireEvent.click(within(quickRow()).getByRole("button", { name: "网站开发" }));
    await act(settle);
    expect(composer().value).toBe("帮我搭建一个内部系统首页");
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === "POST")).toEqual([]);
    expect(currentLocation()).toBe("/");

    selectScene("代码开发");
    expectCodeSceneWithOneToast();
    await act(settle);
    expect(requestCount(fetchMock)).toBe(requests);
  });

  it("W2 切换到 创意设计（X7 不发任何请求）：五项快捷任务与对应 Toast", async () => {
    const { fetchMock } = await mountWelcome();
    await workspacesRead(fetchMock, 1);
    const requests = requestCount(fetchMock);
    selectScene("创意设计");
    expect(pressedScenes()).toEqual(["false", "false", "true"]);
    expect(quickLabels()).toEqual(DESIGN_LABELS);
    expect(toasts()).toEqual(["已切换到「创意设计」场景"]);
    await act(settle);
    expect(requestCount(fetchMock)).toBe(requests);
  });

  it("W3 静态清单：三组场景的值、文案与图标；office 引用既有清单；code 与 design 各五项", () => {
    expect(WELCOME_SCENES.map(({ value, label, icon }) => ({ value, label, icon }))).toEqual([
      { value: "office", label: "日常办公", icon: "file-text" },
      { value: "code", label: "代码开发", icon: "code" },
      { value: "design", label: "创意设计", icon: "palette" },
    ]);
    expect(WELCOME_SCENES[0]?.prompts).toBe(WELCOME_QUICK_PROMPTS);
    expect(WELCOME_SCENES[1]?.prompts).toEqual([
      { label: "日常开发", icon: "code", prompt: "帮我实现一个带校验的登录组件" },
      { label: "网站开发", icon: "layout-grid", prompt: "帮我搭建一个内部系统首页" },
      { label: "Agent 应用", icon: "file-code", prompt: "帮我设计一个 Agent 应用的交互流程" },
      { label: "Skill 开发", icon: "file-code", prompt: "帮我写一个数据处理 Skill" },
      { label: "CI/CD", icon: "code", prompt: "帮我生成一条 CI 流水线配置" },
    ]);
    expect(WELCOME_SCENES[2]?.prompts).toEqual([
      { label: "网站设计", icon: "palette", prompt: "帮我设计一个内部系统首页" },
      { label: "PPT 设计", icon: "file-text", prompt: "帮我美化这份 PPT 的配色与排版" },
      { label: "视觉海报", icon: "image", prompt: "帮我设计一张科技感的产品发布海报" },
      { label: "移动端 App", icon: "image", prompt: "帮我设计一个移动端打卡界面" },
      { label: "设计系统", icon: "palette", prompt: "帮我整理一套设计系统规范" },
    ]);
  });

  it("W4 场景随创建请求发送：选 创意设计 后发送，恰一个 POST，body 为 design 的 JSON", async () => {
    const { fetchMock } = await mountWelcome();
    selectScene("创意设计");
    send("你好");
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"design"}')]);
  });

  it("W4 默认场景下点侧栏 新建会话：body 为 office 的 JSON", async () => {
    const { fetchMock } = await mountWelcome();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([createOf(OFFICE_BODY)]);
  });
});

describe("composer footer 空间选择 (W5–W9)", () => {
  it("W5 选择空间后创建绑定会话（X7、X9）：footer 在卡片末尾，按钮为 type=button 带 folder 图标，弹层列出逻辑路径且不发请求，过滤、选择、焦点、再打开、绑定创建与侧栏归组", async () => {
    const { fetchMock } = await mountWelcome();
    await workspacesRead(fetchMock, 1);
    const requests = requestCount(fetchMock);
    const trigger = footerButton(UNSELECTED_BUTTON);
    expect(trigger.type).toBe("button");
    expect(trigger.querySelector("svg")?.classList.contains("lucide-folder")).toBe(true);
    const card = trigger.closest(".chat-composer-card");
    expect(card?.lastElementChild?.contains(trigger)).toBe(true);
    expect(card?.lastElementChild?.previousElementSibling).toBe(
      card?.querySelector(".chat-composer-toolbar"),
    );

    const dialog = await openPicker();
    expect(searchBox(dialog).placeholder).toBe(SEARCH);
    expect(searchBox(dialog).value).toBe("");
    expect(options(dialog)).toEqual([
      [UNSELECTED, "true"],
      [PROJECT_A_OPTION, "false"],
      [SUPPORT_OPTION, "false"],
    ]);
    await act(settle);
    expect(workspaceRequests(fetchMock)).toBe(1);
    expect(requestCount(fetchMock)).toBe(requests);
    expect(pageHtml()).not.toContain(ROOT_MARK);

    search(dialog, "项目");
    expect(options(dialog)).toEqual([
      [UNSELECTED, "true"],
      [PROJECT_A_OPTION, "false"],
    ]);
    await choose(dialog, PROJECT_A_OPTION);
    await focusOn(footerButton(PROJECT_A_BUTTON));

    const reopened = await openPicker();
    expect(searchBox(reopened).value).toBe("");
    expect(options(reopened)).toEqual([
      [UNSELECTED, "false"],
      [PROJECT_A_OPTION, "true"],
      [SUPPORT_OPTION, "false"],
    ]);
    await choose(reopened, PROJECT_A_OPTION);
    await act(settle);
    expect(workspaceRequests(fetchMock)).toBe(1);
    expect(requestCount(fetchMock)).toBe(requests);

    send("你好");
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${PROJECT_A.id}"}`),
    ]);
    const nav = await findList("新会话");
    await waitFor(() => expect(partitionTitles(nav, "空间 (1)")).toEqual(["新会话"]));
    expect(partitionTitles(nav, "项目A")).toEqual(["新会话"]);
    expect(entryTitles(nav)).toEqual(["新会话"]);
    await waitFor(() => expect(queryFooterButton()).toBeNull());
    expect(sceneGroup()).toBeNull();
    expect(pageHtml()).not.toContain(ROOT_MARK);
  });

  it("W6 无权限元素与无匹配：footer 只有一个按钮；搜索无匹配只剩 未选择 与提示；按名称过滤（去首尾空白、不分大小写、不匹配逻辑路径）", async () => {
    const { fetchMock } = await mountWelcome({
      workspaces: () => workspaceList(PROJECT_A, SUPPORT, ALPHA),
    });
    await workspacesRead(fetchMock, 1);
    const picker = document.querySelector(".chat-workspace-picker");
    if (!(picker instanceof HTMLElement)) throw new Error("未渲染 footer");
    expect(within(picker).getAllByRole("button")).toEqual([footerButton(UNSELECTED_BUTTON)]);

    const dialog = await openPicker();
    const none = [[UNSELECTED, "true"]];
    const forbidden = ["权限", "完全访问", "默认权限", "新建工作空间", "挂载目录到当前空间"];
    for (const text of forbidden) expect(pageText()).not.toContain(text);
    expect(within(dialog).queryByText(NO_MATCH, { exact: true })).toBeNull();

    search(dialog, "不存在");
    expect(options(dialog)).toEqual(none);
    expect(within(dialog).getByText(NO_MATCH, { exact: true })).toBeTruthy();
    for (const text of forbidden) expect(pageText()).not.toContain(text);

    for (const query of ["alp", "  ALPHA "]) {
      search(dialog, query);
      expect(options(dialog)).toEqual([...none, [ALPHA_OPTION, "false"]]);
      expect(within(dialog).queryByText(NO_MATCH, { exact: true })).toBeNull();
    }
    // 逻辑路径 zhangsan/misc、zhangsan/kefu 里才有的片段不算匹配。
    for (const query of ["misc", "kefu", "zhangsan"]) {
      search(dialog, query);
      expect(options(dialog)).toEqual(none);
      expect(within(dialog).getByText(NO_MATCH, { exact: true })).toBeTruthy();
    }
  });

  it("W7 读取中（X4 三态互斥）：弹层显示 正在读取工作空间 与可选的 未选择，没有无匹配提示与 alert；选择后弹层关闭、按钮不变", async () => {
    await mountWelcome({ workspaces: () => deferredResponse().promise });
    const dialog = await openPicker();
    expect(within(dialog).getByText(LOADING, { exact: true })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(dialog.textContent).not.toContain(NO_MATCH);
    expect(options(dialog)).toEqual([[UNSELECTED, "true"]]);

    await choose(dialog, UNSELECTED);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);
  });

  it("W7 读取失败（X4 三态互斥）：alert 恰为信封 message，没有无匹配与读取中提示；失败后的重读在途显示 正在读取工作空间 且无 alert；重读成功后显示列表", async () => {
    const second = deferredResponse();
    const mounted = await mountWelcome({ workspaces: [unavailable(), second.promise] });
    const failed = await openPicker();
    expect((await within(failed).findByRole("alert")).textContent).toBe(UNAVAILABLE);
    expect(within(failed).queryByText(LOADING, { exact: true })).toBeNull();
    expect(failed.textContent).not.toContain(NO_MATCH);
    expect(options(failed)).toEqual([[UNSELECTED, "true"]]);
    await choose(failed, UNSELECTED);

    await rereadByCreate(mounted, 2);
    const rereading = await openPicker();
    expect(within(rereading).getByText(LOADING, { exact: true })).toBeTruthy();
    expect(within(rereading).queryByRole("alert")).toBeNull();
    expect(rereading.textContent).not.toContain(NO_MATCH);
    expect(pageText()).not.toContain(UNAVAILABLE);

    await settleDeferredResponse(second, workspaceList(PROJECT_A, SUPPORT));
    expect(options(rereading)).toEqual([
      [UNSELECTED, "true"],
      [PROJECT_A_OPTION, "false"],
      [SUPPORT_OPTION, "false"],
    ]);
    expect(within(rereading).queryByRole("alert")).toBeNull();
    expect(within(rereading).queryByText(LOADING, { exact: true })).toBeNull();
  });

  it("W7 非信封失败（X4 三态互斥）：alert 为 请求失败，请稍后重试，没有无匹配与读取中提示，未选择 仍在", async () => {
    await mountWelcome({ workspaces: () => new Response("oops", { status: 500 }) });
    const dialog = await openPicker();
    expect((await within(dialog).findByRole("alert")).textContent).toBe(REQUEST_FAILED);
    expect(dialog.textContent).not.toContain(LOADING);
    expect(dialog.textContent).not.toContain(NO_MATCH);
    expect(options(dialog)).toEqual([[UNSELECTED, "true"]]);
  });

  it("W8 改回未选择：按钮回到 任务启动于 未选择，发送的 body 没有 workspaceId 键", async () => {
    const { fetchMock } = await mountWelcome();
    await pickOption(PROJECT_A_OPTION);
    expect(footerButton().textContent).toBe(PROJECT_A_BUTTON);
    await pickOption(UNSELECTED);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);

    send("你好");
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([createOf(OFFICE_BODY)]);
  });

  it("W9 两条路径一致：选 代码开发 与 项目A 后点侧栏 新建会话，body 带同样的 scene 与 workspaceId", async () => {
    const { fetchMock } = await mountWelcome();
    selectScene("代码开发");
    await pickOption(PROJECT_A_OPTION);
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    expect(createRequests(fetchMock)).toEqual([
      createOf(`{"scene":"code","workspaceId":"${PROJECT_A.id}"}`),
    ]);
  });
});

describe("锁定、会话页与状态生命周期 (W10–W14)", () => {
  it("W10 锁定：创建请求挂起期间三个胶囊与 footer 按钮均禁用", async () => {
    const pending = deferredResponse();
    await mountWelcome({ create: () => pending.promise });
    expect(scenePills().map((pill) => pill.disabled)).toEqual([false, false, false]);
    expect(footerButton().disabled).toBe(false);

    send("你好");
    await waitFor(() => expect(composer().disabled).toBe(true));
    expect(scenePills().map((pill) => pill.disabled)).toEqual([true, true, true]);
    expect(footerButton().disabled).toBe(true);
  });

  it("W10 锁定时已打开的弹层关闭；创建失败解锁后按钮可用而弹层不重开", async () => {
    const pending = deferredResponse();
    await mountWelcome({ create: () => pending.promise });
    const dialog = await openPicker();
    await waitFor(() => expect(options(dialog)).toHaveLength(3));

    typeDraft("你好");
    fireEvent.submit(composerForm());
    await waitFor(() => expect(pickerDialog()).toBeNull());
    expect(composer().disabled).toBe(true);
    expect(footerButton().disabled).toBe(true);

    await settleDeferredResponse(pending, createRejected());
    await waitFor(() => expect(footerButton().disabled).toBe(false));
    expect(composer().value).toBe("你好");
    expect(pickerDialog()).toBeNull();
    await yieldMacrotask();
    expect(pickerDialog()).toBeNull();
    expect(footerButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("W11 会话页（X9 卡片须存在）：欢迎态有 场景 组与 footer，选中会话后两者都不渲染、卡片末元素是工具栏", async () => {
    mountSessions("/", [view(A, "既有会话")]);
    const nav = await findList("既有会话");
    expect(scenePills()).toHaveLength(3);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);

    await openExistingSession(nav, "既有会话", A);
    expectToolbarEndsCard();
  });

  it("W11（保持项，X9 卡片须存在）深链会话页：没有 场景 组与 任务启动于 按钮，卡片末元素是工具栏", async () => {
    mountSessions(`/?session=${A}`, [view(A, "既有会话")]);
    await findList("既有会话");
    await screen.findByText("回答", { exact: true });
    expect(sceneGroup()).toBeNull();
    expect(queryFooterButton()).toBeNull();
    expect(document.querySelector(".chat-workspace-picker")).toBeNull();
    expectToolbarEndsCard();
  });

  /** 一个既有会话 + 两个空间；选 代码开发 与 项目A。 */
  async function mountWithSelection() {
    const mounted = mountSessions("/", [view(A, "既有会话")], {
      "/api/workspaces": () => workspaceList(PROJECT_A, SUPPORT),
    });
    const nav = await findList("既有会话");
    selectScene("代码开发");
    await pickOption(PROJECT_A_OPTION);
    return { ...mounted, nav };
  }

  it("W12 状态保留：选中既有会话再回到欢迎态，场景、空间与快捷任务清单都还在", async () => {
    const { nav, router } = await mountWithSelection();
    fireEvent.click(within(nav).getByRole("button", { name: "既有会话" }));
    await waitFor(() => expect(sceneGroup()).toBeNull());
    expect(queryFooterButton()).toBeNull();

    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(pressedScenes()).toEqual(["false", "true", "false"]);
    expect(footerButton().textContent).toBe(PROJECT_A_BUTTON);
    expect(quickLabels()).toEqual(CODE_LABELS);
  });

  it("W12 状态复位：离开会话页再回来，日常办公 选中、任务启动于 未选择", async () => {
    const { fetchMock, router } = await mountWithSelection();
    await leaveChatPage(router);
    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await workspacesRead(fetchMock, 2);
    expect(pressedScenes()).toEqual(["true", "false", "false"]);
    expect(quickLabels()).toEqual(OFFICE_LABELS);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);
  });

  it("W13 重读后空间已不存在：按钮回到 未选择，发送的 body 不带 workspaceId", async () => {
    const mounted = await mountWelcome({
      workspaces: [
        workspaceList(PROJECT_A, SUPPORT),
        workspaceList(SUPPORT),
        workspaceList(SUPPORT),
      ],
    });
    await pickOption(PROJECT_A_OPTION);
    await rereadByCreate(mounted, 2);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);

    send("你好");
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[1]}`));
    expect(createRequests(mounted.fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${PROJECT_A.id}"}`),
      createOf(OFFICE_BODY),
    ]);
  });

  it("W13 重读失败：按钮为 未选择、body 不带 workspaceId；再一次成功读取含该空间后按钮恢复", async () => {
    const mounted = await mountWelcome({
      workspaces: [
        workspaceList(PROJECT_A, SUPPORT),
        unavailable(),
        workspaceList(SUPPORT, PROJECT_A),
      ],
    });
    await pickOption(PROJECT_A_OPTION);
    await rereadByCreate(mounted, 2);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);

    await rereadByCreate(mounted, 3);
    expect(createRequests(mounted.fetchMock)).toEqual([
      createOf(`{"scene":"office","workspaceId":"${PROJECT_A.id}"}`),
      createOf(OFFICE_BODY),
    ]);
    expect(footerButton().textContent).toBe(PROJECT_A_BUTTON);
  });

  it("W13 账号切换（X2 不改选直接发送）：新账号列表挂起时按钮立即为 未选择、不露出上一账号的空间；列表到达后直接发送的 body 不带 workspaceId", async () => {
    const pending = deferredResponse();
    let renewed = false;
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(
      "/",
      welcomeRoutes({
        workspaces: () => (renewed ? pending.promise : workspaceList(PROJECT_A, SUPPORT)),
      }),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });
    await pickOption(PROJECT_A_OPTION);
    expect(footerButton().textContent).toBe(PROJECT_A_BUTTON);

    renewed = true;
    await renewAccount(getProbe);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);
    expect(pageText()).not.toContain("项目A");
    const dialog = await openPicker();
    expect(within(dialog).getByText(LOADING, { exact: true })).toBeTruthy();
    expect(options(dialog)).toEqual([[UNSELECTED, "true"]]);
    expect(pageText()).not.toContain("项目A");

    await settleDeferredResponse(pending, workspaceList(ALPHA));
    expect(options(dialog)).toEqual([
      [UNSELECTED, "true"],
      ["Alphalisi/misc", "false"],
    ]);
    expect(footerButton().textContent).toBe(UNSELECTED_BUTTON);

    send("你好");
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(1));
    expect(createRequests(fetchMock)).toEqual([createOf(OFFICE_BODY)]);
  });

  it("W14 创建失败后选择保留：错误提示与草稿恢复照旧，场景与空间不变，再次发送的 body 相同", async () => {
    const { fetchMock } = await mountWelcome({ create: createRejected });
    selectScene("创意设计");
    await pickOption(PROJECT_A_OPTION);
    const body = createOf(`{"scene":"design","workspaceId":"${PROJECT_A.id}"}`);

    send("你好");
    expect((await screen.findByRole("alert")).textContent).toBe(CREATE_REJECTED);
    await waitFor(() => expect(composer().value).toBe("你好"));
    expect(currentLocation()).toBe("/");
    expect(pressedScenes()).toEqual(["false", "false", "true"]);
    expect(quickLabels()).toEqual(DESIGN_LABELS);
    expect(footerButton().textContent).toBe(PROJECT_A_BUTTON);
    expect(createRequests(fetchMock)).toEqual([body]);

    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(2));
    expect(createRequests(fetchMock)).toEqual([body, body]);
  });
});

describe("评审后补充 (X1、X3、X5、X6)", () => {
  const CODE_WITH_PROJECT_A = createOf(`{"scene":"code","workspaceId":"${PROJECT_A.id}"}`);

  /**
   * 一个既有会话 + 欢迎态夹具：选 代码开发 与 项目A，从侧栏选中既有会话（胶囊与 footer 卸载），
   * 再在会话页点侧栏 新建会话 并等它被选中。
   */
  async function createFromSessionPage(workspaces?: Response[]) {
    const mounted = await mountWelcome({
      existing: [view(A, "既有会话")],
      ...(workspaces ? { workspaces } : {}),
    });
    const nav = await findList("既有会话");
    selectScene("代码开发");
    await pickOption(PROJECT_A_OPTION);
    await openExistingSession(nav, "既有会话", A);

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[0]}`));
    return mounted;
  }

  it("X1 会话页创建：选 代码开发 与 项目A 后选中既有会话，再点侧栏 新建会话，body 带同样的 scene 与 workspaceId", async () => {
    const { fetchMock } = await createFromSessionPage();
    expect(createRequests(fetchMock)).toEqual([CODE_WITH_PROJECT_A]);
  });

  it("X1 变体：创建后的工作空间重读失败，在会话页再点 新建会话，body 只剩 scene", async () => {
    const { fetchMock } = await createFromSessionPage([
      workspaceList(PROJECT_A, SUPPORT),
      unavailable(),
      workspaceList(PROJECT_A, SUPPORT),
    ]);
    await workspacesRead(fetchMock, 2);
    expect(sceneGroup()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${CREATED_IDS[1]}`));
    expect(createRequests(fetchMock)).toEqual([CODE_WITH_PROJECT_A, createOf('{"scene":"code"}')]);
  });

  it("X3 搜索框回车：有草稿时在 搜索工作空间 上按 Enter 不提交 composer，弹层仍在、草稿不变；弹层不在表单内", async () => {
    const { fetchMock } = await mountWelcome();
    typeDraft("你好");
    const dialog = await openPicker();
    await waitFor(() => expect(options(dialog)).toHaveLength(3));
    const box = searchBox(dialog);
    expect(composerForm().contains(dialog)).toBe(false);
    expect(box.form).toBeNull();

    fireEvent.keyDown(box, { code: "Enter", key: "Enter" });
    await act(settle);
    expect(fetchMock.mock.calls.filter(([, request]) => request?.method === "POST")).toEqual([]);
    expect(pickerDialog()).toBe(dialog);
    expect(composer().value).toBe("你好");
    expect(composer().disabled).toBe(false);
    expect(currentLocation()).toBe("/");
  });

  it("X5 上一账号的读取失败不带到新账号：续期后新账号读取挂起，弹层为 正在读取工作空间、无 alert；换账号的那次提交起就不再显示", async () => {
    let renewed = false;
    const commits: string[] = [];
    const { getProbe } = renderChatPageWithAuthProbe(
      "/",
      welcomeRoutes({
        workspaces: () => (renewed ? deferredResponse().promise : unavailable()),
      }),
      (html) => commits.push(html),
    );
    await screen.findByRole("heading", { level: 1, name: HERO });
    const dialog = await openPicker();
    expect((await within(dialog).findByRole("alert")).textContent).toBe(UNAVAILABLE);

    renewed = true;
    await renewAccount(getProbe);
    expect(pickerDialog()).toBe(dialog);
    expect(within(dialog).getByText(LOADING, { exact: true })).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(pageText()).not.toContain(UNAVAILABLE);
    expect(options(dialog)).toEqual([[UNSELECTED, "true"]]);
    // 失败文案只对读到它的账号可见：侧栏已显示新账号的每一次提交里都没有它，
    // 而不是等新账号的读取开始后才清掉。
    const asNewAccount = commits.filter((html) => html.includes(NEW_ACCOUNT));
    expect(asNewAccount.length).toBeGreaterThan(0);
    expect(asNewAccount.some((html) => html.includes(UNAVAILABLE))).toBe(false);
  });

  it("X6 场景不改变 prompt：选 创意设计 后发送 你好，prompt 请求体只有 message", async () => {
    const { fetchMock } = await mountWelcome();
    selectScene("创意设计");
    send("你好");
    const sessionId = `${CREATED_IDS[0]}`;
    await waitFor(() => expect(promptRequests(fetchMock, sessionId)).toHaveLength(1));
    expect(createRequests(fetchMock)).toEqual([createOf('{"scene":"design"}')]);
    expect(promptRequests(fetchMock, sessionId)).toEqual([["POST", '{"message":"你好"}']]);
  });
});

describe("静态样式", () => {
  it("≤760px 媒体块内 .chat-quick-row 单行横向滚动且不超出容器、chip 不收缩（X8）；该规则不出现在媒体块之外", () => {
    const css = stripComments(readRepoFile("web/src/features/chat/chat.css"));
    const media = blockBody(css, /@media\s*\(max-width:\s*760px\)\s*\{/);
    const narrow = ruleBody(media, ".chat-quick-row");
    expect(narrow).toContain("flex-wrap: nowrap;");
    expect(narrow).toContain("overflow-x: auto;");
    expect(narrow).toContain("max-width: 100%;");
    expect(ruleBody(media, ".chat-quick-chip")).toContain("flex: none;");

    const outside = topLevelBlocks(css)
      .filter(({ prelude }) => prelude.split(",").some((part) => part.trim() === ".chat-quick-row"))
      .map(({ body }) => body);
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain("flex-wrap: wrap;");
    expect(outside[0]).not.toContain("nowrap");
    expect(outside[0]).not.toContain("overflow");
  });
});
