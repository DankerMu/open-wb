# Spec: omp-pool

## Purpose
定义 omp 子进程的全局数量治理：`OMP_MAX_PROCESSES` 硬上限、串行化准入、最久空闲驱逐、`agent_capacity` 拒绝，以及任何原因的进程退出即释放名额（修复空闲回收后的 slot 泄漏）。

## MODIFIED Requirements

### Requirement: agent_capacity 错误码
`core/errors` 定义映射 SHALL 新增 `agent_capacity`(503, `Agent 容量已满，请稍后重试`)，随 `approval_settled` 一并把 typed 错误码由十一码扩为十三码；HTTP 映射器、既有"意外错误不伪装"与 no-store 路由归属规则对新码同样成立。

#### Scenario: 信封形状
- **WHEN** 路由抛出 `HttpError("agent_capacity")`
- **THEN** 响应 503，body 恰为 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}`，无 Fastify 默认字段；伪造 `statusCode:503` 的普通 Error 仍为 generic 5xx

## ADDED Requirements

### Requirement: OMP_MAX_PROCESSES 配置
应用配置 SHALL 新增可选键 `OMP_MAX_PROCESSES`，缺省值 `16`。其解析纪律 SHALL 与 `OMP_IDLE_MS` 完全一致：只接受 canonical ASCII decimal 正整数 `1..2147483647`（无符号、无空白、无小数/指数、除 `0` 外无前导零），非法或超限值 SHALL 在任何 filesystem/database/listen 副作用前使启动失败，配置错误消息 SHALL 命名 `OMP_MAX_PROCESSES` 而不含输入值。该值 SHALL 经 `agent-config` 同一纯解析器进入 supervisor，不得由 supervisor 直接读 `process.env`。

#### Scenario: 缺省与覆盖
- **WHEN** 未设置 `OMP_MAX_PROCESSES` 启动，或设置为 `1`、`2`、`2147483647`
- **THEN** supervisor 的上限分别为 16、1、2、2147483647，其它十二项配置行为不变

#### Scenario: 非法值启动失败
- **WHEN** `OMP_MAX_PROCESSES` 为空串、`0`、`abc`、`-1`、`1.5`、`+3`、`016`、` 8`、`2147483648`
- **THEN** 启动 nonzero，stderr 恰一行既有 generic failure record，错误命名该键且不含输入值，无任何 filesystem/database/listen 副作用

### Requirement: 活进程集合与上限不变量
supervisor SHALL 维护"活进程集合"：每个已 spawn 且尚未退出的 omp 子进程恰占一个名额，无论它是会话 slot 的常驻进程、regenerate 复用/新起的会话进程，还是 fork 的临时进程。任一时刻活进程数 SHALL ≤ `OMP_MAX_PROCESSES`。集合中每个进程 SHALL 记录最近活动时刻（与 runtime 空闲计时器同源：子进程帧到达或 prompt 受理即刷新）与是否"在回合中"；回合中定义为：该进程已受理 prompt 且尚未收到终止 `agent_end`（含挂起审批期间），**或**该进程所属会话（fork 临时进程则为其源会话）持有 turn-control 定义的控制占用——自 regenerate/fork/stop 预检通过起、至派发完成或响应返回止，覆盖各次 `get_branch_messages`/`branch`/`get_state` 请求之间的间隙。回合中的进程 SHALL 永不成为驱逐候选。

#### Scenario: 临时进程计入上限
- **WHEN** `OMP_MAX_PROCESSES=1`，某会话的 fork 临时进程正在执行 `branch`
- **THEN** 同一时刻另一会话的 prompt 准入不得再 spawn：若无可驱逐者则 503 `agent_capacity`；临时进程关停后该 prompt 可以 202

#### Scenario: 控制占用期间不可驱逐
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 的 regenerate 已取得进程并收到 `get_branch_messages` 应答、尚未发出 `branch`（此刻无回合），会话 B 发 prompt
- **THEN** B 返回 503 `agent_capacity`，A 的进程未收到任何信号，A 的 regenerate 照常完成；A 回合结束后 B 再次 prompt 可驱逐 A 并 202

#### Scenario: 上限恒成立
- **WHEN** 以 `OMP_MAX_PROCESSES=2` 并发对 4 个会话发 prompt、regenerate 与 fork
- **THEN** 以真实子进程观察，任一时刻活 omp 子进程数 ≤2；每个 503 响应都对应"活进程数 ==2 且全部在回合中"的时刻

### Requirement: 串行化准入与最久空闲驱逐
所有会 spawn 新进程的路径（prompt 懒 spawn / resume、regenerate 取得会话进程、fork 临时进程）SHALL 经同一准入点 `#admitProcess`，准入 SHALL 串行化：一次准入的"判定→（驱逐）→登记名额"在同一临界区内完成，两次并发准入不得同时越过上限。判定规则：活进程数 < 上限 SHALL 直接放行；等于上限时 SHALL 在"不在回合中"的进程里选最近活动时刻最早者（相同时刻取准入次序更早者），对其执行既有 retire 序列（stdin→SIGTERM 5000ms→SIGKILL 8000ms）并等待其 shutdown 完成后放行；无任何不在回合中的进程 SHALL 抛 `HttpError("agent_capacity")`，不 spawn、不排队、不等待。fork 路径 SHALL 在为临时进程进入 `#admitProcess` 之前，对源会话存活且无活跃回合的进程（源会话必非 running，否则 fork 已 409；它此时虽因源会话持有控制占用而不可被驱逐，仍由 fork 路径自身显式 retire）执行既有 retire 并等待其退出；该进程退出即释放名额，此后 SHALL 不再计入活进程集合，也不作为临时进程准入判定中的"其它活进程"（源会话持有控制占用期间不会被再次 spawn）。被驱逐会话的数据 SHALL 不丢：其 `omp_session_file` 保留，下次 prompt 以 `--resume` 重起并按既有 `stream_epoch+1` 语义开启新 generation，SSE 订阅者按既有规则收到 `replay.gap`。准入被 `agent_capacity` 拒绝时 SHALL 无任何持久化副作用：prompt 路径经既有 `rollbackPrompt` 补偿受理对；regenerate 路径不改动任何行；fork 路径删除已建的新会话行。

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

### Requirement: 进程退出即释放名额
runtime SHALL 向 supervisor 接线 `onExit`：子进程因任何原因退出（空闲回收、回合中崩溃、驱逐、关停、已取得 pid 后的启动失败）时，supervisor SHALL 同步把它从活进程集合移除，并仅当该 slot 仍是该会话当前登记（generation 身份一致）时删除 slot 登记——过期 generation 的退出回调不得删除替换后的 slot，但其名额释放不受此限；准入已登记名额而 spawn 或握手失败、且该子进程从未取得 pid 时（runtime 对此类 generation 不调用 `onExit`），SHALL 由执行该准入的路径（prompt、regenerate 或 fork）在失败返回前同步释放该名额并删除对应登记，不依赖任何退出回调。下一次该会话 prompt SHALL 作为新准入进入 `#admitProcess`（而非复用已死 slot），从而按上限规则重新判定。名额释放 SHALL 与 chat-stream 既有 generation ring 的排空/封口相互独立：进程退出立即释放名额，ring 仍按既有语义等待残留发布排空后才封口。

#### Scenario: 空闲回收后 slot 不泄漏
- **WHEN** `OMP_MAX_PROCESSES=1`，会话 A 完成回合后经 `OMP_IDLE_MS` 空闲回收（注入时钟），随后会话 B 发 prompt
- **THEN** B 无需驱逐即 spawn 并 202；supervisor 的 slot 表不含 A；A 再次 prompt 时经准入点驱逐 B 后以 `--resume` 重起

#### Scenario: 无 pid 启动失败释放名额
- **WHEN** `OMP_MAX_PROCESSES=1`，`OMP_BIN` 指向不存在的路径使 spawn 报 `ENOENT`，同一或不同会话连续两次 prompt，随后换为有效 bin 再发第三次 prompt
- **THEN** 前两次均 502 `agent_unavailable` 且活进程集合为空、无残留登记；第三次无需驱逐即 spawn 并 202

#### Scenario: 崩溃与关停释放
- **WHEN** 会话 A 的子进程在回合中被外部 kill，或 supervisor 整体关停
- **THEN** 该进程退出后立即从活进程集合移除，A 的回合按既有规则以 `failed` 收尾；关停后活进程集合为空且不留任何 slot

