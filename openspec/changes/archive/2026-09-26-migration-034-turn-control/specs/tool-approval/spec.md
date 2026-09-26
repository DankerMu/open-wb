# Spec delta: tool-approval（#449 迁移 034 的 schema 面）

> 父 delta「chat_approvals 持久化」由 #449（表结构）与 #464（supervisor 插入与 CAS 结算）分担；本 delta 只含本 issue 交付的 schema 面，#464 归档时以 MODIFIED 并入其余部分。

## ADDED Requirements

### Requirement: chat_approvals 持久化
迁移 `034_chat_turn_control.sql` SHALL 新建 `chat_approvals(id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, request_id TEXT NOT NULL, tool TEXT NOT NULL, title TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decision TEXT NULL CHECK (decision IN ('allow','deny','timeout')), decided_at INTEGER NULL, UNIQUE(message_id, request_id))`。同一 `(message_id, request_id)` 重复请求 SHALL 被 UNIQUE 拒绝而不产生第二行。删除消息（regenerate 删旧助手行、删会话）SHALL 级联删除其审批行。

#### Scenario: 级联删除
- **WHEN** 删除含审批记录的助手消息，或删除其所属会话
- **THEN** 对应 `chat_approvals` 行不存在，无孤儿行

#### Scenario: 重复请求与决定值域
- **WHEN** 对同一 `(message_id, request_id)` 插入第二行，或写入 allow/deny/timeout 以外的 `decision`
- **THEN** SQLite 拒绝该写入，既有行不变
