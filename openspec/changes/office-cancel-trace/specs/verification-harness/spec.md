# verification-harness Spec Delta

> office-cancel-trace（#1751）：假 sidecar cancel 观察的第三类（跨进程）改为子进程预加载钩子在删除时刻同步留痕，不再依赖 `fs.watch` 送达。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 假 sidecar 的 cancel 观察不依赖文件事件送达
断言进程内假 sidecar（`server/test/support/fake-sidecar.ts`）「看到了某个作业的 `cancel`」的测试 SHALL 以确定的同步扫描取得这一观察，除下述第三类外 SHALL NOT 以等待 `fs.watch` 事件的方式取得——app 写完 `cancel` 随即删除作业目录，短命文件的事件可能被合并或丢弃；也 SHALL NOT 以加大等待时限、给测试加重试或删除断言来消除偶发失败。按触发方式分三种（#1574）：
- 测试在本进程内同步触发 cancel（`abort()`、`close()`）：在触发之后、第一次让出之前（`cancel` 已写、作业目录仍在）同步扫描一次，然后同步断言；
- cancel 由本进程内的计时器或其它异步路径写下、测试拿不到同步执行的机会：在 app 删除该作业目录的那一刻同步扫描（如对 `fs.rmSync` 的 spy，先扫描再执行真实删除）；
- app 在另一个进程里（编译入口的启动测试）：测试进程的扫描无法与它同拍，这一观察 SHALL 由子进程内的预加载钩子在 app 删除该作业目录的那一刻同步留痕（第二类的跨进程版本：包住 `fs.rmSync`，目标是作业目录且其下有 `cancel` 时先追加一行 `cancel:<作业 id>` 到一个专用 trace 文件，再执行真实删除；该 trace 与入口的次序 trace 分开），测试轮询这个 trace 文件取得观察（#1751）；它承载的计时结论 SHALL 保留。

#### Scenario: 关停时在途作业的 cancel 被确定地观察到
- **WHEN** 并发上限为 1 的转换缓存有一个在途作业与若干排队调用，测试调用 `close()`，并在同一拍里（`cancel` 已写、作业目录仍在）同步扫描一次假 sidecar
- **THEN** 该作业的 `cancelAt` 立即已定义，无需等待；`close()` 返回后作业目录已删、排队调用全部 `aborted`、启动次数仍为 1
- **AND** 假 sidecar 的文件事件回调不记 `cancel` 时（变异），结论相同

#### Scenario: 编译入口的 cancel 不靠文件事件
- **WHEN** 编译入口的启动测试中，配置的转换超时结束一次 `hang` 作业，随后关停时有一个在途作业；测试以子进程预加载钩子写下的 cancel trace 判定这两次 cancel
- **THEN** 超时那次的 `cancel:<id>` 已在 trace 中、作业目录已删；`server.stop()` 后 1.5 s 内在途作业的 `cancel:<id>` 出现在 trace 中；入口的次序 trace 逐字不变
- **AND** 假 sidecar 的文件事件回调不记 `cancel` 时（变异），结论相同
