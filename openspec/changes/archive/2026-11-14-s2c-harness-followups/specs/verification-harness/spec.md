# verification-harness Spec Delta

> s2c-harness-followups（#2002、#2009）：官方 omp 门控用例在多核开发机上的 worker 上限；入库世界的泄密哨兵把 `console` 通道也算进去。

## ADDED Requirements

### Requirement: 官方 omp 门控用例的 worker 上限
`server/vitest.config.ts` SHALL 在 `../vitest.shared.mjs` 之上（用从 `vitest/config` 导入的 `mergeConfig`，不新增依赖）只在 `process.env.WORKBUDDY_OMP_TEST === "1"` 时叠加 `test.maxWorkers`，
取值为 `Math.max(1, Math.min(3, os.availableParallelism() - 1))`：上限 3，且永不高于 vitest 4.1.11 run 模式的缺省
（`availableParallelism() - 1`，`node_modules/vitest/dist/chunks/cli-api.*.js` 的 `resolveMaxWorkers`）。3 取自 CI uid-isolation
（4 vCPU runner 的缺省 3 个 worker）一直绿的实测，所以那里的 worker 数不变。未设该变量时 server 的 vitest 配置与改前逐字等效：
`npm test --workspace server`、`npm run test:focus --workspace server -- <pattern>`、CI 分片与合并覆盖率的 worker 数与覆盖率阈值都不变。
命令行显式给的 `--maxWorkers` 照常优先于配置。`server/src/sessions/omp/process.ts` 的握手期限不改。

#### Scenario: 开发机默认命令全绿
- **WHEN** 在 `availableParallelism()` 不小于 5 的开发机上执行 `WORKBUDDY_OMP_TEST=1 OMP_BIN="$PWD/var/omp/omp" npm run test:focus --workspace server -- omp-official-`，不带 `--maxWorkers`
- **THEN** 全部官方门控文件通过、退出码 0，输出里没有 `handshake timeout`
- **AND** 同一命令在改前的配置上有用例以 `handshake timeout` 失败（PR 附改前失败计数作对照）

#### Scenario: 未开门控时配置不变
- **WHEN** 未设 `WORKBUDDY_OMP_TEST` 时解析 server 的 vitest 配置
- **THEN** 解析结果里没有 `maxWorkers`，`coverage` 与共享配置相同
- **WHEN** 设 `WORKBUDDY_OMP_TEST=1` 时解析同一配置
- **THEN** `maxWorkers` 等于 `Math.max(1, Math.min(3, availableParallelism() - 1))`

#### Scenario: CI 上 worker 数不变
- **WHEN** CI uid-isolation 以 `WORKBUDDY_OMP_TEST=1` 跑官方门控清单
- **THEN** 该 job 通过；`WORKBUDDY_OMP_TEST=1` 下解析出的 `maxWorkers` 在 `availableParallelism()` 为 4 时等于 3，即改前的缺省（vitest 不打印 worker 数，CI 侧证据是 job 绿加这条公式）

### Requirement: 入库世界的泄密哨兵覆盖 console
`server/test/kb-ingest-helpers.ts` 的 `useIngestWorlds` SHALL 在每个用例期间同时收集 `process.stdout.write`、`process.stderr.write`
与 `console` 的 `log`、`info`、`warn`、`error`、`debug` 的输出，收尾时断言合起来的文本既不含 `CONTENT_SENTINEL` 也不含 `MESSAGE_SENTINEL`。
收集到的 `console` 输出 SHALL 仍照常交给 vitest（spy 不吞输出），收尾时全部 spy 恢复。判定 SHALL 提成一个可直接调用的函数，
收集器同样提成可单独起停的工厂，`useIngestWorlds` 用它，让用例能断言它会抓到泄漏，而不必依赖 `afterEach` 自己失败。

#### Scenario: console 泄漏被抓到
- **WHEN** 用例（不在 `useIngestWorlds` 的文件里，免得被它自己的收尾断言绊倒）起一个与 `useIngestWorlds` 同一工厂的收集器，经 `console.log` 写出含 `CONTENT_SENTINEL` 的文本，停止收集后对收集到的文本调用该判定函数
- **THEN** 判定失败，失败信息点名哨兵
- **AND** 收集器只 spy 两个 `write` 时（改前行为），同一用例因判定没有抛错而失败（PR 附这次红）

#### Scenario: 既有入库用例不变
- **WHEN** 跑 `npm run test:focus --workspace server -- kb-`
- **THEN** 全部既有用例通过，断言不改
