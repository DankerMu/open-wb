# Spec delta: turn-control（#466 fork 的 supervisor 编排与控制占用的 fork 部分）

> 父 delta「从此处分叉 REST」由 #466（supervisor）与 #469（5.2b REST 路由）分担，「会话级控制占用」由 #465/#466/#467 分担。本 issue（父 tasks 4.5）只交付 supervisor 侧：`SessionSupervisor.fork` 与控制占用的 fork 部分。
> - 「从此处分叉 REST」（ADDED，主 spec 尚无此块，只含本刀交付部分）：
>   - 首段去掉路由、`application/json`、`{messageId:number}` 形态、content-parser、cookie/owner（401/404）与 no-store 句 → #469；其余逐字取父文。
>   - 执行序按 proposal「偏离与决定」1 改写：新会话行不在 RPC 之前插入，而在 CAS 事务内插入（列值与父文相同，`status` 由「保持 `idle`」改为「为 `idle`」）；父文「删除已建的新会话行」各处改为「不留下新会话行」。父 delta 归档对账时须采纳这一改写。
>   - 「响应 201 `{session, draft}`」改为 fork 调用以 `{session, draft}` 兑现，由 #469 路由包装成 201；末句「响应返回前临时进程 SHALL 已退出」相应改为「fork 调用兑现或拒绝之前」。
>   - 自写括注（父 delta 没有，归档时须采纳）：拷贝历史末条 assistant 仍为 `running` 时视为事务失败。
>   - Scenario：
>     - 「正常分叉」按假 omp 固定列表改写 entryId 与原文（父文 `e1/e2` 列表不可满足，#465 同例）；
>     - 「非法目标与运行中」去掉 body 形态一支 → #469，保留父标题；
>     - 各 Scenario 的「201」改为「兑现」，「新会话行已删除」改为「无新会话行」；
>     - 「fork 最终事务复核失败」保留父文时点：fork 的 `get_state` 应答与事务之间隔着临时进程关停（等子进程退出，是真实的 I/O 边界），该时点可构造。
> - 「会话级控制占用」（MODIFIED）：以主 spec 原文为底，并入父文的 fork 部分——登记方「fork（占用的是**源**会话）」、「响应返回（fork、stop…）」、「regenerate、fork 请求 … 一律 409」、「与该操作的临时进程」。prompt 的「不写任何行」要求 REST 在受理前查占用，仍归 #467。
>   - Scenario「regenerate 各 RPC 间隙的并发请求」：注入请求由「regenerate」扩为「regenerate 或 fork」（#465 延后）；prompt 的注入 → #467。原因：该 Scenario 断言注入请求「未新增或修改任何行」（过程中也不写），而今天的 REST prompt 注入是 `acceptPrompt` → supervisor 拒绝 → `rollbackPrompt`，有瞬时写入；受理前拒绝要等 #467。
>   - Scenario「fork 各 RPC 间隙的并发请求」（父文）：注入时点改为「应答未到」，理由同 #465：父文「X 应答后」与下一次写帧之间只有微任务，没有 I/O 或宏任务边界，外部请求插不进来。另自写一个可构造的间隙「临时进程关停未完成」（归档时父 delta 须采纳）。「原 fork 照常 201」改为「照常兑现」。注入请求保留父文的 prompt：该 Scenario 只断言终态（源会话行、文件不变），瞬时写入经 `rollbackPrompt` 补偿后终态不变，今天即可兑现。
>   - Scenario「失败后释放占用」取父文（补回 fork 一支）；其余主 spec Scenario 原样。

## ADDED Requirements

### Requirement: 从此处分叉 REST
`messageId` SHALL 属于该会话且 `role="user"`，否则 400 `bad_request`；原会话 `status="running"` 或持有控制占用 SHALL 409 `session_busy`；原会话 `omp_session_file` 为 NULL SHALL 502 `agent_unavailable`。校验通过即对原会话登记控制占用（见会话级控制占用），并记下预检读到的原会话末条 assistant id。

执行序：若原会话有存活 idle 进程，SHALL 先经既有 retire 序列关停它并等待其退出（数据在会话文件中，无损；名额随退出释放）→ 经 omp-pool 准入起**临时** `SessionRuntime`（同一 spawn 契约、`--resume <原 omp_session_file>`、不绑定任何会话 slot、计入活进程集合）→ `get_branch_messages` → 在返回列表中取序号等于该 user 消息在 SQLite 该会话 user 消息中序号（按 `created_at,id` 升序，从 0 起）的项，其 `text` SHALL 等于该消息 `content`，序号越界或文本不等 SHALL 502 → `branch{entryId}` → `get_state` 取新文件 → 关停临时进程（既有有界 retire，token 撤销）→ SQLite 单事务：先以 CAS 复核源会话 `status` 仍非 running 且其末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 不写任何行并 409 `session_busy`；复核通过则插入新会话行（`owner_id` 同、`title` 复制、`parent_session_id`=原会话 id（列为 `TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`，删除原会话时分叉会话保留且该列置 NULL）、`omp_session_file`=新文件、`stream_epoch=0`），把原会话中 `(created_at,id)` 严格早于分叉点 user 消息的全部 `chat_messages` 及其 `chat_steps` 与 `chat_approvals` 拷贝到新会话（新 id、保持顺序、`content`/`status`/`created_at`/步骤 `ordinal`/`name`/`detail`/`output`/`status`/时间原值；审批 `request_id`/`tool`/`title`/`requested_at`/`expires_at`/`decision`/`decided_at` 原值，指向拷贝后的新消息 id），分叉点 user 消息本身不拷贝；新会话 `status` SHALL 置为拷贝历史中末条 assistant 消息的状态（`done`/`failed`/`stopped` 之一；该消息仍为 `running` 时视为事务失败），未拷贝任何消息时为 `idle`。fork 调用以 `{session:{id,title,status,createdAt,updatedAt}, draft:<branch 返回的 text>}` 兑现，`session` 为既有公共视图（反映上述最终 `status`），不暴露 `parent_session_id`。准入 503、`branch` 前后任何失败、文本/序号不一致 SHALL 不留下新会话行（新会话不存在于 `GET /api/sessions`）并关停临时进程。原会话的行、`omp_session_file` 与会话文件 SHALL 全程不被改写（只读取以复制）；原会话进程 SHALL 不被发送任何帧，其存活 idle 进程在临时进程启动前被 retire（fork 失败时不恢复，下次 prompt 按既有 `--resume` 懒 spawn）。fork 调用兑现或拒绝之前，临时进程 SHALL 已退出并释放名额。

#### Scenario: 正常分叉
- **WHEN** 原会话 `done`、历史 u1(`"first question"`)→a1→u2(`"second question"`)→a2（a1 为 `done`），对 u2 调用 fork，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}` 并在 `branch{entryId:"fake-entry-2"}` 后创建新会话文件
- **THEN** fork 兑现 `{session:{id:<新>,title:<原 title>,status:"done",...},draft:"second question"}`；新会话 messages 为 u1、a1（含 a1 步骤与审批，新 id，顺序与内容相同）、`streamCursor:{epoch:0,seq:null}`；`chat_sessions.parent_session_id`=原 id；`omp_session_file` 为新文件路径；原会话行与文件不变；临时进程已退出且原会话进程未收到任何帧；`GET /api/sessions` 同时列出两会话

#### Scenario: 新会话状态随拷贝历史
- **WHEN** 对首条 user 消息 u1 调用 fork，或对 u2 调用 fork 而 a1 为 `stopped`（或 `failed`）
- **THEN** 前者无拷贝消息，新会话 `status="idle"`；后者新会话 `status` 分别为 `stopped`（或 `failed`），且新会话可直接 regenerate 末条助手消息

#### Scenario: 拷贝审批记录
- **WHEN** 被拷贝的 a1 带两条审批（`deny`、`timeout`）时 fork
- **THEN** 新会话中 a1 副本的 `approvals` 按 `id` 升序为两条、`decision` 分别为 `deny`、`timeout`，`tool`/`title`/`requestedAt`/`expiresAt` 原值；原会话审批行不变；无 `decision` NULL 的拷贝行

#### Scenario: 源会话存活进程先退出
- **WHEN** `OMP_MAX_PROCESSES=1`，原会话刚完成回合且其进程仍存活（未到 `OMP_IDLE_MS`），对其 u1 调用 fork
- **THEN** fork 兑现；以真实子进程观察，原会话进程在临时进程 spawn 之前已退出，任一时刻活 omp 子进程数 ≤1，不出现两个进程同时打开原会话文件；原会话进程未收到任何帧（仅 stdin 关闭与既有升级序列）；随后原会话 prompt 以 `--resume <原 omp_session_file>` 重 spawn 并 202

#### Scenario: 非法目标与运行中
- **WHEN** `messageId` 为 assistant 消息、属他会话或不存在
- **THEN** 400 `bad_request`，无新会话行、无进程 spawn
- **WHEN** 原会话 running 时 fork
- **THEN** 409 `session_busy`，无新会话行、无进程 spawn、原会话进程未被 retire

#### Scenario: 对齐失败回滚
- **WHEN** `get_branch_messages` 在目标序号处的 `text` 与该 user 消息 `content` 不等，或列表长度不足
- **THEN** 502 `agent_unavailable`；无新会话行、`GET /api/sessions` 不含新会话；未发送 `branch`；临时进程已关停；原会话行与文件不变

#### Scenario: fork 最终事务复核失败
- **WHEN** fork 的 `get_state` 应答后、事务提交前，源会话行被直接改写为末条 assistant id 不同于预检值（或 `status="running"`）
- **THEN** 409 `session_busy`；无新会话行、`GET /api/sessions` 不含新会话；事务未拷贝任何行；源会话行与 `omp_session_file` 不变；临时进程已退出；占用已释放

#### Scenario: 池满与临时进程释放
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 fork
- **THEN** 503 `agent_capacity`，无新会话行
- **WHEN** `OMP_MAX_PROCESSES=1` 且无其它活进程时 fork 成功
- **THEN** fork 兑现时活进程数为 0，随后对新会话发 prompt 以 `--resume <新文件>` spawn 并 202

## MODIFIED Requirements

### Requirement: 会话级控制占用
supervisor SHALL 按 `sessionId` 维护"控制占用"（control claim）。regenerate、fork（占用的是**源**会话）与 stop 在前置校验通过的同一同步段内登记占用，持有至该操作的 prompt 派发完成（regenerate）或响应返回（fork、stop，以及任何失败路径），并 SHALL 在每一种结束路径（2xx、409、400、502、503、异常）上释放，使失败后会话仍可正常使用。占用 SHALL 按持有次数计数：同一会话可同时有多个持有者（如 regenerate 执行中到达的 stop），每个持有者只释放自己登记的那一次，全部释放后占用才解除；supervisor SHALL 提供同步可读的"该会话是否持有控制占用"判定，供受理前拒绝使用。持有占用期间，同一会话的 regenerate、fork 请求 SHALL 一律 409 `session_busy`，不写任何行、不向进程发帧、不 spawn。stop 不受占用阻塞、永不因占用返回 409：它按会话 `status` 判定（非 running → 204；running 而 prompt 尚未派发 → 停止意图，见停止生成 REST；regenerate 派发后即为普通 running 回合，可正常停止）。持有占用的会话，其进程与该操作的临时进程在 omp-pool 中视为"回合中"，不可被驱逐。

#### Scenario: regenerate 各 RPC 间隙的并发请求
- **WHEN** 会话 `done`，regenerate 执行中，分别在进程已准入而 `ready` 未到、`get_branch_messages` 应答未到、`branch` 应答未到、branch 之后的 `get_state` 应答未到（事务提交前）时向同一会话注入 regenerate 或 fork 请求
- **THEN** 每个注入请求均 409 `session_busy`；注入请求未新增或修改任何 `chat_messages`/`chat_steps`/`chat_sessions` 行，未改动 `omp_session_file` 与会话文件，fake-omp 未收到注入请求引起的任何帧；原 regenerate 照常兑现并完成回合

#### Scenario: fork 各 RPC 间隙的并发请求
- **WHEN** fork 执行中，分别在临时进程已准入而 `ready` 未到、`get_branch_messages` 应答未到、`branch` 应答未到、`get_state` 应答未到、临时进程关停未完成（事务提交前）时向**源**会话注入 prompt、regenerate 或 fork
- **THEN** 每个注入请求均 409 `session_busy`，源会话行、`omp_session_file` 与文件不变，无额外 spawn；原 fork 照常兑现

#### Scenario: 失败后释放占用
- **WHEN** regenerate 因分支文本不一致 502、因池满 503，或 fork 因对齐失败 502 结束
- **THEN** 响应返回时占用已释放：随后对该会话的合法 prompt 返回 202

#### Scenario: stop 持有占用且不被占用阻塞
- **WHEN** 会话 A 回合进行中调用 stop；另一次，A 的 regenerate 持有占用（`branch` 应答未到）时对 A 调用 stop
- **THEN** 前者 stop 调用期间 A 持有控制占用、调用返回后占用解除，stop 不因占用被拒；后者 stop 正常返回且不写任何帧，返回后 A 仍持有占用（stop 的释放不抵消 regenerate 的登记），regenerate 照常完成后占用解除
