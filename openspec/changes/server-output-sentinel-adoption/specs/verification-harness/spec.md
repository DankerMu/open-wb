# verification-harness Spec Delta

> server-output-sentinel-adoption（#2021）：server 测试里的输出泄密断言全部走共享收集器与判定；例外写明。

## MODIFIED Requirements

### Requirement: 入库世界的泄密哨兵覆盖 console
输出泄密哨兵 SHALL 只有一份实现，放在中立的测试支架模块 `server/test/support/output-sentinel.ts`：
- 收集器工厂 `outputCollector()`：`start()` 装 spy，`stop()` 恢复自己装的 spy 并返回收集到的文本。它在每个用例期间同时收集 `process.stdout.write`、`process.stderr.write` 与 `console` 的 `log`、`info`、`warn`、`error`、`debug` 的输出；`write` 收到的 `Uint8Array`/`Buffer` 块按 UTF-8 解码。收集器 SHALL 可嵌套：`start()` 时方法已被 spy 的，只从当时的调用数之后读起，`stop()` 不恢复它，外层收集器的记录与 spy 不受内层影响。收集到的 `console` 输出 SHALL 仍照常交给 vitest（spy 不吞输出）。
- 判定函数 `expectNoSentinel(text, sentinels)`：文本含任一哨兵就抛错，信息只点名命中的哨兵，不回显文本。

`server/test/kb-ingest-helpers.ts` 的 `useIngestWorlds` 与 `server/test/kb-settings-helpers.ts` 的 `useSettingsWorlds` SHALL 都用这两个函数，收尾时分别断言收集到的文本不含各自的哨兵：入库世界是 `CONTENT_SENTINEL` 与 `MESSAGE_SENTINEL`，设置世界是它的密钥与泄漏哨兵列表（`SENTINELS`）。两个世界的收尾 SHALL 先跑各自的收尾检查、关闭世界与假服务（检查失败时照样关闭），再在最外层 `finally` 里停止收集并判定；收尾检查失败或关闭抛错时 spy 也恢复。这两个世界工厂里 SHALL NOT 再有自带的输出收集或哨兵比对逻辑。判定与收集器可直接调用，让用例能断言它会抓到泄漏，而不必依赖 `afterEach` 自己失败。

`server/test` 里其余断言进程输出不含哨兵的用例（`kb-retrieval-endpoint`、`connectors-probe`、`models-probe`、`model-proxy-routing`、`kb-ragflow-client`、`kb-ragflow-client-retrieval`、`preview-token-rest`、`omp-host-tools`、`mounts-rest-hosts`、`session-kb-hits`）SHALL 同样用这两个函数收集与判定，不再自带 `write` 或 `console` 的 spy 来做泄密比对；在用例体内判定的，`stop()` SHALL 在 `finally` 里执行，用例中途失败也恢复 spy；它们对审计、日志汇、响应、omp 帧、挂载 argv/env 等其它载体的检查不受影响。例外三处，保留自己的 spy：`server/test/server-entry-silent.test.ts` 断言导入入口时不输出启动记录（静默），不是泄密哨兵；`server/test/server-upstream-failed-log.test.ts` 与 `server/test/server-handshake-log.test.ts` 用替换实现的 `write` spy 驱动受管写入器的回调与失败形态并断言精确记录行，透传的共享收集器替代不了。

#### Scenario: console 泄漏被抓到
- **WHEN** 用例（不在 `useIngestWorlds` 的文件里，免得被它自己的收尾断言绊倒）起一个与 `useIngestWorlds` 同一工厂的收集器，经 `console.log` 写出含 `CONTENT_SENTINEL` 的文本，停止收集后对收集到的文本调用该判定函数
- **THEN** 判定失败，失败信息点名哨兵
- **AND** 收集器只 spy 两个 `write` 时（改前行为），同一用例因判定没有抛错而失败（PR 附这次红）

#### Scenario: 设置世界的密钥经 console 泄出被抓到
- **WHEN** 用例（不在 `useSettingsWorlds` 的文件里）起同一个收集器，经 `console.warn` 写出含设置世界某个密钥哨兵的文本，停止收集后以设置世界的哨兵列表调用判定函数
- **THEN** 判定失败，失败信息点名该哨兵
- **AND** 改前抓不到、改后抓得到由临时探针证明（PR 附两次输出，探针不提交）：在一个用 `useSettingsWorlds` 的测试文件里临时加一例，经 `console.warn` 写出一个密钥哨兵；改前该文件全绿（漏判），改后该例在收尾失败且信息点名该哨兵

#### Scenario: 嵌套收集不吃掉外层
- **WHEN** 外层收集器已 start，内层收集器再 start，经 `console.warn` 写出含哨兵的文本，内层 stop
- **THEN** 内层文本含该哨兵、判定失败；外层随后 stop，其文本同样含该哨兵，且全部 spy 已恢复

#### Scenario: 二进制块里的哨兵被抓到
- **WHEN** 用例起收集器，经 `process.stdout.write` 写出 `new TextEncoder().encode(<哨兵>)`（纯 `Uint8Array`，不是 `Buffer`），停止收集后调用判定函数
- **THEN** 判定失败，失败信息点名哨兵

#### Scenario: 其余泄密断言改用共享实现后覆盖 console
- **WHEN** 在上列 10 个文件的任一处泄密断言的收集期间临时经 `console.warn` 写出该处的一个哨兵（探针，不提交；`models-probe` 用收尾时才确定的 `baseUrls` 条目，`preview-token-rest` 用运行时拿到的令牌）
- **THEN** 该处断言失败并点名哨兵；改前只 spy `write` 的 8 个文件同一探针不失败（PR 附两次输出）

#### Scenario: 既有入库用例不变
- **WHEN** 跑 `npm run test:focus --workspace server -- kb-`
- **THEN** 全部既有用例通过，断言不改；`kb-ingest-sentinel` 用例只改导入路径，并因判定签名变化补上入库世界的哨兵列表参数，期望的报错文本不变
