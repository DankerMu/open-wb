# Spec: omp-runtime

## ADDED Requirements

### Requirement: 二进制供给
`make omp-fetch` SHALL 只从 `can1357/oh-my-pi` GitHub release **v18.0.10** 拉取与当前 `uname -sm` 匹配的资产（`omp-darwin-arm64` 或 `omp-linux-x64`），对照仓内固定的 SHA256 表校验后落到 `var/omp/omp` 并置可执行位；校验失败 SHALL 不留下 `var/omp/omp`；目标已存在且校验通过 SHALL 跳过下载。不支持的平台 SHALL 显式失败并打印支持矩阵。app-server SHALL 不依赖 PATH 上的任何 `omp`。

#### Scenario: 首次拉取与幂等
- WHEN 在空 `var/omp/` 下执行 `make omp-fetch`
- THEN 产出 `var/omp/omp`，`var/omp/omp --version` 输出 `omp/18.0.10`；再次执行不产生网络下载且退出 0

#### Scenario: 摘要不符
- WHEN 下载内容的 SHA256 与固定表不一致
- THEN 退出非 0，stderr 含 expected/actual 摘要，且 `var/omp/omp` 不存在

### Requirement: 子进程 spawn 契约
`OmpProcess.spawn` SHALL 以 `<OMP_BIN> --mode rpc --cwd <SANDBOX_ROOT>/<ownerId> --session-dir <OMP_STATE_DIR>/sessions/<ownerId> --model workbuddy/<MODEL_ID> --approval-mode yolo --no-extensions --no-lsp --no-pty --no-title` 启动，**仅当** `chat_sessions.omp_session_file` 非 null 时追加 `--resume <omp_session_file>`，否则冷启动（不得传空/`null` 参数）。子进程环境 SHALL 精确等于 `{PATH, LANG, TMPDIR, HOME, PI_CODING_AGENT_DIR, WORKBUDDY_MODEL_TOKEN}`（`LANG`/`TMPDIR` 缺席时不设），其中 `HOME=<OMP_STATE_DIR>/home`、`PI_CODING_AGENT_DIR=<OMP_STATE_DIR>/agent`；SHALL 不继承 `process.env` 中任何其它键。spawn 前 SHALL `mkdir -p` cwd、session-dir、home、agent 四个目录。

#### Scenario: 环境白名单
- WHEN 在 `process.env` 含 `MODEL_UPSTREAM_API_KEY`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 的进程内 spawn
- THEN 子进程收到的 env 键集合精确等于白名单，三者均不存在；`WORKBUDDY_MODEL_TOKEN` 为该会话 64 位 lowercase hex

#### Scenario: 参数与目录
- WHEN 对 owner `u1` 首次 spawn 与 resume spawn
- THEN 首次 argv 精确等于契约（无 `--resume`）；resume 时 argv 末尾恰为 `--resume <persisted file>`；`omp_session_file` 为 null 的会话再次 spawn 时 argv 不含 `--resume`；四个目录在 spawn 时已存在

### Requirement: RPC 握手与帧层
`OmpProcess` SHALL 在收到 `{type:"ready"}` 后立即发送 `negotiate_protocol` v2 并等待成功响应，再发送 `get_state`；仅当响应 `sessionFile` 为非空字符串才算握手成功并把该值写回 `chat_sessions.omp_session_file`；`sessionFile` 缺失/空、任一步失败响应、或握手在 `handshakeTimeoutMs`（默认 10000）内未完成，SHALL 终止子进程并以 `agent_unavailable` 类失败结束 spawn。它 SHALL 按 rpc.md 重组 `rpc_chunk`（校验 `chunkId/index/count/byteLength`，拒绝交错或中断序列，超过 `maxReassembledFrameBytes` 失败），SHALL 以 `id` 匹配响应而不依赖发出顺序，SHALL 把 malformed 行视为可恢复（记录后继续读）。

#### Scenario: 分块帧重组
- WHEN 假子进程把一个 3 MiB 的 JSON 对象以 `rpc_chunk` 序列发出
- THEN 解码得到与原对象逐字节相等的 JSON；若中间插入其它帧或缺一块，SHALL 以协议错误结束该帧且不崩溃进程读取循环

#### Scenario: 握手超时
- WHEN 假子进程启动后不发 `ready`
- THEN 到达超时后子进程被终止，spawn 以 `agent_unavailable` 类错误失败

#### Scenario: get_state 缺 sessionFile
- WHEN 假子进程的 `get_state` 响应省略 `sessionFile`
- THEN 子进程被终止、spawn 失败、`chat_sessions.omp_session_file` 保持 null；该会话下一次 prompt 冷启动且 argv 不含 `--resume`

### Requirement: 每会话生命周期
`SessionRuntime` SHALL 在会话首条 prompt 时才 spawn；SHALL 在每次收到子进程事件或新 prompt 时重置 idle 计时器（`OMP_IDLE_MS`）；到期或服务关停时 SHALL 关闭 stdin，5s 内未退出发 `SIGTERM`，再 3s 未退出发 `SIGKILL`，退出后注销该会话的 bearer token。回合进行中子进程退出 SHALL 使该回合以 `failed` 收尾并丢弃 runtime；下一条 prompt SHALL 以 `--resume` 重新 spawn。

#### Scenario: 懒启动与空闲退出
- WHEN 创建会话但不发 prompt
- THEN 无子进程；发出首条 prompt 后 spawn；注入时钟推进超过 `OMP_IDLE_MS` 后子进程 stdin 关闭并退出，token 失效

#### Scenario: 回合中崩溃后 resume
- WHEN 回合中杀死子进程
- THEN 当前 assistant 消息状态 `failed`；再次 prompt 时以 `--resume <omp_session_file>` 重新 spawn，新回合正常完成
