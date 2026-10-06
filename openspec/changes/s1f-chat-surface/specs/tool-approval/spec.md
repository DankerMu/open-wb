## MODIFIED Requirements

### Requirement: web 审批条
web SHALL 把审批分两处呈现：待决审批是 composer 上方停靠区里的提问卡，已结算审批是其所属 assistant 消息内的记录。web 只使用快照与事件归约出的 `approvals`（`tool` 字段即工具名，web 不再解析 `title`）；assistant-ui 工具调用 part 的 `approval` 字段与 `onRespondToToolApproval` SHALL NOT 使用（审批与步骤之间没有关联键，且工具调用组默认收起）。

**提问卡**：选中会话全部消息中 `decision:null` 的审批 SHALL 各渲染一张提问卡，跨消息按审批 `id` 升序纵向叠放在 composer 正上方的停靠区内（停靠区不随消息线程滚动；同一停靠区内任务清单面板在其上方，见 session-todo）；助手消息内 SHALL NOT 渲染待决审批。每张卡是独立的 `role="group"`，accessible name 为 `需要你的确认`，内容为：工具名徽章（`tool` 字段）；`title` **全文**，以 `white-space: pre-wrap` 保留换行，这段正文有自己的最大高度、超出时在卡内滚动（使按钮不被长 `title` 挤出，停靠区整体的限高见 chat-web `输入框上方停靠区`）；正文超出这个高度时，卡内 SHALL 在正文与倒计时句之间显示一行可见提示 `内容较长，请滚动查看全部`，并使正文的滚动容器可由键盘聚焦（`tabindex="0"`），未超出时两者都没有——被限高裁掉的内容不得没有任何迹象；由 `expiresAt` 与注入时钟计算的单句倒计时 `（<n>s 内未操作将自动允许）`，`<n>` SHALL 为 `max(0, ceil((expiresAt - now) / 1000))`（`now` 为注入时钟的毫秒时间），至少每秒重算一次（初值 60，`expiresAt` 已过时为 0），卡内无其它倒计时元素；按钮 `允许` / `拒绝`。点击按钮 SHALL 以该卡自己的审批 `id` 调用一次 `decideApproval(sessionId, approvalId, "allow"|"deny")`，该卡的两个按钮立即禁用，其它卡不受影响。409 `approval_settled` SHALL NOT 显示任何错误（无 Toast、composer 无内联错误、卡内无 alert）：页面主动对账权威历史（与现状一致），以对账得到的快照或随后到达的 `approval.resolved` 为准。其它失败（400/404/502/503、网络异常或非法响应）SHALL 在该提问卡内以 `role="alert"` 渲染 `ApiError` 的 message（400/404/502/503 为信封文案；网络异常与非法响应为既有 request_failed 的安全文案），该卡的两个按钮恢复可用，该 alert 在这张卡下一次点击按钮时清除；不显示 Toast，其它卡不受影响。停靠区里的提问卡集合在已有卡显示期间发生变化（有卡消失或新卡加入），或其上方的任务清单面板在已有卡显示期间出现、消失、收起 / 展开或展开时清单内容改变后的 400 毫秒内，所有提问卡 SHALL 忽略对 `允许` / `拒绝` 的点击（不发请求、不禁用按钮）：卡的位置刚刚移动（停靠区到达高度上限并在内部滚动时，面板高度变化同样会推移卡），这段时间内的点击可能原本是点向另一张卡的；停靠区从空到出现第一张卡不计入。提问卡的标题与内容 SHALL NOT 乐观改变：在 `approval.resolved` 或权威快照显示已结算之前，它始终是 `需要你的确认`。`approval.resolved` 到达或快照显示该审批已结算后，对应提问卡 SHALL 消失。

**已结算记录**：`decision` 非 null 的审批 SHALL 在其所属 assistant 消息内各渲染一条记录（位置见 chat-web `消息线程` 的助手块次序），同一消息的多条按 `id` 升序排列。每条是 `role="group"`，accessible name 按 `decision`：`allow` → `已允许执行`，`deny` → `已拒绝执行`，`timeout` → `超时自动允许`；显示工具名徽章与 `title` 全文（`white-space: pre-wrap`），无按钮、无倒计时。`approvals` 为 `[]` 的消息不渲染记录。

只要选中会话存在待决审批，回合即仍在进行：composer SHALL 保持锁定且 `停止` 可用。重新加载后，快照中的待决审批 SHALL 恢复为提问卡（倒计时从 `expiresAt` 起算，可继续作答），已结算审批恢复为消息内记录。

`title` 正文限高的证据按 seam 分工：多张提问卡与超长 `title` 由整页挂载测试断言结构（下方 `长 title 与多张提问卡的结构`，不作视口或像素断言）；真实浏览器里的布局只对 ui-walk 栈能产生的那一张待决提问卡（首回合 bash 审批）断言：其 `允许` / `拒绝` 与输入框、`停止` 都在视口内（chat-harness `UI 走查对话步骤`）。

#### Scenario: 提问卡挂起、允许与拒绝
- **WHEN** running 助手消息收到 `approval.request{approvalId, tool:"bash", title:"Allow tool: bash\nReason: run ls", expiresAt: now+60s}`
- **THEN** composer 上方停靠区出现一张名为 `需要你的确认` 的提问卡：工具名徽章为 `bash`，正文为 title 全文（两行均在，换行按 `white-space: pre-wrap` 保留），倒计时句为 `（60s 内未操作将自动允许）` 且随注入时钟推进 1s 后变为 `（59s 内未操作将自动允许）`，卡内无其它倒计时元素，按钮 `允许`/`拒绝` 可用；该助手消息内没有名为 `需要你的确认` 的元素；composer 仍锁定且 `停止` 可用
- **WHEN** 点击 `允许`，服务端 200，随后收到 `approval.resolved{decision:"allow"}`
- **THEN** `decideApproval(sessionId, approvalId, "allow")` 恰调用一次，该卡两按钮立即禁用；resolved 到达后停靠区不再有该提问卡，所属助手消息内出现名为 `已允许执行` 的记录，含工具名徽章 `bash` 与 title 全文，无按钮无倒计时句
- **WHEN** 另一条挂起审批点击 `拒绝` 并收到 `approval.resolved{decision:"deny"}`
- **THEN** 提问卡消失，所属助手消息内出现名为 `已拒绝执行` 的记录
- **WHEN** 点击 `允许` 时服务端返回 409 `approval_settled`，随后权威快照中该审批 `decision:"timeout"`
- **THEN** 页面发起一次历史对账；无 Toast、composer 无内联错误、页面无新增 `role="alert"`；提问卡消失，所属助手消息内出现名为 `超时自动允许` 的记录

#### Scenario: 作答失败在卡内提示并可重试
- **WHEN** 待决提问卡点击 `允许`，服务端返回 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}`；随后再次点击 `允许`，服务端 200 并送达 `approval.resolved{decision:"allow"}`；另一例点击 `拒绝` 时请求因网络异常失败
- **THEN** 502 之后该卡内出现 `role="alert"`，文本为 `Agent 运行时不可用`，卡的可访问名仍为 `需要你的确认`，`允许` / `拒绝` 两个按钮恢复可用，页面无 Toast、composer 无内联错误；第二次点击时该 alert 即被清除，`decideApproval` 累计恰调用两次，resolved 到达后提问卡消失、所属助手消息内出现 `已允许执行` 记录；网络异常的一例卡内 alert 为 request_failed 的安全文案，按钮同样恢复可用

#### Scenario: 超时与拒绝的记录文案
- **WHEN** 待决审批收到 `approval.resolved{decision:"timeout"}`；另一条收到 `{decision:"deny"}`
- **THEN** 两张提问卡消失；所属助手消息内分别出现名为 `超时自动允许` 与 `已拒绝执行` 的记录，均无按钮与倒计时句

#### Scenario: 两条并行审批分别作答
- **WHEN** running 助手消息先后收到 `approval.request{approvalId:7, tool:"bash"}` 与 `approval.request{approvalId:8, tool:"bash"}`（均 pending），用户先点 id 8 提问卡的 `拒绝`、再点 id 7 提问卡的 `允许`，服务端各返回 200，随后依次收到 `approval.resolved{approvalId:8, decision:"deny"}` 与 `approval.resolved{approvalId:7, decision:"allow"}`
- **THEN** 停靠区按文档顺序纵向叠放两张名为 `需要你的确认` 的提问卡（第一张为 id 7、第二张为 id 8），第二个 request 未替换第一张；点 id 8 的 `拒绝` 只以 `decideApproval(sessionId, 8, "deny")` 调用一次并只禁用 id 8 的两按钮，id 7 的按钮仍可用、倒计时句仍在；id 8 resolved 后停靠区只剩 id 7 的提问卡，助手消息内出现一条 `已拒绝执行` 记录，composer 仍锁定；id 7 作答并 resolved 后停靠区没有提问卡，助手消息内按 id 升序为 `已允许执行`、`已拒绝执行` 两条记录，均无按钮

#### Scenario: 长 title 与多张提问卡的结构
- **WHEN** 整页挂载（假 API 与假 EventSource）的 running 助手消息有三条待决审批，`id` 为 7、8、9，其中 id 7 的 `title` 为 50 行
- **THEN** 三张提问卡按 id 升序渲染在同一个停靠区容器内，该容器在所有消息 `article` 与消息线程的滚动容器之外、按文档顺序位于输入框之前；每张卡的 `title` 正文是独立的元素（经实现暴露的稳定钩子如 `data-slot` 属性定位），带有限高与内部滚动的样式声明，id 7 的正文含全部 50 行；每张卡的 `允许` / `拒绝` 按钮与倒计时句都不在该卡 `title` 正文的滚动容器之内。正文的内容高度超过其可见高度的卡（测试里按元素的 `scrollHeight` 大于 `clientHeight` 给出）显示 `内容较长，请滚动查看全部` 且正文带 `tabindex="0"`，其余卡两者都没有。本场景不对视口或像素尺寸作断言

#### Scenario: 卡位移后的短暂防误点
- **WHEN** 停靠区里有 id 7、8 两张待决提问卡，点击 id 8 的 `允许` 后 `approval.resolved` 使它消失，随即（400 毫秒内）点击 id 7 的 `允许`；之后过了 400 毫秒再点一次
- **THEN** 400 毫秒内的那次点击不发出任何请求，id 7 的按钮保持可用；之后的点击恰以 id 7 调用一次 `decideApproval`。只有一张卡、停靠区从空到出现它时，立即点击照常作答

#### Scenario: 任务清单面板变化后的短暂防误点
- **WHEN** 停靠区里有一张待决提问卡，其上方的任务清单面板依次出现、在展开时清单内容改变、被收起、被重新展开、消失，每次变化后随即（400 毫秒内）点击该卡的 `允许`；最后一次变化过了 400 毫秒再点一次
- **THEN** 每次变化后 400 毫秒内的点击都不发出任何请求，按钮保持可用；之后的点击恰调用一次 `decideApproval`。面板收起时清单内容改变不设防；面板已经显示、提问卡在其下方从无到有出现时，立即点击照常作答

#### Scenario: 待决审批跨消息按 id 叠放
- **WHEN** 选中会话的快照里两条不同的助手消息各有一条 `decision:null` 的审批，`id` 分别为 12 与 9
- **THEN** 停靠区恰有两张提问卡，按文档顺序先为 id 9、后为 id 12；两条助手消息内都没有待决审批的元素

#### Scenario: 刷新后审批状态保留
- **WHEN** 以 `/?session=<id>` 重新加载：快照中一条助手消息 `approvals` 含一条 pending 且 `expiresAt` 距今 40s，另一次加载中快照的 pending 审批 `expiresAt` 已过去 3s，再一次加载中一条助手消息的审批 `decision` 为 `timeout`、另一条助手消息的为 `deny`、还有一条为 `allow`
- **THEN** pending 加载后停靠区有名为 `需要你的确认` 的提问卡，倒计时句为 `（40s 内未操作将自动允许）`，按钮可点并能作答，composer 锁定且 `停止` 可用；`expiresAt` 已过的那次提问卡的倒计时句为 `（0s 内未操作将自动允许）`（不出现负数），按钮仍可点；`timeout`、`deny`、`allow` 分别在各自助手消息内渲染为名为 `超时自动允许`、`已拒绝执行`、`已允许执行` 的记录，均无按钮与倒计时句，停靠区没有它们的提问卡；`approvals` 为 `[]` 的助手消息不渲染记录
