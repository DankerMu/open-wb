# verification-harness Spec Delta

> kb-output-sentinel-shared（#2018）：输出泄密哨兵只留一份实现，入库世界与设置世界共用；设置世界的密钥哨兵也覆盖 `console`。

## MODIFIED Requirements

### Requirement: 入库世界的泄密哨兵覆盖 console
输出泄密哨兵 SHALL 只有一份实现，放在中立的测试支架模块 `server/test/support/output-sentinel.ts`：
- 收集器工厂 `outputCollector()`：`start()` 装 spy，`stop()` 恢复全部 spy 并返回收集到的文本。它在每个用例期间同时收集 `process.stdout.write`、`process.stderr.write` 与 `console` 的 `log`、`info`、`warn`、`error`、`debug` 的输出。收集到的 `console` 输出 SHALL 仍照常交给 vitest（spy 不吞输出）。
- 判定函数 `expectNoSentinel(text, sentinels)`：文本含任一哨兵就抛错，信息只点名命中的哨兵，不回显文本。

`server/test/kb-ingest-helpers.ts` 的 `useIngestWorlds` 与 `server/test/kb-settings-helpers.ts` 的 `useSettingsWorlds` SHALL 都用这两个函数，收尾时分别断言收集到的文本不含各自的哨兵：入库世界是 `CONTENT_SENTINEL` 与 `MESSAGE_SENTINEL`，设置世界是它的密钥与泄漏哨兵列表（`SENTINELS`）。两个世界原有的收尾次序不变。这两个世界工厂里 SHALL NOT 再有自带的输出收集或哨兵比对逻辑。判定与收集器可直接调用，让用例能断言它会抓到泄漏，而不必依赖 `afterEach` 自己失败。

#### Scenario: console 泄漏被抓到
- **WHEN** 用例（不在 `useIngestWorlds` 的文件里，免得被它自己的收尾断言绊倒）起一个与 `useIngestWorlds` 同一工厂的收集器，经 `console.log` 写出含 `CONTENT_SENTINEL` 的文本，停止收集后对收集到的文本调用该判定函数
- **THEN** 判定失败，失败信息点名哨兵
- **AND** 收集器只 spy 两个 `write` 时（改前行为），同一用例因判定没有抛错而失败（PR 附这次红）

#### Scenario: 设置世界的密钥经 console 泄出被抓到
- **WHEN** 用例（不在 `useSettingsWorlds` 的文件里）起同一个收集器，经 `console.warn` 写出含设置世界某个密钥哨兵的文本，停止收集后以设置世界的哨兵列表调用判定函数
- **THEN** 判定失败，失败信息点名该哨兵
- **AND** 改前抓不到、改后抓得到由临时探针证明（PR 附两次输出，探针不提交）：在一个用 `useSettingsWorlds` 的测试文件里临时加一例，经 `console.warn` 写出一个密钥哨兵；改前该文件全绿（漏判），改后该例在收尾失败且信息点名该哨兵

#### Scenario: 既有入库用例不变
- **WHEN** 跑 `npm run test:focus --workspace server -- kb-`
- **THEN** 全部既有用例通过，断言不改；`kb-ingest-sentinel` 用例只改导入路径，并因判定签名变化补上入库世界的哨兵列表参数，期望的报错文本不变
