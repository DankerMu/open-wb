#!/usr/bin/env node
/**
 * Issue #87 fake omp subprocess. Protocol pin:
 * can1357/oh-my-pi@33cc6b9a043a74e00a157e72ca909272796d8461
 * Local oracle: resource/oh-my-pi/docs/rpc.md (docs/architecture/rpc.md tracked by #141).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs, parseDelay } from "./fake-omp-argv.mjs";
import { loadBaseUrl, parseToolCall, postChat } from "./fake-omp-proxy.mjs";
import {
  ANSWER_DELTAS,
  editWriteSteps,
  parseThinkingRepeat,
  stepEnd,
  thinkingContent,
  thinkingFrames,
  toolUseEnd,
} from "./fake-omp-thinking.mjs";

const MAX_FRAME = 1_048_576;
const MAX_REASSEMBLED = 67_108_864;
const CHUNK_PAYLOAD = 256 * 1024;
const THREE_MIB = 3 * 1024 * 1024;
const DEFAULT_SESSION = "/tmp/open-wb-fake-session.jsonl";
const TOOL_ID = "tool-1";
const TOOL_NAME = "bash";
const TOOL_OUTPUT = "workbuddy-smoke";
const UI_ID = "ui-confirm-1";
const DELTAS = ["Hello ", "from ", "fake-omp"];
/** slow-ready（#461）：扣住 ready 之后行为与 abort-ok 完全一致。 */
const ABORT_SCENARIOS = new Set(["abort-ok", "abort-ignored", "slow-ready"]);
const START_SCENARIOS = new Set(["abort-ok", "slow-ready"]);
/**
 * 审批门控场景（#458）：仅最后一个 `--approval-mode` 恰为 write 时门控，否则同 normal。
 * approval-chain-abort-ignored（#470）：r1 应答后再开 r2/C2，r2 应答后永久挂起；abort 一律无帧。
 * 帧序同 omp v18.0.10 实测（#620）：select 先于 tool_execution_start；每个 end 后紧跟其 toolResult。
 */
const APPROVAL_SCENARIOS = new Set([
  "approval",
  "approval-parallel",
  "approval-then-abort",
  "approval-chain-abort-ignored",
]);
/** 任何状态下 abort 都不产生帧、也不被延后记录的场景。 */
const IGNORE_ABORT = new Set(["abort-ignored", "approval-chain-abort-ignored"]);
const CALL_1 = { id: TOOL_ID, name: TOOL_NAME, args: { command: "echo workbuddy-smoke" } };
const CALL_2 = { id: "tool-2", name: TOOL_NAME, args: { command: "echo workbuddy-smoke-2" } };
/**
 * `branch` 场景的固定用户 entry 列表（#457）：进程生命周期内不变，不随 --resume、branch 或 prompt
 * 变化。后续消费者（#465 regenerate / #466 fork / #488 command）逐字依赖 entryId 与 text。
 */
const BRANCH_MESSAGES = Object.freeze([
  Object.freeze({ entryId: "fake-entry-1", text: "first question" }),
  Object.freeze({ entryId: "fake-entry-2", text: "second question" }),
]);
/** omp v18.0.10 agent-session.ts:8628-8629 的未知 entry 错误文本。 */
const UNKNOWN_ENTRY = "Invalid entry ID for branching";
/**
 * `slash` 场景（#552）只识别这两个精确 message（`===`，不 trim）：omp v18.0.10 内建命令的本地完成
 * （rpc-mode.ts:1019-1054）。`/todo` 无参输出同 slash-commands/helpers/todo.ts:246-260；`/compact`
 * 经 runCommandInBackground（builtin-lifecycle.ts:140-190），回执先于输出。
 */
const TODO_OUTPUT = "No todos. Use /todo append <task> to start one.";
const COMPACT_OUTPUT = "Compaction complete.";
const COMPACT_DELAY_MS = 50;

const argv = parseArgs(process.argv.slice(2));
const { scenario, resume, sessionDir, approvalMode, delay, startDelay, repeat, hold } = argv;
const { silent, entries } = argv;
/**
 * `branch` 实际列表（#552）：固定两条之后按 argv 序追加每个 `--branch-entry` 值（原样）。顶层算一次并
 * 冻结；无旋钮时即 BRANCH_MESSAGES，逐字不变。非 branch 场景不读它。
 */
const branchMessages = Object.freeze([
  ...BRANCH_MESSAGES,
  ...entries.map((text, index) =>
    Object.freeze({ entryId: `fake-entry-${BRANCH_MESSAGES.length + 1 + index}`, text }),
  ),
]);
/**
 * `--ready-delay-ms <n>`（#461）：与 `--scenario` 的位置无关，取最后一次出现的值；只有 slow-ready 解析它
 * （缺省 500，非法值在求值时抛错、退出 1 且零帧），其它 scenario 忽略。延迟期间关闭 stdin 零帧退出 0。
 * `--start-delay-ms <n>`（#650）同一规则、缺省 0，只有 START_SCENARIOS 解析它（abort-ignored 等忽略）。
 */
const readyDelayMs = scenario === "slow-ready" ? parseDelay(delay, "--ready-delay-ms", 500) : 0;
const startMs = START_SCENARIOS.has(scenario) ? parseDelay(startDelay, "--start-delay-ms", 0) : 0;
/** #518：`--thinking-repeat <n>`（非法值同上零帧退出）与 `--hold-after-thinking` 只作用于 thinking。 */
const thinkingRepeat = scenario === "thinking" ? parseThinkingRepeat(repeat) : 1;
const holdThinking = scenario === "thinking" && hold;
const gated = APPROVAL_SCENARIOS.has(scenario) && approvalMode === "write";
const abortable =
  ABORT_SCENARIOS.has(scenario) || (gated && scenario !== "approval") || holdThinking;
let protocol = 1;
let pendingUi = false;
/**
 * abort-* 回合：idle（首个 prompt 挂起回合）→ [starting（start-delay 窗口，回合未开始）] → pending（等 abort）
 * → done（其后 prompt 走缺省路径）；门控回合另有 selecting。
 */
let abortTurn = "idle";
let startTimer; // 仅在 starting 期间有值
/** 门控回合状态：挂起的 select id → 调用；是否有过 Approve；selecting 态记下的首个 abort。 */
const pendingSelects = new Map();
let approvedAny = false;
let deferredAbort;
/** slash：未出队的 `/compact` 输出，按定时器句柄登记；abort 清空它即取消（输出出队时才判定）。 */
const pendingOutputs = new Set();
/** 当前会话文件：初值同既有 resume/缺省；只有 branch 场景的成功 branch 会切换它。 */
let currentSession = resume ?? DEFAULT_SESSION;
/** 入站帧 type 记录（probe `frames=`）：按 stdin 行序、在串行 queue 内追加，按进程累积。 */
const inbound = [];
let queue = Promise.resolve();
let readyTimer; // 仅在 slow-ready 扣住 ready 期间有值
const readyGate = scenario === "slow-ready" ? delayReady(readyDelayMs) : Promise.resolve();

if (scenario !== "no-ready" && scenario !== "no-ready-hang") {
  queue = readyGate.then(() =>
    emit({
      type: "ready",
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
      maxFrameBytes: MAX_FRAME,
      maxReassembledFrameBytes: MAX_REASSEMBLED,
    }),
  );
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  queue = queue.then(() => onLine(line));
});
rl.on("close", () => {
  if (scenario === "hang-eof" || scenario === "hang-term" || scenario === "no-ready-hang") {
    return;
  }
  if (readyTimer !== undefined) {
    process.exit(0);
  }
  queue.then(
    () => process.exit(0),
    () => process.exit(1),
  );
});

if (scenario === "hang-eof" || scenario === "hang-term" || scenario === "no-ready-hang") {
  setInterval(() => {}, 60_000);
}
if (scenario === "hang-term" || scenario === "no-ready-hang") {
  process.on("SIGTERM", () => {});
}
if (scenario === "no-ready-hang") {
  process.stderr.write("no-ready-hang:handlers-ready\n");
}

function delayReady(ms) {
  const { promise, resolve } = Promise.withResolvers();
  readyTimer = setTimeout(() => {
    readyTimer = undefined;
    resolve();
  }, ms);
  return promise;
}

function emit(frame) {
  const { promise, resolve, reject } = Promise.withResolvers();
  process.stdout.write(`${JSON.stringify(frame)}\n`, (error) =>
    error ? reject(error) : resolve(),
  );
  return promise;
}

async function onLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    await emit({ type: "response", command: "parse", success: false, error: "invalid json" });
    return;
  }
  if (typeof frame?.type === "string") {
    inbound.push(frame.type);
  }
  await dispatch(frame);
}

async function dispatch(frame) {
  const type = frame?.type;
  const handlers = {
    extension_ui_response: gated ? handleSelect : handleUi,
    negotiate_protocol: handleNegotiate,
    get_state: handleState,
    prompt: handlePrompt,
    ...(abortable ? { abort: handleAbort } : {}),
    ...(scenario === "slash" ? { abort: handleSlashAbort } : {}),
    ...(scenario === "branch"
      ? { get_branch_messages: handleBranchMessages, branch: handleBranch }
      : {}),
  };
  const handler = handlers[type];
  if (handler) {
    await handler(frame);
    return;
  }
  await emit({
    type: "response",
    command: String(type ?? "parse"),
    success: false,
    error: "unsupported",
  });
}

async function handleNegotiate(frame) {
  protocol = 2;
  await emit({
    id: frame.id,
    type: "response",
    command: "negotiate_protocol",
    success: true,
    data: { protocolVersion: 2 },
  });
}

async function handleState(frame) {
  const data = sessionState();
  if (scenario === "chunked" || scenario === "interleaved") {
    if (protocol === 2) {
      data.pad = unicodePad();
      await emitChunked({
        id: frame.id,
        type: "response",
        command: "get_state",
        success: true,
        data,
      });
      return;
    }
  }
  await emit({
    id: frame.id,
    type: "response",
    command: "get_state",
    success: true,
    data,
  });
}

function sessionState() {
  const data = {
    model: { provider: "workbuddy", id: "deepseek-v4.1-flash" },
    thinkingLevel: "off",
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
  if (scenario === "missing-session") {
    return data;
  }
  if (scenario === "new-session") {
    data.sessionFile = "/tmp/open-wb-new-session.jsonl";
    return data;
  }
  data.sessionFile = currentSession;
  return data;
}

/** 同 omp v18.0.10 rpc-mode.ts:1347-1349：列表包在 data.messages 里。 */
async function handleBranchMessages(frame) {
  await emit({
    id: frame.id,
    type: "response",
    command: "get_branch_messages",
    success: true,
    data: { messages: branchMessages },
  });
}

/**
 * 已知 entry：wx 写出 session-dir 直属的新 .jsonl（不覆盖、不建 session-dir 本身）及其同名产物目录
 * （真 omp 在会话文件旁放工具完整输出的目录：一个文件 + 一层嵌套子目录），都写成功后才切换当前文件，
 * 再回 data:{text, cancelled:false}（rpc-mode.ts:488-491,1101-1105）。未知/缺失/非字符串 entryId
 * 回显 id 的错误帧（rpc-mode.ts:401,754-755）。写异常转错误帧，避免 reject 卡死串行 queue。
 */
async function handleBranch(frame) {
  const entry = branchMessages.find((message) => message.entryId === frame.entryId);
  if (entry === undefined) {
    await emitBranchError(frame.id, UNKNOWN_ENTRY);
    return;
  }
  let next;
  try {
    next = join(sessionDir, `branch-${randomUUID()}.jsonl`);
    const header = JSON.stringify({ type: "session", parentSession: currentSession });
    writeFileSync(next, `${header}\n`, { flag: "wx" });
    const artifacts = next.slice(0, -".jsonl".length);
    mkdirSync(join(artifacts, "local"), { recursive: true });
    writeFileSync(join(artifacts, "1.bash.log"), `${TOOL_OUTPUT}\n`);
    writeFileSync(join(artifacts, "local", "note.txt"), `${TOOL_OUTPUT}\n`);
  } catch (error) {
    await emitBranchError(frame.id, String(error?.message ?? error));
    return;
  }
  currentSession = next;
  await emit({
    id: frame.id,
    type: "response",
    command: "branch",
    success: true,
    data: { text: entry.text, cancelled: false },
  });
}

async function emitBranchError(id, error) {
  await emit({ id, type: "response", command: "branch", success: false, error });
}

function unicodePad() {
  return "你好".repeat(Math.ceil((THREE_MIB + 4096) / 6));
}

async function emitChunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD);
  for (let index = 0; index < count; index++) {
    if (scenario === "interleaved" && index === 1) {
      await emit({ type: "notice", level: "info", message: "interleave" });
    }
    await emit({
      type: "rpc_chunk",
      chunkId: "rpc-1",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * CHUNK_PAYLOAD, (index + 1) * CHUNK_PAYLOAD).toString("base64"),
    });
  }
}

/** prompt 回执；agentInvoked:false 即内建命令本地完成（rpc-mode.ts:1019-1054）。 */
async function promptAck(id, agentInvoked) {
  await emit({ id, type: "response", command: "prompt", success: true, data: { agentInvoked } });
}

function isSlashCommand(message) {
  return scenario === "slash" && (message === "/todo" || message === "/compact");
}

async function handlePrompt(frame) {
  if (isSlashCommand(frame.message)) {
    await slashTurn(frame);
    return;
  }
  await promptAck(frame.id, true);
  const turns = {
    crash: () => process.exit(2),
    "crash-after-deltas": () => crashAfterDeltas(),
    error: () => failTurn("fake omp scripted error"),
    "extension-ui": () => requestConfirm(),
    "call-proxy": () => runProxy(frame.message),
    "hang-prompt": () => {},
    thinking: () => thinkingTurn(),
    "edit-write": () => editWriteTurn(),
  };
  if (gated && abortTurn === "idle") {
    await openSelects(scenario === "approval-parallel" ? [CALL_1, CALL_2] : [CALL_1]);
    return;
  }
  if (ABORT_SCENARIOS.has(scenario) && abortTurn === "idle") {
    await (startMs > 0 ? delayHoldTurn() : holdTurn());
    return;
  }
  const turn = turns[scenario];
  if (turn) {
    await turn();
    return;
  }
  const report = probeReport(frame.message);
  if (report !== undefined) {
    await completeTurn([report], false);
    return;
  }
  await completeTurn(DELTAS, true);
}

function probeReport(message) {
  const text = String(message ?? "");
  if (text.startsWith("rename:")) {
    const path = text.slice(7);
    try {
      renameSync(path, `${path}.moved`);
      return "renamed=ok";
    } catch (error) {
      return `renamed=${error.code}`;
    }
  }
  if (!text.startsWith("probe:")) {
    return undefined;
  }
  const rest = text.slice(6);
  const colon = rest.indexOf(":");
  if (colon === -1) {
    return undefined;
  }
  const pid = rest.slice(0, colon);
  const writePath = rest.slice(colon + 1);
  if (!/^[0-9]+$/u.test(pid) || writePath.length === 0) {
    return undefined;
  }
  let wrote = "ok";
  try {
    writeFileSync(writePath, "probe", "utf8");
  } catch (error) {
    wrote = error.code;
  }
  let environ = "readable";
  try {
    readFileSync(`/proc/${pid}/environ`);
  } catch (error) {
    environ = error.code;
  }
  const env = Object.keys(process.env).sort().join(",");
  const xdg = (kind) => process.env[`XDG_${kind}_HOME`] ?? "";
  return `uid=${process.getuid()} gid=${process.getgid()} env=${env} home=${process.env.HOME ?? ""} xdgdata=${xdg("DATA")} xdgstate=${xdg("STATE")} xdgcache=${xdg("CACHE")} environ=${environ} wrote=${wrote} frames=${inbound.join(",")} cwd=${process.cwd()}`;
}

async function requestConfirm() {
  pendingUi = true;
  await emit({
    type: "extension_ui_request",
    id: UI_ID,
    method: "confirm",
    title: "Confirm",
    message: "Continue?",
  });
}

async function handleUi(frame) {
  if (!pendingUi || frame.id !== UI_ID || frame.cancelled !== true) {
    return;
  }
  pendingUi = false;
  await completeTurn(DELTAS, true);
}

/**
 * 发完 agent_start 与两段 delta 后返回：回合只记在 abortTurn，不 await abort，
 * 否则串行队列里的 abort 行永远排不到。
 */
async function holdTurn() {
  await emit({ type: "agent_start" });
  await emitDeltas(DELTAS.slice(0, 2));
  abortTurn = "pending";
}

/** ack 后 startMs 才把开回合排进串行 queue（期间照常读 stdin）；出队时仍为 starting 才开，否则已被 abort 丢弃。 */
function delayHoldTurn() {
  abortTurn = "starting";
  startTimer = setTimeout(() => {
    startTimer = undefined;
    queue = queue.then(() => (abortTurn === "starting" ? holdTurn() : null));
  }, startMs);
}

/** 同 omp v18.0.10 实测：先发全部 select，再发全部 start（不等作答）；随即返回，以免堵住串行队列。 */
async function openSelects(calls) {
  await emit({ type: "agent_start" });
  await emitDeltas(DELTAS);
  const content = calls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name,
    arguments: call.args,
  }));
  await emit({
    type: "message_end",
    message: { role: "assistant", content, stopReason: "toolUse" },
  });
  for (const [index, call] of calls.entries()) {
    await emitSelect(`r${index + 1}`, call);
  }
  for (const call of calls) {
    await emit(toolStart(call));
  }
  abortTurn = "selecting";
}

async function emitSelect(id, call) {
  pendingSelects.set(id, call);
  const title = `Allow tool: ${call.name}\nCommand: ${call.args.command}`;
  await emit({
    type: "extension_ui_request",
    id,
    method: "select",
    title,
    options: ["Approve", "Deny"],
  });
}

/**
 * 未知或已答 id 静默忽略（rpc-mode.ts:280-285）；每条应答只结束自己的调用。
 * approval-chain-abort-ignored：C1 结束后同步开出 r2 与 C2 并返回，仍为 selecting。
 */
async function handleSelect(frame) {
  const call = pendingSelects.get(frame.id);
  if (call === undefined) {
    return;
  }
  pendingSelects.delete(frame.id);
  const approved = !frame.cancelled && frame.value === "Approve";
  approvedAny ||= approved;
  const end = toolEnd(call, approved);
  await emit(end);
  const { content } = end.result;
  const message = { role: "toolResult", toolCallId: call.id, toolName: call.name, content };
  await emit({ type: "message_end", message: { ...message, isError: !approved } });
  if (scenario === "approval-chain-abort-ignored" && call === CALL_1) {
    await emitSelect("r2", CALL_2);
    await emit(toolStart(CALL_2));
    return;
  }
  if (pendingSelects.size === 0) {
    await settleSelects();
  }
}

/** 最后一条应答之后：延后的 abort 优先；否则 approval 或有 Approve 的 parallel 正常完成，其余挂起等 abort。 */
async function settleSelects() {
  if (deferredAbort !== undefined) {
    await emitAbortedEnd(deferredAbort.id);
  } else if (scenario === "approval" || (scenario === "approval-parallel" && approvedAny)) {
    await finishTurn();
    abortTurn = "done";
  } else {
    abortTurn = "pending";
  }
}

/**
 * 一个回合只记第一个 abort：selecting 态延后，starting 态丢弃整轮，pending 态兑现，其余状态无帧。
 * IGNORE_ABORT 必须先于 selecting 分支判断，否则 r1 挂起时的 abort 会被延后兑现（#470）。
 */
async function handleAbort(frame) {
  if (IGNORE_ABORT.has(scenario)) {
    return;
  }
  if (abortTurn === "selecting") {
    deferredAbort ??= { id: frame.id };
    return;
  }
  if (abortTurn === "starting") {
    await dropStartingTurn(frame.id);
    return;
  }
  if (abortTurn !== "pending") {
    return;
  }
  await emitAbortedEnd(frame.id);
}

/** 回合开始前的 abort（#495 实测）：只回执 success，该回合永不发 agent_start/delta/message_end/agent_end。 */
async function dropStartingTurn(id) {
  clearTimeout(startTimer);
  startTimer = undefined;
  abortTurn = "done";
  await emit({ id, type: "response", command: "abort", success: true });
}

/**
 * 门控进程里只有审批回合会走到这里：按 omp v18.0.10 Deny→abort 实测多一个空 aborted 回合
 * （turn_end、turn_start、带 errorMessage 的 aborted message_end、turn_end）。其余场景逐字节不变。
 */
async function emitAbortedEnd(id) {
  const message = { role: "assistant", content: [], stopReason: "aborted" };
  if (gated) {
    await emit({ type: "turn_end" });
    await emit({ type: "turn_start" });
    message.errorMessage = "Interrupted by user";
  }
  await emit({ type: "message_end", message });
  if (gated) {
    await emit({ type: "turn_end" });
  }
  await emit({ type: "agent_end", messages: [], isTerminal: true });
  await emit({ id, type: "response", command: "abort", success: true });
  abortTurn = "done";
}

/**
 * slash 内建命令，无 agent_start/agent_end。`/compact` 回执之后才登记定时器；到期回调不移出登记，
 * 只把输出追加到串行 queue（不与进行中的回合帧交错），出队时仍登记才发——在它之前处理的 abort 都能取消它。
 */
async function slashTurn(frame) {
  if (frame.message === "/todo") {
    await emit({ type: "command_output", text: TODO_OUTPUT });
    await promptAck(frame.id, false);
    return;
  }
  await promptAck(frame.id, false);
  if (silent) {
    return;
  }
  const timer = setTimeout(() => {
    queue = queue.then(() =>
      pendingOutputs.delete(timer) ? emit({ type: "command_output", text: COMPACT_OUTPUT }) : null,
    );
  }, COMPACT_DELAY_MS);
  pendingOutputs.add(timer);
}

/** slash：abort 任何时刻都回执（无 data，rpc-mode.ts:1086-1088），并取消全部未发出的 `/compact` 输出。 */
async function handleSlashAbort(frame) {
  for (const timer of pendingOutputs) {
    clearTimeout(timer);
  }
  pendingOutputs.clear();
  await emit({ id: frame.id, type: "response", command: "abort", success: true });
}

async function crashAfterDeltas() {
  await emit({ type: "agent_start" });
  await emitDeltas(DELTAS.slice(0, 2));
  process.exit(2);
}

async function completeTurn(deltas, tools) {
  await emit({ type: "agent_start" });
  await emitDeltas(deltas);
  if (tools) {
    await emitToolRound([CALL_1]);
  }
  await finishTurn();
}

/** `index` 缺省时事件无 contentIndex 键（JSON 省略 undefined），既有场景逐字节不变。 */
async function emitDeltas(deltas, index) {
  for (const delta of deltas) {
    await emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: index, delta },
      message: { role: "assistant", content: [] },
    });
  }
}

async function emitThinking(times) {
  for (const frame of thinkingFrames(times)) {
    await emit(frame);
  }
}

/** hold 下 thinking_end 后挂起（每个回合都挂起）；串行 queue 保证早到的 abort 在置 pending 之后才被处理。 */
async function thinkingTurn() {
  await emit({ type: "agent_start" });
  await emitThinking(thinkingRepeat);
  if (holdThinking) {
    abortTurn = "pending";
    return;
  }
  await emitDeltas(DELTAS, 1);
  await finishTurn(thinkingContent(thinkingRepeat, DELTAS.join("")));
}

/** 两个旋钮不作用于此：恒 repeat=1、不挂起。每个 end 帧之前真实写出它报告的文件。 */
async function editWriteTurn() {
  await emit({ type: "agent_start" });
  await emitThinking(1);
  const steps = editWriteSteps(process.cwd());
  await emit(toolUseEnd(steps));
  for (const step of steps) {
    await emit(toolStart(step.call));
    await emit(stepEnd(step, writeStepFile(step)));
  }
  await emitDeltas(ANSWER_DELTAS);
  await finishTurn();
}

function writeStepFile(step) {
  try {
    mkdirSync(dirname(step.file), { recursive: true });
    writeFileSync(step.file, step.content, "utf8");
  } catch (error) {
    return String(error?.code ?? error);
  }
}

async function emitToolRound(calls) {
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "toolUse" },
  });
  for (const call of calls) {
    await emit(toolStart(call));
    await emit(toolEnd(call));
  }
}

function toolStart(call) {
  return {
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: call.args,
  };
}

/** 成功帧同既有工具轮（无 isError）；拒绝帧同 wrapper.ts:337-340 与 agent-loop.ts:2625-2631。 */
function toolEnd(call, approved = true) {
  const text = approved ? TOOL_OUTPUT : `Tool call denied by user: ${call.name}`;
  return {
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    result: { content: [{ type: "text", text }], details: approved ? { exitCode: 0 } : {} },
    ...(approved ? {} : { isError: true }),
  };
}

/** content 缺省为 []，既有回合逐字节不变；thinking 回合传入 [thinking 块, 文本块]。 */
async function finishTurn(content = []) {
  await emit({
    type: "message_end",
    message: { role: "assistant", content, stopReason: "stop" },
  });
  await emit({ type: "agent_end", messages: [], isTerminal: true });
}

async function failTurn(errorMessage) {
  await emit({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error", errorMessage },
  });
  await emit({ type: "agent_end", messages: [], isTerminal: true });
}

/**
 * 有界两轮继电器（#166）：第一轮带 tool_calls 时报告工具帧并发唯一一次第二轮；
 * 回答轮没有内容（空 200、第二轮仍只有 tool_calls）一律可见失败，绝不空回合成功。
 */
async function runProxy(message) {
  try {
    const baseUrl = loadBaseUrl();
    const token = process.env.WORKBUDDY_MODEL_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("config");
    }
    const user = { role: "user", content: message };
    const first = await postChat(baseUrl, token, [user]);
    if (first.calls.length > 0) {
      await relayToolRound(baseUrl, token, user, first);
      return;
    }
    if (first.deltas.length === 0) {
      throw new Error("empty round");
    }
    await completeTurn(first.deltas, false);
  } catch {
    await failTurn("proxy failed");
  }
}

async function relayToolRound(baseUrl, token, user, first) {
  const calls = Array.from(first.calls, parseToolCall);
  await emit({ type: "agent_start" });
  await emitDeltas(first.deltas);
  await emitToolRound(calls);
  const second = await postChat(baseUrl, token, [
    user,
    {
      role: "assistant",
      content: first.deltas.length > 0 ? first.deltas.join("") : null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: TOOL_OUTPUT })),
  ]);
  if (second.calls.length > 0 || second.deltas.length === 0) {
    throw new Error("no answering content");
  }
  await emitDeltas(second.deltas);
  await finishTurn();
}
