/**
 * fake-omp 工具调用帧的纯构建部分（#997 自 fake-omp.mjs 原样搬出）：固定 bash 调用常量、
 * `tool_execution_start` / `tool_execution_end` 帧构建。S1g 的纯构建（approval-write、模型命令）随后落在这里。
 * 无模块级可变状态、不发帧、不写文件；不导入 fake-omp.mjs 或其它 fake-omp-* 模块。
 */
const TOOL_ID = "tool-1";
const TOOL_NAME = "bash";
export const TOOL_OUTPUT = "workbuddy-smoke";
export const CALL_1 = { id: TOOL_ID, name: TOOL_NAME, args: { command: "echo workbuddy-smoke" } };
export const CALL_2 = {
  id: "tool-2",
  name: TOOL_NAME,
  args: { command: "echo workbuddy-smoke-2" },
};

export function toolStart(call) {
  return {
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
  };
}

/** 成功帧同既有工具轮（无 isError）；拒绝帧同 wrapper.ts:337-340 与 agent-loop.ts:2625-2631。 */
export function toolEnd(call, approved = true) {
  const text = approved ? TOOL_OUTPUT : `Tool call denied by user: ${call.name}`;
  return {
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result: { content: [{ type: "text", text }], details: approved ? { exitCode: 0 } : {} },
    ...(approved ? {} : { isError: true }),
  };
}
