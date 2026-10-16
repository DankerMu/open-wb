## MODIFIED Requirements

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision, stepId}`（`decision` 为 `"allow"|"deny"|"timeout"|null`；`stepId` 为 `chat_approvals.step_id`，未配对为 `null`，见「确认与步骤配对」）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述七键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null`、`stepId:null` 的记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，以 `step.start` 的 `approvalId` 只设置同一 `approvalId` 记录的 `stepId`（chat-web「纯会话视图归约」），并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approvals=[{id,tool:"bash",title,requestedAt,expiresAt,decision:null,stepId}]`（该 bash 步骤已开始时 `stepId` 为其 id，否则为 `null`），其它消息 `approvals:[]`；页面渲染审批条；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算；一例该审批配上了步骤，另一例没有（`stepId` 为 `null`）
- **THEN** 快照该消息 `approvals[0].decision="deny"`；配上步骤的一例 web 在该步骤卡上显示 `已拒绝` 小标记、消息内没有记录卡；没有配上的一例 web 在消息末尾显示 `已拒绝执行` 兜底记录

#### Scenario: 多条审批的快照与归约
- **WHEN** 同一消息先后收到 `approval.request` `a1`、`a2`，随后收到 `approval.resolved{approvalId:a2,decision:"deny"}`，再重连回放同一批事件
- **THEN** 该消息 `approvals` 为 `[{id:a1,decision:null},{id:a2,decision:"deny"}]`（按 `id` 升序、无重复）；`a1` 仍可作答；重新拉取的快照与归约结果一致

### Requirement: web 审批条
web SHALL 把审批分两处呈现：待决审批是 composer 上方停靠区里的提问卡；已结算审批中配上步骤的（`stepId` 指向所属消息的一个步骤）只在该步骤卡上按 chat-web「步骤卡的确认标记」显示小标记（正常允许不显示），配不上步骤的是其所属 assistant 消息内的兜底记录。web 只使用快照与事件归约出的 `approvals`（`tool` 字段即工具名，`stepId` 即配对，web 不再解析 `title`）；assistant-ui 工具调用 part 的 `approval` 字段与 `onRespondToToolApproval` SHALL NOT 使用（配对与标记由应用层组件按 `stepId` 读取；作答只在提问卡上进行，工具段默认收起）。

**提问卡**：选中会话全部消息中 `decision:null` 的审批 SHALL 各渲染一张提问卡，跨消息按审批 `id` 升序纵向叠放在 composer 正上方的停靠区内（停靠区不随消息线程滚动；同一停靠区内任务清单面板在其上方，见 session-todo）；助手消息内 SHALL NOT 渲染待决审批。每张卡是独立的 `role="group"`，accessible name 为 `需要你的确认`，并 SHALL 以 `aria-describedby` 依次关联本卡的工具名徽章与 `title` 正文两个元素（多张卡的名称与按钮名都相同，靠这段描述区分；`允许` / `拒绝` 的可访问名不变），内容为：工具名徽章（`tool` 字段）；`title` **全文**，以 `white-space: pre-wrap` 保留换行，这段正文有自己的最大高度、超出时在卡内滚动（使按钮不被长 `title` 挤出，停靠区整体的限高见 chat-web `输入框上方停靠区`）；正文超出这个高度时，卡内 SHALL 在正文与倒计时句之间显示一行可见提示 `内容较长，请滚动查看全部`，并使正文的滚动容器可由键盘聚焦（`tabindex="0"`），未超出时两者都没有——被限高裁掉的内容不得没有任何迹象；由 `expiresAt` 与注入时钟计算的单句倒计时 `（<n>s 内未操作将自动允许）`，`<n>` SHALL 为 `max(0, ceil((expiresAt - now) / 1000))`（`now` 为注入时钟的毫秒时间），至少每秒重算一次（初值 60，`expiresAt` 已过时为 0），卡内无其它倒计时元素；按钮 `允许` / `拒绝`。点击按钮 SHALL 以该卡自己的审批 `id` 调用一次 `decideApproval(sessionId, approvalId, "allow"|"deny")`，该卡的两个按钮立即禁用，其它卡不受影响。409 `approval_settled` SHALL NOT 显示任何错误（无 Toast、composer 无内联错误、卡内无 alert）：页面主动对账权威历史（与现状一致），以对账得到的快照或随后到达的 `approval.resolved` 为准。其它失败（400/404/502/503、网络异常或非法响应）SHALL 在该提问卡内以 `role="alert"` 渲染 `ApiError` 的 message（400/404/502/503 为信封文案；网络异常与非法响应为既有 request_failed 的安全文案），该卡的两个按钮恢复可用，该 alert 在这张卡下一次点击按钮时清除；不显示 Toast，其它卡不受影响。停靠区里的提问卡集合在已有卡显示期间发生变化（有卡消失或新卡加入），或其上方的任务清单面板在已有卡显示期间出现、消失、收起 / 展开或展开时清单内容改变后的 400 毫秒内，所有提问卡 SHALL 忽略对 `允许` / `拒绝` 的点击（不发请求、不禁用按钮）：卡的位置刚刚移动（停靠区到达高度上限并在内部滚动时，面板高度变化同样会推移卡），这段时间内的点击可能原本是点向另一张卡的；停靠区从空到出现第一张卡不计入。提问卡的标题与内容 SHALL NOT 乐观改变：在 `approval.resolved` 或权威快照显示已结算之前，它始终是 `需要你的确认`。`approval.resolved` 到达或快照显示该审批已结算后，对应提问卡 SHALL 消失。提问卡因结算而消失时的焦点：若用户是用键盘在这张卡内作答的（按钮由键盘激活，随之禁用而失去焦点，此后焦点没有落到别的元素上），或这张卡未经本页作答而消失之前焦点在卡内，焦点 SHALL 移到剩余待决提问卡里 `id` 大于它的最小一张的 `允许` 按钮，没有更大的则移到剩余的第一张；没有剩余待决提问卡时 SHALL 移到 composer 的输入框，输入框此刻锁定（回合仍在进行）则推迟到它解锁的那一刻、且届时焦点仍未落到别的元素上才聚焦。用鼠标或触屏作答时 SHALL NOT 移动焦点（否则焦点会在用户看不到的情况下落到另一张卡的 `允许` 上，回合结束时还会在触屏设备上唤起软键盘）；焦点在这张卡之外的任何元素上时 SHALL NOT 移动焦点；提问卡出现时同样 SHALL NOT 夺取焦点。移过去的焦点不豁免上面的 400 毫秒防误点；卡内按钮 SHALL 忽略按住不放产生的重复按键（`keydown` 的 `repeat` 为真时不作答），使按住 Enter 或空格不会在防误点过期后连答下一张卡。

**兜底记录**：`decision` 非 null、且 `stepId` 为 `null` 或不指向所属消息任一步骤的审批 SHALL 在其所属 assistant 消息内各渲染一条记录（位置见 chat-web `消息线程` 的助手块次序：分段区之后、错误文本之前），同一消息的多条按 `id` 升序排列；配上步骤的已结算审批 SHALL NOT 渲染为记录。每条是 `role="group"`，accessible name 按 `decision`：`allow` → `已允许执行`，`deny` → `已拒绝执行`，`timeout` → `超时自动允许`；显示工具名徽章与 `title` 全文（`white-space: pre-wrap`），无按钮、无倒计时。`approvals` 为 `[]` 或其已结算审批都已配上步骤的消息不渲染记录。本要求以下各场景中的审批都没有配上步骤（没有带其 `approvalId` 的 `step.start`，`stepId` 为 `null`），配上步骤的情形见场景「已配对的已结算确认不渲染记录」。

只要选中会话存在待决审批，回合即仍在进行：composer SHALL 保持锁定且 `停止` 可用。重新加载后，快照中的待决审批 SHALL 恢复为提问卡（倒计时从 `expiresAt` 起算，可继续作答），已结算审批按 `stepId` 恢复为步骤卡标记或消息内兜底记录。

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

#### Scenario: 多张提问卡靠描述区分
- **WHEN** 停靠区里有 id 7（`tool:"bash"`，`title:"Allow tool: bash\nReason: run ls"`）与 id 8（`tool:"write"`，`title:"Allow tool: write\nPath: notes.md"`）两张待决提问卡
- **THEN** 两张卡的可访问名都是 `需要你的确认`；每张卡的 `aria-describedby` 恰引用两个元素，依次为本卡的工具名徽章与 `title` 正文，两张卡引用的元素互不相同，由此得到的描述文本分别含 `bash` 与 `write`；四个按钮的可访问名仍是 `允许` / `拒绝`

#### Scenario: 作答后焦点移到下一张卡或输入框
- **WHEN** 停靠区里有 id 7、8、9 三张待决提问卡，焦点在 id 8 的 `拒绝` 上并用键盘按下它，`approval.resolved{approvalId:8}` 使它消失；随后在 id 9 的 `允许` 上作答并结算；最后在 id 7 的 `允许` 上作答并结算，之后回合结束、输入框解锁
- **THEN** id 8 消失后焦点在 id 9 的 `允许` 上；id 9 消失后焦点在 id 7 的 `允许` 上；id 7 消失时输入框仍锁定，回合结束、输入框解锁后焦点在输入框；每次移动后 400 毫秒内对新聚焦按钮的点击不作答
- **WHEN** 另一例焦点在 `停止` 按钮上时一张提问卡因 `approval.resolved{decision:"timeout"}` 消失；再一例用户在卡内作答后、结算到达之前把焦点移到了 `停止`；再一例焦点在输入框上方别的控件上时出现一张新的提问卡
- **THEN** 三例焦点都留在原处
- **WHEN** 另一例停靠区有 id 7、8 两张卡，用鼠标点击 id 8 的 `拒绝`（按钮因点击获得焦点），`approval.resolved{approvalId:8}` 使它消失；随后用鼠标答掉 id 7，回合结束、输入框解锁
- **THEN** 两次都没有焦点移动：id 8 消失后焦点不在 id 7 的按钮上，回合结束后焦点不在输入框
- **WHEN** 另一例焦点被移到下一张卡的 `允许` 上之后，过了 400 毫秒到达一次 `repeat` 为真的 Enter `keydown`
- **THEN** 不发出作答请求
- **WHEN** 另一例焦点在一张提问卡的 `允许` 上、用户没有作答，该卡因 `approval.resolved{decision:"timeout"}` 消失，停靠区还有另一张待决卡
- **THEN** 焦点移到那一张的 `允许`

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

#### Scenario: 已配对的已结算确认不渲染记录
- **WHEN** running 助手消息依次收到 `approval.request{approvalId:7, tool:"bash"}`、`step.start{stepId:5, name:"bash", approvalId:7}`，用户点 `允许` 后收到 `approval.resolved{approvalId:7, decision:"allow"}`；另一条依次收到 `approval.request{approvalId:8, tool:"bash"}`、`step.start{stepId:6, approvalId:8}` 与 `approval.resolved{approvalId:8, decision:"deny"}`；再以快照重新加载这两条消息（`stepId` 分别为 5 与 6）
- **THEN** 提问卡在 resolved 到达后消失；两条助手消息内都没有名为 `已允许执行`、`已拒绝执行` 或 `超时自动允许` 的记录；展开工具段后步骤 5 的卡头没有标记、步骤 6 的卡头有 `已拒绝`；重新加载后同样


## ADDED Requirements

### Requirement: 确认与步骤配对
SessionSupervisor SHALL 在每个回合内按 pump 读到帧的次序（即 omp stdout 的线上次序）记下该回合的审批 select：pump 每读到一个被「审批请求识别」认作审批的 `extension_ui_request` 帧，就把它的 `{request_id, tool}` 追加到本回合的配对队列末尾。队列只在内存里、只属于这一个回合（这一条助手消息），回合结束即丢弃。审批行由运行时在解析该帧时插入，可能早于 pump 处理在它之前到达的帧；配对 SHALL 以队列次序为准，不以审批行的插入次序或 `id` 为准。

持久化一条 `step.start` 时（chat-stream「分段位置的记录与下发」），supervisor SHALL 从队列中取出第一个 `tool` 等于该步骤名的项（按工具名先进先出；名字不同的项留在原位），并在插入步骤行的同一事务里执行 `UPDATE chat_approvals SET step_id = <新步骤 id> WHERE message_id = <本消息> AND request_id = <该项的 request_id> AND step_id IS NULL`。更新恰一行时，该行 `id` 即发布的 `step.start` 的 `approvalId`；队列里没有同名项、或更新零行（该审批行没有插入成功）时，`approvalId` 为 `null`、不写任何审批行。配对与该审批是否已作答无关：真 omp 的步骤开始不等作答（「审批事件」），所以配对时审批通常仍是 pending。

配对 SHALL 只写 `chat_approvals.step_id` 这一列：它 SHALL NOT 改变审批的 `decision`、`decided_at`、`expires_at`，不改变计时器、向子进程写的帧、`session.approval` 审计、`approval.request` / `approval.resolved` 的发布与次序、`pendingApproval`、停止与终态对挂起审批的结算——这些仍只由本 spec 的其余要求决定。写入失败与步骤插入失败同属一个事务，沿既有 owned error-sink 处理，不发布该 `step.start`。已配对的行此后不再改配；没有配上的行保持 `step_id` 为 NULL。审批只与同一消息的步骤配对。

被拒绝的调用：真 omp v18.0.10 对被拒绝的调用是否仍发出 `tool_execution_start` / `tool_execution_end`，以官方二进制实测为准（design D6，结果记入设计与 PR）。两种结果都合法：发出时，被拒绝的审批照常配上该步骤（该步骤以失败结束），web 在步骤卡上显示 `已拒绝`；不发出时，该审批没有可配的步骤，保持未配对，web 显示兜底记录（「web 审批条」）。

#### Scenario: 同名工具按先进先出配对
- **WHEN** fake-omp `approval-parallel` 回合依次发出两个 bash 审批 select（`r1`、`r2`）与两个 bash 的 `tool_execution_start`，owner 先拒绝 `r2`、再允许 `r1`
- **THEN** 第一条 `step.start` 的 `approvalId` 为 `r1` 行的 id、第二条为 `r2` 行的 id；两行 `step_id` 分别为两个步骤的 id；`r2` 对应的步骤以 `failed` 结束；两条审批的 `decision`、`decided_at`、审计行、发给子进程的帧与 `approval.resolved` 事件与本 change 之前逐值相同

#### Scenario: 按线上次序而非插入次序
- **WHEN** 同一段 stdout 里先是一个不需要审批的 `read` 的 `tool_execution_start`，后是一个 `read` 的审批 select 与它的 `tool_execution_start`；运行时在 pump 处理第一个 `tool_execution_start` 之前已插入该审批行
- **THEN** 第一个 `read` 步骤的 `step.start` 的 `approvalId` 为 `null`，审批配给第二个 `read` 步骤

#### Scenario: 工具名不同不配对
- **WHEN** 队列里有一个 `bash` 审批时到达 `read` 的 `tool_execution_start`，随后到达 `bash` 的 `tool_execution_start`
- **THEN** `read` 步骤的 `approvalId` 为 `null`；`bash` 步骤配上该审批

#### Scenario: 没有步骤的审批保持未配对
- **WHEN** 一个审批 select 到达后、其 `tool_execution_start` 到达之前用户停止生成，回合以 `turn.end stopped` 结束
- **THEN** 该审批按「停止与终态对挂起审批的结算」以 `deny` 结算，`step_id` 为 NULL，快照 `stepId` 为 `null`
- **WHEN** 另一回合审批已配上步骤后、作答之前用户停止生成
- **THEN** 该审批同样以 `deny` 结算，`step_id` 仍为该步骤 id，快照 `stepId` 为该步骤 id

#### Scenario: 配对写失败
- **WHEN** 持久化一条 `step.start` 时，步骤插入与配对所在的事务在 SQLite 中失败
- **THEN** 步骤行与 `step_id` 都没有写入，该 `step.start` 不进入 ring，失败沿既有 owned error-sink 处理
