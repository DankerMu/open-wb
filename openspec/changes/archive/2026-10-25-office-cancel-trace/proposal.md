# Proposal: office-cancel-trace

```text
Issue type: bugfix (test flake)
Fixture level: compact
Upstream suggested level: (issue 未标) compact
Blast radius: server-startup-office.test.ts 两处 cancel 观察；做错时用例仍偶发红，或把计时结论（超时写 cancel、SIGTERM 后 1.5 s 内中止在途作业）丢掉
Selected risk packs: Concurrency / shared state / ordering; File IO / path safety / overwrite（预加载钩子包 fs.rmSync，只在测试子进程）
Evidence floor: server-startup-office.test.ts 连跑稳定通过；变异验证（假 sidecar 事件回调不记 cancel）修改前红、修改后绿各 5 次；次序 trace 逐字断言不变；npm test --workspace server；make check
```

design.md omitted (compact)：issue #1751 已给出通道（`startEntry({hook})` 的 `--require` 预加载，`orderPreload` 的 `Module.syncBuiltinESMExports()` 样板），本 change 只把规格第三类改写成这条确定通道。

## Why

#1751：`server/test/server-startup-office.test.ts` 编译入口用例在全量负载下偶发 `timed out waiting for the timed-out job's cancel`。app 子进程写 `cancel` 后几个微任务内就递归删掉作业目录，测试进程在 504 之后才开始扫描，扫描结构上看不到；唯一的观察通道是假 sidecar 的 `fs.watch` 回调，满负载下 darwin FSEvents 会丢这类短命文件的事件。`verification-harness`「假 sidecar 的 cancel 观察不依赖文件事件送达」第三类目前**要求**跨进程用例保留文件事件依赖，改测试必须先改这条规则。

## What Changes

- verification-harness：第三类（跨进程）改为子进程预加载钩子在删除作业目录那一刻同步留痕到专用 trace 文件，测试轮询该文件；计时结论保留；加一个场景（含变异）。
- 测试：`server-startup-office.test.ts` 的 `:195`（超时那次）与 `:202`（关停时在途作业）两处等待改为轮询 cancel trace；去掉 `:190-192` 的「依赖文件事件」注释，改写为新通道的说明。钩子经 `spoolEntry` 新增的 `hook` 透传给 `startEntry({hook})`；trace 写在每次尝试的根下。

## Impact

- 规格：verification-harness 一条 requirement 修改。
- 代码：仅测试——`server/test/server-startup-office.test.ts`，必要时 `server/test/server-startup-helpers.ts`（只在需要导出钩子构造函数时）。
- 不动：产品代码 `server/src/preview/office.ts`、假 sidecar 的进程内通道、#1574 已修好的进程内用例。
