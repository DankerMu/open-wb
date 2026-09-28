# Spec delta: tool-approval（#465 regenerate 级联删除审批行）

> 「chat_approvals 持久化」正文主 spec 与父 delta 逐字相同（「regenerate 删旧助手行」已在正文中）。本 issue 只把 Scenario「级联删除」的 WHEN 换成父文，由 regenerate 的删除路径兑现。其余 Scenario 原样。删除会话一支由既有 `migration-034.test.ts` 守护。

## MODIFIED Requirements

### Requirement: chat_approvals 持久化
迁移 `034_chat_turn_control.sql` SHALL 新建 `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。supervisor 收到审批请求 SHALL 先插入一行（`decision` NULL、`requested_at`=注入时钟 now、`expires_at = requested_at + 60000`），再发布事件；同一消息上已存在的审批行（无论 pending 或已结算）SHALL 不被新请求改写或覆盖，一条 assistant 消息可有多行审批。结算 SHALL 以 compare-and-set（`UPDATE … WHERE id=? AND decision IS NULL`）把 `decision`/`decided_at` 一次性写入，此后不可再改；CAS 未命中者即为"已结算"。同一 `(message_id, request_id)` 重复请求 SHALL 被 UNIQUE 拒绝而不产生第二行。删除消息（regenerate 删旧助手行、删会话）SHALL 级联删除其审批行。

#### Scenario: 落库形状
- **WHEN** 审批请求到达，注入时钟为 T
- **THEN** `chat_approvals` 恰一行：`message_id` 为当前 running assistant id、`request_id="r1"`、`tool="bash"`、`title` 原文、`requested_at=T`、`expires_at=T+60000`、`decision`/`decided_at` NULL

#### Scenario: 同一消息多行审批
- **WHEN** 同一回合内先后到达 `request_id` 为 `r1`、`r2` 的两个审批请求
- **THEN** `chat_approvals` 中该 assistant 消息恰有两行，`id` 按到达顺序递增，`r1` 行在 `r2` 到达后字段不变

#### Scenario: 级联删除
- **WHEN** 对含审批记录的会话执行 regenerate（删旧助手行）或删除会话
- **THEN** 对应 `chat_approvals` 行不存在，无孤儿行

#### Scenario: 重复请求与决定值域
- **WHEN** 对同一 `(message_id, request_id)` 插入第二行，或写入 allow/deny/timeout 以外的 `decision`
- **THEN** SQLite 拒绝该写入，既有行不变
