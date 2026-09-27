# Spec delta: omp-runtime（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

## MODIFIED Requirements

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装。

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
The transport SHALL classify every `extension_ui_request` frame. A frame whose `method` is exactly `select`, whose `options` array is exactly `["Approve","Deny"]` in that order and whose `title` string starts with `Allow tool: ` is an **approval request**: the transport SHALL NOT answer it itself, SHALL expose it to its owner as an approval request carrying the frame `id`, the full `title` and a `tool` name parsed from the first line of the title after `Allow tool: ` (parsing failure or empty name yields `unknown`, and the request still counts as an approval request), and SHALL keep the child waiting. Every other extension UI request (any other `method`, a `select` with different options or a non-matching title, or a request lacking a string `id` handled as before) SHALL be cancelled immediately with `{type:"extension_ui_response",id:<request id>,cancelled:true}` exactly as before. The transport SHALL expose `respondApproval(id, decision)` that writes exactly one `{type:"extension_ui_response",id,value:"Approve"}` for `allow` or `{…,value:"Deny"}` for `deny`; a second answer for the same `id` SHALL NOT be written. Neither the transport nor SessionRuntime SHALL ever answer an approval request on its own under any condition — no timeout answer, no fallback `Deny`, no answer on stop, retirement, shutdown or child exit; `respondApproval` called by the owner is the only writer of an approval answer, and an approval left unanswered when the child exits simply ends with that child (settlement of its record is the owner's concern). It SHALL expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

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

#### Scenario: Unanswered approval is never answered by the runtime
- **WHEN** an approval request is outstanding and the owner does not call `respondApproval`, while the injected clock advances well past 60000ms and the generation is then retired or shut down
- **THEN** no `extension_ui_response` (neither `Approve`, `Deny` nor `cancelled`) is ever written for that id by the transport or runtime; retirement proceeds with the normal stdin→TERM→KILL contract

#### Scenario: Child crash or write failure
- **WHEN** a child crashes, is signalled, fails to spawn, or a command cannot be written
- **THEN** affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

### Requirement: 每会话生命周期
SessionRuntime SHALL lazily acquire one child generation on the first prompt, reuse it across completed turns, reset its injected-clock idle timer on every child frame and accepted prompt, and retire it on idle expiry or shutdown. The runtime SHALL track pending approvals of the current generation as a set keyed by approval id: `markPending(approvalId)` adds the id, `clearPending(approvalId)` removes it, marking an id already present or clearing an id not present SHALL be a no-op, and several ids MAY be pending at once. While the set is non-empty the idle timer SHALL be suspended; when the last pending id is cleared the timer SHALL be re-armed with the full idle duration from that moment. The set SHALL be discarded with its generation. Retirement SHALL close stdin, send SIGTERM if still alive after 5 seconds, and SIGKILL if still alive after a further 3 seconds. Tokens SHALL be issued per generation and revoked exactly once on native death or failed startup without a live child. Caller-provided persisted resumePath and later successful sessionFile SHALL be retained as the last-known-good path for --resume; failed startup SHALL preserve that path, and only startup with no known path SHALL retry cold. Interrupted active turns SHALL fail and report the original child exit once. Every native exit of a generation that obtained a live child — idle expiry, explicit shutdown/retirement (including supervisor-driven eviction), crash during or between turns — SHALL invoke the caller-provided `onExit` callback exactly once with the original code/signal, whether or not a turn was active; the callback SHALL run after the generation's token is revoked and SHALL NOT be invoked for a generation that never obtained a pid. Public shutdown SHALL be idempotent and prevent subsequent prompts.
Local-only completion (`server/src/sessions/omp/local-command.ts`, a pure decision over the dispatched text and the frames seen since dispatch, wired into the runtime's frame handler): a matching `agentInvoked:false` outcome (`response{command:"prompt",success:true,data:{agentInvoked:false}}` or `prompt_result{agentInvoked:false}` with the turn's request id) completes the turn immediately when the dispatched prompt text does not start with `/` (the pre-existing behaviour; after chat-sessions「Slash 命令白名单与命令目录」 only whitelisted commands reach the runtime with a leading `/`) or when at least one `command_output` frame has been seen since that prompt was written; when the text starts with `/` and none has been seen, the turn enters `awaiting-output` and completes at the first `command_output` frame or, failing that, when the injected clock has advanced `LOCAL_COMMAND_GRACE_MS` = 120000 ms since the outcome, whichever comes first. A matching `agentInvoked:true` outcome never completes a turn (the turn ends by agent_end as usual). Frames arriving during `awaiting-output` are pushed to the turn stream and reset the idle timer as usual; a terminal agent_end or a matching failure during the wait ends the turn by the ordinary rules; the grace timer SHALL be cancelled when the turn ends or the generation retires and SHALL never end a later turn. The rule keys on the leading `/` of the dispatched text only; it knows no command names. A `command_output` that arrives after the grace expired is handled like any frame of whatever turn is then active (dropped when none is): the host does not filter it, so a compaction slower than 120 s may append its completion text to the next turn's body — an accepted, documented residual.

#### Scenario: Lazy startup and normal reuse
- **WHEN** a runtime is constructed, then receives and completes two prompts
- **THEN** construction issues no token and spawns no process; both prompts run through one child and expose all ordered frames through the true terminal event

#### Scenario: Idle reset and restart
- **WHEN** child frames or a new prompt arrive before idle expires, then activity stops for the configured duration
- **THEN** each activity resets the deadline; expiry closes stdin and reclaims the child, revokes its token, and the next prompt spawns with a fresh token and the exact last successful sessionFile as --resume

#### Scenario: Pending approval suspends idle expiry
- **WHEN** an approval request is marked pending and the injected clock advances past the idle duration, then the approval is cleared
- **THEN** no retirement occurs while pending; after clearing, the child is retired only once the full idle duration elapses again without activity

#### Scenario: Several pending approvals suspend idle until the last is cleared
- **WHEN** approvals `a1` and `a2` are marked pending, `clearPending(a1)` is called twice, the injected clock advances past the idle duration, and then `clearPending(a2)` is called
- **THEN** no retirement occurs while `a2` is still pending (the repeated clear of `a1` does not re-arm the timer); after clearing `a2` the child is retired only once the full idle duration elapses again without activity

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
- **WHEN** an ACK, nonterminal agent_end, unrelated response, matching local-only outcome (for a prompt not starting with `/`, or one preceded by a `command_output`), or matching delayed failure arrives
- **THEN** ACK/nonterminal/unrelated frames do not end the turn; agent_end with isTerminal absent or true completes it, a matching agentInvoked=false completes local-only work immediately for a prompt whose text does not start with `/` and for one that follows at least one `command_output`, and a same-id failure after ACK fails the turn; events before ACK remain visible

#### Scenario: Local-only outcome waits for late command output
- **WHEN** the real fake (`slash`) answers `/todo` (output before the receipt) and, on another turn, `/compact` (receipt before the output), a prompt `hello` is answered by a bare `agentInvoked:false` receipt and a prompt `/x` by a `command_output` then an `agentInvoked:true` receipt then agent frames (both with hand-written frames on the wired fake child, as in the existing local-only tests; the `slash` fixture runs `hello` as a normal turn), and the real fake (`slash --compact-silent`) answers `/compact` with a receipt and no output
- **THEN** the `/todo` turn ends at the receipt with its `command_output` already in the stream; `hello` ends at the receipt as before; the `/compact` turn does not end at the receipt and ends exactly when `command_output{text:"Compaction complete."}` arrives, that frame being the last one exposed by the iterator; the `/x` turn ends only at its terminal agent_end; the silent turn ends when the injected clock advances 120000 ms after the receipt, no later, with no fabricated frame; a subsequent prompt on each runtime reuses the same child, and a cancelled grace timer (turn already ended or generation retired) never ends a later turn

#### Scenario: Concurrency and abandoned consumption
- **WHEN** prompts overlap or a consumer abandons an active iterator
- **THEN** overlap is rejected without a second command/child and abandonment reclaims the active generation instead of making it available for an overlapping turn

#### Scenario: Native death before pipe closure
- **WHEN** native exit precedes buffered terminal frames or stdout is held open
- **THEN** token revocation does not wait for pipe closure, valid buffered frames are drained before logical completion, and held pipes are reclaimed within the 8-second drain budget with unfinished work failed using the original exit

#### Scenario: Retired generation callbacks and transport errors
- **WHEN** old frame/exit/timer callbacks arrive after retirement, or transport failure interrupts an active turn
- **THEN** old callbacks cannot affect the new child, token or turn; transport failure is sanitized, fails the current turn and reclaims its generation rather than silently yielding success

### Requirement: 审批请求经 SessionRuntime 转接
SessionRuntime SHALL accept an optional synchronous constructor callback `onApproval(request)` and SHALL forward to it, synchronously and unchanged, each approval request (`{id, title, tool}`, see 「RPC IO and child observation」) surfaced by the `OmpProcess` of a generation, but only when that generation is still the runtime's current generation and a prompt turn whose `prompt` frame has been written is active on that generation — the same generation/turn gate that decides whether a child frame joins the active turn. An approval request surfaced by a generation that is no longer current, or arriving while no such turn is active on the current generation (between turns, or before the turn's `prompt` frame is written), SHALL be dropped: it is not forwarded and not answered, and it simply ends with that child like any unanswered approval. Forwarding SHALL NOT mark the approval pending and SHALL NOT affect the idle timer by itself; `markPending`/`clearPending` remain explicit owner calls. SessionRuntime SHALL expose `respondApproval(id, decision)` that passes the owner's `allow`/`deny` answer unchanged to the current generation's `OmpProcess.respondApproval`, and SHALL be a no-op — no frame, no throw, no spawn — when the runtime has no current generation (before the first acquisition, after retirement, after shutdown) or when the current generation's `OmpProcess` no longer accepts input (for example while it is retiring). SessionRuntime SHALL NOT answer an approval request on its own and SHALL NOT write `extension_ui_response` itself; `OmpProcess` remains its only writer.

#### Scenario: Approval requests reach the owner only from the active turn of the current generation
- **WHEN** the real fake `approval` scenario, spawned with `--approval-mode write`, surfaces select `r1` during an active prompt turn of the current generation, and separately an approval-shaped select is surfaced between turns, before the turn's `prompt` frame is written, or by a generation that is no longer current
- **THEN** `onApproval` is called exactly once with `{id:"r1", title, tool:"bash"}` carrying the original title; the other requests are never forwarded and no `extension_ui_response` is written for them

#### Scenario: respondApproval passes through to the current generation
- **WHEN** the owner calls `respondApproval("r1","allow")` on the runtime for the forwarded request, then calls it again, and separately calls it before any generation exists, while the generation is retiring and after shutdown
- **THEN** exactly one `extension_ui_response{id:"r1",value:"Approve"}` reaches the child, which proceeds to finish the tool call and the turn; every other call writes nothing, throws nothing and spawns no child

#### Scenario: Forwarding alone does not suspend idle expiry
- **WHEN** an approval request is forwarded and the owner does not call `markPending`, and the injected clock then advances by the idle duration
- **THEN** the generation is retired on idle expiry as usual, no answer is written for the outstanding approval, and `onExit` reports the child's actual exit once

## ADDED Requirements

### Requirement: 相关命令 API 与回合中断
SessionRuntime SHALL 暴露两类经 `OmpProcess.request` 的相关（correlated）命令 API，均以独立 id 发送并只被 id 与 command 同时匹配的 `response` 结算（沿用「Correlated responses」规则）。
`abort()` SHALL 仅在存在活跃回合（该回合的 `prompt` 帧已成功写出，即自其派发回执 `dispatched`（见「Prompt dispatch receipt」）可兑现之时起；不要求已收到 `agent_start` 等任何子进程帧）时写出 `{type:"abort",id}` 并返回其 response Promise；没有活跃回合、`prompt` 已被调用但其帧尚未写出（仍在获取/握手）、或没有存活子进程时 SHALL 不写任何帧并返回 `false`，不抛错，且不影响那次仍在进行的 `prompt` 调用（其获取、握手与派发照常继续）。`false` 对 owner 的语义是"尚无已派发的回合"：owner 据此登记停止意图，并在其等待中的该 prompt 派发回执兑现后再次调用 `abort()`——此时回合已活跃，该调用 SHALL 写出 `abort` 帧（turn-control 停止生成 REST）；owner 不得把 `false` 当作失败或等待崩溃路径。runtime 不为停止意图新增任何接口。`abort` 的 response（`command:"abort"`）SHALL 只结算 abort 请求，不得结束或失败当前 prompt 的 iterator；回合是否结束仍由随后的 `agent_end` 决定。
`command(frame)` SHALL 接受 `get_branch_messages`、`branch{entryId}` 与 `get_state` 三种帧：若当前存在活跃回合 SHALL 同步抛出 `SessionBusyError` 而不写帧；若没有存活子进程 SHALL 经与 `prompt` 相同的惰性获取路径（同一 spawn 契约、握手、token、`--resume` 最后已知路径）先获取一个 generation，再发送该帧——这与 `prompt` 触发的获取是**同一种**获取：SHALL 恰调用一次 owner 提供的 `tokens.issue`，与 prompt 获取对 owner 的上报完全一致（会话进程的 owner 借此递增 `stream_epoch` 并建立该 generation 的 ring；fork 临时进程的 owner 接入不递增 epoch 的 token 适配器，runtime 契约不变）；随后在同一 generation 上的 `command`/`prompt` SHALL 复用它而不再次调用 `issue`；返回匹配 response 的 `data`。`branch` 成功后 `command({type:"get_state"})` 返回的 `sessionFile` SHALL 被视为新的 last-known-good path 供后续 `--resume`。`command` 期间 SHALL 视为活动：重置空闲计时器，且与 `prompt` 互斥（进行中的 `command` 使并发 `prompt`/`command` 抛 `SessionBusyError`）。子进程在 `command` 未结算前退出 SHALL 使该 Promise 以 `AgentUnavailableError` 拒绝并按既有路径回收 generation。

#### Scenario: abort during a turn ends the turn as aborted
- **WHEN** a prompt is active on the real fake (`abort-ok`) and `abort()` is called
- **THEN** exactly one `{type:"abort",id}` frame is written, the iterator then observes `message_end{stopReason:"aborted"}`, terminal `agent_end` and the correlated `response{command:"abort"}`, the abort Promise resolves, and a following prompt on the same generation is accepted without a new spawn

#### Scenario: abort without an active turn is a no-op
- **WHEN** `abort()` is called on a runtime with no active turn, before any spawn or between turns
- **THEN** nothing is written to the child, no child is spawned and the call returns `false`

#### Scenario: Branch command family outside a turn
- **WHEN** an idle runtime with a persisted sessionFile receives `command(get_branch_messages)`, then `command(branch{entryId})`, then `command(get_state)` against the real fake (`branch`)
- **THEN** the child is acquired with `--resume <persisted file>`, each call resolves with the matching response data, `get_state` returns the new file created by branch, and that file becomes the `--resume` path of the next acquisition

#### Scenario: abort right after the dispatch receipt
- **WHEN** `prompt()` has been called on a runtime whose real fake is `slow-ready` (delayed `ready`, then `abort-ok` behaviour), `abort()` is called before `dispatched` resolves, and the owner calls `abort()` again as soon as `dispatched` resolves
- **THEN** the first `abort()` returns `false` and writes nothing, while the pending prompt still acquires, handshakes and writes its `prompt` frame; the second call writes exactly one `{type:"abort",id}` frame, after the `prompt` frame; the iterator observes `message_end{stopReason:"aborted"}`, terminal `agent_end` and the correlated `response{command:"abort"}`, the abort Promise resolves, and a following prompt on the same generation is accepted without a new spawn or a second `issue`

#### Scenario: Command acquisition reports the generation like prompt
- **WHEN** a runtime with no live child receives `command(get_branch_messages)` and then a `prompt` on the same generation
- **THEN** the owner's `tokens.issue` is called exactly once, before the command frame is written, exactly as for a prompt-triggered acquisition; the following prompt reuses that generation without another `issue` or spawn

#### Scenario: Command during a turn or after child death
- **WHEN** `command(get_branch_messages)` is called while a prompt is active, or the child exits before the command response arrives
- **THEN** the in-turn call throws `SessionBusyError` synchronously without writing a frame; the interrupted call rejects with `AgentUnavailableError`, the generation is reclaimed and its token revoked exactly once
