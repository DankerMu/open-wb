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
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <CWD> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode write --no-extensions --no-lsp --no-pty --no-title --config <OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 启动（`--config` 的取值由「宿主 overlay」规定，恒为绝对路径），**仅当** `chat_sessions.omp_session_file` 非 null 时在其后追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。`<CWD>` SHALL 按会话取值：`chat_sessions.workspace_id` 非 null 时为该会话绑定空间的根 `<SANDBOX_ROOT>/<ownerId>/<dir>`（由调用方在派发时经所有者作用域的 `rootOf(principal, workspaceId)` 解析得到，spawn 不自行拼接或信任任何其它来源的路径）；`workspace_id` 为 null 时为所有者根 `<SANDBOX_ROOT>/<ownerId>`（S1c A 及之前的唯一取值）。绑定会话的空间根解析失败（`rootOf` 返回 null）时 SHALL 不调用 `spawnOmp`，也不得以任何替代路径（含所有者根）spawn——首次 spawn 写入会话文件头的 cwd 此后不可改，回退会把绑定会话永久钉在错误目录；失败如何呈现给调用方归 session-metadata 与 chat-sessions「Supervisor dispatch」，本契约只规定取值。子进程的工作目录（spawn 的 `cwd` 选项）SHALL 等于同一 `<CWD>`，使 `--cwd` 参数与进程实际工作目录一致。`--approval-mode write` SHALL 是唯一的审批模式值：不得在运行期切换，不得由配置改写；它使 omp 仅对 exec 档工具（bash/eval/browser/task）经 `extension_ui_request` 请求审批，文件读写不触发审批。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, PI_CODING_AGENT_DIR, PI_CONFIG_FILES, PI_CONFIG_DIR, OMP_PROFILE, PI_PROFILE, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME=<OMP_STATE_DIR>/xdg/{data,state,cache}`；`PI_CODING_AGENT_DIR` SHALL 显式设为 omp 的默认 agent 目录本身——即 `<HOME 的取值>/.omp/agent`，与 `ompAgentDir(stateDir)` 同一字符串（omp 以字符串相等判断 agent 目录是否为默认值，只在相等时才把运行期状态重定向到 `$XDG_*_HOME/omp`，见「OMP_STATE_DIR 托管布局」）；`PI_CONFIG_FILES` SHALL 设为「宿主 overlay」的文件路径；`PI_CONFIG_DIR` SHALL 为 `.omp`，`OMP_PROFILE` 与 `PI_PROFILE` SHALL 为 `default`（omp 把它规范化为「无 profile」；空串不行——dotenv 会覆盖空值）。五者的取值与不设时 omp 的行为相同，显式设置的目的是「工作目录 dotenv 钉住」：omp 启动时加载 `<cwd>/.env` 等文件，但不覆盖已有的非空环境变量；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL 先按「OMP_STATE_DIR 托管布局」建立并校正整套布局，再同样方式准备 session-dir `<OMP_STATE_DIR>/sessions/<ownerId>`（`2770`）；cwd 仅在它是所有者根（未绑定会话，既有行为）时一并经 `ensureSharedDir` `mkdir -p`。绑定会话的空间根 SHALL 已存在：宿主在 spawn 前经所有者作用域的 `rootOf` 取得它并检查它是已存在的目录，SHALL NOT 创建它（`mkdir -p` 会把被外部删除的空间目录悄悄重建）；它缺失或不是目录时视同目录准备失败，SHALL 不 spawn 任何子进程，也不以其它路径替代（失败呈现为 session-metadata 规定的 502 `agent_unavailable`）。fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约，不得有第二套 argv/env 组装；它们的 `<CWD>` 按同一规则取自其所服务的会话行（fork 临时进程取源会话）。
omp 在 `--resume <file>` 时以该会话文件头记录的 cwd 为准（该目录可进入时切换过去，`--cwd` 只决定冷启动会话写入文件头的 cwd；见 vendored omp v18.0.10 `coding-agent/src/main.ts:728-775,1697-1712`、`session-manager.ts:2846-2871`），且 RPC 无改 cwd 的命令。宿主 SHALL 依赖这一 omp 行为而不是对抗它：会话的 cwd 在首个 prompt 冷启动时确定，此后不可改（空间绑定不可改的事实依据）；宿主对同一会话的每次 spawn 仍 SHALL 传入按上文规则取得的同一 `<CWD>`，不得借后续 spawn 的不同 `--cwd` 试图迁移已存在的会话。

#### Scenario: 环境白名单
- **WHEN** 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- **THEN** 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- **WHEN** 对 owner `u1` 的未绑定空间会话（`workspace_id` 为 null）首次 spawn 与 resume spawn
- **THEN** 首次 argv 精确等于契约（`--cwd <SANDBOX_ROOT>/u1`，含 `--approval-mode write` 与紧随 `--no-title` 的 `--config <overlay 路径>`，无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；任何 spawn 的 argv 都不含 `--approval-mode yolo`；session-dir、「OMP_STATE_DIR 托管布局」的全部目录与作为 cwd 的所有者根在 spawn 时已存在（事先不存在的由宿主建出）

#### Scenario: Directory preparation failure
- **WHEN** a required directory path is obstructed by a file
- **THEN** preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- **WHEN** parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- **THEN** the actual child SHALL observe only the allowlisted keys and supplied token, session-dir and every directory of the managed layout SHALL already exist together with its cwd (the owner root created on demand for an unbound session, or the pre-existing workspace root of a bound session, which the host verifies but never creates), and parent env SHALL remain unchanged

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

### Requirement: OMP_STATE_DIR 托管布局
宿主 SHALL 把 `OMP_STATE_DIR`（下称 `<state>`）分成「托管配置」（app 持有、omp uid 只读）与「omp 运行期状态」（omp uid 可写）两部分，目录与权限位（`mode & 0o7777`）精确如下，全部由 app uid 持有：

| 路径 | mode | 用途 |
| --- | --- | --- |
| `<state>` | `2750` | 根；omp uid 只能进入，不能在其下创建/改名/删除条目 |
| `<state>/home` | `3770` | omp 的 `HOME`；omp uid 可创建自己的条目（工具链缓存等），粘滞位使它不能改名或删除 app 持有的 `.omp` |
| `<state>/home/.env` | `0640`（普通文件） | omp 启动时加载 `$HOME/.env`；由宿主预建（空文件）并持有，粘滞位使 omp uid 不能替换它，见「工作目录 dotenv 钉住」 |
| `<state>/home/.omp`、`<state>/home/.omp/agent` | `2750` | 托管配置：`models.yml`（`0640`）与运维安装的 `skills/` 位于 agent 目录 |
| `<state>/xdg`、`<state>/xdg/data`、`<state>/xdg/state`、`<state>/xdg/cache` | `2750` | XDG 根 |
| `<state>/xdg/data/omp`、`<state>/xdg/state/omp`、`<state>/xdg/cache/omp` | `2770` | omp 运行期状态（`agent.db`、日志、原生模块缓存等）；omp 只在该目录已存在时才启用对应的 XDG 重定向，因此三者 SHALL 由宿主预先建出 |
| `<state>/sessions` | `2750` | 会话目录的父目录 |
| `<state>/sessions/<ownerId>` | `2770` | `--session-dir`，spawn 时按需建立 |
| `<state>/trash` | `0700` | app 私有：会话删除先把产物目录移到这里再递归删除（session-metadata「会话删除」），临时空间目录的删除同样经它中转（temporary-workspaces「临时空间目录的删除」）；omp uid 不能进入 |
| `<state>/snapshots` | `0700` | app 私有：每个回合开始前的工作空间快照（workspace-snapshots「快照的存放位置」）；omp uid 不能进入、列举或改写 |

这些路径 SHALL 只有一个来源：`server/src/sessions/omp/` 下的一个模块导出 `ompTrashDir(stateDir)`、`ompSnapshotsDir(stateDir)`（= `<state>/snapshots`）、`ompHome(stateDir)`、`ompAgentDir(stateDir)`（= `<state>/home/.omp/agent`）、`ompXdgHome(stateDir, "data"|"state"|"cache")`、`ompSessionDir(stateDir, ownerId)` 与 `ensureOmpStateLayout(stateDir)`；`server.ts`、`createApp`、spawn 与会话删除 SHALL 经它们取路径，不得再拼 `join(stateDir, "agent")` 一类的字面量。旧布局的 `<state>/agent` SHALL 不再被读写（遗留目录原样留在磁盘，宿主不迁移也不删除）。

`ensureOmpStateLayout(stateDir)` SHALL 先在 `<state>` 缺失时以递归 `mkdir` 建出它及缺失的父级（不改父级权限位），再取 `<state>` 的内核 realpath（`OMP_STATE_DIR` 自身可以是运维放置的、指向目录的符号链接——既有部署形态，会话删除按同一 realpath 校验），然后对表中除 `sessions/<ownerId>` 之外的每个目录、以解析后的根为基、按父先于子的顺序调用 sandbox-core「托管目录权限位」的 `ensureOwnedDir(path, mode)`；根以下的各级不得是符号链接。`<state>/home` 缺失时 SHALL 先以不对组开放的权限位建出，待 `home/.omp` 与 `home/.omp/agent` 建好之后才校正为 `3770`——否则冷建期间一个残留的 omp uid 进程可以抢先建出 `home/.omp`，使布局因归属不符而失败；`ensureOwnedDir` 新建目录时 SHALL 直接以目标 mode 的权限位创建（不经过一个更宽的中间状态）。argv 与环境里的路径仍用配置值（未解析）拼出，与此前一致。它 SHALL 在两处被调用：服务启动时写托管 `models.yml` 之前，以及每次 `spawnOmp` 准备目录时（随后对 `sessions/<ownerId>` 以 `2770` 调同一 `ensureOwnedDir`）；因此被外部改宽的权限位在下一次 spawn 前被校正，而不属于 app uid 的目录、符号链接或非目录条目使启动失败（既有 generic `server_start_failed` 路径）或使该次 spawn 以「Directory preparation failure」失败，绝不被跟随或沿用。宿主 SHALL NOT chown、不改进程 umask；组归属由部署经 setgid 继承（ADR-0010）。同 uid 部署（`OMP_USER` 缺席）使用同一布局与同一权限位。

部署前提（ADR-0010，宿主不检查）：`<state>` 的父目录不得对 omp uid 可写（否则 `<state>` 可被整体改名替换）；`skills/` 及其内容由运维以 app uid（或 root）安装且不对 omp uid 可写。

#### Scenario: 冷布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout` 后再对 owner `u1` spawn
- **THEN** 表中每个目录存在、由本进程 uid 持有且 `mode & 0o7777` 精确等于表值；再次调用不改变任何 mode、不抛错

#### Scenario: 被改宽的目录被校正
- **WHEN** `<state>`、`<state>/home/.omp/agent` 与 `<state>/sessions` 被预先 `chmod 2770`、`<state>/home` 被 `chmod 2770`（无粘滞位）后调 `ensureOmpStateLayout`
- **THEN** 四者回到表值

#### Scenario: 被占位的路径不被跟随
- **WHEN** 根以下的 `<state>/home/.omp` 是指向别处目录的符号链接，或 `<state>/xdg` 是普通文件，或 `<state>/sessions/u1` 是符号链接
- **THEN** `ensureOmpStateLayout`（前两者）/ spawn 的目录准备（第三者）抛错，链接目标的 mode 与内容不变，不 spawn 任何子进程

#### Scenario: 状态根是符号链接
- **WHEN** `OMP_STATE_DIR` 是指向一个既有目录 `D` 的符号链接，服务启动并 spawn
- **THEN** 布局建立在 `D` 之下且 `D` 的 mode 为 `2750`，启动与 spawn 成功，`HOME` 与 `--session-dir` 仍以配置路径（经链接）给出

#### Scenario: 遗留 agent 目录被忽略
- **WHEN** `<state>/agent/models.yml` 与 `<state>/agent/skills/x/SKILL.md` 存在（旧布局），服务启动并 spawn
- **THEN** 托管 `models.yml` 写在 `<state>/home/.omp/agent/`，命令目录不含 `skill:x`，`<state>/agent` 下的文件字节与 mode 不变

#### Scenario: 冷建时 home 在 .omp 就位前不对组开放
- **WHEN** 对不存在的 `<state>` 调 `ensureOmpStateLayout`，并在 `home/.omp` 被创建的那一刻观测 `<state>/home` 的 mode
- **THEN** 此刻 `home` 的组与 other 权限位全为 0；调用返回后 `home` 为 `3770`、`trash` 为 `0700`

#### Scenario: 快照目录属于布局
- **WHEN** 对一个不存在的 `<state>` 调 `ensureOmpStateLayout`；另一次 `<state>/snapshots` 被预先 `chmod 0770`；再一次它是指向别处目录的符号链接
- **THEN** 第一种 `<state>/snapshots` 存在、由本进程 uid 持有且 `mode & 0o7777` 为 `0o700`；第二种被校正回 `0o700`；第三种 `ensureOmpStateLayout` 抛错且链接目标的 mode 与内容不变

### Requirement: 宿主 overlay
omp 把会话 cwd 下的项目层设置（`.omp/config.yml`、`.claude/settings.json` 等）与全局层深合并，而 cwd 是 agent 无需审批即可写的目录；`--approval-mode write` 只钉住档位一个键。宿主 SHALL 用 omp 的 `--config` overlay 层（优先级：全局 < 项目 < overlay < CLI runtime override）钉住会绕过审批或在审批之外执行命令的设置键。overlay 文件 SHALL 位于托管 agent 目录、名为 `host-overlay.yml`，路径只有一个来源（与「OMP_STATE_DIR 托管布局」的路径函数同模块导出 `ompHostOverlayPath(stateDir)`）；它 SHALL 在服务启动时、托管布局建立之后与托管 `models.yml` 一起写入，使用与 `models.yml` 相同的替换方式（独占创建的临时文件、mode 精确 `0640`、rename；宿主内只有一份该实现），内容 SHALL 逐字节等于：

```yaml
tools:
  approval: []
  approvalMode: write
bash:
  patterns: []
  direnv: "off"
shellPath: null
python:
  interpreter: ""
ruby:
  interpreter: ""
julia:
  interpreter: ""
mcp:
  enableProjectConfig: false
todo:
  reminders: false
images:
  urls:
    enabled: false
    command: null
```

各键的作用（真实 omp v18.0.10 实测）：`tools.approval: []` 以数组整体替换项目层的逐工具放行记录（对象会被深合并，替换不掉未列出的工具）；`bash.patterns: []` 清掉项目层的 bash 放行规则；`shellPath: null` 与三个 `interpreter: ""` 使项目层不能指定被宿主执行的可执行文件；`bash.direnv: "off"` 关闭 bash 调用前的 `direnv export`；`mcp.enableProjectConfig: false` 使项目层 MCP 配置文件里的 stdio server 不在 spawn 时被拉起；`todo.reminders: false` 关闭未完成 todo 的隐藏提醒与同回合自动续跑（会让助手正文出现两段回复）；`images.urls.enabled: false` 关掉图片发布 broker——项目层把它打开后，会话创建时的 prewarm 会按项目给的参数拉起 `ssh`/`cloudflared` 等外部进程（`blob-broker/service.ts:623`、`exposure.ts:488-503`），`images.urls.command` 则被直接执行（`uploaders.ts:100`）；这一组的效果是读源码得出的，omp 接受该取值已实测。`tools.approvalMode: write` 与 argv 冗余，保留使文件自洽。overlay 不做 schema 校验，上述取值依赖 v18.0.10 的消费代码：升级 omp 时 SHALL 重新验证。

overlay 缺失、不可读或不是 YAML mapping 时 omp 以非零退出且不发任何帧——宿主按既有的握手失败处理（`agent_unavailable`），SHALL NOT 回退为不带 `--config` 的 spawn。写入失败 SHALL 走与 `models.yml` 写入失败相同的 partial-start failure 路径。

本要求 SHALL NOT 做的（owner 决定，登记于 ADR-0012）：不拦项目层的 skills、`AGENTS.md`/`RULES.md`、agent 定义（它们是功能）；不拦项目层 `.omp/tools`、`.claude/tools`、`.codex/tools` 与项目插件在 spawn 时的执行（受信局域网 + uid 隔离下的已接受残余）；不在 spawn 前扫描或拒绝工作目录。

#### Scenario: overlay 写入
- **WHEN** 编译入口冷启动
- **THEN** `<OMP_STATE_DIR>/home/.omp/agent/host-overlay.yml` 是 mode `0640` 的普通文件，内容逐字节等于上文；重启后字节不变；agent 目录无残留临时文件

#### Scenario: 项目层放行不再绕过审批（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/config.yml`，含 `tools.approval: {bash: allow}` 与 `bash.patterns: [{match: "*", approval: allow}]`，随后一个回合里模型调用 bash
- **THEN** 宿主收到该 bash 调用的审批请求（`chat_approvals` 有行），与无项目配置时一致
- **WHEN** 去掉 argv 里的 `--config`（负向对照）
- **THEN** bash 不经审批直接执行

#### Scenario: 项目层 MCP 不在 spawn 时执行（真实 omp）
- **WHEN** 会话 cwd 下预置 `.omp/mcp.json`，声明一个会写标记文件的 stdio server，然后 spawn 并完成一个回合
- **THEN** 标记文件不存在
- **WHEN** 去掉 `--config`（负向对照）
- **THEN** 标记文件出现

#### Scenario: 默认行为不变
- **WHEN** cwd 下没有任何项目配置
- **THEN** bash 仍请求审批、文件读写不请求，`make smoke` 的全部既有断言通过

### Requirement: 工作目录 dotenv 钉住
官方 omp 二进制在启动时依次读取 `<cwd>/.env`、`<agent 目录>/.env`、`$HOME/.omp/.env`、`$HOME/.env`，把其中宿主环境里**没有或为空**的变量写入自己的环境（`OMP_X` 在同一文件内镜像为 `PI_X`；`resource/oh-my-pi/packages/utils/src/env.ts:228-247`，官方 v18.0.10 二进制实测）。cwd 是 agent 无需审批即可写的目录，`<state>/home` 对 omp uid 可写，因此未加处理时一份 `.env` 就能把 agent 目录改到 agent 可写的位置（`PI_CODING_AGENT_DIR`，实测 `agent.db` 落到该目录）或让该目录的 spawn 持续失败（`PI_CONFIG_FILES` 指向不存在的文件）。宿主 SHALL：

1. 在 spawn 环境里显式设置决定 omp 从哪里读托管配置的五个变量——`PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`（「子进程 spawn 契约」）——使任何 `.env` 都不能改写它们。后三个是必须的：`PI_CONFIG_DIR` 改变配置根后，显式的 agent 目录不再等于默认值，XDG 重定向关闭（实测：`agent.db` 写回 agent 目录，sudo 模式下即 spawn 失败），与 profile 变量合用时配置根可被移到 cwd 之下（实测：`<cwd>/evil` 下出现 omp 的运行目录）；named profile 生效时 omp 丢弃 agent 目录覆盖并改写 `PI_CODING_AGENT_DIR`（`utils/src/dirs.ts:320,541-544`）。`PI_CONFIG_FILES` 以 `:` 分隔多个文件，故 `ensureOmpStateLayout` SHALL 在 `OMP_STATE_DIR` 含 `:` 时抛错（启动失败，而不是每次 spawn 都因 overlay 找不到而 502）；
2. 在托管布局里预建并持有 `<state>/home/.env`（「OMP_STATE_DIR 托管布局」；sandbox-core「托管文件权限位」的 `ensureOwnedFile`）：缺失时建为空文件，已存在时要求它是 app uid 持有的普通文件并把 mode 校正为 `0640`，其内容不由宿主管理（运维可在其中为 omp 放环境变量）；`<state>/home` 冷建时它 SHALL 在 `home` 对组开放之前建出。它是符号链接、非普通文件或不属于 app uid 时布局失败（与目录同一失败路径）。`<agent 目录>/.env` 与 `$HOME/.omp/.env` 位于 omp uid 不可写的托管目录内，无需预建。

本要求不覆盖的（登记于 ADR-0012）：`<cwd>/.env` 里其它未被宿主设置的 `PI_*`/`OMP_*` 变量仍会生效；宿主不读取、不改写、不拒绝工作目录里的 `.env`（它可能是用户项目的一部分）。

#### Scenario: 托管配置位置不可被 dotenv 改写（真实 omp）
- **WHEN** cwd 下的 `.env` 含 `PI_CODING_AGENT_DIR=<cwd>/evil2`、`PI_CONFIG_FILES=/nonexistent.yml`、`OMP_CONFIG_FILES=/nonexistent2.yml`、`PI_CONFIG_DIR=../<cwd 相对 HOME 的路径>/evil`、`OMP_PROFILE=p`、`PI_PROFILE=q`，随后 spawn 并完成一个回合
- **THEN** 回合 done；cwd 下除 `.env` 外没有 omp 新建的条目，`<state>/home` 下没有新的配置根，`agent.db` 仍在 `<state>/xdg/data/omp`
- **WHEN** 去掉 spawn 环境里的 `PI_CONFIG_FILES`（负向对照）
- **THEN** spawn 失败（omp 以 `Config overlay not found` 退出，宿主呈现 502）
- **WHEN** 只去掉 `PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`（负向对照）
- **THEN** `<cwd>/evil` 下出现 omp 写出的条目，或 `agent.db` 不在 `<state>/xdg/data/omp`

#### Scenario: 状态目录路径含冒号
- **WHEN** `OMP_STATE_DIR` 的路径含 `:`
- **THEN** `ensureOmpStateLayout` 抛错，不创建任何目录

#### Scenario: home/.env 由宿主持有
- **WHEN** 对不存在的 `<state>` 调 `ensureOmpStateLayout`
- **THEN** `<state>/home/.env` 是本进程 uid 持有的空普通文件、mode `0640`，且它在 `home` 的组权限位仍为 0 时已经存在
- **WHEN** 它已存在且内容非空、mode 为 `0666`
- **THEN** 调用后内容字节不变、mode 为 `0640`
- **WHEN** 它是符号链接或目录
- **THEN** 布局抛错，链接目标不变，不 spawn
