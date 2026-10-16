## MODIFIED Requirements

### Requirement: 对话原地回退
校验通过后，undo SHALL 按以下次序执行（fork 的进程策略，作用于当前会话）：
1. 经既有有界 retire 序列关停该会话的存活进程（如有）并等待其退出；其 slot 与事件环丢弃，已连接的单会话事件流订阅结束。
2. 经 omp-pool 准入一个**临时** `SessionRuntime`（与 fork 相同的 spawn 契约、`--resume <omp_session_file>`、`--cwd` 为该会话的工作目录、不绑定 slot、不是 generation、不改 `stream_epoch`、不拥有事件环）；准入失败 503 `agent_capacity`。
3. `get_branch_messages` → 按 chat-sessions「Slash 命令白名单与命令目录」的 Branch alignment 自前向后首次匹配对位，取对位到该用户消息的条目；无对位 SHALL 502 `agent_unavailable`，不发 `branch` → `branch{entryId}` → `get_state` 取新 `sessionFile` → 关停临时进程（token 撤销、名额释放）。任何失败 SHALL 502 `agent_unavailable` 并关停临时进程。
4. `files` 不是 `keep` 时还原工作空间（「文件还原与结果」）。
5. 一个 SQLite 事务：先以 CAS 复核会话仍非 `running`、未归档、其末条助手消息 id 等于前置校验读到的值、该用户消息行仍在；复核失败 SHALL 不写任何行并 409 `session_busy`。复核通过则：删除该会话中 `(created_at,id)` 不早于该用户消息的全部 `chat_messages` 行（其 `chat_steps`、`chat_approvals`、`chat_thinking_segments`、`chat_turn_snapshots` 行随外键级联删除）；把 `omp_session_file` 置为新文件；`status` 置为剩余消息中末条助手消息的状态（`done` / `failed` / `stopped`），没有剩余助手消息时为 `idle`；`updated_at` 置为当前毫秒；`todo` 置为被撤回消息快照行的 `todo` 值（含 NULL）；写一条 `session.undo` 审计（「撤回审计与通知」）。`title`、`scene`、`pinned_at`、`archived_at`、`workspace_id`、`stream_epoch`、`parent_session_id` SHALL 不变。审计失败则事务回滚。
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

#### Scenario: 撤回连带删除分段数据
- **WHEN** 会话为 u1→a1→u2→a2，a1、a2 各有两行思考段、带 `bodyOffset` 的步骤与配上步骤的审批，撤回 u2
- **THEN** a2 的思考段、步骤与审批行都不存在（无孤儿行）；a1 的思考段、步骤 `bodyOffset` 与审批 `stepId` 与撤回前逐值相同，快照里 a1 经 chat-web「助手消息分段」得到与撤回前逐块相等的分段

