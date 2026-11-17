# Proposal: server-output-sentinel-adoption

```text
Issue type: test harness refactor（#2021）
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: server/test 里 10 个测试文件的泄密断言 + 共享模块 `server/test/support/output-sentinel.ts` + `kb-ingest-helpers.ts` 收尾。做错时：泄密断言的覆盖面变小（漏收某个通道、哨兵列表少一项）、spy 没恢复串到下一个用例，或把原本断言的其它载体（审计、日志汇、响应头、帧）顺手删掉
Selected risk packs: Auth / permissions / secrets（泄密断言只增不减）; Legacy compatibility / examples（既有用例的其它断言不改）; Concurrency / shared state / ordering（spy 恢复与收尾次序）
Evidence floor: 每处改动的临时探针：改前经 console 写哨兵不被抓到（omp-host-tools、preview-token-rest 改前就抓得到，记为不退化；models-probe、preview-token-rest 用运行时才确定的哨兵），改后被抓到并点名哨兵（.workplans/2021/probe-<文件>-{before,after}.log）；入库世界收尾变异（关闭抛错后 spy 是否遗留）；npm run test:focus --workspace server -- <各文件>；npm test --workspace server；make check
```

design.md omitted (compact)。

## Why

#2018（PR 2019）把入库世界与设置世界的输出泄密哨兵合成 `server/test/support/output-sentinel.ts` 一份，proposal 把仓库里另外 9 处自带收集列为 Non-goal 交给 #2021；fixture 审查又找出 2 处（`mounts-rest-hosts`、`session-kb-hits`，写法是 `vi.spyOn(stream, "write")` 加透传实现，原 grep 没匹配到）。其中 8 处只 spy `write`（或只 spy `stderr`），密钥经 `console.*` 泄出时查不出来；2 处同时收 `console` 但各写一份，违反 Code Canonicality。另有既有缺陷：`useIngestWorlds` 收尾时关闭世界一步抛错，`output.stop()` 不执行，spy 串到下一个用例。

## What Changes

- 10 处泄密断言改用共享 `outputCollector()` + `expectNoSentinel(text, sentinels)`：`kb-retrieval-endpoint`、`connectors-probe`、`models-probe`、`model-proxy-routing`、`kb-ragflow-client`、`kb-ragflow-client-retrieval`、`preview-token-rest`、`omp-host-tools`、`mounts-rest-hosts`、`session-kb-hits` 的测试文件。用例体内判定的，`stop()` 放进 `finally`，用例中途失败也恢复 spy。各处原有的哨兵列表不变；同一断言里对其它载体（审计行、受管日志汇、响应头、响应体、omp 帧）的检查原样保留。
- 共享收集器的 `write` 通道把 `Uint8Array`/`Buffer` 块按 UTF-8 解码（`preview-token-rest` 原有的做法），不再用 `String(chunk)`。
- `useIngestWorlds` 收尾改为 `try { try { 既有收尾断言 } finally { 关闭世界与假服务 } } finally { 停收集、判定 }`：既有断言失败或关闭抛错时，世界照样关闭、spy 照样恢复。`connectors-probe` 的 `afterEach` 同样改成关闭在 `try`、恢复与判定在 `finally`。
- 三处不改，spec 写明例外：
  - `server/test/server-entry-silent.test.ts`：断言导入入口时不打出 `server_started`/`server_start_failed` 记录（静默），不是泄密哨兵。
  - `server/test/server-upstream-failed-log.test.ts`、`server/test/server-handshake-log.test.ts`：用 `mockImplementation` 替换 `write` 来驱动受管写入器的回调与失败形态、断言精确记录行，`not.toContain(KEY)` 只是附带；共享收集器原样透传，替代不了。
- verification-harness「入库世界的泄密哨兵覆盖 console」MODIFIED：适用范围从两个世界工厂扩到 server 测试里的全部输出泄密断言，写明例外。

## Non-goals

- web 侧测试不在范围（本次 grep 只覆盖 `server/test`）。
- 不新增泄密场景；不改哨兵取值。

## Impact

只动 `server/test/**` 与 openspec。产品代码、web、CI 不动。
