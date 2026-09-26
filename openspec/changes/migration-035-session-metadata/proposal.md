# Proposal: migration-035-session-metadata（#510）

## Why
父 change `s1c-session-metadata-presentation` tasks 1.1（epic #509）。空间绑定（`workspace_id`）、场景（`scene`）、置顶（`pinned_at`）、深度思考（`chat_messages.thinking`）与文件变更（`chat_steps.changes`）五项元数据是 S1c-B 其后全部 store/REST/web 切片的 schema 前提；五列可空还是 A 的 fork 显式列插入（4.4）的硬前提（父 design D1/D14）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 迁移不可逆、账本第九条、FK/CHECK 是 SQLite `ADD COLUMN` 规则下的数据面决定)
Blast radius: 全部既有会话/消息/步骤数据与迁移账本——SQL 错误会让 `openDb` 在每次启动失败（服务不可启动）；列可空性/默认值错会让 A 的显式列 fork 插入静默拿到错误值；FK 方向错会在删工作空间或账号时误删会话。
Selected risk packs: Schema / columns / units / field names；Error handling / rollback / partial outputs；Legacy compatibility / examples；Concurrency / shared state / ordering（账本连续前缀：034 先于 035）；Release / packaging / dependency compatibility（server build 产物含 035）
Evidence floor: 新建 `server/test/core-db-session-metadata.test.ts`（真实临时 SQLite）覆盖 spec 三个 Migration 035 Scenario，且每条新断言在无 035 文件时为红；既有 core-db/迁移测试只按 design「Sibling surfaces」所列联动修改后全绿；`npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- 新增 `server/src/core/db/migrations/035_chat_session_metadata.sql`：恰五条 `ALTER TABLE … ADD COLUMN`（列定义见 design「Must add/change」），无 `BEGIN`/`COMMIT`、无 `PRAGMA`、无 DEFAULT/NOT NULL/索引；由 runner 在其既有事务内执行，回执为第九条。
- 新增 `server/test/core-db-session-metadata.test.ts`。
- 既有测试的必要联动（逐条列于 design「Sibling surfaces」）：`core-db-helpers.ts` 增 `MIGRATION_035` 常量、进 `TRACKED_MIGRATION_FILENAMES`、`COMPLETE_CATALOG` 增 `[9, MIGRATION_035]` 且 `sequenceRows` 为 9；新库精确列清单末尾追加新列；「只跑到 0xx 为止」的种子过滤再排除 035；034 专用断言中的回执/列期望 +035。
- 偏离 issue PR Boundary「只改 `core-db-helpers.ts`/`core-db-chat-schema.test.ts` 的期望值」：`core-db-chat-step-output.test.ts`、`migration-034.test.ts` 的种子过滤与精确期望在 035 存在时必然失败（与 #449 PR #496 同类联动，先例已记录）；约束为不删断言、过滤只多排除 035、不放宽其它条件，每处在 PR `偏离记录` 逐条列出。

## Capabilities
- MODIFIED `chat-sessions`「会话数据 schema」：整段取父 delta（035 说明段 + Scenario「Migration 035 on fresh and populated databases」「Migration 035 column constraints」「Migration 035 follows 034 atomically」）。本 issue 交付该 requirement 父 delta 的全部内容；父 delta 与当前主 spec 的差异恰为这四块。

## Impact
- 仅新增一条 SQL 迁移与一个测试文件，加既有测试期望联动；不触碰 `server/src/sessions/**`、`server/src/core/db/*.ts`（runner/ledger/`openDb`）、032/033/034 文件、web。
- 旧代码不读写新列；`openDb` 自动执行，单独合入保绿、非死代码。
- 运维：升级前备份 DB 文件；迁移不可逆（`ADD COLUMN` 无 DROP 回退，父 design Migration Plan）。

## Non-goals
- 新列在 DTO/快照中的投影（5.1 #517）、`workspace_id`/`scene` 写入与 `session.bind` 审计（4.1 #523）、PATCH（4.2 #524）、`thinking` 写入（3.3 #519）、`changes` 写入与 JSON 形状（3.4 #522）、A 的 fork 显式列插入与拷贝列表（4.4 / #527）、所有者一致性校验（4.1 的 `rootOf`）。
