/**
 * Issue #865 — session-todo「非法事件负载与未知回合」on the mounted page: an illegal `todo.updated`
 * payload and a valid one for a turn the settled view does not hold each cost exactly one more
 * history read, and the recovery snapshot replaces the view. A valid one for a known turn costs
 * none and leaves the page as it was once the list is cleared again. History reads are counted
 * exactly: first load 1 + open recovery 1 is the baseline.
 */
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  historyUser,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { calls, jsonResponse } from "./support.js";

const MESSAGES = `/api/sessions/${SESSION_ID}/messages`;
const LIST = {
  phases: [{ name: "准备", tasks: [{ content: "读取需求", status: "in_progress" as const }] }],
};

type Snapshot = ChatMessageSnapshot;
type Status = Snapshot["messages"][number]["status"];

function snapshotOf(
  assistant: { id: number; status: Status; content: string },
  seq: number,
  todo: Snapshot["todo"] = null,
): Snapshot {
  return {
    session: { ...chatSnapshot().session, status: assistant.status },
    messages: [
      historyUser,
      { ...historyUser, ...assistant, role: "assistant", createdAt: assistant.id },
    ],
    streamCursor: { epoch: 1, seq },
    todo,
  };
}

async function flush() {
  for (const _ of [1, 2, 3]) {
    await act(settle);
  }
}

async function mount(initial: Snapshot) {
  const messages = { reply: () => jsonResponse(initial) };
  const { fetchMock } = renderChatPage(`/?session=${SESSION_ID}`, {
    "/api/sessions": () => jsonResponse({ sessions: [initial.session] }),
    [MESSAGES]: () => messages.reply(),
  });
  await waitFor(() => expect(screen.queryAllByRole("article").length).toBeGreaterThan(0));
  const source = latestSource();
  act(() => source.emitOpen());
  await flush();
  const reads = () => calls(fetchMock, MESSAGES).length;
  expect(reads()).toBe(2);
  return { messages, source, reads };
}

function assistantBodies() {
  return screen
    .queryAllByRole("article", { name: "助手" })
    .map((article) => article.querySelector('[data-slot="message-body"]')?.textContent ?? "");
}

function expectHealthy(source: FakeEventSource) {
  expect(screen.queryAllByRole("alert")).toEqual([]);
  expect(source.closeCount).toBe(0);
  expect(FakeEventSource.instances).toHaveLength(1);
}

afterEach(() => {
  cleanupChatPage();
  vi.restoreAllMocks();
});

const OLD = snapshotOf({ id: 2, status: "done", content: "old" }, 0);
/** The authoritative snapshot: the turn the view never saw (3) and its list, cursor past `1:1`. */
const NEW = snapshotOf({ id: 3, status: "done", content: "new" }, 1, LIST);

describe("todo.updated on the mounted page", () => {
  it("re-reads history exactly once for a valid event of a turn the settled view does not hold", async () => {
    const { messages, reads, source } = await mount(OLD);
    expect(assistantBodies()).toEqual(["old"]);

    messages.reply = () => jsonResponse(NEW);
    act(() => source.emitData("todo.updated", "1:1", { messageId: 3, todo: LIST }));
    await flush();

    expect(reads()).toBe(3);
    expect(assistantBodies()).toEqual(["new"]);
    expectHealthy(source);

    // The installed snapshot holds turn 3 now: its next list update is reduced, not re-read.
    act(() => source.emitData("todo.updated", "1:2", { messageId: 3, todo: null }));
    await flush();
    expect(reads()).toBe(3);
    expect(assistantBodies()).toEqual(["new"]);
  });

  it.each<[string, unknown]>([
    ["a missing todo", { messageId: 2 }],
    ["empty phases", { messageId: 2, todo: { phases: [] } }],
    ["an extra key", { messageId: 2, todo: LIST, extra: 1 }],
  ])(
    "re-reads history exactly once for %s and installs the recovery snapshot",
    async (_label, data) => {
      const { messages, reads, source } = await mount(OLD);

      messages.reply = () => jsonResponse(NEW);
      act(() => source.emitData("todo.updated", "1:1", data));
      await flush();

      expect(reads()).toBe(3);
      expect(assistantBodies()).toEqual(["new"]);
      expectHealthy(source);
    },
  );

  it("reduces valid events of a known turn with no history read: a list set and cleared again leaves the page unchanged", async () => {
    const { reads, source } = await mount(OLD);
    const before = document.body.innerHTML;

    act(() => {
      source.emitData("todo.updated", "1:1", { messageId: 2, todo: LIST });
      source.emitData("todo.updated", "1:2", { messageId: 2, todo: null });
    });
    await flush();

    expect(reads()).toBe(2);
    expect(document.body.innerHTML).toBe(before);
    expectHealthy(source);
  });

  it("hands an unheld id to the reducer while a turn runs: no history read, no added message", async () => {
    const { reads, source } = await mount(
      snapshotOf({ id: 2, status: "running", content: "wip" }, 0),
    );
    const before = screen.queryAllByRole("article").length;

    act(() => source.emitData("todo.updated", "1:1", { messageId: 9, todo: LIST }));
    await flush();

    expect(reads()).toBe(2);
    expect(screen.queryAllByRole("article")).toHaveLength(before);
    expect(assistantBodies()).toEqual(["wip"]);
    expectHealthy(source);
  });
});
