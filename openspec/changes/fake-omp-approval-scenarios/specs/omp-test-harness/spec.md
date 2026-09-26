# Spec delta: omp-test-harness（#458 fake-omp approval）

> 父 delta「假 omp 进程契约」的 S1c 段由 6.1–6.6 分担（#456/#457/#458/#459/#461/#470）。6.1 #456 的 `abort-ok`/`abort-ignored` 与 6.2 #457 的 `--session-dir`/`branch` 已在主 spec 中。本 delta 只并入：argv `--approval-mode <mode>`、`approval`/`approval-then-abort`/`approval-parallel` 三段与 Scenario「审批 select 门控 bash」「并行审批各自应答」「select 挂起时 abort 被延后」，均逐字取自父 delta。其余部分由对应 issue 归档时 MODIFIED 并入：`approval-chain-abort-ignored` 段与 Scenario「审批链上 abort 被忽略」归 6.6 #470；`slow-ready`/`--ready-delay-ms` 段与 Scenario「延迟握手」归 6.5 #461；probe `frames=` 与 Requirement「假 omp 入站帧记录」归 6.4 #459。父 delta 句首「support eight scripted scenarios (…)」的完整列表在最后一个 issue 归档时恢复。

## MODIFIED Requirements

### Requirement: 假 omp 进程契约
The standalone zero-dependency Node fixture SHALL expose JSONL stdin/stdout frames matching omp v18.0.10 commit 33cc6b9a043a74e00a157e72ca909272796d8461 for its supported commands, with explicit argv-selected scenarios. It SHALL not replace production code or contact a real model service in its contract tests.
For S1c turn control the fixture SHALL additionally parse `--session-dir <dir>` and `--approval-mode <mode>` from argv and support the argv-selected scripted scenarios `abort-ok`, `abort-ignored`, `branch`, `approval`, `approval-parallel` and `approval-then-abort`. `abort-ok`: after prompt ack, `agent_start` and two text deltas the turn waits; on an inbound `abort` frame it emits `message_end` with `stopReason` `aborted`, terminal `agent_end` and `response{command:"abort"}` echoing the abort id, then accepts a further prompt as a normal turn; an `abort` read before `agent_start` and the two deltas have been emitted is honored right after them, so the host always sees `agent_start`, the two deltas, `message_end aborted`, `agent_end` in that order. `abort-ignored`: same held turn, but inbound `abort` produces no frame at all and the process stays alive until stdin closes or a signal arrives (bounded-fallback probe). `branch`: `get_branch_messages` responds with a fixed deterministic list of at least two user entries `[{entryId,text}]` documented in the fixture; `branch{entryId}` for a known entry writes a real new nonempty `.jsonl` file under the `--session-dir` directory (distinct from the resumed/default path), switches the process to it so every subsequent `get_state.sessionFile` returns that new path, and responds `{text}` with that entry's text; an unknown `entryId` yields an error response and leaves `sessionFile` unchanged. `approval`: when argv contains `--approval-mode write`, a prompt turn emits `agent_start`, text deltas and `message_end stopReason toolUse`, then `tool_execution_start` for bash, and only then (mirroring real omp, where the agent loop emits `tool_execution_start` before the tool wrapper asks) emits `extension_ui_request{id, method:"select", title:"Allow tool: bash\n…", options:["Approve","Deny"]}` (exactly the recognizer shape of omp-runtime) and emits no further frame until a matching `extension_ui_response{id}` arrives; `{value:"Approve"}` continues with the normal `tool_execution_end` and completion, any other value or `cancelled` emits `tool_execution_end` with `isError: true` before completing; without `--approval-mode write` the same scenario behaves as `normal` and emits no select. `approval-then-abort`: like `approval`, but after the select's answer and that answer's `tool_execution_end` (with `isError: true` for any value other than `Approve` or for `cancelled`) the turn is held exactly like `abort-ok` — no completion frame — until an inbound `abort`, which is then honored with `message_end aborted`, terminal `agent_end` and `response{command:"abort"}` echoing the abort id, after which a further prompt is accepted as a normal turn; an `abort` arriving while the select is still pending produces no frame until the select is answered and is honored right after that answer's `tool_execution_end`. A host that writes `Deny` and then `abort` (the stop order) therefore gets a deterministic aborted end. `approval-parallel`: when argv contains `--approval-mode write`, a prompt turn emits `agent_start`, text deltas and one `message_end stopReason toolUse` carrying two bash tool calls, then two `tool_execution_start` frames for bash with distinct `toolCallId`s, and then two `extension_ui_request` selects of the same recognizer shape with distinct `id`s (one per tool call, in tool-call order) back to back, before either is answered; each select is answered independently and in any order: a matching `extension_ui_response{id}` emits the `tool_execution_end` of that select's own tool call only (successful for `Approve`, `isError: true` for any other value or `cancelled`), the other call stays pending. Once both are answered: if at least one answer was `Approve` and no `abort` has arrived, the turn continues to its normal text, assistant `message_end` and terminal `agent_end`; if every answer was a denial (`Deny`, any other value or `cancelled`) and no `abort` has arrived, the turn is held exactly like `abort-ok` — no completion frame — until an inbound `abort`, which is then honored (modelling the model's follow-up call during which a host's stop, which denies every pending select before writing `abort`, lands). An `abort` arriving while either select is still pending produces no frame of its own until both are answered: each answer still emits its own tool call's `tool_execution_end` immediately as above, and after the last one, instead of the normal completion and whatever the answers were, the abort is honored with `message_end aborted`, terminal `agent_end` and `response{command:"abort"}` echoing the abort id. Without `--approval-mode write` it behaves as `normal`. Existing scenarios and defaults SHALL remain unchanged.

#### Scenario: 默认握手与完整回合
- WHEN a spawned fixture receives negotiate_protocol version 2, get_state and prompt with request ids
- THEN ready advertises supported transport; successful responses echo ids, negotiation data has protocolVersion 2, get_state data has nonempty sessionFile; prompt ack precedes a turn containing at least three message_update.assistantMessageEvent text_delta frames, matching tool_execution_start/end, assistant message_end and terminal agent_end

#### Scenario: 握手故障与进程退出
- WHEN no-ready or missing-session is selected
- THEN respectively no ready frame is emitted or get_state omits sessionFile, while the difference is observable through a real subprocess
- WHEN idle normal stdin closes
- THEN the process exits cleanly without leaking resources

#### Scenario: 字节级分块与交错
- WHEN chunked get_state follows successful v2 negotiation
- THEN rpc_chunk frames are individually within 1MiB and concatenate decoded bytes into the exact greater-than-3MiB Unicode JSON object; chunkId/index/count/byteLength are consistent
- WHEN interleaved is selected
- THEN an unrelated frame deliberately interrupts that sequence so downstream decoders can reject it

#### Scenario: 回合失败与交互取消
- WHEN crash or error is selected and a prompt is accepted
- THEN crash exits nonzero without terminal completion, while error emits assistant stopReason error with errorMessage before terminal agent_end
- WHEN extension-ui is selected
- THEN a confirm request is emitted, and terminal completion waits for a matching cancelled extension_ui_response

#### Scenario: 真实代理承载
- WHEN call-proxy reads the managed providers.workbuddy configuration and receives a prompt
- THEN it POSTs the prompt messages with stream true to baseUrl/chat/completions using the environment WORKBUDDY_MODEL_TOKEN bearer; if the streamed response carries tool calls it reassembles them, reports each as matching tool_execution_start/end frames carrying the upstream tool call id and name, and POSTs one second request whose messages are the original user message, the assistant tool-call message and a role tool result for that call id; streamed content of the answering round maps to text_delta without byte-boundary corruption, and the turn ends successfully after DONE
- WHEN a 200 response ends without content or tool calls, or the second round again yields only tool calls
- THEN the assistant message ends with stopReason error rather than a successful empty turn
- WHEN configuration is invalid or the local HTTP request fails
- THEN the failure is observable without a fabricated successful reply or a token leak into stdout/stderr

#### Scenario: abort 收尾与忽略
- **WHEN** `abort-ok` accepts a prompt and then receives `abort` with request id X
- **THEN** after the two deltas no completion is emitted until the abort; then `message_end` with `stopReason` `aborted`, `agent_end` and `response{id:X, command:"abort"}` follow in that order, and a subsequent prompt completes as a normal turn
- **WHEN** `abort-ignored` receives `abort` in the same position
- **THEN** no frame is emitted afterwards, the process does not exit on its own, and it still exits when stdin closes or SIGTERM arrives

#### Scenario: branch 产生真实新会话文件
- **WHEN** `branch` is spawned with `--session-dir <dir>` and `--resume <old>`, receives `get_branch_messages`, then `branch{entryId}` for the last listed entry, then `get_state`
- **THEN** the list is the fixed documented user entries; a new nonempty `.jsonl` file exists under `<dir>` that is not `<old>`; the branch response `text` equals that entry's text; `get_state.sessionFile` equals the new path
- **WHEN** `branch` is sent an unknown `entryId`
- **THEN** an error response is returned, no file is created and `get_state.sessionFile` is unchanged

#### Scenario: 审批 select 门控 bash
- **WHEN** `approval` is spawned with `--approval-mode write` and accepts a prompt
- **THEN** `tool_execution_start` for bash is followed by a `select` request with options exactly `["Approve","Deny"]` and title starting `Allow tool: bash`, and no further frame arrives until it is answered
- **WHEN** the response value is `Approve`
- **THEN** a successful `tool_execution_end` and normal completion follow
- **WHEN** the response value is `Deny` or the response is `cancelled`
- **THEN** `tool_execution_end` carries `isError: true` and the turn still completes with `agent_end`
- **WHEN** `approval` is spawned with `--approval-mode yolo`
- **THEN** the turn matches the `normal` scenario and no `extension_ui_request` is emitted

#### Scenario: 并行审批各自应答
- **WHEN** `approval-parallel` is spawned with `--approval-mode write` and accepts a prompt
- **THEN** two bash `tool_execution_start` frames with distinct `toolCallId`s are followed by two `select` requests with distinct ids, both emitted before any answer, and no further frame arrives until an answer
- **WHEN** the second select is answered `Deny` first and then the first select is answered `Approve`
- **THEN** after the `Deny` exactly one `tool_execution_end` arrives, for the second tool call, with `isError: true`, and nothing else until the other answer; after the `Approve` the first tool call's `tool_execution_end` arrives without `isError`, followed by normal completion and terminal `agent_end` — only the denied step is `isError`
- **WHEN** both selects are pending and an `abort` with request id X arrives, then the first select and then the second are answered `Deny`
- **THEN** no frame follows the `abort` until the first answer; each `Deny` is followed by exactly its own tool call's `tool_execution_end` with `isError: true`; after the second one `message_end` with `stopReason` `aborted`, terminal `agent_end` and `response{id:X, command:"abort"}` follow in that order, with no normal completion
- **WHEN** both selects are answered `Deny` with no `abort` yet, and an `abort` with request id X arrives afterwards
- **THEN** after the two `tool_execution_end` frames with `isError: true` nothing is emitted until the `abort`; then `message_end` with `stopReason` `aborted`, terminal `agent_end` and `response{id:X, command:"abort"}` follow in that order
- **WHEN** `approval-parallel` is spawned with `--approval-mode yolo`
- **THEN** the turn matches the `normal` scenario and no `extension_ui_request` is emitted

#### Scenario: select 挂起时 abort 被延后
- **WHEN** `approval-then-abort` has a pending select and receives `abort`
- **THEN** nothing is emitted until `extension_ui_response` for the select arrives; then `tool_execution_end` (isError for Deny), `message_end aborted`, `agent_end` and `response{command:"abort"}` follow in that order, so a host that answers Deny before abort can be proven by frame order
- **WHEN** `approval-then-abort` has its select answered `Deny` and only afterwards receives `abort`
- **THEN** `tool_execution_end` with `isError: true` follows the answer, nothing further is emitted until the `abort`, and then `message_end aborted`, `agent_end` and `response{command:"abort"}` follow in that order
