/**
 * Issue #83 pure protocol event mapping; #455 adds the interrupted outcome and applyStop.
 */
import type { OmpFrame } from "./omp/frame.js";

export type ChatEvent<StepId extends string | number = number> =
  | { type: "turn.start"; data: { messageId: number } }
  | { type: "text.delta"; data: { messageId: number; delta: string } }
  | {
      type: "step.start";
      data: { messageId: number; stepId: StepId; name: string; detail: string };
    }
  | {
      type: "step.end";
      data: {
        messageId: number;
        stepId: StepId;
        status: "done" | "failed";
        output: string;
      };
    }
  | { type: "turn.end"; data: { messageId: number; status: "done" | "failed" | "stopped" } }
  | { type: "error"; data: { messageId: number; message: string } }
  | {
      type: "approval.request";
      data: {
        messageId: number;
        approvalId: number;
        tool: string;
        title: string;
        expiresAt: number;
      };
    }
  | {
      type: "approval.resolved";
      data: { messageId: number; approvalId: number; decision: "allow" | "deny" | "timeout" };
    };

const GENERIC_FAILURE = "Agent execution failed";
// detail（args）与 output（result 文本）各自的码点上限；环形缓冲最坏成本见 #367 design D3。
const MAX_STEP_POINTS = 4096;
const TRUNCATED_MARK = "…（已截断）";
const IMAGE_PLACEHOLDER = "[图片]";
const NO_TOOLS: readonly ToolEntry[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);

interface ToolEntry {
  readonly id: string;
  readonly name: string;
}

/** 至多记住一个结局（首个胜出）：失败走 error + turn.end failed，中断走单独的 turn.end stopped。 */
type Outcome =
  | { readonly kind: "failure"; readonly message: string }
  | { readonly kind: "interrupted" };

const INTERRUPTED: Outcome = Object.freeze({ kind: "interrupted" });

interface EventState {
  readonly messageId: number;
  readonly promptRequestId: string;
  readonly started: boolean;
  readonly ended: boolean;
  readonly outcome: Outcome | undefined;
  readonly running: readonly ToolEntry[];
  readonly finished: readonly string[];
}

interface ApplyResult {
  state: EventState;
  events: ChatEvent<string>[];
}

export function createEventState(input: {
  messageId: number;
  promptRequestId: string;
}): EventState {
  return freezeState({
    messageId: input.messageId,
    promptRequestId: input.promptRequestId,
    started: false,
    ended: false,
    outcome: undefined,
    running: NO_TOOLS,
    finished: NO_IDS,
  });
}

export function applyFrame(state: EventState, frame: OmpFrame): ApplyResult {
  if (state.ended) {
    return { state, events: [] };
  }
  switch (frame.type) {
    case "agent_start":
      return applyAgentStart(state);
    case "message_update":
      return applyTextDelta(state, frame);
    case "tool_execution_start":
      return applyToolStart(state, frame);
    case "tool_execution_end":
      return applyToolEnd(state, frame);
    case "message_end":
      return applyMessageEnd(state, frame);
    case "agent_end":
      return applyAgentEnd(state, frame);
    case "response":
      return applyPromptFailure(state, frame);
    default:
      return { state, events: [] };
  }
}

export function applyFailure(state: EventState, message: string): ApplyResult {
  if (state.ended) {
    return { state, events: [] };
  }
  return failTurn(state, message);
}

/** Supervisor 有界退回用：未终态即合成恰一个 turn.end stopped，不看 started 与已记住结局。 */
export function applyStop(state: EventState): ApplyResult {
  if (state.ended) {
    return { state, events: [] };
  }
  return stopTurn(state);
}

function applyAgentStart(state: EventState): ApplyResult {
  if (state.started) {
    return { state, events: [] };
  }
  return {
    state: evolve(state, { started: true }),
    events: [{ type: "turn.start", data: { messageId: state.messageId } }],
  };
}

function applyTextDelta(state: EventState, frame: OmpFrame): ApplyResult {
  if (!state.started) {
    return { state, events: [] };
  }
  const event = asRecord(frame.assistantMessageEvent);
  if (event?.type !== "text_delta" || typeof event.delta !== "string") {
    return { state, events: [] };
  }
  const message = asRecord(frame.message);
  if (message !== undefined && message.role !== undefined && message.role !== "assistant") {
    return { state, events: [] };
  }
  return {
    state,
    events: [{ type: "text.delta", data: { messageId: state.messageId, delta: event.delta } }],
  };
}

function applyToolStart(state: EventState, frame: OmpFrame): ApplyResult {
  if (!state.started) {
    return { state, events: [] };
  }
  const id = nonemptyString(frame.toolCallId);
  const name = nonemptyString(frame.toolName);
  if (
    id === undefined ||
    name === undefined ||
    findRunning(state, id) !== undefined ||
    state.finished.includes(id)
  ) {
    return { state, events: [] };
  }
  const detail = "args" in frame ? truncateStep(serializeArgs(frame.args)) : "";
  return {
    state: evolve(state, {
      running: Object.freeze([...state.running, { id, name }]),
    }),
    events: [
      {
        type: "step.start",
        data: { messageId: state.messageId, stepId: id, name, detail },
      },
    ],
  };
}

function applyToolEnd(state: EventState, frame: OmpFrame): ApplyResult {
  if (!state.started) {
    return { state, events: [] };
  }
  const id = nonemptyString(frame.toolCallId);
  if (id === undefined) {
    return { state, events: [] };
  }
  if (findRunning(state, id) === undefined) {
    return { state, events: [] };
  }
  const output = truncateStep(normalizeOutput(frame.result));
  const status = frame.isError === true ? "failed" : "done";
  return {
    state: evolve(state, {
      running: Object.freeze(state.running.filter((tool) => tool.id !== id)),
      finished: Object.freeze([...state.finished, id]),
    }),
    events: [
      {
        type: "step.end",
        data: { messageId: state.messageId, stepId: id, status, output },
      },
    ],
  };
}

function applyMessageEnd(state: EventState, frame: OmpFrame): ApplyResult {
  const message = asRecord(frame.message);
  if (
    message === undefined ||
    message.role !== "assistant" ||
    (message.stopReason !== "error" && message.stopReason !== "aborted")
  ) {
    return { state, events: [] };
  }
  if (state.outcome !== undefined) {
    return { state, events: [] };
  }
  const outcome: Outcome =
    message.stopReason === "aborted"
      ? INTERRUPTED
      : Object.freeze({
          kind: "failure",
          message: nonemptyString(message.errorMessage) ?? GENERIC_FAILURE,
        });
  return { state: evolve(state, { outcome }), events: [] };
}

function applyAgentEnd(state: EventState, frame: OmpFrame): ApplyResult {
  if (frame.isTerminal === false) {
    return { state, events: [] };
  }
  if (state.outcome?.kind === "failure") {
    return failTurn(state, state.outcome.message);
  }
  if (state.outcome?.kind === "interrupted") {
    return stopTurn(state);
  }
  return {
    state: evolve(state, { ended: true }),
    events: [{ type: "turn.end", data: { messageId: state.messageId, status: "done" } }],
  };
}

function applyPromptFailure(state: EventState, frame: OmpFrame): ApplyResult {
  if (frame.command !== "prompt" || frame.success !== false || frame.id !== state.promptRequestId) {
    return { state, events: [] };
  }
  return failTurn(state, frame.error);
}

function failTurn(state: EventState, message: unknown): ApplyResult {
  return {
    state: evolve(state, { ended: true }),
    events: [
      {
        type: "error",
        data: {
          messageId: state.messageId,
          message: nonemptyString(message) ?? GENERIC_FAILURE,
        },
      },
      { type: "turn.end", data: { messageId: state.messageId, status: "failed" } },
    ],
  };
}

function stopTurn(state: EventState): ApplyResult {
  return {
    state: evolve(state, { ended: true }),
    events: [{ type: "turn.end", data: { messageId: state.messageId, status: "stopped" } }],
  };
}

function evolve(
  state: EventState,
  patch: {
    started?: boolean;
    ended?: boolean;
    outcome?: Outcome;
    running?: readonly ToolEntry[];
    finished?: readonly string[];
  },
): EventState {
  return freezeState({
    messageId: state.messageId,
    promptRequestId: state.promptRequestId,
    started: patch.started ?? state.started,
    ended: patch.ended ?? state.ended,
    outcome: patch.outcome ?? state.outcome,
    running: patch.running ?? state.running,
    finished: patch.finished ?? state.finished,
  });
}

function freezeState(state: EventState): EventState {
  Object.freeze(state.running);
  Object.freeze(state.finished);
  return Object.freeze(state);
}

function asRecord(value: unknown): OmpFrame | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as OmpFrame)
    : undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findRunning(state: EventState, id: string): ToolEntry | undefined {
  for (const entry of state.running) {
    if (entry.id === id) {
      return entry;
    }
  }
  return undefined;
}

/** 紧凑单行 JSON：U+2028/U+2029 转义，保证 detail 不含行分隔符。 */
function serializeArgs(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  const json = JSON.stringify(value);
  if (typeof json !== "string") {
    return "";
  }
  return json.replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

/**
 * AgentToolResult 取 content 中 text 块原文与 image 占位，以 \n 连接，其余字段（details、
 * providerMetadata、图片 base64 等）一律丢弃；缺省/null 为空串，字符串原样，其余走紧凑 JSON。
 */
function normalizeOutput(result: unknown): string {
  if (result === undefined || result === null) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  const record = asRecord(result);
  if (record === undefined || !Object.hasOwn(record, "content") || !Array.isArray(record.content)) {
    return serializeArgs(result);
  }
  const parts: string[] = [];
  for (const item of record.content as unknown[]) {
    const block = asRecord(item);
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block?.type === "image") {
      parts.push(IMAGE_PLACEHOLDER);
    }
  }
  return parts.join("\n");
}

function truncateStep(text: string): string {
  const kept = truncateCodepoints(text, MAX_STEP_POINTS);
  return kept.length === text.length ? text : kept + TRUNCATED_MARK;
}

function truncateCodepoints(text: string, max: number): string {
  const { length } = text;
  let offset = 0;
  let points = 0;
  while (offset < length) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) {
      break;
    }
    if (points === max) {
      return text.slice(0, offset);
    }
    points += 1;
    offset += codePoint > 0xffff ? 2 : 1;
  }
  return text;
}
