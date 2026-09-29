import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import {
  cleanupChatLifecycle,
  renderChatPageWithAuthProbe,
  renewAccount,
} from "./chat-page-lifecycle-support.js";
import {
  OTHER_MESSAGES,
  OTHER_SESSION_ID,
  otherIdleSession,
  otherSnapshot,
} from "./chat-page-ownership-support.js";
import { expectChatLocation, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

const T0 = 1_750_000_000_000;
const TITLE = "Allow tool: bash\nReason: run ls";
const OTHER_TITLE = "Allow tool: bash\nReason: run pwd";
const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const EVENTS_URL = `/api/sessions/${SESSION_ID}/events`;
const OTHER_EVENTS_URL = `/api/sessions/${OTHER_SESSION_ID}/events`;
const PENDING = "需要你的确认";
const ALLOWED = "已允许执行";
const DENIED = "已拒绝执行";
const COUNTDOWN = /内未操作将自动允许/;
const SETTLED_409 = { error: { code: "approval_settled", message: "该审批已处理" } };
const BUSY_409 = { error: { code: "session_busy", message: "会话正在生成，请稍候" } };
const UNAVAILABLE_502 = { error: { code: "agent_unavailable", message: "Agent 运行时不可用" } };

type Approval = ChatMessageSnapshot["messages"][number]["approvals"][number];
type Decision = "allow" | "deny" | "timeout";

const approvalPath = (id: number) => `/api/sessions/${SESSION_ID}/approvals/${id}`;

function approval(id: number, overrides: Partial<Approval> = {}): Approval {
  return {
    id,
    tool: "bash",
    title: TITLE,
    requestedAt: T0,
    expiresAt: T0 + 60_000,
    decision: null,
    ...overrides,
  };
}

function settledBody(id: number, decision: Decision) {
  return jsonResponse(approval(id, { decision }));
}

/** running 快照（assistant id 0），把 approvals 放进该条助手消息。 */
function snapshotWith(approvals: Approval[], seq = 0): ChatMessageSnapshot {
  const base = chatSnapshot({ status: "running", cursor: { epoch: 1, seq } });
  return {
    ...base,
    messages: base.messages.map((message) =>
      message.role === "assistant" ? { ...message, approvals } : message,
    ),
  };
}

type PageRoutes = { messages: () => Response | Promise<Response>; snapshot: ChatMessageSnapshot };

/** 选中会话、读完历史并 open 实时源（open 会再拉一次快照），此后事件从 `1:<seq+1>` 起。 */
async function mountPage(initial: ChatMessageSnapshot, routes: FetchRoutes = {}) {
  const page: PageRoutes = {
    snapshot: initial,
    messages: () => jsonResponse(page.snapshot),
  };
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [initial.session, otherIdleSession()] }),
    [MESSAGES]: () => page.messages(),
    ...routes,
  });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const source = latestSource();
  act(() => {
    source.emitOpen();
  });
  await flush();
  return { fetchMock, page, source };
}

async function flush(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(settle);
  }
}

function emitRequest(
  source: FakeEventSource,
  seq: number,
  approvalId: number,
  overrides: { messageId?: number; tool?: string; title?: string; expiresAt?: number } = {},
) {
  act(() => {
    source.emitData("approval.request", `1:${seq}`, {
      messageId: 0,
      approvalId,
      tool: "bash",
      title: TITLE,
      expiresAt: T0 + 60_000,
      ...overrides,
    });
  });
}

function emitResolved(
  source: FakeEventSource,
  seq: number,
  approvalId: number,
  decision: Decision,
  messageId = 0,
) {
  act(() => {
    source.emitData("approval.resolved", `1:${seq}`, { messageId, approvalId, decision });
  });
}

function assistants() {
  return screen.getAllByRole("article", { name: "助手" });
}

function bars(article = assistants()[0] as HTMLElement) {
  return within(article).getAllByRole("group");
}

function button(group: HTMLElement, name: "允许" | "拒绝") {
  return within(group).getByRole("button", { name }) as HTMLButtonElement;
}

function countdowns(group: HTMLElement) {
  return within(group).queryAllByText(COUNTDOWN);
}

function composerInput() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function bodies(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"], path: string) {
  return calls(fetchMock, path).map(([, init]) => JSON.parse(String(init?.body)));
}

function expectSettled(group: HTMLElement, header: string) {
  expect(group.getAttribute("aria-labelledby")).not.toBeNull();
  expect(within(group).queryAllByRole("button")).toHaveLength(0);
  expect(countdowns(group)).toHaveLength(0);
  expect(within(assistants()[0] as HTMLElement).getAllByRole("group", { name: header })).toContain(
    group,
  );
}

function sourcesFor(url: string) {
  return FakeEventSource.instances.filter((source) => source.url === url);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  cleanupChatLifecycle();
  vi.useRealTimers();
});

describe("approval bar: pending, countdown and settled headers", () => {
  it("A1 renders one pending bar with badge, full title, one countdown sentence and live buttons", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7);

    const article = assistants()[0] as HTMLElement;
    const groups = within(article).getAllByRole("group", { name: PENDING });
    expect(groups).toHaveLength(1);
    const group = groups[0] as HTMLElement;
    expect(group.querySelector(".chat-approval-tool")?.textContent).toBe("bash");
    expect(group.querySelector(".chat-approval-body")?.textContent).toBe(TITLE);
    // 条渲染在同一 `.chat-msg-main` 内、正文 `.chat-md` 之上
    const main = article.querySelector(".chat-msg-main");
    const list = main?.querySelector(".chat-approvals");
    const text = main?.querySelector(".chat-md");
    expect(list?.contains(group)).toBe(true);
    expect(list?.parentElement).toBe(main);
    expect(text?.parentElement).toBe(main);
    expect(
      (list as Element).compareDocumentPosition(text as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const sentences = countdowns(group);
    expect(sentences).toHaveLength(1);
    expect(sentences[0]?.textContent).toBe("（60s 内未操作将自动允许）");
    expect(within(group).queryByRole("progressbar")).toBeNull();
    expect(within(group).queryAllByText(/^\d+s$/)).toHaveLength(0);
    expect(button(group, "允许").disabled).toBe(false);
    expect(button(group, "拒绝").disabled).toBe(false);
    // 守卫：有 pending 审批时回合仍 running，composer 锁定
    expect(composerInput().disabled).toBe(true);
    expect(screen.getByText("生成中", { exact: true })).toBeTruthy();
  });

  it("A2 recomputes the countdown every second and floors it at 0 with buttons still live", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7);
    const group = bars()[0] as HTMLElement;

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdowns(group)[0]?.textContent).toBe("（59s 内未操作将自动允许）");
    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(countdowns(group)[0]?.textContent).toBe("（0s 内未操作将自动允许）");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(countdowns(group)).toHaveLength(1);
    expect(countdowns(group)[0]?.textContent).toBe("（0s 内未操作将自动允许）");
    expect(button(group, "允许").disabled).toBe(false);
    expect(button(group, "拒绝").disabled).toBe(false);
  });

  it("A3 sends allow exactly once, stays disabled across a snapshot swap and waits for approval.resolved", async () => {
    const answer = deferredResponse();
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => answer.promise,
    });
    emitRequest(source, 1, 7);
    const group = bars()[0] as HTMLElement;

    fireEvent.click(button(group, "允许"));
    fireEvent.click(button(group, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    expect(button(group, "允许").disabled).toBe(true);
    expect(button(group, "拒绝").disabled).toBe(true);
    expect(within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING })).toBe(
      group,
    );

    const reads = calls(fetchMock, MESSAGES).length;
    page.snapshot = snapshotWith([approval(7)], 1);
    act(() => {
      source.emitGap();
    });
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    const swapped = within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING });
    expect(button(swapped, "允许").disabled).toBe(true);
    expect(button(swapped, "拒绝").disabled).toBe(true);
    fireEvent.click(button(swapped, "允许"));
    await flush();
    expect(calls(fetchMock, approvalPath(7))).toHaveLength(1);

    answer.resolve(settledBody(7, "allow"));
    await flush();
    const answered = within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING });
    expect(answered.querySelector(".chat-approval-head")?.textContent).toContain(PENDING);
    expect(countdowns(answered)).toHaveLength(1);

    emitResolved(source, 2, 7, "allow");
    const settled = bars()[0] as HTMLElement;
    expectSettled(settled, ALLOWED);
    expect(settled.querySelector(".chat-approval-tool")?.textContent).toBe("bash");
    expect(settled.querySelector(".chat-approval-body")?.textContent).toBe(TITLE);
  });

  it("A4 maps deny to 已拒绝执行 and timeout to 已允许执行 without buttons or countdown", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    emitResolved(source, 3, 8, "deny");
    emitResolved(source, 4, 7, "timeout");

    const [seven, eight] = bars() as [HTMLElement, HTMLElement];
    expectSettled(seven, ALLOWED);
    expectSettled(eight, DENIED);
    expect(seven.querySelector(".chat-approval-body")?.textContent).toBe(TITLE);
    expect(eight.querySelector(".chat-approval-body")?.textContent).toBe(OTHER_TITLE);
  });

  it("A10 shows the tool field as the badge and never re-parses the title", async () => {
    const { source } = await mountPage(snapshotWith([]));
    emitRequest(source, 1, 7, { tool: "python", title: "Allow tool: bash\nReason: x" });
    const group = bars()[0] as HTMLElement;
    expect(group.querySelector(".chat-approval-tool")?.textContent).toBe("python");
    expect(within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING })).toBe(
      group,
    );
  });

  it("A11 keeps exactly one interval per list with pending bars and clears it once none is pending", async () => {
    const { source } = await mountPage(snapshotWith([]));
    expect(vi.getTimerCount()).toBe(0);
    emitRequest(source, 1, 7);
    expect(vi.getTimerCount()).toBe(1);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });
    expect(vi.getTimerCount()).toBe(1);
    emitResolved(source, 3, 7, "allow");
    expect(vi.getTimerCount()).toBe(1);
    emitResolved(source, 4, 8, "deny");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("approval bar: answer outcomes", () => {
  it("A5 reconciles a 409 approval_settled silently and reconnects from the new snapshot", async () => {
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    page.snapshot = snapshotWith([approval(7, { decision: "timeout" })], 1);

    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".ui-toast")).toBeNull();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
    expect(latestSource().url).toBe(EVENTS_URL);
    expectSettled(bars()[0] as HTMLElement, ALLOWED);
  });

  it("A5 counter-case: a 409 with another code is an inline error, re-enables and never reconciles", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(BUSY_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();

    expect(screen.getByRole("alert").textContent).toBe(BUSY_409.error.message);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(source.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    const group = bars()[0] as HTMLElement;
    expect(button(group, "允许").disabled).toBe(false);
    expect(button(group, "拒绝").disabled).toBe(false);
  });

  it("A5b keeps the live source and stays silent when the reconcile GET fails", async () => {
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    page.messages = () => jsonResponse(UNAVAILABLE_502, 502);

    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();

    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(source.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(1);
    const group = within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING });
    expect(button(group, "允许").disabled).toBe(true);
    expect(button(group, "拒绝").disabled).toBe(true);

    emitResolved(source, 2, 7, "timeout");
    expectSettled(bars()[0] as HTMLElement, ALLOWED);
  });

  it("A6 shows other envelopes inline, re-enables the bar and clears the alert on retry", async () => {
    const retry = deferredResponse();
    let answers = 0;
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => {
        answers += 1;
        return answers === 1 ? jsonResponse(UNAVAILABLE_502, 502) : retry.promise;
      },
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(button(bars()[0] as HTMLElement, "拒绝"));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Agent 运行时不可用");
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    const group = bars()[0] as HTMLElement;
    expect(button(group, "允许").disabled).toBe(false);
    expect(button(group, "拒绝").disabled).toBe(false);

    fireEvent.click(button(group, "拒绝"));
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([
      { decision: "deny" },
      { decision: "deny" },
    ]);
    expect(button(group, "拒绝").disabled).toBe(true);
  });

  it("A7 answers two bars of one message independently by their own ids", async () => {
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
      [approvalPath(8)]: () => settledBody(8, "deny"),
    });
    emitRequest(source, 1, 7);
    emitRequest(source, 2, 8, { title: OTHER_TITLE });

    const article = assistants()[0] as HTMLElement;
    const [seven, eight] = within(article).getAllByRole("group", { name: PENDING }) as [
      HTMLElement,
      HTMLElement,
    ];
    expect(bars()).toHaveLength(2);
    expect(seven.querySelector(".chat-approval-body")?.textContent).toBe(TITLE);
    expect(eight.querySelector(".chat-approval-body")?.textContent).toBe(OTHER_TITLE);
    expect(seven.compareDocumentPosition(eight) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button(eight, "拒绝"));
    await flush();
    expect(bodies(fetchMock, approvalPath(8))).toEqual([{ decision: "deny" }]);
    expect(calls(fetchMock, approvalPath(7))).toHaveLength(0);
    expect(button(eight, "允许").disabled).toBe(true);
    expect(button(eight, "拒绝").disabled).toBe(true);
    expect(button(seven, "允许").disabled).toBe(false);
    expect(button(seven, "拒绝").disabled).toBe(false);
    expect(countdowns(seven)).toHaveLength(1);

    emitResolved(source, 3, 8, "deny");
    expect(within(article).getByRole("group", { name: PENDING })).toBe(seven);
    expectSettled(bars()[1] as HTMLElement, DENIED);
    expect(composerInput().disabled).toBe(true);

    fireEvent.click(button(seven, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
    emitResolved(source, 4, 7, "allow");
    expectSettled(bars()[0] as HTMLElement, ALLOWED);
    expect(within(article).queryAllByRole("button", { name: /允许|拒绝/ })).toHaveLength(0);
  });
});

describe("approval bar: snapshot restore", () => {
  it("A8 restores a pending bar from the snapshot with the remaining seconds and keeps it answerable", async () => {
    const restored = approval(7, { requestedAt: T0 - 20_000, expiresAt: T0 + 40_000 });
    const { fetchMock } = await mountPage(snapshotWith([restored]), {
      [approvalPath(7)]: () => settledBody(7, "allow"),
    });
    const group = within(assistants()[0] as HTMLElement).getByRole("group", { name: PENDING });
    expect(countdowns(group)[0]?.textContent).toBe("（40s 内未操作将自动允许）");
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(countdowns(group)[0]?.textContent).toBe("（39s 内未操作将自动允许）");

    fireEvent.click(button(group, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);
  });

  it("A9 renders settled decisions from the snapshot and nothing for approvals: []", async () => {
    const assistant = (id: number, approvals: Approval[]) => ({
      id,
      role: "assistant" as const,
      approvals,
      content: `answer ${id}`,
      status: "done" as const,
      createdAt: id,
      steps: [] as [],
    });
    const snapshot: ChatMessageSnapshot = {
      ...chatSnapshot({ status: "done", cursor: { epoch: 1, seq: null } }),
      messages: [
        historyUser,
        assistant(0, [approval(7, { decision: "timeout" })]),
        assistant(1, [approval(8, { decision: "deny" })]),
        assistant(2, []),
      ],
    };
    await mountPage(snapshot);

    const [first, second, third] = assistants() as [HTMLElement, HTMLElement, HTMLElement];
    const allowed = within(first).getByRole("group", { name: ALLOWED });
    const denied = within(second).getByRole("group", { name: DENIED });
    for (const group of [allowed, denied]) {
      expect(within(group).queryAllByRole("button", { name: /允许|拒绝/ })).toHaveLength(0);
      expect(countdowns(group)).toHaveLength(0);
    }
    expect(within(third).queryAllByRole("group")).toHaveLength(0);
    expect(third.querySelector(".chat-approvals")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("approval bar: ownership fences", () => {
  async function switchToOther() {
    fireEvent.click(screen.getByRole("button", { name: "other session" }));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    await screen.findByText("other user", { exact: true });
    await flush();
  }

  it("A12 drops a late 409 after the user switched to another session", async () => {
    const answer = deferredResponse();
    const { fetchMock, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => answer.promise,
      [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
    });
    emitRequest(source, 1, 7);
    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();
    await switchToOther();
    const reads = calls(fetchMock, MESSAGES).length;
    expect(sourcesFor(OTHER_EVENTS_URL)).toHaveLength(1);

    answer.resolve(jsonResponse(SETTLED_409, 409));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(sourcesFor(EVENTS_URL)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A12b drops a reconcile snapshot that resolves after the user switched sessions", async () => {
    const reconcile = deferredResponse();
    const { fetchMock, page, source } = await mountPage(snapshotWith([]), {
      [approvalPath(7)]: () => jsonResponse(SETTLED_409, 409),
      [OTHER_MESSAGES]: () => jsonResponse(otherSnapshot()),
    });
    emitRequest(source, 1, 7);
    const reads = calls(fetchMock, MESSAGES).length;
    page.messages = () => reconcile.promise;
    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);

    await switchToOther();
    const [other] = sourcesFor(OTHER_EVENTS_URL);
    expect(other).toBeDefined();
    reconcile.resolve(jsonResponse(snapshotWith([approval(7, { decision: "timeout" })], 1)));
    await flush();

    expect(other?.closeCount).toBe(0);
    expect(sourcesFor(EVENTS_URL)).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("other user", { exact: true })).toBeTruthy();
    expect(screen.queryAllByRole("group", { name: ALLOWED })).toHaveLength(0);
  });

  it("A12c drops a late 409 after account renewal kept the same session selected", async () => {
    const answer = deferredResponse();
    const page: PageRoutes = {
      snapshot: snapshotWith([]),
      messages: () => jsonResponse(page.snapshot),
    };
    const { fetchMock, getProbe } = renderChatPageWithAuthProbe(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [page.snapshot.session] }),
      [MESSAGES]: () => page.messages(),
      [approvalPath(7)]: () => answer.promise,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = latestSource();
    act(() => {
      source.emitOpen();
    });
    await flush();
    emitRequest(source, 1, 7);
    page.snapshot = snapshotWith([approval(7)], 1);
    fireEvent.click(button(bars()[0] as HTMLElement, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(7))).toEqual([{ decision: "allow" }]);

    await renewAccount(getProbe);
    expect(await screen.findByText("lisi", { exact: true })).toBeTruthy();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(2);
    const renewed = latestSource();
    expect(renewed.url).toBe(EVENTS_URL);
    expect(source.closeCount).toBeGreaterThan(0);
    act(() => {
      renewed.emitOpen();
    });
    await flush();
    const reads = calls(fetchMock, MESSAGES).length;

    answer.resolve(jsonResponse(SETTLED_409, 409));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
    expect(renewed.closeCount).toBe(0);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("A13 answering leaves an in-flight prompt and its acceptance reconcile untouched", async () => {
    const prompt = deferredResponse();
    const done = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: "earlier answer",
      cursor: { epoch: 1, seq: 0 },
    });
    const { fetchMock, page, source } = await mountPage(done, {
      [PROMPT_PATH]: () => prompt.promise,
      [approvalPath(9)]: () => settledBody(9, "allow"),
    });
    await waitFor(() => expect(composerInput().disabled).toBe(false));
    fireEvent.change(composerInput(), { target: { value: "继续" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);

    // #633：新回合事件先于 202 到达且末条助手已 done，页面不本地追加，而是恢复一次快照；
    // 权威快照（游标 1:2）带助手 2 与待审批 9，审批条随快照装入后出现。
    page.snapshot = {
      session: { ...done.session, status: "running" },
      messages: [
        ...done.messages,
        { ...historyUser, id: 1, content: "继续", createdAt: 1 },
        {
          ...historyUser,
          id: 2,
          role: "assistant",
          status: "running",
          content: "",
          createdAt: 2,
          approvals: [approval(9)],
        },
      ],
      streamCursor: { epoch: 1, seq: 2 },
    };
    // 首次加载 + open 恢复。
    expect(calls(fetchMock, MESSAGES)).toHaveLength(2);
    act(() => {
      source.emitData("turn.start", "1:1", { messageId: 2 });
    });
    act(() => {
      source.emitData("approval.request", "1:2", {
        messageId: 2,
        approvalId: 9,
        tool: "bash",
        title: TITLE,
        expiresAt: T0 + 60_000,
      });
    });
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(3);
    expect(assistants()).toHaveLength(2);
    const turn = assistants()[1] as HTMLElement;
    const group = within(turn).getByRole("group", { name: PENDING });
    fireEvent.click(button(group, "允许"));
    await flush();
    expect(bodies(fetchMock, approvalPath(9))).toEqual([{ decision: "allow" }]);

    const reads = calls(fetchMock, MESSAGES).length;
    expect(reads).toBe(3);
    const sources = FakeEventSource.instances.length;
    prompt.resolve(jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });
});

describe("approval bar: source guards", () => {
  it("G1 messages.css keeps the full title as pre-wrap text", () => {
    const css = stripComments(readRepoFile("web/src/features/chat/messages.css"));
    expect(ruleBody(css, ".chat-approval-body")).toContain("white-space: pre-wrap;");
  });

  it("G2 turn-actions.ts owns no React state and does not import the page", () => {
    const source = readRepoFile("web/src/features/chat/turn-actions.ts");
    for (const banned of ["useState(", "useEffect(", "useRef(", "useMemo(", "./page.js"]) {
      expect(source).not.toContain(banned);
    }
  });
});
