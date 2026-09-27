# Spec delta: omp-pool（#463 串行准入、最久空闲驱逐与进程退出释放名额）

> 父 delta 三个 ADDED 块由多个 issue 分担，主 spec 尚无，故本 delta 为 ADDED 且只含本 issue（4.1）交付的部分；被裁掉的 Scenario 保留父标题待后续刀原位补回。
> - 「活进程集合与上限不变量」：裁掉进程来源枚举（regenerate 会话进程 → #465，fork 临时进程 → #466）与「或所属会话持有控制占用」子句（随首个登记控制占用的刀 #473/#465/#466 补回）；「最近活动时刻」括注按本刀可交付的刷新源改写（proposal 偏离 3）。Scenario「临时进程计入上限」→ #466，「控制占用期间不可驱逐」→ #465，未收录；「上限恒成立」裁为只含 prompt，保留父标题。
> - 「串行化准入与最久空闲驱逐」：准入点由父文 `#admitProcess` 改述为 `sessions/pool.ts` 进程池准入（proposal 偏离 1）；路径枚举改为「含 prompt 懒 spawn / resume」；fork 先退回源会话进程一段与 regenerate/fork 的拒绝副作用 → #465/#466；Scenario「fork 先退回源会话进程」→ #466，未收录。Scenario「空闲回收进行中到达的 prompt 仍经准入」为本 issue 自写（proposal 偏离 6），归档时父 delta 须补。
> - 「进程退出即释放名额」：slot 删除时点按实现改述（同步释放名额，slot 经既有退役路径删除，proposal 偏离 4）；「执行该准入的路径」去掉「（prompt、regenerate 或 fork）」枚举，待 #465/#466 原位补回。

## ADDED Requirements

### Requirement: 活进程集合与上限不变量
supervisor SHALL 维护"活进程集合"：每个已 spawn 且尚未退出的 omp 子进程恰占一个名额。任一时刻活进程数 SHALL ≤ `OMP_MAX_PROCESSES`。集合中每个进程 SHALL 记录最近活动时刻（该进程受理 prompt、其回合帧到达或回合结束即刷新）与是否"在回合中"；回合中定义为：该进程已受理 prompt 且尚未收到终止 `agent_end`（含挂起审批期间）。回合中的进程 SHALL 永不成为驱逐候选。

#### Scenario: 上限恒成立
- **WHEN** 以 `OMP_MAX_PROCESSES=2` 并发对 4 个会话发 prompt
- **THEN** 以真实子进程观察，任一时刻活 omp 子进程数 ≤2；每个 503 响应都对应"活进程数 ==2 且全部在回合中"的时刻

### Requirement: 串行化准入与最久空闲驱逐
所有会 spawn 新进程的路径（含 prompt 懒 spawn / resume）SHALL 经同一准入点（`sessions/pool.ts` 的进程池准入），准入 SHALL 串行化：一次准入的"判定→（驱逐）→登记名额"在同一临界区内完成，两次并发准入不得同时越过上限。判定规则：活进程数 < 上限 SHALL 直接放行；等于上限时 SHALL 在"不在回合中"的进程里选最近活动时刻最早者（相同时刻取准入次序更早者），对其执行既有 retire 序列（stdin→SIGTERM 5000ms→SIGKILL 8000ms）并等待其 shutdown 完成后放行；无任何不在回合中的进程 SHALL 抛 `HttpError("agent_capacity")`，不 spawn、不排队、不等待。被驱逐会话的数据 SHALL 不丢：其 `omp_session_file` 保留，下次 prompt 以 `--resume` 重起并按既有 `stream_epoch+1` 语义开启新 generation，SSE 订阅者按既有规则收到 `replay.gap`。准入被 `agent_capacity` 拒绝时 SHALL 无任何持久化副作用：prompt 路径经既有 `rollbackPrompt` 补偿受理对。

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

### Requirement: 进程退出即释放名额
runtime SHALL 向 supervisor 接线 `onExit`：子进程因任何原因退出（空闲回收、回合中崩溃、驱逐、关停、已取得 pid 后的启动失败）时，supervisor SHALL 同步把它从活进程集合移除以释放名额；该会话的 slot 登记随后经既有 retire 路径删除（回合中退出时待该回合按既有规则收尾之后），且仅当该 slot 仍是该会话当前登记（generation 身份一致）时才删除——过期 generation 的退出不得删除替换后的 slot，但其名额释放不受此限；准入已登记名额而 spawn 或握手失败、且该子进程从未取得 pid 时（runtime 对此类 generation 不调用 `onExit`），SHALL 由执行该准入的路径在失败返回前同步释放该名额并删除对应登记，不依赖任何退出回调。下一次该会话 prompt SHALL 作为新准入进入准入点（而非复用已死 slot），从而按上限规则重新判定。名额释放 SHALL 与 chat-stream 既有 generation ring 的排空/封口相互独立：进程退出立即释放名额，ring 仍按既有语义等待残留发布排空后才封口。

#### Scenario: 空闲回收后 slot 不泄漏
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 完成回合后经 `OMP_IDLE_MS` 空闲回收（注入时钟），随后会话 B 发 prompt
- **THEN** B 无需驱逐即 spawn 并 202；supervisor 的 slot 表不含 A；A 再次 prompt 时经准入点驱逐 B 后以 `--resume` 重起

#### Scenario: 无 pid 启动失败释放名额
- **WHEN** `OMP_MAX_PROCESSES=1`，`OMP_BIN` 指向不存在的路径使 spawn 报 `ENOENT`，同一或不同会话连续两次 prompt，随后换为有效 bin 再发第三次 prompt
- **THEN** 前两次均 502 `agent_unavailable` 且活进程集合为空、无残留登记；第三次无需驱逐即 spawn 并 202

#### Scenario: 崩溃与关停释放
- **WHEN** 会话 A 的子进程在回合中被外部 kill，或 supervisor 整体关停
- **THEN** 该进程退出后立即从活进程集合移除，A 的回合按既有规则以 `failed` 收尾；关停后活进程集合为空且不留任何 slot
