/**
 * Issue 538 对话内搜索 (parent tasks 7.7): U1–U4 of openspec/changes/conversation-search/design.md.
 * Seam: the pure `matchMessages` over the message views the page holds. Expected values are
 * literals from the spec delta.
 */
import { describe, expect, it } from "vitest";
import { matchMessages } from "../src/features/chat/search-match.js";
import { type ChatState, chatStateFromSnapshot } from "../src/features/chat/stream.js";
import { reportConversation } from "./chat-page-search-support.js";

type MessageView = ChatState["messages"][number];

/** The message views of the spec scenario: ids -3, 0 and 1. */
const report = () => chatStateFromSnapshot(reportConversation()).messages;

const said = (id: number, content: string) => ({ id, content });

describe("matchMessages", () => {
  it("U1 counts a message once however often it holds the query, and never a step output", () => {
    const messages = report();
    expect(messages[1]?.steps.map((step) => step.output)).toEqual(["report.pdf"]);

    expect(matchMessages(messages, "REPORT")).toEqual([-3, 0]);
  });

  it("U2 an empty query matches nothing, an empty content included", () => {
    expect(matchMessages(report(), "")).toEqual([]);
    expect(matchMessages([said(1, ""), said(2, "x")], "")).toEqual([]);
    expect(matchMessages([], "")).toEqual([]);
    expect(matchMessages([], "x")).toEqual([]);
  });

  it("U3 ignores case on both sides", () => {
    const messages = [said(1, "Report"), said(2, "report"), said(3, "REPORT"), said(4, "repor")];

    expect(matchMessages(messages, "report")).toEqual([1, 2, 3]);
    expect(matchMessages(messages, "REPORT")).toEqual([1, 2, 3]);
    expect(matchMessages(messages, "rEpOrT")).toEqual([1, 2, 3]);
  });

  it("U3 searches the Markdown source, not the rendered text", () => {
    expect(matchMessages(report(), "**report**")).toEqual([0]);
    // Rendered as "report 已生成"; the source has the closing ** in between.
    expect(matchMessages(report(), "report 已生成")).toEqual([]);
  });

  it("U3 leaves thinking, error, step detail and step output out", () => {
    const [question, answer] = report();
    if (!question || !answer) throw new Error("expected the scenario's first two messages");
    const hidden: MessageView = {
      ...answer,
      content: "已生成",
      thinking: "先写 needle",
      error: "needle 失败",
      steps: answer.steps.map((step) => ({ ...step, detail: "needle", output: "needle" })),
    };

    expect(matchMessages([question, hidden], "needle")).toEqual([]);
    expect(matchMessages([question, { ...hidden, content: "a needle" }], "needle")).toEqual([0]);
  });

  it("U3 takes the query literally, surrounding blanks included", () => {
    const messages = [said(1, "a report"), said(2, "report")];

    expect(matchMessages(messages, "report")).toEqual([1, 2]);
    expect(matchMessages(messages, " report")).toEqual([1]);
    expect(matchMessages(messages, "report ")).toEqual([]);
    expect(matchMessages(messages, " ")).toEqual([1]);
  });

  it("U4 keeps the transcript order and returns the ids 0 and negative ones as they are", () => {
    const messages = [said(5, "x1"), said(-3, "x2"), said(0, "x3"), said(9, "y"), said(2, "x4")];

    expect(matchMessages(messages, "x")).toEqual([5, -3, 0, 2]);
    expect(matchMessages(messages, "x3")).toEqual([0]);
  });
});
