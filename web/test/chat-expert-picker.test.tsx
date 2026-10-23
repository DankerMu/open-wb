// 输入框的专家选择（experts「输入框的专家选择」、chat-web「输入框与能力栏」的专家部分；s1d-experts-skills
// 任务 9.2）：「+」菜单的 `选择专家…`、专家对话框（搜索、`不使用专家`、分组、打开时重取）、能力行
// `专家 · <名称>` 标签与 `移除专家`、名称来源与 `专家` 回退、每个 client 一次 `listExperts`、欢迎态的选择与
// 首次发送、中心 `开始会话` 带入的 state、会话中的 `PUT …/capabilities`。读取时机与迟到 / 在途的丢弃在
// `chat-expert-picker-timing.test.tsx`。seam：整页挂载 + 假 API（`fetch`）。期望文案取自规格条文与
// tasks.md 9.2 的定案。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../src/routes/index.js";
import { ANALYST, DESIGNER, FRONTEND, OWN, TESTER } from "./center-experts-support.js";
import {
  alerts,
  COMMAND_TEXTS,
  caps,
  capsPath,
  capsReads,
  capsWrites,
  choices,
  choose,
  dialogGone,
  EXPERTS,
  expertCalls,
  experts,
  FAILED,
  groups,
  item,
  LOADING,
  label,
  labelText,
  mountSelected,
  mountWelcome,
  NO_MATCH,
  NONE,
  openExperts,
  openMenu,
  optionCalls,
  PICK,
  pickItem,
  plusButton,
  removeButton,
  search,
  select,
} from "./chat-expert-picker-support.js";
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
} from "./chat-page-session-meta-support.js";
import { COMMANDS, catalogue } from "./chat-page-slash-support.js";
import { renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  createOf,
  createRequests,
  HERO,
  leaveForWelcome,
} from "./chat-page-welcome-scene-support.js";
import { CLOSED, chatSnapshot, FakeEventSource, latestSource } from "./chat-stream-support.js";
import { deferredResponse, type FetchMock, jsonResponse } from "./support.js";

/** 事件流终止失败时 `streamError` 的引导语（chat-web 的终止失败文案）。 */
const STREAM_GUIDANCE = "请刷新页面后重试";

afterEach(cleanupSessionMeta);

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

  it("首次发送后不清：回到欢迎态标签仍在，第二次首次发送的创建体仍带 expertId", async () => {
    const mounted = await mountWelcome();
    const { fetchMock } = mounted;
    await choose(await openExperts(), "测试工程师");

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(composer().placeholder).toBe("继续追问，或派一个新任务…"));
    await leaveForWelcome(mounted);
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(labelText()).toBe("专家 · 测试工程师");

    typeDraft("再来一个");
    clickSend();
    await waitFor(() => expect(createRequests(fetchMock)).toHaveLength(2));
    const withExpert = createOf('{"scene":"office","expertId":"builtin:test-engineer"}');
    expect(createRequests(fetchMock)).toEqual([withExpert, withExpert]);
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

  it("PUT 失败的 alert 在 chat column 里排在 streamError 之后", async () => {
    await mountSelected(A, {
      [capsPath(A)]: (_path, init) =>
        init?.method === "PUT" ? envelope(409, "会话已归档") : caps(TESTER.id),
    });
    await waitFor(() => expect(labelText()).toBe("专家 · 测试工程师"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => latestSource().emitTransport(CLOSED));
    await waitFor(() => expect(alerts()).toEqual([expect.stringContaining(STREAM_GUIDANCE)]));

    fireEvent.click(removeButton());
    await waitFor(() => expect(alerts()).toHaveLength(2));
    const [stream, failed] = screen.getAllByRole("alert");
    expect([stream?.textContent, failed?.textContent]).toEqual([
      expect.stringContaining(STREAM_GUIDANCE),
      "会话已归档",
    ]);
    expect(stream?.parentElement).toBe(failed?.parentElement);
    expect(stream?.parentElement?.getAttribute("data-slot")).toBe("chat-column");
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
