# message-undo Specification

## Purpose
定义「撤回」：把会话原地退回到某条用户消息之前——`POST /api/sessions/:id/undo` 的前置校验、临时进程编排、提交与通知，文件随快照还原（`restore` / `force` / `keep`）与冲突判定，消息视图的 `undo` 键与五种不可撤回原因，以及 web 侧的撤回按钮、草稿回填、冲突对话框与未还原文件说明。快照的制作与还原本身由 workspace-snapshots 定义。

## Requirements

### Requirement: 可撤回状态
消息视图（`GET /api/sessions/:id/messages` 的每条消息）SHALL 增加键 `undo`：助手消息恒为 `null`；用户消息为下列字符串之一，由该消息的 `chat_turn_snapshots` 行与会话决定：
- `available`：有行且 `outcome='ok'`；
- `too_large`、`failed`、`command`：有行且 `outcome` 为同名值；
- `unbound`：没有行且会话 `workspace_id` 为 NULL；
- `none`：没有行且会话已绑定工作空间（本能力上线之前的消息、fork 拷贝来的消息、快照行写入失败或快照进行中进程被杀的消息）。

两条收窄是 owner 2026-10-06 的补充决定，不是待定项：白名单命令回合（`/todo`、`/skill:…`）的用户消息 SHALL NOT 能单独撤回（`command`；撤回它之前的一条普通消息会把它连带移除）——RPC 模式下这类回合在 `get_branch_messages` 里没有条目，无从对位；fork 拷贝来的消息 SHALL NOT 能撤回（`none`；fork 不拷贝快照行），分叉之后在新会话里新发的消息照常有自己的快照行、可以撤回。

prompt 路由的 202 SHALL 为 `{userMessageId, assistantMessageId, undo}`，`undo` 是刚受理的那条用户消息的同一取值（此时快照行已写入）。fork 拷贝的消息在新会话里没有快照行；regenerate 不改变任何消息的 `undo`。`undo` 是只读派生值，不能经任何 REST 写入。

#### Scenario: 各取值
- **WHEN** 绑定会话依次发送一条普通 prompt、一条 `/todo`、一条在超出总量上限时发送的 prompt、一条在 `take` 被注入失败时发送的 prompt；另有一个直接写库构造的未绑定会话发送一条 prompt
- **THEN** 五次 202 的 `undo` 依次为 `available`、`command`、`too_large`、`failed`、`unbound`；随后读取快照，这些用户消息的 `undo` 与各自的 202 相同，每条助手消息的 `undo` 为 `null`

#### Scenario: 分叉拷贝与存量消息
- **WHEN** 对一个各消息均为 `available` 的会话在第二条用户消息处 fork；另有一个在迁移 039 之前就存在消息的绑定会话
- **THEN** 新会话里拷贝来的用户消息 `undo` 为 `none`；存量会话的用户消息 `undo` 为 `none`

### Requirement: 撤回 REST
`POST /api/sessions/:id/undo` SHALL 受 cookie guard 与 owner 预检（未认证 401；不存在或属他人 404 `not_found`，与未知 id 相同，均先于 body 解析），响应 `Cache-Control: no-store`，属于 content-parser 归属集（content-parser 错误 400 `bad_request`）。body SHALL 恰为 `{messageId:number, files:"restore"|"force"|"keep"}`：其它形状、缺键、多余键、`messageId` 不是安全整数、`files` 为其它值 SHALL 400 `bad_request`。前置校验 SHALL 按以下次序进行，全部不写任何行、不向任何进程发帧、不 spawn、不改动任何文件：
1. 会话已归档 → 409 `session_archived`；
2. 会话 `status="running"` 或其控制占用被持有 → 409 `session_busy`；
3. `messageId` 不是该会话的 `role="user"` 消息 → 400 `bad_request`；
4. 该消息的 `undo` 不是 `available` → 400 `bad_request`（无论 `files` 取何值）；
5. 会话 `omp_session_file` 为 NULL → 502 `agent_unavailable`；
6. `files` 为 `restore` 或 `force`，且存在另一个 `workspace_id` 相同、`status="running"` 的会话 → 409 `session_busy`；
7. `files` 为 `restore` 且存在冲突（「共用空间冲突」的判据，只读数据库）→ 409 `undo_conflict`。

校验通过即登记该会话的控制占用（turn-control「会话级控制占用」），持有至本次调用结束并在每一种结束路径上释放；持有期间同一会话的 prompt、regenerate、fork、undo、DELETE SHALL 409 `session_busy`。成功 SHALL 返回 200 `{session, draft, files, attachments}`：`session` 为撤回后的会话视图，`draft` 为被撤回消息所存的 `content` 原文（不带转义空格；只发附件的消息为空串），`files` 见「文件还原与结果」，`attachments` 为被撤回消息所存的附件（message-attachments「附件落库与快照」）里撤回完成后仍然存在的那些——按存储次序，元素恰为所存的 `{path, size}`；该消息没有附件或它们都已不存在时为 `[]`。所存的附件数组 SHALL 在「对话原地回退」第 5 步删除该消息行之前读出；是否存在 SHALL 在第 4 步的文件还原（`files` 不是 `keep` 时）之后判定：路径按 sandbox-core「resolve 契约与逃逸向量」（`op=read`）在该会话的工作空间内解析成功，且目标经 `lstat`（不跟随符号链接）是普通文件，即为存在。这一判定是服务端读回它受理时校验过的路径，不是用户请求：SHALL 使用不写审计的解析（不产生 `sandbox.reject`），解析被拒或 `lstat` 出错都按不存在处理，SHALL NOT 使撤回失败，也不读取文件内容。

#### Scenario: 形状与鉴权
- **WHEN** 所有者以 `{}`、`{messageId:1}`、`{messageId:"1",files:"restore"}`、`{messageId:1,files:"yes"}`、`{messageId:1,files:"keep",x:1}`、`[]`、malformed JSON、`text/plain` body 调用 undo
- **THEN** 均 400 `bad_request` 与 no-store，无行变化、无进程变化
- **WHEN** 匿名请求、他人会话、不存在的会话调用 undo（含非法 body）
- **THEN** 分别 401、404、404（后两者逐字相同），先于 body 解析

#### Scenario: 前置校验的各拒绝
- **WHEN** 分别对：已归档会话；回合进行中的会话；regenerate 正持有占用的会话；`messageId` 为助手消息、别的会话的消息或不存在的 id；`undo` 为 `command`、`too_large`、`failed`、`none` 的消息（`files` 取 `keep`）；一个 `workspace_id` 为 NULL 的存量会话的消息 调用 undo
- **THEN** 依次为 409 `session_archived`；409 `session_busy`；409 `session_busy`；三次 400；四次 400；400。每一次之后会话的消息行、`omp_session_file`、工作空间文件与快照目录都没有变化，fake omp 没有收到任何帧，没有新进程

#### Scenario: 撤回期间的并发请求
- **WHEN** undo 的临时进程 `branch` 应答未到时，对同一会话发 prompt、regenerate、fork、第二个 undo 与 DELETE
- **THEN** 五者均 409 `session_busy`；原 undo 照常 200；之后对该会话的 prompt 返回 202

#### Scenario: 响应带回仍存在的附件
- **WHEN** 用户消息 u2 受理时带附件 `uploads/a.pdf` 与 `uploads/b.png`，其后的回合里 `uploads/b.png` 被删除；所有者 undo `{messageId:<u2>, files:"keep"}`；另一例同样的前提以 `files:"restore"` 撤回（u2 的快照里有这两个文件）；再一例撤回一条不带附件的消息；再一例 u2 的附件路径在受理之后被带外换成了符号链接
- **THEN** 第一例 200 的 `attachments` 恰为 `[{path:"uploads/a.pdf", size:<所存大小>}]`；第二例两项都在、次序与所存相同（`b.png` 已被还原）；第三例为 `[]`；第四例不含那一项；四例的 body 都恰含 `session`、`draft`、`files`、`attachments` 四键，审计都没有新增 `sandbox.reject`
- **WHEN** 被撤回的 u2 只有附件（`content` 为空串、附件 `uploads/a.pdf`，fake omp 的条目文本为附件后缀本身），所有者以 `files:"keep"` 撤回
- **THEN** 200；`draft` 为 `""`，`attachments` 为 `[{path:"uploads/a.pdf", size:<所存大小>}]`；对位成功（不是 502）

### Requirement: 对话原地回退
校验通过后，undo SHALL 按以下次序执行（fork 的进程策略，作用于当前会话）：
1. 经既有有界 retire 序列关停该会话的存活进程（如有）并等待其退出；其 slot 与事件环丢弃，已连接的单会话事件流订阅结束。
2. 经 omp-pool 准入一个**临时** `SessionRuntime`（与 fork 相同的 spawn 契约、`--resume <omp_session_file>`、`--cwd` 为该会话的工作目录、不绑定 slot、不是 generation、不改 `stream_epoch`、不拥有事件环）；准入失败 503 `agent_capacity`。
3. `get_branch_messages` → 按 chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment 自前向后首次匹配对位，取对位到该用户消息的条目；无对位 SHALL 502 `agent_unavailable`，不发 `branch` → `branch{entryId}` → `get_state` 取新 `sessionFile` → 关停临时进程（token 撤销、名额释放）。任何失败 SHALL 502 `agent_unavailable` 并关停临时进程。
4. `files` 不是 `keep` 时还原工作空间（「文件还原与结果」）。
5. 一个 SQLite 事务：先以 CAS 复核会话仍非 `running`、未归档、其末条助手消息 id 等于前置校验读到的值、该用户消息行仍在；复核失败 SHALL 不写任何行并 409 `session_busy`。复核通过则：删除该会话中 `(created_at,id)` 不早于该用户消息的全部 `chat_messages` 行（其 `chat_steps`、`chat_approvals`、`chat_turn_snapshots` 行随外键级联删除）；把 `omp_session_file` 置为新文件；`status` 置为剩余消息中末条助手消息的状态（`done` / `failed` / `stopped`），没有剩余助手消息时为 `idle`；`updated_at` 置为当前毫秒；`todo` 置为被撤回消息快照行的 `todo` 值（含 NULL）；写一条 `session.undo` 审计（「撤回审计与通知」）。`title`、`scene`、`pinned_at`、`archived_at`、`workspace_id`、`stream_epoch`、`parent_session_id` SHALL 不变。审计失败则事务回滚。
6. 提交后：删除被移除的各用户消息的快照目录（workspace-snapshots「快照清理」）；发通知；返回 200。

第 1–4 步的任何失败 SHALL 不改动任何 `chat_*` 行与 `omp_session_file`（被退役的进程不恢复，下次 prompt 按既有 `--resume` 懒 spawn）。响应返回之前临时进程 SHALL 已退出。被放弃的旧会话文件与 `branch` 失败时可能产生的新文件留在磁盘上，与 regenerate 的旧分支文件同一处理（不在删除清理范围内）。撤回之后，该会话的下一条 prompt SHALL 以 `--resume <新文件>` 冷启动一个新 generation（`stream_epoch` 按既有规则 +1），模型看到的历史不含被撤回的消息及其后的内容。撤回的编排 SHALL 位于 `server/src/sessions/` 下的独立模块，其导出只供 `sessions/` 内使用；`store.ts` 与 `supervisor.ts` 不因此越过 800 行上限。

#### Scenario: 撤回中间的一条
- **WHEN** 会话 `done`、历史 u1→a1→u2→a2→u3→a3（a1 `done`，含步骤与一条 `allow` 审批），各用户消息 `undo` 为 `available`，fake omp `branch` 场景对 `get_branch_messages` 返回三条与之文本一致的条目；所有者 undo `{messageId:<u2>, files:"keep"}`
- **THEN** 200；`draft` 等于 u2 的原文；快照读取恰剩 u1、a1（内容、步骤、审批与撤回前逐值相同）；`session.status` 为 `done`；`omp_session_file` 等于 `branch` 之后 `get_state` 返回的新路径；fake 临时进程依次收到 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state` 后退出；会话原有的存活进程在临时进程 spawn 之前已退出；`stream_epoch` 未变

#### Scenario: 撤回第一条
- **WHEN** 对同一会话 undo `{messageId:<u1>, files:"keep"}`
- **THEN** 200；消息列表为空；`session.status` 为 `idle`；`title` 与撤回前相同；随后发送一条 prompt 返回 202，其进程以 `--resume <新文件>` 启动

#### Scenario: 剩余历史的状态
- **WHEN** a1 为 `stopped`（或 `failed`）时撤回 u2
- **THEN** `session.status` 分别为 `stopped`（或 `failed`）

#### Scenario: 任务清单回到当时
- **WHEN** u2 受理时会话的任务清单为 T1，其后的回合把它变成了 T2，撤回 u2
- **THEN** 会话快照的 `todo` 深等于 T1；u2 受理时清单为空的另一例撤回后 `todo` 为 `null`

#### Scenario: 对位失败与进程失败
- **WHEN** 该用户消息在 `get_branch_messages` 里无对位；或 fake omp 在 `branch` 应答后、`get_state` 应答前退出；或池已满
- **THEN** 分别 502、502、503；消息行、`omp_session_file`、会话状态、`updated_at` 与工作空间文件完全不变；临时进程已退出；占用已释放，随后的 prompt 以 `--resume <原文件>` 启动并 202

#### Scenario: 最终事务复核失败
- **WHEN** `get_state` 应答后、事务提交前，会话行被直接改写为 `status="running"`
- **THEN** 409 `session_busy`；没有消息行被删除；`omp_session_file` 不变

#### Scenario: 撤回后模型看不到被撤回的内容
- **WHEN** 在真实 omp（`make ui-walk` 的栈）上，会话只有一轮，撤回这条用户消息后发送一条新消息并等回合结束，再对这条新消息调用 fork
- **THEN** 新回合正常完成；fork 返回 201——分支对位要求 omp 当前分支上的用户条目恰与存储的用户消息一一对应，被撤回的那一条若仍在分支上，对位会失败并得到 502

### Requirement: 文件还原与结果
`files` 为 `restore` 或 `force` 时，undo SHALL 在「对话原地回退」的第 4 步，用被撤回消息的快照（`<快照根>/<workspaceId>/<messageId>`）对会话的工作空间根调用 workspace-snapshots「还原」，使工作空间回到该消息发出之前的状态（快照里有的都还原，含 `.git`；`skipped` 里的路径——超限文件、排除的依赖目录、读不了的条目、挂载点——以及还原时才发现的挂载点（含其下在快照里的条目）保持现状）；`force` 与 `restore` 的差别只在前置校验是否因冲突而拒绝。`files` 为 `keep` 时 SHALL NOT 读取快照、SHALL NOT 改动工作空间内的任何条目。还原在本会话没有存活进程时进行（第 1 步已退役）。还原抛错（清单缺失或损坏、工作空间根不是目录等结构性失败）SHALL 使请求以通用 5xx 结束，不执行第 5 步，对话保持原样；再次请求可重试。

200 的 `files` SHALL 为 `{mode, restored, removed, skipped, failed}`：`mode` 为 `restored`（`restore` / `force`）或 `kept`（`keep`）；`restored`（内容被写回的文件数与被重建的符号链接数）、`removed`（被删除的条目数）为非负整数，取自 workspace-snapshots「还原」的返回值（`kept` 时为 0）；`skipped` 为 `{count, paths}`，`paths` 是至多 200 项 `{path, reason}`（`reason` ∈ `too_large|excluded|unreadable|special|name_encoding|mount`），`count` 是总数；`failed` 为 `{count, paths}`，`paths` 是至多 200 项 `{path}`。`kept` 时二者均为 `{count:0, paths:[]}`。其中的 `path` 都是相对工作空间根的路径，SHALL NOT 含绝对路径。个别条目还原失败（进入 `failed`）SHALL NOT 使请求失败：对话照常回退。

#### Scenario: 连文件一起还原
- **WHEN** 绑定工作空间 W 的会话，第二轮（u2）里 fake omp `edit-write` 场景改写了 `a.txt` 并新建了目录 `out/` 与其下的 `out/b.html`；所有者 undo `{messageId:<u2>, files:"restore"}`
- **THEN** 200；`files.mode` 为 `restored`、`restored` 为 1（只有内容被写回的 `a.txt`）、`removed` 为 1（那一轮新建的 `out/`，连同其下的 `b.html` 计一项）、`failed.count` 为 0；W 的根下 `a.txt` 为 u2 发出前的内容，`out/b.html` 不存在；消息列表恰剩 u2 之前的消息

#### Scenario: 只撤回对话
- **WHEN** 同样的会话以 `files:"keep"` 撤回 u2
- **THEN** 200；`files` 为 `{mode:"kept",restored:0,removed:0,skipped:{count:0,paths:[]},failed:{count:0,paths:[]}}`；`a.txt` 与 `out/b.html` 保持第二轮之后的内容

#### Scenario: 一次退回多轮
- **WHEN** 三轮各改动了不同的文件，以 `files:"restore"` 撤回第一条用户消息
- **THEN** 工作空间回到第一条消息发出之前的状态（三轮的改动全部消失）；消息列表为空

#### Scenario: 超限文件不还原并列出
- **WHEN** u2 的快照 `skipped` 含 `big.bin`（`too_large`），第二轮改动了 `big.bin` 与 `a.txt`，以 `restore` 撤回 u2
- **THEN** `a.txt` 被还原，`big.bin` 保持改动后的内容；`files.skipped` 为 `{count:1,paths:[{path:"big.bin",reason:"too_large"}]}`

#### Scenario: 版本库连同提交一起还原
- **WHEN** 工作空间含 `.git/refs/heads/main`（内容为提交 A 的哈希）；u2 的回合期间 `src/app.ts` 被改写、`.git/refs/heads/main` 被改为提交 B 的哈希、`.git/objects/` 下新增一个对象文件（等价于回合里做了一次提交；测试直接写这些文件，不依赖宿主装有 git）；所有者以 `files:"restore"` 撤回 u2
- **THEN** 200；`.git/refs/heads/main` 的内容回到提交 A，那一轮新增的对象文件不存在，`src/app.ts` 为 u2 发出前的内容；`files.skipped` 不含 `.git`

#### Scenario: 还原的结构性失败
- **WHEN** u2 的快照目录在磁盘上被移走后以 `restore` 撤回 u2
- **THEN** 响应为通用 5xx；消息行与 `omp_session_file` 不变；以 `files:"keep"` 重试得到 200

### Requirement: 共用空间冲突
撤回带文件还原时，宿主 SHALL 判定是否有别的会话在被撤回消息发出之后还在用同一个工作空间。记被撤回的会话为 S、被撤回的用户消息为 M、`T = M.created_at`。**冲突**当且仅当存在另一个会话 B 同时满足：
1. `B.id != S.id`，`B.owner_id = S.owner_id`，`B.workspace_id = S.workspace_id`；
2. B **自己活动过**，即以下任一成立：`chat_turn_snapshots` 里至少有一行的 `message_id` 是 B 的消息（任何 `outcome`，含 `command`）；或 `B.updated_at > B.created_at`。会话创建与 fork 都把两列写成同一时刻，fork 不拷贝快照行，PATCH（改名、置顶、归档）与任务清单写入不动 `updated_at`，所以只有拷贝来的历史、自己从未活动过的分叉会话（以及从未发过消息的新会话）不满足本条；回合受理、终态结算、regenerate 提交与撤回提交都把 `updated_at` 写为当时的时刻，其中 regenerate 不写快照登记行（workspace-snapshots「受理时做快照」），只靠后一支被认出；
3. B 的最近一次活动不能证明早于 T，即以下任一成立：
   - (a) B 有一行自己的快照登记 `created_at >= T`（在 M 之后受理过回合）；
   - (b) `B.updated_at >= T`（B 的某个回合在 M 之后才结算，或 B 在 M 之后做过重新生成 / 撤回——回合受理、终态结算、regenerate 提交与撤回提交都把 `updated_at` 写为当时的时刻）；
   - (c) `B.status = 'failed'` 且 `B.updated_at` 等于 B 末条助手消息的 `created_at`（该回合没有经过终态结算，是启动对账把它置为 `failed` 的，对账不写结束时刻；它何时停止写文件无从得知，按「可能在 M 之后」处理）。

判定只读数据库（上述三张表的列），不比较文件、不读 `chat_steps.changes`（它不记 bash 等途径的改动）。它是保守的：B 在那段时间里可能根本没动文件，此时仍判为冲突（多弹一次对话框）；反过来，只要 B 的会话行还在，凡经 B 的回合（含重新生成的回合、登记行写入失败的回合、本能力上线之前就存在的会话在上线后跑的回合）发生在 T 之后的文件改动都会被判为冲突；B 在 T 之后跑过回合、随后自己把它撤回掉的，同样判为冲突（撤回提交把 `B.updated_at` 写为当时的时刻）。不构成冲突的情形 SHALL 恰为两种：不经会话回合发生的文件改动（文件页的操作）；B 在 T 之后跑过回合、随后 B 被整个删除（会话行、消息行与登记行都已不在，库里没有可供判定的记录，它留下的文件与手工改动同类）。

`files:"restore"` 遇冲突 SHALL 409 `undo_conflict`，不改动任何行、文件或进程；`files:"force"` 与 `files:"keep"` 不做冲突判定。另一个同空间会话此刻 `running` 时，`restore` 与 `force` 都 SHALL 409 `session_busy`（「撤回 REST」第 6 步，先于冲突判定），`keep` 不受影响——所以冲突判定只需回答「已经不在运行的 B 是否在 T 之后活动过」。会话独占其工作空间（没有别的会话引用同一 `workspace_id`）时永不冲突。

#### Scenario: 别的会话在那之后有过回合
- **WHEN** S 与其 fork 产生的 F 共用工作空间；S 的 u2 发出之后 F 完成了一轮；所有者对 S undo `{messageId:<u2>, files:"restore"}`
- **THEN** 409 `undo_conflict`（message `其它会话在这之后改动过工作空间`）；S 的消息行、文件与快照都不变
- **WHEN** 随后以 `files:"keep"` 重发
- **THEN** 200；S 的对话回退，工作空间文件不变
- **WHEN** 另一例以 `files:"force"` 重发
- **THEN** 200；工作空间回到 S 的 u2 发出之前的状态（F 那一轮写的文件随之消失）

#### Scenario: 重叠回合
- **WHEN** S 与 B 共用工作空间；在受控的时刻下 B 在 t1 受理一个回合（fake omp 挂起），S 在 t2 > t1 受理并完成 u2，B 的回合在 t3 > t2 写入 `late.txt` 后结束（B 回到 `done`，B 的全部消息 `created_at` 都是 t1）；所有者对 S undo `{messageId:<u2>, files:"restore"}`
- **THEN** 409 `undo_conflict`；`late.txt` 仍在，S 的消息行与快照不变

#### Scenario: 仅有 fork 拷贝行的会话不算
- **WHEN** S 历史为 u1→a1→u2→a2，在 u2 处 fork 出 F（F 里是拷贝来的 u1、a1，其 `created_at` 与 S 的相同），F 一轮都没有跑；所有者对 S undo `{messageId:<u1>, files:"restore"}`
- **THEN** 200，不出现 `undo_conflict`；`chat_turn_snapshots` 里没有指向 F 的消息的行，`F.updated_at` 等于 `F.created_at`

#### Scenario: 分叉会话只重新生成过拷贝来的末轮
- **WHEN** S 历史为 u1→a1→u2→a2，在 u2 处 fork 出 F（F 里是拷贝来的 u1、a1）；S 随后发出 u3 并完成；之后在 F 里对拷贝来的 a1 重新生成，该回合写入 `regen.txt` 后结束（`chat_turn_snapshots` 里没有指向 F 的消息的行，`F.updated_at` 晚于 `F.created_at` 且晚于 u3 的 `created_at`）；所有者对 S undo `{messageId:<u3>, files:"restore"}`
- **THEN** 409 `undo_conflict`；`regen.txt` 仍在，S 的消息行与快照不变

#### Scenario: 被启动对账置为失败的回合
- **WHEN** B 在 t1 受理一个回合，S 在 t2 > t1 受理并完成 u2，随后服务在 B 的回合进行中被重启、启动对账把 B 置为 `failed`（`B.updated_at` 仍为 t1）；所有者对 S undo `{messageId:<u2>, files:"restore"}`
- **THEN** 409 `undo_conflict`
- **WHEN** 另一例 B 的回合在 t1 之后、t2 之前经终态结算以 `failed` 结束（`B.updated_at` 为结算时刻，晚于其末条助手消息的 `created_at`、早于 t2）
- **THEN** 对 S 以 `restore` 撤回 u2 为 200

#### Scenario: 别的会话只在那之前活动过
- **WHEN** F 自己的回合全部在 S 的 u2 发出之前结算完毕（`F.updated_at` 早于 u2 的 `created_at`、F 为 `done`），对 S 以 `restore` 撤回 u2
- **THEN** 200，不出现 `undo_conflict`

#### Scenario: 别的会话正在运行
- **WHEN** F 的回合进行中，对 S 分别以 `restore`、`force`、`keep` 撤回
- **THEN** 前两者 409 `session_busy` 且无任何改动；`keep` 为 200

#### Scenario: 他人的会话不参与判定
- **WHEN** 另一个账号在 S 的 u2 之后活跃
- **THEN** 对 S 以 `restore` 撤回不产生冲突

### Requirement: 撤回审计与通知
每次成功的撤回 SHALL 在其事务内经 `core/audit` 的 `emit` 写一条 `session.undo`：`actorId` 为会话所有者、`title` 为 `撤回消息`、`workspaceId` 为会话的 `workspace_id`、`detail={sessionId, messageId, removedMessages, files}`，其中 `removedMessages` 为被删除的消息行数，`files` 为请求的 `restore` / `force` / `keep`。被拒绝或失败的撤回不写审计。提交之后 SHALL 向所有者的列表事件连接发出一条 `session.rewound`（`sessionId` 为该会话）与 `sessions.changed`（session-list-push「通知触发点」）。`GET /api/audit` 以既有形状与可见规则返回该事件。

#### Scenario: 审计形状
- **WHEN** 所有者以 `files:"force"` 撤回 u2（其后共 4 条消息被删）
- **THEN** `GET /api/audit?limit=1` 为 `session.undo`，`title` 为 `撤回消息`，`detail` 深等于 `{sessionId:<id>, messageId:<u2>, removedMessages:4, files:"force"}`；第二个非管理员账号的审计列表不含它

#### Scenario: 审计失败则不回退
- **WHEN** 测试令撤回事务中的审计写入失败
- **THEN** 响应为通用 5xx；消息行与 `omp_session_file` 不变

### Requirement: web 撤回
用户消息的操作行 SHALL 含 `撤回` 按钮（可访问名与 tooltip 均为 `撤回`），位于 `从此处分叉` 之前（chat-web「消息线程」；`复制` 与操作行的悬停显隐由 #908 规定，不属于本条）。已归档会话不渲染它。输入框锁定期间它禁用。消息的 `undo` 不是 `available` 时它 SHALL 以 `aria-disabled="true"` 呈现为不可用、点击不发请求，并带可访问描述说明原因：
- `too_large`：`这一轮开始前工作空间超出快照上限，无法撤回`
- `failed`：`这一轮开始前的文件快照没有保存成功，无法撤回`
- `unbound`：`这个会话没有使用工作空间，无法撤回`
- `command`：`命令消息无法撤回`
- `none`：`这条消息没有文件快照，无法撤回`

`undo` 为 `available` 时点击 SHALL 不弹确认，恰调用一次 `undoMessage(sessionId, messageId, "restore")`，请求期间输入框锁定（不显示 `生成中` 与 `停止`）。200 时页面 SHALL：重读该会话的消息快照并替换线程；把输入框草稿设为响应的 `draft`，覆盖已有草稿（`draft` 为空串——被撤回的是只发附件的消息——时草稿被清空）；把输入框的附件标签设为响应 `attachments` 所列各项（已上传状态，文件名取路径的最后一段，大小取 `size`；覆盖已有标签——在途的上传中止、排队的撤掉，与 message-attachments「输入框附件标签」切换会话时的规则相同），不发出任何上传请求；把焦点移到输入框；以响应的 `session` 更新列表条目。`files.skipped.count` 或 `files.failed.count` 大于 0 时 SHALL 在输入框上方就地显示一条可关闭的说明（`role="status"`），标题为 `已撤回，以下文件未还原`，其下每行一个路径：先 `skipped.paths`、后 `failed.paths`，各按响应里的次序，不去重、不显示原因；`skipped.count + failed.count` 大于所列行数时末行为 `等共 <skipped.count + failed.count> 项`（截断只发生在服务端，web 不另设上限）。每一次被本页应用的 200 都以它自己的 `files` 重新决定这条说明（二者都为 0 时不显示，并撤掉已有的说明）；点关闭、下一次发送、切换会话或换账号时消失，其后不再出现。

409 `undo_conflict` SHALL 打开对话框，标题 `其它会话改动过这个工作空间`，说明 `这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。`，三个按钮 `只撤回对话`、`连文件一起还原`、`取消`：前两者关闭对话框并分别以 `"keep"`、`"force"` 再调用一次 `undoMessage`；`取消` 与 Escape 关闭对话框（遮罩点击不关闭：`alert-dialog`，同删除对话框）且不发请求，焦点回到该 `撤回` 按钮。没有冲突时 SHALL NOT 出现该对话框。其它失败（400/404/409 `session_busy`/409 `session_archived`/502/503 与网络失败）SHALL 把信封文案（非信封失败为既有的安全文案）就地显示在输入框上，线程、草稿与附件标签不变，输入框解锁。请求在途时切换会话、换账号或卸载页面，其后到达的响应 SHALL 被丢弃（不改草稿与附件标签、不导航、不显示错误）。撤回 SHALL NOT 显示任何轻提示。

#### Scenario: 撤回并回填
- **WHEN** 输入框草稿为 `半句话`，点击第二条用户消息（文本 `第二个问题`，`undo` 为 `available`）的 `撤回`，undo 返回 200（`files.skipped.count` 与 `files.failed.count` 均为 0）
- **THEN** 没有出现确认框；恰发出一次 `POST /api/sessions/<id>/undo`，body 为 `{"messageId":<该 id>,"files":"restore"}`；随后恰一次消息快照读取；线程里不再有 `第二个问题` 及其后的消息；输入框草稿为 `第二个问题`、焦点在输入框；页面没有轻提示，也没有 `已撤回，以下文件未还原`

#### Scenario: 不可撤回的原因
- **WHEN** 线程里有 `undo` 分别为 `too_large`、`failed`、`unbound`、`command`、`none` 的用户消息
- **THEN** 各自的 `撤回` 按钮 `aria-disabled="true"`，可访问描述依次为上列五句；点击它们不发出任何请求

#### Scenario: 冲突三选一
- **WHEN** 首次 undo 返回 409 `undo_conflict`
- **THEN** 出现对话框 `其它会话改动过这个工作空间`，含三个按钮；点击 `取消` 后没有第二个请求、线程与草稿不变、焦点在该 `撤回` 按钮
- **WHEN** 改点 `只撤回对话`；另一例点 `连文件一起还原`
- **THEN** 分别恰再发出一次 body 为 `{"messageId":<id>,"files":"keep"}` 与 `{"messageId":<id>,"files":"force"}` 的请求；其 200 之后的行为与「撤回并回填」相同

#### Scenario: 列出未还原的文件
- **WHEN** undo 返回 200，`files.skipped` 为 `{count:1,paths:[{path:"big.bin",reason:"too_large"}]}`、`files.failed.count` 为 0
- **THEN** 输入框上方出现 `已撤回，以下文件未还原` 与 `big.bin`；关闭后消失；发送下一条消息后不再出现

#### Scenario: 未还原文件被截断
- **WHEN** undo 返回 200，`files.skipped` 为 `{count:3,paths:[{path:"a.bin",reason:"too_large"}]}`、`files.failed` 为 `{count:1,paths:[{path:"b.txt"}]}`
- **THEN** 说明里依次是 `a.bin`、`b.txt`、`等共 4 项`

#### Scenario: 失败就地显示
- **WHEN** undo 返回 502 `agent_unavailable`，或 409 `session_busy`
- **THEN** 输入框上显示对应的信封文案；线程与草稿不变；输入框可用；没有轻提示

#### Scenario: 锁定与归档时
- **WHEN** 回合进行中；另一例打开一个已归档的会话
- **THEN** 前者每条用户消息的 `撤回` 为禁用；后者用户消息没有 `撤回` 按钮

#### Scenario: 撤回带附件的消息恢复标签
- **WHEN** 输入框里已有一个已上传的标签 `old.txt`，点击一条带附件 `uploads/a.pdf`、`uploads/b.png` 的用户消息（文本 `看看这两个`）的 `撤回`，undo 返回 200 且 `attachments` 为 `[{path:"uploads/a.pdf", size:3}]`（`b.png` 已不存在）
- **THEN** 草稿为 `看看这两个`；附件区恰有一个已上传状态的 `a.pdf` 标签，没有 `old.txt` 与 `b.png`；没有发出任何上传请求；此时直接发送，prompt 的 `attachments` 恰为 `["uploads/a.pdf"]`
- **WHEN** 另一例 undo 返回的 `attachments` 为 `[]`
- **THEN** 附件区不渲染；草稿照常回填
- **WHEN** 输入框草稿为 `半句话`，撤回一条只有附件的用户消息，undo 返回 200 且 `draft` 为 `""`、`attachments` 为 `[{path:"uploads/a.pdf", size:3}]`
- **THEN** 草稿为空（`半句话` 被覆盖）；附件区恰有一个已上传状态的 `a.pdf` 标签；`发送` 可用；线程里不再有那条只有附件的消息；没有发出上传请求
