# Spec delta: omp-pool（#469 fork 先退回源会话进程的 REST 201）

> 只含本 issue（父 tasks 5.2b）交付的部分。「串行化准入与最久空闲驱逐」取父 delta 同名块逐字：与主 spec（#466 推进后）相比，只有 Scenario「fork 先退回源会话进程」的「fork 兑现」改为父文「fork 201」。这是 #466 归档时注明「REST 201 → #469」的那一处（fork-session omp-pool delta 引注）。本刀之后整块交付，归档时父块须与推进后的主 spec 逐字一致。

## MODIFIED Requirements

### Requirement: 串行化准入与最久空闲驱逐
所有会 spawn 新进程的路径（prompt 懒 spawn / resume、regenerate 取得会话进程、fork 临时进程）SHALL 经同一准入点（`sessions/pool.ts` 的进程池准入），准入 SHALL 串行化：一次准入的"判定→（驱逐）→登记名额"在同一临界区内完成，两次并发准入不得同时越过上限。判定规则：活进程数 < 上限 SHALL 直接放行；等于上限时 SHALL 在"不在回合中"的进程里选最近活动时刻最早者（相同时刻取准入次序更早者），对其执行既有 retire 序列（stdin→SIGTERM 5000ms→SIGKILL 8000ms）并等待其 shutdown 完成后放行；无任何不在回合中的进程 SHALL 抛 `HttpError("agent_capacity")`，不 spawn、不排队、不等待。fork 路径 SHALL 在为临时进程进入该准入点之前，对源会话存活且无活跃回合的进程（源会话必非 running，否则 fork 已 409；它此时虽因源会话持有控制占用而不可被驱逐，仍由 fork 路径自身显式 retire）执行既有 retire 并等待其退出；该进程退出即释放名额，此后 SHALL 不再计入活进程集合，也不作为临时进程准入判定中的"其它活进程"（源会话持有控制占用期间不会被再次 spawn）。被驱逐会话的数据 SHALL 不丢：其 `omp_session_file` 保留，下次 prompt 以 `--resume` 重起并按既有 `stream_epoch+1` 语义开启新 generation，SSE 订阅者按既有规则收到 `replay.gap`。准入被 `agent_capacity` 拒绝时 SHALL 无任何持久化副作用：prompt 路径经既有 `rollbackPrompt` 补偿受理对；regenerate 路径不改动任何行；fork 路径不留下新会话行。

#### Scenario: 驱逐最久空闲者
- **WHEN** `OMP_MAX_PROCESSES=2`，会话 A、B 各完成一回合（均不在回合中），A 的最近活动早于 B，随后会话 C 发 prompt
- **THEN** A 的子进程被 retire 且 C 在 A 退出后才 spawn；B 的进程不受影响；C 返回 202；A 再次 prompt 时以 `--resume <A 的 omp_session_file>` 重 spawn 并 202，历史完整

#### Scenario: 全部在回合中
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 回合进行中（或挂起审批中），会话 B 发 prompt
- **THEN** B 返回 503 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}`，`Cache-Control: no-store`；B 的消息表行数不变、状态仍为原终态；A 的进程未被发送任何信号；A 回合结束后 B 再次 prompt 可驱逐 A 并 202

#### Scenario: 并发准入不越界
- **WHEN** `OMP_MAX_PROCESSES=1` 且当前无活进程，两个会话同时发 prompt
- **THEN** 恰一个 spawn 成功并 202，另一个要么在前者进入回合后收到 503 `agent_capacity`，要么在前者回合结束后驱逐它再 202；任一时刻子进程数不超过 1，不出现两个子进程

#### Scenario: fork 先退回源会话进程
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 完成回合且其进程仍存活，对 A 的用户消息 fork
- **THEN** A 的进程先经 retire 退出，临时进程随后准入并 spawn；fork 201；以真实子进程观察任一时刻活 omp 子进程数 ≤1；无 503、无其它会话被驱逐

#### Scenario: 驱逐中的进程不会被重复选中
- **WHEN** 一次准入正在等待被驱逐进程的 shutdown 完成，另一次准入到达
- **THEN** 后者等待前者的临界区结束后再判定，不得把同一进程再次选为驱逐目标，也不得在前者登记名额前 spawn

#### Scenario: 空闲回收进行中到达的 prompt 仍经准入
- **WHEN** 会话 A 的进程已开始空闲回收但尚未退出时，A 的下一个 prompt 到达
- **THEN** 该 prompt 不复用正在退出的进程所属 slot 另起子进程，而是在该进程退出、名额释放后作为一次新准入按上限规则判定；准入放行时以 `--resume` 起新进程并 202，`stream_epoch` 恰 +1
