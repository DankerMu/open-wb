import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { Icon } from "../src/ui/index.js";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import {
  cleanupChatPage,
  expectChatLocation,
  type FetchRoutes,
  renderChatPage,
} from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, deferredResponse, jsonResponse } from "./support.js";
import { listRepoFiles, readRepoFile, ruleBody, stripComments } from "./ui-support.js";

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const PROMPT_PATH = `/api/sessions/${SESSION_ID}/prompt`;
const STOP = `/api/sessions/${SESSION_ID}/stop`;
const OTHER_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const OTHER_STOP = `/api/sessions/${OTHER_SESSION_ID}/stop`;
const STOPPED_TOAST = "已停止生成";
const BADGE = "助手消息 已停止";
const PLACEHOLDER = "（已停止生成）";
const UNAVAILABLE_502 = { error: { code: "agent_unavailable", message: "Agent 运行时不可用" } };
const CAPACITY_503 = { error: { code: "agent_capacity", message: "Agent 容量已满，请稍后重试" } };

type Snapshot = ChatMessageSnapshot;
type SnapshotMessage = Snapshot["messages"][number];
type SnapshotStep = SnapshotMessage["steps"][number];
type Status = SnapshotMessage["status"];

function bashStep(status: SnapshotStep["status"]): SnapshotStep {
  return { id: 11, ordinal: 0, name: "bash", detail: '{"command":"sleep 9"}', output: "", status };
}

/** 快照 R：`saved title` running，助手 0 running、空正文、一条 running `bash` 步骤，cursor `1:0`。 */
function runningR(sessionId = SESSION_ID, title = "saved title"): Snapshot {
  const base = chatSnapshot({ sessionId, steps: [bashStep("running")] });
  return { ...base, session: { ...base.session, title } };
}

function doneSnapshot(content = "earlier answer"): Snapshot {
  return chatSnapshot({
    status: "done",
    assistantStatus: "done",
    content,
    cursor: { epoch: 1, seq: 0 },
  });
}

const noContent = () => new Response(null, { status: 204 });
const accepted = () => jsonResponse({}, 202);

type Page = { snapshot: Snapshot; messages: () => Response | Promise<Response> };

/** 选中会话、读完历史并 open 实时源（open 会再拉一次快照），此后事件从 `1:1` 起。 */
async function mountPage(initial: Snapshot, routes: FetchRoutes = {}, extra: Snapshot[] = []) {
  const page: Page = { snapshot: initial, messages: () => jsonResponse(page.snapshot) };
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () =>
      jsonResponse({ sessions: [initial.session, ...extra.map(({ session }) => session)] }),
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

function emit(type: string, seq: number, data: unknown) {
  act(() => {
    latestSource().emitData(type, `1:${seq}`, data);
  });
}

function toolbar() {
  const element = document.querySelector<HTMLElement>("form .chat-composer-toolbar");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function stopButton() {
  return within(toolbar()).getByRole("button", { name: "停止" }) as HTMLButtonElement;
}

function composerInput() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

function assistants() {
  return screen.getAllByRole("article", { name: "助手" });
}

function nav() {
  return screen.getByRole("navigation", { name: "会话列表" });
}

function toastText(message: string) {
  return screen.queryByText(message);
}

function expectRunningComposer() {
  expect(within(toolbar()).getByText("生成中", { exact: true })).toBeTruthy();
  expect(composerInput().disabled).toBe(true);
}

function expectSendBack() {
  const bar = toolbar();
  expect(within(bar).getByRole("button", { name: "发送" })).toBeTruthy();
  expect(within(bar).queryByRole("button", { name: "停止" })).toBeNull();
  expect(within(bar).queryByText("生成中")).toBeNull();
}

function sendDraft(text: string) {
  fireEvent.change(composerInput(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "发送" }));
}

function follows(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

afterEach(() => {
  cleanupChatPage();
});

describe("stop button: layout and outcomes", () => {
  it("S1 replaces send with an enabled round 停止 button after the 生成中 status", async () => {
    await mountPage(runningR());
    const bar = toolbar();
    expect(within(bar).queryByRole("button", { name: "发送" })).toBeNull();
    const buttons = within(bar).getAllByRole("button");
    expect(buttons).toHaveLength(1);
    const stop = buttons[0] as HTMLButtonElement;
    expect(stop.getAttribute("aria-label")).toBe("停止");
    expect(stop.disabled).toBe(false);
    expect(stop.type).toBe("button");
    expect(stop.title).toBe("停止");
    expect(stop.classList.contains("ui-btn--primary")).toBe(true);
    expect(stop.querySelector("svg.lucide-square")).not.toBeNull();
    const status = within(bar).getByRole("status");
    expect(status.textContent).toBe("生成中");
    expect(follows(status, stop)).toBe(true);
    expect(composerInput().disabled).toBe(true);
  });

  it("S2 stops once per in-flight click, toasts on 202 and renders 已停止 from turn.end", async () => {
    const stop = deferredResponse();
    const { fetchMock, page } = await mountPage(runningR(), {
      [STOP]: () => stop.promise,
      [PROMPT_PATH]: () => jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202),
    });

    fireEvent.click(stopButton());
    fireEvent.click(stopButton());
    await flush();
    const stops = calls(fetchMock, STOP);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[1]?.method).toBe("POST");
    expect(stops[0]?.[1]?.body).toBeUndefined();
    expect(stopButton().disabled).toBe(true);
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(0);

    stop.resolve(accepted());
    await flush();
    const region = within(screen.getByRole("region", { name: "通知" }));
    expect(region.getByText(STOPPED_TOAST)).toBeTruthy();
    expect(composerInput().disabled).toBe(true);

    emit("turn.end", 1, { messageId: 0, status: "stopped" });
    await flush();
    expectSendBack();
    const article = assistants()[0] as HTMLElement;
    const badge = within(article).getByRole("status", { name: BADGE });
    expect(badge.textContent).toBe("已停止");
    expect(within(article).queryByRole("alert")).toBeNull();
    const body = article.querySelector(".chat-md");
    expect(body?.textContent).toBe(PLACEHOLDER);
    expect(article.querySelector(".ui-caret")).toBeNull();
    expect(within(article).getByRole("status", { name: "bash 已停止" })).toBeTruthy();
    const listed = within(nav()).getByRole("status", { name: "saved title 已停止" });
    expect(
      listed.querySelector(".chat-session-dot")?.classList.contains("chat-session-dot-stopped"),
    ).toBe(true);

    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    page.snapshot = runningR();
    sendDraft("继续");
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });

  it("S3 treats 204 as passive: no toast, no view write, no reconcile", async () => {
    const { fetchMock, page } = await mountPage(runningR(), { [STOP]: noContent });
    const reads = calls(fetchMock, MESSAGES).length;

    fireEvent.click(stopButton());
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(1);
    expect(toastText(STOPPED_TOAST)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(stopButton().disabled).toBe(false);
    expectRunningComposer();
    expect(within(nav()).getByRole("status", { name: "saved title 运行中" })).toBeTruthy();
    expect((assistants()[0] as HTMLElement).querySelector(".ui-caret")).not.toBeNull();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);

    page.snapshot = doneSnapshot("完");
    act(() => {
      latestSource().emitGap();
    });
    await flush();
    expectSendBack();
    expect(screen.queryAllByRole("status", { name: BADGE })).toHaveLength(0);
  });

  it("S4 stays clickable after a 202 that never yields turn.end, across a gap reinstall", async () => {
    const { fetchMock } = await mountPage(runningR(), { [STOP]: accepted });

    fireEvent.click(stopButton());
    await flush();
    expect(toastText(STOPPED_TOAST)).not.toBeNull();
    expectRunningComposer();
    expect(stopButton().disabled).toBe(false);

    act(() => {
      latestSource().emitGap();
    });
    await flush();
    expectRunningComposer();
    expect(stopButton().disabled).toBe(false);

    fireEvent.click(stopButton());
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(2);
  });

  it("S5 shows an error envelope inline, re-enables and clears the alert on the next click", async () => {
    const retry = deferredResponse();
    let stops = 0;
    const { fetchMock } = await mountPage(runningR(), {
      [STOP]: () => {
        stops += 1;
        return stops === 1 ? jsonResponse(UNAVAILABLE_502, 502) : retry.promise;
      },
    });

    fireEvent.click(stopButton());
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("Agent 运行时不可用");
    expect(toastText(STOPPED_TOAST)).toBeNull();
    expect(stopButton().disabled).toBe(false);
    expect(composerInput().disabled).toBe(true);

    fireEvent.click(stopButton());
    expect(screen.queryByRole("alert")).toBeNull();
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(2);
    expect(stopButton().disabled).toBe(true);
  });

  it("S6 keeps 停止 available while an approval is pending", async () => {
    const { fetchMock } = await mountPage(runningR(), { [STOP]: accepted });
    emit("approval.request", 1, {
      messageId: 0,
      approvalId: 7,
      tool: "bash",
      title: "Allow tool: bash",
      expiresAt: Date.now() + 60_000,
    });
    const article = assistants()[0] as HTMLElement;
    const group = within(article).getByRole("group", { name: "需要你的确认" });
    expect(
      (within(group).getByRole("button", { name: "允许" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(stopButton().disabled).toBe(false);
    expect(composerInput().disabled).toBe(true);

    fireEvent.click(stopButton());
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(1);

    emit("approval.resolved", 2, { messageId: 0, approvalId: 7, decision: "deny" });
    const denied = within(assistants()[0] as HTMLElement).getByRole("group", {
      name: "已拒绝执行",
    });
    expect(within(denied).queryAllByRole("button")).toHaveLength(0);
    emit("turn.end", 3, { messageId: 0, status: "stopped" });
    await flush();
    expect(
      within(assistants()[0] as HTMLElement).getByRole("status", { name: BADGE }),
    ).toBeTruthy();
    expectSendBack();
  });
});

describe("stop button: ownership and fences", () => {
  it.each([
    ["202", () => accepted()],
    ["502", () => jsonResponse(UNAVAILABLE_502, 502)],
  ])("S7 drops a late %s for session A after switching to running session B", async (_, late) => {
    const stopA = deferredResponse();
    const other = runningR(OTHER_SESSION_ID, "other session");
    const { fetchMock } = await mountPage(
      runningR(),
      {
        [STOP]: () => stopA.promise,
        [OTHER_MESSAGES]: () => jsonResponse(other),
        [OTHER_STOP]: noContent,
      },
      [other],
    );
    fireEvent.click(stopButton());
    await flush();
    expect(stopButton().disabled).toBe(true);

    fireEvent.click(within(nav()).getByRole("button", { name: "other session" }));
    await expectChatLocation(`/?session=${OTHER_SESSION_ID}`);
    await flush();
    await waitFor(() => expect(stopButton().disabled).toBe(false));
    fireEvent.click(stopButton());
    await flush();
    expect(calls(fetchMock, OTHER_STOP)).toHaveLength(1);
    expect(calls(fetchMock, STOP)).toHaveLength(1);

    stopA.resolve(late());
    await flush();
    expect(toastText(STOPPED_TOAST)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expectRunningComposer();
  });

  it("S8 leaves an in-flight prompt and its acceptance reconcile untouched", async () => {
    const prompt = deferredResponse();
    const { fetchMock, page, source } = await mountPage(doneSnapshot(), {
      [PROMPT_PATH]: () => prompt.promise,
      [STOP]: accepted,
    });
    await waitFor(() => expect(composerInput().disabled).toBe(false));
    sendDraft("继续");
    await flush();
    expect(calls(fetchMock, PROMPT_PATH)).toHaveLength(1);

    expect(stopButton().disabled).toBe(false);
    fireEvent.click(stopButton());
    await flush();
    expect(calls(fetchMock, STOP)).toHaveLength(1);

    const reads = calls(fetchMock, MESSAGES).length;
    const sources = FakeEventSource.instances.length;
    page.snapshot = runningR();
    prompt.resolve(jsonResponse({ userMessageId: 1, assistantMessageId: 2 }, 202));
    await flush();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads + 1);
    expect(source.closeCount).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(sources + 1);
  });

  it("S9 renders a disabled 停止 while a welcome-state create is pending", async () => {
    const create = deferredResponse();
    const { fetchMock } = renderChatPage("/", {
      "/api/sessions": (_path: string, init?: RequestInit) =>
        init?.method === "POST" ? create.promise : jsonResponse({ sessions: [] }),
    });
    await screen.findByRole("button", { name: "新建会话" });
    sendDraft("hi");
    await flush();

    const stop = stopButton();
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    await flush();
    const stopCalls = fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/stop"));
    expect(stopCalls).toHaveLength(0);
    expect(within(toolbar()).getByText("生成中", { exact: true })).toBeTruthy();
  });
});

describe("stop button: stopped presentation from snapshots", () => {
  function message(id: number, role: "user" | "assistant", status: Status, content: string) {
    return {
      ...historyUser,
      id,
      role,
      status,
      content,
      createdAt: id,
      steps: [] as SnapshotStep[],
    };
  }

  it("S10 badges and placeholders only stopped assistants", async () => {
    const a1 = { ...message(2, "assistant", "stopped", "部分回答"), steps: [bashStep("stopped")] };
    const base = chatSnapshot({ status: "done", cursor: { epoch: 1, seq: null } });
    const snapshot: Snapshot = {
      ...base,
      session: { ...base.session, status: "failed" },
      messages: [
        message(1, "user", "done", "q1"),
        a1,
        message(3, "user", "done", "q2"),
        message(4, "assistant", "stopped", ""),
        message(5, "user", "done", "q3"),
        message(6, "assistant", "done", "完成回答"),
        message(7, "user", "done", "q4"),
        message(8, "assistant", "failed", ""),
      ],
    };
    await mountPage(snapshot);

    const articles = assistants();
    expect(articles).toHaveLength(4);
    const badges = articles.map((article) =>
      within(article).queryAllByRole("status", { name: BADGE }),
    );
    expect(badges.map((list) => list.length)).toEqual([1, 1, 0, 0]);
    const placeholders = articles.map((article) => within(article).queryAllByText(PLACEHOLDER));
    expect(placeholders.map((list) => list.length)).toEqual([0, 1, 0, 0]);
    const [first, second] = articles as [HTMLElement, HTMLElement];
    expect(first.querySelector(".chat-md")?.textContent).toBe("部分回答");
    expect(within(first).queryByRole("alert")).toBeNull();
    expect(within(second).queryByRole("alert")).toBeNull();
    expect(within(first).queryByRole("button", { name: "复制" })).not.toBeNull();
    expect(within(second).queryByRole("button", { name: "复制" })).toBeNull();
    const badge = badges[0]?.[0] as HTMLElement;
    expect(badge.textContent).toBe("已停止");
    expect(follows(first.querySelector(".chat-md") as Element, badge)).toBe(true);
    expect(follows(badge, first.querySelector(".chat-msg-actions") as Element)).toBe(true);
    expect(within(nav()).getByRole("status", { name: "saved title 失败" })).toBeTruthy();
    expect(within(first).getByRole("status", { name: "bash 已停止" })).toBeTruthy();
    expect(within(toolbar()).getByRole("button", { name: "发送" })).toBeTruthy();
    expect(within(toolbar()).queryByText("生成中")).toBeNull();
  });

  it("S11 registers the square, refresh-cw and git-branch icons", () => {
    for (const name of ["square", "refresh-cw", "git-branch"] as const) {
      const { container, unmount } = render(<Icon name={name} />);
      const svgs = container.querySelectorAll("svg");
      expect(svgs).toHaveLength(1);
      expect(svgs[0]?.classList.contains(`lucide-${name}`)).toBe(true);
      unmount();
    }
  });
});

describe("stop button: capacity and source guards", () => {
  it("S12 shows the 503 agent_capacity envelope inline and unlocks with the draft kept", async () => {
    const { fetchMock } = await mountPage(doneSnapshot(), {
      [PROMPT_PATH]: () => jsonResponse(CAPACITY_503, 503),
    });
    await waitFor(() => expect(composerInput().disabled).toBe(false));
    const reads = calls(fetchMock, MESSAGES).length;
    sendDraft("重试一下");
    await flush();

    expect(screen.getByRole("alert").textContent).toBe(CAPACITY_503.error.message);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(composerInput().disabled).toBe(false);
    expect(composerInput().value).toBe("重试一下");
    const send = within(toolbar()).getByRole("button", { name: "发送" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    expect(within(toolbar()).queryByRole("button", { name: "停止" })).toBeNull();
    expect(calls(fetchMock, MESSAGES)).toHaveLength(reads);
  });

  it("S13 styles the stopped dot and step badge with semantic tokens only", () => {
    const rules = [
      ["web/src/features/chat/chat.css", ".chat-session-dot-stopped"],
      ["web/src/features/chat/messages.css", ".chat-step-status-stopped"],
    ] as const;
    for (const [file, selector] of rules) {
      const body = ruleBody(stripComments(readRepoFile(file)), selector);
      const values = body
        .split(";")
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => declaration.slice(declaration.indexOf(":") + 1).trim());
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value.startsWith("var(--wb-")).toBe(true);
      }
    }
  });

  it("G4 keeps the capacity copy out of web/src (it comes from the envelope)", () => {
    const files = listRepoFiles("web/src", (path) => /\.tsx?$/.test(path));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readRepoFile(file)).not.toContain("容量已满");
    }
  });
});
