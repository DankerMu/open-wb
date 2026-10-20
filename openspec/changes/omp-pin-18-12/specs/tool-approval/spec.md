# tool-approval Spec Delta

## MODIFIED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 的 spawn 契约以该会话的有效审批档位启动（`--approval-mode` 取 `always-ask`、`write` 或 `yolo`，session-permission-tier「档位与 omp 审批模式」）。下面的识别规则与档位无关，也与被请求确认的是哪个工具无关：`always-ask` 档下写文件类工具（`write`、`edit` 等）的确认请求与 `write` 档下 bash、eval 的确认请求走同一条路径；`yolo` 档下 omp 若仍发出符合形状的请求，同样按审批处理。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流（omp-runtime「RPC IO and child observation」）：`method==="select"`、`title` 以 `Allow tool: ` 开头、首行工具名不是 `browser`，且 `options` 恰为两种闭合形状之一——`["Approve","Deny"]`，或恰三项、首项 `Approve`、末项 `Deny`、中间一项匹配 `^Approve .+ for this session$`（omp v18.12.3 对被档位抬高的 bash / write / edit / eval / task 提示附带的「本会话内放行」选项，其中的名字是 omp 的策略键、不钉成工具名）→ 视为审批请求向上抛出而不自动应答，`tool` 与 `title` 都是原文；`title` 整体恰为 `Allow tool: browser`、或恰为 `Allow tool: browser\nReason: <不含换行的一行>`，且 `options` 恰为 `["Approve","Deny"]` 的 `select` 是浏览器 eval prelude 的卡，由进程自己立即应答 `Approve`、不作为审批（#1563，owner 2026-10-20；痕迹见 browser-runtime「浏览器调用审计」）——题目按整体匹配：omp v18.0.10 真 `browser` 工具的 `Allow tool: browser\nAction: …` 卡不是 prelude 卡，落入 cancel（omp-runtime「RPC IO and child observation」）；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 为其它形状的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。宿主作答 SHALL 只写 `Approve` 或 `Deny`，永远不写中间那一项：omp 的「本会话内放行」是其进程内存里的授权集合，宿主不向用户暴露它。`eval` 的审批 `title` 是 `Allow tool: eval\nLanguage: <语言>\nCode:\n<代码>`（omp 把代码截到 2000 个 UTF-16 码元后加省略标记，与 bash 的 `Command:` 同一规则），宿主 SHALL 原样登记与发布，不改写、不改名（owner 2026-10-20 Q4：用户在卡上看到的就是将要执行的代码）；v18.0.10 时代对 `write xd://browser` 的浏览器改写已删除（browser-runtime「浏览器操作的可读描述」REMOVED）。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 `message_end(toolUse)` 与 bash 的 `tool_execution_start` 之后（与真 omp v18.12.3 实测一致）发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nCommand: echo workbuddy-smoke",options:["Approve","Approve bash for this session","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="bash"`，`title` 为原文
- **WHEN** 同一 title 的 select 的 `options` 为 `["Approve","Deny"]`（工具自带的强制提示，如 bash 的 `Critical pattern detected`），或 `["Approve","Approve shell:echo for this session","Deny"]`
- **THEN** 两者同样作为审批上抛，`tool="bash"`

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}`、`{method:"select",title:"Pick one",options:["Approve","Deny"]}`、`{method:"select",title:"Allow tool: bash",options:["Approve","Approve bash","Deny"]}`（中间项不含 `for this session`）或 `{method:"select",title:"Allow tool: bash",options:["Approve","Approve bash for this session","Deny","Other"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，不向 owner 上抛审批请求

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍作为审批请求上抛给 owner，`tool="unknown"`，不被自动回绝

#### Scenario: 写文件工具的确认同样识别为审批
- **WHEN** fake-omp `approval-write` 脚本（argv 含 `--approval-mode always-ask`）在 `message_end(toolUse)` 与 write 的 `tool_execution_start` 之后发 `extension_ui_request{id:"w1",method:"select",title:"Allow tool: write\nPath: workbuddy-report.html",options:["Approve","Approve write for this session","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="write"`，`title` 为原文；随后的登记、事件、作答、超时与审计与 bash 审批相同（`chat_approvals.tool="write"`，`session.approval` 的 `detail.tool="write"`）

#### Scenario: 浏览器调用的审批改写为浏览器操作
- **WHEN** 档位 `write` 的会话里收到 `title` 为 `Allow tool: eval\nLanguage: javascript\nCode:\nawait browser.open({ name: "main", url: "https://example.com/a" });` 的审批请求（`options` 为三项形状）；另一次收到 `title` 为 `Allow tool: write\nPath: xd://browser\nContent:\n{"action":"open","url":"https://example.com/a"}` 的两项审批（#1563 之前被改写成「浏览器：打开 …」的那种 title）
- **THEN** （标题沿用 #1563 之前的规格以便归档保留该场景；它命名的行为被 #1563 反转）两者都不再改写为浏览器操作——`xd-browser.ts` 已删：前者作为审批上抛，`tool="eval"`，`title` 逐字为原文；`chat_approvals` 的 `tool`/`title` 与 `approval.request` 事件同为这些值，作答后 `session.approval` 审计的 `detail.tool="eval"`；作答 `allow` 时发给子进程的值恰为 `Approve`；后者 `tool="write"`、`title` 原文，没有 `浏览器：` 前缀与 ⚠ 行

#### Scenario: 浏览器审批与浏览器步骤配对
- **WHEN** 上例 `eval` 的审批之后到达同一调用的 `tool_execution_start{toolName:"eval"}`（或反序），其间与之后子进程发出若干 `Allow tool: browser` 的 prelude 卡
- **THEN** 该审批与该 `eval` 步骤按「确认与步骤配对」以名字 `eval` 配对（`step.start.approvalId` 或 `approval.request.stepId` 之一非 null，快照 `stepId` 为该步骤 id）；prelude 卡不进入未配对审批队列，也不改变配对结果

#### Scenario: 浏览器 prelude 的卡不是审批
- **WHEN** 一个已批准的 `eval` 步骤运行中，子进程发 `extension_ui_request{id:"p1",method:"select",title:"Allow tool: browser",options:["Approve","Deny"]}`
- **THEN** 子进程立即收到 `{id:"p1",value:"Approve"}`；owner 没有收到审批请求，`chat_approvals` 没有新行，没有 `approval.request` 事件，没有 `session.approval` 审计；回合结束时没有滞留的未配对审批
- **WHEN** 子进程发 `{id:"p2",method:"select",title:"Allow tool: browser\nAction: open\nTab: main\nURL: https://example.com",options:["Approve","Deny"]}`（omp v18.0.10 真 `browser` 工具的卡）
- **THEN** 它收到 `{id:"p2",cancelled:true}`，不被自动放行、也不作为审批上抛

### Requirement: 确认与步骤配对
SessionSupervisor SHALL 在每个回合（一条助手消息）内维护两份只在内存、回合结束即丢弃的配对状态，二者都按 pump 读到帧的次序（即 omp stdout 的线上次序）更新：
- **未配对审批队列**：尚未配上步骤的审批 select，每项 `{request_id, tool}`，按到达次序；
- **未配对的运行中步骤**：已持久化 `step.start`、尚未配上审批、其 `step.end` 尚未持久化的步骤，每项 `{stepId, name}`，按开始次序。

审批行由运行时在解析 select 帧时插入，可能早于 pump 处理在它之前到达的帧；配对 SHALL 只按上述两份状态（即 pump 次序），不按审批行的插入次序或 `id`。配对在一对同名的审批与步骤中**后到的一方**到达时发生，与二者谁先到无关（omp 不保证 select 与 `tool_execution_start` 在线上的先后：v18.0.10 实测 select 在前，v18.12.3 实测 `tool_execution_start` 在前，见「审批事件」）：

1. **步骤开始**：持久化一条 `step.start` 时（chat-stream「分段位置的记录与下发」），SHALL 从队列中取出第一个 `tool` 等于该步骤名的项（名字不同的项留在原位），并在插入步骤行的同一事务里执行 `UPDATE chat_approvals SET step_id = <新步骤 id> WHERE message_id = <本消息> AND request_id = <该项的 request_id> AND step_id IS NULL`；更新恰一行时，该行 `id` 即发布的 `step.start` 的 `approvalId`。队列里没有同名项、或更新零行时，`approvalId` 为 `null`，该步骤记入未配对的运行中步骤。
2. **审批 select**：pump 读到一个被「审批请求识别」认作审批的帧、且此刻对该帧的 `approval.request` 发布会真正发出（该帧的审批登记仍在、其 request 尚未发布；作答、超时与终态结算发布 request 后会删除登记）时，若未配对的运行中步骤里有步骤名等于该审批 `tool` 的步骤，SHALL 取其中最早开始的一个，执行 `UPDATE chat_approvals SET step_id = <该步骤 id> WHERE message_id = <本消息> AND request_id = <该帧的 id> AND step_id IS NULL`，提交之后再发布该审批的 `approval.request`，其 `stepId` 为该步骤 id，并把该步骤移出未配对列表；更新零行时按没有可配的步骤处理。没有可配的步骤，或此刻对该帧不会再发布 `approval.request`（作答、超时或终态结算先于 pump 读到 select，结算路径已先发布它并删除登记，见「审批事件」），SHALL 把 `{request_id, tool}` 追加到队尾，发布的 `approval.request` 的 `stepId` 为 `null`。
3. **步骤结束**：一条 `step.end` 持久化后，该步骤若仍在未配对列表里则移出；已结束的步骤不再配对。

配对与该审批是否已作答无关：真 omp 的步骤开始不等作答，所以在步骤开始时配对的审批通常仍是 pending。实时视图从 `step.start` 的 `approvalId` 与 `approval.request` 的 `stepId` 两个方向得到同一个关联，与快照的 `stepId` 一致（chat-web「纯会话视图归约」）。浏览器 prelude 的卡（「审批请求识别」）不进入任何一份状态。

配对 SHALL 只写 `chat_approvals.step_id` 这一列：它 SHALL NOT 改变审批的 `decision`、`decided_at`、`expires_at`，不改变计时器、向子进程写的帧、`session.approval` 审计、`approval.resolved` 的发布与次序、`pendingApproval`、停止与终态对挂起审批的结算——这些仍只由本 spec 的其余要求决定；`approval.request` 只多出 `stepId` 一个字段，发布的时机与次序不变。步骤开始时的写入与步骤插入同属一个事务，失败时不发布该 `step.start`；审批 select 时的写入失败时不发布该 `approval.request`；二者都沿既有 owned error-sink 处理（回合按既有规则结束，仍挂起的审批按「停止与终态对挂起审批的结算」以 `deny` 结算）。已配对的行此后不再改配；没有配上的行保持 `step_id` 为 NULL。审批只与同一消息的步骤配对。

**已知局限**（owner 2026-10-15 B3 的启发式本身）：只凭工具名配对。同一批并行调用里同名工具有的需要审批、有的不需要时（例如一个普通 `read` 与一个读 PDF 的 `read`），两种线上次序下审批都可能配给同一批里另一个同名步骤；另一种情形：被拒绝的调用若没有步骤（见下文「被拒绝的调用」），它的审批留在队列里，同一回合其后开始的同名步骤会按规则 1 把它配走。两种情形的后果都只是步骤卡上的标记落在另一张同名卡上，审批记录、审计与作答不受影响（design Risks）。

被拒绝的调用：真 omp v18.12.3 先发 `tool_execution_start` 再发 select（实测），所以被拒绝的调用也有步骤：审批照常与该步骤配对（该步骤以失败结束，结果文本 `Tool call denied by user: <tool>`），web 在步骤卡上显示 `已拒绝`。假 omp 自 #1563 起同样先 start 后 select（omp-test-harness「假 omp 进程契约」）。

#### Scenario: 同名工具按先进先出配对
- **WHEN** fake-omp `approval-parallel` 回合依次发出两个 bash 的 `tool_execution_start` 与两个 bash 审批 select（`r1`、`r2`），owner 先拒绝 `r2`、再允许 `r1`
- **THEN** 两条 `step.start` 的 `approvalId` 都为 `null`（start 先到，队列为空）；第一条 `approval.request` 的 `stepId` 为第一个步骤的 id、第二条为第二个步骤的 id；两行 `step_id` 分别为两个步骤的 id；`r2` 对应的步骤以 `failed` 结束；两条审批的 `decision`、`decided_at`、审计行、发给子进程的帧与 `approval.resolved` 事件与本 change 之前逐值相同

#### Scenario: 审批 select 先于步骤到达
- **WHEN** 一段 stdout 先是某调用的审批 select、后是它的 `tool_execution_start(bash)`（v18.0.10 的次序，配对规则对两种次序都成立），随后 owner 允许
- **THEN** 该 `approval.request` 的 `stepId` 为 `null`；该 `step.start` 的 `approvalId` 为审批行的 id，该行 `step_id` 为该步骤 id；回合结束后的快照里该审批的 `stepId` 与之相同

#### Scenario: 步骤先于审批 select 到达
- **WHEN** 一段 stdout 先是 `tool_execution_start(bash)`、后是该调用的审批 select（v18.12.3 的次序），运行时在 pump 处理该 start 之前已插入审批行；随后 owner 允许
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

### Requirement: 审批事件
supervisor SHALL 在审批行持久化之后、经既有 generation ring 发布 `approval.request{messageId, approvalId, tool, title, expiresAt, stepId}`（消费一个 seq；`stepId` 为发布时该审批已配上的步骤 id，没有为 `null`，见「确认与步骤配对」。omp 在工具执行里先推出 `tool_execution_start`、再发审批 select，但二者在 stdout 上的先后由 omp 的调度决定，不作保证（design D6 的 Context）：真 omp v18.12.3 与 fake-omp（#1563 组 7 起）都是 `tool_execution_start` 先于 select、并行时各 start 均先于各 select，此时该事件位于对应 `step.start` 之后、`stepId` 已为该步骤 id（v18.0.10 是相反的次序，配对规则对两种次序都成立）；本 spec 的其余要求与配对不依赖这一先后。start 不等作答，工具在作答后才执行，故该事件总在该步骤 `step.end` 之前）；每条审批结算后（该审批登记时所属的 generation 的 ring 尚未封口时，见停止与终态对挂起审批的结算；但该 Requirement 第 7 条「基础设施故障 retire」的结算除外，它 SHALL 不发布）SHALL 发布恰一个 `approval.resolved{messageId, approvalId, decision}`，`decision ∈ {allow,deny,timeout}`。同一回合可有多条审批同时挂起（omp 并行执行多个工具时各自下发 select），其 `approval.request`/`approval.resolved` 可与其它步骤的 `step.*`、`text.delta` 事件交错；每条审批事件 SHALL 只作用于自身 `approvalId`，后到的 `approval.request` SHALL 不覆盖先前审批。两类事件 SHALL 进入 ring 回放、SSE 扇出与 `Last-Event-ID` 语义与其它事件一致。

#### Scenario: 事件序与回放
- **WHEN** fake-omp `approval` 脚本（`--approval-mode write`）的审批请求于注入时钟 T 到达后用户 allow，回合继续到 `agent_end`
- **THEN** 该回合 SSE 事件满足以下次序约束（不断言完整固定序列）：`turn.start` 为首个事件；`step.start(bash)` 先于 `approval.request{…,expiresAt:T+60000, stepId:<该步骤 id>}`；`approval.request` 先于 `approval.resolved{decision:"allow"}`；`approval.resolved` 先于该步骤的 `step.end(done)`；以上全部先于恰一个 `turn.end(done)`，且它是该回合末个事件；`text.delta` 可出现在 `step.start` 之前与 `step.end` 之后（fake 在工具轮之前发出正文增量）；事件 id 严格单调；用户在 `approval.request` 送达之后才作答时，`step.start(bash)`、`approval.request`、`approval.resolved` 的事件 id 连续；以 `step.start(bash)` 的 id 作 `Last-Event-ID` 重连，回放首个事件为 `approval.request`；以该 `approval.request` 的 id 重连，回放首个事件为 `approval.resolved`

#### Scenario: 两条并行审批分别作答
- **WHEN** fake-omp `approval-parallel` 脚本在同一回合对两个 bash 调用先后发 `extension_ui_request` `r1` 与 `r2`（均未应答），用户先对 `r2` 作答 deny、再对 `r1` 作答 allow
- **THEN** 两个 `approval.request` 的 `approvalId` 不同且都保留，二者的 `stepId` 分别为各自步骤的 id（start 先于 select，配对发生在 pump 读到 select 时；两条 `step.start` 的 `approvalId` 为 `null`）；fake-omp 先收到 `extension_ui_response{id:"r2",value:"Deny"}`、后收到 `{id:"r1",value:"Approve"}`，每个 id 恰一帧；发布两个 `approval.resolved`，分别携带各自 `approvalId` 与 `deny`/`allow`；`r2` 对应步骤 `failed`、`r1` 对应步骤 `done`

### Requirement: 审批快照
`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `approvals` 字段，类型为数组：assistant 消息为该消息全部 `chat_approvals` 行按 `id` 升序的投影 `{id, tool, title, requestedAt, expiresAt, decision, stepId}`（`decision` 为 `"allow"|"deny"|"timeout"|null`；`stepId` 为 `chat_approvals.step_id`，未配对为 `null`，见「确认与步骤配对」）；user 消息与无审批记录的 assistant 消息为 `[]`。web `session-contract.ts` 的 `hasExactlyKeys` SHALL 同步（消息键集含 `approvals`，数组元素键集恰为上述七键）；归约器 SHALL 以 `approval.request` 按 `approvalId` 为键向对应消息 `approvals` 插入一条 `decision:null`、`stepId` 取事件值的记录（同一 `approvalId` 重复到达——如回放——SHALL 不产生第二条、不覆盖其它审批），以 `approval.resolved` 只更新同一 `approvalId` 记录的 `decision`，以 `step.start` 的 `approvalId` 只设置同一 `approvalId` 记录的 `stepId`（chat-web「纯会话视图归约」），并保持按 `id` 升序。刷新后 pending 审批 SHALL 可从快照恢复并继续作答。

#### Scenario: 刷新后继续作答
- **WHEN** 审批挂起时重新加载页面并请求 messages
- **THEN** running assistant 消息 `approvals=[{id,tool:"bash",title,requestedAt,expiresAt,decision:null,stepId}]`（该 bash 步骤已开始并配上时 `stepId` 为其 id（v18.12.3 与 fake-omp 先 start 后 select，配对在 pump 读到 select 时写入），否则为 `null`），其它消息 `approvals:[]`；页面渲染审批条；此时作答 allow 返回 200 且回合继续

#### Scenario: 历史决定可见
- **WHEN** 回合已 `done` 且审批曾以 deny 结算；一例该审批配上了步骤，另一例没有（`stepId` 为 `null`）
- **THEN** 快照该消息 `approvals[0].decision="deny"`；配上步骤的一例 web 在该步骤卡上显示 `已拒绝` 小标记、消息内没有记录卡；没有配上的一例 web 在消息末尾显示 `已拒绝执行` 兜底记录

#### Scenario: 多条审批的快照与归约
- **WHEN** 同一消息先后收到 `approval.request` `a1`、`a2`，随后收到 `approval.resolved{approvalId:a2,decision:"deny"}`，再重连回放同一批事件
- **THEN** 该消息 `approvals` 为 `[{id:a1,decision:null},{id:a2,decision:"deny"}]`（按 `id` 升序、无重复）；`a1` 仍可作答；重新拉取的快照与归约结果一致
