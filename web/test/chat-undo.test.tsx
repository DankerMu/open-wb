// 用户消息的 `撤回`（message-undo「web 撤回」；chat-web「用户消息操作行的按钮与次序」）：按钮、撤回动作、
// 冲突对话框与所有权 fence。seam：整页挂载 + 假 API / 假 EventSource。测试不派发 `session.rewound`。
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessageSnapshot,
  ChatSession,
  ChatSessionUndo,
} from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
} from "./chat-page-lifecycle-support.js";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  FakeEventSource,
  historyUser,
  latestSource,
  observeUnhandledRejections,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";
import {
  calls,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  paths,
} from "./support.js";

const UNDO = `/api/sessions/${SESSION_ID}/undo`;
const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const B_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const LIST = "/api/sessions";
const QUERY = "&tab=x#frag";
const A_URL = `/?session=${SESSION_ID}${QUERY}`;
const UNDO_LABEL = "撤回";
const FORK_LABEL = "从此处分叉";
const CONFLICT_TITLE = "其它会话改动过这个工作空间";
const CONFLICT_TEXT =
  "这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。";
const UNRESTORED = "已撤回，以下文件未还原";
const GUIDANCE = "请刷新页面后重试";
const REASONS = [
  ["too_large", "这一轮开始前工作空间超出快照上限，无法撤回"],
  ["failed", "这一轮开始前的文件快照没有保存成功，无法撤回"],
  ["unbound", "这个会话没有使用工作空间，无法撤回"],
  ["command", "命令消息无法撤回"],
  ["none", "这条消息没有文件快照，无法撤回"],
] as const;

type Snapshot = ChatMessageSnapshot;
type Message = Snapshot["messages"][number];
type UndoState = NonNullable<Message["undo"]>;

function envelope(code: string, message: string) {
  return { error: { code, message } };
}

const CONFLICT = () => jsonResponse(envelope("undo_conflict", "别的会话动过"), 409);

function user(id: number, content: string, undo: UndoState): Message {
  return { ...historyUser, id, undo, content, createdAt: id };
}

function assistant(id: number, content: string, status: Message["status"] = "done"): Message {
  return { ...historyUser, id, role: "assistant", undo: null, status, content, createdAt: id };
}

function session(
  id: string,
  status: ChatSession["status"],
  title: string,
  updatedAt: number,
): ChatSession {
  return { id, title, status, createdAt: 1_740_000_000_000, updatedAt, ...NULL_SESSION_META };
}

function snapshotOf(s: ChatSession, messages: Message[]): Snapshot {
  return { session: s, messages, streamCursor: { epoch: 1, seq: 0 }, todo: null };
}

/** S：A 的 done 会话，两轮问答，两条用户消息都可撤回。 */
const S = snapshotOf(session(SESSION_ID, "done", "saved title", 1_740_000_000_023), [
  user(1, "第一个问题", "available"),
  assistant(2, "一"),
  user(3, "第二个问题", "available"),
  assistant(4, "二"),
]);
/** 撤回 u3 之后服务端的会话与快照（`updatedAt` 落在今天）。 */
const REWOUND_SESSION = { ...S.session, updatedAt: Date.now() };
const REWOUND = snapshotOf(REWOUND_SESSION, S.messages.slice(0, 2));
const B = snapshotOf(session(OTHER_SESSION_ID, "done", "other session", 1_740_000_000_010), [
  user(21, "B 问", "available"),
  assistant(22, "B 回答"),
]);
const FULL = ["第一个问题", "一", "第二个问题", "二"];
const TRIMMED = ["第一个问题", "一"];

const NO_PATHS = { count: 0, paths: [] };

/** 撤回提交之后 A 的消息读取的回复；null 时回挂载时的快照。每例复位。 */
let afterUndo: (() => Response) | null = null;

/** undo 的 200。服务端此时已提交：此后 A 的消息读取回 `after`（默认是撤回 u3 之后的快照）。 */
function undone(after: () => Response = () => jsonResponse(REWOUND), draft = "第二个问题") {
  afterUndo = after;
  return jsonResponse({
    session: REWOUND_SESSION,
    draft,
    files: { mode: "restored", restored: 1, removed: 0, skipped: NO_PATHS, failed: NO_PATHS },
  } satisfies ChatSessionUndo);
}

async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

/** 以 `?session=A&tab=x#frag` 挂载并 open。A 的消息读取回 `initial`，undo 200 之后回 `afterUndo`。 */
async function mount(initial: Snapshot, routes: FetchRoutes = {}, withB = false) {
  const mounted = renderChatPage(A_URL, {
    [LIST]: () =>
      jsonResponse({ sessions: withB ? [initial.session, B.session] : [initial.session] }),
    [MESSAGES]: () => (afterUndo ? afterUndo() : jsonResponse(initial)),
    [B_MESSAGES]: () => jsonResponse(B),
    ...routes,
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  if (initial.session.archivedAt === null) {
    await waitFor(() => expect(textarea().disabled).toBe(initial.session.status === "running"));
  }
  return { fetchMock: mounted.fetchMock, router: mounted.router, source };
}

function listGets(fetchMock: FetchMock) {
  return calls(fetchMock, LIST).filter(([, init]) => init?.method !== "POST").length;
}

function undoBodies(fetchMock: FetchMock) {
  return calls(fetchMock, UNDO).map(([, init]) => {
    expect(init?.method).toBe("POST");
    return init?.body;
  });
}

function buttons(label: string, scope: HTMLElement = document.body) {
  return within(scope).queryAllByRole("button", { name: label }) as HTMLButtonElement[];
}

function undoButton(scope: HTMLElement) {
  const [button, ...rest] = buttons(UNDO_LABEL, scope);
  expect(rest).toHaveLength(0);
  expect(button).toBeDefined();
  return button as HTMLButtonElement;
}

/** `aria-describedby` 所指元素的文本（仓库没有 jest-dom）。 */
function description(element: HTMLElement) {
  const id = element.getAttribute("aria-describedby");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

function bar() {
  const element = document.querySelector<HTMLElement>('form [data-slot="composer-toolbar"]');
  expect(element).not.toBeNull();
  return within(element as HTMLElement);
}

/** 页面内容的查询都带 `hidden`：冲突对话框开着时页面其余部分是 `aria-hidden`。 */
function textarea() {
  return screen.getByRole("textbox", {
    name: "给助手发消息",
    hidden: true,
  }) as HTMLTextAreaElement;
}

function typeDraft(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

function userArticles() {
  return screen.queryAllByRole("article", { name: "用户", hidden: true }) as HTMLElement[];
}

function alerts() {
  return screen.queryAllByRole("alert", { hidden: true }).map((alert) => alert.textContent);
}

function transcript() {
  const region = screen.queryByRole("region", { name: "消息", hidden: true });
  if (!region) {
    return [];
  }
  return within(region)
    .queryAllByRole("article", { hidden: true })
    .map((article) => article.querySelector('[data-slot="message-body"]')?.textContent ?? "");
}

function nav() {
  return screen.getByRole("navigation", { name: "会话列表" });
}

async function selectInNav(title: string, sessionId: string) {
  fireEvent.click(within(nav()).getByRole("button", { name: title }));
  await expectChatLocation(`/?session=${sessionId}${QUERY}`);
  await flush();
}

/** 第二条用户消息（u3）的 `撤回`。 */
function secondUndo() {
  return undoButton((userArticles() as [HTMLElement, HTMLElement])[1]);
}

async function clickUndo(button: HTMLButtonElement = secondUndo()) {
  fireEvent.click(button);
  await flush();
}

function conflictDialog() {
  return screen.queryByRole("alertdialog", { name: CONFLICT_TITLE });
}

function expectNoDialog() {
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
}

/** 没有轻提示，也没有未还原文件说明。 */
function expectNoNotice() {
  expect(document.querySelector(".ui-toast")).toBeNull();
  expect(screen.queryByText(UNRESTORED)).toBeNull();
}

/** 200 之后的页面：线程回到 u1/a2，草稿是原文，焦点在输入框，没有请求之外的提示。 */
function expectRewound() {
  expect(transcript()).toEqual(TRIMMED);
  expect(textarea().value).toBe("第二个问题");
  expect(textarea().disabled).toBe(false);
  expect(document.activeElement).toBe(textarea());
  expect(alerts()).toEqual([]);
  expectNoDialog();
  expectNoNotice();
}

afterEach(() => {
  afterUndo = null;
  window.localStorage.clear();
  cleanupChatLifecycle();
  vi.restoreAllMocks();
});

describe("撤回按钮", () => {
  it("用户消息操作行的按钮与次序：done 会话里 撤回 在 从此处分叉 之前，二者可用；助手消息没有", async () => {
    await mount(S);
    const users = userArticles();
    expect(users).toHaveLength(2);
    for (const article of users) {
      const row = article.querySelector<HTMLElement>('[data-slot="message-actions"]');
      expect(row).not.toBeNull();
      const all = within(row as HTMLElement).getAllByRole<HTMLButtonElement>("button");
      expect(all.map((b) => b.getAttribute("aria-label"))).toEqual([UNDO_LABEL, FORK_LABEL]);
      expect(all.map((b) => b.title)).toEqual([UNDO_LABEL, FORK_LABEL]);
      expect(all.map((b) => b.disabled)).toEqual([false, false]);
      expect(all.map((b) => b.getAttribute("aria-disabled"))).toEqual([null, null]);
      expect(all.map((b) => b.type)).toEqual(["button", "button"]);
      expect(description(undoButton(article))).toBeNull();
    }
    for (const article of screen.getAllByRole("article", { name: "助手" })) {
      expect(buttons(UNDO_LABEL, article)).toHaveLength(0);
    }
  });

  it("锁定与归档时：回合进行中每条用户消息的 撤回 与 从此处分叉 都禁用，点击不发请求", async () => {
    const running = snapshotOf(session(SESSION_ID, "running", "saved title", 1_740_000_000_023), [
      user(1, "第一个问题", "available"),
      assistant(2, "一"),
      user(3, "第二个问题", "available"),
      assistant(4, "", "running"),
    ]);
    const { fetchMock } = await mount(running, { [UNDO]: () => undone() });
    const undos = buttons(UNDO_LABEL);
    expect(undos).toHaveLength(2);
    expect(undos.map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons(FORK_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    for (const button of undos) {
      fireEvent.click(button);
    }
    await flush();
    expect(calls(fetchMock, UNDO)).toHaveLength(0);
  });

  it("锁定时不可撤回的消息同时带 disabled 与 aria-disabled", async () => {
    const running = snapshotOf(session(SESSION_ID, "running", "saved title", 1_740_000_000_023), [
      user(1, "/todo", "command"),
      assistant(2, "", "running"),
    ]);
    await mount(running);
    const [button] = buttons(UNDO_LABEL) as [HTMLButtonElement];
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(description(button)).toBe("命令消息无法撤回");
  });

  it("锁定与归档时：已归档的会话里用户消息没有 撤回 与 从此处分叉", async () => {
    const archived = snapshotOf({ ...S.session, archivedAt: 1_760_000_000_000 }, S.messages);
    await mount(archived);
    expect(await screen.findByText("该会话已归档，恢复后才能继续对话")).toBeTruthy();
    expect(userArticles()).toHaveLength(2);
    expect(buttons(UNDO_LABEL)).toHaveLength(0);
    expect(buttons(FORK_LABEL)).toHaveLength(0);
  });

  it("不可撤回的原因：五种取值各自 aria-disabled 并带原因描述，点击不发出任何请求", async () => {
    const messages = REASONS.flatMap(([undo], index) => [
      user(index * 2 + 1, `问题 ${undo}`, undo),
      assistant(index * 2 + 2, "答"),
    ]);
    const { fetchMock } = await mount(snapshotOf(S.session, messages), { [UNDO]: () => undone() });
    const undos = userArticles().map((article) => undoButton(article));
    expect(undos).toHaveLength(5);
    expect(undos.map((b) => b.getAttribute("aria-disabled"))).toEqual(Array(5).fill("true"));
    expect(undos.map(description)).toEqual(REASONS.map(([, reason]) => reason));
    // 不是原生禁用（读屏可达），名字与 tooltip 仍是 `撤回`；同一行的分叉不受影响。
    expect(undos.map((b) => b.disabled)).toEqual(Array(5).fill(false));
    expect(undos.map((b) => b.title)).toEqual(Array(5).fill(UNDO_LABEL));
    expect(buttons(FORK_LABEL).map((b) => b.getAttribute("aria-disabled"))).toEqual(
      Array(5).fill(null),
    );
    const before = paths(fetchMock).length;
    for (const button of undos) {
      fireEvent.click(button);
    }
    await flush();
    expect(calls(fetchMock, UNDO)).toHaveLength(0);
    expect(paths(fetchMock)).toHaveLength(before);
    expect(textarea().disabled).toBe(false);
    expectNoDialog();
    expect(alerts()).toEqual([]);
  });
});

describe("撤回动作", () => {
  it("撤回并回填：不确认，恰一次 POST，恰一次快照读取，线程回退，原文覆盖草稿并聚焦，列表条目更新", async () => {
    // 按时间分组：列表条目的 `updatedAt` 更新后从 `更早` 挪到 `今天`。
    window.localStorage.setItem("workbuddy-session-grouping", "time");
    const undo = deferredResponse();
    const { fetchMock, source } = await mount(S, { [UNDO]: () => undo.promise }, true);
    expect(within(nav()).queryByRole("group", { name: "今天" })).toBeNull();
    typeDraft("半句话");
    const button = secondUndo();
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();

    expectNoDialog();
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
    // 请求期间：输入框锁定，但不是生成中；操作行的按钮都禁用。
    expect(textarea().disabled).toBe(true);
    expect(textarea().value).toBe("半句话");
    expect(bar().queryByRole("button", { name: "停止" })).toBeNull();
    expect(bar().queryByText("生成中")).toBeNull();
    expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    expect(buttons(FORK_LABEL).map((b) => b.disabled)).toEqual([true, true]);
    expect(transcript()).toEqual(FULL);

    const reads = calls(fetchMock, MESSAGES).length;
    const lists = listGets(fetchMock);
    undo.resolve(undone());
    await flush();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    // 新连接 open 之前计数：恰一次快照读取，旧连接已关闭。
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(latestSource().url).toBe(`/api/sessions/${SESSION_ID}/events`);
    expectRewound();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(currentLocation()).toBe(A_URL);
    // 列表条目用响应的 `session` 更新（`updatedAt` 落到今天），不另发列表 GET。
    expect(listGets(fetchMock)).toBe(lists);
    const today = within(nav()).getByRole("group", { name: "今天" });
    expect(within(today).getByRole("button", { name: "saved title" })).toBeTruthy();
    expect(within(today).queryByRole("button", { name: "other session" })).toBeNull();
    expect(paths(fetchMock).filter((path) => path.endsWith("/prompt"))).toEqual([]);
    // 留下的那条用户消息仍可撤回。
    expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([false]);
  });

  it("草稿为空时同样写入原文；撤回第一条后线程为空", async () => {
    const empty = snapshotOf({ ...REWOUND_SESSION, status: "idle" }, []);
    const { fetchMock } = await mount(S, {
      [UNDO]: () => undone(() => jsonResponse(empty), "第一个问题"),
    });
    await clickUndo(undoButton((userArticles() as [HTMLElement])[0]));
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":1,"files":"restore"}']);
    await waitFor(() => expect(transcript()).toEqual([]));
    expect(textarea().value).toBe("第一个问题");
    expect(document.activeElement).toBe(textarea());
    expectNoNotice();
  });

  it.each([
    [
      "400",
      () => jsonResponse(envelope("bad_request", "这条消息无法撤回"), 400),
      "这条消息无法撤回",
    ],
    ["404", () => jsonResponse(envelope("not_found", "会话不存在"), 404), "会话不存在"],
    [
      "409 session_busy",
      () => jsonResponse(envelope("session_busy", "会话正在生成"), 409),
      "会话正在生成",
    ],
    [
      "409 session_archived",
      () => jsonResponse(envelope("session_archived", "会话已归档"), 409),
      "会话已归档",
    ],
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502), "Agent 不可用"],
    [
      "503",
      () => jsonResponse(envelope("agent_capacity", "Agent 容量已满"), 503),
      "Agent 容量已满",
    ],
    ["network", () => new TypeError("offline"), "请求失败，请稍后重试"],
  ] as const)(
    "失败就地显示：%s 时文案在输入框上，线程与草稿不变，输入框可用",
    async (_, reply, text) => {
      const { fetchMock, source } = await mount(S, { [UNDO]: reply });
      typeDraft("半句话");
      const reads = calls(fetchMock, MESSAGES).length;
      const lists = listGets(fetchMock);
      await clickUndo();

      expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
      expect(alerts()).toEqual([text]);
      expect(transcript()).toEqual(FULL);
      expect(textarea().value).toBe("半句话");
      expect(textarea().disabled).toBe(false);
      expect(buttons(UNDO_LABEL).map((b) => b.disabled)).toEqual([false, false]);
      expect(currentLocation()).toBe(A_URL);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(listGets(fetchMock)).toBe(lists);
      expect(source.closeCount).toBe(0);
      expect(FakeEventSource.instances).toHaveLength(1);
      expectNoDialog();
      expectNoNotice();
    },
  );

  it("200 之后的重读失败：草稿已写入，显示带刷新指引的错误", async () => {
    const { fetchMock } = await mount(S, {
      [UNDO]: () => undone(() => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502)),
    });
    typeDraft("半句话");
    const reads = calls(fetchMock, MESSAGES).length;
    await clickUndo();
    expect(undoBodies(fetchMock)).toHaveLength(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(textarea().value).toBe("第二个问题");
    expect(alerts()).toEqual([`Agent 不可用。${GUIDANCE}`]);
    expect(textarea().disabled).toBe(true);
    expect(bar().queryByText("生成中")).toBeNull();
  });
});

describe("撤回冲突对话框", () => {
  async function mountConflict(second: () => Response | Promise<Response> = () => undone()) {
    let posts = 0;
    const mounted = await mount(S, {
      [UNDO]: () => {
        posts += 1;
        return posts === 1 ? CONFLICT() : second();
      },
    });
    typeDraft("半句话");
    const trigger = secondUndo();
    await clickUndo(trigger);
    return { ...mounted, trigger };
  }

  function dialogButtons(dialog: HTMLElement) {
    return within(dialog)
      .getAllByRole("button")
      .map((button) => button.textContent);
  }

  it("冲突三选一：409 undo_conflict 打开对话框，标题、说明与三个按钮；输入框已解锁、没有报错", async () => {
    const { fetchMock } = await mountConflict();
    const dialog = conflictDialog();
    expect(dialog).not.toBeNull();
    expect(description(dialog as HTMLElement)).toBe(CONFLICT_TEXT);
    expect(dialogButtons(dialog as HTMLElement).sort()).toEqual(
      ["只撤回对话", "连文件一起还原", "取消"].sort(),
    );
    expect(undoBodies(fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
    expect(textarea().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    expect(transcript()).toEqual(FULL);
    expect(textarea().value).toBe("半句话");
  });

  it.each([
    [
      "取消",
      (dialog: HTMLElement) =>
        fireEvent.click(within(dialog).getByRole("button", { name: "取消" })),
    ],
    [
      "Escape",
      (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" }),
    ],
  ] as const)(
    "冲突三选一：%s 关闭对话框，没有第二个请求，线程与草稿不变，焦点回到该 撤回",
    async (_, close) => {
      const { fetchMock, trigger } = await mountConflict();
      const reads = calls(fetchMock, MESSAGES).length;
      close(conflictDialog() as HTMLElement);
      await flush();
      await waitFor(() => expectNoDialog());
      expect(undoBodies(fetchMock)).toHaveLength(1);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(transcript()).toEqual(FULL);
      expect(textarea().value).toBe("半句话");
      expect(textarea().disabled).toBe(false);
      expect(trigger.isConnected).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(trigger));
      expect(alerts()).toEqual([]);
    },
  );

  it("遮罩点击不关闭对话框", async () => {
    const { fetchMock } = await mountConflict();
    const overlay = document.querySelector<HTMLElement>('[data-slot="alert-dialog-overlay"]');
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay as HTMLElement);
    fireEvent.click(overlay as HTMLElement);
    await flush();
    expect(conflictDialog()).not.toBeNull();
    expect(undoBodies(fetchMock)).toHaveLength(1);
  });

  it.each([
    ["只撤回对话", "keep"],
    ["连文件一起还原", "force"],
  ] as const)(
    "冲突三选一：%s 关闭对话框并以 %s 恰再发一次，200 之后与撤回并回填相同",
    async (label, files) => {
      const second = deferredResponse();
      const { fetchMock } = await mountConflict(() => second.promise);
      const reads = calls(fetchMock, MESSAGES).length;
      fireEvent.click(within(conflictDialog() as HTMLElement).getByRole("button", { name: label }));
      await flush();
      await waitFor(() => expectNoDialog());
      expect(undoBodies(fetchMock)).toEqual([
        '{"messageId":3,"files":"restore"}',
        `{"messageId":3,"files":"${files}"}`,
      ]);
      expect(textarea().disabled).toBe(true);
      expect(textarea().value).toBe("半句话");

      second.resolve(undone());
      await flush();
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
      await flush();
      expectRewound();
      expect(undoBodies(fetchMock)).toHaveLength(2);
    },
  );

  it("重发的失败（含再次 undo_conflict）进输入框上的错误，不再开对话框", async () => {
    const { fetchMock } = await mountConflict(CONFLICT);
    fireEvent.click(
      within(conflictDialog() as HTMLElement).getByRole("button", { name: "连文件一起还原" }),
    );
    await flush();
    await waitFor(() => expectNoDialog());
    expect(undoBodies(fetchMock)).toHaveLength(2);
    expect(alerts()).toEqual(["别的会话动过"]);
    expect(transcript()).toEqual(FULL);
    expect(textarea().value).toBe("半句话");
    expect(textarea().disabled).toBe(false);
  });
});

describe("撤回的所有权 fence", () => {
  it.each([
    ["200", () => undone()],
    ["409 undo_conflict", CONFLICT],
    ["502", () => jsonResponse(envelope("agent_unavailable", "Agent 不可用"), 502)],
  ] as const)("请求在途时切换会话，草稿不变：迟到的 %s 被丢弃", async (_, reply) => {
    const undo = deferredResponse();
    const { fetchMock } = await mount(S, { [UNDO]: () => undo.promise }, true);
    typeDraft("半句话");
    await clickUndo();
    expect(undoBodies(fetchMock)).toHaveLength(1);

    await selectInNav("other session", OTHER_SESSION_ID);
    const sourceB = latestSource();
    expect(textarea().disabled).toBe(false);
    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    const lists = listGets(fetchMock);

    undo.resolve(reply());
    await flush();
    expect(textarea().value).toBe("半句话");
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(textarea().disabled).toBe(false);
    expect(alerts()).toEqual([]);
    expectNoDialog();
    expect(currentLocation()).toBe(`/?session=${OTHER_SESSION_ID}${QUERY}`);
    expect(transcript()).toEqual(["B 问", "B 回答"]);
    expect(FakeEventSource.instances).toHaveLength(sources);
    expect(sourceB.closeCount).toBe(0);
    expect(listGets(fetchMock)).toBe(lists);
  });

  it("离开又回到同一会话后到达的 200 照常应用（不带历史令牌）", async () => {
    const undo = deferredResponse();
    await mount(S, { [UNDO]: () => undo.promise }, true);
    await clickUndo();
    await selectInNav("other session", OTHER_SESSION_ID);
    await selectInNav("saved title", SESSION_ID);
    act(() => latestSource().emitOpen());
    await flush();
    expect(transcript()).toEqual(FULL);
    expect(textarea().disabled).toBe(true);

    undo.resolve(undone());
    await flush();
    await waitFor(() => expect(textarea().value).toBe("第二个问题"));
    expect(textarea().disabled).toBe(false);
    expect(document.activeElement).toBe(textarea());
    expect(alerts()).toEqual([]);
  });

  it("换账号后旧账号的 200 被丢弃", async () => {
    const stale = deferredResponse();
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      [LIST]: () => jsonResponse({ sessions: [S.session] }),
      [MESSAGES]: () => jsonResponse(S),
      [UNDO]: () => stale.promise,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await waitFor(() => expect(textarea().disabled).toBe(false));
    await clickUndo();
    expect(calls(fetchMock, UNDO)).toHaveLength(1);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    await waitFor(() => expect(textarea().disabled).toBe(false));
    typeDraft("新草稿");
    const reads = calls(fetchMock, MESSAGES).length;

    stale.resolve(undone());
    await flush();
    expect(textarea().value).toBe("新草稿");
    expect(textarea().disabled).toBe(false);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(transcript()).toEqual(FULL);
    expect(alerts()).toEqual([]);
  });

  it("页面卸载后到达的 200 被丢弃，不报错", async () => {
    const observer = observeUnhandledRejections();
    try {
      const undo = deferredResponse();
      const { fetchMock, router } = await mount(S, { [UNDO]: () => undo.promise });
      await clickUndo();
      await act(async () => {
        await router.navigate("/center");
      });
      expect(await screen.findByText("中心暂不可用")).toBeTruthy();
      const reads = calls(fetchMock, MESSAGES).length;
      const consoleError = vi.spyOn(console, "error");

      undo.resolve(undone());
      await flush();
      expect(currentLocation().startsWith("/center")).toBe(true);
      expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
      expect(consoleError).not.toHaveBeenCalled();
      expect(observer.unhandled).toEqual([]);
    } finally {
      observer.stop();
    }
  });
});
