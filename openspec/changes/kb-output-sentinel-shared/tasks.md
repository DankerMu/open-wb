# Tasks: kb-output-sentinel-shared

> 单 issue 单 PR（#2018）；合入后另开 PR 归档。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Legacy compatibility / examples | 是 | 既有 `kb-` 用例与断言不改，全绿（1.4）；唯一允许的改动见 1.1 |
| Auth / permissions / secrets | 是 | 设置世界的密钥哨兵新增 `console` 通道；覆盖面只增不减。落点是 1.2、1.3 的两份探针日志（改前漏判、改后抓到） |
| Error handling / rollback / partial outputs | 否 | 收尾次序不变：先关世界，再停收集、判定 |
| Concurrency / shared state / ordering | 是 | 收尾次序变了会漏收泄漏期间的输出，spy 没恢复会串到下一个用例。落点：`kb-ingest-sentinel.test.ts` 的 spy 恢复断言保持绿；probe-after 日志证明收尾时才判定 |
| Public API / CLI / script entry | 否 | 无 |
| Schema / columns / units / field names | 否 | 无 |
| Config / project setup | 否 | 无 |
| File IO / path safety / overwrite | 否 | 无 |
| Resource limits / large input / discovery | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只有 spec |

Boundary：只改 `server/test/support/output-sentinel.ts`（新）、`server/test/kb-ingest-helpers.ts`、`server/test/kb-settings-helpers.ts`、`server/test/kb-ingest-sentinel.test.ts`（不改名）。其余只读。

Must-preserve：
- 两个世界收尾时先关闭所有世界与假服务，再停止收集并判定；判定仍在 `finally` 里。
- 入库世界判 `CONTENT_SENTINEL`、`MESSAGE_SENTINEL`；设置世界判它原有的 `SENTINELS` 全部五项。
- 判定失败信息只点名哨兵，不回显收集到的文本。
- `kb-ingest-helpers.ts` 不再导出收集器与判定（唯一实现在 support 模块），调用方改从新位置导入；没有残留的重新导出。

## 1. 合并实现（#2018）

- [x] 1.1 新建 `server/test/support/output-sentinel.ts`，把 `outputCollector` 与 `expectNoSentinel` 原样挪入，判定加 `sentinels` 参数；`useIngestWorlds` 改用它（传两个哨兵）。既有 `kb-ingest-sentinel` 用例改为新导入，保持绿：只允许改导入路径，以及给两处 `expectNoSentinel(text)` 补上 `[CONTENT_SENTINEL, MESSAGE_SENTINEL]` 参数，期望的报错文本不变。
- [x] 1.2 新用例（与既有 sentinel 用例同文件）：起共享收集器，`console.warn` 写出设置世界的一个密钥哨兵，停止后以设置世界的哨兵列表判定，断言抛错且点名该哨兵。设置世界的哨兵列表从 `kb-settings-helpers.ts` 导出（只导出列表）。
  改前证据（临时探针，不提交）：在一个用 `useSettingsWorlds` 的测试文件里临时加一例 `console.warn(<某密钥哨兵>)`，在 1.3 之前跑该文件——全绿即漏判，记 `.workplans/2018/probe-before.log`。
- [x] 1.3 `useSettingsWorlds` 改用共享收集器与判定，删掉它自己的 spy 与比对逻辑；文件头注释（`kb-settings-helpers.ts:7`）同步写明也收 `console`。再跑同一探针：该例在收尾失败且点名哨兵，记 `.workplans/2018/probe-after.log`；然后删掉探针。
- [x] 1.4 `npm run test:focus --workspace server -- kb-`、`-- kb-ingest-sentinel`、`npm test --workspace server`、`make check` 通过（日志带 `EXIT=`）。

Suggested fixture level: compact - 测试支架去重。
