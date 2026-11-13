/**
 * fake-omp 的宿主工具场景（change s2c-kb-session 3.2，#1964）：omp-test-harness「假 omp host tool 场景」。
 * 帧形照 docs/reviews/2026-11-10-omp-host-tools.md §2.3、§2.4、§2.6、§2.7（v18.12.3 实测）。`yolo` 帧序：
 * `host_tool_call` 先于 `tool_execution_start`。3.5（#1965）：只有 `host-tool` 在 `write` / `always-ask` 下
 * 先发 `tool_execution_start` 与 `Allow tool: kb_search` 的 select，收到 `Approve` 才发 `host_tool_call`；
 * 其它应答（`Deny`、`cancelled`）以拒绝结束这次调用——记录 §2.4 未实测 Deny，这是假 omp 的选择。
 * `host-tool-parallel`、`host-tool-abort` 不论档位都按 `yolo`。
 * 其余场景对 `set_host_tools` 回按 id 关联的 `success:false`。没有 import、不发 ready、不读 argv（档位由主程序传入）：
 * 帧经主程序给的 `emit` 等函数写出，调用发出后立即返回，`host_tool_result` 到达时按状态表推进，
 * 不在串行 queue 的 handler 里等结果。
 */

const SCENARIOS = new Set(["host-tool", "host-tool-parallel", "host-tool-abort"]);
const KB_TOOL = "kb_search";
const ABORTED = `Host tool "${KB_TOOL}" was aborted`;
const DELTAS = ["已根据", "检索结果作答。"];
const SELECT_OPTIONS = ["Approve", `Approve ${KB_TOOL} for this session`, "Deny"];

/**
 * `hooks`：`emit(frame)`、`emitDeltas(deltas)`、`finishTurn()`（终态 agent_end 并应答回合内延后的命令）、
 * `flushCommands()`（回合被 abort 丢弃时应答延后的命令）。返回 `handlers`（并入主程序的命令分派）与
 * `prompt(message)`（本场景接管这条 prompt 时 resolve true）。
 */
export function hostToolScenario(scenario, approvalMode, hooks) {
  const active = SCENARIOS.has(scenario);
  const gated =
    scenario === "host-tool" && (approvalMode === "write" || approvalMode === "always-ask");
  /** 在途调用：host_tool_call id → 调用；`host-tool` 的第二次调用在第一次结束后才登记。 */
  const pending = new Map();
  /** 等作答的 select：`r<n>` → 调用（含它的 host_tool_call id）。 */
  const selects = new Map();
  /** `ids`：按进程累计的调用序号（`h<n>` / `c<n>` / `r<n>`，调用开始时分配）；`calls`：本回合的调用序号（`第 <n> 轮`）。 */
  const turn = { open: false, done: false, question: "", kbIds: [], calls: 0, ids: 0 };

  async function call(toolName, args) {
    turn.calls += 1;
    turn.ids += 1;
    const id = `h${turn.ids}`;
    const toolCallId = `c${turn.ids}`;
    const intent = `第 ${turn.calls} 轮`;
    const start = { type: "tool_execution_start", toolCallId, toolName, args, intent };
    if (gated) {
      const selectId = `r${turn.ids}`;
      selects.set(selectId, { id, toolCallId, toolName, args });
      await hooks.emit(start);
      await hooks.emit({
        type: "extension_ui_request",
        id: selectId,
        method: "select",
        title: `Allow tool: ${toolName}`,
        options: SELECT_OPTIONS,
      });
      return;
    }
    pending.set(id, { toolCallId, toolName, args });
    await hooks.emit({ type: "host_tool_call", id, toolCallId, toolName, arguments: args });
    await hooks.emit(start);
  }

  /** `Approve` 才发 host_tool_call；其它应答以拒绝结束这次调用（文本同 fake-omp-composer.mjs 的 toolEnd）。 */
  async function onSelect(frame) {
    const entry = selects.get(frame?.id);
    if (entry === undefined) {
      return;
    }
    selects.delete(frame.id);
    const { id, toolCallId, toolName, args } = entry;
    if (frame.value === "Approve") {
      pending.set(id, { toolCallId, toolName, args });
      await hooks.emit({ type: "host_tool_call", id, toolCallId, toolName, arguments: args });
      return;
    }
    await hooks.emit({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: { content: [{ type: "text", text: `Tool call denied by user: ${toolName}` }] },
      isError: true,
    });
    await advance();
  }

  function kbArgs(question, index) {
    const kbId = turn.kbIds[index] ?? turn.kbIds[0];
    return { question, kb_ids: kbId === undefined ? [] : [kbId] };
  }

  async function prompt(message) {
    if (!active || turn.open || (scenario === "host-tool-abort" && turn.done)) {
      return false;
    }
    turn.open = true;
    turn.calls = 0;
    turn.question = String(message ?? "");
    turn.kbIds = Array.from(turn.question.matchAll(/KB:(\S+)/gu), (match) => match[1]);
    await hooks.emit({ type: "agent_start" });
    await call(KB_TOOL, kbArgs(turn.question, 0));
    if (scenario === "host-tool-parallel") {
      await call(KB_TOOL, kbArgs(turn.question, 1));
      await call("other", { question: turn.question });
    }
    return true;
  }

  async function onResult(frame) {
    const entry = pending.get(frame?.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(frame.id);
    await hooks.emit({
      type: "tool_execution_end",
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      result: frame.result,
      isError: frame.isError === true,
    });
    await advance();
  }

  /** 一次调用结束后：`host-tool` 接着第二次调用；全部结束则发正文与终态。 */
  async function advance() {
    if (scenario === "host-tool" && turn.calls === 1) {
      await call(KB_TOOL, kbArgs(`${turn.question} 详细说明`, 0));
      return;
    }
    if (pending.size === 0 && selects.size === 0) {
      await endTurn();
      await hooks.emitDeltas(DELTAS);
      await hooks.finishTurn();
    }
  }

  function endTurn() {
    turn.open = false;
    turn.done = true;
  }

  /** 同记录 §2.7：先取消在途调用并以失败结束它，再 aborted 的 turn_end、终态 agent_end 与 abort 应答。 */
  async function onAbort(frame) {
    const inFlight = [...pending.entries()];
    pending.clear();
    for (const [targetId, entry] of inFlight) {
      await hooks.emit({ type: "host_tool_cancel", id: `cancel-${targetId}`, targetId });
      await hooks.emit({
        type: "tool_execution_end",
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        result: { content: [{ type: "text", text: ABORTED }] },
        isError: true,
      });
    }
    const wasOpen = turn.open;
    endTurn();
    if (wasOpen) {
      await hooks.emit({ type: "turn_end", stopReason: "aborted" });
      await hooks.emit({ type: "agent_end", messages: [], isTerminal: true });
    }
    await hooks.emit({ id: frame.id, type: "response", command: "abort", success: true });
    if (wasOpen) {
      await hooks.flushCommands();
    }
  }

  async function onRegister(frame) {
    const tools = Array.isArray(frame.tools) ? frame.tools : [];
    await hooks.emit(
      active
        ? {
            id: frame.id,
            type: "response",
            command: "set_host_tools",
            success: true,
            data: { toolNames: tools.map((tool) => tool?.name) },
          }
        : {
            id: frame.id,
            type: "response",
            command: "set_host_tools",
            success: false,
            error: "unsupported",
          },
    );
  }

  const handlers = { set_host_tools: onRegister };
  if (active) {
    handlers.host_tool_result = onResult;
  }
  if (gated) {
    handlers.extension_ui_response = onSelect;
  }
  if (scenario === "host-tool-abort") {
    handlers.abort = onAbort;
  }
  return { handlers, prompt };
}
