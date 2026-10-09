// chat-web「会话页源码模块划分」场景「convertMessage 映射」：会话视图消息 → 运行时消息的纯映射。
import { describe, expect, it } from "vitest";
import { convertMessage, messageCustom } from "../src/features/chat/runtime-convert.js";
import { type ChatState, chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { parseMessageSnapshot } from "../src/lib/session-contract.js";
import { NULL_SESSION_META } from "./session-meta-fixtures.js";

type View = ChatState["messages"][number];

const SETTLED = {
  id: 7,
  tool: "write",
  title: "Allow tool: write",
  expiresAt: 1_750_000_060_000,
  decision: "allow" as const,
};
const CHANGES = [{ path: "out/index.html", added: null, removed: null, kind: "write" as const }];

function stoppedView(): View {
  return {
    id: 12,
    role: "assistant",
    content: "部分回答",
    thinking: "先想一想",
    status: "stopped",
    undo: null,
    attachments: [],
    steps: [
      {
        id: 31,
        name: "bash",
        detail: '{"command":"ls"}',
        output: "a.txt",
        changes: null,
        status: "done",
      },
      {
        id: 32,
        name: "write",
        detail: '{"path":"out/index.html"}',
        output: "EACCES",
        changes: CHANGES,
        status: "failed",
      },
    ],
    approvals: [SETTLED],
    error: "写入失败",
  };
}

function runningView(): View {
  return {
    id: 13,
    role: "assistant",
    content: "正在",
    thinking: null,
    status: "running",
    undo: null,
    attachments: [],
    steps: [],
    approvals: [],
    error: null,
  };
}

describe("convertMessage 映射", () => {
  it("stopped 助手消息：id 为十进制字符串，part 依次为 reasoning、text、按原序的 tool-call，状态为未完成", () => {
    const converted = convertMessage(stoppedView());

    expect(converted.id).toBe("12");
    expect(converted.role).toBe("assistant");
    expect(converted.content).toEqual([
      { type: "reasoning", text: "先想一想" },
      { type: "text", text: "部分回答" },
      {
        type: "tool-call",
        toolCallId: "31",
        toolName: "bash",
        argsText: '{"command":"ls"}',
        result: "a.txt",
      },
      {
        type: "tool-call",
        toolCallId: "32",
        toolName: "write",
        argsText: '{"path":"out/index.html"}',
        result: "EACCES",
        isError: true,
      },
    ]);
    expect(converted.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("审批、步骤 changes、error 与原始状态原值透传，应用层组件读得到", () => {
    const view = stoppedView();
    const custom = messageCustom(convertMessage(view).metadata?.custom ?? {});

    expect(custom.status).toBe("stopped");
    expect(custom.error).toBe("写入失败");
    expect(custom.approvals).toBe(view.approvals);
    expect(custom.steps).toBe(view.steps);
    expect(custom.steps[1]?.changes).toBe(CHANGES);
  });

  it("thinking 为 null、无步骤的 running 助手消息：只有一个 text part，状态为运行中", () => {
    const converted = convertMessage(runningView());

    expect(converted.id).toBe("13");
    expect(converted.content).toEqual([{ type: "text", text: "正在" }]);
    expect(converted.status).toEqual({ type: "running" });
  });

  it("状态映射：done 为完成，failed 与 stopped 为未完成", () => {
    const status = (value: View["status"]) =>
      convertMessage({ ...runningView(), status: value }).status;

    expect(status("done")).toEqual({ type: "complete", reason: "stop" });
    expect(status("failed")).toEqual({ type: "incomplete", reason: "error" });
    expect(status("stopped")).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("空正文仍是一个 text part，空字符串的 thinking 不产生 reasoning part", () => {
    const converted = convertMessage({ ...runningView(), content: "", thinking: "" });

    expect(converted.content).toEqual([{ type: "text", text: "" }]);
  });

  it("用户消息：只有 text part、不带状态（运行时只接受助手消息带这些），透传字段照常", () => {
    const view: View = {
      ...runningView(),
      id: -3,
      role: "user",
      content: "第一行\n  第二行",
      status: "done",
      steps: stoppedView().steps,
    };
    const converted = convertMessage(view);

    expect(converted.id).toBe("-3");
    expect(converted.role).toBe("user");
    expect(converted.content).toEqual([{ type: "text", text: "第一行\n  第二行" }]);
    expect(converted.status).toBeUndefined();
    expect(messageCustom(converted.metadata?.custom ?? {}).steps).toBe(view.steps);
  });

  it("同一输入得到相等的输出，且不修改输入", () => {
    for (const make of [stoppedView, runningView]) {
      const view = make();
      const frozen = structuredClone(view);

      expect(convertMessage(view)).toEqual(convertMessage(view));
      expect(convertMessage(view)).toEqual(convertMessage(make()));
      expect(view).toEqual(frozen);
    }
  });
});

describe("附件透传：快照 → 视图消息 → 运行时消息的应用自有字段", () => {
  const FILE = { path: "uploads/a.pdf", size: 3 };

  function wire(id: number, role: "user" | "assistant", attachments: unknown[]) {
    return {
      id,
      role,
      content: role === "user" ? "问" : "答",
      thinking: null,
      status: "done",
      createdAt: id,
      steps: [],
      approvals: [],
      undo: role === "user" ? "available" : null,
      attachments,
    };
  }

  it("用户消息的每个附件经 chatStateFromSnapshot 与 convertMessage 原值到达，助手消息为空数组", () => {
    const snapshot = parseMessageSnapshot({
      session: {
        id: "0123456789abcdef0123456789abcdef",
        title: "saved title",
        status: "done",
        createdAt: 1_740_000_000_000,
        updatedAt: 1_740_000_000_023,
        ...NULL_SESSION_META,
      },
      messages: [wire(1, "user", [FILE]), wire(2, "assistant", [])],
      streamCursor: { epoch: 1, seq: null },
      todo: null,
    });
    if (!snapshot) {
      throw new Error("the snapshot did not parse");
    }

    const view = chatStateFromSnapshot(snapshot);

    expect(view.messages.map((item) => item.attachments)).toEqual([[FILE], []]);
    expect(view.messages.map((item) => convertMessage(item).metadata?.custom?.attachments)).toEqual(
      [[FILE], []],
    );
  });
});
