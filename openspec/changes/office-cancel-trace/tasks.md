# Tasks: office-cancel-trace

> 单 issue 单 PR（#1751，来源 Epic #1668 收尾路由）；本 fixture 随该 PR 合入。

## 风险包

| 风险包 | 选中 | 理由 / 落点 |
|---|---|---|
| Concurrency / shared state / ordering | 是 | cancel 与删目录之间只隔几个微任务；钩子必须在真实删除之前同步留痕 |
| File IO / path safety / overwrite | 是 | 钩子包住子进程的 `fs.rmSync`，只对 `<spool>/jobs/<id>` 且其下有 `cancel` 时留痕，其余调用原样转交；trace 文件与次序 trace 分开 |
| Public API / CLI / script entry | 否 | 不改入口与产品代码 |
| Schema / columns / units / field names | 否 | 无 |
| Auth / permissions / secrets | 否 | 无 |
| Config / project setup | 否 | 无 |
| Resource limits / large input / discovery | 否 | 无 |
| Error handling / rollback / partial outputs | 否 | 断言语义不变 |
| Legacy compatibility / examples | 否 | 无 |
| Release / packaging / dependency compatibility | 否 | 无 |
| Documentation / migration notes | 否 | 只改测试内注释 |

Must-preserve：
- `:213` 起的次序 trace 逐字断言不变（新留痕不写进次序 trace）。
- 两条计时结论仍有断言：超时那次写了 cancel（且作业目录已删）；`server.stop()` 后 1.5 s 内中止在途作业，早于监听器 2 s 关停预算。
- 不加大时限、不加重试、不删 `cancelAt` 类断言（规格明文禁止）。本文件其它 `until`（等 `request` 等）不改。

## 1. 跨进程 cancel 观察改为子进程内同步留痕

- [ ] 1.1 核对 Context：`server/test/server-startup-office.test.ts`（`:186-213`，用例如何起入口、是否已传 `hook`）、`server/test/server-startup-preview-helpers.ts`（`startEntry({hook})`、`hookPath` / `requireHook`、`orderTrace`）、`server/test/server-startup-helpers.ts` `orderPreload`（`Module.syncBuiltinESMExports()` 样板）、`server/src/preview/office.ts`（写 `cancel` 与 `removeJob` → `rmSync` 递归删的时序，`rmSync` 是 ESM 具名导入）、`server/test/support/fake-sidecar.ts`（`scan` / `onJobs`，变异点）。
- [ ] 1.2 测试先行 / 变异：先在**未改**的用例上做变异（假 sidecar 的事件回调不记 `cancel`），跑 5 次，记录修改前的断言变红；实现后同一变异跑 5 次保持绿；去掉变异后连跑 5 次全绿。结果贴进 PR。
- [ ] 1.3 实现：预加载钩子（源码文本经 `startEntry({hook})` 传入；若该用例已有钩子则组合）包住 `fs.rmSync`：目标路径是 `<spool>/jobs/<id>` 且 `<目标>/cancel` 存在时，先 `appendFileSync(<cancel trace>, "cancel:<id>\n")` 再执行真实删除；随后 `Module.syncBuiltinESMExports()` 使 `office.ts` 的具名导入也换成包装后的版本。`:195`、`:202` 改为轮询 cancel trace（各自原有时限不变：2 s / 1.5 s），对应作业 id 取自 `records()` 已知的作业；`:190-192` 注释改写。
- [ ] 1.4 `cd server && npx vitest run test/server-startup-office.test.ts --coverage=false` 连跑通过；`npm test --workspace server`、`scripts/size-guard.sh`、`make check` 通过（注明 #1751 本身不再出现）。

Suggested fixture level: compact - 单用例两处等待换通道，钩子样板现成。
