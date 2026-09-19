# Spec: audit-core

## ADDED Requirements

### Requirement: 只追加审计表
迁移 `030_audit_events.sql` SHALL 原子建立 `audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL CHECK ts >= 0, actor_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT, kind TEXT NOT NULL CHECK 匹配小写点分标识（如 sandbox.reject）, title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}' CHECK json_valid(detail), workspace_id TEXT NULL)`、索引 `(actor_id, id DESC)`，以及触发器 `audit_events_no_update BEFORE UPDATE` 与 `audit_events_no_delete BEFORE DELETE`，均 `RAISE(ABORT, 'audit_events is append-only')`。受信任迁移目录计数断言 SHALL 随之 +1。

#### Scenario: 触发器拒绝改写
- WHEN 对任一 `audit_events` 行执行 UPDATE 或 DELETE
- THEN 语句以 `audit_events is append-only` 失败，行不变；删除被引用账号亦失败（RESTRICT）

### Requirement: emit 与 query
`emit(db, {kind, actorId, title, detail?, workspaceId?, ts?})` SHALL 插入一行并返回 `id`；`ts` 缺省为当前 epoch ms；`detail` 序列化为 JSON。`query(db, principal, {limit?, before?})` SHALL 按 `id DESC` 返回 `{id, ts, actorId, kind, title, detail(对象), workspaceId}`：`principal.role !== '管理员'` 时只返回 `actor_id = principal.id` 的行；`limit` 缺省 50、允许 1..200，越界或非整数 SHALL 抛 `HttpError("bad_request")`；`before` 缺省不过滤，给出时 SHALL 为 canonical 正整数（`^[1-9][0-9]*$`）id 游标（只返回 `id < before`），其它值 SHALL 抛 `HttpError("bad_request")`。

#### Scenario: 账号隔离与管理员全量
- WHEN u1、u2 各有事件，成员 u1 与管理员 u3 分别 query
- THEN u1 只见自己的行；u3 见全部且按 id 降序；`before` 游标翻页不重复不遗漏

### Requirement: 审计只读端点
`GET /api/audit?limit=&before=` SHALL 受既有 cookie guard 保护，调用 `query` 并返回 200 `{events:[...]}`，`Cache-Control: no-store`；非法 `limit`/`before` → 400 `bad_request`。端点由 `accounts` 模块注册（`registerAccounts(app, {db})`），S1a 无其它账号路由。

#### Scenario: 端点形状
- WHEN zhangsan 触发一次越界后 `GET /api/audit?limit=1`
- THEN 200，`events[0].kind === "sandbox.reject"`，响应头 `cache-control: no-store`；`GET /api/audit?limit=0`、`?before=abc`、`?before=0`、`?before=-1` 均 → 400
