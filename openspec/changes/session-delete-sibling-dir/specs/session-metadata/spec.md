## MODIFIED Requirements

### Requirement: 会话删除
`DELETE /api/sessions/:id` SHALL 受既有 cookie guard 与 owner 预检（未认证 401、不存在或属他人 404 `not_found`，先于任何 supervisor 调用），响应 no-store，成功为 204 无 body。该路由不读取 body、不属于 content-parser 归属集：携带的格式良好的 body 被忽略，不改变 204/404/409 行为；body 引发的 content-parser 错误按 http-service-skeleton「统一错误信封」的非归属已注册路由语义为通用 500，不执行任何删除步骤。执行 SHALL 同步完成以下序列，任一步失败即停止后续步骤：
1. 若该会话的控制占用正被 regenerate、fork、stop 或另一 DELETE 持有，SHALL 409 `session_busy`，无任何副作用；否则登记控制占用（chat-sessions「Supervisor dispatch and generation binding」），持有至本次调用结束，并在每一种结束路径（204、409、5xx、异常）上释放。持有期间同一会话的 prompt、regenerate、fork 与 DELETE SHALL 409 `session_busy`；stop 不受占用阻塞，按其自身规则返回 202/204。
2. 若会话 `status="running"`：SHALL 在本次 DELETE 已持有的控制占用之下（不重新登记、不释放）执行与 `POST /api/sessions/:id/stop` 相同的停止序列（挂起审批以 `deny` 结算 → `abort` 帧，或派发前登记停止意图），并同时记录该回合的「停止已在途」（turn-control「停止生成 REST」）：等待期间用户对同一回合的 stop 按 A 的规则返回 202 `{}`，不写第二帧 `abort`、不重复结算审批。随后 SHALL 等待以下两者之一出现，出现即进入第 3 步：
   - (a) 该回合终态落库（`turn.end` 已发布）。该等待由 A 的有界退回保证：`abort` 写出后 `OMP_ABORT_GRACE_MS`（8000 ms）内未见 `agent_end` 即 retire 并以 `stopped` 结算，retire 本身按既有 5000/8000 ms 升级。
   - (b) 该回合的受理被补偿：停止意图登记后 runtime 获取或派发失败（例如空间根缺失的 `agent_unavailable`、池满 `agent_capacity`、握手失败），prompt 请求按其无停止意图时相同的失败路径返回它自己的 502/503，受理对被移除、会话状态复原，停止意图随之丢弃且不写 `abort`；此时不会有 `turn.end`。该 prompt 的失败属于该 prompt 请求，不是本 DELETE 的步骤失败；会话此时已非 running、无存活 generation，DELETE 照常继续。
   获取要么成功派发后经 (a) 结束，要么失败经 (b) 结束，二者都在既有上界内出现，删除不另设计时器。
3. 调用 supervisor 公开的 `retire(sessionId)`：存活进程经既有有界 retire 序列退出（token 撤销、名额释放），该会话的 slot 与事件环丢弃，所有 SSE 订阅者的响应结束且不再收到事件。自本步开始至本次调用结束（删除墓碑期，含 retire 完成与第 4 步删行之间的窗口），已通过 owner 预检的新事件流订阅 SHALL 立即结束且不写任何事件；第 4 步失败时墓碑随控制占用一同解除，此后订阅恢复既有行为。
4. 单个 SQLite 事务：读取 `omp_session_file` 与该会话消息数，删除会话行——消息、步骤、审批随外键级联删除，以其为源的 fork 会话 `parent_session_id` 由外键置 NULL 且这些会话保留——并在同一事务写一条 `session.delete` 审计；审计失败则整个事务回滚。store SHALL 在删除时确认该会话无活跃回合/缓冲/步骤内存状态（此时应已结算；若仍存在视为不变量破坏，通用失败且不删除）。
5. 若第 4 步读到的 `omp_session_file` 非 NULL：该值由 omp 上报、写入时未经宿主校验，故宿主 SHALL 仅在它是绝对路径、其所在目录的 realpath 等于该会话所有者的 omp 会话目录（`<OMP_STATE_DIR>/sessions/<ownerId>`）的 realpath、该会话目录的 realpath 恰为 `<OMP_STATE_DIR 的 realpath>/sessions/<ownerId>`（`sessions` 与 `<ownerId>` 两级都不是符号链接——这两级对 omp uid 组可写，换成指向别处的符号链接后前一条比较两侧会一起解析到链接目标而恒等）、且它本身（`lstat`，不跟随符号链接）是普通文件时才 unlink；不满足任一条件 SHALL NOT unlink 任何路径，并经服务错误通道报告。`ENOENT`（校验或 unlink 时已不存在）视为成功；其它错误经服务错误通道报告。以上任何情况响应仍为 204（行已删除，残留文件不影响任何会话），错误通道自身的失败也不改变该响应。同名目录的处理条件 SHALL 为：该值是绝对路径、其所在目录的 realpath 等于 owner 会话目录的 realpath、其 basename 以 `.jsonl` 结尾且去掉后缀后的名字非空且不是 `.` 或 `..`，并且对它本身的 `lstat` 结果是普通文件（不论随后 unlink 成功、`ENOENT` 或失败）或 `ENOENT`（文件已不存在而同名目录可能仍在）。条件满足时，宿主 SHALL 在同一校验后的 owner 会话目录 realpath 下，对去掉 `.jsonl` 后缀的同名项（omp 为该会话建的产物目录，存放工具完整输出等）做 `lstat`：为目录（不跟随符号链接）则递归移除，递归过程不跟随目录内的符号链接；不存在视为成功；不是目录（含符号链接）则不移除任何东西并经服务错误通道报告；移除失败（含部分失败）经服务错误通道报告。其余情形（非绝对路径、所在目录不符或不存在、本身不是普通文件、去后缀后的名字为空或为 `.`/`..`）SHALL NOT 触碰任何同名项；名字不合法的情形经服务错误通道报告。以上情况响应仍为 204。regenerate/fork 产生的旧分支 `.jsonl` 及其同名目录不在清理范围内。以被删会话为源的 fork 会话不依赖该目录（omp 只在会话自己的同名目录里解析产物引用，fork 不复制也不回退到源目录）。
6. 返回 204。

第 2–4 步失败（例如终态落库或删除事务的存储错误）SHALL 返回通用 5xx，会话行保持存在（进程可能已被退役，下次 prompt 按既有 `--resume` 懒获取）。删除完成后该 id 的 `GET /api/sessions/:id/messages`、事件流订阅、PATCH、DELETE SHALL 与未知 id 相同地 404，`GET /api/sessions` 不再列出它；其它会话的进程、行与订阅不受影响。

#### Scenario: 删除空闲会话
- **WHEN** owner 删除一个 `done` 会话（两轮消息、含步骤与一条 `allow` 审批、存活 idle 进程、一个打开的 SSE 订阅、`omp_session_file` 指向已存在文件），另有一个以它为源的 fork 会话
- **THEN** 204 无 body；fake-omp 子进程已退出且订阅响应已结束；该会话的消息/步骤/审批行不复存在；`omp_session_file` 文件已被删除，其同名目录（含一个文件与一层嵌套子目录）也已不存在；fork 会话仍在 `GET /api/sessions` 中且其 `parent_session_id` 为 NULL；`GET /api/audit` 恰新增一条 `session.delete`，`detail.messageCount=4`、`detail.ompSessionFile` 为被删文件路径

#### Scenario: 删除运行中的会话先停止
- **WHEN** 回合进行中且有一条挂起审批时 owner 删除该会话，fake-omp 以 `abort-ok` 应答
- **THEN** 该审批先以 `deny` 结算（审计有 `session.approval decision=deny`），fake-omp 收到 `abort`，订阅者在响应结束前收到 `approval.resolved{decision:"deny"}` 与恰一个 `turn.end{status:"stopped"}`；之后子进程退出、行被删除、响应 204
- **WHEN** fake-omp 以 `abort-ignored` 忽略 `abort`，注入时钟推进过 8000 ms
- **THEN** 进程被退役、回合以 `stopped` 结算，DELETE 随后完成 204，无 `error` 事件
- **WHEN** fake-omp 以 `abort-ignored` 使 DELETE 停在等待终态，此时 owner 对同一会话 `POST …/stop`
- **THEN** stop 返回 202 `{}`；fake-omp 自始至终恰收到一帧 `abort`；注入时钟推进过 8000 ms 后 DELETE 完成 204

#### Scenario: 删除时停止意图遇获取失败
- **WHEN** 会话在 fake-omp `slow-ready` 下受理 prompt（仍在获取/握手、`abort()` 返回 false），owner 此时 DELETE 使停止意图被登记，随后测试注入的获取失败使该次派发不发生
- **THEN** prompt 返回其失败对应的 502/503，受理对被补偿、会话状态复原，fake-omp 未收到 `prompt` 或 `abort` 帧；DELETE 随后 204 且 `GET /api/audit` 恰新增一条 `session.delete`；此后该 id 的 DELETE、PATCH 与 `GET …/messages` 均为 404（而非 409 `session_busy`），无残留控制占用，其它会话的 prompt 照常 202

#### Scenario: 运行中删除的过渡拒绝
- **WHEN** 回合进行中（会话 `running`、进程存活、一个打开的 SSE 订阅）时 owner 删除该会话
- **THEN** 不再返回过渡期的 409 `session_busy`：该回合按「删除运行中的会话先停止」被停止，随后删除完成、响应 204（过渡拒绝已由第 2 步的停止路径取代）

#### Scenario: 删除墓碑期新订阅立即结束
- **WHEN** DELETE 已完成第 3 步 retire、第 4 步删除事务尚未执行时，测试在该窗口内以同一 owner 对该会话发起新的 `GET /api/sessions/:id/events`
- **THEN** 该订阅响应立即结束且不含任何事件；DELETE 完成 204 后同一订阅请求为 404
- **WHEN** 同一窗口内发起新订阅，而随后测试令删除事务中的审计写入失败
- **THEN** 窗口内的订阅仍立即结束且无事件；DELETE 为通用 5xx，此后对该会话的新订阅正常建立（不立即结束）

#### Scenario: 删除期间的并发请求
- **WHEN** DELETE 正在等待被停止回合终态时，对同一会话发 prompt、regenerate、fork 与第二个 DELETE
- **THEN** 四者均 409 `session_busy`，无行变化、无帧；原 DELETE 完成 204；此后对该 id 的 DELETE 返回 404
- **WHEN** 同一会话的 regenerate 或 fork 正持有控制占用时发 DELETE
- **THEN** 409 `session_busy`，会话与进程不变

#### Scenario: 会话文件缺失与从未派发
- **WHEN** owner 删除 `omp_session_file` 指向的文件已不存在的会话，以及一个从未 prompt 过（`omp_session_file` 为 NULL、无进程）的会话
- **THEN** 两者均 204、行被删除、审计各一条（后者 `ompSessionFile=null`、`messageCount=0`），无错误报告

#### Scenario: 会话文件路径不在所有者会话目录内
- **WHEN** 被删会话的 `omp_session_file` 分别为所有者会话目录之外的一个已存在文件、一个相对路径、会话目录内指向目录外文件的符号链接
- **THEN** 三者均 204、行被删除、审计各一条；目录外文件、符号链接及其目标都仍存在；每次经服务错误通道恰报告一次

#### Scenario: 删除事务失败保留会话
- **WHEN** 测试令删除事务中的审计写入失败
- **THEN** 响应为通用 5xx；会话、消息、步骤、审批行与 `omp_session_file` 文件都保留；控制占用已释放，随后对该会话的 prompt 可 202

#### Scenario: 删除的鉴权
- **WHEN** 匿名请求、他人会话、不存在会话调用 DELETE
- **THEN** 分别 401、404、404（后两者一致），无 supervisor 调用、无进程变化、无写入

#### Scenario: 同名目录的边界情形
- **WHEN** 被删会话的 `omp_session_file` 合法存在，而其同名项是一个指向 owner 会话目录之外某目录的符号链接
- **THEN** 204；`.jsonl` 已删除；该符号链接及其目标目录的内容原样保留；服务错误通道恰收到一条报告
- **WHEN** 同名项不存在
- **THEN** 204，错误通道无报告
- **WHEN** `omp_session_file` 未通过校验（不在 owner 会话目录内，或不是普通文件）
- **THEN** 204；owner 会话目录内的同名项不被触碰（仍存在）
- **WHEN** `omp_session_file` 指向的 `.jsonl` 已不存在，而 owner 会话目录内的同名目录仍在
- **THEN** 204；同名目录已被移除；错误通道无报告
- **WHEN** `omp_session_file` 是 owner 会话目录内名为 `..jsonl` 或 `...jsonl` 的普通文件（去后缀后为 `.` 或 `..`）
- **THEN** 204；该文件按既有规则 unlink；owner 会话目录、其上级目录及其中的其它文件原样保留；错误通道收到一条报告
- **WHEN** 同名目录的递归移除失败（注入）
- **THEN** 204；会话行已删除；错误通道收到报告
