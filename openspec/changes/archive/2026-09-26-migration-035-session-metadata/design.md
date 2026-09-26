# Design: migration-035-session-metadata（#510）

权威决定见父 design D1「迁移 035」与 Migration Plan；本文件只写本切片的审查面。

- **Change surface**：`server/src/core/db/migrations/035_chat_session_metadata.sql`（新）；由 `server/src/core/db/index.ts` `openDb` → `migration-runner.ts` 在其事务内执行（二者不改）。
- **Must preserve**：032/033/034 的全部列、默认值、NOT NULL、主键、AUTOINCREMENT、FK 与级联（`owner_id → accounts CASCADE`、`parent_session_id → chat_sessions SET NULL`、消息/步骤/审批级联）、`UNIQUE(message_id,ordinal)`、`chat_approvals` 的 UNIQUE、全部索引；三表既有**列顺序**不变（新列只追加在各表末尾）；既有八条回执与业务数据、`sqlite_sequence` 逐字节不变；032/033/034 文件不改；账本连续前缀校验（`migration-ledger.ts`）不改。
- **Must add/change**（五条语句，顺序即列追加顺序）：
  1. `ALTER TABLE chat_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL;`
  2. `ALTER TABLE chat_sessions ADD COLUMN scene TEXT CHECK (scene IS NULL OR scene IN ('office','code','design'));`
  3. `ALTER TABLE chat_sessions ADD COLUMN pinned_at INTEGER CHECK (pinned_at IS NULL OR (typeof(pinned_at) = 'integer' AND pinned_at >= 0));`
  4. `ALTER TABLE chat_messages ADD COLUMN thinking TEXT;`
  5. `ALTER TABLE chat_steps ADD COLUMN changes TEXT;`
  文件头注释写明：runner 事务、不可逆、升级前备份、可空是 A fork 显式列插入的前提（与 033/034 文件头风格一致）。第九条回执 `035_chat_session_metadata.sql`。
- **Governing invariant**：035 要么整体提交（五列就位、第九条回执、旧行新列全 NULL、既有数据/约束/序列不变），要么什么都不留（无任何 035 列、无 035 回执，034 及更早回执与行不变）；且 035 只能在 034 回执之后应用。
- **Sibling surfaces**：
  - 生产者：runner 事务（`BEGIN`/`COMMIT`/ROLLBACK）——不改；035 不得自带事务语句或 `PRAGMA`。SQLite 的 `ALTER TABLE ADD COLUMN` 在同一事务内可回滚（中途失败用例证明）。
  - SQLite `ADD COLUMN` 规则：不带 PRIMARY KEY/UNIQUE；外键开启时带 REFERENCES 的列默认值须为 NULL（满足）；CHECK 对既有行求值（NULL 通过）——由新测试在 node:sqlite 内置版本上实证。
  - 存储：`workspaces(id)` 主键与 `workspaces.owner_id → accounts(id) ON DELETE CASCADE`（`031_workspaces.sql`）：删账号经「工作空间 SET NULL」与「会话 CASCADE」两条路径，最终会话仍被删除——新测试断言。
  - 消费者：`server/src/sessions/store*.ts` 读写三表用显式列名（新列不被读，旧写入不给新列值 → NULL），无需改动；实现时 grep `SELECT \*`/`INSERT INTO chat_` 核对无按位置依赖列顺序的读写，若有即为缺陷并在 PR 报告。
  - 构建：`npm run build --workspace server` 产物须含 `035_chat_session_metadata.sql`（构建按 glob 复制 migrations）。
  - 既有测试（允许的最小联动；不删断言、不放宽其它条件，每处列入 PR `偏离记录`）：
    - `server/test/core-db-helpers.ts`：增 `MIGRATION_035`，进 `TRACKED_MIGRATION_FILENAMES`，`COMPLETE_CATALOG` 回执 +`[9, MIGRATION_035]`、`sequenceRows` 8→9。
    - `server/test/core-db-chat-schema.test.ts`：新库 `columnInfo` 精确期望在 `chat_sessions`/`chat_messages`/`chat_steps` 末尾追加对应新列行；`:316` `PRAGMA foreign_key_list('chat_sessions')` 的精确（未排序）期望由两项变三项——实测（node:sqlite 内置版本）新项 `{table:"workspaces", from:"workspace_id", to:"id", on_delete:"SET NULL"}` 排在**末位**（id 2），既有 `parent_session_id`(0)、`owner_id`(1) 次序不变（`ADD COLUMN` 的列级 REFERENCES 并入列定义区，排序先于表级 FOREIGN KEY 子句；fixture 初稿「首位」为推断，已按实测更正）；升级用例顺序断言追加第八条（034）与第九条（`sequence: 9, filename: MIGRATION_035`）；`seedPre032Database` 过滤条件再排除 035。
    - `server/test/core-db-chat-step-output.test.ts`：`seedPre033Database` 过滤条件再排除 035（否则 035 会在无 034 的 schema 上执行）；其余期望若因 035 变化只改期望值。
    - `server/test/migration-034.test.ts`：`seed033Database` 过滤条件再排除 035；`expect034Receipts`/`expect034Schema`/`TABLE_INFO` 等在真实 `openDb`（含 035）之后断言的回执与列期望 +035 的内容（回执末条变为 `[9, MIGRATION_035]` 且 034 仍为第八条；各表 `TABLE_INFO` 末尾追加新列）；`:126-130` `FOREIGN_KEYS.chat_sessions`（`foreignKeys()` 按 `from` 排序后比对）追加第三项 `workspace_id → workspaces(id) SET NULL`，排序后在**末位**。不降低 034 本身的断言强度。
    - 其它因 035 失败的既有断言：同一原则处理并在 PR 逐条报告；若某处无法仅以期望值/过滤联动修复，停止并报告。
- **Seams under test**：`openDb`（真实临时文件库与 `:memory:`）；种子库经 `trackedMigrationAssets()` 过滤 + `runMigration` 跑到 034 为止（先例 `migration-034.test.ts` `seed033Database`、`core-db-chat-step-output.test.ts`）；冲突对象预置在一次性副本中。
- **Required evidence**（新文件 `core-db-session-metadata.test.ts`，每条先在无 035 文件时跑红）：
  - 新库：回执以 `033,034,035` 结尾、共九条；五列存在、`notnull=0`、`dflt_value=null`、各在表末尾；`PRAGMA foreign_key_list(chat_sessions)` 含 `workspace_id → workspaces(id) SET NULL`。
  - 带数据 034 库（两个所有者；含 fork 子会话 `parent_session_id`、带审批的消息、带 detail/output 的步骤）升级：035 恰追加一次；既有列值（逐行逐列）、行数、索引、UNIQUE、`sqlite_sequence` 与升级前相同；`chat_messages`/`chat_steps`/`chat_approvals` 的 FK 列表与升级前逐项相同，`chat_sessions` 原有 `owner_id→accounts CASCADE` 与 `parent_session_id→chat_sessions SET NULL` 两项不变且恰新增一项 `workspace_id→workspaces(id) SET NULL`；新列全 NULL；`PRAGMA foreign_key_check` 为空；`expectRepeatedOpenStable` 重开稳定。
  - 回执止于 033 的库：同次 `openDb` 先 034 后 035，两条回执各一次且有序。
  - 中途失败：一次性副本中预置 `chat_sessions.scene` 列（034 已应用）→ `openDb` 抛错；无 `workspace_id`/`pinned_at`/`thinking`/`changes` 列残留、无 035 回执，034 及更早回执与行保留；移除冲突列（重建副本或 `ALTER TABLE DROP COLUMN`）后重试恰应用 035 一次。
  - 约束：`scene` 写 `office`/`code`/`design`/NULL 成功、`chat`/`Office`/`''` 被拒；`pinned_at` 写 `0`/`Date.now()`/NULL 成功、`-1`/`1.5`/`'x'` 被拒；`workspace_id` 写已存在工作空间 id 成功、不存在的 id 被 FK 拒绝；`thinking`/`changes` 任意文本（含空串、多字节、JSON 文本）可写。
  - 级联：删一行 `workspaces` → 引用它的会话 `workspace_id` 为 NULL，会话与其消息仍在；删账号 → 其工作空间、会话、消息、步骤、审批全部删除，另一所有者的行不变。
- **Non-goals**：见 proposal。
- **Review focus**：五条 DDL 以本文件「Must add/change」（= 父 design D1）为准逐字核对（尤其 `ON DELETE SET NULL` 与两条 CHECK 的 NULL 分支）；spec delta 中 `scene` 的短写法 `CHECK (scene IN (…))` 与 D1 的 `scene IS NULL OR scene IN (…)` 行为等价（`NULL IN (…)` 为 NULL，CHECK 放行；`''` 被拒），不作逐字比对对象；无事务语句/PRAGMA；新列在表末尾；既有测试联动只限上列四类且无断言被删/放宽；中途失败用例确实在 035 执行期间失败（而非 034 或 openDb 前）。
