# Proposal: kb-output-sentinel-shared

```text
Issue type: test harness refactor（#2018）
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: server/test 的两个世界工厂（useIngestWorlds、useSettingsWorlds，13 个设置测试文件与全部入库测试文件经它收尾）。做错时：收尾次序变了导致泄漏期间的输出没收进来、spy 没恢复串到下一个用例，或设置世界的密钥哨兵漏判
Selected risk packs: Legacy compatibility / examples（既有 kb- 用例与断言不改，签名变化带来的参数补全除外）; Auth / permissions / secrets（密钥哨兵的覆盖面变大，不能变小）; Concurrency / shared state / ordering（收尾次序与 spy 恢复）
Evidence floor: 临时探针改前全绿（漏判，.workplans/2018/probe-before.log）、改后在收尾失败并点名哨兵（probe-after.log）；npm run test:focus --workspace server -- kb-；npm test --workspace server；make check
```

design.md omitted (compact)。

## Why

#2009（PR 2013）把入库世界的哨兵提成 `outputCollector` / `expectNoSentinel` 并加上 `console` 通道。审查发现 `server/test/kb-settings-helpers.ts:163-179` 的 `useSettingsWorlds` 另有一份只 spy 两个 `write` 的收集逻辑：同一逻辑两份实现，违反 Code Canonicality；设置世界的密钥哨兵经 `console.*` 泄出时查不出来。

## What Changes

- 收集器与判定挪到 `server/test/support/output-sentinel.ts`，判定改为接收哨兵列表。挪到中立模块的原因：`kb-ingest-helpers.ts` 已 import `kb-settings-helpers.ts`，反向 import 会成环。
- `useIngestWorlds`、`useSettingsWorlds` 都改用它；`kb-ingest-sentinel.test.ts` 改为从新位置导入，并加设置世界一例。
- verification-harness「入库世界的泄密哨兵覆盖 console」MODIFIED：写明唯一实现的位置与两个世界的用法，加一个场景。

## Non-goals

- 只合并两个世界工厂里的收集逻辑。仓库里另有几处自带的输出收集（只 spy 两个 `write` 的：`kb-retrieval-endpoint.test.ts:205-216`、`connectors-probe.test.ts:97`、`models-probe.test.ts:49`、`model-proxy-routing.test.ts:143-144`、`server-entry-silent.test.ts:25-26`；只 spy `stderr` 的：`kb-ragflow-client.test.ts:68`、`kb-ragflow-client-retrieval.test.ts:42`；同时收 `write` 与 `console` 的：`preview-token-rest.test.ts:533-536`、`omp-host-tools.test.ts:406-408`），本次不动，另开 issue 跟进。
- 提交进仓库的用例只证明共享收集器与判定能抓到 `console` 泄漏，不保护 `useSettingsWorlds` 的接线：以后若有人把它改回自带 spy，不会有测试变红。接线的改前改后只由临时探针证明。

## Impact

只动 `server/test/**`。产品代码、web、CI 不动。
