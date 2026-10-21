## ADDED Requirements

### Requirement: 假 sidecar 的 cancel 观察不依赖文件事件送达
断言进程内假 sidecar（`server/test/support/fake-sidecar.ts`）「看到了某个作业的 `cancel`」的测试，SHALL 在 app 写下 `cancel` 之后、作业目录被删之前的同一拍里，经一次同步扫描让假 sidecar 记下它，然后同步断言；SHALL NOT 以等待 `fs.watch` 事件的方式取得这一观察（app 写完 `cancel` 随即删除作业目录，短命文件的事件可能被合并或丢弃），也 SHALL NOT 以加大等待时限、给测试加重试或删除断言来消除偶发失败。作业目录在 `cancel` 写下后不会立即被删的用例不受此限，但须在测试或 PR 中写明理由（#1574）。

#### Scenario: 关停时在途作业的 cancel 被确定地观察到
- **WHEN** 并发上限为 1 的转换缓存有一个在途作业与若干排队调用，测试调用 `close()`，并在同一拍里（`cancel` 已写、作业目录仍在）同步扫描一次假 sidecar
- **THEN** 该作业的 `cancelAt` 立即已定义，无需等待；`close()` 返回后作业目录已删、排队调用全部 `aborted`、启动次数仍为 1
- **AND** 假 sidecar 收不到任何 `cancel` 文件事件时（变异），结论相同
