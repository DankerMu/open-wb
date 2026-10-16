// 工具段摘要（chat-web「工具段摘要与折叠」；design D11，owner 裁定 B6、B7）：纯函数，按步骤名归类计数。
// 转圈图标与「不着色」是渲染层的事，钉在 `chat-tool-group.test.tsx`。
import { describe, expect, it } from "vitest";
import type { ChatStepView } from "../src/features/chat/stream-steps.js";
import { summarizeTools, toolAction } from "../src/features/chat/tool-summary.js";

let nextId = 1;

/** 一个步骤；`read` 一律读同一个文件，按文件数计时会与按步骤数计分开。 */
function step(name: string, status: ChatStepView["status"] = "done"): ChatStepView {
  const id = nextId++;
  return {
    id,
    name,
    detail: '{"path":"notes.md"}',
    output: "",
    changes: null,
    status,
    bodyOffset: null,
  };
}

function steps(...names: string[]): ChatStepView[] {
  return names.map((name) => step(name));
}

describe("toolAction: B6 table, exact and case-sensitive", () => {
  it("maps every listed name to its action", () => {
    const table: [string, string][] = [
      ["bash", "执行命令"],
      ["eval", "执行命令"],
      ["read", "读取"],
      ["write", "新建"],
      ["edit", "修改"],
      ["ast_edit", "修改"],
      ["grep", "搜索"],
      ["glob", "搜索"],
      ["ast_grep", "搜索"],
      ["web_search", "搜索"],
      ["search", "搜索"],
      ["find", "搜索"],
    ];
    expect(table.map(([name]) => [name, toolAction(name)])).toEqual(table);
  });

  it("puts any other name, a different case and inherited object keys under 其它", () => {
    const names = ["todo", "task", "Bash", "READ", " read", "read ", "constructor", "__proto__"];
    expect(names.map(toolAction)).toEqual(names.map(() => "其它"));
  });
});

describe("summarizeTools", () => {
  it("归类计数与次序：counts steps per action and joins the non-zero actions in table order", () => {
    expect(summarizeTools(steps("read", "bash", "read", "todo", "bash", "grep", "bash"))).toBe(
      "执行 3 条命令、读取 2 个文件、搜索 1 次、其它 1 步",
    );
    expect(
      summarizeTools(
        steps("edit", "ast_edit", "write", "search", "find", "web_search", "eval", "task"),
      ),
    ).toBe("执行 1 条命令、新建 1 个文件、修改 2 个文件、搜索 3 次、其它 1 步");
  });

  it("失败与进行中后缀：appends the failed count, then 进行中 while a step runs", () => {
    const running = [step("bash", "failed"), step("bash"), step("read", "running")];
    expect(summarizeTools(running)).toBe("执行 2 条命令、读取 1 个文件，1 步失败，进行中");
    const ended = running.map((item) => (item.status === "running" ? step("read") : item));
    expect(summarizeTools(ended)).toBe("执行 2 条命令、读取 1 个文件，1 步失败");
    expect(summarizeTools([step("read", "running")])).toBe("读取 1 个文件，进行中");
    expect(summarizeTools([step("bash", "failed"), step("todo", "failed")])).toBe(
      "执行 1 条命令、其它 1 步，2 步失败",
    );
    // 失败按步骤计，不按类：同一类里两个失败步骤记 2。
    expect(summarizeTools([step("bash", "failed"), step("bash", "failed")])).toBe(
      "执行 2 条命令，2 步失败",
    );
  });

  it("counts a stopped step in its action without a suffix", () => {
    expect(summarizeTools([step("bash", "stopped"), step("read")])).toBe(
      "执行 1 条命令、读取 1 个文件",
    );
  });
});
