## ADDED Requirements

### Requirement: 假 sidecar 的 cancel 观察不依赖文件事件送达
断言进程内假 sidecar（`server/test/support/fake-sidecar.ts`）「看到了某个作业的 `cancel`」的测试 SHALL 以确定的同步扫描取得这一观察，除下述第三类外 SHALL NOT 以等待 `fs.watch` 事件的方式取得——app 写完 `cancel` 随即删除作业目录，短命文件的事件可能被合并或丢弃；也 SHALL NOT 以加大等待时限、给测试加重试或删除断言来消除偶发失败。按触发方式分三种（#1574）：
- 测试在本进程内同步触发 cancel（`abort()`、`close()`）：在触发之后、第一次让出之前（`cancel` 已写、作业目录仍在）同步扫描一次，然后同步断言；
- cancel 由本进程内的计时器或其它异步路径写下、测试拿不到同步执行的机会：在 app 删除该作业目录的那一刻同步扫描（如对 `fs.rmSync` 的 spy，先扫描再执行真实删除）；
- app 在另一个进程里（编译入口的启动测试）：测试进程的扫描无法与它同拍，这一观察 SHALL 在测试里写明它依赖文件事件、以及为什么保留（承载的结论）；它承载的计时结论 SHALL 保留。

#### Scenario: 关停时在途作业的 cancel 被确定地观察到
- **WHEN** 并发上限为 1 的转换缓存有一个在途作业与若干排队调用，测试调用 `close()`，并在同一拍里（`cancel` 已写、作业目录仍在）同步扫描一次假 sidecar
- **THEN** 该作业的 `cancelAt` 立即已定义，无需等待；`close()` 返回后作业目录已删、排队调用全部 `aborted`、启动次数仍为 1
- **AND** 假 sidecar 的文件事件回调不记 `cancel` 时（变异），结论相同
