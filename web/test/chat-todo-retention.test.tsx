/**
 * Issue #1524 — session-todo「任务清单面板」的保留规则（epic-acceptance-followups D6，owner C2）on the
 * mounted page (fake API and fake EventSource): a list that turns all-closed in place stays until the
 * user clicks 发送 on this page; the scenarios「已完结清单保留到下一条用户消息」and「全部完成或放弃时隐藏」.
 * 「点击的那一刻」is asserted while the request is held (`deferredResponse`).
 */
import "./radix-platform.js";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  approval,
  cards,
  composerInput,
  flush,
  mountPage,
  snapshotWith,
  T0,
} from "./chat-approval-support.js";
import { CREATED, sendFirst, W, welcome } from "./chat-attachments-first-send-support.js";
import { choose, file, xhr } from "./chat-attachments-support.js";
import { clickSend, settleDeferredResponse, typeDraft } from "./chat-page-lifecycle-support.js";
import {
  envelope,
  OTHER_MESSAGES,
  otherSnapshot,
  promptAccepted,
} from "./chat-page-ownership-support.js";
import { cleanupSessionMeta, messagesPath, view } from "./chat-page-session-meta-support.js";
import { PROJECT_A_OPTION, pickOption } from "./chat-page-welcome-scene-support.js";
import {
  chatSnapshot,
  type FakeEventSource,
  latestSource,
  SESSION_ID,
} from "./chat-stream-support.js";
import { deferredResponse, jsonResponse } from "./support.js";

type Todo = NonNullable<ChatMessageSnapshot["todo"]>;
type Status = Todo["phases"][number]["tasks"][number]["status"];

const list = (...statuses: Status[]): Todo => ({
  phases: [
    { name: "走查", tasks: statuses.map((status, at) => ({ content: `任务 ${at + 1}`, status })) },
  ],
});
const ONE_OF_THREE = list("completed", "pending", "pending");
const DONE = list("completed", "completed", "completed");
const TWO_OF_THREE = list("completed", "completed", "pending");
/** 保留期间删掉一项的已完结清单。 */
const DONE_TWO = list("completed", "completed");
const OTHER_TODO = list("pending");
const PROMPT = `/api/sessions/${SESSION_ID}/prompt`;
const DONE_WORDS = ["已完成", "已完成", "已完成"];

const SETTLED = { status: "done", assistantStatus: "done", content: "answer" } as const;
const done = (todo: Todo | null, seq = 0) =>
  chatSnapshot({ ...SETTLED, cursor: { epoch: 1, seq }, todo });

/** 名称以 `任务清单` 开头的按钮（面板的头部按钮，至多一个）的文字；没有面板时为 null。 */
function header() {
  return screen.queryByRole("button", { name: /^任务清单/ })?.textContent ?? null;
}

const statusWords = () =>
  [...document.querySelectorAll('[data-slot="todo-panel"] li [data-slot="todo-status"]')].map(
    (status) => status.textContent,
  );

function emitTodo(source: FakeEventSource, seq: number, todo: Todo | null) {
  act(() => source.emitData("todo.updated", `1:${seq}`, { messageId: 0, todo }));
}

/** 事件流断开后恢复：再次 open，页面重新读快照并装入。 */
async function reopen(source: FakeEventSource) {
  act(() => source.emitTransport());
  act(() => source.emitOpen());
  await flush();
}

/** 先显示 `1/3`，再就地完结为 `3/3`：面板仍在。 */
async function completeInPlace(routes = {}) {
  const mounted = await mountPage(done(ONE_OF_THREE), routes);
  expect(header()).toBe("任务清单 1/3");
  emitTodo(mounted.source, 1, DONE);
  expect(header()).toBe("任务清单 3/3");
  mounted.page.snapshot = done(DONE, 1);
  return mounted;
}

async function selectTitle(title: string, shown: string) {
  fireEvent.click(screen.getByRole("button", { name: title }));
  for (let round = 0; round < 200 && !screen.queryByText(shown, { exact: true }); round += 1)
    await flush(1);
  await flush();
}

afterEach(async () => {
  vi.useRealTimers();
  await cleanupSessionMeta();
});

describe("a list closed in place stays until the next 发送", () => {
  it("R1 keeps 3/3 through the locked turn and turn.end, is gone the moment 发送 is clicked and after the 400; a list with a pending task comes back, closes in place again and is gone from the click through the 202 snapshot", async () => {
    // 提问卡的倒计时读 Date 与 setInterval
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(T0);
    const [rejected, accepted] = [deferredResponse(), deferredResponse()];
    const { page, source } = await mountPage(
      { ...snapshotWith([approval(7)]), todo: ONE_OF_THREE },
      { [PROMPT]: [rejected.promise, accepted.promise] },
    );
    const [card] = cards() as [HTMLElement];

    emitTodo(source, 1, DONE);
    expect(header()).toBe("任务清单 3/3");
    expect(statusWords()).toEqual(DONE_WORDS);
    expect(composerInput().disabled).toBe(true);
    expect(cards()).toEqual([card]);
    act(() => source.emitData("turn.end", "1:2", { messageId: 0, status: "done" }));
    await flush();
    expect(composerInput().disabled).toBe(false);
    expect(header()).toBe("任务清单 3/3");

    typeDraft("下一句");
    clickSend();
    await flush();
    expect(header()).toBeNull();
    expect(cards()).toEqual([card]);
    await settleDeferredResponse(rejected, envelope(400, "bad_request", "消息不能为空"));
    await flush();
    expect(composerInput().disabled).toBe(false);
    expect(header()).toBeNull();

    emitTodo(source, 3, TWO_OF_THREE);
    expect(header()).toBe("任务清单 2/3");
    emitTodo(source, 4, DONE);
    expect(header()).toBe("任务清单 3/3");
    page.snapshot = { ...snapshotWith([approval(7)], 4), todo: DONE };
    typeDraft("下一句");
    clickSend();
    await flush();
    expect(header()).toBeNull();
    await settleDeferredResponse(accepted, jsonResponse(promptAccepted, 202));
    act(() => latestSource().emitOpen());
    await flush();
    expect(header()).toBeNull();
    expect(cards()).toHaveLength(1);
  });

  it("R2 swaps in another closed list (2/2) while kept and is gone on todo.updated null", async () => {
    const { source } = await completeInPlace();
    emitTodo(source, 2, DONE_TWO);
    expect(header()).toBe("任务清单 2/2");
    emitTodo(source, 3, null);
    expect(header()).toBeNull();
  });

  it("R3 shows 3/3 when a stream recovery installs the list closed, and keeps it through a recovery and a regenerate that reinstall the same content", async () => {
    const regen = deferredResponse();
    const { page, source } = await mountPage(done(ONE_OF_THREE), {
      [`/api/sessions/${SESSION_ID}/regenerate`]: () => regen.promise,
    });
    page.snapshot = done(DONE);
    await reopen(source);
    expect(header()).toBe("任务清单 3/3");
    await reopen(source);
    expect(header()).toBe("任务清单 3/3");

    page.snapshot = { ...chatSnapshot({ cursor: { epoch: 1, seq: 0 } }), todo: DONE };
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await flush();
    expect(header()).toBe("任务清单 3/3");
    await settleDeferredResponse(regen, jsonResponse({ assistantMessageId: 0 }, 202));
    await flush();
    expect(composerInput().disabled).toBe(true);
    expect(header()).toBe("任务清单 3/3");
    expect(statusWords()).toEqual(DONE_WORDS);
  });

  it("R4 is gone the moment 发送 is clicked and stays gone when the snapshot read after the 202 fails", async () => {
    const prompt = deferredResponse();
    const { page } = await completeInPlace({ [PROMPT]: () => prompt.promise });
    typeDraft("下一句");
    clickSend();
    await flush();
    expect(header()).toBeNull();
    page.messages = () => envelope(503, "agent_unavailable", "Agent 运行时不可用");
    await settleDeferredResponse(prompt, jsonResponse(promptAccepted, 202));
    await flush();
    expect(document.body.textContent).toContain("Agent 运行时不可用");
    expect(header()).toBeNull();
  });
});

describe("a list closed in place is not shown again after leaving the page state", () => {
  it("H1 shows no panel for a list closed on first load, nor after a reload of a kept list", async () => {
    await mountPage(done(DONE));
    expect(header()).toBeNull();
    await cleanupSessionMeta();
    await completeInPlace();
    await cleanupSessionMeta();
    await mountPage(done(DONE, 1));
    expect(header()).toBeNull();
  });

  it("H2 shows no panel after switching to a session with an unfinished list and back", async () => {
    await completeInPlace({
      [OTHER_MESSAGES]: () => jsonResponse({ ...otherSnapshot(), todo: OTHER_TODO }),
    });
    await selectTitle("other session", "other user");
    expect(header()).toBe("任务清单 0/1");
    await selectTitle("saved title", "answer");
    expect(header()).toBeNull();
  });

  it("H3 shows no panel after a round trip through the welcome state", async () => {
    await completeInPlace();
    fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "WorkBuddy，我帮你" })).toBeTruthy();
    expect(header()).toBeNull();
    await selectTitle("saved title", "answer");
    expect(header()).toBeNull();
  });
});

describe("发送 stopped while the staged files upload", () => {
  it("U1 is gone the moment 发送 is clicked and stays gone after 停止 in the upload stage", async () => {
    const created = view(CREATED, null, { status: "done", workspaceId: W });
    const snapshot = { ...done(ONE_OF_THREE, 0), session: created };
    await welcome({
      [messagesPath(CREATED)]: () => jsonResponse(snapshot),
      [`/api/sessions/${CREATED}/stop`]: () => new Response(null, { status: 204 }),
    });
    await pickOption(PROJECT_A_OPTION);
    await choose(file("a.pdf"));
    typeDraft("看看");
    await sendFirst();
    const stop = () => fireEvent.click(screen.getByRole("button", { name: "停止" }));
    stop();
    await flush();
    expect(header()).toBe("任务清单 1/3");
    const source = latestSource();
    act(() => source.emitOpen());
    await flush();
    emitTodo(source, 1, DONE);
    expect(header()).toBe("任务清单 3/3");

    clickSend();
    await flush();
    expect(xhr(1).aborts).toBe(0);
    expect(header()).toBeNull();
    stop();
    await flush();
    expect(xhr(1).aborts).toBe(1);
    expect(composerInput().value).toBe("看看");
    expect(header()).toBeNull();
  });
});
