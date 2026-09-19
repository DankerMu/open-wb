# audit-core Specification

## Purpose
Persist validated audit events with stable identifiers, account-reference integrity, and explicit UPDATE/DELETE rejection.
## Requirements
### Requirement: 只追加审计表
迁移 `030_audit_events.sql` SHALL 原子建立 `audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL CHECK ts >= 0, actor_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK 匹配小写点分标识（如 sandbox.reject）, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}' CHECK json_valid(detail), workspace_id TEXT NULL)`、索引 `(actor_id, id DESC)`，以及触发器 `audit_events_no_update BEFORE UPDATE` 与 `audit_events_no_delete BEFORE DELETE`，均 `RAISE(ABORT, 'audit_events is append-only')`。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 触发器拒绝改写
- WHEN 对任一 `audit_events` 行执行 UPDATE 或 DELETE
- THEN 语句以 `audit_events is append-only` 失败，行不变；删除被引用账号亦失败（RESTRICT）

