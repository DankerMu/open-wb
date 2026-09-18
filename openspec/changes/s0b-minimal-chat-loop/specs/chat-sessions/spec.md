# Spec: chat-sessions

## ADDED Requirements

### Requirement: 会话数据 schema
迁移 `020_chat_sessions.sql` SHALL 原子建立 `chat_sessions`、`chat_messages`、`chat_steps` 三表，列与约束精确如下：`chat_sessions(id TEXT PK 32 lowercase hex, owner_id → accounts.id ON DELETE CASCADE, title TEXT NULL, status ∈ {idle,running,done,failed}, omp_session_file TEXT NULL, stream_epoch INTEGER ≥0 默认 0, created_at/updated_at 非负 epoch ms)` 与索引 `(owner_id, updated_at DESC)`；`chat_messages(id AUTOINCREMENT, session_id → chat_sessions ON DELETE CASCADE, role ∈ {user,assistant}, content TEXT 默认 '', status ∈ {done,running,failed}, created_at)`；`chat_steps(id AUTOINCREMENT, message_id → chat_messages ON DELETE CASCADE, ordinal ≥0, name, detail 默认 '', status ∈ {running,done,failed}, started_at, ended_at NULL, UNIQUE(message_id, ordinal))`。既有 `0010/002/010` receipt SHALL 不变。

#### Scenario: 迁移形态
- WHEN `openDb(":memory:")`
- THEN receipts 按字典序为 `0010,002,010,020`；三表存在、CHECK/FK/级联实际生效（删除 session 级联删消息与步骤；非法 status 被拒）

### Requirement: 会话 REST
所有 `/api/sessions*` 路由 SHALL 受既有 cookie guard 保护并按 `request.principal.id` 过滤；不存在或属他人的会话 SHALL 一律 404 `not_found`（不区分）。`POST /api/sessions` SHALL 创建 `status=idle`、`title=null` 的会话并返回 201 `{id,title,status,createdAt,updatedAt}`；`GET /api/sessions` SHALL 返回本账号会话按 `updated_at` 降序 `{sessions:[...]}`；`GET /api/sessions/:id/messages` SHALL 返回 `{session, messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,status}]}]}` 按 `created_at,id` 升序。全部响应 SHALL `Cache-Control: no-store`。

#### Scenario: 隔离
- WHEN zhangsan 创建会话后 lisi 请求其 messages / prompt / events
- THEN lisi 得到 404 `not_found`；zhangsan 的 `GET /api/sessions` 只含自己的会话

#### Scenario: 列表排序
- WHEN 两个会话中较早创建的那个收到新 prompt
- THEN 它在 `GET /api/sessions` 中排第一

### Requirement: prompt 回合状态机
`POST /api/sessions/:id/prompt` SHALL 只接受 `application/json` 且 body 精确为 `{message:string}`（trim 后非空、≤32768 字节），否则 400 `bad_request`（错误 content-type / malformed JSON / 超限 body 经 content-parser 归属集在 handler 前映射为 400）。会话 `status=running` SHALL 返回 409 `session_busy` 且不写任何行；`idle`/`done`/`failed` 均可受理。受理 SHALL 在一个事务内：插入 user 消息（`done`）与空 assistant 消息（`running`）、会话 `status=running`、`title` 为 null 时置为 message 前 18 个字符、`updated_at=now`；然后确保 runtime（懒 spawn / resume）并发送 `prompt`；spawn 或握手失败 SHALL 回滚上述写入并返回 502 `agent_unavailable`；成功 SHALL 返回 202 `{userMessageId, assistantMessageId}`。正文刷盘：回合进行中每 2s 或每累计 2KB 增量刷一次（先到者），回合结束做最终刷盘；回合结束 SHALL 把 assistant 消息 `status` 置 `done`/`failed`、会话 `status` 同步为 `done`/`failed`、`updated_at=now`。上游/模型错误（omp `message_end.message.stopReason ∈ {error,aborted}`）SHALL 使回合以 `failed` 收尾而非 `done`。**启动对账**：`registerSessions` 在受理任何请求前 SHALL 把所有 `status='running'` 的会话及其 `running` 消息置为 `failed`。

#### Scenario: 正常回合落盘
- WHEN 对新会话发 prompt，假子进程按脚本发出 agent_start → tool_execution_start/end → text_delta×3 → agent_end(isTerminal:true)
- THEN 202；回合结束后 messages 端点显示 assistant `content` 等于三段拼接、`status=done`、恰一条 step `{name:"bash",status:"done"}`；会话 `status=done`、`title` 为 prompt 前 18 字符

#### Scenario: 忙碌与失败
- WHEN 回合进行中再次 prompt
- THEN 409 `session_busy`，消息表行数不变
- WHEN `OMP_BIN` 指向不存在路径时 prompt
- THEN 502 `agent_unavailable`，会话仍 `idle`、消息表为空

#### Scenario: 子进程回合中退出
- WHEN 假子进程在发出两段 text_delta 后退出（两段合计 <2KB 且不足 2s，即尚未定时刷盘）
- THEN assistant 消息 `status=failed` 且 `content` 精确为已收到的两段（内存残量在标 failed 前落盘）；会话 `status=failed`；随后 prompt 以 `--resume` 重新 spawn 并 202

#### Scenario: 进行中刷盘节奏
- WHEN 假子进程发出累计 >2KB 的 text_delta 后停顿（不发 agent_end）
- THEN messages 端点在停顿期间返回的 `content` 非空且长度 ≥ 已发增量 − 2KB；assistant `status` 仍 `running`

#### Scenario: 上游错误回合
- WHEN 假子进程发出 `message_end{message:{role:"assistant",stopReason:"error",errorMessage:"upstream 500"}}` 后 `agent_end{isTerminal:true}`
- THEN assistant 消息 `status=failed`、会话 `status=failed`；随后 prompt 被受理（202）

#### Scenario: 启动对账
- WHEN 打开一个预置了 `status='running'` 会话与 `running` assistant 消息的数据库并装配 app
- THEN 装配后二者均为 `failed`，对该会话 prompt 得到 202 而非 409
