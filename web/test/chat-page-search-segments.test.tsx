// change chat-interleaved-segments 切片 6（issue 1475，design D13）：chat-web「工具段摘要与折叠」的「对话内搜索不改变
// 段的展开态」（owner 2026-10-06 B8：保持现状）。seam 与夹具同 chat-page-search.test.tsx（chat-page-search-support.tsx，
// 不改它们）；期望值取自场景字面量。
import { within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  answered,
  asked,
  CENTER,
  conversation,
  conversationSearchFixture,
  count,
  highlighted,
  jumps,
  openConversation,
  toggleSearch,
  typeQuery,
} from "./chat-page-search-support.js";

conversationSearchFixture();

/** 正文段 `先看一下。`、工具段 [bash]（输出含 needle）、思考段（原文含 needle）、正文段 `看完了。`。 */
function segmentedConversation() {
  const bash = {
    id: 11,
    ordinal: 0,
    bodyOffset: 5,
    name: "bash",
    detail: "ls",
    output: "needle.txt",
    changes: null,
    status: "done" as const,
  };
  return conversation([
    asked(-3, "看看目录"),
    answered(0, "先看一下。看完了。", {
      steps: [bash],
      thinking: "想一想 needle",
      thinkingMs: 1200,
      thinkingSegments: [
        { bodyOffset: 5, thinkingOffset: 0, thinkingLength: 10, stepsBefore: 1, thinkingMs: 1200 },
      ],
    }),
  ]);
}

/** 助手消息里工具段与折叠块的 `aria-expanded`，按文档次序。 */
function expansions() {
  const article = document.querySelector('article[data-message-id="0"]') as HTMLElement;
  const controls = [
    within(article).getByRole("button", { name: "执行 1 条命令" }),
    within(article).getByRole("button", { name: "已思考 1 秒" }),
  ];
  return controls.map((control) => control.getAttribute("aria-expanded"));
}

describe("对话内搜索不改变段的展开态", () => {
  it("needle 只在步骤输出与思考里：0/0，段仍收起；看完：1/1、消息高亮并滚动入视，段仍收起", async () => {
    await openConversation(segmentedConversation());
    expect(expansions()).toEqual(["false", "false"]);

    toggleSearch();
    typeQuery("needle");

    expect(count()).toBe("0/0");
    expect(highlighted()).toEqual([]);
    expect(expansions()).toEqual(["false", "false"]);

    typeQuery("看完");

    expect(count()).toBe("1/1");
    expect(highlighted()).toEqual(["0"]);
    expect(jumps).toEqual([["0", CENTER]]);
    expect(expansions()).toEqual(["false", "false"]);
  });
});
