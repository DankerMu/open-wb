# Spec delta: omp-runtime（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。fork/regenerate 使用的临时进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（含 `--approval-mode write`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；四个目录在 spawn 时已存在

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, the four directories SHALL already exist, and parent env SHALL remain unchanged

### Requirement: RPC IO and child observation
The transport SHALL classify every `extension_ui_request` frame. A frame whose `method` is exactly `select`, whose `options` array is exactly `["Approve","Deny"]` in that order and whose `title` string starts with `Allow tool: ` is an **approval request**: the transport SHALL NOT answer it itself, SHALL expose it to its owner as an approval request carrying the frame `id`, the full `title` and a `tool` name parsed from the first line of the title after `Allow tool: ` (parsing failure or empty name yields `unknown`, and the request still counts as an approval request), and SHALL keep the child waiting. Every other extension UI request (any other `method`, a `select` with different options or a non-matching title, or a request lacking a string `id` handled as before) SHALL be cancelled immediately with `{type:"extension_ui_response",id:<request id>,cancelled:true}` exactly as before. The transport SHALL expose `respondApproval(id, decision)` that writes exactly one `{type:"extension_ui_response",id,value:"Approve"}` for `allow` or `{…,value:"Deny"}` for `deny`; a second answer for the same `id` SHALL NOT be written. It SHALL expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

#### Scenario: Extension UI cancellation
- **WHEN** the fake requests extension UI during a prompt with a non-approval shape (`method` other than `select`, or a `select` whose options are not exactly `["Approve","Deny"]` or whose title does not start with `Allow tool: `)
- **THEN** it receives {type:extension_ui_response,id:the-request-id,cancelled:true} without user interaction and proceeds

#### Scenario: Approval request is surfaced, not cancelled
- **WHEN** the fake, spawned with `--approval-mode write`, sends `extension_ui_request{method:"select",title:"Allow tool: bash\n…",options:["Approve","Deny"]}` before a bash step
- **THEN** no `extension_ui_response` is written for that id until the owner answers, the owner observes one approval request with that id, `tool` equal to `bash` and the original title, and the fake emits no further turn frames while it waits

#### Scenario: Approval answers map to exact values
- **WHEN** the owner answers an outstanding approval request with `allow`, and separately another with `deny`, and then answers either a second time
- **THEN** exactly one `extension_ui_response{id,value:"Approve"}` respectively `{id,value:"Deny"}` reaches the child, the fake proceeds (executing on Approve, reporting `tool_execution_end{isError:true}` on Deny), and the second answer writes nothing
- **WHEN** the title first line cannot be parsed as `Allow tool: <name>`
- **THEN** the request is still surfaced as an approval request with `tool` equal to `unknown` and is not auto-cancelled

#### Scenario: Child crash or write failure
- **WHEN** a child crashes, is signalled, fails to spawn, or a command cannot be written
- **THEN** affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

### Requirement: 每会话生命周期
SessionRuntime SHALL lazily acquire one child generation on the first prompt, reuse it across completed turns, reset its injected-clock idle timer on every child frame and accepted prompt, and retire it on idle expiry or shutdown. While at least one approval request of the current generation is pending (`markPending()` called and not yet balanced by `clearPending()`), the idle timer SHALL be suspended; when the last pending approval is cleared the timer SHALL be re-armed with the full idle duration. Retirement SHALL close stdin, send SIGTERM if still alive after 5 seconds, and SIGKILL if still alive after a further 3 seconds. Tokens SHALL be issued per generation and revoked exactly once on native death or failed startup without a live child. Caller-provided persisted resumePath and later successful sessionFile SHALL be retained as the last-known-good path for --resume; failed startup SHALL preserve that path, and only startup with no known path SHALL retry cold. Interrupted active turns SHALL fail and report the original child exit once. Every native exit of a generation that obtained a live child — idle expiry, explicit shutdown/retirement (including supervisor-driven eviction), crash during or between turns — SHALL invoke the caller-provided `onExit` callback exactly once with the original code/signal, whether or not a turn was active; the callback SHALL run after the generation's token is revoked and SHALL NOT be invoked for a generation that never obtained a pid. Public shutdown SHALL be idempotent and prevent subsequent prompts.

#### Scenario: Lazy startup and normal reuse
- **WHEN** a runtime is constructed, then receives and completes two prompts
- **THEN** construction issues no token and spawns no process; both prompts run through one child and expose all ordered frames through the true terminal event

#### Scenario: Idle reset and restart
- **WHEN** child frames or a new prompt arrive before idle expires, then activity stops for the configured duration
- **THEN** each activity resets the deadline; expiry closes stdin and reclaims the child, revokes its token, and the next prompt spawns with a fresh token and the exact last successful sessionFile as --resume

#### Scenario: Pending approval suspends idle expiry
- **WHEN** an approval request is marked pending and the injected clock advances past the idle duration, then the approval is cleared
- **THEN** no retirement occurs while pending; after clearing, the child is retired only once the full idle duration elapses again without activity

#### Scenario: Every exit reaches onExit once
- **WHEN** a generation exits through idle expiry, through shutdown, through an externally requested retirement between turns, or through a crash
- **THEN** `onExit` is invoked exactly once per generation with the actual code/signal in each case, after its token is revoked; a generation that never obtained a pid produces no `onExit` call

#### Scenario: Persisted resume in a new runtime
- **WHEN** a newly constructed runtime receives a previously persisted sessionFile from its caller, including after an unsuccessful first startup
- **THEN** its first and retry spawns use the exact --resume path until a new successful handshake replaces it; omitted/null initial path produces no --resume argument

#### Scenario: Bounded escalation
- **WHEN** a retiring child exits on EOF, waits for TERM, or ignores EOF and TERM
- **THEN** real process observation respectively proves no unnecessary signal, TERM at 5000ms, or KILL at 8000ms; no signal occurs before its deadline, early death cancels remaining escalation, and shutdown observes actual native exit without fabricating it

#### Scenario: Crash during a turn
- **WHEN** a child exits before a terminal prompt outcome
- **THEN** already received frames remain observable, the active iterator fails, the exit callback receives the original code/signal exactly once, the token is revoked and the next prompt resumes using the successful sessionFile

#### Scenario: Startup failure and shutdown race
- **WHEN** startup fails before a sessionFile is accepted or shutdown races delayed startup
- **THEN** no false successful session path is retained, every acquired child/token is reclaimed, no prompt is sent after shutdown, and cold retry is possible only on a runtime not explicitly shut down

#### Scenario: Prompt lifecycle signals
- **WHEN** an ACK, nonterminal agent_end, unrelated response, matching local-only outcome or matching delayed failure arrives
- **THEN** ACK/nonterminal/unrelated frames do not end the turn; agent_end with isTerminal absent or true completes it, matching agentInvoked=false completes local-only work, and a same-id failure after ACK fails the turn; events before ACK remain visible

#### Scenario: Concurrency and abandoned consumption
- **WHEN** prompts overlap or a consumer abandons an active iterator
- **THEN** overlap is rejected without a second command/child and abandonment reclaims the active generation instead of making it available for an overlapping turn

#### Scenario: Native death before pipe closure
- **WHEN** native exit precedes buffered terminal frames or stdout is held open
- **THEN** token revocation does not wait for pipe closure, valid buffered frames are drained before logical completion, and held pipes are reclaimed within the 8-second drain budget with unfinished work failed using the original exit

#### Scenario: Retired generation callbacks and transport errors
- **WHEN** old frame/exit/timer callbacks arrive after retirement, or transport failure interrupts an active turn
- **THEN** old callbacks cannot affect the new child, token or turn; transport failure is sanitized, fails the current turn and reclaims its generation rather than silently yielding success

## ADDED Requirements

### Requirement: 相关命令 API 与回合中断
SessionRuntime SHALL 暴露两类经 `OmpProcess.request` 的相关（correlated）命令 API，均以独立 id 发送并只被 id 与 command 同时匹配的 `response` 结算（沿用「Correlated responses」规则）。
`abort()` SHALL 仅在存在活跃回合时写出 `{type:"abort",id}` 并返回其 response Promise；没有活跃回合或没有存活子进程时 SHALL 不写任何帧并返回 `false`，不抛错。`abort` 的 response（`command:"abort"`）SHALL 只结算 abort 请求，不得结束或失败当前 prompt 的 iterator；回合是否结束仍由随后的 `agent_end` 决定。
`command(frame)` SHALL 接受 `get_branch_messages`、`branch{entryId}` 与 `get_state` 三种帧：若当前存在活跃回合 SHALL 同步抛出 `SessionBusyError` 而不写帧；若没有存活子进程 SHALL 经与 `prompt` 相同的惰性获取路径（同一 spawn 契约、握手、token、`--resume` 最后已知路径）先获取一个 generation，再发送该帧；返回匹配 response 的 `data`。`branch` 成功后 `command({type:"get_state"})` 返回的 `sessionFile` SHALL 被视为新的 last-known-good path 供后续 `--resume`。`command` 期间 SHALL 视为活动：重置空闲计时器，且与 `prompt` 互斥（进行中的 `command` 使并发 `prompt`/`command` 抛 `SessionBusyError`）。子进程在 `command` 未结算前退出 SHALL 使该 Promise 以 `AgentUnavailableError` 拒绝并按既有路径回收 generation。

#### Scenario: abort during a turn ends the turn as aborted
- **WHEN** a prompt is active on the real fake (`abort-ok`) and `abort()` is called
- **THEN** exactly one `{type:"abort",id}` frame is written, the iterator then observes `message_end{stopReason:"aborted"}`, terminal `agent_end` and the correlated `response{command:"abort"}`, the abort Promise resolves, and a following prompt on the same generation is accepted without a new spawn

#### Scenario: abort without an active turn is a no-op
- **WHEN** `abort()` is called on a runtime with no active turn, before any spawn or between turns
- **THEN** nothing is written to the child, no child is spawned and the call returns `false`

#### Scenario: Branch command family outside a turn
- **WHEN** an idle runtime with a persisted sessionFile receives `command(get_branch_messages)`, then `command(branch{entryId})`, then `command(get_state)` against the real fake (`branch`)
- **THEN** the child is acquired with `--resume <persisted file>`, each call resolves with the matching response data, `get_state` returns the new file created by branch, and that file becomes the `--resume` path of the next acquisition

#### Scenario: Command during a turn or after child death
- **WHEN** `command(get_branch_messages)` is called while a prompt is active, or the child exits before the command response arrives
- **THEN** the in-turn call throws `SessionBusyError` synchronously without writing a frame; the interrupted call rejects with `AgentUnavailableError`, the generation is reclaimed and its token revoked exactly once
