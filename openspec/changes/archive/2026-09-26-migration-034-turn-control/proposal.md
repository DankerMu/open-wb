# Proposal: migration-034-turn-control（#449）

## Why
父 change `s1c-turn-control-governance` tasks 1.1（epic #448）。停止生成需要独立终态 `stopped`，fork 需要 `chat_sessions.parent_session_id`，审批条需要 `chat_approvals` 表；SQLite 不能 ALTER CHECK，三处 status CHECK 只能靠重建三表扩值。三者共用同一迁移 034，是 S1c 其后所有 store/supervisor/REST 切片的 schema 前提。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: 全部既有会话/消息/步骤数据——重建失败或次序错会丢行、改写 FK 到 `_next`、复用已删除 id，且迁移不可逆（回滚 = 恢复备份）。
Selected risk packs: Schema / columns / units / field names；Error handling / rollback / partial outputs；Legacy compatibility / examples；Concurrency / shared state / ordering（DDL 次序）；Documentation / migration notes
Evidence floor: 新建 `server/test/migration-034.test.ts`（真实临时 SQLite）覆盖 spec 六个 Scenario 全绿，且每条新断言在无 034 文件时为红；既有迁移测试仅按 tasks §3 所列联动修改；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。

## What Changes
- 新增 `server/src/core/db/migrations/034_chat_turn_control.sql`：按父 design D2 配方 (1)–(6) 在 runner 既有事务内重建 `chat_sessions`/`chat_messages`/`chat_steps`（CHECK 扩 `stopped`、加 `parent_session_id … ON DELETE SET NULL`），保住两张 AUTOINCREMENT 表的 `sqlite_sequence` 高水位，RENAME 之后建 `chat_approvals`（含 `message_id` 索引）并重建三表索引；不写任何 `PRAGMA foreign_keys`。回执追加为第八条。
- 新增 `server/test/migration-034.test.ts`；既有迁移测试的必要联动（逐条列于 design「Sibling surfaces」与 tasks §3）：回执/计数/目录期望 +034、`columnInfo(chat_sessions)` 期望末尾 +`parent_session_id`、两处「只跑到 032/033 为止」的种子过滤条件再排除 034、`core-db-helpers.ts` 增 `MIGRATION_034` 常量与目录清单。偏离 issue PR Boundary「只改期望值」：过滤条件与 helper 常量不是期望值，但不改则既有测试在 034 存在时必然失败（034 会在 033 之前的 schema 上执行）；约束为不删断言、过滤只多排除 034、不放宽其它条件。

## Capabilities
- MODIFIED `chat-sessions`「会话数据 schema」：整段取父 delta（`stopped` 进三处 CHECK、034 取代 032 列集与 CHECK 的说明段、Fresh schema Scenario 的 034 子句）。本 issue 交付该 requirement 父 delta 的全部内容。
- ADDED `chat-sessions`「迁移 034 回合控制 schema」：整段取父 delta。
- MODIFIED `chat-sessions`「步骤输出列迁移」：整段取父 delta（Fresh and upgraded schema 的回执断言由「以 033 结尾」改为「含 032 后 033，其后可有 034」）；#448 无其它 issue 认领，本 issue 全量交付。
- ADDED `tool-approval`「chat_approvals 持久化」（新 capability，部分交付）：只含 schema 面——表 DDL、UNIQUE 拒绝重复、消息/会话删除级联；supervisor 插入、`requested_at`/`expires_at` 取值、CAS 结算与「已结算」语义归 4.3 #464（其归档时 MODIFIED 并入）。

## Impact
- 仅新增一条 SQL 迁移与一个测试文件；不触碰 `server/src/sessions/**`、`migration-runner.ts`、`openDb`、032/033 文件。
- 旧代码只写 `done`/`failed`/`running`/`idle`，新 CHECK 为超集，单独合并保绿；`openDb` 自动执行，故非死代码。
- 运维：升级前备份 DB 文件；迁移不可逆（与 032 同纪律，见父 design Migration Plan）。

## Non-goals
- store 层对 `stopped` 的接受与结算（3.1 #455）、`chat_approvals` 读写（4.3/4.6）、`parent_session_id` 写入（4.5）、REST 与视图。
