# omp-runtime Specification

## Purpose
Defines pinned omp binary supply, least-privilege child spawning, bounded RPC transport, per-session lifecycle, and prompt-dispatch receipt semantics.

## Requirements

### Requirement: 二进制供给
`make omp-fetch` SHALL 只从 `can1357/oh-my-pi` GitHub release **v18.0.10** 拉取与当前 `uname -sm` 匹配的资产（`omp-darwin-arm64` 或 `omp-linux-x64`），对照仓内固定的 SHA256 表校验后落到 `var/omp/omp` 并置可执行位；校验失败 SHALL 不留下 `var/omp/omp`；目标已存在且校验通过 SHALL 跳过下载。不支持的平台 SHALL 显式失败并打印支持矩阵。app-server SHALL 不依赖 PATH 上的任何 `omp`。

#### Scenario: 首次拉取与幂等
- WHEN 在空 `var/omp/` 下执行 `make omp-fetch`
- THEN 产出 `var/omp/omp`，`var/omp/omp --version` 输出 `omp/18.0.10`；再次执行不产生网络下载且退出 0

#### Scenario: 摘要不符
- WHEN 下载内容的 SHA256 与固定表不一致
- THEN 退出非 0，stderr 含 expected/actual 摘要，且 `var/omp/omp` 不存在

#### Scenario: 不支持平台
- WHEN uname -sm is neither Darwin arm64 nor Linux x86_64
- THEN the command SHALL fail nonzero with the supported platform matrix without downloading

#### Scenario: Make contract protection
- WHEN an equivalent duplicate `omp-fetch :` target or a changed recipe is injected
- THEN the existing harness oracle SHALL reject the mutation while accepting the intended Makefile

### Requirement: 子进程 spawn 契约
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` session-dir、home、agent 三个目录；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并 `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话）。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd；见 vendored omp v18.0.10 `coding-agent/src/main.ts:728-775,1697-1712`、`session-manager.ts:2846-2871`），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--cwd <SANDBOX_ROOT>/u1`，含 `--approval-mode write`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；session-dir、home、agent 与作为 cwd 的所有者根四个目录在 spawn 时已存在（事先不存在的由宿主 `mkdir -p` 建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir, home and agent SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates), and parent env SHALL remain unchanged

#### Scenario: 绑定空间的会话以空间根为 cwd
- **WHEN** owner `u1` 的会话绑定了 `dir` 为 `proj` 的工作空间（`workspace_id` 非 null），其首个 prompt 触发 spawn，随后 resume spawn，且同一 owner 另有一个未绑定会话 spawn
- **THEN** `<SANDBOX_ROOT>/u1/proj` 在首次 spawn 前已由工作空间创建建出，宿主只校验不创建；绑定会话两次 spawn 的 argv 都含 `--cwd <SANDBOX_ROOT>/u1/proj`，其余参数与未绑定会话逐字相同（`--session-dir <OMP_STATE_DIR>/sessions/u1` 不随空间变化）；真实 fake 子进程经 probe 回报的 `cwd=` 等于 `<SANDBOX_ROOT>/u1/proj`（`process.cwd()` 的真实路径）；未绑定会话的 `--cwd` 与 probe `cwd=` 仍为 `<SANDBOX_ROOT>/u1`

#### Scenario: 绑定空间根缺失时不创建不 spawn
- **WHEN** owner `u1` 绑定 `proj` 的会话在下一次 spawn 前，`<SANDBOX_ROOT>/u1/proj` 被应用之外的操作删除（或被同名文件占据）
- **THEN** 宿主的存在性检查失败，`spawnOmp` 不被调用、没有子进程、不签发可用 token；`<SANDBOX_ROOT>/u1/proj` 仍不存在（未被 `mkdir -p` 重建）；没有以 `<SANDBOX_ROOT>/u1` 或任何其它路径替代 spawn

#### Scenario: resume 以会话文件头的 cwd 为准
- **WHEN** 一个已持久化 `omp_session_file` 的会话被 resume spawn，而 spawn 传入的 `--cwd` 与该文件头记录的 cwd 不同（例如同一 owner 的另一目录）
- **THEN** 这是宿主依赖的 omp 行为而非宿主实现：真实 omp 在该目录可进入时以文件头 cwd 为会话工作目录，后传的 `--cwd` 不迁移已存在的会话；宿主侧可测的约定是对同一会话（及其 regenerate、fork 进程）的每次 spawn 均传入同一按规则取得的 `<CWD>`，host 测试断言同一绑定会话的首次与 resume argv 中 `--cwd` 逐字相等，fake omp 不模拟此 omp 行为，也不以 fake 结果冒充对它的证明

### Requirement: RPC 握手与帧层
OmpProcess SHALL reuse spawnOmp, wait for ready, negotiate protocol v2, then request get_state with distinct correlated ids. start SHALL resolve with nonempty data.sessionFile only after both matching successful responses, and SHALL otherwise reject with agent_unavailable and terminate the child within the configured startup failure path. One overall handshake deadline SHALL default to 10000ms. It SHALL start only after the child has been spawned; when the owning SessionRuntime is given a spawn gate (see omp-pool「并发 spawn 上限」), spawning happens only after a permit has been granted, so time spent queued for a permit SHALL NOT count against the deadline. This transport SHALL return sessionFile; persistence belongs to the supervisor.

#### Scenario: Successful handshake
- WHEN the real fake omp advertises v2 and successfully answers negotiation and get_state
- THEN start resolves with its sessionFile and repeated start does not spawn another child

#### Scenario: Failed startup
- WHEN ready is absent, negotiation fails, get_state lacks nonempty sessionFile, or the child exits during startup
- THEN start rejects, never reports readiness, clears pending state and terminates a still-running child

#### Scenario: Correlated responses
- WHEN responses arrive out of order or with a wrong id or command
- THEN only a response matching both id and command settles its request; later same-id prompt failures remain observable frames

#### Scenario: Queue time excluded from the deadline
- WHEN a supervisor with spawn concurrency 1 and handshakeTimeoutMs H cold-starts three sessions at once against fake-omp `slow-ready` with ready delay D, where D < H < 3·D
- THEN all three handshakes succeed and each prompt is accepted (202, dispatched), although the third session's total wait from prompt to ready exceeds H

### Requirement: Bounded lossless RPC transport
The transport SHALL enforce physical and logical limits (at most 1 MiB and 64 MiB respectively), reconstruct ordered contiguous rpc_chunk sequences using validated metadata/base64 and strict UTF-8, and emit only complete JSON objects. Invalid sequences SHALL report a sanitized protocol error and discard partial state without crashing the reading loop. Malformed JSON lines SHALL be recoverable. Outbound frames SHALL be unchunked JSONL within the physical limit.

#### Scenario: Large Unicode frame
- WHEN the real chunked fake emits its greater-than-3-MiB Unicode response over arbitrary pipe boundaries
- THEN consumers receive exactly the original object without corruption or rpc_chunk fragments

#### Scenario: Invalid chunk or interrupted sequence
- WHEN metadata, order, base64, byte length, UTF-8 or limits are invalid, or a normal frame interrupts a chunk sequence
- THEN the decoder rejects the affected sequence, emits no partial payload and can process subsequent independent valid frames

#### Scenario: Invalid line and truncated EOF
- WHEN malformed JSON is followed by valid JSONL or EOF truncates a line/chunk sequence
- THEN malformed input is reported without raw payload disclosure; a following valid frame remains readable, and truncated payload is never emitted

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

### Requirement: Prompt dispatch receipt
SessionRuntime.prompt(text) SHALL retain its existing single AsyncIterable interface and additionally expose dispatched, a Promise resolving to the exact requestId and validated sessionFile after the prompt write succeeds following handshake. It SHALL NOT infer receipt from ACK, first event or turn completion. Existing consumers that only iterate SHALL preserve frame order, terminal/error delivery, cancellation and native-resource ownership without an unhandled rejection from the added Promise.
Pre-dispatch acquisition, write, cancellation or shutdown failure SHALL reject the receipt and terminate the iterable faithfully; a resolved receipt SHALL never be retroactively rejected by later turn failure. Buffered frames arriving before receipt SHALL remain available in order. The extracted stream SHALL be one canonical implementation and retain the existing bounded native retirement semantics.
prompt() SHALL preserve its existing synchronous closed/busy throws; a receipt exists only when an iterable has been returned. This addition SHALL NOT change existing runtime error sanitization.
#### Scenario: Exact request correlation with early frames
- WHEN a child sends lifecycle frames before its prompt ACK, and send completion is deliberately held
- THEN the iterable preserves those frames, dispatched remains pending until successful write completion, and its requestId equals the actual outbound prompt id rather than any observed response id
#### Scenario: Acquisition and write rejection
- WHEN spawn, handshake, stdin write or pre-dispatch cancellation/shutdown fails
- THEN dispatched rejects, no accepted receipt is fabricated, old iterator consumers observe their existing failure/cancellation behavior and no child/token is leaked
#### Scenario: Successful dispatch is not terminal completion
- WHEN the prompt is written successfully but the child remains in a nonterminal turn
- THEN dispatched resolves without waiting for agent_end, while the iterator remains active and later failure is observable there

### Requirement: Pid-less spawn failure retirement
A SessionRuntime generation whose child never obtained a pid SHALL be treated as having no live child from the moment spawn returns. Retiring such a generation (by shutdown, by the failed acquisition itself, or by cancellation; idle expiry cannot apply because the idle timer is armed only after a successful acquire), even when retirement starts before Node reports the spawn error, SHALL revoke its token exactly once and complete without waiting for any TERM/KILL grace and without awaiting a native exit, independent of whether the failed child ever reports `exitCode` or emits `'error'`. A child that obtained a pid SHALL keep the existing retirement contract even if it later emits `'error'` while still running; such an `'error'` SHALL NOT mark the generation as a failed spawn nor drop its child handle, so its held stdio is still reclaimed within the shutdown drain budget.

#### Scenario: Shutdown races a missing-binary spawn
- **WHEN** shutdown starts inside the spawn call of a missing-binary generation, before the spawn error tick
- **THEN** shutdown settles without advancing the injected clock, no timers remain pending, no signal is sent, the token is revoked exactly once and the prompt rejects with agent_unavailable

#### Scenario: Pid-less child that never reports failure
- **WHEN** spawn returns a pid-less child that never emits `'error'` and never sets `exitCode`
- **THEN** the failed acquisition's retirement and a later shutdown both settle at clock 0 with no pending timers

#### Scenario: Live child emitting error keeps the grace contract
- **WHEN** a child with a pid emits `'error'` while still running and the generation is retired
- **THEN** stdin is closed, SIGTERM is sent at 5000 ms and SIGKILL at 8000 ms unless the child actually exits first

#### Scenario: Live child error before exit keeps held-pipe reclaim
- **WHEN** a retiring child with a pid emits `'error'`, then exits natively before SIGTERM would be sent while its stdout stays open
- **THEN** no signal is sent, its stdout is destroyed exactly when the 8000 ms shutdown budget measured from retirement start elapses and not before, retirement settles only then, and the token is revoked exactly once

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`omp/commands.ts` SHALL 承载 `SessionRuntime` 的模块级辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助）以及 command/abort/pending 计时面，由 `omp/runtime.ts` 引用；它 SHALL 不新增未被引用的导出，且对 `runtime.ts` 只有类型导入。`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名与导入路径 SHALL 保持在 `runtime.ts`/`process.ts`。`omp/ui-requests.ts` SHALL 承载 `extension_ui_request` 的分类（审批请求或即时回绝）、审批 `title` 的工具名解析与 `extension_ui_response` 应答帧形状：它是无状态的纯函数模块，不持有传输状态、不写子进程 stdin，不导入 `./process.js`、`./runtime.js` 或 `./commands.js`；`OmpProcess` 仍是 `extension_ui_response` 的唯一写出者，由它决定是否与何时写出。`runtime.ts` 与 `commands.ts` 对 `./ui-requests.js` SHALL 至多有语句级 `import type`（不得有值导入、副作用导入、动态导入，也不得 re-export 其中的符号），审批请求的类型可由此引入，应答帧的构造与写出不得出现在这两个文件中。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`runtime.ts` 从 `./commands.js` 引用上述辅助而 `commands.ts` 对 `./runtime.js` 只有 `import type`，runtime/process 测试全绿

#### Scenario: UI 请求分类模块边界
- **WHEN** 运行 `knip`、`bash scripts/size-guard.sh`，并检查 `server/src/sessions/omp/` 的导入方向与 `extension_ui_response` 写出点
- **THEN** `process.ts` 从 `./ui-requests.js` 引用分类、工具名解析与应答帧形状；`ui-requests.ts` 不导入 `./process.js`、`./runtime.js`、`./commands.js`；`server/src/sessions/omp/` 中只有 `process.ts` 向子进程 stdin 写出 `extension_ui_response`；size-guard 退出 0，knip 无未引用导出

#### Scenario: 运行时对 UI 请求模块只有类型依赖
- **WHEN** 检查 `server/src/sessions/omp/runtime.ts` 与 `commands.ts` 中引用 `./ui-requests.js` 的全部语句
- **THEN** 每一条都是语句级 `import type`，不存在值导入、副作用导入、动态导入或 re-export；两个文件都不含 `extension_ui_response` 字面量，也不引用应答帧构造函数

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

### Requirement: 相关命令 API 与回合中断
SessionRuntime SHALL 暴露两类经 `OmpProcess.request` 的相关（correlated）命令 API，均以独立 id 发送并只被 id 与 command 同时匹配的 `response` 结算（沿用「Correlated responses」规则）。
`abort()` SHALL 仅在存在活跃回合（该回合的 `prompt` 帧已成功写出，即自其派发回执 `dispatched`（见「Prompt dispatch receipt」）可兑现之时起）时返回 abort response 的 Promise，并且 SHALL 只在该回合**已开始**之后写出 `{type:"abort",id}`。「已开始」指该回合的 iterator 已收到 `agent_start`，或已收到该 prompt 报告本地完成结果的帧（`response{command:"prompt"}` 的 `data.agentInvoked===false` 或 `prompt_result{agentInvoked:false}`，与本地完成等待同一判定）。原因：真 omp v18.0.10 在回合开始前收到的 `abort` 会让仍在预处理的 prompt 静默放弃，两个 response 都为 success，此后没有该回合的任何帧，用户条目也不写入会话历史。回合已开始时调用 SHALL 立即写出该帧。派发回执已兑现而回合未开始时调用 SHALL 此刻不写帧，返回一个推迟的 Promise：在该回合开始时（处理使其开始的那一帧的同一同步段内）写出恰一帧 `abort`，并以其 response 结算；如果使其开始的帧同时结束了该回合（本地完成且无需再等待输出），SHALL 不写帧并以 `AgentUnavailableError` 拒绝；回合在开始前结束（terminal `agent_end`）、失败、其 iterator 被取消（`return()`），或其 generation 退役、子进程退出时，该 Promise SHALL 以 `AgentUnavailableError` 拒绝且不写帧；在使其开始的帧上写出之前 SHALL 重新核对同一 generation、未在退役、子进程存活，任一不满足同样拒绝。回合开始前对同一回合再次调用 `abort()` SHALL 返回同一个推迟的 Promise，不另登记、不多写帧；回合已开始后的再次调用照常各写一帧（owner 的停止去重保证至多一次，见 turn-control）。此外，没有活跃回合、`prompt` 已被调用但其帧尚未写出（仍在获取/握手）、没有存活子进程、或该回合所在 generation 正在退役时 SHALL 不写任何帧并返回 `false`，不抛错，且不影响那次仍在进行的 `prompt` 调用（其获取、握手与派发照常继续）。在该 prompt 派发回执兑现之前取得的 `false` 对 owner 的语义是"尚无已派发的回合"：owner 据此登记停止意图，并在其等待中的该 prompt 派发回执兑现后再次调用 `abort()`——此时回合已活跃，该调用 SHALL 返回 abort response 的 Promise，`abort` 帧按上文规则在该回合已开始后写出（turn-control 停止生成 REST）；owner 不得把这种 `false` 当作失败或等待崩溃路径。在派发回执已兑现之后取得的 `false`（子进程已死或 generation 正在退役）表示该回合正经失败路径收尾：owner SHALL 丢弃其停止意图，不再重试 `abort()`。runtime 不为停止意图新增任何接口。`abort` 的 response（`command:"abort"`）SHALL 只结算 abort 请求，不得结束或失败当前 prompt 的 iterator；回合是否结束仍由随后的 `agent_end` 决定。
`command(frame)` SHALL 接受 `get_branch_messages`、`branch{entryId}` 与 `get_state` 三种帧：若当前存在活跃回合 SHALL 同步抛出 `SessionBusyError` 而不写帧；若没有存活子进程 SHALL 经与 `prompt` 相同的惰性获取路径（同一 spawn 契约、握手、token、`--resume` 最后已知路径）先获取一个 generation，再发送该帧——这与 `prompt` 触发的获取是**同一种**获取：SHALL 恰调用一次 owner 提供的 `tokens.issue`，与 prompt 获取对 owner 的上报完全一致（会话进程的 owner 借此递增 `stream_epoch` 并建立该 generation 的 ring；fork 临时进程的 owner 接入不递增 epoch 的 token 适配器，runtime 契约不变）；随后在同一 generation 上的 `command`/`prompt` SHALL 复用它而不再次调用 `issue`；返回匹配 response 的 `data`。匹配 response 的 `success` 不为 `true`（例如 `branch` 的未知 `entryId`）时 SHALL 以 `AgentUnavailableError` 拒绝，且不因此回收 generation（是否 retire 由 owner 决定）。`branch` 成功后 `command({type:"get_state"})` 返回的 `sessionFile` SHALL 被视为新的 last-known-good path 供后续 `--resume`。`command` 期间 SHALL 视为活动：重置空闲计时器，且与 `prompt` 互斥（进行中的 `command` 使并发 `prompt`/`command` 抛 `SessionBusyError`）。子进程在 `command` 未结算前退出 SHALL 使该 Promise 以 `AgentUnavailableError` 拒绝并按既有路径回收 generation。`command` 在途时子进程产生协议错误（畸形行、超限行、非法 chunk 元数据）SHALL 与回合内同类错误一样回收该 generation，使该 Promise 以 `AgentUnavailableError` 拒绝，不等待空闲回收。runtime 已 `shutdown` 后调用 `command` SHALL 与 `prompt` 一样同步抛出 `AgentUnavailableError`，不写帧、不 spawn。

#### Scenario: abort during a turn ends the turn as aborted
- **WHEN** a prompt is active on the real fake (`abort-ok`) and `abort()` is called
- **THEN** exactly one `{type:"abort",id}` frame is written, the iterator then observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}` (which the child sends after `agent_end`, so it is not an iterator frame), and a following prompt on the same generation is accepted without a new spawn

#### Scenario: abort without an active turn is a no-op
- **WHEN** `abort()` is called on a runtime with no active turn, before any spawn or between turns
- **THEN** nothing is written to the child, no child is spawned and the call returns `false`

#### Scenario: Branch command family outside a turn
- **WHEN** an idle runtime with a persisted sessionFile receives `command(get_branch_messages)`, then `command(branch{entryId})`, then `command(get_state)` against the real fake (`branch`)
- **THEN** the child is acquired with `--resume <persisted file>`, each call resolves with the matching response data, `get_state` returns the new file created by branch, and that file becomes the `--resume` path of the next acquisition

#### Scenario: abort right after the dispatch receipt
- **WHEN** `prompt()` has been called on a runtime whose real fake is `slow-ready` (delayed `ready`, then `abort-ok` behaviour), `abort()` is called before `dispatched` resolves, and the owner calls `abort()` again as soon as `dispatched` resolves
- **THEN** the first `abort()` returns `false` and writes nothing, while the pending prompt still acquires, handshakes and writes its `prompt` frame; the second call writes exactly one `{type:"abort",id}` frame, after the `prompt` frame and not before the turn's `agent_start` has reached the runtime; the iterator observes `message_end{stopReason:"aborted"}` and terminal `agent_end` and ends, the abort Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation is accepted without a new spawn or a second `issue`

#### Scenario: abort response alone does not end the turn
- **WHEN** a turn has a resolved dispatch receipt but is still waiting for a late `command_output` (real fake `slash --compact-silent`, prompt `/compact`), `abort()` is called and the child answers only `response{command:"abort"}`
- **THEN** exactly one `abort` frame is written, the abort Promise resolves with that response, the response reaches the iterator as an ordinary frame of the still-active turn without ending it, and the turn still ends only when the local-command grace elapses on the injected clock; a following prompt reuses the same child

#### Scenario: Command acquisition reports the generation like prompt
- **WHEN** a runtime with no live child receives `command(get_branch_messages)` and then a `prompt` on the same generation
- **THEN** the owner's `tokens.issue` is called exactly once, before the command frame is written, exactly as for a prompt-triggered acquisition; the following prompt reuses that generation without another `issue` or spawn

#### Scenario: Command during a turn or after child death
- **WHEN** `command(get_branch_messages)` is called while a prompt is active, or the child exits before the command response arrives
- **THEN** the in-turn call throws `SessionBusyError` synchronously without writing a frame; the interrupted call rejects with `AgentUnavailableError`, the generation is reclaimed and its token revoked exactly once

#### Scenario: Command failure response and closed runtime
- **WHEN** `command(branch{entryId})` names an entry the real fake (`branch`) does not know, and separately `command` is called after `shutdown()`
- **THEN** the first rejects with `AgentUnavailableError` while the generation stays current and the next `command` on it resolves without a new spawn or `issue`; the call after shutdown throws `AgentUnavailableError` synchronously, writes nothing and spawns no child

#### Scenario: abort before the turn starts is deferred to agent_start
- **WHEN** a runtime runs the real fake `abort-ok --start-delay-ms 200` (the held turn opens 200ms after the prompt ack) and `abort()` is called as soon as `dispatched` resolves; separately `slow-ready --ready-delay-ms 300 --start-delay-ms 200` where the first `abort()` precedes the receipt and a second follows it
- **THEN** the call after the receipt returns a Promise and no `abort` frame is written until the turn's `agent_start` reaches the runtime; then exactly one `abort` frame is written after the `prompt` frame, the iterator observes `agent_start`, the two deltas, `message_end{stopReason:"aborted"}` and terminal `agent_end`, the Promise resolves with the correlated `response{command:"abort"}`, and a following prompt on the same generation completes without a new spawn

#### Scenario: deferred abort is rejected when the turn never starts
- **WHEN** `abort()` is deferred after the receipt and the turn then ends without starting: the real fake `crash` exits after its prompt ack, or the real fake `slash` answers `/todo` with its output and a local completion response that ends the turn
- **THEN** no `abort` frame is written; the Promise rejects with `AgentUnavailableError`; the iterator ends through its existing failure or completion path; after `/todo` the next prompt reuses the same child

#### Scenario: local completion that awaits output opens the deferred abort
- **WHEN** `abort()` is deferred after the receipt of `/compact` on the real fake `slash --compact-silent`, and the local completion response arrives while the turn keeps waiting for a late `command_output`
- **THEN** exactly one `abort` frame is written as that response is processed, the Promise resolves with the abort response, and the turn still ends only when the local-command grace elapses on the injected clock

### Requirement: 握手超时可观测
SessionRuntime SHALL 接受可选同步 `log` 端口（supervisor 经 `sessionRuntimeOpts` 传入；未传则丢弃）。当一次 acquisition 因握手 deadline 到期而失败（`AgentUnavailableError` 原因为 `handshake timeout`）时，runtime SHALL 在该错误向调用方传播之前恰调用一次 `log({event:"omp_handshake_timeout", sessionId, reason:"handshake timeout", elapsedMs})`：`sessionId` 为该 runtime 的会话 id，`elapsedMs` 为自进入该次 acquisition（含排队等待许可）至握手 deadline 失败被 runtime 捕获（在退役该 generation 之前）的整数毫秒，取与握手 deadline 相同的真实单调时间源（不取注入时钟）。其它启动失败（spawn 失败、negotiate/get_state 失败、子进程提前退出、关停取消）SHALL 不产生记录。`log` 抛出或返回 thenable SHALL 被吞掉，原错误照常传播，调用方仍得到 502 `agent_unavailable`。

#### Scenario: 握手超时写一条记录
- **WHEN** fake-omp `no-ready` 子进程使一次 prompt 的握手在 `handshakeTimeoutMs` 后超时
- **THEN** REST prompt 返回 502 `agent_unavailable`；`log` 恰收到一条记录，键集合恰为 `event`、`sessionId`、`reason`、`elapsedMs`，`sessionId` 为该会话 id，`elapsedMs ≥ handshakeTimeoutMs`

#### Scenario: 非超时的启动失败不记录
- **WHEN** `OMP_BIN` 指向不存在的路径使 spawn 报 `ENOENT`，或 `log` 端口自身抛出
- **THEN** 前者 `log` 未被调用；后者 REST 仍返回 502 `agent_unavailable` 且无未处理异常
