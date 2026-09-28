# Spec delta: omp-pool（#465 regenerate 经准入、控制占用期间不可驱逐）

> 以主 spec 原文为底，只并入父 delta 同名块中本 issue（4.4）交付的部分。
> - 「活进程集合与上限不变量」：
>   - 并入进程来源的常驻/regenerate 两项，fork 临时进程 → #466；
>   - 并入「**或**所属会话持有控制占用」子句，其中去掉「（fork 临时进程则为其源会话）」与 fork 登记方 → #466；
>   - 并入 Scenario「控制占用期间不可驱逐」，WHEN 由「收到 `get_branch_messages` 应答、尚未发出 `branch`」改为「已发出 `branch`、其应答尚未到达」。前者到发出 `branch` 之间只有微任务，没有 I/O 边界，外部请求插不进来，不可观测；
>   - Scenario「临时进程计入上限」→ #466；
>   - 「上限恒成立」保留主 spec 的 prompt 版，含 regenerate 与 fork 的并发版随 #466 按父文替换。
> - 「串行化准入与最久空闲驱逐」：
>   - 路径枚举并入「regenerate 取得会话进程」，fork 临时进程 → #466；
>   - 拒绝副作用并入「regenerate 路径不改动任何行」，fork 句 → #466；
>   - fork 先退回源会话进程一段与 Scenario「fork 先退回源会话进程」→ #466；
>   - 主 spec 六个 Scenario 原样保留。
> - 「进程退出即释放名额」不动：主 spec 未枚举准入路径，父块的「（prompt、regenerate 或 fork）」枚举随 #466 一并补回。

## MODIFIED Requirements

### Requirement: 活进程集合与上限不变量
supervisor SHALL 维护"活进程集合"：每个已 spawn 且尚未退出的 omp 子进程恰占一个名额，无论它是会话 slot 的常驻进程，还是 regenerate 复用/新起的会话进程。任一时刻活进程数 SHALL ≤ `OMP_MAX_PROCESSES`。集合中每个进程 SHALL 记录最近活动时刻（该进程受理 prompt、其回合帧到达或回合结束即刷新）与是否"在回合中"；回合中定义为：该进程已受理 prompt 且尚未收到终止 `agent_end`（含挂起审批期间），**或**该进程所属会话持有 turn-control 定义的控制占用——自 regenerate/stop 预检通过起、至派发完成或响应返回止，覆盖各次 `get_branch_messages`/`branch`/`get_state` 请求之间的间隙。回合中的进程 SHALL 永不成为驱逐候选。

#### Scenario: 控制占用期间不可驱逐
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 的 regenerate 已取得进程并已发出 `branch`、其应答尚未到达（此刻无回合），会话 B 发 prompt
- **THEN** B 返回 503 `agent_capacity`，A 的进程未收到任何信号，A 的 regenerate 照常完成；A 回合结束后 B 再次 prompt 可驱逐 A 并 202

#### Scenario: 上限恒成立
- **WHEN** 以 `OMP_MAX_PROCESSES=2` 并发对 4 个会话发 prompt
- **THEN** 以真实子进程观察，任一时刻活 omp 子进程数 ≤2；每个 503 响应都对应"活进程数 ==2 且全部在回合中"的时刻

### Requirement: 串行化准入与最久空闲驱逐
所有会 spawn 新进程的路径（prompt 懒 spawn / resume、regenerate 取得会话进程）SHALL 经同一准入点（`sessions/pool.ts` 的进程池准入），准入 SHALL 串行化：一次准入的"判定→（驱逐）→登记名额"在同一临界区内完成，两次并发准入不得同时越过上限。判定规则：活进程数 < 上限 SHALL 直接放行；等于上限时 SHALL 在"不在回合中"的进程里选最近活动时刻最早者（相同时刻取准入次序更早者），对其执行既有 retire 序列（stdin→SIGTERM 5000ms→SIGKILL 8000ms）并等待其 shutdown 完成后放行；无任何不在回合中的进程 SHALL 抛 `HttpError("agent_capacity")`，不 spawn、不排队、不等待。被驱逐会话的数据 SHALL 不丢：其 `omp_session_file` 保留，下次 prompt 以 `--resume` 重起并按既有 `stream_epoch+1` 语义开启新 generation，SSE 订阅者按既有规则收到 `replay.gap`。准入被 `agent_capacity` 拒绝时 SHALL 无任何持久化副作用：prompt 路径经既有 `rollbackPrompt` 补偿受理对；regenerate 路径不改动任何行。

#### Scenario: 驱逐最久空闲者
- **WHEN** `OMP_MAX_PROCESSES=2`，会话 A、B 各完成一回合（均不在回合中），A 的最近活动早于 B，随后会话 C 发 prompt
- **THEN** A 的子进程被 retire 且 C 在 A 退出后才 spawn；B 的进程不受影响；C 返回 202；A 再次 prompt 时以 `--resume <A 的 omp_session_file>` 重 spawn 并 202，历史完整

#### Scenario: 全部在回合中
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 回合进行中（或挂起审批中），会话 B 发 prompt
- **THEN** B 返回 503 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}`，`Cache-Control: no-store`；B 的消息表行数不变、状态仍为原终态；A 的进程未被发送任何信号；A 回合结束后 B 再次 prompt 可驱逐 A 并 202

#### Scenario: 并发准入不越界
- **WHEN** `OMP_MAX_PROCESSES=1` 且当前无活进程，两个会话同时发 prompt
- **THEN** 恰一个 spawn 成功并 202，另一个要么在前者进入回合后收到 503 `agent_capacity`，要么在前者回合结束后驱逐它再 202；任一时刻子进程数不超过 1，不出现两个子进程

#### Scenario: 驱逐中的进程不会被重复选中
- **WHEN** 一次准入正在等待被驱逐进程的 shutdown 完成，另一次准入到达
- **THEN** 后者等待前者的临界区结束后再判定，不得把同一进程再次选为驱逐目标，也不得在前者登记名额前 spawn

#### Scenario: 空闲回收进行中到达的 prompt 仍经准入
- **WHEN** 会话 A 的进程已开始空闲回收但尚未退出时，A 的下一个 prompt 到达
- **THEN** 该 prompt 不复用正在退出的进程所属 slot 另起子进程，而是在该进程退出、名额释放后作为一次新准入按上限规则判定；准入放行时以 `--resume` 起新进程并 202，`stream_epoch` 恰 +1
