# Spec delta: turn-control（父 tasks 9.2）

> MODIFIED 两条，文本与主规格 `openspec/specs/turn-control/spec.md` 现文逐字一致（由 change `turn-control-fork-eight-keys`、`slash-escape-branch-align` 等子 change 归档而来）：「从此处分叉 REST」的 201 `session` 为八键、新会话行继承 `workspace_id` / `scene`、`pinned_at` 为 NULL；两条的选条目规则为 chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment、锚点为白名单命令 → 400、fork `draft` 为所存正文。本 change 归档时这两条以本文整段替换，结果与主规格现文相同。

## MODIFIED Requirements

### Requirement: 重新生成 REST
`POST /api/sessions/:id/regenerate` SHALL 受 cookie guard 与 owner 校验（401/404 同 stop），响应 no-store。该路由 SHALL 是无 body 路由且列入 content-parser 归属集：content-parser 错误与任何被解析出的 body SHALL 400 `bad_request`，在认证之后、任何 supervisor 调用之前，无写入。前置校验：会话 `status="running"` 或该会话持有控制占用 SHALL 409 `session_busy`；`status ∈ {done,failed,stopped}` 且末条消息 `role="assistant"` 且其前一条为 `role="user"` 方可执行，否则（含 `idle` 无消息、末条为 user）400 `bad_request`；末条 user 消息的 `content` 被 chat-sessions「Slash 命令白名单与命令目录」的 `classifyPrompt` 判为 `builtin|skill`（白名单命令回合在 omp 分支列表里没有条目）SHALL 同样 400 `bad_request`，判定在上述 409 之后；校验阶段不写任何行。校验通过即登记控制占用（见会话级控制占用），并记下预检读到的末条 assistant id。

执行序：取得该会话进程——若有存活进程则复用；若进程已被回收，SHALL 经与 prompt **相同**的懒 spawn 路径（omp-pool 准入、`--resume <omp_session_file>`、握手、token）取得一个正常 generation：`stream_epoch` 恰 +1 并新建该 generation 的 ring，后续回合事件经该 ring 发布、SSE 语义与普通 prompt 回合一致（准入可能 503 `agent_capacity`，无行变更）→ `request(get_branch_messages)` → 取列表最后一项，其 `text` SHALL 是 SQLite 中该会话末条 user 消息 `content` 的 wire 候选（chat-sessions「Slash 命令白名单与命令目录」Branch alignment：`content` 本身，或 `content` 以 `/` 开头时前置一个 U+0020 的转义形），否则（含列表为空）SHALL 502 `agent_unavailable` 且不改任何行、不发 `branch` → `request(branch{entryId})` → `request(get_state)` 取新 `sessionFile` → SQLite 单事务：先以 CAS 复核会话 `status` 仍非 running 且末条 assistant id 仍等于预检读到的 id，复核失败 SHALL 409 `session_busy`、不改任何行并 retire 该进程；复核通过则删除旧 assistant 行（步骤与审批级联删除）、插入新 `running` 空 assistant 行、`omp_session_file`=新文件、会话 `status="running"`、`updated_at=now` → 以 `branch` 返回的 `text` 在同一 generation 上走既有 prompt 派发（不再 bump epoch）。响应 202 `{assistantMessageId}`（新行 id）。`branch` 之后、事务提交之前的任何失败 SHALL retire 该进程且不改动 `omp_session_file` 与消息行，返回 502 `agent_unavailable`。事务提交之后的派发失败 SHALL 把新 assistant 行与会话结算为 `failed` 并返回 502 `agent_unavailable`，不复活已删除的旧 assistant 行。后续回合事件、刷盘与终态 SHALL 与普通 prompt 回合完全一致。

#### Scenario: 正常重新生成
- **WHEN** 会话 `done`、历史为 user(`"second question"`) → assistant(a1)，fake-omp `branch` 脚本对 `get_branch_messages` 返回 `{messages:[{entryId:"fake-entry-1",text:"first question"},{entryId:"fake-entry-2",text:"second question"}]}`
- **THEN** 202 `{assistantMessageId:<新 id>}`；fake-omp 依次收到 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state`、`prompt{message:"second question"}`；a1 及其步骤行已删除；`omp_session_file` 等于 branch 后 `get_state` 返回的新路径；回合结束后 messages 为 user(`"second question"`) → assistant(新内容, `done`)

#### Scenario: 已回收会话的重新生成取得正常 generation
- **WHEN** 会话 `done` 且其进程已经 `OMP_IDLE_MS` 空闲回收，此时 messages 快照 `streamCursor.epoch=E`，随后调用 regenerate
- **THEN** 202；子进程以 `--resume <omp_session_file>` spawn；`stream_epoch` 恰 +1 一次（`get_branch_messages` 所用获取与随后的 prompt 派发共用这一 generation，不二次递增）；该会话 SSE 收到新 generation 的 `turn.start` … `turn.end(done)`；回合结束后 messages 快照 `streamCursor.epoch=E+1`

#### Scenario: 运行中与形态不满足
- **WHEN** 会话 running 时 regenerate
- **THEN** 409 `session_busy`，无入站帧、无行变更
- **WHEN** 会话 `idle` 无消息、或末条消息为 user、或末条 user 消息为白名单命令（如 `/todo`）
- **THEN** 400 `bad_request`，无入站帧、无行变更
- **WHEN** 已认证 owner 以任何 JSON body（含 `{}`）或 malformed JSON 调用 regenerate
- **THEN** 400 `bad_request`，无 supervisor 调用、无行变更

#### Scenario: 分支文本不一致
- **WHEN** `get_branch_messages` 最后一项 `text` 不是 SQLite 末条 user `content` 的 wire 候选，或返回空列表
- **THEN** 502 `agent_unavailable`；未发送 `branch`；assistant 行、`omp_session_file`、会话状态与 `updated_at` 完全不变；会话随后仍可正常 prompt

#### Scenario: branch 之后提交之前失败
- **WHEN** fake-omp 对 `branch` 正常应答后在 `get_state` 应答前退出（或事务写入抛错）
- **THEN** 502 `agent_unavailable`；该进程被 retire；旧 assistant 行及其步骤、`omp_session_file`、会话 `status` 与 `updated_at` 完全不变；随后对该会话的合法 prompt 以 `--resume <原 omp_session_file>` 重 spawn 并 202

#### Scenario: 最终事务复核失败
- **WHEN** regenerate 的 branch 之后的 `get_state` 已发出、应答尚未到达时，会话行被直接改写为末条 assistant id 不同于预检值（或 `status="running"`）
- **THEN** 409 `session_busy`；事务不写入任何行，旧 assistant 行与 `omp_session_file` 不变；该进程被 retire；占用已释放

#### Scenario: 池满
- **WHEN** `OMP_MAX_PROCESSES=1` 且另一会话在回合中时 regenerate 一个已被回收进程的会话
- **THEN** 503 `agent_capacity`，无行变更

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
