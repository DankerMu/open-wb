# omp-runtime Specification

## Purpose
TBD - created by archiving change s0b-omp-fetch. Update Purpose after archive.
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
`spawnOmp` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。

#### Scenario: 环境白名单
- WHEN 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- THEN 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- WHEN 对 owner `u1` 首次 spawn 与 resume spawn
- THEN 首次 argv 精确等于契约（无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；四个目录在 spawn 时已存在

#### Scenario: Directory preparation failure
- WHEN a required directory path is obstructed by a file
- THEN preparation SHALL fail and no child SHALL be spawned

#### Scenario: Effective child boundary
- WHEN parent env contains gateway/KB/DB/unrelated sentinels and a child is launched through the boundary
- THEN the actual child SHALL observe only the allowlisted keys and supplied token, the four directories SHALL already exist, and parent env SHALL remain unchanged

### Requirement: RPC 握手与帧层
OmpProcess SHALL reuse spawnOmp, wait for ready, negotiate protocol v2, then request get_state with distinct correlated ids. start SHALL resolve with nonempty data.sessionFile only after both matching successful responses, and SHALL otherwise reject with agent_unavailable and terminate the child within the configured startup failure path. One overall handshake deadline SHALL default to 10000ms. This transport SHALL return sessionFile; persistence belongs to the supervisor.

#### Scenario: Successful handshake
- WHEN the real fake omp advertises v2 and successfully answers negotiation and get_state
- THEN start resolves with its sessionFile and repeated start does not spawn another child

#### Scenario: Failed startup
- WHEN ready is absent, negotiation fails, get_state lacks nonempty sessionFile, or the child exits during startup
- THEN start rejects, never reports readiness, clears pending state and terminates a still-running child

#### Scenario: Correlated responses
- WHEN responses arrive out of order or with a wrong id or command
- THEN only a response matching both id and command settles its request; later same-id prompt failures remain observable frames

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
The transport SHALL cancel extension UI requests immediately with matching id, expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

#### Scenario: Extension UI cancellation
- WHEN the fake requests extension UI during a prompt
- THEN it receives {type:extension_ui_response,id:the-request-id,cancelled:true} without user interaction and proceeds

#### Scenario: Child crash or write failure
- WHEN a child crashes, is signalled, fails to spawn, or a command cannot be written
- THEN affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

