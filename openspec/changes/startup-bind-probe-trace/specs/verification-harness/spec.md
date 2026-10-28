## ADDED Requirements

### Requirement: 启动用例以 listener-close 留痕证明端口已释放

断言编译入口子进程退出后「端口已释放、可由后继进程复用」（http-service-skeleton 与 office-preview 中「可重新绑定 / 立即复用」的测试判据）的用例——不论子进程是启动失败退出（退出码 1），还是在启动期或关停中收到信号退出（退出码 0）——SHALL 以被测子进程自己的次序 trace 取得结论：该次启动 trace 中每个绑定过的监听器都有对应的 `listener-close:<端口>` 行、从未绑定的端口没有 `listening:` 行，加上子进程已按预期退出码退出。用例 SHALL NOT 在子进程退出之后对 `reserveWildcardPort()` 取到、已释放的端口调用 `bind`（`expectBindable`）作为证据——进程退出时内核已回收其全部 fd，这一 bind 观察不到被测进程，只会因并行测试占到同一个号而 `EADDRINUSE` 偶发红（#1825，与 #1273 / #1821 同属「先占后放」），也拦不住「漏关监听器、靠进程退出兜底」的回归。

已有 trace 逐字断言的用例直接删去冗余的 bind。没有 trace 的 SHALL 经「入口拒绝类用例以子进程自己的 listen 留痕判定监听」所述的共享助手（`startListenTraced`，由它注入每次尝试新取的 `orderTrace` 并拒绝调用方的 `NODE_OPTIONS`）启动，助手按需支持子进程 stdout 指向调用方的文件描述符、并允许每次尝试异步取得启动参数（如新取的 `PREVIEW_PORT`）。唯一例外是故意先占住预览端口、因而不能走重试包装器的 `preview_listen` 用例：它直接给 `startCompiledServer` 传每次新取的 `orderTrace`；它期望的监听行含 `listening:` 行，预加载没装上时只会失败、不会空过。按失败阶段断言的监听行形状为：从未监听；仅主端口绑定并关闭；主端口绑定且预览绑定失败（`listener-close:-`）；两个端口都绑定并关闭（预览端口为临时号时按形状匹配）。产品 spec 的措辞不变。「失败前多开一次监听」类回归由上述共享助手的既有要求覆盖，同样适用于本要求替换下来的从未监听用例。

#### Scenario: 失败清理漏关主监听器时用例变红
- **WHEN** 临时把入口失败清理中主实例的关闭换成 `server.unref()`（不关闭、进程照样以 1 退出）（变异）
- **THEN** 主端口绑定过的启动失败用例因 trace 缺 `listener-close:<主端口>` 而失败；而在变异前的写法下，同一变异里退出后的 `expectBindable` 仍会通过
