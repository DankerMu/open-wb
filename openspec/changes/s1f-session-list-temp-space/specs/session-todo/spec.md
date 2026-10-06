## MODIFIED Requirements

### Requirement: 任务清单持久化
迁移 `036`（chat-sessions `迁移 036 任务清单列`）SHALL 给 `chat_sessions` 增加可空的 `todo` 列，存归一化清单的 JSON 文本；SQL NULL 表示没有清单。归一结果非 null 时列值 SHALL 是 `{"phases":[{"name":…,"tasks":[{"content":…,"status":…}]}]}` 形状的紧凑 JSON 文本，键次序固定为 `phases`；`name`、`tasks`；`content`、`status`；归一结果为 `null` 时列值 SHALL 为 SQL NULL。

写入 SHALL 走与其它事件相同的有序持久化路径（chat-sessions `Supervisor ordered persistence and publication`）：候选事件按帧到达次序处理，先落库后发布，位于该调用 `step.start` 之后、`step.end` 之前。归一结果与该会话行当前已落库的值相同（同为 null，或 JSON 文本逐字相同）时 SHALL 不写库、不发布。写入 SHALL 只改 `todo` 一列：`updated_at`、`status`、`title` 及其它列不变（任务清单更新不改变会话列表次序）；写不到恰一行即为失败。落库失败 SHALL 不发布该事件、不推进 ring 序号，并沿既有 owned error-sink 路径处理。

`chat_sessions.todo` SHALL 只由两条路径写入：这条有序持久化路径，以及撤回的最终事务（message-undo「对话原地回退」第 5 步——把该列置为被撤回消息快照行里存的那份原文或 NULL，与删除消息行、改写 `omp_session_file` 同一事务；它不走事件路径、不发布 `todo.updated`，页面靠撤回之后的快照重读得到新值）。会话创建时为 NULL。prompt 受理之后、派发之前的快照步骤（workspace-snapshots「受理时做快照」）SHALL 只**读**该列一次，把原文抄进该用户消息的快照行，SHALL NOT 写它；prompt 的受理事务与补偿、回合终态结算、启动对账、关停、元数据 PATCH（含归档）均 SHALL NOT 读写它。分叉得到的新会话 SHALL 为 NULL（fork 事务的显式列插入不拷贝 `todo`）。重新生成 SHALL NOT 清空或改写它（清单是 omp 会话状态，下一次 `todo` 工具结果会覆盖）。回合以 `failed` 或 `stopped` 结束、进程被回收或重启后，已落库的值 SHALL 保持。会话行删除时随之消失。本 change SHALL NOT 为清单新增 REST 端点，也 SHALL NOT 调用 omp 的 `get_state` 来补读或对账清单。

#### Scenario: 落库后发布且只改一列
- **WHEN** 真实 fake-omp（`todo` 场景）的第一轮回合在一个 `todo` 列为 NULL 的会话上结束；另在持久化路径的单元 seam 上对一个已有行单独执行一次清单写入
- **THEN** `chat_sessions.todo` 的文本恰为 `{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}`；ring 中该回合的事件次序为 `turn.start`、`step.start`、`todo.updated`、`step.end`、`text.delta`…、`turn.end`，`todo.updated` 在该列提交之后发布；单独那次清单写入前后，该行除 `todo` 外的所有列（含 `updated_at`、`status`、`title`）逐值不变

#### Scenario: 落库失败不发布
- **WHEN** 写入 `chat_sessions.todo` 在 SQLite 中失败
- **THEN** 没有 `todo.updated` 进入 ring，ring 序号不因它推进，失败沿既有 owned error-sink 路径处理

#### Scenario: 快照步骤只读、撤回写回
- **WHEN** 会话已落库清单 T1 时受理一条 prompt u2（快照步骤执行），该回合把清单变成 T2 后结束；随后所有者撤回 u2
- **THEN** 受理之后、回合的第一条 `todo` 工具结果之前，`chat_sessions.todo` 仍逐字为 T1（快照步骤没有写它），u2 的快照行 `todo` 列与 T1 的存储文本逐字相同；撤回提交后该列逐字为 T1，撤回没有向任何事件环发布 `todo.updated`；另一例受理时清单为 NULL，撤回后该列为 SQL NULL

#### Scenario: 分叉为空、重新生成与终态不清空
- **WHEN** 一个已落库清单 T 的 done 会话被分叉（真实 fake `branch`）；另一个已落库清单 T 的会话执行重新生成；另一个已落库清单 T 的会话其后一轮回合以 `stopped` 或 `failed` 结束；另一个已落库清单 T 的 running 会话经历服务重启与启动对账
- **THEN** 分叉得到的新会话 `todo` 列为 NULL、其快照 `todo` 为 `null`，源会话仍为 T；重新生成的最终事务提交后该会话 `todo` 仍为 T；`stopped`/`failed` 结算与启动对账之后仍为 T

### Requirement: 任务清单快照
`GET /api/sessions/:id/messages` 的响应 SHALL 恰有四个顶层键 `session`、`messages`、`streamCursor`、`todo`。`todo` SHALL 为该会话 `chat_sessions.todo` 列解析后的归一化清单对象（`{phases:[{name, tasks:[{content, status}]}]}`），列为 NULL 时为 `null`；列里的文本解析不出来、或解析结果不符合归一化清单的结构时（带内唯一的写者只写归一化结果，这种值只可能来自带外改库）同样 SHALL 为 `null`，快照照常返回、不因此失败，读取不改写该列；它与消息树、`streamCursor` 在同一次 owner-scoped 读取与同一 preParsing 栈内取得（chat-sessions `会话 REST`），使快照里的清单与游标边界一致。会话视图的键集由 session-metadata「会话视图扩展键」规定（本条不复述键数）：`todo` SHALL NOT 进入任何会话视图——会话列表、创建、PATCH、fork 与 undo 响应的 `session`，以及快照自己的 `session`。服务端的四键快照与 web 的四键解析（本能力 `web 契约解析与归约` 的快照部分）SHALL 同刀落地，不设兼容窗口（严格键集使任一侧先合入都会让会话页整体失效）。

#### Scenario: 无清单的会话
- **WHEN** 账号新建会话后读取其消息快照；另一个账号读取该会话
- **THEN** 前者返回 200，响应体恰有 `session`、`messages`、`streamCursor`、`todo` 四键且 `todo` 为 `null`；后者返回与未知 id 相同的 404，不暴露清单

#### Scenario: 清单随快照返回
- **WHEN** 真实 fake-omp（`todo` 场景）的第一轮回合结束后读取快照，随后重启服务再读取一次
- **THEN** 两次的 `todo` 都恰为 `{"phases":[{"name":"准备","tasks":[{"content":"读取需求","status":"in_progress"},{"content":"列出要点","status":"pending"}]},{"name":"交付","tasks":[{"content":"输出结论","status":"pending"}]}]}`；`GET /api/sessions` 的列表项与快照的 `session` 键集恰为 session-metadata「会话视图扩展键」规定的会话视图键集、不含 `todo`

#### Scenario: 存量坏值降级为 null
- **WHEN** 某会话的 `chat_sessions.todo` 被带外改成 `{not json`；另一例改成合法 JSON 但结构不合规（`{"phases":"x"}`）；其属主分别读取消息快照
- **THEN** 两例都返回 200，四键齐全且 `todo` 为 `null`，`messages` 与 `streamCursor` 与该列为 NULL 时相同；读取之后该列的值没有被改写
