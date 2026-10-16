## MODIFIED Requirements

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt, stepId}`（消费一个 seq；`stepId` 为发布时该审批已配上的步骤 id，没有为 `null`，见「确认与步骤配对」。omp 在工具执行里先推出 `tool_execution_start`、再发审批 select，但二者在 stdout 上的先后由 omp 的调度决定，不作保证（design D6 的 Context）：fake-omp 与目前观察到的真 omp v18.0.10 回合都是 select 先于 start、并行时各 select 均先于各 start，此时该事件位于对应 `step.start` 之前；本 spec 的其余要求与配对不依赖这一先后。start 不等作答，工具在作答后才执行，故该事件总在该步骤 `step.end` 之前）；每条审批结算后（该审批登记时所属的 generation 的 ring 尚未封口时，见停止与终态对挂起审批的结算；但该 Requirement 第 7 条「基础设施故障 retire」的结算除外，它 SHALL 不发布）SHALL 发布恰一个 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。同一回合可有多条审批同时挂起（omp 并行执行多个工具时各自下发 select），其 `approval.request`/`approval.resolved` 可与其它步骤的 `step.*`、`text.delta` 事件交错；每条审批事件 SHALL 只作用于自身 `approvalId`，后到的 `approval.request` SHALL 不覆盖先前审批。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致。

#### Scenario: 事件序与回放
- **WHEN** fake-omp `approval` 脚本（`--approval-mode write`）的审批请求于注入时钟 T 到达后用户 allow，回合继续到 `agent_end`
- **THEN** 该回合 SSE 事件满足以下次序约束（不断言完整固定序列）：`turn.start` 为首个事件；`approval.request{…,expiresAt:T+60000}` 先于 `step.start(bash)`；`approval.request` 先于 `approval.resolved{decision:"allow"}`；`approval.resolved` 先于该步骤的 `step.end(done)`；以上全部先于恰一个 `turn.end(done)`，且它是该回合末个事件；`text.delta` 可出现在 `step.start` 之前与 `step.end` 之后（fake 在工具轮之前发出正文增量）；事件 id 严格单调；用户在 `step.start(bash)` 送达之后才作答时，`approval.request`、`step.start(bash)`、`approval.resolved` 的事件 id 连续；以 `approval.request` 的 id 作 `Last-Event-ID` 重连，回放首个事件为 `step.start(bash)`；以该 `step.start` 的 id 重连，回放首个事件为 `approval.resolved`

#### Scenario: 两条并行审批分别作答
- **WHEN** fake-omp `approval-parallel` 脚本在同一回合对两个 bash 调用先后发 `extension_ui_request` `r1` 与 `r2`（均未应答），用户先对 `r2` 作答 deny、再对 `r1` 作答 allow
- **THEN** 两个 `approval.request` 的 `approvalId` 不同且都保留，二者的 `stepId` 都为 `null`（select 先于 start，配对发生在 `step.start`）；fake-omp 先收到 `extension_ui_response{id:"r2",value:"Deny"}`、后收到 `{id:"r1",value:"Approve"}`，每个 id 恰一帧；发布两个 `approval.resolved`，分别携带各自 `approvalId` 与 `deny`/`allow`；`r2` 对应步骤 `failed`、`r1` 对应步骤 `done`

### Requirement: 审批作答 REST
`POST /api/sessions/:id/approvals/:approvalId` SHALL 只接受 `application/json` 且 body 恰为 `{decision:"allow"|"deny"}`，其 content-parser 错误由归属集映射为 400 `bad_request`；其它形态（缺键/多键/其它值）400。受 cookie guard 与 owner 校验：未认证 401；会话不存在/属他人、或 `approvalId` 不属于该会话的消息 SHALL 一律 404 `not_found`；未认证 401、会话 404 与非 canonical 正十进制整数 `approvalId` 的 404 SHALL 在 body 解析前返回，`approvalId` 不属于该会话的 404 SHALL 先于任何写入与发帧；均无写入。结算 SHALL 以 `decision IS NULL` 为条件的 CAS 执行，作答与超时、停止、崩溃/有界退回、优雅关停、启动对账共用这同一 CAS：`decision` 已非 NULL（已 allow/deny/timeout，同一审批第二次作答，或该消息所属进程已退出/回合已终态而被非作答路径结算为 `deny`）SHALL 409 `approval_settled`，无写入、不向 omp 发帧；并发作答时 CAS 的后到者 SHALL 409。CAS 命中时 SHALL 依序：在同一 SQLite 事务内写入 `decision`/`decided_at=now` 与审计行 → 向 omp 发 `{type:"extension_ui_response", id:<request_id>, value: decision==="allow" ? "Approve" : "Deny"}` → 取消该 `approvalId` 的超时计时器 → 发布 `approval.resolved` → 200，body 恰为已结算的审批对象 `{id, tool, title, requestedAt, expiresAt, decision, stepId}`（与快照 `approvals` 数组元素同形；`stepId` 为该行此刻的 `step_id`，见「确认与步骤配对」，作答本身从不写它）。`deny` 后 omp 对该工具产出 `tool_execution_end{isError:true}` 时，仅该步骤 `failed`，回合按既有规则可以 `done` 收尾。session supervisor 关停开始后到达结算端口的作答 SHALL 以 `agent_unavailable`（502）拒绝，无写入、不向 omp 发帧。`core/errors` SHALL 新增 `approval_settled`(409, `该审批已处理`)，响应 no-store。

#### Scenario: 允许
- **WHEN** pending 审批收到 `{decision:"allow"}`
- **THEN** 200 `{id,tool:"bash",title,requestedAt,expiresAt,decision:"allow",stepId}`（`stepId` 为作答时该行的 `step_id`：步骤已开始并配上时为其 id，否则为 `null`）；fake-omp 收到 `extension_ui_response{id:"r1",value:"Approve"}`；发布 `approval.resolved{decision:"allow"}`；随后 bash 步骤 `done`，回合 `done`

#### Scenario: 拒绝
- **WHEN** pending 审批收到 `{decision:"deny"}`
- **THEN** 200 `decision:"deny"`；fake-omp 收到 `value:"Deny"` 并发 `tool_execution_end{isError:true}`；该步骤 `failed`、assistant 与会话最终 `done`（非 `failed`）

#### Scenario: 已结算与重复作答
- **WHEN** 对已 allow、已 deny、已 timeout 的审批再次作答，或对同一 pending 审批并发两次作答
- **THEN** 后到者 409 `{error:{code:"approval_settled",message:"该审批已处理"}}`；`chat_approvals` 该行 `decision` 与首次一致；omp 只收到一帧应答

#### Scenario: 作答与进程退出竞争
- **WHEN** 审批挂起时子进程退出，其非作答结算把该审批 CAS 为 `deny`，随后（或与之并发）用户对该审批作答 allow
- **THEN** CAS 仅一方命中：进程退出后到达的作答返回 409 `approval_settled`；该行 `decision="deny"` 不变；无任何 `extension_ui_response` 写出；审计恰一条 `decision=deny`

#### Scenario: 形态、鉴权与归属
- **WHEN** body 为 `{decision:"maybe"}`、`{}`、`{decision:"allow",x:1}` 或非 JSON
- **THEN** 400 `bad_request`，无写入
- **WHEN** 匿名、他人会话、不存在的 approvalId、或 approvalId 属于另一会话
- **THEN** 401 或一致的 404，无写入、无入站帧

#### Scenario: 关停后作答
- **WHEN** 审批挂起时 session supervisor 已开始关停，随后 owner 对该审批作答 allow
- **THEN** 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}` 且 no-store；该请求不改变该行 `decision`/`decided_at`，不新增审计行，不写出 `extension_ui_response`

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision, stepId}`（`decision` 为 `"allow"|"deny"|"timeout"|null`；`stepId` 为 `chat_approvals.step_id`，未配对为 `null`，见「确认与步骤配对」）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述七键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null`、`stepId` 取事件值的记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，以 `step.start` 的 `approvalId` 只设置同一 `approvalId` 记录的 `stepId`（chat-web「纯会话视图归约」），并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

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
SessionSupervisor SHALL 在每个回合（一条助手消息）内维护两份只在内存、回合结束即丢弃的配对状态，二者都按 pump 读到帧的次序（即 omp stdout 的线上次序）更新：
- **未配对审批队列**：尚未配上步骤的审批 select，每项 `{request_id, tool}`，按到达次序；
- **未配对的运行中步骤**：已持久化 `step.start`、尚未配上审批、其 `step.end` 尚未持久化的步骤，每项 `{stepId, name}`，按开始次序。

审批行由运行时在解析 select 帧时插入，可能早于 pump 处理在它之前到达的帧；配对 SHALL 只按上述两份状态（即 pump 次序），不按审批行的插入次序或 `id`。配对在一对同名的审批与步骤中**后到的一方**到达时发生，与二者谁先到无关（omp 不保证 select 与 `tool_execution_start` 在线上的先后，见「审批事件」）：

1. **步骤开始**：持久化一条 `step.start` 时（chat-stream「分段位置的记录与下发」），SHALL 从队列中取出第一个 `tool` 等于该步骤名的项（名字不同的项留在原位），并在插入步骤行的同一事务里执行 `UPDATE chat_approvals SET step_id = <新步骤 id> WHERE message_id = <本消息> AND request_id = <该项的 request_id> AND step_id IS NULL`；更新恰一行时，该行 `id` 即发布的 `step.start` 的 `approvalId`。队列里没有同名项、或更新零行时，`approvalId` 为 `null`，该步骤记入未配对的运行中步骤。
2. **审批 select**：pump 读到一个被「审批请求识别」认作审批的帧、且此刻对该帧的 `approval.request` 发布会真正发出（该帧的审批登记仍在、其 request 尚未发布；作答、超时与终态结算发布 request 后会删除登记）时，若未配对的运行中步骤里有步骤名等于该审批 `tool` 的步骤，SHALL 取其中最早开始的一个，执行 `UPDATE chat_approvals SET step_id = <该步骤 id> WHERE message_id = <本消息> AND request_id = <该帧的 id> AND step_id IS NULL`，提交之后再发布该审批的 `approval.request`，其 `stepId` 为该步骤 id，并把该步骤移出未配对列表；更新零行时按没有可配的步骤处理。没有可配的步骤，或此刻对该帧不会再发布 `approval.request`（作答、超时或终态结算先于 pump 读到 select，结算路径已先发布它并删除登记，见「审批事件」），SHALL 把 `{request_id, tool}` 追加到队尾，发布的 `approval.request` 的 `stepId` 为 `null`。
3. **步骤结束**：一条 `step.end` 持久化后，该步骤若仍在未配对列表里则移出；已结束的步骤不再配对。

配对与该审批是否已作答无关：真 omp 的步骤开始不等作答，所以在步骤开始时配对的审批通常仍是 pending。实时视图从 `step.start` 的 `approvalId` 与 `approval.request` 的 `stepId` 两个方向得到同一个关联，与快照的 `stepId` 一致（chat-web「纯会话视图归约」）。

配对 SHALL 只写 `chat_approvals.step_id` 这一列：它 SHALL NOT 改变审批的 `decision`、`decided_at`、`expires_at`，不改变计时器、向子进程写的帧、`session.approval` 审计、`approval.resolved` 的发布与次序、`pendingApproval`、停止与终态对挂起审批的结算——这些仍只由本 spec 的其余要求决定；`approval.request` 只多出 `stepId` 一个字段，发布的时机与次序不变。步骤开始时的写入与步骤插入同属一个事务，失败时不发布该 `step.start`；审批 select 时的写入失败时不发布该 `approval.request`；二者都沿既有 owned error-sink 处理（回合按既有规则结束，仍挂起的审批按「停止与终态对挂起审批的结算」以 `deny` 结算）。已配对的行此后不再改配；没有配上的行保持 `step_id` 为 NULL。审批只与同一消息的步骤配对。

**已知局限**（owner 2026-10-15 B3 的启发式本身）：只凭工具名配对。同一批并行调用里同名工具有的需要审批、有的不需要时（例如一个普通 `read` 与一个读 PDF 的 `read`），两种线上次序下审批都可能配给同一批里另一个同名步骤；另一种情形：被拒绝的调用若没有步骤（见下文「被拒绝的调用」），它的审批留在队列里，同一回合其后开始的同名步骤会按规则 1 把它配走。两种情形的后果都只是步骤卡上的标记落在另一张同名卡上，审批记录、审计与作答不受影响（design Risks）。

被拒绝的调用：真 omp v18.0.10 对被拒绝的调用是否仍发出 `tool_execution_start` / `tool_execution_end`、以及 select 与 start 的线上先后，以官方二进制实测为准（design D6，结果记入设计与 PR）。两种结果都合法：发出时，被拒绝的审批照常与该步骤配对（该步骤以失败结束），web 在步骤卡上显示 `已拒绝`；不发出时，该审批没有可配的步骤，留在队列里：同一回合其后没有同名步骤开始时保持未配对，web 显示兜底记录（「web 审批条」）；其后若有同名步骤开始，按规则 1 被它配走（见已知局限）。

#### Scenario: 同名工具按先进先出配对
- **WHEN** fake-omp `approval-parallel` 回合依次发出两个 bash 审批 select（`r1`、`r2`）与两个 bash 的 `tool_execution_start`，owner 先拒绝 `r2`、再允许 `r1`
- **THEN** 两条 `approval.request` 的 `stepId` 都为 `null`；第一条 `step.start` 的 `approvalId` 为 `r1` 行的 id、第二条为 `r2` 行的 id；两行 `step_id` 分别为两个步骤的 id；`r2` 对应的步骤以 `failed` 结束；两条审批的 `decision`、`decided_at`、审计行、发给子进程的帧与 `approval.resolved` 事件与本 change 之前逐值相同

#### Scenario: 步骤先于审批 select 到达
- **WHEN** 一段 stdout 先是 `tool_execution_start(bash)`、后是该调用的审批 select，运行时在 pump 处理该 start 之前已插入审批行；随后 owner 允许
- **THEN** 该 `step.start` 的 `approvalId` 为 `null`（审批行已在库里，但 pump 尚未读到其 select）；pump 读到 select 后该审批行的 `step_id` 为该步骤 id，随后发布的 `approval.request` 的 `stepId` 为该步骤 id；回合结束后的快照里该审批的 `stepId` 与之相同；审批的 `decision`、`decided_at`、审计行与发给子进程的帧与本 change 之前逐值相同

#### Scenario: 已结束的步骤不再配对
- **WHEN** 一个 bash 步骤开始并结束（没有配上审批）之后到达一个 bash 审批 select，随后另一个 bash 步骤开始
- **THEN** 该 `approval.request` 的 `stepId` 为 `null`；后一个 `step.start` 的 `approvalId` 为该审批的 id

#### Scenario: 作答先于 pump 读到 select
- **WHEN** 一个 bash 步骤已开始、未配对时，审批行已插入，客户端从快照读到它并作答，作答路径先发布了它的 `approval.request`（`stepId` 为 `null`）与 `approval.resolved`；随后 pump 才读到该审批的 select 帧
- **THEN** select 时不配对、只把它入队：该行 `step_id` 仍为 NULL，不再发布第二条 `approval.request`；同一回合其后若有 bash 步骤开始，该 `step.start` 的 `approvalId` 为这条审批的 id 且行的 `step_id` 为该步骤 id，否则回合结束后快照 `stepId` 为 `null`；两种情况下实时视图与快照的 `stepId` 一致

#### Scenario: 工具名不同不配对
- **WHEN** 队列里有一个 `bash` 审批时到达 `read` 的 `tool_execution_start`，随后到达 `bash` 的 `tool_execution_start`
- **THEN** `read` 步骤的 `approvalId` 为 `null`；`bash` 步骤配上该审批
- **WHEN** 一个 `read` 步骤运行中、未配对时到达一个 `bash` 审批 select
- **THEN** 该 `approval.request` 的 `stepId` 为 `null`，审批进入队列

#### Scenario: 没有步骤的审批保持未配对
- **WHEN** 一个审批 select 到达后、其 `tool_execution_start` 到达之前用户停止生成，回合以 `turn.end stopped` 结束
- **THEN** 该审批按「停止与终态对挂起审批的结算」以 `deny` 结算，`step_id` 为 NULL，快照 `stepId` 为 `null`
- **WHEN** 另一回合审批已配上步骤后、作答之前用户停止生成
- **THEN** 该审批同样以 `deny` 结算，`step_id` 仍为该步骤 id，快照 `stepId` 为该步骤 id

#### Scenario: 配对写失败
- **WHEN** 持久化一条 `step.start` 时，步骤插入与配对所在的事务在 SQLite 中失败；另一例在审批 select 时配对的 `step_id` 写入失败
- **THEN** 前者步骤行与 `step_id` 都没有写入、该 `step.start` 不进入 ring；后者 `step_id` 仍为 NULL、该 `approval.request` 不进入 ring；两者都沿既有 owned error-sink 处理
