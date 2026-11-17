# Tasks: server-output-sentinel-adoption

> 单 issue 单 PR（#2021）；合入后另开 PR 归档。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Auth / permissions / secrets | 是 | 每处泄密断言的通道只增不减（加 `console`），哨兵列表逐项保持；落点是每处的 probe before/after 日志 |
| Legacy compatibility / examples | 是 | 同一用例里对其它载体的断言一字不改（见 Must-preserve）；全绿（1.6） |
| Concurrency / shared state / ordering | 是 | spy 在 `finally` 里恢复：用例体内判定的 `stop()` 进 `finally`；`useIngestWorlds`、`connectors-probe` 的收尾在关闭抛错时也恢复；收集器可嵌套，内层 `stop()` 不清外层收集。落点：1.1 的嵌套用例、1.2 的 `kb-retrieval-endpoint` 双探针、1.3 的入库世界变异日志（`connectors-probe` 的结构改动只由评审核对） |
| Error handling / rollback / partial outputs | 否 | 无 |
| Public API / CLI / script entry | 否 | 无 |
| Schema / columns / units / field names | 否 | 无 |
| Config / project setup | 否 | 无 |
| File IO / path safety / overwrite | 否 | 无 |
| Resource limits / large input / discovery | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只有 spec |

Boundary：只改 `server/test/support/output-sentinel.ts`、`server/test/kb-ingest-helpers.ts`、`server/test/kb-ingest-sentinel.test.ts`（为 1.1 加用例）、`server/test/mounts-rest-helpers.ts`（仅当需要导出 `SECRETS` 列表）与下列 10 个测试文件：`kb-retrieval-endpoint.test.ts`、`connectors-probe.test.ts`、`models-probe.test.ts`、`model-proxy-routing.test.ts`、`kb-ragflow-client.test.ts`、`kb-ragflow-client-retrieval.test.ts`、`preview-token-rest.test.ts`、`omp-host-tools.test.ts`、`mounts-rest-hosts.test.ts`、`session-kb-hits.test.ts`。`server-entry-silent.test.ts`、`server-upstream-failed-log.test.ts`、`server-handshake-log.test.ts` 只读。

Must-preserve：
- 每处原有的哨兵列表逐项保留：`models-probe` 收尾时才确定的 `baseUrls` 在判定时求值（不得提前固化成空数组）；`mounts-rest-hosts` 的输出文本按 `expectNoSecret` 的同一组 `SECRETS` 判定。
- 每处同一断言里对非输出载体的检查不删不改：
  - `kb-retrieval-endpoint`：审计与 `world.logged`。
  - `kb-ragflow-client{,-retrieval}`：结果对象与 `logged`。
  - `preview-token-rest`：响应头、`sinks`、审计行与响应体（`sinks` 的 `JSON.stringify` 检查保留，只把 `console` 从那里挪到收集器）。
  - `omp-host-tools`：`run.writes`、`results`、`run.errors`。
  - `mounts-rest-hosts`：响应体、审计行（含 kind 序列）、`world.errors`、`world.mountCalls()` 的 argv/env。
  - `session-kb-hits`：帧与 `turn.records`。
- `mounts-rest-hosts`：`output.stop()` 取代 `:315` 的 `vi.restoreAllMocks()`，位置不变（在后面的判定之前）。
- 原来在 `afterEach` 里判定的仍在 `afterEach`；原来在用例体里判定的仍在用例体，`stop()` 放进包住该段的 `finally`，判定在 `stop()` 之后。原 `afterEach` 里的其它收尾（关闭世界、`fake.unknownRoutes()`、`fake.close()`）照常执行。
- `useIngestWorlds` 收尾：`kb-ingest-helpers.ts` 现有对假服务路由、bearer、`expectDefaultNeverCleared` 的检查仍先跑；结构为 `try { try { 这些检查 } finally { closeApps / disposeWorlds / fake.close } } finally { stop + 判定 }`。
- `expectNoSentinel` 失败信息只点名哨兵，不回显文本。
- 嵌套：`kb-retrieval-endpoint` 的用例体收集器套在 `useIngestWorlds` 的收集器里面。入库世界的收尾判定 SHALL 仍覆盖该用例全程（含收尾阶段）：内层 `stop()` 不得清空或恢复外层装的 spy。

## 1. 收口（#2021）

- [ ] 1.1 共享收集器可嵌套：`start()` 时某方法已是 mock（`vi.isMockFunction`），就不再 `spyOn`，只记下该 mock 当前 `mock.calls.length` 作为起点，`stop()` 只读起点之后的调用、不恢复它；自己装的 spy 照旧读全部并恢复。`kb-ingest-sentinel.test.ts` 加一例：外层收集器 start，内层 start，`console.warn(<哨兵>)`，内层 stop 并判定抛错；随后外层 stop，外层文本同样含该哨兵且全部 spy 已恢复。改前该例红（内层 `mockRestore` 清空外层），记 `.workplans/2021/nested-red.log`。
  另：共享收集器的 `write` 通道按 UTF-8 解码 `Uint8Array`/`Buffer` 块（`typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")`）。`kb-ingest-sentinel.test.ts` 加一例：`process.stdout.write(new TextEncoder().encode(<哨兵>))`，判定抛错并点名哨兵。改前该例红（`String(Uint8Array)` 得逗号分隔数字），记 `.workplans/2021/uint8-red.log`。
- [ ] 1.2 10 个文件逐个改用共享收集器与判定。每个文件改前加临时探针：在该处收集期间 `console.warn(<该处一个哨兵>)`；`models-probe` 写一个 `addModel` 之后才进 `baseUrls` 的条目，`preview-token-rest` 写运行时拿到的 `token`。`kb-retrieval-endpoint` 另加第二个探针：在那个用例里 `console.warn(CONTENT_SENTINEL)`，改后必须在入库世界收尾报红（证明嵌套没吃掉外层）。跑该文件记 `probe-<文件>-before.log`（预期全绿＝漏判；`preview-token-rest`、`omp-host-tools` 预期已红＝不退化基线）；改后同一探针记 `probe-<文件>-after.log`（预期红，信息点名哨兵）；删探针，跑该文件全绿。
- [ ] 1.3 `useIngestWorlds` 与 `connectors-probe` 的收尾按 Must-preserve 改结构。变异证据（临时，不提交）：在 `useIngestWorlds` 收尾的关闭段临时插一个 `throw`；新建一个临时测试文件，在 `describe("A")` 里调用 `useIngestWorlds()` 并跑一个开世界的用例，在其后的兄弟 `describe("B")`（不受 A 的钩子作用）里断言 `vi.isMockFunction(console.log)` 与 `vi.isMockFunction(process.stdout.write)` 都为 false。改前 B 红（spy 遗留），改后 B 绿；记 `.workplans/2021/ingest-teardown-{before,after}.log`，随后撤掉变异并删掉临时文件。
- [ ] 1.4 用例体内判定的各处，确认 `stop()` 在 `finally` 里（逐处列出行号写进 PR）。
- [ ] 1.5 grep 证明：`server/test` 里 `vi.spyOn(<任意对象>, "write")` 与 `vi.spyOn(console, …)` 只剩 `support/output-sentinel.ts` 与三处例外（`server-entry-silent`、`server-upstream-failed-log`、`server-handshake-log`），其它命中逐条列出并说明非泄密用途；记 `.workplans/2021/grep.log`。
- [ ] 1.6 `npm run test:focus --workspace server -- <10 个文件与 kb-ingest-sentinel>`、`npm run test:focus --workspace server -- kb-`、`npm test --workspace server`、`make check` 通过（日志带 `EXIT=`）。

Suggested fixture level: compact - 测试支架收口。
