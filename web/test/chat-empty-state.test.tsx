import "./radix-platform.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  clickSend,
  sessionPromptPath,
  settleDeferredResponse,
  typeDraft,
} from "./chat-page-lifecycle-support.js";
import {
  composer,
  findMessageArea,
  promptAccepted,
  runningCreatedSnapshot,
} from "./chat-page-ownership-support.js";
import {
  A,
  cleanupSessionMeta,
  crumb,
  envelope,
  findList,
  messagesPath,
  view,
} from "./chat-page-session-meta-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  CREATED_IDS,
  HERO,
  PROJECT_A,
  promptRequests,
  quickRow,
  sceneGroup,
  welcomeRoutes,
  workspaceList,
  workspaceRequests,
} from "./chat-page-welcome-scene-support.js";
import { CLOSED, FakeEventSource, latestSource } from "./chat-stream-support.js";
import { currentLocation, deferredResponse, jsonResponse } from "./support.js";
import { yieldMacrotask } from "./ui-support.js";

// 零消息会话空态（s1f-chat-surface 组 4，#825）：chat-web 消息线程「零消息会话空态」。

const EMPTY = "还没有消息，发一条开始吧";
const TITLE = "空会话";
const DRAFT = "草稿";
const HISTORY_FAILED = "历史读取失败";
const GUIDANCE = "请刷新页面后重试";

const UNBOUND = view(A, TITLE, { status: "idle" });
const BOUND = { ...UNBOUND, workspaceId: PROJECT_A.id };

type Session = typeof BOUND | typeof UNBOUND;

afterEach(cleanupSessionMeta);

function snapshot(session: Session, messages: unknown[] = []) {
  return jsonResponse({ session, messages, streamCursor: { epoch: 1, seq: 0 } });
}

/** 列表里只有 `session`，它的历史是空快照；`extra` 追加或覆盖。 */
function routes(session: Session, extra: FetchRoutes = {}): FetchRoutes {
  return {
    "/api/sessions": () => jsonResponse({ sessions: [session] }),
    "/api/workspaces": () => workspaceList(PROJECT_A),
    [messagesPath(A)]: () => snapshot(session),
    ...extra,
  };
}

/** 空态：线程区里的那一行文本所在的块（图标与工作空间行都在其中）。 */
async function findEmptyState() {
  const line = await within(await findMessageArea()).findByText(EMPTY, { exact: true });
  if (!line.parentElement) throw new Error("空态文本没有容器");
  return line.parentElement;
}

function queryEmptyText() {
  return screen.queryByText(EMPTY, { exact: true });
}

/** 刷新指引已显示、输入框锁定、不是「生成中」——此时线程里不该再有空态。 */
async function expectGuidanceInsteadOfEmptyState() {
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(GUIDANCE));
  expect(queryEmptyText()).toBeNull();
  expect(composer().disabled).toBe(true);
  expect(screen.queryByText("生成中", { exact: true })).toBeNull();
}

/**
 * 在零消息空闲会话的空态里发送，prompt 请求挂起。返回的 `accept` 让服务端受理（202）；受理之后的历史
 * 读取由 `afterAccept` 应答。
 */
async function sendFromEmptyState(afterAccept: () => Response) {
  const held = deferredResponse();
  let accepted = false;
  const { fetchMock } = renderChatPage(
    `/?session=${A}`,
    routes(BOUND, {
      [messagesPath(A)]: () => (accepted ? afterAccept() : snapshot(BOUND)),
      [sessionPromptPath(A)]: () => held.promise,
    }),
  );
  await findEmptyState();
  await waitFor(() => expect(composer().disabled).toBe(false));

  typeDraft("你好");
  clickSend();
  await waitFor(() => expect(promptRequests(fetchMock, A)).toHaveLength(1));
  return async () => {
    accepted = true;
    await settleDeferredResponse(held, jsonResponse(promptAccepted, 202));
  };
}

/** 线程区里以 `工作空间` 开头的文本节点（只读的绑定空间行）。 */
function workspaceLines(scope: HTMLElement) {
  return within(scope)
    .queryAllByText(/^工作空间/)
    .map((node) => node.textContent);
}

function expectDecorativeIcon(scope: HTMLElement) {
  const icons = scope.querySelectorAll("svg");
  expect(icons).toHaveLength(1);
  expect(icons[0]?.getAttribute("aria-hidden")).toBe("true");
}

/** 欢迎态专属内容都不在：hero、场景分组、快捷任务、最佳实践卡。 */
function expectNoWelcomeContent() {
  expect(screen.queryByRole("heading", { name: HERO })).toBeNull();
  expect(sceneGroup()).toBeNull();
  expect(screen.queryByRole("group", { name: "快捷任务" })).toBeNull();
  expect(screen.queryByRole("region", { name: "最佳实践案例" })).toBeNull();
}

describe("零消息会话空态", () => {
  it("E1 已绑定且空间名可解析：图标、提示与 工作空间 项目A；无场景/快捷任务/最佳实践/hero；一级标题仍是面包屑；草稿不变且可发送", async () => {
    renderChatPage("/", routes(BOUND));
    const nav = await findList(TITLE);
    // 欢迎态确有这些内容，之后「不在」的断言才有意义。
    expect(sceneGroup()).not.toBeNull();
    expect(quickRow()).toBeTruthy();
    expect(screen.getByRole("region", { name: "最佳实践案例" })).toBeTruthy();
    typeDraft(DRAFT);

    fireEvent.click(within(nav).getByRole("button", { name: TITLE }));
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${A}`));
    const empty = await findEmptyState();

    expectDecorativeIcon(empty);
    expect(workspaceLines(empty)).toEqual(["工作空间 项目A"]);
    // 工作空间行只读：空态里没有任何按钮或链接。
    expect(within(empty).queryAllByRole("button")).toEqual([]);
    expect(within(empty).queryAllByRole("link")).toEqual([]);
    expect(screen.queryAllByRole("article")).toEqual([]);
    expectNoWelcomeContent();
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([await crumb(TITLE)]);
    expect(within(await findMessageArea()).queryAllByRole("heading")).toEqual([]);
    expect(composer().value).toBe(DRAFT);
    expect(composer().disabled).toBe(false);
    expect(composer().placeholder).toBe("继续追问，或派一个新任务…");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(false);
  });

  it("E2 未绑定工作空间：有图标与提示，没有以 工作空间 开头的那一行", async () => {
    renderChatPage(`/?session=${A}`, routes(UNBOUND));
    const empty = await findEmptyState();
    await act(yieldMacrotask);

    expectDecorativeIcon(empty);
    expect(workspaceLines(await findMessageArea())).toEqual([]);
    expectNoWelcomeContent();
  });

  // 列表响应先挂起：`respond` 为 null 即一直读取中，否则等页面消化完这个响应再断言。
  it.each([
    ["列表读取中", null],
    ["列表读取失败", () => envelope(500, "读取失败")],
    ["该空间已不在列表里", () => workspaceList()],
  ])(
    "E3 已绑定但空间名解析不出（%s）：有图标与提示，没有以 工作空间 开头的那一行",
    async (_, respond) => {
      const list = deferredResponse();
      const { fetchMock } = renderChatPage(
        `/?session=${A}`,
        routes(BOUND, { "/api/workspaces": () => list.promise }),
      );
      const empty = await findEmptyState();
      await waitFor(() => expect(workspaceRequests(fetchMock)).toBe(1));
      if (respond) await settleDeferredResponse(list, respond());
      await act(yieldMacrotask);
      expect(workspaceRequests(fetchMock)).toBe(1);

      expectDecorativeIcon(empty);
      expect(workspaceLines(await findMessageArea())).toEqual([]);
      expect(document.body.textContent).not.toContain("已绑定空间 ");
    },
  );

  it("E4 历史请求尚未返回：返回之前不显示空态，返回后显示", async () => {
    const history = deferredResponse();
    const { fetchMock } = renderChatPage(
      `/?session=${A}`,
      routes(BOUND, { [messagesPath(A)]: () => history.promise }),
    );
    await findList(TITLE);
    await waitFor(() =>
      expect(fetchMock.mock.calls.map(([path]) => path)).toContain(messagesPath(A)),
    );
    await act(yieldMacrotask);
    expect(queryEmptyText()).toBeNull();

    await settleDeferredResponse(history, snapshot(BOUND));
    expect(workspaceLines(await findEmptyState())).toEqual(["工作空间 项目A"]);
  });

  it("E5 历史读取失败：只有错误，不显示空态", async () => {
    renderChatPage(
      `/?session=${A}`,
      routes(BOUND, { [messagesPath(A)]: () => envelope(500, HISTORY_FAILED) }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(HISTORY_FAILED);
    await act(yieldMacrotask);
    expect(queryEmptyText()).toBeNull();
  });

  it("E6 快照为 running 且尚无消息：不显示空态", async () => {
    const running = { ...BOUND, status: "running" as const };
    renderChatPage(`/?session=${A}`, routes(running));
    const region = await findMessageArea();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await act(yieldMacrotask);

    expect(screen.getByText("生成中")).toBeTruthy();
    expect(queryEmptyText()).toBeNull();
    expect(region.querySelector("svg")).toBeNull();
  });

  it("E7 在空态里发送：请求在途时空态已消失；受理后出现用户消息，空态不再出现", async () => {
    const accept = await sendFromEmptyState(() =>
      jsonResponse({ ...runningCreatedSnapshot(), session: { ...BOUND, status: "running" } }),
    );
    expect(queryEmptyText()).toBeNull();
    expect(screen.queryAllByRole("article")).toEqual([]);

    await accept();
    expect(await screen.findByRole("article", { name: "用户" })).toBeTruthy();
    expect(queryEmptyText()).toBeNull();
  });

  it("E7b 在空态里发送，已受理（202）但随后的快照读取失败：显示刷新指引、输入框锁定，不显示空态", async () => {
    const accept = await sendFromEmptyState(() => envelope(500, HISTORY_FAILED));

    await accept();
    await expectGuidanceInsteadOfEmptyState();
    expect(screen.getByRole("alert").textContent).toContain(HISTORY_FAILED);
    expect(screen.queryAllByRole("article")).toEqual([]);
  });

  it("E7c 零消息空闲会话的事件流终止失败：显示刷新指引、输入框锁定，不显示空态", async () => {
    renderChatPage(`/?session=${A}`, routes(BOUND));
    await findEmptyState();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      latestSource().emitTransport(CLOSED);
    });
    await expectGuidanceInsteadOfEmptyState();
  });

  it("E8 欢迎态首次发送：会话已建、prompt 在途——不显示空态", async () => {
    const created = `${CREATED_IDS[0]}`;
    const { fetchMock } = renderChatPage("/", welcomeRoutes());
    await screen.findByRole("heading", { level: 1, name: HERO });
    expect(queryEmptyText()).toBeNull();

    typeDraft("你好");
    clickSend();
    await waitFor(() => expect(currentLocation()).toBe(`/?session=${created}`));
    await waitFor(() => expect(promptRequests(fetchMock, created)).toHaveLength(1));
    await act(yieldMacrotask);
    expect(queryEmptyText()).toBeNull();
  });

  it("E9 欢迎态（列表里有零消息会话但未选中）：不显示空态", async () => {
    renderChatPage("/", routes(BOUND));
    await findList(TITLE);
    await screen.findByRole("heading", { level: 1, name: HERO });
    await act(yieldMacrotask);
    expect(queryEmptyText()).toBeNull();
  });
});
