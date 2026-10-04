## MODIFIED Requirements

### Requirement: web 审批条
web SHALL 把审批分两处呈现：待决审批是 composer 上方停靠区里的提问卡，已结算审批是其所属 assistant 消息内的记录。web 只使用快照与事件归约出的 `approvals`（`tool` 字段即工具名，web 不再解析 `title`）；assistant-ui 工具调用 part 的 `approval` 字段与 `onRespondToToolApproval` SHALL NOT 使用（审批与步骤之间没有关联键，且工具调用组默认收起）。

**提问卡**：选中会话全部消息中 `decision:null` 的审批 SHALL 各渲染一张提问卡，跨消息按审批 `id` 升序纵向叠放在 composer 正上方的停靠区内（停靠区不随消息线程滚动；同一停靠区内任务清单面板在其上方，见 session-todo）；助手消息内 SHALL NOT 渲染待决审批。每张卡是独立的 `role="group"`，accessible name 为 `需要你的确认`，内容为：工具名徽章（`tool` 字段）；`title` **全文**，以 `white-space: pre-wrap` 保留换行；由 `expiresAt` 与注入时钟计算的单句倒计时 `（<n>s 内未操作将自动允许）`，`<n>` 为剩余整秒并随时间递减（初值 60），卡内无其它倒计时元素；按钮 `允许` / `拒绝`。点击按钮 SHALL 以该卡自己的审批 `id` 调用一次 `decideApproval(sessionId, approvalId, "allow"|"deny")`，该卡的两个按钮立即禁用，其它卡不受影响。409 `approval_settled` SHALL NOT 显示任何错误（无 Toast、composer 无内联错误），以随后到达的 `approval.resolved` 或权威快照为准。`approval.resolved` 到达或快照显示该审批已结算后，对应提问卡 SHALL 消失。

**已结算记录**：`decision` 非 null 的审批 SHALL 在其所属 assistant 消息内各渲染一条记录（位置见 chat-web `消息线程` 的助手块次序），同一消息的多条按 `id` 升序排列。每条是 `role="group"`，accessible name 按 `decision`：`allow` → `已允许执行`，`deny` → `已拒绝执行`，`timeout` → `超时自动允许`；显示工具名徽章与 `title` 全文（`white-space: pre-wrap`），无按钮、无倒计时。`approvals` 为 `[]` 的消息不渲染记录。

只要选中会话存在待决审批，回合即仍在进行：composer SHALL 保持锁定且 `停止` 可用。重新加载后，快照中的待决审批 SHALL 恢复为提问卡（倒计时从 `expiresAt` 起算，可继续作答），已结算审批恢复为消息内记录。

#### Scenario: 提问卡挂起、允许与拒绝
- **WHEN** running 助手消息收到 `approval.request{approvalId, tool:"bash", title:"Allow tool: bash\nReason: run ls", expiresAt: now+60s}`
- **THEN** composer 上方停靠区出现一张名为 `需要你的确认` 的提问卡：工具名徽章为 `bash`，正文为 title 全文（两行均在，换行按 `white-space: pre-wrap` 保留），倒计时句为 `（60s 内未操作将自动允许）` 且随注入时钟推进 1s 后变为 `（59s 内未操作将自动允许）`，卡内无其它倒计时元素，按钮 `允许`/`拒绝` 可用；该助手消息内没有名为 `需要你的确认` 的元素；composer 仍锁定且 `停止` 可用
- **WHEN** 点击 `允许`，服务端 200，随后收到 `approval.resolved{decision:"allow"}`
- **THEN** `decideApproval(sessionId, approvalId, "allow")` 恰调用一次，该卡两按钮立即禁用；resolved 到达后停靠区不再有该提问卡，所属助手消息内出现名为 `已允许执行` 的记录，含工具名徽章 `bash` 与 title 全文，无按钮无倒计时句
- **WHEN** 另一条挂起审批点击 `拒绝` 并收到 `approval.resolved{decision:"deny"}`
- **THEN** 提问卡消失，所属助手消息内出现名为 `已拒绝执行` 的记录
- **WHEN** 点击 `允许` 时服务端返回 409 `approval_settled`，随后权威快照中该审批 `decision:"timeout"`
- **THEN** 无 Toast、composer 无内联错误、页面无新增 `role="alert"`；提问卡消失，所属助手消息内出现名为 `超时自动允许` 的记录

#### Scenario: 超时与拒绝的记录文案
- **WHEN** 待决审批收到 `approval.resolved{decision:"timeout"}`；另一条收到 `{decision:"deny"}`
- **THEN** 两张提问卡消失；所属助手消息内分别出现名为 `超时自动允许` 与 `已拒绝执行` 的记录，均无按钮与倒计时句

#### Scenario: 两条并行审批分别作答
- **WHEN** running 助手消息先后收到 `approval.request{approvalId:7, tool:"bash"}` 与 `approval.request{approvalId:8, tool:"bash"}`（均 pending），用户先点 id 8 提问卡的 `拒绝`、再点 id 7 提问卡的 `允许`，服务端各返回 200，随后依次收到 `approval.resolved{approvalId:8, decision:"deny"}` 与 `approval.resolved{approvalId:7, decision:"allow"}`
- **THEN** 停靠区按文档顺序纵向叠放两张名为 `需要你的确认` 的提问卡（第一张为 id 7、第二张为 id 8），第二个 request 未替换第一张；点 id 8 的 `拒绝` 只以 `decideApproval(sessionId, 8, "deny")` 调用一次并只禁用 id 8 的两按钮，id 7 的按钮仍可用、倒计时句仍在；id 8 resolved 后停靠区只剩 id 7 的提问卡，助手消息内出现一条 `已拒绝执行` 记录，composer 仍锁定；id 7 作答并 resolved 后停靠区没有提问卡，助手消息内按 id 升序为 `已允许执行`、`已拒绝执行` 两条记录，均无按钮

#### Scenario: 待决审批跨消息按 id 叠放
- **WHEN** 选中会话的快照里两条不同的助手消息各有一条 `decision:null` 的审批，`id` 分别为 12 与 9
- **THEN** 停靠区恰有两张提问卡，按文档顺序先为 id 9、后为 id 12；两条助手消息内都没有待决审批的元素

#### Scenario: 刷新后审批状态保留
- **WHEN** 以 `/?session=<id>` 重新加载：快照中一条助手消息 `approvals` 含一条 pending 且 `expiresAt` 距今 40s，另一次加载中一条助手消息的审批 `decision` 为 `timeout`、另一条助手消息的为 `deny`、还有一条为 `allow`
- **THEN** pending 加载后停靠区有名为 `需要你的确认` 的提问卡，倒计时句为 `（40s 内未操作将自动允许）`，按钮可点并能作答，composer 锁定且 `停止` 可用；`timeout`、`deny`、`allow` 分别在各自助手消息内渲染为名为 `超时自动允许`、`已拒绝执行`、`已允许执行` 的记录，均无按钮与倒计时句，停靠区没有它们的提问卡；`approvals` 为 `[]` 的助手消息不渲染记录
