# Proposal: omp-spawn-gate（#652）

```text
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (override: 并发许可、生产配置键、公共装配面与生产 stderr 记录同时变化)
Blast radius: 许可泄漏或排队不可取消 → 之后所有冷启动永久挂起、关停挂起；上限失效 → #652 的整批 502 复现；日志接线错 → 生产 stderr 多出未约定的记录或仍无记录
Selected risk packs: Concurrency/ordering; Resource limits; Error handling/partial outputs; Config/project setup; Public API/CLI/script entry; Legacy compatibility; Documentation
Evidence floor: G1–G7、L1、L2、C1 全绿且列明的项在 master 上为红、三条变异各自变红；全部既有测试全绿；make check；size-guard；openspec validate --strict；测试 VPS 复测与 master 对照
```

## Why
#494 在测试 VPS（4 vCPU / 7.4Gi）上实测：冷态下 16 个会话同时发 prompt，两轮分别有 14/16 与 9/16 在约 10.2s 收到 `502 agent_unavailable`，服务端没有任何日志。成因有两层：
- 池（#463）只限制**存活进程数**，不限制**同时 spawn 的数量**。`pool.admit` 登记完就返回，spawn 与握手发生在其后的 `SessionRuntime.#acquire` → `OmpProcess.start()`（`runtime.ts:354`），名额够时 N 个会话就是 N 个 omp 同时冷启动。
- omp 冷启动互相争抢 CPU：最慢一个到 `ready` 的时间 K=1 1.09s、K=4 2.0s、K=8 4.7s、K=16 9.4s，再加 `get_state`，K=16 时超过固定的 10s 握手 deadline（`process.ts:130`）。

502 的原因字符串 `handshake timeout` 在 supervisor `#translate`（`supervisor.ts:740-750`）被丢掉；而默认的会话故障观察者 `observeSessionFault` 写的是 `app.log`，`createApp` 以 `logger:false` 构建（`app.ts:116`），在生产上是空操作。所以这类 502 无从检索。

2026-09-29 owner 拍板：**A + C**。A = 准入之后、spawn 之前加有界的并发 spawn 信号量，排队时间不计入握手 deadline；C = 握手超时写服务端日志（会话 id、`handshake timeout`、耗时）。

## What Changes
- 新模块 `server/src/sessions/omp/spawn-gate.ts`：FIFO 计数信号量，`limit` 个许可；排队者可取消。
- `SessionRuntime.#acquire`：创建 generation 与 `OmpProcess` 之前先取得许可；启动（spawn + 握手）一旦结算（成功或失败）立即归还；runtime `shutdown()` 同步取消自己的排队，排队中的 acquire 以 `AgentUnavailableError("runtime shutdown")` 拒绝，从未 spawn。
- supervisor 构造时按 `runtime.spawnConcurrency ?? availableParallelism()` 建一个 gate，经 `sessionRuntimeOpts` 同时交给会话 runtime 与 fork 临时 runtime（`branching.ts:257`）。
- 新配置键 `OMP_SPAWN_CONCURRENCY`（`agent-config.ts`，与 `OMP_MAX_PROCESSES` 同一解析纪律；缺省 `os.availableParallelism()`），经 `sessionRuntimeOf` 进入 runtime settings。
- 握手超时日志：supervisor 新增可选同步 `log` 端口（缺省丢弃），经 runtime 选项到达 `SessionRuntime`；`#acquire` 的失败分支在原因仍为 `handshake timeout` 时发一条记录 `{event:"omp_handshake_timeout", sessionId, reason:"handshake timeout", elapsedMs}`。`createApp` 的 assembly 与 `registerSessions` 透传该端口；生产入口 `server.ts` 把它接到受管 stderr writer。
- 不加握手超时配置键（选项 B 未被选中）；不设排队超时（理由见 design）。

## Capabilities
- ADDED omp-pool「并发 spawn 上限」。
- MODIFIED omp-runtime「RPC 握手与帧层」（deadline 自取得许可、开始 spawn 起算）；ADDED omp-runtime「握手超时可观测」。
- MODIFIED http-service-skeleton「服务启动与装配」（第十五个配置键、握手超时 stderr 记录）、「Shared agent module assembly」（spawn 上限随同一 settings 对象到达；`log` 端口）。

## Impact
- 源码：`omp/spawn-gate.ts`（新）、`omp/runtime.ts`、`sessions/pool.ts`（`sessionRuntimeOpts`）、`supervisor.ts`、`sessions/index.ts`、`app.ts`（assembly 透传）、`server.ts`（`sessionRuntimeOf` 与 stderr 接线）、`agent-config.ts`。
- 部署：4 vCPU 机器缺省同时冷启动 4 个；排队中的请求等待更久，但不再整批 502。
- 已知残留：`observeSessionFault` 在生产上不写日志是独立缺陷，已另立 #664，不在本刀修。
