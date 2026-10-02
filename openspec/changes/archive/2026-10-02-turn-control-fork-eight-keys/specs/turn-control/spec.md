# Spec delta: turn-control（#543，父 tasks 9.2）

> MODIFIED 一条，按主规格现文整段重述，只做三处改动：最终事务插入的新会话行写明 `workspace_id` 与 `scene` 复制自源会话、`pinned_at` 为 NULL；201 响应的 `session` 由五键改为八键并写明继承值；末尾追加两个 Scenario，逐字取自 session-metadata「fork 继承会话元数据」。其余字句与既有 Scenario 逐字不变。

## MODIFIED Requirements

### Requirement: 从此处分叉 REST
`POST /api/sessions/:id/fork` SHALL 只接受 `application/json` 且 body 恰为 `{messageId:number}`，其 content-parser 错误由归属集映射为 400 `bad_request`；受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。`messageId` SHALL 属于该会话且 `role="user"`，否则 400 `bad_request`；原会话 `status="running"` 或持有控制占用 SHALL 409 `session_busy`；该消息 `content` 被 chat-sessions「Slash 命令白名单与命令目录」的 `classifyPrompt` 判为 `builtin|skill` SHALL 400 `bad_request`（判定在 409 之后）；原会话 `omp_session_file` 为 NULL SHALL 502 `agent_unavailable`。校验通过即对原会话登记控制占用（见会话级控制占用），并记下预检读到的原会话末条 assistant id。

执行序：若原会话有存活 idle 进程，SHALL 先经既有 retire 序列关停它并等待其退出（数据在会话文件中，无损；名额随退出释放）→ 经 omp-pool 准入起**临时** `SessionRuntime`（同一 spawn 契约、`--resume <原 omp_session_file>`、不绑定任何会话 slot、计入活进程集合）→ `get_branch_messages` → 按 chat-sessions「Slash 命令白名单与命令目录」Branch alignment 把 SQLite 该会话 user 消息（按 `created_at,id` 升序）与返回列表自前向后首次匹配对位（条目 `text` 为该消息 `content` 的 wire 候选时配对并各自前进，否则跳过该消息、不消耗条目），取对位到该 user 消息的项，无对位 SHALL 502 → `branch{entryId}` → `get_state` 取新文件 → 关停临时进程（既有有界 retire，token 撤销）→ SQLite 单事务：先以 CAS 复核源会话 `status` 仍非 running 且其末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 不写任何行并 409 `session_busy`；复核通过则插入新会话行（`owner_id` 同、`title` 复制、`parent_session_id`=原会话 id（列为 `TEXT NULL REFERENCES chat_sessions(id) ON DELETE SET NULL`，删除原会话时分叉会话保留且该列置 NULL）、`omp_session_file`=新文件、`stream_epoch=0`、`workspace_id` 与 `scene` 复制自源会话、`pinned_at` 为 NULL），把原会话中 `(created_at,id)` 严格早于分叉点 user 消息的全部 `chat_messages` 及其 `chat_steps` 与 `chat_approvals` 拷贝到新会话（新 id、保持顺序、`content`/`status`/`created_at`/步骤 `ordinal`/`name`/`detail`/`output`/`status`/时间原值；审批 `request_id`/`tool`/`title`/`requested_at`/`expires_at`/`decision`/`decided_at` 原值，指向拷贝后的新消息 id），分叉点 user 消息本身不拷贝；新会话 `status` SHALL 置为拷贝历史中末条 assistant 消息的状态（`done`/`failed`/`stopped` 之一；该消息仍为 `running` 时视为事务失败），未拷贝任何消息时为 `idle`。响应 201 `{session:{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}, draft:<该 user 消息所存 `content`>}`，`session` 为与其它会话视图相同的八键公共视图（反映上述最终 `status`；`workspaceId` 与 `scene` 为继承自源会话的值，`pinnedAt` 为 null），不暴露 `parent_session_id`。准入 503、`branch` 前后任何失败、无对位 SHALL 不留下新会话行（新会话不存在于 `GET /api/sessions`）并关停临时进程。原会话的行、`omp_session_file` 与会话文件 SHALL 全程不被改写（只读取以复制）；原会话进程 SHALL 不被发送任何帧，其存活 idle 进程在临时进程启动前被 retire（fork 失败时不恢复，下次 prompt 按既有 `--resume` 懒 spawn）。响应返回之前，临时进程 SHALL 已退出并释放名额。

#### Scenario: 正常分叉
- **WHEN** 原会话 `done`、历史 u1(`"first question"`)→a1→u2(`"second question"`)→a2（a1 为 `done`），对 u2 调用 fork，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}` 并在 `branch{entryId:"fake-entry-2"}` 后创建新会话文件
- **THEN** 201 `{session:{id:<新>,title:<原 title>,status:"done",...},draft:"second question"}`；新会话 messages 为 u1、a1（含 a1 步骤与审批，新 id，顺序与内容相同）、`streamCursor:{epoch:0,seq:null}`；`chat_sessions.parent_session_id`=原 id；`omp_session_file` 为新文件路径；原会话行与文件不变；临时进程已退出且原会话进程未收到任何帧；`GET /api/sessions` 同时列出两会话

#### Scenario: 新会话状态随拷贝历史
- **WHEN** 对首条 user 消息 u1 调用 fork，或对 u2 调用 fork 而 a1 为 `stopped`（或 `failed`）
- **THEN** 前者无拷贝消息，新会话 `status="idle"`；后者新会话 `status` 分别为 `stopped`（或 `failed`），且新会话可直接 regenerate 末条助手消息

#### Scenario: 拷贝审批记录
- **WHEN** 被拷贝的 a1 带两条审批（`deny`、`timeout`）时 fork
- **THEN** 新会话中 a1 副本的 `approvals` 按 `id` 升序为两条、`decision` 分别为 `deny`、`timeout`，`tool`/`title`/`requestedAt`/`expiresAt` 原值；原会话审批行不变；无 `decision` NULL 的拷贝行

#### Scenario: 源会话存活进程先退出
- **WHEN** `OMP_MAX_PROCESSES=1`，原会话刚完成回合且其进程仍存活（未到 `OMP_IDLE_MS`），对其 u1 调用 fork
- **THEN** 201；以真实子进程观察，原会话进程在临时进程 spawn 之前已退出，任一时刻活 omp 子进程数 ≤1，不出现两个进程同时打开原会话文件；原会话进程未收到任何帧（仅 stdin 关闭与既有升级序列）；随后原会话 prompt 以 `--resume <原 omp_session_file>` 重 spawn 并 202

#### Scenario: 非法目标与运行中
- **WHEN** `messageId` 为 assistant 消息、属他会话、不存在、其 `content` 为白名单命令（如 `/skill:<已安装>`），或 body 形态不为 `{messageId:number}`
- **THEN** 400 `bad_request`，无新会话行、无进程 spawn
- **WHEN** 原会话 running 时 fork
- **THEN** 409 `session_busy`，无新会话行、无进程 spawn、原会话进程未被 retire

#### Scenario: 对齐失败回滚
- **WHEN** 该 user 消息在 `get_branch_messages` 列表中无对位（轮到它时当前条目的 `text` 不是其 `content` 的 wire 候选，或条目已耗尽）
- **THEN** 502 `agent_unavailable`；无新会话行、`GET /api/sessions` 不含新会话；未发送 `branch`；临时进程已关停；原会话行与文件不变

#### Scenario: fork 最终事务复核失败
- **WHEN** fork 的 `get_state` 应答后、事务提交前，源会话行被直接改写为末条 assistant id 不同于预检值（或 `status="running"`）
- **THEN** 409 `session_busy`；无新会话行、`GET /api/sessions` 不含新会话；事务未拷贝任何行；源会话行与 `omp_session_file` 不变；临时进程已退出；占用已释放

#### Scenario: 池满与临时进程释放
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 fork
- **THEN** 503 `agent_capacity`，无新会话行
- **WHEN** `OMP_MAX_PROCESSES=1` 且无其它活进程时 fork 成功
- **THEN** 201 返回时活进程数为 0，随后对新会话发 prompt 以 `--resume <新文件>` spawn 并 202

#### Scenario: 继承空间与场景、不继承置顶
- **WHEN** owner 对绑定 W、`scene="code"`、已置顶的源会话调用 fork（fake-omp `branch`），随后在新会话发 prompt
- **THEN** 201 的 `session` 为八键，`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；源会话 `pinnedAt` 不变；被拷贝助手消息的 `thinking` 与其步骤的 `changes` 在新会话快照中与源会话逐值相同（NULL 仍为 null）；新会话进程 probe 报告的 `cwd` 为 W 的根；审计无 `session.bind` 新增

#### Scenario: fork 响应的会话视图与列表一致
- **WHEN** owner 对绑定 W、`scene="design"`、已置顶的源会话调用 fork 成功，随后 `GET /api/sessions`
- **THEN** 201 响应的 `session` 恰为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`，`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`，且与 `GET /api/sessions` 中同 id 条目逐键相等
