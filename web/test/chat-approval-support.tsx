// 审批呈现（停靠区提问卡 + 消息内已结算记录）整页挂载测试的共用支撑：假 API 与假 EventSource。
import { act, screen, within } from "@testing-library/react";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { otherIdleSession } from "./chat-page-ownership-support.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";

export const T0 = 1_750_000_000_000;
export const TITLE = "Allow tool: bash\nReason: run ls";
export const OTHER_TITLE = "Allow tool: bash\nReason: run pwd";
export const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
export const PENDING = "需要你的确认";
export const ALLOWED = "已允许执行";
export const DENIED = "已拒绝执行";
export const TIMED_OUT = "超时自动允许";
export const UNAVAILABLE_502 = {
  error: { code: "agent_unavailable", message: "Agent 运行时不可用" },
};

export type Approval = ChatMessageSnapshot["messages"][number]["approvals"][number];
export type Decision = "allow" | "deny" | "timeout";
export type PageRoutes = {
  messages: () => Response | Promise<Response>;
  snapshot: ChatMessageSnapshot;
};

const COUNTDOWN = /内未操作将自动允许/;

export const approvalPath = (id: number) => `/api/sessions/${SESSION_ID}/approvals/${id}`;

export function approval(id: number, overrides: Partial<Approval> = {}): Approval {
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

export function settledBody(id: number, decision: Decision) {
  return jsonResponse(approval(id, { decision }));
}

/** 一条助手消息的快照行。 */
export function assistantRow(
  id: number,
  approvals: Approval[],
  status: "running" | "done" = "done",
): ChatMessageSnapshot["messages"][number] {
  return {
    id,
    role: "assistant",
    undo: null,
    approvals,
    content: `answer ${id}`,
    status,
    createdAt: id,
    steps: [],
    thinking: null,
  };
}

/** running 快照（assistant id 0），把 approvals 放进该条助手消息。 */
export function snapshotWith(approvals: Approval[], seq = 0): ChatMessageSnapshot {
  const base = chatSnapshot({ status: "running", cursor: { epoch: 1, seq } });
  return {
    ...base,
    messages: base.messages.map((message) =>
      message.role === "assistant" ? { ...message, approvals } : message,
    ),
  };
}

export async function flush(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(settle);
  }
}

/** 选中会话、读完历史并 open 实时源（open 会再拉一次快照），此后事件从 `1:<seq+1>` 起。 */
export async function mountPage(initial: ChatMessageSnapshot, routes: FetchRoutes = {}) {
  const page: PageRoutes = {
    snapshot: initial,
    messages: () => jsonResponse(page.snapshot),
  };
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [initial.session, otherIdleSession()] }),
    [MESSAGES]: () => page.messages(),
    ...routes,
  });
  // 不用 `waitFor`：它靠 `setInterval` 轮询，而这里的 `setInterval` 是假的（倒计时用），只剩 DOM 变动能唤醒它。
  for (let round = 0; round < 200 && FakeEventSource.instances.length === 0; round += 1) {
    await flush(1);
  }
  if (FakeEventSource.instances.length !== 1) throw new Error("event source not opened");
  const source = latestSource();
  act(() => {
    source.emitOpen();
  });
  await flush();
  return { fetchMock, page, source };
}

export function emitRequest(
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

export function emitResolved(
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

export function assistants() {
  return screen.getAllByRole("article", { name: "助手" });
}

/** 停靠区容器；没有待决审批时不在 DOM 里。 */
export function dock() {
  return document.querySelector<HTMLElement>('[data-slot="composer-dock"]');
}

/** 整页全部提问卡（文档顺序）。每张都必须在停靠区内、在所有消息 `article` 之外。 */
export function cards() {
  const found = screen.queryAllByRole("group", { name: PENDING });
  for (const card of found) {
    if (!dock()?.contains(card)) throw new Error("prompt card outside the composer dock");
    if (card.closest("article")) throw new Error("prompt card inside a message article");
  }
  return found;
}

/** 一条助手消息内的已结算记录（文档顺序）；工具调用组也是 `group`，按记录的钩子取。 */
export function records(article: HTMLElement = assistants()[0] as HTMLElement) {
  return [...article.querySelectorAll<HTMLElement>('[data-slot="approval-record"]')];
}

export function slotText(root: HTMLElement, slot: "approval-tool" | "approval-title") {
  return root.querySelector(`[data-slot="${slot}"]`)?.textContent;
}

export function button(group: HTMLElement, name: "允许" | "拒绝") {
  return within(group).getByRole("button", { name }) as HTMLButtonElement;
}

export function countdowns(group: HTMLElement) {
  return within(group).queryAllByText(COUNTDOWN);
}

export function composerInput() {
  return screen.getByRole("textbox", { name: "给助手发消息" }) as HTMLTextAreaElement;
}

export function stopButton() {
  return screen.getByRole("button", { name: "停止" }) as HTMLButtonElement;
}

export function bodies(fetchMock: ReturnType<typeof renderChatPage>["fetchMock"], path: string) {
  return calls(fetchMock, path).map(([, init]) => JSON.parse(String(init?.body)));
}

/** `record` 是 `article` 内名为 `name` 的记录：`role="group"`、无按钮、无倒计时句。 */
export function expectRecord(record: HTMLElement | undefined, name: string, article?: HTMLElement) {
  if (!record) throw new Error(`no settled record for ${name}`);
  const owner = article ?? (assistants()[0] as HTMLElement);
  if (!within(owner).getAllByRole("group", { name }).includes(record)) {
    throw new Error(`record is not a group named ${name} inside its message`);
  }
  if (within(record).queryAllByRole("button").length > 0) throw new Error("record has buttons");
  if (countdowns(record).length > 0) throw new Error("record has a countdown sentence");
}
