/**
 * fake-omp S1c 会话元数据场景的纯构建部分（#518 拆出）：`thinking` / `edit-write` 的常量与帧构建、
 * `--thinking-repeat` 取值校验。无模块级可变状态、不发帧、不写文件；只依赖 node: 内建，
 * 绝不导入 fake-omp.mjs（它有 argv/ready/stdin 模块级副作用）或 fake-omp-proxy.mjs。
 * 形状对照 omp v18.0.10：ai/src/types.ts:1294-1296（thinking 事件）、coding-agent/src/edit/renderer.ts
 * （EditToolDetails.path/diff）、edit/diff.ts:54-56（`+N|`/`-N|`/` N|` 行格式）、tools/write.ts:314-324
 * （WriteToolDetails.resolvedPath，无 diff）。
 */
import { join } from "node:path";

/** 确定性思考文本（与 fake-upstream THINK_PARTS 同文本）；三段互不为前缀。 */
const THINKING_PARTS = Object.freeze(["先读需求，", "再列要点，", "最后作答。"]);
const THINKING_TEXT = THINKING_PARTS.join("");
/** `edit-write` 工具之后的固定回答（≥2 段 text_delta）。 */
export const ANSWER_DELTAS = Object.freeze(["Edited notes.md ", "and wrote out/report.html."]);
/** edit 的固定 hashline input（hashline 模式 args 恰 `{input}`，无 path 键）。 */
const EDIT_INPUT = "[notes.md#3f2a]\nPUT 1.=1:\n+a\n+b";
/** edit 落盘后的 `<cwd>/notes.md` 固定内容。 */
const NOTES_CONTENT = "a\nb\nd\n";
const EDIT_DIFF = "+1|a\n+2|b\n-3|c\n 4|d";
/** write 的固定 html，真实写到 `<cwd>/out/report.html`。 */
const REPORT_HTML = "<!doctype html>\n<html><body><h1>Report</h1></body></html>\n";

/** `--thinking-repeat`：缺省（undefined）为 1；只接受 `/^[1-9][0-9]*$/` 的安全整数，其余（含缺值 ""）抛错。 */
export function parseThinkingRepeat(raw) {
  if (raw === undefined) {
    return 1;
  }
  if (/^[1-9][0-9]*$/u.test(raw) && Number.isSafeInteger(Number(raw))) {
    return Number(raw);
  }
  throw new Error(`invalid --thinking-repeat: ${JSON.stringify(raw)}`);
}

/** 固定小形状：不做累积快照，repeat 很大时输出不按平方增长。 */
function partial() {
  return { role: "assistant", content: [] };
}

/** `message_update` 帧：`message` 与事件的 `partial` 均为固定小形状。 */
function messageUpdate(event) {
  return {
    type: "message_update",
    assistantMessageEvent: { ...event, partial: partial() },
    message: partial(),
  };
}

/**
 * thinking_start → 三段 delta 按序重复 repeat 次 → thinking_end{content: 全部 delta 之和}，
 * 逐帧产出 message_update（生成器：6555 帧的大回合也不整体驻留）。
 */
export function* thinkingFrames(repeat) {
  yield messageUpdate({ type: "thinking_start", contentIndex: 0 });
  for (let round = 0; round < repeat; round++) {
    for (const delta of THINKING_PARTS) {
      yield messageUpdate({ type: "thinking_delta", contentIndex: 0, delta });
    }
  }
  yield messageUpdate({
    type: "thinking_end",
    contentIndex: 0,
    content: THINKING_TEXT.repeat(repeat),
  });
}

/** `thinking` 回合 message_end{stop} 的 content：thinking 块在前、文本块在后。 */
export function thinkingContent(repeat, text) {
  return [
    { type: "thinking", thinking: THINKING_TEXT.repeat(repeat) },
    { type: "text", text },
  ];
}

/** `edit-write` 的两步（edit 在前）：调用、要真实写出的绝对路径与内容、成功时的 details 与结果文本。 */
export function editWriteSteps(cwd) {
  const notes = join(cwd, "notes.md");
  const report = join(cwd, "out", "report.html");
  return [
    {
      call: { id: "tool-edit-1", name: "edit", args: { input: EDIT_INPUT } },
      file: notes,
      content: NOTES_CONTENT,
      details: { path: notes, diff: EDIT_DIFF },
      text: "Updated notes.md",
    },
    {
      call: {
        id: "tool-write-1",
        name: "write",
        args: { path: "out/report.html", content: REPORT_HTML },
      },
      file: report,
      content: REPORT_HTML,
      details: { resolvedPath: report },
      text: `Successfully wrote ${REPORT_HTML.length} bytes to out/report.html`,
    },
  ];
}

/** 一个 message_end{toolUse}，content 恰为各步的 toolCall 块（其前无正文）。 */
export function toolUseEnd(steps) {
  const content = steps.map(({ call }) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.args,
  }));
  return { type: "message_end", message: { role: "assistant", content, stopReason: "toolUse" } };
}

/** 落盘成功带 details；失败 `isError: true` 且无 details。 */
export function stepEnd(step, error) {
  const text = error === undefined ? step.text : `Failed to write ${step.file}: ${error}`;
  return {
    type: "tool_execution_end",
    toolCallId: step.call.id,
    toolName: step.call.name,
    result: {
      content: [{ type: "text", text }],
      ...(error === undefined ? { details: step.details } : {}),
    },
    ...(error === undefined ? {} : { isError: true }),
  };
}
