## ADDED Requirements

### Requirement: 握手超时可观测
SessionRuntime SHALL 接受可选同步 `log` 端口（supervisor 经 `sessionRuntimeOpts` 传入；未传则丢弃）。当一次 acquisition 因握手 deadline 到期而失败（`AgentUnavailableError` 原因为 `handshake timeout`）时，runtime SHALL 在该错误向调用方传播之前恰调用一次 `log({event:"omp_handshake_timeout", sessionId, reason:"handshake timeout", elapsedMs})`：`sessionId` 为该 runtime 的会话 id，`elapsedMs` 为自进入该次 acquisition（含排队等待许可）至握手 deadline 失败被 runtime 捕获（在退役该 generation 之前）的整数毫秒，取与握手 deadline 相同的真实单调时间源（不取注入时钟）。其它启动失败（spawn 失败、negotiate/get_state 失败、子进程提前退出、关停取消）SHALL 不产生记录。`log` 抛出或返回 thenable SHALL 被吞掉，原错误照常传播，调用方仍得到 502 `agent_unavailable`。

#### Scenario: 握手超时写一条记录
- **WHEN** fake-omp `no-ready` 子进程使一次 prompt 的握手在 `handshakeTimeoutMs` 后超时
- **THEN** REST prompt 返回 502 `agent_unavailable`；`log` 恰收到一条记录，键集合恰为 `event`、`sessionId`、`reason`、`elapsedMs`，`sessionId` 为该会话 id，`elapsedMs ≥ handshakeTimeoutMs`

#### Scenario: 非超时的启动失败不记录
- **WHEN** `OMP_BIN` 指向不存在的路径使 spawn 报 `ENOENT`，或 `log` 端口自身抛出
- **THEN** 前者 `log` 未被调用；后者 REST 仍返回 502 `agent_unavailable` 且无未处理异常

## MODIFIED Requirements

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
