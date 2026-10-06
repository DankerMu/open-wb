// 运行时接入（design D1）：`isRunning` 只跟末条助手消息走，运行时不注入乐观的助手占位；
// 输入框的锁定仍由应用自己的状态驱动（chat-web「锁定不等于生成中」「首次发送前不出现占位助手块」）。
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatState } from "../src/features/chat/stream.js";
import { useThreadRuntime } from "../src/features/chat/use-thread-runtime.js";
import {
  CREATED_MESSAGES,
  CREATED_PROMPT,
  CREATED_SESSION_ID,
  composer,
  idleCreatedSession,
  PROMPT,
  promptAccepted,
  runningCreatedSnapshot,
  SESSION_MESSAGES,
  typeAndSend,
} from "./chat-page-ownership-support.js";
import { cleanupChatPage, expectChatLocation, renderChatPage } from "./chat-page-support.js";
import {
  chatSnapshot,
  FakeEventSource,
  latestSource,
  SESSION_ID,
  settle,
} from "./chat-stream-support.js";
import { deferredResponse, jsonResponse } from "./support.js";

type View = ChatState["messages"][number];

const CARET = '[data-slot="message-caret"]';

afterEach(() => {
  cleanupChatPage();
});

function view(id: number, role: View["role"], status: View["status"], content = "x"): View {
  return { id, role, content, thinking: null, status, steps: [], approvals: [], error: null };
}

/** 只挂 hook：经运行时自己的线程接口读状态、触发三个回调。 */
function mountRuntime(initial: View[]) {
  const onSend = vi.fn<(prompt: string) => void>();
  const onStop = vi.fn<() => Promise<unknown>>().mockResolvedValue("stopping");
  const onRegenerate = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const held: { runtime?: ReturnType<typeof useThreadRuntime> } = {};
  function Harness({ messages }: { messages: View[] }) {
    held.runtime = useThreadRuntime({ messages, onRegenerate, onSend, onStop });
    return null;
  }
  const mounted = render(<Harness messages={initial} />);
  const thread = () => {
    if (!held.runtime) throw new Error("运行时未创建");
    return held.runtime.thread;
  };
  return {
    onRegenerate,
    onSend,
    onStop,
    thread,
    state: () => {
      const { isRunning, messages } = thread().getState();
      return { isRunning, ids: messages.map((message) => message.id) };
    },
    update: (messages: View[]) => mounted.rerender(<Harness messages={messages} />),
  };
}

describe("useThreadRuntime：运行态只在末条为 running 助手消息时为真", () => {
  it("空线程、末条是用户消息、末条助手已终态时都不在运行，也没有多出来的消息", () => {
    const runtime = mountRuntime([]);
    expect(runtime.state()).toEqual({ isRunning: false, ids: [] });

    runtime.update([view(1, "user", "done")]);
    expect(runtime.state()).toEqual({ isRunning: false, ids: ["1"] });

    for (const status of ["done", "failed", "stopped"] as const) {
      runtime.update([view(1, "user", "done"), view(2, "assistant", status)]);
      expect(runtime.state()).toEqual({ isRunning: false, ids: ["1", "2"] });
    }
  });

  it("末条是 running 助手消息时在运行；更早的 running 助手消息不算", () => {
    const runtime = mountRuntime([view(1, "user", "done"), view(2, "assistant", "running")]);
    expect(runtime.state()).toEqual({ isRunning: true, ids: ["1", "2"] });

    runtime.update([
      view(1, "user", "done"),
      view(2, "assistant", "running"),
      view(3, "user", "done"),
    ]);
    expect(runtime.state()).toEqual({ isRunning: false, ids: ["1", "2", "3"] });
  });

  it("onNew 把追加的文本交给发送路径，onCancel 调停止，onReload 调重新生成", async () => {
    const runtime = mountRuntime([view(1, "user", "done"), view(2, "assistant", "done")]);

    await act(async () => runtime.thread().append("再问一次"));
    expect(runtime.onSend.mock.calls).toEqual([["再问一次"]]);

    await act(async () => runtime.thread().startRun({ parentId: "1" }));
    expect(runtime.onRegenerate).toHaveBeenCalledTimes(1);

    runtime.update([view(1, "user", "done"), view(2, "assistant", "running")]);
    await act(async () => runtime.thread().cancelRun());
    expect(runtime.onStop).toHaveBeenCalledTimes(1);
    expect(runtime.onSend).toHaveBeenCalledTimes(1);
  });
});

function assistants() {
  return screen.queryAllByRole("article", { name: "助手" });
}

describe("会话页：锁定不等于线程在运行", () => {
  it("历史加载中：输入框禁用，线程没有消息、没有光标；历史返回后输入框恢复可用", async () => {
    const history = deferredResponse();
    const snapshot = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: "已完成的回答",
      cursor: { epoch: 1, seq: null },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [SESSION_MESSAGES]: () => history.promise,
    });

    await waitFor(() => expect(composer().disabled).toBe(true));
    expect(screen.queryAllByRole("article")).toEqual([]);
    expect(document.querySelector(CARET)).toBeNull();

    history.resolve(jsonResponse(snapshot));
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(assistants()).toHaveLength(1);
    expect(document.querySelector(CARET)).toBeNull();
  });

  it("分叉进行中：输入框禁用，线程没有多出助手块、没有光标、没有 生成中 与 停止；fork 结束后恢复", async () => {
    const fork = deferredResponse();
    const snapshot = chatSnapshot({
      status: "done",
      assistantStatus: "done",
      content: "已完成的回答",
      cursor: { epoch: 1, seq: null },
    });
    renderChatPage(`/?session=${SESSION_ID}`, {
      "/api/sessions": () => jsonResponse({ sessions: [snapshot.session] }),
      [SESSION_MESSAGES]: () => jsonResponse(snapshot),
      [`/api/sessions/${SESSION_ID}/fork`]: () => fork.promise,
    });
    const user = await screen.findByRole("article", { name: "用户" });
    await waitFor(() => expect(composer().disabled).toBe(false));

    fireEvent.click(within(user).getByRole("button", { name: "从此处分叉" }));

    await waitFor(() => expect(composer().disabled).toBe(true));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(assistants()).toHaveLength(1);
    expect(document.querySelector(CARET)).toBeNull();
    expect(screen.queryByText("生成中")).toBeNull();
    expect(screen.queryByRole("button", { name: "停止" })).toBeNull();

    fork.resolve(jsonResponse({ error: { code: "session_busy", message: "会话忙" } }, 409));
    await waitFor(() => expect(composer().disabled).toBe(false));
    expect(assistants()).toHaveLength(1);
  });
});

function expectLockedAndGenerating() {
  expect(composer().disabled).toBe(true);
  expect(screen.getByText("生成中")).toBeTruthy();
  expect(screen.getByRole("button", { name: "停止" })).toBeTruthy();
}

describe("会话页：首次发送前不出现占位助手块", () => {
  it("欢迎态发送后，在 turn.start 或快照给出助手消息之前线程里没有助手块，输入框一直显示 生成中 与 停止", async () => {
    const accept = deferredResponse();
    const running = runningCreatedSnapshot();
    // 受理后的第一份快照只带用户消息：该回合的助手消息还没有被服务端给出。
    let snapshot = { ...running, messages: running.messages.slice(0, 1) };
    let prompts = 0;
    renderChatPage("/", {
      "/api/sessions": (_path, options) =>
        options?.method === "POST"
          ? jsonResponse(idleCreatedSession(), 201)
          : jsonResponse({ sessions: [] }),
      [CREATED_PROMPT]: () => {
        prompts += 1;
        return accept.promise;
      },
      [CREATED_MESSAGES]: () => jsonResponse(snapshot),
    });
    await screen.findByRole("heading", { level: 1, name: "WorkBuddy，我帮你" });

    await typeAndSend(PROMPT);
    await expectChatLocation(`/?session=${CREATED_SESSION_ID}`);
    await waitFor(() => expect(prompts).toBe(1));
    expectLockedAndGenerating();
    expect(screen.queryAllByRole("article")).toEqual([]);

    accept.resolve(jsonResponse(promptAccepted, 202));
    const user = await screen.findByRole("article", { name: "用户" });
    expect(within(user).getByText(PROMPT)).toBeTruthy();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    await act(settle);

    // 线程已挂上、末条是用户消息、回合在跑：运行时不得自己补一条助手占位。
    expectLockedAndGenerating();
    expect(screen.getAllByRole("article")).toEqual([user]);
    expect(assistants()).toEqual([]);
    expect(document.querySelector(CARET)).toBeNull();

    snapshot = running;
    act(() => {
      const source = latestSource();
      source.emitOpen();
      source.emitData("turn.start", "1:1", { messageId: 0 });
    });

    await waitFor(() => expect(assistants()).toHaveLength(1));
    expect(assistants()[0]?.getAttribute("data-message-id")).toBe("0");
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(document.querySelectorAll(CARET)).toHaveLength(1);
    expectLockedAndGenerating();
  });
});
