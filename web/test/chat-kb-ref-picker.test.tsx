// 输入框知识库引用（message-attachments「输入框知识库引用」场景「引用并发送」「关闭时没有入口」「空白草稿与上限」
// 「欢迎态暂存」，以及列表取得失败、拒绝后保留、切换 / 回欢迎态 / 换账号 / 分叉 / 撤回清空、首次发送失败或停止后再发、
// 迟到应答被丢弃；s2c-kb-session 任务 8.2）。seam：整页挂载 + 假 API + `FakeXhr`。期望的菜单次序、可访问名、请求体与
// 文案取自规格条文。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSessionFork } from "../src/lib/session-contract.js";
import { base } from "./center-kb-support.js";
import {
  CREATED,
  turn as firstSendTurn,
  prompts,
  sendFirst,
  W,
  welcome,
} from "./chat-attachments-first-send-support.js";
import {
  alerts,
  choose,
  file,
  land,
  openMenu,
  remove,
  send,
  xhr,
} from "./chat-attachments-support.js";
import {
  baseReads,
  closePicker,
  DIALOG,
  ITEM,
  kbRoutes,
  menuItem,
  mountSelected,
  openPicker,
  options,
  PRODUCT,
  promptBodies,
  refer,
  removeTag,
  SA,
  SUPPORT_QA,
  tagArea,
  tagNames,
  toggle,
  turn,
} from "./chat-kb-ref-support.js";
import { quiesce } from "./chat-page-file-changes-support.js";
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
  B,
  cleanupSessionMeta,
  envelope,
  findList,
  mountSessions,
  newSessionButton,
  view,
} from "./chat-page-session-meta-support.js";
import {
  createRequests,
  openExistingSession,
  PROJECT_A_OPTION,
  pickOption,
} from "./chat-page-welcome-scene-support.js";
import { SESSION_ID } from "./chat-stream-support.js";
import {
  cleanupUndoPage,
  clickUndo,
  mount,
  S,
  session,
  snapshotOf,
  UNDO,
  undone,
  userArticles,
} from "./chat-undo-support.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";

afterEach(async () => {
  cleanupUndoPage();
  await cleanupSessionMeta();
});

const READ_FAILED = "知识库服务暂不可用";

describe("引用并发送", () => {
  it("「+」菜单在 `上传文件` 之后、`选择专家…` 之前有 `引用知识库…`；选 `产品文档` 后标签一项，发送 body 恰为两键，受理后标签区消失", async () => {
    const { fetchMock } = await mountSelected();
    const menu = await openMenu();
    const items = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    // `上传文件` 后面跟着不可用的原因（会话没有工作空间），只比开头。
    expect(items.slice(0, 3)).toEqual([expect.stringMatching(/^上传文件/), ITEM, "选择专家…"]);

    fireEvent.click(within(menu).getByRole("menuitem", { name: ITEM }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG });
    await quiesce();
    expect(baseReads(fetchMock)).toBe(1);
    expect(options(dialog)).toEqual([
      { text: "产品文档", pressed: false, disabled: false },
      { text: "客服问答重建中", pressed: false, disabled: false },
    ]);
    toggle(dialog, "产品文档");
    // 点选只切换、不关闭。
    expect(screen.getByRole("dialog", { name: DIALOG })).toBe(dialog);
    expect(options(dialog)[0]).toEqual({ text: "产品文档", pressed: true, disabled: false });
    await closePicker(dialog);

    expect(tagNames()).toEqual(["产品文档"]);
    const area = tagArea() as HTMLElement;
    expect(within(area).getByRole("button", { name: "移除 产品文档" })).toBeTruthy();
    // 与附件标签同在文本框上方、输入卡之内。
    const card = composer().closest('[data-slot="composer-card"]') as HTMLElement;
    expect(card.contains(area)).toBe(true);
    expect(
      area.compareDocumentPosition(composer()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    typeDraft("查一下");
    clickSend();
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(promptBodies(fetchMock, A)).toEqual([
      { message: "查一下", knowledgeBases: [PRODUCT.id] },
    ]);
    expect(alerts()).toEqual([]);
  });

  it("没有引用时 body 不带 `knowledgeBases` 键", async () => {
    const { fetchMock } = await mountSelected();
    typeDraft("查一下");
    clickSend();
    await waitFor(() => expect(promptBodies(fetchMock, A)).toHaveLength(1));
    expect(promptBodies(fetchMock, A)).toEqual([{ message: "查一下" }]);
  });

  it("非 `ready` 的库同样可选，标签只写库名；多个引用按加入次序发出", async () => {
    const { fetchMock } = await mountSelected();
    await refer("客服问答", "产品文档");
    expect(tagNames()).toEqual(["客服问答", "产品文档"]);
    typeDraft("查一下");
    clickSend();
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(promptBodies(fetchMock, A)).toEqual([
      { message: "查一下", knowledgeBases: [SUPPORT_QA.id, PRODUCT.id] },
    ]);
  });
});

describe("关闭时没有入口", () => {
  it.each([
    ["`enabled:false`", () => jsonResponse({ enabled: false })],
    ["状态读取失败", () => envelope(500, READ_FAILED)],
    ["状态读取在途", () => deferredResponse().promise],
  ])("%s：「+」菜单没有 `引用知识库…`，也不读库列表", async (_, status) => {
    const { fetchMock } = await mountSelected({ "/api/kb/status": status });
    const menu = await openMenu();
    expect(menuItem(menu)).toBeNull();
    expect(within(menu).getAllByRole("menuitem")[0]?.textContent).toMatch(/^上传文件/);
    expect(baseReads(fetchMock)).toBe(0);
    expect(tagArea()).toBeNull();
  });
});

describe("空白草稿与上限", () => {
  it("草稿为空白、只有一个引用：`发送` 禁用，Enter 不发送", async () => {
    const { fetchMock } = await mountSelected();
    await refer("产品文档");
    typeDraft("   ");
    expect(send().disabled).toBe(true);
    fireEvent.keyDown(composer(), { key: "Enter" });
    await quiesce();
    expect(promptBodies(fetchMock, A)).toEqual([]);
    expect(tagNames()).toEqual(["产品文档"]);
  });

  it("已引用 5 个时其余未选项禁用，已选项仍可取消；取消一个后其余恢复可选", async () => {
    const six = ["一", "二", "三", "四", "五", "六"].map((name, index) =>
      base(`kb-${index}`, { name: `库${name}` }),
    );
    await mountSelected(kbRoutes(six));
    const dialog = await openPicker();
    for (const name of ["库一", "库二", "库三", "库四", "库五"]) toggle(dialog, name);
    expect(options(dialog).map(({ pressed, disabled }) => [pressed, disabled])).toEqual([
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [true, false],
      [false, true],
    ]);
    toggle(dialog, "库三");
    expect(options(dialog).every(({ disabled }) => !disabled)).toBe(true);
    toggle(dialog, "库六");
    await closePicker(dialog);
    expect(tagNames()).toEqual(["库一", "库二", "库四", "库五", "库六"]);
  });
});

describe("选择、取消与移除", () => {
  it("再选一次即取消（标签区不渲染）；移除按钮去掉标签，再打开列表时该项未选", async () => {
    await mountSelected();
    let dialog = await openPicker();
    toggle(dialog, "产品文档");
    toggle(dialog, "产品文档");
    expect(options(dialog)[0]?.pressed).toBe(false);
    await closePicker(dialog);
    expect(tagArea()).toBeNull();

    await refer("产品文档", "客服问答");
    removeTag("产品文档");
    expect(tagNames()).toEqual(["客服问答"]);
    dialog = await openPicker();
    expect(options(dialog).map(({ pressed }) => pressed)).toEqual([false, true]);
  });

  it("还没有知识库：列表里没有可选项，只有一行说明", async () => {
    await mountSelected(kbRoutes([]));
    const dialog = await openPicker();
    expect(within(dialog).getByText("还没有知识库")).toBeTruthy();
    expect(options(dialog)).toEqual([]);
  });

  it("列表取得失败：显示该失败的 message，已有引用不变；每次打开各重取一次", async () => {
    let reads = 0;
    const { fetchMock } = await mountSelected({
      "/api/kb/bases": () => {
        reads += 1;
        return reads === 1 ? jsonResponse({ bases: [PRODUCT] }) : envelope(503, READ_FAILED);
      },
    });
    await refer("产品文档");
    const dialog = await openPicker();
    expect(baseReads(fetchMock)).toBe(2);
    expect(within(dialog).getByText(READ_FAILED)).toBeTruthy();
    expect(options(dialog)).toEqual([]);
    await closePicker(dialog);
    expect(tagNames()).toEqual(["产品文档"]);
  });

  it("先开一次（应答挂起）、关闭再开：先前那次迟到的应答被丢弃，只显示本次的结果", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const answers = [first, second];
    await mountSelected({ "/api/kb/bases": () => (answers.shift() ?? second).promise });
    let dialog = await openPicker();
    await closePicker(dialog);
    dialog = await openPicker();
    expect(within(dialog).getByText("正在读取知识库…")).toBeTruthy();
    expect(options(dialog)).toEqual([]);
    await settleDeferredResponse(second, jsonResponse({ bases: [PRODUCT] }));
    await settleDeferredResponse(first, jsonResponse({ bases: [SUPPORT_QA] }));
    expect(options(dialog).map(({ text }) => text)).toEqual(["产品文档"]);
  });
});

describe("拒绝后保留", () => {
  it.each([
    [400, "知识库引用无效"],
    [404, "知识库不存在"],
  ])(
    "prompt %s：引用留在输入框，草稿恢复，显示拒绝的 message；再发一次带同样的引用",
    async (status, message) => {
      const { fetchMock } = await mountSelected(turn(SA, [() => envelope(status, message)]));
      await refer("产品文档");
      typeDraft("查一下");
      clickSend();
      await waitFor(() => expect(alerts()).toEqual([message]));
      expect(tagNames()).toEqual(["产品文档"]);
      expect(composer().value).toBe("查一下");

      clickSend();
      await waitFor(() => expect(tagArea()).toBeNull());
      expect(promptBodies(fetchMock, A)).toEqual([
        { message: "查一下", knowledgeBases: [PRODUCT.id] },
        { message: "查一下", knowledgeBases: [PRODUCT.id] },
      ]);
    },
  );
});

describe("清空时机", () => {
  it("切换会话清空，切回来也不再出现", async () => {
    const { nav } = await mountSelected();
    await refer("产品文档");
    await openExistingSession(nav, "会话乙", B);
    await quiesce();
    expect(tagArea()).toBeNull();
    await openExistingSession(nav, "会话甲", A);
    await quiesce();
    expect(tagArea()).toBeNull();
  });

  it("回到欢迎态清空", async () => {
    const { nav } = await mountSelected();
    await refer("产品文档");
    fireEvent.click(newSessionButton(nav));
    await waitFor(() => expect(currentLocation()).toBe("/"));
    await quiesce();
    expect(tagArea()).toBeNull();
  });

  it("换账号清空：新账号在同一会话里发送，body 不带旧账号的引用", async () => {
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${A}`, {
      "/api/sessions": () => jsonResponse({ sessions: [SA] }),
      ...kbRoutes(),
      ...turn(SA),
    });
    await findList("会话甲");
    await waitFor(() => expect(composer().disabled).toBe(false));
    await quiesce();
    await refer("产品文档");
    expect(tagNames()).toEqual(["产品文档"]);
    await renewAccount(getProbe);
    await quiesce();
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(tagArea()).toBeNull();

    typeDraft("查一下");
    clickSend();
    await waitFor(() => expect(promptBodies(fetchMock, A)).toHaveLength(1));
    expect(promptBodies(fetchMock, A)).toEqual([{ message: "查一下" }]);
  });
});

const ARCHIVED_NOTICE = '[data-slot="archived-notice"]';

describe("选择列表随输入框卸下", () => {
  it.each([
    ["", false],
    ["（StrictMode）", true],
  ])(
    "开着选择列表经导航切到已归档的会话（输入框卸下）再回来：列表不再自己打开、不再读库列表%s",
    async (_, strict) => {
      const archived = view(B, "旧项目", { archivedAt: 1 });
      const mounted = mountSessions(
        `/?session=${A}`,
        [SA, archived],
        { ...kbRoutes(), ...turn(SA) },
        strict,
      );
      await findList("会话甲");
      await waitFor(() => expect(composer().disabled).toBe(false));
      await quiesce();
      await openPicker();
      expect(baseReads(mounted.fetchMock)).toBe(1);

      await act(() => mounted.router.navigate(`/?session=${B}`));
      await waitFor(() => expect(document.querySelector(ARCHIVED_NOTICE)).not.toBeNull());
      expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull();
      await act(() => mounted.router.navigate(`/?session=${A}`));
      await waitFor(() => expect(document.querySelector(ARCHIVED_NOTICE)).toBeNull());
      // 输入框重挂后再判定：开着的模态列表会把输入框藏出无障碍树，所以先看 DOM 里的表单。
      await waitFor(() =>
        expect(document.querySelector('form[data-slot="composer"]')).not.toBeNull(),
      );
      await quiesce();
      expect(screen.queryByRole("dialog", { name: DIALOG })).toBeNull();
      expect(composer().disabled).toBe(false);
      expect(baseReads(mounted.fetchMock)).toBe(1);
    },
  );
});

const DENIED = "路径不在工作空间内";
const WITH_REF = `"knowledgeBases":["${PRODUCT.id}"]`;

/** 欢迎态（知识库开启），新会话 `CREATED` 绑定 W；它的 prompt 受理后历史带一条 `查一下`。 */
function welcomeWithKb() {
  const created = view(CREATED, null, { status: "idle", workspaceId: W });
  return welcome({ ...kbRoutes(), ...firstSendTurn(created, "查一下", []) });
}

/** 欢迎态选中项目A、暂存 a.pdf、引用 `产品文档`、输入 `查一下` 并发送：会话已建出，a.pdf 在途。 */
async function sendStaged() {
  const page = await welcomeWithKb();
  await pickOption(PROJECT_A_OPTION);
  await choose(file("a.pdf"));
  await refer("产品文档");
  typeDraft("查一下");
  await sendFirst();
  return page;
}

describe("欢迎态暂存", () => {
  it("引用 `产品文档` 并发送 `查一下`：恰一次 `createSession`、恰一次 prompt 带引用；受理后标签区消失", async () => {
    const { fetchMock } = await welcomeWithKb();
    await refer("产品文档");
    expect(tagNames()).toEqual(["产品文档"]);
    typeDraft("查一下");
    await sendFirst();
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(prompts(fetchMock)).toEqual([`{"message":"查一下",${WITH_REF}}`]);
  });

  it("带附件：上传期间引用标签仍在，传完后唯一的那次 prompt 同时带附件与引用", async () => {
    const { fetchMock } = await sendStaged();
    expect(tagNames()).toEqual(["产品文档"]);
    expect(prompts(fetchMock)).toEqual([]);
    await land(0, "a.pdf");
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(prompts(fetchMock)).toEqual([
      `{"message":"查一下","attachments":["uploads/a.pdf"],${WITH_REF}}`,
    ]);
  });

  it("上传阶段失败：不发 prompt，引用留在新会话上；移除失败的文件再发，不再建会话，那一次 prompt 带这些引用", async () => {
    const { fetchMock } = await sendStaged();
    act(() =>
      xhr(0).respond(403, JSON.stringify({ error: { code: "sandbox_denied", message: DENIED } })),
    );
    await quiesce();
    expect(alerts()).toEqual([DENIED]);
    expect(prompts(fetchMock)).toEqual([]);
    expect(currentLocation()).toBe(`/?session=${CREATED}`);
    expect(tagNames()).toEqual(["产品文档"]);

    remove("a.pdf");
    clickSend();
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(prompts(fetchMock)).toEqual([`{"message":"查一下",${WITH_REF}}`]);
  });

  it("上传阶段按 `停止`：引用留在新会话上；再发不再建会话，那一次 prompt 带附件与引用", async () => {
    const { fetchMock } = await sendStaged();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    await quiesce();
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(prompts(fetchMock)).toEqual([]);
    expect(tagNames()).toEqual(["产品文档"]);

    clickSend();
    await quiesce();
    await land(1, "a.pdf");
    await waitFor(() => expect(tagArea()).toBeNull());
    expect(createRequests(fetchMock)).toHaveLength(1);
    expect(prompts(fetchMock)).toEqual([
      `{"message":"查一下","attachments":["uploads/a.pdf"],${WITH_REF}}`,
    ]);
  });
});

describe("分叉与撤回回填时清空", () => {
  const FORK_ID = "c".repeat(32);
  const FORK_SESSION = session(FORK_ID, "done", "saved title", 1_740_000_000_099);

  it("`从此处分叉`：草稿回填为分叉点原文，新会话的输入框没有引用", async () => {
    const forked: ChatSessionFork = { session: FORK_SESSION, draft: "第一个问题", attachments: [] };
    await mount(S, {
      ...kbRoutes(),
      [`/api/sessions/${SESSION_ID}/fork`]: () => jsonResponse(forked, 201),
      [`/api/sessions/${FORK_ID}/messages`]: () =>
        jsonResponse(snapshotOf(FORK_SESSION, S.messages.slice(0, 2))),
    });
    await refer("产品文档");
    const [first] = userArticles();
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "从此处分叉" }));
    await waitFor(() => expect(currentLocation()).toContain(`session=${FORK_ID}`));
    await quiesce();
    expect(composer().value).toBe("第一个问题");
    expect(tagArea()).toBeNull();
  });

  it("`撤回`：同一会话里草稿回填为原文，引用清空", async () => {
    await mount(S, { ...kbRoutes(), [UNDO]: () => undone() });
    await refer("产品文档");
    await clickUndo();
    expect(composer().value).toBe("第二个问题");
    expect(currentLocation()).toContain(`session=${SESSION_ID}`);
    expect(tagArea()).toBeNull();
  });
});
