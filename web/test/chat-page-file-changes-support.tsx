// 文件变更卡（issue #535）测试的夹具与页面查询：快照搭法、冻结的 reducer 输入、已装快照的连接器、
// 带工作空间列表的会话页挂载、事件推送、卡片行的读取。chat-page-file-changes.test.tsx 与其它整页测试（产物卡、产物面板、搜索、斜杠菜单、项目配置）共用。
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { expandToolGroups, type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  connectChat,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";

export type Snapshot = ChatMessageSnapshot;
export type Message = Snapshot["messages"][number];
type Step = Message["steps"][number];
export type Change = NonNullable<Step["changes"]>[number];

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
export const WORKSPACES = "/api/workspaces";
/** No page text or attribute may hold this prefix: both workspace roots start with it. */
export const ROOT_PREFIX = "/srv/wb-private-root";
export const PROJ = {
  id: "5".repeat(32),
  name: "项目",
  dir: "proj",
  root: `${ROOT_PREFIX}/u-1/proj`,
  createdAt: 1_740_000_000_000,
};
const OTHER = {
  ...PROJ,
  id: "6".repeat(32),
  name: "别的空间",
  dir: "other",
  root: `${ROOT_PREFIX}/u-1/other`,
};
export const UNLISTED_ID = "9".repeat(32);
const DETAILS = /^查看详情/;

export const edit = (path: string, added: number, removed: number): Change => ({
  path,
  added,
  removed,
  kind: "edit",
});
export const write = (path: string): Change => ({
  path,
  added: null,
  removed: null,
  kind: "write",
});

/** Snapshot step whose `detail` is `<name> args`; a running one has no output yet. */
export function toolStep(
  id: number,
  ordinal: number,
  name: string,
  changes: Step["changes"],
  status: Step["status"] = "done",
): Step {
  const output = status === "running" ? "" : "ok";
  return { id, ordinal, name, detail: `${name} args`, output, changes, status };
}

/** An empty assistant message (id 0) in `status`, overridden by `fields`. */
export function assistantMessage(
  status: Message["status"],
  fields: Partial<Message> = {},
): Message {
  return {
    id: 0,
    role: "assistant",
    content: "",
    thinking: null,
    status,
    createdAt: 0,
    steps: [],
    approvals: [],
    ...fields,
  };
}

/**
 * `historyUser` (id -3) then one assistant (id 0) whose status the session shares; the session is
 * bound to `workspaceId` and the stream cursor is `1:3`.
 */
export function turn(
  status: Message["status"],
  fields: Partial<Message> = {},
  workspaceId: string | null = PROJ.id,
): Snapshot {
  return {
    session: { ...chatSnapshot().session, status, workspaceId },
    messages: [historyUser, assistantMessage(status, fields)],
    streamCursor: { epoch: 1, seq: 3 },
    todo: null,
  };
}

/** Deep-freezes `value`: a reducer or a summary that writes to its input throws. */
export function deepFrozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFrozen);
    Object.freeze(value);
  }
  return value;
}

export const viewOf = (snapshot: Snapshot): ChatState =>
  deepFrozen(chatStateFromSnapshot(snapshot));

export function filesChanged(messageId: number, stepId: number, ...files: Change[]): ChatEvent {
  return { type: "files.changed", data: { messageId, stepId, files } };
}

/** Applies `events` in order, freezing every intermediate state. */
export function reduce(state: ChatState, ...events: ChatEvent[]): ChatState {
  return events.reduce((current, event) => deepFrozen(applyChatEvent(current, event)), state);
}

/** Connector over a running turn holding running step 5, with the `1:3` snapshot installed. */
export async function installed() {
  const snapshot = turn("running", { steps: [toolStep(5, 0, "write", null, "running")] });
  const wire = connectChat(snapshot);
  wire.source.emitOpen();
  wire.loads[0]?.resolve(snapshot);
  await settle();
  expect(wire.snapshots).toHaveLength(1);
  return wire;
}

/** Lets pending fetches, their JSON bodies and the renders they cause finish. */
export async function quiesce() {
  await act(async () => {
    for (let turns = 0; turns < 3; turns += 1) await settle();
  });
}

export const listed = () => jsonResponse({ workspaces: [OTHER, PROJ] });

/**
 * Session-list route holding `snapshot`'s session and a neighbour bound to PROJ. The sidebar files
 * the neighbour under 未知空间 until the workspace list is installed, then under PROJ's name.
 */
export const withNeighbour = (snapshot: Snapshot): FetchRoutes => {
  const neighbour = {
    ...snapshot.session,
    id: "a".repeat(32),
    title: "邻居会话",
    workspaceId: PROJ.id,
  };
  return { "/api/sessions": () => jsonResponse({ sessions: [snapshot.session, neighbour] }) };
};

/** The sidebar group named after PROJ: present only once the page holds the workspace list. */
export function listedGroup() {
  return screen.queryByRole("group", { name: PROJ.name });
}

/** Opens the session page on `snapshot`; `workspaces` answers every workspace-list read. */
export async function openSession(
  snapshot: Snapshot,
  workspaces: FetchRoutes[string] = listed,
  more: FetchRoutes = {},
) {
  const page = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
    [WORKSPACES]: workspaces,
    [MESSAGES]: () => jsonResponse(snapshot),
    ...more,
  });
  await screen.findAllByRole("article", { name: "助手" });
  await waitFor(() => expect(calls(page.fetchMock, WORKSPACES).length).toBeGreaterThan(0));
  await quiesce();
  return page;
}

/** Reopens the live source (one snapshot reload); the returned sender numbers frames from `1:4`. */
export async function goLive() {
  const source = latestSource();
  act(() => source.emitOpen());
  await quiesce();
  let seq = 3;
  return (type: string, data: Record<string, unknown>) => {
    seq += 1;
    act(() => source.emitData(type, `1:${seq}`, { messageId: 0, ...data }));
  };
}

export function reply() {
  return screen.getByRole("article", { name: "助手" });
}

/** Every child of the assistant's `message-content` column, in document order. */
export function replyParts() {
  const main = reply().querySelector('[data-slot="message-content"]');
  if (!main) throw new Error("助手消息缺少 message-content");
  return [...main.children];
}

/** A part's name: `data-slot` on the thread's own markup, `tag.class` on the slotted old components. */
export const tagAndClass = (part: Element) =>
  part.getAttribute("data-slot") ?? `${part.localName}.${part.className}`;

export function cards() {
  return [...document.querySelectorAll('[data-slot="file-changes-card"]')];
}

/** The card named `name` inside the assistant message. */
export function cardNamed(name: string) {
  return within(reply()).getByRole("group", { name });
}

/** Per row, the `[data-slot, text]` of each span in document order. */
export function rowCells(card: HTMLElement) {
  return [...card.querySelectorAll('[data-slot="file-change-row"]')].map((line) =>
    [...line.children]
      .filter((cell) => cell.localName === "span")
      .map((cell) => [cell.getAttribute("data-slot"), cell.textContent]),
  );
}

export function rowTexts(card: HTMLElement) {
  return [...card.querySelectorAll('[data-slot="file-change-row"]')].map(
    (line) => line.textContent,
  );
}

export function detailButtons() {
  return screen.queryAllByRole("button", { name: DETAILS });
}

/** 助手消息里名为 `name` 的步骤徽章；步骤收在工具调用组里，先展开。 */
export function stepBadge(name: string) {
  expandToolGroups(reply());
  return within(reply()).getByRole("status", { name });
}
