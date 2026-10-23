// 输入框的专家选择（experts「输入框的专家选择」、chat-web「输入框与能力栏」的专家部分与「能力读取时机」；
// s1d-experts-skills 任务 9.2）：「+」菜单的 `选择专家…`、专家对话框（搜索、`不使用专家`、分组、打开时重取）、
// 能力行 `专家 · <名称>` 标签与 `移除专家`、名称来源与 `专家` 回退、每个 client 一次 `listExperts`、欢迎态的选择与
// 首次发送、中心 `开始会话` 带入的 state、会话中的 `PUT …/capabilities`、按选中会话 id 变化一次 `GET`，以及迟到 /
// 在途的丢弃。seam：整页挂载 + 假 API（`fetch`）；在途守卫另以 `renderHook` 同闭包连调（禁用的按钮不分派
// React 事件，整页够不到 ref 守卫）。期望文案取自规格条文与 tasks.md 9.2 的定案。
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionCapabilities } from "../src/features/chat/use-session-capabilities.js";
import type { ApiClient, ExpertView } from "../src/lib/api.js";
import { createAppRouter } from "../src/routes/index.js";
import { ANALYST, DESIGNER, FRONTEND, OWN, TESTER } from "./center-experts-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import { composer } from "./chat-page-ownership-support.js";
import {
  A,
  B,
  cleanupSessionMeta,
  envelope,
  findList,
  messagesPath,
  mountSessions,
  view,
} from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue } from "./chat-page-slash-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
  openExistingSession,
  welcomeRoutes,
} from "./chat-page-welcome-scene-support.js";
import { chatSnapshot } from "./chat-stream-support.js";
import { calls, deferredResponse, type FetchMock, jsonResponse } from "./support.js";

const EXPERTS = "/api/experts";
const OPTIONS = "/api/composer/options";
const PICK = "选择专家…";
const NONE = "不使用专家";
const REMOVE = "移除专家";
const LOADING = "正在读取专家…";
const FAILED = "专家读取失败，关闭后重新打开可重试";
const NO_MATCH = "没有匹配的专家";
const COMMAND_TEXTS = [
  "整理上下文压缩较长对话的上下文，保留要点",
  "任务清单查看或修改助手的任务清单",
  "weekly-report写周报",
];
/** 服务端次序：内置在前（固定次序），自建在后。 */
const LIST = [FRONTEND, ANALYST, DESIGNER, TESTER, OWN];
const SA = view(A, "会话甲");
const SB = view(B, "会话乙");

afterEach(cleanupSessionMeta);

function capsPath(id: string) {
  return `/api/sessions/${id}/capabilities`;
}

function caps(expertId: string | null) {
  return jsonResponse({ expertId, disabledSkills: [] });
}

function experts(list: readonly ExpertView[] = LIST) {
  return jsonResponse({ experts: list });
}

/** 一项的完整文本：名称、`内置` / `自建`、描述。 */
function item(expert: ExpertView) {
  return `${expert.name}${expert.builtin ? "内置" : "自建"}${expert.description}`;
}

function expertCalls(fetchMock: FetchMock) {
  return calls(fetchMock, EXPERTS).length;
}

function optionCalls(fetchMock: FetchMock) {
  return calls(fetchMock, OPTIONS).length;
}

/** 发往 `…/capabilities` 的 GET 路径，按调用顺序（PUT 不算）。 */
function capsReads(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([path, init]) => path.endsWith("/capabilities") && (init?.method ?? "GET") === "GET")
    .map(([path]) => path);
}

/** 发往 `…/capabilities` 的 PUT：`[路径, body]`，按调用顺序。 */
function capsWrites(fetchMock: FetchMock) {
  return fetchMock.mock.calls
    .filter(([path, init]) => path.endsWith("/capabilities") && init?.method === "PUT")
    .map(([path, init]) => [path, init?.body]);
}

function plusButton() {
  return screen.getByRole<HTMLButtonElement>("button", { hidden: true, name: "添加文件或命令" });
}

async function openMenu() {
  fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
  const menu = await screen.findByRole("menu");
  await quiesce();
  return menu;
}

function pickItem(menu: HTMLElement) {
  return within(menu).getByRole("menuitem", { name: PICK });
}

/** 「+」菜单 → `选择专家…`，返回打开的专家对话框。 */
async function openExperts() {
  fireEvent.click(pickItem(await openMenu()));
  return screen.findByRole("dialog", { name: "选择专家" });
}

function dialogGone() {
  return waitFor(() => expect(screen.queryByRole("dialog", { name: "选择专家" })).toBeNull());
}

/** 对话框里的分组：`[分类, 各项完整文本]`，按文档顺序。 */
function groups(dialog: HTMLElement) {
  return within(dialog)
    .queryAllByRole("group")
    .map((group) => [
      group.querySelector("legend")?.textContent,
      within(group)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ]);
}

/** 对话框里的全部选项（含 `不使用专家`）的完整文本，按文档顺序。 */
function choices(dialog: HTMLElement) {
  return within(dialog)
    .getAllByRole("button")
    .filter((button) => button.textContent !== "关闭")
    .map((button) => button.textContent);
}

/** 点对话框里完整文本以 `text` 开头的一项，等对话框关闭。 */
async function choose(dialog: HTMLElement, text: string) {
  const target = within(dialog)
    .getAllByRole("button")
    .find((button) => button.textContent?.startsWith(text));
  if (!target) throw new Error(`对话框里没有 ${text}`);
  fireEvent.click(target);
  await dialogGone();
}

function search(dialog: HTMLElement, query: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: "搜索专家" }), {
    target: { value: query },
  });
}

/** 能力行的专家标签（没有时为 null）。 */
function label() {
  return document.querySelector<HTMLElement>('form [data-slot="composer-expert"]');
}

/** 标签的可见文字（没有标签时为 null）。 */
function labelText() {
  const found = label();
  return found === null ? null : found.textContent;
}

function removeButton() {
  const found = label();
  if (!found) throw new Error("能力行没有专家标签");
  return within(found).getByRole<HTMLButtonElement>("button", { name: REMOVE });
}

function alerts() {
  return screen.queryAllByRole("alert").map((alert) => alert.textContent);
}

/** 欢迎态挂载（没有会话），专家清单缺省为 `LIST`；等输入框就绪与首轮读取完成。 */
async function mountWelcome(extra: FetchRoutes = {}) {
  const mounted = renderChatPage("/", {
    ...welcomeRoutes({ existing: [SA] }),
    [EXPERTS]: () => experts(),
    [COMMANDS]: catalogue(),
    ...extra,
  });
  await screen.findByRole("heading", { level: 1, name: HERO });
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
  return mounted;
}

/** 选中会话 `id`（`SA`、`SB` 都在列表里），专家清单缺省为 `LIST`。 */
async function mountSelected(id: string, extra: FetchRoutes = {}) {
  const mounted = mountSessions(`/?session=${id}`, [SA, SB], {
    [EXPERTS]: () => experts(),
    [COMMANDS]: catalogue(),
    ...extra,
  });
  const nav = await findList("会话甲");
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
  return { ...mounted, nav };
}

async function select(nav: HTMLElement, title: string, id: string) {
  await openExistingSession(nav, title, id);
  await waitFor(() => expect(composer().disabled).toBe(false));
  await quiesce();
}

describe("「+」菜单的 选择专家…", () => {
  it("欢迎态与会话中都在 上传文件 之后、命令段之前", async () => {
    const { nav } = await mountSelected(A);
    const texts = (menu: HTMLElement) =>
      within(menu)
        .getAllByRole("menuitem")
        .map((menuitem) => menuitem.textContent);

    const inSession = await openMenu();
    expect(texts(inSession)).toEqual([expect.stringMatching(/^上传文件/), PICK, ...COMMAND_TEXTS]);
    expect(pickItem(inSession).getAttribute("aria-disabled")).toBeNull();
    fireEvent.keyDown(inSession, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(within(nav).getByRole("button", { name: "新建会话" }));
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(texts(await openMenu())).toEqual(["上传文件", PICK, ...COMMAND_TEXTS]);
  });

  it("回答生成中：添加文件或命令 按钮禁用，选择专家… 随菜单一起不可达", async () => {
    const running = chatSnapshot();
    renderChatPage(`/?session=${running.session.id}`, {
      "/api/sessions": () => jsonResponse({ sessions: [running.session] }),
      [messagesPath(running.session.id)]: () => jsonResponse(running),
      [EXPERTS]: () => experts(),
      [COMMANDS]: catalogue(),
    });
    await screen.findByRole("button", { name: "停止" });
    await quiesce();

    expect(plusButton().disabled).toBe(true);
    fireEvent.pointerDown(plusButton(), { button: 0, ctrlKey: false, pointerType: "mouse" });
    await quiesce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: PICK })).toBeNull();
  });
});

describe("专家对话框", () => {
  it("顶部 不使用专家，按 开发 / 办公 / 设计 / 产品 分组、组内按清单次序；搜索按名称、描述、标签，不分大小写、先 trim；无匹配时只剩 不使用专家", async () => {
    await mountWelcome();
    const dialog = await openExperts();
    await quiesce();

    expect(choices(dialog)[0]).toBe(NONE);
    expect(groups(dialog)).toEqual([
      ["开发", [item(FRONTEND), item(TESTER)]],
      ["办公", [item(ANALYST)]],
      ["设计", [item(DESIGNER)]],
      ["产品", [item(OWN)]],
    ]);
    const box = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "搜索专家" });
    expect(box.placeholder).toBe("搜索专家");

    search(dialog, "  海报 ");
    expect(groups(dialog)).toEqual([["设计", [item(DESIGNER)]]]);
    search(dialog, "prd");
    expect(groups(dialog)).toEqual([["产品", [item(OWN)]]]);
    search(dialog, "回归测试");
    expect(groups(dialog)).toEqual([["开发", [item(TESTER)]]]);
    search(dialog, "数据分析师");
    expect(groups(dialog)).toEqual([["办公", [item(ANALYST)]]]);
    expect(within(dialog).queryByText(NO_MATCH)).toBeNull();

    search(dialog, "不存在的专家");
    expect(groups(dialog)).toEqual([]);
    expect(choices(dialog)).toEqual([NONE]);
    expect(within(dialog).getByText(NO_MATCH)).toBeTruthy();
  });

  it("没有成员的分组不显示", async () => {
    await mountWelcome({ [EXPERTS]: () => experts([ANALYST, DESIGNER]) });
    const dialog = await openExperts();
    await quiesce();

    expect(groups(dialog)).toEqual([
      ["办公", [item(ANALYST)]],
      ["设计", [item(DESIGNER)]],
    ]);
  });

  it("每次打开另重取一次 listExperts：有缓存时立即显示缓存，重取成功后替换；重取失败静默保留缓存", async () => {
    const second = deferredResponse();
    const third = deferredResponse();
    const answers = [() => experts([TESTER]), () => second.promise, () => third.promise];
    const { fetchMock } = await mountWelcome({
      [EXPERTS]: () => (answers.shift() ?? (() => experts()))(),
    });
    expect(expertCalls(fetchMock)).toBe(1);

    let dialog = await openExperts();
    expect(expertCalls(fetchMock)).toBe(2);
    expect(groups(dialog)).toEqual([["开发", [item(TESTER)]]]);
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    await settleDeferredResponse(second, experts([TESTER, DESIGNER]));
    expect(groups(dialog)).toEqual([
      ["开发", [item(TESTER)]],
      ["设计", [item(DESIGNER)]],
    ]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await dialogGone();

    dialog = await openExperts();
    expect(expertCalls(fetchMock)).toBe(3);
    await act(async () => third.reject(new Error("offline")));
    await quiesce();
    expect(groups(dialog)).toEqual([
      ["开发", [item(TESTER)]],
      ["设计", [item(DESIGNER)]],
    ]);
    expect(within(dialog).queryByText(FAILED)).toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("没有缓存：重取在途显示 正在读取专家…，失败显示失败文案、只剩 不使用专家；关闭后重新打开再取一次", async () => {
    const opened = deferredResponse();
    const reopened = deferredResponse();
    const answers = [
      () => envelope(503, "服务暂不可用"),
      () => opened.promise,
      () => reopened.promise,
    ];
    const { fetchMock } = await mountWelcome({
      [EXPERTS]: () => (answers.shift() ?? (() => experts()))(),
    });

    let dialog = await openExperts();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    expect(choices(dialog)).toEqual([NONE]);
    await settleDeferredResponse(opened, envelope(503, "服务暂不可用"));
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    expect(within(dialog).getByText(FAILED)).toBeTruthy();
    expect(choices(dialog)).toEqual([NONE]);
    expect(groups(dialog)).toEqual([]);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await dialogGone();

    dialog = await openExperts();
    expect(within(dialog).getByText(LOADING)).toBeTruthy();
    await settleDeferredResponse(reopened, experts([TESTER]));
    expect(within(dialog).queryByText(LOADING)).toBeNull();
    expect(groups(dialog)).toEqual([["开发", [item(TESTER)]]]);
    expect(expertCalls(fetchMock)).toBe(3);
  });
});

describe("能力行的专家标签", () => {
  it("名称取自专家清单：清单在途时只显示 专家（带 移除专家、无提示），清单到达后为 专家 · 测试工程师；id 不在清单里同样回退", async () => {
    const list = deferredResponse();
    const { fetchMock, nav } = await mountSelected(A, {
      [EXPERTS]: () => list.promise,
      [capsPath(A)]: () => caps(TESTER.id),
      [capsPath(B)]: () => caps("gone-expert"),
    });

    expect(labelText()).toBe("专家");
    expect(removeButton().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    await settleDeferredResponse(list, experts());
    expect(labelText()).toBe("专家 · 测试工程师");

    await select(nav, "会话乙", B);
    expect(labelText()).toBe("专家");
    expect(removeButton()).toBeTruthy();
    expect(alerts()).toEqual([]);
    expect(expertCalls(fetchMock)).toBe(1);
  });

  it("listExperts 失败：标签为 专家、无提示；回到欢迎态重取成功后再选中该会话为 专家 · 测试工程师；全程恰两次 listExperts，之后切换会话不再取", async () => {
    let asked = 0;
    const mounted = await mountSelected(A, {
      [EXPERTS]: () => {
        asked += 1;
        return asked === 1 ? envelope(503, "服务暂不可用") : experts();
      },
      [capsPath(A)]: () => caps(TESTER.id),
    });
    expect(labelText()).toBe("专家");
    expect(alerts()).toEqual([]);

    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();
    expect(expertCalls(mounted.fetchMock)).toBe(2);
    await select(mounted.nav, "会话甲", A);
    expect(labelText()).toBe("专家 · 测试工程师");
    await select(mounted.nav, "会话乙", B);
    await select(mounted.nav, "会话甲", A);
    expect(expertCalls(mounted.fetchMock)).toBe(2);
  });
});

describe("欢迎态的专家选择", () => {
  it("选 测试工程师 后发送：创建体带 expertId，之后没有第二次 getComposerOptions；新会话被选中时恰一次 GET …/capabilities", async () => {
    const { fetchMock } = await mountWelcome();
    await choose(await openExperts(), "测试工程师");
    expect(labelText()).toBe("专家 · 测试工程师");
    expect(optionCalls(fetchMock)).toBe(1);

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(1));
    await quiesce();

    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office","expertId":"builtin:test-engineer"}'),
    ]);
    expect(optionCalls(fetchMock)).toBe(1);
    await waitFor(() => expect(capsReads(fetchMock)).toEqual([capsPath(CREATED_IDS[0] ?? "")]));
  });

  it("没选过、选后改 不使用专家、选后 移除专家：创建体都不带 expertId 键", async () => {
    const mounted = await mountWelcome();
    const { fetchMock } = mounted;
    const sendAndReturn = async () => {
      typeDraft("你好");
      clickSend();
      await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
      await leaveForWelcome(mounted);
      await screen.findByRole("heading", { level: 1, name: HERO });
    };

    await sendAndReturn();
    await choose(await openExperts(), "测试工程师");
    await choose(await openExperts(), NONE);
    expect(label()).toBeNull();
    await sendAndReturn();
    await choose(await openExperts(), "前端架构师");
    fireEvent.click(removeButton());
    expect(label()).toBeNull();
    await sendAndReturn();

    expect(createRequests(fetchMock)).toEqual([
      createOf('{"scene":"office"}'),
      createOf('{"scene":"office"}'),
      createOf('{"scene":"office"}'),
    ]);
    expect(capsWrites(fetchMock)).toEqual([]);
  });

  it("欢迎态的选择是页面状态：选中会话后回到欢迎态仍在", async () => {
    const mounted = await mountWelcome();
    const { fetchMock } = mounted;
    await choose(await openExperts(), "数据分析师");
    const nav = await findList("会话甲");

    await select(nav, "会话甲", A);
    expect(label()).toBeNull();
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });

    expect(labelText()).toBe("专家 · 数据分析师");
    expect(capsWrites(fetchMock)).toEqual([]);
  });
});

describe("中心 开始会话 带入的专家", () => {
  /** 在当前这条历史记录上重挂整个应用（不经 `setBrowserPath`，所以不清 `history.state`）。 */
  function remountInPlace(fetchMock: FetchMock) {
    cleanup();
    vi.stubGlobal("fetch", fetchMock);
    const router = createAppRouter();
    render(<RouterProvider router={router} />);
    return router;
  }

  it("在中心点 开始会话：欢迎态显示该专家、history 的 state 不再带 expertId、没有会话请求；同一条历史记录上重挂不再带入（StrictMode）", async () => {
    const { fetchMock, router } = renderChatPage(
      "/center",
      { "/api/sessions": () => jsonResponse({ sessions: [] }), [EXPERTS]: () => experts() },
      true,
    );
    const main = await screen.findByRole("main");
    const card = (await within(main).findByRole("heading", { name: TESTER.name })).closest("li");
    if (!card) throw new Error("没有 测试工程师 的卡片");

    fireEvent.click(within(card).getByRole("button", { name: "开始会话" }));

    await screen.findByRole("heading", { level: 1, name: HERO });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    expect(window.location.pathname).toBe("/");
    expect((window.history.state as { usr?: unknown } | null)?.usr ?? null).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toEqual([]);
    expect(capsReads(fetchMock)).toEqual([]);

    router.dispose();
    const again = remountInPlace(fetchMock);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();
    expect(label()).toBeNull();
    again.dispose();
  });

  it("带入 → 移除专家 → 选中会话 → 回到欢迎态：没有标签", async () => {
    const { router } = await mountWelcome();
    // 与中心 `开始会话` 同一个入口：带 `{expertId}` state 导航到 `/`。
    await act(() => router.navigate("/", { state: { expertId: TESTER.id } }));
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));

    fireEvent.click(removeButton());
    expect(label()).toBeNull();
    await select(await findList("会话甲"), "会话甲", A);
    await act(() => router.navigate("/"));
    await screen.findByRole("heading", { level: 1, name: HERO });
    await quiesce();

    expect(label()).toBeNull();
  });
});

describe("会话中换专家", () => {
  it("选 测试工程师 恰一次 PUT {expertId}，成功以应答更新标签；移除专家 恰一次 PUT {expertId:null}，标签消失", async () => {
    let current: string | null = null;
    const { fetchMock } = await mountSelected(A, {
      [capsPath(A)]: (_path, init) => {
        if (init?.method === "PUT") current = JSON.parse(String(init.body)).expertId;
        return caps(current);
      },
    });
    expect(label()).toBeNull();

    await choose(await openExperts(), "测试工程师");
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    fireEvent.click(removeButton());
    await waitFor(() => expect(label()).toBeNull());

    expect(capsWrites(fetchMock)).toEqual([
      [capsPath(A), '{"expertId":"builtin:test-engineer"}'],
      [capsPath(A), '{"expertId":null}'],
    ]);
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);
    expect(alerts()).toEqual([]);
  });

  it("PUT 失败：保留原标签，chat column 里以 alert 显示 message（不在输入卡内）；下一次 PUT 开始、切换会话、回到欢迎态各清除它", async () => {
    let put: () => Promise<Response> | Response = () => envelope(409, "会话已归档");
    const mounted = await mountSelected(A, {
      [capsPath(A)]: (_path, init) => (init?.method === "PUT" ? put() : caps(TESTER.id)),
    });
    const { nav } = mounted;
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));

    fireEvent.click(removeButton());
    await waitFor(() => expect(alerts()).toEqual(["会话已归档"]));
    expect(labelText()).toBe("专家 · 测试工程师");
    const alert = screen.getByRole("alert");
    expect(alert.closest('[data-slot="chat-column"]')).not.toBeNull();
    expect(alert.closest('[data-slot="composer-card"]')).toBeNull();

    const pending = deferredResponse();
    put = () => pending.promise;
    await choose(await openExperts(), "前端架构师");
    expect(alerts()).toEqual([]);
    await settleDeferredResponse(pending, envelope(409, "会话已归档"));
    expect(alerts()).toEqual(["会话已归档"]);

    await select(nav, "会话乙", B);
    expect(alerts()).toEqual([]);
    await select(nav, "会话甲", A);
    put = () => envelope(409, "会话已归档");
    fireEvent.click(removeButton());
    await waitFor(() => expect(alerts()).toEqual(["会话已归档"]));
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(alerts()).toEqual([]);
  });

  it("PUT 401：交给既有的登录失效处理，进入登录页，不显示该失败", async () => {
    const { fetchMock } = await mountSelected(A, {
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT"
          ? jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401)
          : caps(TESTER.id),
    });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));

    fireEvent.click(removeButton());

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await quiesce();
    expect(screen.queryByText("登录已失效")).toBeNull();
    expect(alerts()).toEqual([]);
    expect(capsWrites(fetchMock)).toEqual([[capsPath(A), '{"expertId":null}']]);
  });
});

describe("会话能力的读取时机", () => {
  it("选中的会话 id 每变化一次恰一次 GET（A→B→A 共三次）；同一会话发消息、回合结束不重取", async () => {
    let snapshot = chatSnapshot({ assistantStatus: "done", content: "回答" });
    const { fetchMock, nav } = await mountSelected(A, {
      [messagesPath(A)]: () => jsonResponse({ ...snapshot, session: SA }),
      [`/api/sessions/${A}/prompt`]: () => {
        snapshot = chatSnapshot({ assistantStatus: "done", content: "第二个回答" });
        return jsonResponse({ userMessageId: 5, assistantMessageId: 6, undo: "none" }, 202);
      },
    });
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);

    typeDraft("再问一句");
    clickSend();
    await waitFor(() => expect(calls(fetchMock, `/api/sessions/${A}/prompt`)).toHaveLength(1));
    await quiesce();
    expect(capsReads(fetchMock)).toEqual([capsPath(A)]);

    await select(nav, "会话乙", B);
    await select(nav, "会话甲", A);
    expect(capsReads(fetchMock)).toEqual([capsPath(A), capsPath(B), capsPath(A)]);
  });

  it("GET 失败：没有标签、没有提示；下次选中该会话再取", async () => {
    let asked = 0;
    const { fetchMock, nav } = await mountSelected(A, {
      [capsPath(A)]: () => {
        asked += 1;
        return asked === 1 ? envelope(500, "内部错误") : caps(TESTER.id);
      },
    });
    expect(label()).toBeNull();
    expect(alerts()).toEqual([]);

    await select(nav, "会话乙", B);
    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    expect(capsReads(fetchMock)).toEqual([capsPath(A), capsPath(B), capsPath(A)]);
  });

  it("A 的 GET 在切到 B 之后才到：丢弃，B 的标签不受影响", async () => {
    const late = deferredResponse();
    let reads = 0;
    const { nav } = await mountSelected(B, {
      [capsPath(A)]: () => {
        reads += 1;
        return reads === 1 ? late.promise : caps(DESIGNER.id);
      },
      [capsPath(B)]: () => caps(TESTER.id),
    });
    await select(nav, "会话甲", A);
    expect(label()).toBeNull();

    await select(nav, "会话乙", B);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    await settleDeferredResponse(late, caps(ANALYST.id));
    expect(labelText()).toBe("专家 · 测试工程师");

    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 品牌视觉设计师"));
  });

  it("PUT 在途：选择专家… 与 移除专家 禁用；切到 B 后 B 照常可用，A 的应答与失败都丢弃", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const puts = [first, second];
    const { fetchMock, nav } = await mountSelected(A, {
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? (puts.shift()?.promise ?? caps(null)) : caps(TESTER.id),
      [capsPath(B)]: () => caps(FRONTEND.id),
    });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));

    fireEvent.click(removeButton());
    await quiesce();
    expect(removeButton().disabled).toBe(true);
    fireEvent.click(removeButton());
    const menu = await openMenu();
    expect(pickItem(menu).getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(capsWrites(fetchMock)).toHaveLength(1);

    await select(nav, "会话乙", B);
    await waitFor(() => expect(labelText()).toBe("专家 · 前端架构师"));
    expect(removeButton().disabled).toBe(false);
    await settleDeferredResponse(first, caps(null));
    expect(labelText()).toBe("专家 · 前端架构师");

    await select(nav, "会话甲", A);
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    fireEvent.click(removeButton());
    await quiesce();
    await select(nav, "会话乙", B);
    await settleDeferredResponse(second, envelope(409, "会话已归档"));
    expect(alerts()).toEqual([]);
    expect(labelText()).toBe("专家 · 前端架构师");
  });

  it("同一闭包连调两次 chooseExpert：恰一次 PUT（hook 内的 ref 守卫）", async () => {
    const put = vi.fn(() => new Promise<never>(() => {}));
    const client = {
      getSessionCapabilities: vi.fn(async () => ({ expertId: TESTER.id, disabledSkills: [] })),
      putSessionCapabilities: put,
    } as unknown as Pick<ApiClient, "getSessionCapabilities" | "putSessionCapabilities">;
    const { result } = renderHook(() => useSessionCapabilities(client, A));
    await waitFor(() => expect(result.current.capabilities?.expertId).toBe(TESTER.id));

    act(() => {
      const { chooseExpert } = result.current;
      chooseExpert(null);
      chooseExpert(FRONTEND.id);
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(A, { expertId: null });
    expect(result.current.pending).toBe(true);
  });
});
