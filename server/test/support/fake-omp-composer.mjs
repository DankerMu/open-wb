/**
 * fake-omp 工具调用帧的纯构建部分（#997 自 fake-omp.mjs 原样搬出）：固定 bash 调用常量、
 * `tool_execution_start` / `tool_execution_end` 帧构建。S1g 的纯构建（#998）：`approval-write` 的 write
 * 调用与审批 select、`get_state` 的 data、`set_model` / `set_thinking_level` 的应答与两个失败取值的判定。
 * 无模块级可变状态、不发帧、不写文件；不导入 fake-omp.mjs 或其它 fake-omp-* 模块。
 * 「最近一次成功应用的模型与强度」由 fake-omp.mjs 持有，这里只返回帧数据与要并入的 patch。
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
/** `approval-write` 的唯一一次 write 调用及其 select id（tool-approval 规格定为 w1）；夹具不真的写文件。 */
export const WRITE_CALL = {
  id: "tool-write-1",
  name: "write",
  args: { path: "workbuddy-report.html", content: "<!doctype html>\n<h1>workbuddy-smoke</h1>\n" },
};
export const WRITE_SELECT_ID = "w1";
/** 文档化的失败取值。真实 omp v18.0.10 从不拒绝强度：`workbuddy-bad-level` 只是给宿主失败路径用的夹具装置。 */
const MISSING_MODEL = "workbuddy-missing-model";
const BAD_LEVEL = "workbuddy-bad-level";

export function isMissingModel(modelId) {
  return modelId === MISSING_MODEL;
}

export function isBadLevel(level) {
  return level === BAD_LEVEL;
}

/** 审批标题第二行：带 `path` 的调用（write）报 `Path:`，其余（bash）报 `Command:`。 */
export function selectTitle(call) {
  const { path, command } = call.args;
  return `Allow tool: ${call.name}\n${path === undefined ? `Command: ${command}` : `Path: ${path}`}`;
}

export function selectRequest(id, call) {
  return {
    type: "extension_ui_request",
    id,
    method: "select",
    title: selectTitle(call),
    options: ["Approve", "Deny"],
  };
}

/**
 * `set_model` / `set_thinking_level` 的应答与成功时要并入状态的 patch（失败为 `{}`，不改任何状态）。
 * 形状同 omp v18.0.10：set_model 成功带 data `{provider, id}`，set_thinking_level 成功无 data。
 */
export function commandAnswer(frame) {
  const head = { id: frame.id, type: "response", command: frame.type };
  if (frame.type === "set_model") {
    const { provider, modelId } = frame;
    if (isMissingModel(modelId)) {
      const error = `Model not found: ${provider}/${modelId}`;
      return { response: { ...head, success: false, error }, patch: {} };
    }
    const model = { provider, id: modelId };
    return { response: { ...head, success: true, data: model }, patch: { model } };
  }
  if (isBadLevel(frame.level)) {
    const error = `Invalid thinking level: ${frame.level}`;
    return { response: { ...head, success: false, error }, patch: {} };
  }
  return { response: { ...head, success: true }, patch: { thinkingLevel: frame.level } };
}

/** 首次成功命令之前的取值：夹具自第一版起的 get_state `model` / `thinkingLevel`（真实 omp 同样带这两键）。 */
export const INITIAL_APPLIED = Object.freeze({
  model: Object.freeze({ provider: "workbuddy", id: "deepseek-v4.1-flash" }),
  thinkingLevel: "off",
});

/** `get_state` 的 data（不含 sessionFile）：`applied` 即 `{model, thinkingLevel}`，键序即既有字节序。 */
export function stateData(applied) {
  return {
    model: applied.model,
    thinkingLevel: applied.thinkingLevel,
    isStreaming: false,
    isCompacting: false,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    interruptMode: "immediate",
    sessionId: "sess-fake",
    autoCompactionEnabled: true,
    fastModeEnabled: false,
    fastModeActive: false,
    tokensPerSecond: null,
    messageCount: 0,
    queuedMessageCount: 0,
    todoPhases: [],
  };
}

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
