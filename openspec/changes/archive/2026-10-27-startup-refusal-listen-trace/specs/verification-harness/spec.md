## ADDED Requirements

### Requirement: 入口拒绝类用例以子进程自己的 listen 留痕判定监听

断言编译入口在某个启动失败阶段退出时监听状态的用例 SHALL 以被测子进程自己留下的证据取得结论：经编译入口的次序 trace 预加载（`server-startup-helpers.ts` 的 `orderTrace`，包住 `net.Server.prototype.listen`）读该次启动的 trace。用例 SHALL NOT 在子进程退出之后对 `reserveWildcardPort()` 取到、早已释放的端口发起 connect，以「被拒绝」作为证据——该端口从取号到探测一直对整机开放，并行的其它测试文件可能占到同一个号（#1821，与 #1273 是同一个「先占后放」的另一半）。按失败阶段分两种：
- 失败在 `app.listen` 之前（`config`、`db` 等）：trace 中 SHALL 没有任何 `listening:` 与 `listener-close:` 行；
- 失败在主端口绑定之后（`sandbox_root`，`server.ts` 先绑主端口再进入沙箱根阶段）：trace 的监听行 SHALL 恰为主端口上的一行 `listening:` 与一行 `listener-close:<主端口>`，预览监听器从未绑定。
这些启动 SHALL 经一个共享助手构造启动参数并由它注入 `orderTrace`（调用点无法省略），助手拒绝调用方 env 里自带的 `NODE_OPTIONS`（它会覆盖预加载），使「trace 里没有监听行」不会因为预加载没装上而空过。每次启动尝试 SHALL 用新的 trace 路径，trace 文件放在被测托管目录之外；预加载不写 stdout / stderr，同一用例原有的退出码、stdout、stderr 逐字与托管目录断言 SHALL 保留。

#### Scenario: 拒绝配置时 trace 中没有监听记录
- **WHEN** 以 `MOUNT_MAX_ATTACHING_PER_ACCOUNT=0` 启动编译入口，子进程以 `reason:"config"` 退出
- **THEN** 退出码 1、stdout 为空、stderr 恰为失败记录、托管目录都没建，且 trace 中没有 `listening:` 与 `listener-close:` 行；此后有别的进程占住同一端口，结论不变

#### Scenario: 入口在校验前多开一次监听时用例变红
- **WHEN** 临时在 `runEntrypoint` 开头、`resolveServerConfig` 之前插入 `net.createServer().listen(0, "127.0.0.1", function () { this.close(); })`（变异）
- **THEN** 全部「失败在 listen 之前」的入口拒绝用例因 trace 中出现 `listening:` 行而失败，失败信息带出该行；`sandbox_root` 一例因监听行多于预期而失败；各例的退出码、stdout、stderr 与托管目录断言仍通过
