# Tasks: omp-spawn-gate（#652）

## 1. 实现

- [x] 1.1 `server/src/sessions/omp/spawn-gate.ts`：`SpawnGate`（design「Must add/change」1）。
- [x] 1.2 `SessionRuntime`：`#acquire` 取许可、启动结算即归还、`shutdown()` 取消排队、握手超时 `log`（design 2）。`runtime.ts` ≤798 行；放不下时按 design 搬出无关纯 helper。
- [x] 1.3 supervisor 构造 gate 与 `log`，经 `sessionRuntimeOpts` 交给会话 slot 与 fork 临时 runtime（design 3）。
- [x] 1.4 `OMP_SPAWN_CONCURRENCY`：`agent-config.ts` → `sessionRuntimeOf` → `SessionSupervisorRuntime.spawnConcurrency`（design 4）。
- [x] 1.5 `log` 端口透传：`SessionSupervisorOptions` / `RegisterSessionsOptions` / `createApp` assembly；`server.ts` 新增导出纯函数 `appAssemblyOf(config)`，main 路径改为 `assembly: appAssemblyOf(config)`，其 `log` 接到受管 stderr writer（design 5）。
- [x] 1.6 `docs/architecture/system.md:36` sessions 行补「并发 spawn 上限 `OMP_SPAWN_CONCURRENCY`（缺省 CPU 数）」。

## 2. 测试

- [x] 2.1 新测试 G1–G7、L1、L2、C1（design「Tests」），用真实 fake-omp 子进程与既有 helpers；新 helper 放新文件，不改既有 helper 的行为。
- [x] 2.2 红：G2、G3、G4、L1、L2、C1 在 master 上为红；三条变异（design「Required evidence」：G5、G4、G7）各自变红，结果写入报告。
- [x] 2.3 全部既有测试全绿（重点：`session-stop*`、`session-regenerate*`、`session-fork*`、`session-supervisor-pool*`、`omp-runtime*`、`omp-max-processes-config`、`server-entry*`）；如有期望改动，只允许加强断言并逐条列出。既有测试若因缺省 limit 随 CPU 数而串行化超时，停下上报。

## 3. 验证

- [x] 3.1 `make check`（Node 24.13.1）、`bash scripts/size-guard.sh` 退出 0；`wc -l` 记录 `runtime.ts`、`supervisor.ts`、`process.ts`、`spawn-gate.ts`。
- [x] 3.2 `openspec validate omp-spawn-gate --strict --no-interactive` 通过。
- [x] 3.3（编排者）测试 VPS 复测：官方 omp v18.0.10 linux-x64（SHA256 校验）+ 编译产物，缺省配置冷态 16 会话并发 prompt 多轮无握手超时 502；同机 master 对照。结果进 PR，不写机器地址或用户名。
- [x] 3.4（编排者）归档 PR：定点同步父 change `s1c-turn-control-governance` 与 `s1c-session-metadata-presentation` 的 http-service-skeleton delta 中「服务启动与装配」「Shared agent module assembly」两条需求。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | FIFO 许可、每条退出路径归还、关停取消 → G1–G7 |
| Resource limits / large input / discovery | yes | 同时冷启动数上限、队列深度上界 → G2、G3、design 上界 |
| Error handling / rollback / partial outputs | yes | 启动失败归还、排队取消、日志端口失败不影响 502 → G4、G5、L1 |
| Config / project setup | yes | 新键、缺省随 CPU 数 → C1 |
| Public API / CLI / script entry | yes | `createApp` assembly 与 `registerSessions` 增 `log`；生产 stderr 记录 → L2、spec |
| Legacy compatibility / examples | yes | 未注入 gate 的 runtime 与既有 stop-intent 行为不变 → 2.3 |
| Documentation / migration notes | yes | 部署文档与 spec 中的配置键清单 → spec delta、tasks 1.6 |
| Auth / permissions / secrets | no | 日志记录不含凭据（spec 限定键集合） |
| File IO / path safety / overwrite | no | 不涉文件 |
| Schema / columns / units / field names | no | 无持久化变更 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |

## 通用纪律

- [x] 源码边界：`omp/spawn-gate.ts`（新）、`omp/runtime.ts`、`pool.ts`、`supervisor.ts`、`branching.ts`（仅在必要时接线）、`sessions/index.ts`、`app.ts`、`server.ts`、`agent-config.ts`、`docs/architecture/system.md`；`omp/process.ts`、store、approvals、web、fake-omp 零 diff。确需改动时先停下上报。
- [x] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
