# Tasks: web-test-timeout-budget

> 单 issue 单 PR（#2008）；fixture 随该 PR 合入，合入后另开 PR 归档。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Legacy compatibility / examples | 否 | 不改任何兼容面；「既有用例不改、全绿」只是证据要求，见 1.3 |
| Config / project setup | 是 | 只改 `web/vitest.config.ts` 一个键；共享配置、server、CI 文件不动 |
| Concurrency / shared state / ordering | 否 | 不改 worker 数与 pool |
| Error handling / rollback / partial outputs | 否 | 无 |
| Public API / CLI / script entry | 否 | 无 |
| Schema / columns / units / field names | 否 | 无 |
| Auth / permissions / secrets | 否 | 无 |
| File IO / path safety / overwrite | 否 | 无 |
| Resource limits / large input / discovery | 否 | 真挂起的用例要 15 s 才报：接受这个代价（owner 裁定），由 `scheduler-drain-setup.ts` 的屏障与 `testTimeout` 照常显式失败 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只有 spec |

Boundary：只改 `web/vitest.config.ts`；其余只读。

Must-preserve：
- 不加 `retry`，不改 `hookTimeout`。
- 用例级 `timeout`（web 唯一一处：`web/test/scheduler-drain.test.tsx:92` 的 `{ timeout: 2000 }`）照常生效；`:87` 是 RTL `waitFor` 的等待选项，不受 `testTimeout` 影响。
- verification-harness「共享 Vitest 配置的 native ESM 边界」随本 change 改写为如实列出各 workspace 的叠加项（MODIFIED），共享配置本身不动。
- 覆盖率 include/exclude 与阈值不变。

## 1. web 单例预算（#2008）

- [ ] 1.1 改 `web/vitest.config.ts`：`test.testTimeout: 15000`，注释写明 #2008 与诊断结论（不是挂起，CI 慢 4–10 倍）。
- [ ] 1.2 解析 web 与 server 的配置（vitest `resolveConfig`），记录：web `testTimeout=15000`；web 与 server `hookTimeout=10000`、`retry` 未设或为 0；server `testTimeout=5000`。
- [ ] 1.3 `npm test --workspace web`、`npm run test:focus --workspace web -- scheduler-drain`、native loader `npm exec --workspace @workbuddy/web -- vitest run --coverage --configLoader native`（退出码 0、实际跑完用例并出 V8 coverage summary、无 loader warning）、`make check` 通过。

Suggested fixture level: compact - 一个配置值。
