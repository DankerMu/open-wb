// 文件变更卡（issue #535）测试的夹具与页面查询：快照搭法、带工作空间列表的会话页挂载、事件推送、
// 卡片行的读取。只供 chat-page-file-changes.test.tsx 使用。
import { act, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { type FetchRoutes, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
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

/**
 * `historyUser` (id -3) then one assistant (id 0) whose status the session shares; the session is
 * bound to `workspaceId` and the stream cursor is `1:3`.
 */
export function turn(
  status: Message["status"],
  fields: Partial<Message> = {},
  workspaceId: string | null = PROJ.id,
): Snapshot {
  const reply: Message = {
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
  return {
    session: { ...chatSnapshot().session, status, workspaceId },
    messages: [historyUser, reply],
    streamCursor: { epoch: 1, seq: 3 },
  };
}

/** Lets pending fetches, their JSON bodies and the renders they cause finish. */
export async function quiesce() {
  await act(async () => {
    for (let turns = 0; turns < 3; turns += 1) await settle();
  });
}

export const listed = () => jsonResponse({ workspaces: [OTHER, PROJ] });

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
  await screen.findByRole("article", { name: "助手" });
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

/** `tag.class` of every child of the assistant's `.chat-msg-main`, in document order. */
export function replyParts() {
  const main = reply().querySelector(".chat-msg-main");
  if (!main) throw new Error("助手消息缺少 .chat-msg-main");
  return [...main.children];
}

export const tagAndClass = (part: Element) => `${part.localName}.${part.className}`;

export function cards() {
  return [...document.querySelectorAll(".file-changes-card")];
}

/** The card named `name` inside the assistant message. */
export function cardNamed(name: string) {
  return within(reply()).getByRole("group", { name });
}

/** Per row, the `[class, text]` of each span in document order. */
export function rowCells(card: HTMLElement) {
  return [...card.querySelectorAll(".file-change-row")].map((line) =>
    [...line.children]
      .filter((cell) => cell.localName === "span")
      .map((cell) => [cell.className, cell.textContent]),
  );
}

export function rowTexts(card: HTMLElement) {
  return [...card.querySelectorAll(".file-change-row")].map((line) => line.textContent);
}

export function detailButtons() {
  return screen.queryAllByRole("button", { name: DETAILS });
}

export function stepBadge(name: string) {
  return within(reply()).getByRole("status", { name });
}
