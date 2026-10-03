# Tasks: session-fault-stderr-record（#664）

Fixture level: compact

归档次序（前提）：本 change 先归档进主规格；父 change `s1c-session-metadata-presentation` 的 http-service-skeleton delta 仍是旧文，归档前按 #754 从主规格现文重新生成全部 delta。本 PR 不改父 delta。

## 1. 实现
- [ ] 1.1 `server.ts` `appAssemblyOf`：`onError`（spec delta 原句）；复用现有 `emitStderrRecord`，不新增第二个 stderr 出口；JSDoc 同步。
- [ ] 1.2 `app.ts`：删除 `observeSessionFault` 及其对 `app.log` 的调用；未注入时的默认为不观测。`assembly.onError` 显式注入的路径不变。
- [ ] 1.3 测试（放进现有覆盖 `appAssemblyOf` / 握手超时 `log` 的测试文件，沿用其 stderr 捕获手法；找不到合适落点时新建 `server/test/session-fault-record.test.ts`）：
  - (a) `appAssemblyOf(config).onError(new Error("<含路径与密钥样式的哨兵文本>"))` → 捕获的 stderr 恰一行 `{"event":"session_fault"}\n`，不含哨兵；返回值严格为 `undefined`；
  - (b) stderr 写入被拒绝 / 同步抛出时：调用不抛、无 unhandledRejection（在测试内挂监听并让出事件循环后断言）、`onError` 调用次数不变；
  - (c) 经 `createApp({ …, assembly: appAssemblyOf(config) 的等价物 })` 装配，触发一次真实的 supervisor 保留故障（沿用现有 infra-fault 测试的触发方式，例如持久化事务失败）→ stderr 恰一行 `session_fault`；关停时故障照常暴露（既有断言手法）；
  - (d) 不传 `onError` 的 `createApp`：同样的故障不写任何 stderr/stdout，故障仍在关停时暴露。
- [ ] 1.4 除 `server/src/server.ts`、`server/src/app.ts`、上述测试文件与本 change 目录外不改其它被跟踪文件。若现有测试依赖 `observeSessionFault` 或 `app.log`，停下报告。

## Must preserve
- `server_started` / `server_start_failed` / `listener_force_close` / `omp_handshake_timeout` 的输出逐字节不变；`import` 入口无副作用、构造 app 零输出。
- supervisor 的 sink 同步契约测试（`onError` 返回 thenable 的违约保留）全绿；显式传入 `assembly.onError` 的既有测试行为不变。
- `make smoke` 全绿（生产入口装配变更）。

## Required evidence
- E1 RED→GREEN：1.3(a)(c) 在未改源码时失败，改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）。
- E3 `make smoke`（CI wrapper，全新状态）全绿；其 server log 中没有 `session_fault` 行（正常路径不误报）。
- E4 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate session-fault-stderr-record --strict --no-interactive` exit 0。

## Negative controls
- N1 sink 改为返回 `emitStderrRecord(...)` 的 Promise → (a) 的返回值断言失败（并记录 supervisor sink 契约测试是否也红）。
- N2 记录里带上 `error.message` → (a) 的哨兵断言失败。
- N3 去掉 `emitStderrRecord` 的 catch（或在 sink 内直接 await 写入）→ (b) 失败。
- N4 `createApp` 默认 sink 恢复为写 stderr → (d) 失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Logging / secrets in output | yes | 记录不含原始错误文本 → 1.3(a)、N2 |
| Error handling / fault retention | yes | sink 同步契约、写失败不递归 → 1.3(b)、N1、N3 |
| Public API / CLI / script entry | yes | 生产入口 stderr 输出面新增一种记录 → Must preserve、E3 |
| 其它 | no | 无 schema、UI、依赖改动 |
