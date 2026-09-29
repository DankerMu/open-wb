## ADDED Requirements

### Requirement: 并发 spawn 上限
应用配置 SHALL 新增可选键 `OMP_SPAWN_CONCURRENCY`，缺省值为 `os.availableParallelism()`。其解析纪律 SHALL 与 `OMP_MAX_PROCESSES` 完全一致（canonical ASCII decimal 正整数 `1..2147483647`，非法或超限值在任何 filesystem/database/listen 副作用前使启动失败，错误消息命名该键而不含输入值），并经 `agent-config` 同一纯解析器、同一 runtime settings 对象进入 supervisor。

supervisor SHALL 持有恰一个以该值为许可数的 spawn gate，会话 slot 的 runtime 与 fork 临时 runtime 共用它。每次 acquisition（`prompt`、`command` 及其惰性获取、spawn 失败后的重获取）SHALL 在准入之后、spawn 之前取得一个许可；许可不足时按到达顺序（FIFO）排队。许可 SHALL 在取得之后该次 acquisition 的每条退出路径上恰归还一次：启动（spawn + 握手）结算时立即归还——成功或失败都一样，不等失败 generation 的退役完成；spawn 之前的失败（如 token 签发抛错、关停复查）同样归还。任一时刻已取得许可、启动尚未结算的 acquisition 数 SHALL ≤ 该值。排队不设超时：准入先于排队，队列深度 ≤ `OMP_MAX_PROCESSES`。

runtime 关停（`shutdown()`，含驱逐、supervisor 关停与 fork 临时进程的停止）SHALL 同步取消其仍在排队的 acquisition：该 acquisition 以 `agent_unavailable` 失败、从未 spawn、不占许可，关停不因排队而等待。未注入 gate 的 SessionRuntime SHALL 不排队（既有行为）。

#### Scenario: 缺省与覆盖
- **WHEN** 未设置 `OMP_SPAWN_CONCURRENCY` 启动，或设置为 `1`、`2`、`2147483647`
- **THEN** supervisor 的并发 spawn 上限分别为 `os.availableParallelism()`、1、2、2147483647，其它配置行为不变

#### Scenario: 非法值启动失败
- **WHEN** `OMP_SPAWN_CONCURRENCY` 为空串、`0`、`abc`、`-1`、`1.5`、`+3`、`016`、` 8`、`2147483648`
- **THEN** 启动 nonzero，stderr 恰一行既有 generic failure record，错误命名该键且不含输入值，无任何 filesystem/database/listen 副作用

#### Scenario: 并发冷启动受上限约束
- **WHEN** `OMP_SPAWN_CONCURRENCY=1`、`OMP_MAX_PROCESSES≥3`，三个会话同时对 fake-omp `slow-ready` 发 prompt
- **THEN** 任一时刻「已 spawn、尚未 ready」的子进程至多 1 个；三个 prompt 都返回 202（握手成功、prompt 已派发）

#### Scenario: 关停取消排队
- **WHEN** `OMP_SPAWN_CONCURRENCY=1`，会话 A 正在慢握手，会话 B 的 prompt 在排队，随后 supervisor 关停（或 B 的 runtime 被单独关停）
- **THEN** B 的请求以 `agent_unavailable` 结束，B 从未 spawn（`spawnImpl` 调用次数只计 A）；单独关停 B 时，B 在 A 仍持有许可、A 的启动尚未结算之前就已结束，关停不等待 B 取得许可

#### Scenario: 启动失败立即归还许可
- **WHEN** `OMP_SPAWN_CONCURRENCY=1`，会话 A 的启动失败（握手超时或子进程提前退出）而会话 B 在排队
- **THEN** B 在 A 的失败 generation 退役完成之前就已 spawn，B 的 prompt 返回 202

#### Scenario: spawn 前失败不泄漏许可
- **WHEN** `OMP_SPAWN_CONCURRENCY=1`，会话 A 取得许可后在 spawn 之前失败（其 generation token 签发抛错），会话 B 在排队
- **THEN** A 的请求以错误结束；B 随后 spawn 并完成回合

#### Scenario: fork 临时进程共用许可
- **WHEN** `OMP_SPAWN_CONCURRENCY=1`，一个会话正在慢握手时对另一个会话发起 fork
- **THEN** fork 临时进程的 spawn 晚于前者 ready；两者都成功
