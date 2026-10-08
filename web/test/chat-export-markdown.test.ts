// 导出记录的纯函数（任务 17.3）：session-sidebar「导出记录」的「导出内容」「空正文的助手消息」逐字节，
// 以及文件名清洗。期望值一律是规格里的字面量，不经被测函数算出。
import { describe, expect, it } from "vitest";
import { markdownFilename, sessionMarkdown } from "../src/features/chat/export-markdown.js";

/** 快照消息的完整形状：导出只读 `role`、`content` 与步骤的 `name`、`status`。 */
function message(
  role: "user" | "assistant",
  content: string,
  steps: { name: string; status: "running" | "done" | "failed" | "stopped" }[] = [],
  thinking: string | null = null,
) {
  return {
    id: 1,
    role,
    content,
    thinking,
    status: "done" as const,
    createdAt: 0,
    approvals: [],
    undo: null,
    steps: steps.map((step, ordinal) => ({
      ...step,
      id: ordinal,
      ordinal,
      detail: `detail of ${step.name}`,
      output: `output of ${step.name}`,
      changes: null,
    })),
  };
}

describe("导出内容（session-sidebar「导出记录」）", () => {
  it("导出内容：标题块、每条消息的标题行与正文、助手的步骤列表；没有思考，也没有步骤的 detail 与 output", () => {
    const text = sessionMarkdown({
      title: "季度/汇报",
      messages: [
        message("user", "帮我写提纲"),
        message(
          "assistant",
          "好的。",
          [
            { name: "write", status: "done" },
            { name: "bash", status: "failed" },
          ],
          "先想想",
        ),
        message("user", "谢谢"),
      ],
    });

    expect(text).toBe(
      "# 季度/汇报\n\n## 用户\n\n帮我写提纲\n\n## 助手\n\n好的。\n\n- write（已完成）\n- bash（失败）\n\n## 用户\n\n谢谢\n",
    );
    expect(text).not.toContain("先想想");
    expect(text).not.toContain("detail of");
    expect(text).not.toContain("output of");
  });

  it("空正文的助手消息：有步骤时标题行后直接是步骤列表，没有步骤时只有标题行", () => {
    expect(
      sessionMarkdown({
        title: "空回合",
        messages: [
          message("user", "跑一下"),
          message("assistant", "", [{ name: "bash", status: "done" }]),
          message("user", "再来"),
          message("assistant", ""),
        ],
      }),
    ).toBe(
      "# 空回合\n\n## 用户\n\n跑一下\n\n## 助手\n\n- bash（已完成）\n\n## 用户\n\n再来\n\n## 助手\n",
    );
  });

  it("零消息的会话只有标题行", () => {
    expect(sessionMarkdown({ title: "还没开始", messages: [] })).toBe("# 还没开始\n");
  });

  it("步骤的四种状态文案：运行中、已完成、失败、已停止", () => {
    expect(
      sessionMarkdown({
        title: "状态",
        messages: [
          message("assistant", "", [
            { name: "read", status: "running" },
            { name: "write", status: "done" },
            { name: "bash", status: "failed" },
            { name: "grep", status: "stopped" },
          ]),
        ],
      }),
    ).toBe(
      "# 状态\n\n## 助手\n\n- read（运行中）\n- write（已完成）\n- bash（失败）\n- grep（已停止）\n",
    );
  });

  it("用户消息没有步骤列表（即使入参里带着步骤）", () => {
    expect(
      sessionMarkdown({
        title: "只有用户",
        messages: [message("user", "你好", [{ name: "bash", status: "done" }])],
      }),
    ).toBe("# 只有用户\n\n## 用户\n\n你好\n");
  });

  it("正文原样输出：Markdown 记号、行首的井号与正文里的空行都不转义、不改写", () => {
    const body = "# 不是导出的标题\n\n- 列表项\n**粗体** `code` <b>html</b>\n## 用户";
    expect(
      sessionMarkdown({
        title: "*原样* #1",
        messages: [message("user", body), message("assistant", body)],
      }),
    ).toBe(`# *原样* #1\n\n## 用户\n\n${body}\n\n## 助手\n\n${body}\n`);
  });

  it("相邻两块之间恰一个空行，全文以单个换行结尾", () => {
    const text = sessionMarkdown({
      title: "间隔",
      messages: [
        message("user", "一"),
        message("assistant", "二", [{ name: "bash", status: "done" }]),
        message("assistant", ""),
      ],
    });

    expect(text.split("\n\n")).toEqual([
      "# 间隔",
      "## 用户",
      "一",
      "## 助手",
      "二",
      "- bash（已完成）",
      "## 助手\n",
    ]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });
});

describe("下载文件名（session-sidebar「导出记录」）", () => {
  it.each([
    ["季度/汇报", "季度汇报.md"],
    ["a\\b/c", "abc.md"],
    ["  周报整理  ", "周报整理.md"],
    ["/ 周报 \\", "周报.md"],
    ["周报 第一版", "周报 第一版.md"],
    ["行一\n行二\t\u0000\u001f\u007f\u0085尾", "行一行二尾.md"],
    ["notes.md", "notes.md.md"],
  ])("%j → %j", (title, expected) => {
    expect(markdownFilename(title)).toBe(expected);
  });

  it.each([[""], ["   "], ["/"], ["\\ / \n\t"]])("清洗后为空（%j）→ 会话.md", (title) => {
    expect(markdownFilename(title)).toBe("会话.md");
  });
});
