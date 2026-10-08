// 撤回与列表事件的配合（session-list-push「web 列表事件消费」的场景「自己的撤回」）：本页针对该会话的撤回
// 在途时略过自己的 `session.rewound` 与重连补读；撤回没有以「200 被本页应用」告终时在落定处补读一次。
// seam：整页挂载 + 假 API / 假 EventSource。消息读取的计数都落在新的单会话连接 `emitOpen` 之前。
import "./radix-platform.js";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OTHER_SESSION_ID } from "./chat-page-ownership-support.js";
import { FakeEventSource, latestListSource, SESSION_ID, settle } from "./chat-stream-support.js";
import {
  alerts,
  CONFLICT,
  cleanupUndoPage,
  clickUndo,
  conflictDialog,
  envelope,
  expectRewound,
  FULL,
  flush,
  MESSAGES,
  mount,
  REWOUND_SESSION,
  S,
  selectInNav,
  snapshotOf,
  TRIMMED,
  textarea,
  transcript,
  UNDO,
  undoBodies,
  undone,
} from "./chat-undo-support.js";
import { calls, deferredResponse, type FetchMock, jsonResponse } from "./support.js";

const B_MESSAGES = `/api/sessions/${OTHER_SESSION_ID}/messages`;
const NETWORK_FAILED = "请求失败，请稍后重试";
/** 撤回已在服务端提交之后 A 的快照。 */
const REWOUND = snapshotOf(REWOUND_SESSION, S.messages.slice(0, 2));

afterEach(cleanupUndoPage);

/** 在列表连接上派发，并让由此发起的请求与渲染落定。 */
async function onList(run: (source: FakeEventSource) => void) {
  await act(async () => {
    run(latestListSource());
    await settle();
  });
  await flush();
}

function rewound(sessionId: string) {
  return onList((source) => source.emitNamed("session.rewound", JSON.stringify({ sessionId })));
}

function reads(fetchMock: FetchMock, path = MESSAGES) {
  return calls(fetchMock, path).length;
}

const OFFLINE = () => new TypeError("offline");

/** A 的消息读取：`committed()` 之前回挂载时的快照，之后回撤回后的快照。 */
function messagesOfA() {
  let committed = false;
  return {
    committed() {
      committed = true;
    },
    route: () => jsonResponse(committed ? REWOUND : S),
  };
}

/** 挂载 A，undo 的响应挂起；点 `撤回` 之后返回（请求在途）。 */
async function mountInFlight(withB = false) {
  const undo = deferredResponse();
  const messages = messagesOfA();
  const mounted = await mount(S, { [UNDO]: () => undo.promise, [MESSAGES]: messages.route }, withB);
  const baseline = reads(mounted.fetchMock);
  await clickUndo();
  expect(undoBodies(mounted.fetchMock)).toEqual(['{"messageId":3,"files":"restore"}']);
  expect(textarea().disabled).toBe(true);
  return { ...mounted, baseline, messages, undo };
}

describe("自己的撤回", () => {
  it("响应到达前收到自己的 session.rewound，随后 200：自点击起恰一次消息读取", async () => {
    const { baseline, fetchMock, messages, source, undo } = await mountInFlight();

    // 服务端先提交并广播，再回 200。
    messages.committed();
    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline);
    expect(transcript()).toEqual(FULL);

    await act(async () => {
      undo.resolve(undone());
      await settle();
    });
    await flush();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(reads(fetchMock)).toBe(baseline + 1);
    expect(source.closeCount).toBe(1);
    expectRewound();
  });

  it("收到该事件后 undo 以网络失败告终：失败之前没有读取，失败落定后恰补读一次并替换线程，错误照常显示", async () => {
    const { baseline, fetchMock, messages, undo } = await mountInFlight();

    // 服务端已提交并广播，响应丢在路上。
    messages.committed();
    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline);
    expect(transcript()).toEqual(FULL);

    await act(async () => {
      undo.reject(OFFLINE());
      await settle();
    });
    await flush();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(reads(fetchMock)).toBe(baseline + 1);
    expect(alerts()).toEqual([NETWORK_FAILED]);
    // 没有 200：草稿不动，输入框解锁。
    expect(textarea().value).toBe("");
    expect(textarea().disabled).toBe(false);
    expect(undoBodies(fetchMock)).toHaveLength(1);

    // 欠账已清：此后的同一事件按「另一个标签页的撤回」再读一次，而不是被略过。
    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline + 2);
  });

  it("没有收到事件的失败不补读", async () => {
    const { baseline, fetchMock, undo } = await mountInFlight();

    await rewound(OTHER_SESSION_ID);
    await act(async () => {
      undo.reject(OFFLINE());
      await settle();
    });
    await flush();
    expect(alerts()).toEqual([NETWORK_FAILED]);
    expect(reads(fetchMock)).toBe(baseline);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("收到该事件后 undo 以 401 告终：不补读", async () => {
    const { baseline, fetchMock, undo } = await mountInFlight();

    await rewound(SESSION_ID);
    await act(async () => {
      undo.resolve(jsonResponse(envelope("unauthorized", "登录已失效"), 401));
      await settle();
    });
    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    await flush();
    expect(reads(fetchMock)).toBe(baseline);
  });

  it("A 的撤回在途时已切到 B：B 的 session.rewound 恰读一次 B 的消息；A 被丢弃的响应不补读", async () => {
    const { baseline, fetchMock, undo } = await mountInFlight(true);
    // A 的事件先到（被略过），随后离开 A。
    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline);

    await selectInNav("other session", OTHER_SESSION_ID);
    await waitFor(() => expect(transcript()).toEqual(["B 问", "B 回答"]));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    const ofB = reads(fetchMock, B_MESSAGES);

    await rewound(OTHER_SESSION_ID);
    expect(reads(fetchMock, B_MESSAGES)).toBe(ofB + 1);
    expect(reads(fetchMock)).toBe(baseline);

    // A 的请求此时失败：已不属本页，不补读、不报错。
    await act(async () => {
      undo.reject(OFFLINE());
      await settle();
    });
    await flush();
    expect(reads(fetchMock)).toBe(baseline);
    expect(reads(fetchMock, B_MESSAGES)).toBe(ofB + 1);
    expect(alerts()).toEqual([]);
  });

  it("409 冲突对话框开着时不算在途：session.rewound 照常读一次", async () => {
    const { fetchMock } = await mount(S, { [UNDO]: CONFLICT });
    const baseline = reads(fetchMock);
    await clickUndo();
    expect(conflictDialog()).not.toBeNull();
    // 请求期间没有事件被略过：409 落定不补读。
    expect(reads(fetchMock)).toBe(baseline);

    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline + 1);
    expect(conflictDialog()).not.toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("收到该事件后 undo 以 409 undo_conflict 告终：落定处补读一次，对话框照常打开", async () => {
    const { baseline, fetchMock, messages, undo } = await mountInFlight();

    messages.committed();
    await rewound(SESSION_ID);
    expect(reads(fetchMock)).toBe(baseline);

    await act(async () => {
      undo.resolve(CONFLICT());
      await settle();
    });
    await flush();
    await waitFor(() => expect(transcript()).toEqual(TRIMMED));
    expect(reads(fetchMock)).toBe(baseline + 1);
    expect(conflictDialog()).not.toBeNull();
    expect(alerts()).toEqual([]);
  });

  it("在途期间列表连接重连，随后 200：恰一次消息读取", async () => {
    // 先让列表连接进入过打开状态：之后的 open 才是重连。
    const undo = deferredResponse();
    const { fetchMock, source } = await mount(S, { [UNDO]: () => undo.promise });
    await onList((list) => list.emitOpen());
    const baseline = reads(fetchMock);
    await clickUndo();

    await onList((list) => list.emitTransport());
    await onList((list) => list.emitOpen());
    expect(reads(fetchMock)).toBe(baseline);

    await act(async () => {
      undo.resolve(undone());
      await settle();
    });
    await flush();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(reads(fetchMock)).toBe(baseline + 1);
    expect(source.closeCount).toBe(1);
    expectRewound();
  });

  it("没有在途撤回时列表连接重连：照常补读一次", async () => {
    const { fetchMock } = await mount(S);
    await onList((list) => list.emitOpen());
    const baseline = reads(fetchMock);

    await onList((list) => list.emitTransport());
    await onList((list) => list.emitOpen());
    expect(reads(fetchMock)).toBe(baseline + 1);
  });
});
