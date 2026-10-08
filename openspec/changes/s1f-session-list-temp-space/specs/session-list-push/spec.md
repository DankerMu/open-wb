## ADDED Requirements

### Requirement: 列表事件端点
服务端 SHALL 提供 `GET /api/sessions/events`：受既有 cookie guard 保护（未认证 401 统一信封，不建立流），已认证时以 SSE 响应，响应头与单会话事件流相同（`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-store`、`Connection: keep-alive`），状态 200，连接保持到客户端断开或服务关停。该路由 SHALL 是静态路径，不被 `/api/sessions/:id/...` 的任何路由匹配，也不读取 body、不属于 content-parser 归属集。流上只有两种事件，均不带 `id:` 行：
- `event: sessions.changed`，`data: {}`；
- `event: session.rewound`，`data: {"sessionId":"<32 位小写十六进制>"}`。

服务端 SHALL NOT 为该端点保留事件环、序号或任何回放状态，SHALL 忽略请求的 `Last-Event-ID`；连接建立时不补发任何事件。空闲时 SHALL 每 15000 ms 写一行 SSE 注释作为心跳（与单会话事件流同一常量与注入时钟）。服务关停（`preClose`）时 SHALL 销毁全部列表事件连接；关停开始后到达的新连接 SHALL 以 502 `agent_unavailable` 结束并带 `Connection: close`（与单会话事件流相同）。同一账号可同时持有多条连接，每条独立。

#### Scenario: 建立连接与心跳
- **WHEN** 已认证的 `zhangsan` 以真实 HTTP 连接请求 `GET /api/sessions/events`，随后注入时钟推进 15000 ms
- **THEN** 响应状态 200，三个响应头逐字如上；建立后没有任何事件；推进后恰多出一行以 `:` 开头的注释行；连接仍打开

#### Scenario: 未认证与关停
- **WHEN** 匿名请求该端点；另一次在已有一条打开的连接时关闭服务
- **THEN** 前者 401 统一信封、`Content-Type` 为 JSON 而非事件流；后者该连接被销毁，关停开始后的新请求得到 502 `agent_unavailable`

#### Scenario: 不回放
- **WHEN** 一条连接收到两条 `sessions.changed` 后断开，客户端带 `Last-Event-ID: 1:5` 重新连接
- **THEN** 新连接建立后没有任何补发事件；事件块中没有 `id:` 行

### Requirement: 通知触发点
服务端 SHALL 维护一个进程内的按账号通知器。下列写入在其 SQLite 事务**提交之后**（或无事务的单条写入成功之后）SHALL 向该会话所有者的每条列表事件连接发出 `sessions.changed`；事务回滚或请求被拒绝（4xx/5xx 且无写入）时 SHALL NOT 发出：
- 会话创建（`POST /api/sessions`）、fork 提交（新会话出现）、会话删除提交；
- `PATCH /api/sessions/:id` 成功（标题、场景、置顶、归档任一）；
- prompt 受理（状态变为 `running`，标题可能被设置）与受理被补偿（`rollbackPrompt` 成功）；
- regenerate 的事务提交；回合终态落库（`done` / `failed` / `stopped`）；
- 审批行插入（出现待决确认）与审批结算（作答、超时、停止或终态的 `deny` 结算）；
- 临时空间转正（`POST /api/workspaces/:id/promote` 成功）与 `POST /api/workspaces` 成功（分组名来自工作空间列表）；
- 撤回提交（此时另发一条 `session.rewound`，`sessionId` 为被撤回的会话）。

启动对账不发通知（此时没有连接）。通知只发给该会话（或该工作空间）所有者的连接，SHALL NOT 发给其它账号。对同一条连接，已有一条 `sessions.changed` 尚未写出（底层写缓冲未排空）时 SHALL NOT 再排入第二条；`session.rewound` 不被合并。保证的是：一次已提交的上述变化之后，所有者的每条已建立连接最终收到至少一条在该提交之后写出的 `sessions.changed`。通知器的失败（某条连接写出错）SHALL 只关闭那条连接，不影响触发它的请求的响应，也不影响其它连接。

#### Scenario: 状态变化推送给所有者的每条连接
- **WHEN** `zhangsan` 持有两条列表事件连接、`lisi` 持有一条；`zhangsan` 在 fake omp 下发一条 prompt 直到回合结束
- **THEN** `zhangsan` 的两条连接各收到至少两条 `sessions.changed`（受理之后一条、终态之后一条），每条的 `data` 恰为 `{}`；`lisi` 的连接没有收到任何事件

#### Scenario: 待决确认的出现与结算
- **WHEN** fake omp `approval` 场景在回合中请求审批，随后所有者作答 `allow`
- **THEN** 审批行插入之后与结算之后各至少有一条 `sessions.changed` 到达；两次之后分别读取 `GET /api/sessions`，该会话的 `pendingApproval` 依次为 `true`、`false`

#### Scenario: 每个触发点各自通知
- **WHEN** 所有者持有一条列表事件连接，依次执行下列每一项写入，每项之前先读空连接上已到的事件：`POST /api/sessions` 创建会话；`PATCH` 改标题；`PATCH {archived:true}` 与 `{archived:false}`；一次 prompt 受理（fake omp 挂起，回合未结束）；让该回合结束；一次被 supervisor 以 `agent_unavailable` 拒绝而被补偿的 prompt；一次 regenerate 提交；一次 fork 提交；`POST /api/workspaces` 创建工作空间；对一个临时空间 `POST …/promote`；`DELETE` 一个会话
- **THEN** 每一项之后连接上都恰多出至少一条 `sessions.changed`（逐项断言，不合并成总数）；其间没有任何 `session.rewound`

#### Scenario: 被拒绝的写入不通知
- **WHEN** 所有者对 `running` 的会话 PATCH `{archived:true}`（409）、以非法 body PATCH（400）、对不存在的会话 DELETE（404）
- **THEN** 三次之后连接上都没有新事件

#### Scenario: 撤回发两种事件
- **WHEN** 所有者成功撤回会话 S 的一条用户消息
- **THEN** 连接上在该请求返回之前或之后恰收到一条 `session.rewound`，其 `data` 为 `{"sessionId":"<S 的 id>"}`，并至少一条 `sessions.changed`

#### Scenario: 一条连接写失败不影响请求
- **WHEN** 一条列表事件连接的底层套接字已被对端重置，此时所有者 PATCH `{pinned:true}`
- **THEN** PATCH 返回 200；该连接被关闭；所有者的另一条连接照常收到 `sessions.changed`

### Requirement: web 列表事件消费
会话页 SHALL 在挂载且已认证期间持有恰一条到 `GET /api/sessions/events` 的 `EventSource`（same-origin，带凭证）；账号切换、退出登录成功与页面卸载时 SHALL 关闭它，其后到达的事件 SHALL 被丢弃。对齐规则：
- 连接每次进入打开状态（首次与每次自动重连）SHALL 触发一次会话列表读取（与既有列表读取同一路径：并行读取 `GET /api/workspaces`）；
- 连接**再次**进入打开状态（自动重连，不含首次）时，断开期间的 `session.rewound` 已经丢失（不回放），所以若此刻有选中会话、该会话在页面视图里不是 `running`、且本页此刻没有针对该会话的在途撤回请求，SHALL 另外重读一次该会话的消息快照并整体替换视图（与下一条同一路径）；选中会话为 `running` 时不读（它的单会话事件流自己负责对齐）；
- 每收到一条 `sessions.changed` SHALL 触发一次列表读取；读取在途时到达的通知 SHALL 只登记「还需再读一次」，在途读取结束后恰再读一次（单飞，不并发、不丢最后一次）；
- 收到 `session.rewound` 且其 `sessionId` 等于当前选中会话、而本页此刻没有针对该会话的在途撤回请求时，SHALL 重读该会话的消息快照并整体替换视图（与既有恢复快照同一路径）；`sessionId` 不是当前选中会话时不读消息；
- 「在途」自点击 `撤回` 起，到它的 200 之后的消息快照重读落定、或请求失败（含 409 `undo_conflict`）为止，按会话计：别的会话的在途撤回不影响当前选中会话的重读。在途期间因上两条而略过的重读，若这次撤回没有以「200 被本页应用」告终、且该会话此刻仍被选中，SHALL 在它落定时补读恰一次（与上一条同一路径）；200 被应用时不补读（其后的重读已经覆盖）；401 不补读；
- 事件的 `data` 不是合法 JSON、或 `session.rewound` 的 `sessionId` 不是 32 位小写十六进制时，SHALL 忽略该事件。

由通知触发的列表读取失败时 SHALL 保留当前列表、不显示错误（下一条通知或下一次打开会再读）；由页面挂载触发的首次读取沿用既有的加载与错误呈现。运行环境没有 `EventSource`、或连接进入终止的错误状态时，页面 SHALL NOT 显示任何错误：列表照常可用，页面自己发起的动作仍按既有规则更新或重取列表。列表事件连接 SHALL NOT 影响单会话事件流的建立、续流与关闭。

#### Scenario: 打开与通知触发重取
- **WHEN** 整页测试挂载会话页（假 `EventSource`），列表连接触发 `open`，随后派发一条 `sessions.changed`
- **THEN** 恰有一条指向 `/api/sessions/events` 的连接；`open` 之后与通知之后各发出一次 `GET /api/sessions` 与一次 `GET /api/workspaces`；第二次读取返回的状态变化（某会话变为 `running`）反映在侧栏

#### Scenario: 单飞与尾随重取
- **WHEN** 一次列表读取在途时连续派发三条 `sessions.changed`，随后在途读取返回
- **THEN** 在途期间没有新的列表请求；返回之后恰再发出一次列表读取

#### Scenario: 重连后重取
- **WHEN** 连接出错后再次触发 `open`
- **THEN** 再次发出一次列表读取；页面没有出现任何与列表连接有关的错误文案

#### Scenario: 重连补读所选会话
- **WHEN** 页面选中一个 `done` 会话 S 且历史已加载，列表连接出错后再次触发 `open`；另一例重连时 S 在页面视图里为 `running`；再一例是连接的首次 `open`
- **THEN** 第一例在列表读取之外恰发出一次 `GET /api/sessions/<S>/messages` 并以其结果替换线程（断开期间另一个标签页撤回过的消息不再显示）；后两例不因 `open` 发出消息读取

#### Scenario: 另一个标签页的撤回
- **WHEN** 页面选中会话 S 且历史已加载，收到 `session.rewound` `{"sessionId":"<S>"}`；另一次收到 `sessionId` 为别的会话
- **THEN** 前者恰发出一次 `GET /api/sessions/<S>/messages` 并以其结果替换线程；后者不发出消息读取

#### Scenario: 自己的撤回
- **WHEN** 选中会话 S，点击 `撤回` 后、响应到达前收到 `session.rewound` `{"sessionId":"<S>"}`，随后 undo 返回 200
- **THEN** 自点击起恰发出一次 `GET /api/sessions/<S>/messages`
- **WHEN** 同样收到该事件，随后 undo 以网络失败告终
- **THEN** 失败之前没有该读取；失败落定后恰发出一次，并以其结果替换线程
- **WHEN** S 的撤回在途时已切到会话 T，收到 `sessionId` 为 T 的 `session.rewound`
- **THEN** 恰发出一次 T 的消息读取

#### Scenario: 无 EventSource 时静默降级
- **WHEN** 运行环境没有全局 `EventSource`，挂载会话页并执行一次置顶
- **THEN** 页面没有错误文案；列表照常渲染；置顶成功后条目移入置顶区

#### Scenario: 卸载与换账号后关闭
- **WHEN** 页面卸载，或账号切换为另一个 Principal
- **THEN** 原连接被 `close()`；其后在原连接上派发的 `sessions.changed` 不触发任何请求
