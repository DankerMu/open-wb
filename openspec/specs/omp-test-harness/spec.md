# omp-test-harness Specification

## Purpose
Define the standalone fake omp protocol fixture and its real-child probe reporting contract, supporting deterministic RPC tests and later Linux identity-isolation verification without claiming production enforcement.
## Requirements
### Requirement: 假 omp 进程契约
The standalone zero-dependency Node fixture SHALL expose JSONL stdin/stdout frames matching omp v18.0.10 commit 33cc6b9a043a74e00a157e72ca909272796d8461 for its supported commands, with explicit argv-selected scenarios. It SHALL not replace production code or contact a real model service in its contract tests.
For S1c turn control the fixture SHALL additionally parse `--session-dir <dir>` from argv and support the argv-selected scripted scenarios `abort-ok`, `abort-ignored` and `branch`. `abort-ok`: after prompt ack, `agent_start` and two text deltas the turn waits; on an inbound `abort` frame it emits `message_end` with `stopReason` `aborted`, terminal `agent_end` and `response{command:"abort"}` echoing the abort id, then accepts a further prompt as a normal turn; an `abort` read before `agent_start` and the two deltas have been emitted is honored right after them, so the host always sees `agent_start`, the two deltas, `message_end aborted`, `agent_end` in that order. `abort-ignored`: same held turn, but inbound `abort` produces no frame at all and the process stays alive until stdin closes or a signal arrives (bounded-fallback probe). `branch`: `get_branch_messages` responds with a fixed deterministic list of at least two user entries `[{entryId,text}]` documented in the fixture; `branch{entryId}` for a known entry writes a real new nonempty `.jsonl` file under the `--session-dir` directory (distinct from the resumed/default path), switches the process to it so every subsequent `get_state.sessionFile` returns that new path, and responds `{text}` with that entry's text; an unknown `entryId` yields an error response and leaves `sessionFile` unchanged. Existing scenarios and defaults SHALL remain unchanged.

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

### Requirement: 假 omp probe 回报
For prompt `probe:<pid>:<writePath>`, the fake omp SHALL first attempt to write UTF-8 `probe` at the complete writePath using its own credentials, then attempt to read `/proc/<pid>/environ`. It SHALL emit one text delta with fields in order `uid=<uid> gid=<gid> env=<comma-separated sorted environment keys> home=<HOME> agent=<PI_CODING_AGENT_DIR> environ=<readable|errno> wrote=<ok|errno>`, based on its own process and actual IO outcomes. It SHALL reuse normal prompt acknowledgement and assistant stop/terminal agent_end frames even when either IO operation fails. It SHALL not disclose arbitrary environment values or proc contents. Non-probe behavior SHALL remain unchanged.

#### Scenario: 同 uid 成功
- WHEN an ordinary Linux real child receives a probe for its same-uid parent with a writable test-owned path containing colons and spaces
- THEN identity equals that of the parent, environment keys are sorted, HOME/agent equal supplied values, environ is readable, wrote is ok, and exact file content is probe before normal completion

#### Scenario: IO 失败独立回报
- WHEN the destination parent does not exist or the target proc pid does not exist
- THEN the failed operation reports ENOENT, the other operation is still attempted and truthfully reported, and the process emits its normal terminal completion

#### Scenario: 非 Linux 不伪造证明
- WHEN the child runs on macOS without procfs
- THEN it reports the actual proc read errno while identity, environment, file content and terminal behavior remain verifiable; this result is not reported as Linux readability or uid isolation proof

#### Scenario: 非 probe 兼容
- WHEN an existing non-probe prompt/scenario is exercised
- THEN the #87 handshake, scenario-specific frame sequence, and normal shutdown remain unchanged

### Requirement: Isolated bounded upstream dialogue gate
The existing loopback fake-upstream SHALL expose test-only authenticated gate control using its existing expected bearer: POST `/__control/gates/{uuid}` arm, GET phase, POST `/__control/gates/{uuid}/release` release held response, DELETE cleanup. Gate identity SHALL bind one final text response selected by the last user's `WORKBUDDY_UI_WALK:<uuid>` marker; the tool round remains unchanged. An armed final response SHALL send role and first nonempty content prefix but withhold remaining content/finish/DONE until explicit release. Released bytes SHALL reconstruct the unchanged fixed reply. Default/unarmed requests SHALL retain existing behavior.
The fixture SHALL reject wrong bearer401, invalid ID400, duplicate arm or invalid transition409, unknown ID404 and claims of an already-bound gate without stealing ownership. Gates SHALL be instance-local, bounded to32 entries and30s lifetime; expiry/delete/disconnect/server close SHALL clear owned timers/state and destroy unfinished held responses instead of forging completion. Control failure SHALL not release another gate. No gate route SHALL exist in product app-server.

#### Scenario: Hold and release preserve real protocol
- WHEN an authenticated test arms a UUID gate and real omp sends matching final text request after bash
- THEN the upstream publishes prefix and held phase without finish; release sends the remaining original chunks and DONE exactly once

#### Scenario: Ownership and cleanup fail closed
- WHEN two distinct gates coexist, a request targets a different/unknown gate, authentication fails, a transition duplicates, or TTL/delete/disconnect/close occurs
- THEN only the owning gate can change; invalid controls fail explicitly, unfinished cancelled responses do not complete successfully and no owned gate/timer remains after cleanup

