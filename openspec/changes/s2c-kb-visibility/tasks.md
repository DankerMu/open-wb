# Tasks: s2c-kb-visibility

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 没有外部前提：本 change 不碰 omp 子进程治理与 RAGFlow 出站形状（除组 2 的本地截断），全部行为在假 RAGFlow 上可测；真实栈只在 owner 验收（CK 行）。
>
> **打开共享是最后一刀**（design D12）：只有组 11（`PUT …/scope` 与建库的 `scope`）能把库设为非 `me`，种子里没有知识库。组 11 之前的各组对用户是惰性的，
> 它们的测试用带外写 `knowledge_bases.scope` 造出共享库。组 11 依赖全部读面、审计与只读呈现，master 上不出现「能共享、却泄露路径 / 漏审计 / 引用与检索自相矛盾」的中间态。
>
> 依赖（真实依赖）：
> - 无前置：组 1 首刀（1.1–1.4）、组 2、组 3、组 4。
> - 组 1 第二刀（1.5–1.7）← 1 首刀。组 5 ← 1 首刀。
> - 组 6 ← 5。组 7 ← 5。组 8 ← 5、7；与组 3 改同一个文件 `session-search.ts`，宜在组 3 之后合入（文件冲突，不是逻辑依赖）。
> - 组 9 ← 5。组 10 ← 5。
> - 组 11 ← 1 第二刀、6、7、8、9、10。组 12 ← 1 第二刀、11。组 13 ← 9、12。组 14 ← 1–13 全部。
>
> 跨服务的严格解析：web 按严格键集解析 `BaseView`（`web/src/lib/api-kb.ts:212` 的 `BASE_KEYS`），所以组 5 给 `BaseView` 加三键时，web 解析器、web 单测夹具**与 ui-walk 的 `page.route` 桩**
> （`web/e2e/ui-walk-center-kb.ts:46-57` 的 `BASE`，`ui-walk-chat-kb.ts:33-36` 复用它）SHALL 在同一个 PR 里改，否则 CI 的 `ui-walk`（`all-checks-passed` 成员，`make check` 不跑）变红。
> `DocumentView` 的 `workspaceId`、`path` 已允许 `null`（`api-kb.ts:419-420`），组 6 不改 web。
>
> 文件行数（size-guard 上限 800，含测试）：源码 `server/src/app.ts` 767、`web/src/lib/api.ts` 691、`server/src/kb/documents.ts` 675、`server/src/kb/store.ts` 658、`server/src/sessions/rest.ts` 619、`web/src/lib/api-kb.ts` 610；
> 测试 `server/test/auth-schema.test.ts` 737、`server/test/kb-documents-list.test.ts` 735、`web/test/api-kb.test.ts` 688、`web/test/center-kb-retrieval.test.tsx` 647。
> 新逻辑放进下面点名的新文件；上面这些测试文件只改既有断言，不加新用例（新用例进点名的新测试文件）。`app.ts` 预期不改（kb 经已声明的 `kb → accounts` 依赖直接导入 `accounts/scope.ts`）。
>
> 精确形状断言原地改（Code Canonicality：在权威文件里改，SHALL NOT 在新文件里另写一份）：迁移目录计数（`server/test/core-db-helpers.ts:34-61,106-133`）、`accounts` 列清单（`auth-schema.test.ts:54,446`，保留「010 契约恰 5 列」的语义、另断言 053 之后多 `department`）、
> `knowledge_bases` 列与外键清单（`kb-schema.test.ts:107-127,177`）、`BaseView` 键集（`kb-bases-list.test.ts:18-30`、`kb-bases.test.ts:141-153`、`kb-bases-compile.test.ts:188`）、`kb.create` detail（`kb-bases.test.ts:161`）、content-parser 归属集计数（`server/test/http-parser-owners.test.ts`）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 权限 / 多租户过滤（灰盒例外候选） | 是 | 组 5 的两级归属与可见判定：PR 标注请求白盒审查；404 与不存在逐字节相同的用例 |
| 不变量 1（共享只读） | 是 | 组 5 写路由 403 矩阵；组 7 非所有者检索测试不写回 |
| 不变量 2（整篇文档进上下文） | 否 | 本 change 不改给模型的文本形状（除 (a) 的一句措辞） |
| 审计 | 是 | 组 11 `kb.scope`；组 7、组 8 `kb.shared_retrieval` 的时点、中止与失败语义、哨兵用例 |
| 迁移与 DB 约束 | 是 | 组 1 首刀 |
| 跨服务契约（`BaseView` 加键而 web 严格解析） | 是 | 组 5 同 PR 改两端与 ui-walk 桩 |
| 隐私（所有者沙箱路径外泄） | 是 | 组 6：非所有者文档列表的三个 `null` 与「不 stat」；组 11 依赖它（D12） |
| 中间态 | 是 | 组 11 最后合入（D12）；依赖头即合入次序约束 |
| 组 1 首刀：迁移原子性与可重试 | 是 | 「组 1 首刀约定」的「中途失败原子回滚」用例：冲突落在第 ⑥ 句，①–⑤ 必须一并回滚 |
| 组 1 首刀：存量数据不变（052 → 053） | 是 | 「升级保留既有的库」：两个库除新两列外逐值不变；其余表逐行、其余 schema 对象、`sqlite_sequence` 不变 |
| 组 1 首刀：回执次序与目录计数 | 是 | `COMPLETE_CATALOG` 27 条；053 紧随 052 |
| 组 1 首刀：种子进生产库 | 是 | 「种子与约束」字面量断言；新库与 052 升级库结果相同 |
| 组 1 首刀：外键语义（RESTRICT 与双向 CASCADE） | 是 | 「列与约束」删 g1 失败且三表不变；「级联」组侧、账号侧各一例 |
| 组 1 首刀：旧迁移不改、旧用例只跟进末尾假设 | 是 | 「既有用例唯一许可改动」清单；PR 描述贴 grep 结果 |
| 组 1 首刀：Principal 与认证应答形状 | 是 | 「053 之后 Principal 不变」：登录与 `GET /api/auth/me` 逐字节 |
| 组 1 首刀：权限 / web / kb 行为 | 否 | 本刀没有应用代码读写新列新表；`server/src/kb/store.ts:600` 的 `toBase` 逐字段取值，`BaseView` 不变 |
| 组 1 第二刀：认证与只给本人 | 是 | 「三个账号」u3（管理员）为 `groups:[]`（没有管理员分支）；u1 带 `?accountId=u3&id=u3` 仍得 u1 的应答；未登录、种子 u4 的预置会话、u4 启用后登录再停用的真实 cookie 都是 401 |
| 组 1 第二刀：公共 API 形状（严格键与键序） | 是 | 每个 200 应答的 `payload` 与字面量逐字节相等：键序 `department, groups`，组内 `id, name, memberCount`，不带成员 id |
| 组 1 第二刀：缓存头 | 是 | no-store 挂在 route 自己的 `onRequest` 上（早于守卫的 `preParsing`）；200 与守卫 401 都断言 `cache-control: no-store`，且 `set-cookie` 为 undefined |
| 组 1 第二刀：只读 | 是 | 登录之后，每次请求前后 `totalChanges` 的差为 0（涵盖 `audit_events`、`auth_sessions`）；停用账号的会话行仍在 |
| 组 1 第二刀：此刻、成员数与码点序 | 是 | 带外改部门、加组、加成员后，用同一个 cookie 立刻看到变化；五个组的名称次序与插入序、id 序、JS UTF-16 序、locale 序都不同；`memberCount` 为 3 证明计的是全组成员 |
| 组 1 第二刀：与知识库开关无关 | 是 | `withApp({})` 不注入 kb（`server/src/kb/index.ts:99-103`），在这个装配下 200 |
| 组 1 第二刀：依赖方向与 SQL 落点 | 是 | 用例扫描 `server/src/accounts/*.ts`，不得出现对 `../kb/` 的导入；读 `department` 与 `project_group_members` 的 SQL 只在 `accounts/scope.ts`（knowledge-bases/spec.md:49，组 5 的扫描依赖它） |
| 组 1 第二刀：迁移 / web / kb 行为 | 否 | 不改 schema、web、kb；`app.ts` 不改（`registerAccounts` 已在 `server/src/app.ts:383` 注册） |
| 组 2：截断在关联之后 | 是 | 例 2：第 2、5 条关联不上 → 其余 6 条；先截断再关联会只剩 4 条 |
| 组 2：只有例 1 先红后绿 | 是 | 例 1 改前得 8 条（红）；例 2 改前已是 6 条，是次序守卫，#2028 AC「两例先红后绿」照此读 |
| 组 2：出站形状与消费者不变 | 是 | 请求 body 原样（`server/test/kb-retrieval.test.ts:62-69`）；检索测试 `server/src/kb/retrieval.ts:233`、会话检索 `server/src/kb/session-search.ts:149` 的既有用例原样全绿；`server/src/sessions/kb-hits.ts:45` 的 `MAX_HITS` 不动、不合并 |
| 组 3：`details` 键集与 `kb.hits` 枚举不变 | 是 | 措辞只改 `render` 的文本；`BaseOutcome` 仍恰 `kbId, name, status, hits`（`sessions/kb-hits.ts:42` 严格解码），新用例对整个结果 `toStrictEqual` |
| 组 3：原始计数与既有用例冲突 | 是 | `kb-session-search.test.ts:359-375`（六个原始元素去重后五个照常执行）与新规则相反，原地改写，不另写一份 |
| 组 3：只有两例先红后绿 | 是 | `rebuild_failed` 那句与 `[K1,K1,K1,K1,K1,K2]` 改前为红；「六个不同的 id」改前已绿，#2029 AC「两个场景先红后绿」按场景读 |
| 组 3：web 检索卡仍写「正在重建」 | 否 | `web/src/features/chat/kb-search-card.tsx:25` 只按 `status` 出文案；本 change 无 chat-web delta，D7 不动跨服务枚举，`rebuild_failed` 的库在卡上仍显示「正在重建，本轮未检索」（已知残留，不在本组） |

## 1. 迁移 053 与账号范围读取（account-groups 全部；knowledge-bases「迁移 053 知识库范围列」；dev-stub-auth「账号与认证会话数据基座」）

- [x] 1.1 核对 Context：`server/src/core/db/migrations/010_auth_schema_seed.sql`、`052_chat_message_knowledge_bases.sql` 的写法（事务归 runner、无 `IF NOT EXISTS`）；`server/test/core-db-helpers.ts:34-61,106-133` 的迁移清单与计数；`server/test/auth-schema.test.ts:54,446` 与 `kb-schema.test.ts:107-127,177` 的精确形状断言
- [x] 1.2 测试先行：新文件 `server/test/migration-053.test.ts` 覆盖 account-groups「迁移 053 部门与项目组」与 knowledge-bases「迁移 053 知识库范围列」的全部场景（种子、CHECK、外键 RESTRICT 与 CASCADE、052 → 053 升级保留既有库），以及 dev-stub-auth「053 之后 Principal 不变」（登录与 `GET /api/auth/me` 不含 `department`）
- [x] 1.3 实现 `053_kb_visibility.sql`（design D1；列级 CHECK 引用另一列已于 2026-11-17 在 node:sqlite 实测可用，以 1.2 的用例为准）
- [x] 1.4 原地改精确形状断言：迁移清单与计数 +1；`auth-schema.test.ts` 保留 010 的 5 列契约断言、对全量迁移后的库断言多 `department`；`kb-schema.test.ts` 的列与外键清单加两列
  - 组 1 首刀约定（#2026 fixture 审查补；1.2–1.4 照此实现与测试）：
    - 迁移文件 `server/src/core/db/migrations/053_kb_visibility.sql`：文件头注释照 052 的写法，写明：来源（#2026，s2c-kb-visibility design D1；account-groups「迁移 053 部门与项目组」、knowledge-bases「迁移 053 知识库范围列」）；种子与 010 同一先例进生产库；`scope_group_id` 用 RESTRICT 的理由（S3a 删组前先把库退回 `me`）；不含 `IF NOT EXISTS` / `OR IGNORE` / `OR REPLACE`（同名冲突必须让事务失败）；事务与回执归 runner（无 BEGIN / COMMIT / PRAGMA）；迁移不逆转。更早的迁移文件一律不改。
      - 正文语句次序固定（回滚用例依赖它）：① `ALTER TABLE accounts ADD COLUMN department TEXT NULL CHECK (…)` ② `CREATE TABLE project_groups` ③ `CREATE TABLE project_group_members` ④ `CREATE INDEX project_group_members_account ON project_group_members(account_id)`（命名照 `experts_owner`、`chat_approvals_message`）⑤ `ALTER TABLE knowledge_bases ADD COLUMN scope TEXT NOT NULL DEFAULT 'me' CHECK (scope IN ('me','dept','group','all'))` ⑥ `ALTER TABLE knowledge_bases ADD COLUMN scope_group_id TEXT NULL REFERENCES project_groups(id) ON DELETE RESTRICT CHECK ((scope = 'group') = (scope_group_id IS NOT NULL))` ⑦ `UPDATE accounts` 给 u1 `平台研发部`、u2 `数据部`、u3 `产品部` ⑧ `INSERT INTO project_groups` 一行 `('g1','内网落地专项',0)` ⑨ `INSERT INTO project_group_members` 两行 `('g1','u1')`、`('g1','u2')`。
      - 文本 CHECK 照 `050_knowledge_bases.sql:62-67`：`typeof(x) = 'text' AND length(x) BETWEEN 1 AND 64 AND instr(x, char(0)) = 0 AND x NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')`。用于 `department`（另允许 NULL）、`project_groups.id`、`project_groups.name`。
      - `project_groups.created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0)`：规格写「非负整数」，以规格为准。g1 的种子值为 0（不取墙钟，先例是 050 `kb_settings.updated_at` 从 0 起）。
      - `project_group_members(group_id TEXT NOT NULL REFERENCES project_groups(id) ON DELETE CASCADE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, PRIMARY KEY (group_id, account_id))`。
      - 不给 `accounts.department`、`knowledge_bases.scope`、`knowledge_bases.scope_group_id` 建索引，也不加触发器：`auth-schema.test.ts:490` 与 `kb-schema.test.ts:180` 的 `uniqueIndexKeys` 要求这两张表上只有唯一索引。
    - 权威用例：新文件 `server/test/migration-053.test.ts`（头部规定 `auth-schema.test.ts` 737 行等文件不加新用例）。053 按目录位置定位：`POS = TRACKED_MIGRATION_FILENAMES.indexOf(MIGRATION_053)`，紧随 052。期望值写字面量，不从迁移反推。
      - 目录：`POS` 为 26；`TRACKED_MIGRATION_FILENAMES[25]` 为 `MIGRATION_052`；053 恰出现一次；`COMPLETE_CATALOG.receipts[26]` 为 `[27, MIGRATION_053]`；`sequenceRows` 为 `[["schema_migrations", 27, "integer"]]`。源码不匹配 `/\b(IF NOT EXISTS|OR IGNORE|OR REPLACE|BEGIN|COMMIT|PRAGMA)\b/i`。
      - 新库形状（`:memory:` 与新文件各一次；新文件再走 `expectRepeatedOpenStable`）：
        - `PRAGMA table_info(accounts)` 末行为 `["department","TEXT",0,null,0]`，前 5 行列名为 `id, account, role, disabled, password_hash`。
        - `project_groups` 为 `[["id","TEXT",1,null,1],["name","TEXT",1,null,0],["created_at","INTEGER",1,null,0]]`。
        - `project_group_members` 为 `[["group_id","TEXT",1,null,1],["account_id","TEXT",1,null,2]]`；`sortedForeignKeys` 为 `account_id→accounts.id CASCADE`、`group_id→project_groups.id CASCADE`；`PRAGMA index_list` 含非唯一、非部分的 `project_group_members_account`，列为 `account_id`。
        - `knowledge_bases` 末两行为 `["scope","TEXT",1,"'me'",0]`、`["scope_group_id","TEXT",0,null,0]`。
        - `PRAGMA foreign_key_check` 为 `[]`。
      - 「种子与约束」：
        - `SELECT id, department FROM accounts ORDER BY id` 为 `[{u1,平台研发部},{u2,数据部},{u3,产品部},{u4,null}]`；`project_groups` 为 `[{id:"g1",name:"内网落地专项",created_at:0}]`；`project_group_members ORDER BY group_id, account_id` 为 `[{g1,u1},{g1,u2}]`。
        - 五次写入各自报错，每次之后 accounts 整表、`project_groups`、`project_group_members` 逐行不变：`UPDATE accounts SET department = ? WHERE id = 'u1'` 写 `''`、`'部'.repeat(65)`、`'a\u0007b'`，均为 `/CHECK constraint failed/`；`INSERT INTO project_groups VALUES ('g2','内网落地专项',0)` 为 `/UNIQUE constraint failed: project_groups.name/`；`INSERT INTO project_group_members VALUES ('g1','nope')` 为 `/FOREIGN KEY constraint failed/`。
        - 最后写 `'部'.repeat(64)` 成功：按字符计长，不按字节。
      - 「列与约束」（knowledge-bases）：新库插入 `BASE_ROW`（`kb-store-helpers.ts:20`，owner u1）。
        - 依次 `UPDATE`：`('group', NULL)` 为 CHECK；`('all','g1')` 为 CHECK；`('group','g9')` 为 FOREIGN KEY；`('team', NULL)` 为 CHECK。每次之后该行 `{scope:'me', scope_group_id:null}`。
        - 再写 `('group','g1')` 成功。
        - 然后 `DELETE FROM project_groups WHERE id = 'g1'` 为 FOREIGN KEY：g1 行、两条成员行与库行（`group`/`g1`）都不变。
      - 「级联」：新库 `DELETE FROM project_groups WHERE id = 'g1'` 后成员表为 `[]`，accounts 不变；另一个新库 `DELETE FROM accounts WHERE id = 'u2'` 后成员表为 `[{g1,u1}]`。
      - 「升级保留既有的库」：
        - `seedThrough`（`core-db-session-fixture.ts:222`）停在 052，插入 `BASE_ROW` 与 `{...COMPILE_ROW, id: hex(2), owner_id: "u2", name: "数据手册", dataset_id: "ds-2"}`。读 before：两库整行、accounts 的 5 列、`tbl_name` 不在四张表（`accounts`、`knowledge_bases`、`project_groups`、`project_group_members`）里的 `sqlite_master` 行，以及其余每张表 `SELECT * … ORDER BY rowid`。
        - `openDb` 之后：
          - 两库 `scope` 为 `'me'`、`scope_group_id` 为 NULL，其余列逐值等于 before；
          - accounts 的 5 列等于 before，部门与 g1、成员同新库字面量；
          - 其余表、schema 对象、除 `schema_migrations` 外的 `sqlite_sequence` 都不变；
          - 回执 `ledgerRows(db).slice(25, 27)` 为 `[[26, MIGRATION_052],[27, MIGRATION_053]]`；`expectCatalogSnapshot(db, COMPLETE_CATALOG)`；`expectRepeatedOpenStable` 通过。
      - 「中途失败原子回滚」：
        - 停在 052 的副本插入同样两库后，手工 `ALTER TABLE knowledge_bases ADD COLUMN scope_group_id TEXT` 预置冲突。`expectOpenDbFailure(file, /duplicate column name: scope_group_id/)`。
        - 之后 `fullCatalogSnapshot` 与此前相等；无 053 回执；`columnNames(db, "accounts")` 恰为 5 列（①已回滚）；`tableExists` 对 `project_groups`、`project_group_members` 为 false（②③已回滚）；`knowledge_bases` 无 `scope` 列（⑤已回滚）；两库整行不变。
        - 然后 `ALTER TABLE knowledge_bases DROP COLUMN scope_group_id`，重试恰应用一次，结果与「升级保留既有的库」相同，再开一次稳定。
      - 「053 之后 Principal 不变」：`withApp({}, …)`（`auth-lifecycle-helpers.ts:71`）。
        - 以 `CREDENTIALS`（`session-db-helpers.ts:15`）`POST /api/auth/login`，200，payload 逐字节为 `{"id":"u1","account":"zhangsan","role":"成员"}`。
        - 带它的 cookie 调 `requestMe`（`auth-lifecycle-helpers.ts:95`），payload 逐字节相同，`Object.keys` 为 `["id","account","role"]`。
        - 同一库里 `SELECT department FROM accounts WHERE id='u1'` 为 `平台研发部`（列存在但不外泄）。
      - 不复制 `migration-052.test.ts` 的 `COLUMNS_051` / `kept`（jscpd）；`kb-schema.test.ts:240-248` 的 `rowsWithout` 原地移进 `kb-store-helpers.ts` 导出，由两个文件共用。
    - 目录与计数（`core-db-helpers.ts`）：`:33` 后加 `MIGRATION_053 = "053_kb_visibility.sql"`；`:60` 后进跟踪清单；`:132` 后加 `[27, MIGRATION_053]`；`:134` 改为 27（注意 1.1 引的 106-133 不含 `:134`）；另导出一个常量，列 053 触及的四张表（`accounts`、`knowledge_bases`、`project_groups`、`project_group_members`），供下面的剔除共用。
    - 既有用例唯一许可改动（凡断言「完整链末尾是 052」或「完整链的 accounts / knowledge_bases / schema 对象全集」的地方原地跟进；只停在更早迁移、按位置截前缀的用例不动）：
      - `auth-schema.test.ts:446` 改为 `[...EXPECTED_ACCOUNT_COLUMNS, "department"]`；`:54` 常量作为 010 契约 5 列保留，名字和值都不改。`:496-518` 表清单在 `"mount_sources"` 后插入 `"project_group_members"`、`"project_groups"`（BINARY 序，`_` < `s`）。调用点 `:131`、`:365` 不改。
      - `kb-schema.test.ts`：
        - `:107-127` 末尾加两行列元组；`:177` 改为 `[["owner_id","accounts","id","RESTRICT"],["scope_group_id","project_groups","id","RESTRICT"]]`。
        - `:200` 与 `:341` 的 schema 比较两侧按 `tbl_name` 剔除四表对象（`with052` 保留；四表的变化由 migration-053 逐项断言），不得为此整体放宽 `existingSchema` / `untouchedSchema` 的其余部分。
        - `:196/201` 两侧都改为不含 `department` 的读法（`rowsWithout(db, "accounts", ["department"])`）。
        - `:343` 的 dropped 加 `scope`、`scope_group_id`。
        - `:352` 改为 `[["schema_migrations", TRACKED_MIGRATION_FILENAMES.length, "integer"]]`（先例 `migration-045.test.ts:284`）。
      - `migration-052.test.ts`：`:146` 同样剔除四表对象（保留 `name <> 'chat_messages'`）；`:167` 改为 `{ seq: TRACKED_MIGRATION_FILENAMES.length }`；`:217` 同 `kb-schema.test.ts:352` 的改法。
      - `core-db-session-fixture.ts:312` 的 `NOT IN` 列表末尾加 `'project_groups','project_group_members'`。这一处让 `preservedState` 的 10 个使用者跟随：`core-db-message-error`、`core-db-message-thinking-ms`、`core-db-session-archive`、`core-db-session-composer`、`core-db-session-metadata`、`core-db-session-todo`、`core-db-turn-snapshots`、`core-db-workspace-temporary`、`migration-045`、`migration-052`，这些文件本身不改。
      - 例外：用「排除其后每个迁移」搭早期前缀的 `migration-034.test.ts:273-291` 在 `:291` 后加 `MIGRATION_053`（import 在 `:43` 后）；`core-db-chat-step-output.test.ts:98` 改为 `&&` 并加 `asset.filename !== MIGRATION_053`（import 在 `:36` 后）。不改成别的写法。
      - 已核实不需要改：
        - 按 `TRACKED_MIGRATION_FILENAMES.length` 断言的：`core-db-turn-snapshots.test.ts:206,231`、`core-db-session-todo.test.ts:67`、`migration-045.test.ts:284`、`experts-store.test.ts:124`、`connectors-store.test.ts:122`、`mounts-store.test.ts:170`。
        - 同库前后快照：`app.test.ts:229-255`、`auth-login.test.ts:572-577`、`kb-session-search.test.ts:186,271`、`kb-store.test.ts:528-595`。
        - 列冻结在 045：`models-store.test.ts:157-199`。
        - 停在 047：`experts-store.test.ts:183-187`。
        - accounts 显式 5 列读取：`auth-schema.test.ts:576`、`core-db-chat-schema.test.ts:254`、`session-db-helpers.ts:86`。
        - 实施时再 grep 一遍，把完整清单写进 PR。
    - 行数（上限 800）：
      - 新测试文件 ≤ 400；`core-db-helpers.ts` 556 → ≤ 562；`auth-schema.test.ts` 737 → ≤ 740；`kb-schema.test.ts` 495 → ≤ 505；`migration-052.test.ts` 277 → ≤ 282；`core-db-session-fixture.ts` 404 不增；`migration-034.test.ts` 722 → ≤ 724；`core-db-chat-step-output.test.ts` 188 → ≤ 190；`kb-store-helpers.ts` 130 → ≤ 142。
      - 本 PR 预计超过 400 行（review-only），PR 描述援引组 1 的 Width exception 说明理由。
    - 非目标：
      - `scopeOf` 与 `GET /api/accounts/me/scope`（1.5–1.7）；任何读写 `scope` / 部门 / 项目组的 kb 或 accounts 代码（组 5 起）。
      - 新列上的索引、触发器；文档同步（组 14）；web。
      - 缺 u1 或 u2 的存量库：应用侧没有删改账号的路径（`server/src` 里只有 010 写 accounts），种子成员行的外键失败不在输入域内。
    - 回归命令：
      - `npm run test:focus --workspace server -- migration-053 migration-0 auth-schema auth-lifecycle auth-login kb-schema kb-store kb-bases core-db`（先红后绿）；
      - 再跑全量 `npm test --workspace server`（schema 断言散在多个文件，全量兜底）；
      - `make lint`、`make typecheck`、`make anti-drift`（jscpd 与 knip：新导出必须有使用者）。
- [x] 1.5 核对 Context：`server/src/accounts/index.ts` 的 `registerAccounts` 与 `/api/audit` 的 no-store 写法
- [x] 1.6 测试先行：新文件 `server/test/accounts-scope.test.ts` 覆盖「账号范围端点」全部场景（u4 先带外启用；停用账号 401；`memberCount`）
- [x] 1.7 实现新文件 `server/src/accounts/scope.ts`：`scopeOf(db, accountId) → {department, groups:[{id, name, memberCount}]}`（组按 `name` 码点升序）；`registerAccounts` 注册 `GET /api/accounts/me/scope`
  - 组 1 第二刀约定（#2027 fixture 审查补；1.6–1.7 照此实现与测试）：
    - 文件：
      - 新文件 `server/src/accounts/scope.ts`：只导出 `scopeOf`，是纯读函数，不导入 Fastify，也不导入 `../kb/`。组 11 的 kb 直接导入它，不带路由（system.md:87 已声明 `kb → accounts`）。
      - `server/src/accounts/index.ts`：在 `registerAccounts` 里加一条 `app.get("/api/accounts/me/scope", …)`。PR Boundary 的「注册一行」按「一条路由」理解。
      - 新用例文件 `server/test/accounts-scope.test.ts`。
      - `server/test/session-db-helpers.ts`：在 `:123-125` 的 `disableAccount` 旁边加 `enableAccount(db, id)`（`UPDATE accounts SET disabled = 0 WHERE id = ?`）；`:122` 的注释改为「disabled 状态的写入口（停用与启用）」。组 5.2 的「u4 按需带外启用」复用它。
    - 函数与 SQL：
      - 签名：`export function scopeOf(db: DatabaseSync, accountId: string): { department: string | null; groups: { id: string; name: string; memberCount: number }[] }`。
      - 返回类型写在签名里，不另外导出 interface 或 type：knip 会把本刀无人使用的导出类型报出来（`Makefile:30`，`knip.json` 无 rules 覆盖）。组 11 需要时再导出。
      - 两条预编译语句：
        - ① `SELECT department FROM accounts WHERE id = ?`
        - ② `SELECT g.id, g.name, (SELECT COUNT(*) FROM project_group_members AS c WHERE c.group_id = g.id) AS memberCount FROM project_group_members AS m JOIN project_groups AS g ON g.id = m.group_id WHERE m.account_id = ? ORDER BY g.name`
      - 次序：用 SQL 的 BINARY 排序。UTF-8 字节序就是码点序，`name` 是 UNIQUE，不需要第二排序键。SHALL NOT 在 JS 里 `sort`，也不用 `localeCompare`。
      - `memberCount` 统计该组全部成员行，不联 `disabled`。应用侧不产生停用的成员，种子里也没有。
      - 返回对象按 `department, groups` 构造；组对象按 `id, name, memberCount` 构造；`memberCount` 为 number。
    - 路由：
      - `index.ts:7` 的 `noStoreAuditResponse` 原地改名为 `noStoreResponse`，`:6` 的注释改为同时覆盖 audit 与 scope。审计路由和新路由共用这一个 `onRequest` hook，不另写第二份（Code Canonicality）。
      - handler 照 `:14-17` 的写法：先判断 `principal === null` 就抛 `HttpError("unauthorized")`，然后 `return scopeOf(db, principal.id)`。
      - 不读 `request.query`；不写表，不写审计。
    - 用例：经 `withApp({}, …)`（`auth-lifecycle-helpers.ts:71`，不注入 kb）。原语从 `auth-lifecycle-helpers.js` 导入（`:26` 整体转发 session-db-helpers），包括 `loginSessionPair`、`bearerCookie`、`insertRow`、`testId`、`totalChanges`、`sessionSnapshot`、`accountSnapshot`、`disableAccount`、`enableAccount`、`FIXED_NOW`、`UNAUTHORIZED_ENVELOPE`。
      - 「三个账号」：
        - 准备：先 `enableAccount(db, "u4")`；u1、u2、u3、u4 各自用 `loginSessionPair(app, <account>)` 登录（zhangsan / zhaoliu / lisi / wangwu）。登录之后记下 `totalChanges(db)`。
        - 逐个请求 `GET /api/accounts/me/scope`，每次 200，`cache-control` 为 `no-store`，`payload` 逐字节等于：
          - u1：`{"department":"平台研发部","groups":[{"id":"g1","name":"内网落地专项","memberCount":2}]}`
          - u2：`{"department":"数据部","groups":[{"id":"g1","name":"内网落地专项","memberCount":2}]}`（由 053:55-64 推出，规格未列）
          - u3：`{"department":"产品部","groups":[]}`
          - u4：`{"department":null,"groups":[]}`
        - u1 带 `?accountId=u3&id=u3` 请求，`payload` 等于 u1 的字面量。
        - 全部请求结束后，`totalChanges(db)` 的差为 0。
      - 「此刻、成员数与码点序」：
        - 先用 u3 的 cookie 请求一次，得 `{"department":"产品部","groups":[]}`。
        - 带外写入：
          - 依次插入组 `('g2','\u{1F600}组',0)`、`('g3','a组',0)`、`('g4','｡组',0)`、`('g5','Z组',0)`；
          - 插入成员 `(g2,u3)`、`(g3,u3)`、`(g4,u3)`、`(g5,u3)`、`(g1,u3)`；
          - `UPDATE accounts SET department = '设计部' WHERE id = 'u3'`。
        - 用同一个 u3 cookie 再请求，`payload` 逐字节等于 `{"department":"设计部","groups":[{"id":"g5","name":"Z组","memberCount":1},{"id":"g3","name":"a组","memberCount":1},{"id":"g1","name":"内网落地专项","memberCount":3},{"id":"g4","name":"｡组","memberCount":1},{"id":"g2","name":"😀组","memberCount":1}]}`。各名称首字的码点为 Z 0x5A < a 0x61 < 内 0x5185 < ｡ 0xFF61 < 😀 0x1F600。这个结果与插入序、id 序、JS UTF-16 序（😀 会排在 ｡ 前）、locale 序（a 会排在 Z 前）都不同。
        - u1 再请求，得 `{"department":"平台研发部","groups":[{"id":"g1","name":"内网落地专项","memberCount":3}]}`：g2–g5 不出现，g1 的计数跟着成员变化。
      - 「未登录」：
        - 不带 cookie 请求，401，`payload` 逐字节等于 `{"error":{"code":"unauthorized","message":"请先登录"}}`。
        - `cache-control` 为 `no-store`，`set-cookie` 为 undefined（先例 `accounts.test.ts:163-175`；不用 `expectUnauthorizedTerminal`，它断言 `CLEAR_COOKIE`）。
        - `sessionSnapshot` 与 `accountSnapshot` 不变。
      - 「停用账号」：
        - 种子 u4 保持 `disabled=1`，执行 `insertRow(db, testId("b"), "u4", FIXED_NOW + 60_000)`（先例 `http-guard.test.ts:314-316`），用 `bearerCookie(testId("b"))` 请求。
        - 另一例：`enableAccount` → u4 登录 → `disableAccount(db, "u4")` → 用这个真实 cookie 再请求。
        - 两例的期望与「未登录」逐项相同；会话行仍在，`totalChanges` 的差为 0。
      - 「依赖方向」：用 `readdirSync` 列出 `server/src/accounts/*.ts`，逐个 `readFileSync` 读源码，断言都不匹配 `/from\s+["']\.\.\/kb\//`。源码扫描的先例是 `migration-053.test.ts:59-60,219`。
    - 行数（上限 800）：`server/src/accounts/scope.ts` ≤ 60；`server/src/accounts/index.ts` 41 → ≤ 56；`server/test/accounts-scope.test.ts` ≤ 260；`server/test/session-db-helpers.ts` 251 → ≤ 257；`app.ts`（767）、`accounts.test.ts`（320）、`auth-lifecycle-helpers.ts`（168）不改。PR diff 预计少于 400 行。
    - 非目标：kb 使用 `scopeOf`（组 11）；web 的 `getMyScope`（组 12）；`docs/architecture/system.md:35` 的 `scopeOf(principal)` 签名与端点同步（组 14.1）；功能验收清单行（本刀没有用户可见的界面）；`scopeOf` 遇到不存在的账号 id（守卫保证调用者是已存在的启用账号，组 11 用 `owner_id` 外键，都不在输入域内），不加分支用例；部门与项目组的写接口（S3a）；HEAD 与查询参数校验。
    - 回归命令：`npm run test:focus --workspace server -- accounts-scope`（先红后绿）；`npm run test:focus --workspace server -- accounts http-guard auth-lifecycle auth-session migration-053`；再跑全量 `npm test --workspace server`（覆盖率门禁）；`make lint`、`make typecheck`、`make anti-drift`（knip：`scopeOf` 有 `accounts/index.ts` 使用，`enableAccount` 有新用例使用；jscpd：不复制 no-store hook）。

Suggested fixture level: expanded - 新 schema、种子进生产库、外键语义（RESTRICT 约束 S3a 的删组）。
Minimal mergeable slice: 1.1–1.4 为首刀：迁移由 `openDb` 自动执行，独立 SQL 加形态测试即可合并保绿（先例 `openspec/changes/archive/2026-09-24-s1a-sandbox-audit-files/tasks.md:24`），组 5 只需要它；1.5–1.7（读取函数与端点）由组 11、组 12 消费，依赖首刀的表。

## 2. 单轮检索本地截断（knowledge-bases「单轮检索」，种子 e）

- [x] 2.1 核对 Context：关联本地文档在 `server/src/kb/retrieval.ts:114-129` 的 `retrieveForBase`；`PAGE_SIZE` 在 `server/src/kb/ragflow-retrieval.ts:26`，未导出；`server/test/kb-retrieval.test.ts`（207 行）的故障注入写法
- [x] 2.2 测试先行：在 `kb-retrieval.test.ts` 加「上游多给时本地截断」两例（8 条全可关联 → 前 6 条；8 条中两条关联不上 → 其余 6 条）
- [x] 2.3 实现：导出 `PAGE_SIZE`，`retrieveForBase` 在关联之后 `slice(0, PAGE_SIZE)`；`kb-retrieval-canonical.test.ts` 与检索测试、会话检索的既有用例原样全绿
  - 组 2 约定（#2028 fixture 审查补；2.2–2.3 照此实现与测试）：
    - 注入：两例都用 `fake.fault(ROUTE, {kind:"combo", code:0, data:{chunks:[…8 条…], doc_aggs:[], labels:null, total:8}})`，写法照 `kb-retrieval.test.ts:180-189`，每条只给 `document_id`、`content`、`similarity`。不用 `setRetrievalHits`：假 RAGFlow 不看 `page_size`，以后它若遵守 `page_size`，例 1 会假绿。
    - 本地行：`addLocal(base.id, "rf-a", "a.md")`、`addLocal(base.id, "rf-b", "b.md")`。可关联的切片在 rf-a、rf-b 之间交替，这样能看出上限按命中数算，不按文档数算。
    - 切片 #1…#8：`content` 依次为 `段 1`…`段 8`，`similarity` 依次为 0.3、0.8、0.5、0.9、0.1、0.7、0.95、0.6（不单调，#7 最高，先排序再截会留下它）。
    - 例 1（8 条都能关联）：结果恰为 #1–#6，次序同应答；`fake.requests()` 恰 1 次。改前得 8 条，是先红的那一例。
    - 例 2：#2、#5 的 `document_id` 为 `rf-orphan-2`、`rf-orphan-5`，任何库都没有这两个本地行（同 `kb-retrieval.test.ts:117` 的 `rf-orphan`）。结果恰为 #1、#3、#4、#6、#7、#8。改前已绿，它守的是截断次序：先截断再关联只剩 4 条。
    - 期望值写字面量。测试不 import `PAGE_SIZE`（文件头 `kb-retrieval.test.ts:4`：不从 `src/` 取期望值）。
    - 实现：`ragflow-retrieval.ts:26` 改为 `export const PAGE_SIZE = 6;`，加一行 JSDoc，说明请求的 `page_size` 和关联后的截断都用它。`retrieval.ts:26` 改为 `import { PAGE_SIZE, type RetrievalQuery } from "./ragflow-retrieval.js"`（不是 `ragflow-client.ts:58` 那个 100）。`retrieval.ts:130` 返回 `hits.slice(0, PAGE_SIZE)`。`retrieval.ts:11-12` 文件头「命中关联」一条补一句「关联之后至多保留前 `PAGE_SIZE` 条」。
    - 不动：`session-search.ts:24` 的工具描述；`sessions/kb-hits.ts:45` 的 `MAX_HITS`（会话侧对子进程事件的独立校验，不在本 PR 合并）。
    - 行数：`kb-retrieval.test.ts` 207（+约 45）、`retrieval.ts` 240、`ragflow-retrieval.ts` 91，都远低于 800。
    - 回归命令：`npm run test:focus --workspace server -- kb-retrieval kb-session-search session-kb-hits session-host-tool-align`（`kb-retrieval` 已匹配 canonical、endpoint、abort、rerank），再跑 `make lint`、`make typecheck`、`make anti-drift`（knip：`PAGE_SIZE` 由 `retrieval.ts` 使用），最后 `make check`。

Suggested fixture level: compact - 一个已有函数内的一行截断与一个常量导出，没有接口、schema 或权限变化。
Minimal mergeable slice: atomic - 一处改动对应一个场景的两例，无可再分。

## 3. 会话检索的措辞与计数（knowledge-bases「会话检索 `kb_search`」的种子 a、b）

- [ ] 3.1 核对 Context：`server/src/kb/session-search.ts` 的 `render`（:111-118，`not_ready` 固定一句）与 `parseArgs`（:78-102，去重后才判上限）；`server/test/kb-session-search.test.ts`（450 行）；chat-stream 的 `kb.hits` `status` 枚举（不改）
- [ ] 3.2 测试先行：在 `kb-session-search.test.ts` 加「重建失败与重建中分开措辞」，改写「参数校验」（六个不同的 id 与六元素含重复两例）
- [ ] 3.3 实现：`render` 按库的 `state` 分两句，`details.status` 仍为 `not_ready`；`parseArgs` 先按原始数组判 1–5 再去重
  - 组 3 约定（#2029 fixture 审查补；3.2–3.3 照此实现与测试）：
    - 3.1 的行号更正：`render` 为 `session-search.ts:111-129`（`not_ready` 分支 `:116-117`）；`parseArgs` `:79-102`，去重在 `:94`。
    - `state` 的来路：`render` 改为 `render(entry: BaseOutcome, state: KnowledgeBase["state"] | undefined)`；`execute`（`:186`）改为 `bases.map((entry) => render(entry, owned.get(entry.kbId)?.state))`，取的是 `:181` 同一份 `owned`（与 `searchOne` 判定用的是同一次读取）。`BaseOutcome` 与 `outcome()` 不改，不加第五个键。组 8 把 `owned` 换成可见集合时，这一处跟着换。
    - 映射：`not_ready` 分支里，`rebuild_failed` → `${label}：重建失败，本轮未检索`；`rebuilding` → `${label}：正在重建，本轮未检索`（原句）。`status` 两者都是 `not_ready`；`ready` 走不到这个分支（`:146`）。
    - `parseArgs` 次序：键集 → `question` → `kb_ids` 的形状（`:91-93` 原样）→ 原始 `kbIds.length === 0` 返回 `kb_ids 至少含一个知识库 id`（`:96` 原文）→ 原始长度大于 `MAX_BASES` 返回 `一次至多检索 ${MAX_BASES} 个知识库` → 最后 `[...new Set(kbIds)]`。`:12` 的文件头改为「`kb_ids` 的形状 → 原始个数（1–5，与 schema `maxItems` 同一口径）→ 按首次出现去重」；`:78` 的注释保留「合规时给出去重后的参数」。
    - 新用例 `describe("重建失败与重建中分开措辞")`：`:62` 的 `BaseSeed.state` 加上 `"rebuild_failed"`。在用例内部，`seeded()` 之后执行 `seedBase(world, { id: K4, name: "迁移手册", createdAt: 4_000, state: "rebuild_failed" })`，其中 `K4 = "e5".repeat(16)`。不进 `seeded()`，否则「定义」`:154-167` 会断。用 `kb_ids:[K3, K4]` 执行，整个结果 `toStrictEqual` `{text: [`知识库「旧版手册」（${K3}）：正在重建，本轮未检索`, "", `知识库「迁移手册」（${K4}）：重建失败，本轮未检索`].join("\n"), details:{bases:[{kbId:K3,name:"旧版手册",status:"not_ready",hits:[]},{kbId:K4,name:"迁移手册",status:"not_ready",hits:[]}]}, isError:true}`；`world.fake.requests()` 为 `[]`。
    - 「参数校验」原地改：
      - `:335` 那一行拆成两行：`["六个不同的 id", { question: QUESTION, kb_ids: six }]`、`["六元素含重复", { question: QUESTION, kb_ids: [K1, K1, K1, K1, K1, K2] }]`，凑齐规格的八例。
      - `:349-357` 改为对这两组参数 `it.each`，各自 `toStrictEqual({ text: "一次至多检索 5 个知识库", isError: true })`。
      - `:359-375` 改名为「原始五个含重复照常执行并去重；[k1,k1] 只检索一次」：`[K1, K1, "n1", "n2", "n3"]`（原始五个，守住上限边界）的 `isError` 为 false，`kbId` 依次为 `[K1, "n1", "n2", "n3"]`；`[K1, K1]` 的部分不变；`:374` 仍为 2。
      - `:294`（K3 处于 `rebuilding`）不变。
    - 测试文件头 `:2-3` 补一句：「#2029 s2c-kb-visibility 组 3：重建失败与重建中分开措辞；`kb_ids` 按原始个数计」。
    - 行数（上限 800）：`session-search.ts` 206 → ≤ 212；`kb-session-search.test.ts` 450 → ≤ 480（组 8 还要往同一文件加四个场景）。
    - 非目标：`kb.hits` 的 `status` 枚举、`sessions/kb-hits.ts`、web 检索卡文案（`kb-search-card.tsx:25`，残留见风险包）；`session-search.ts:22-27` 的工具描述；可见集合（组 8）。
    - 回归命令：`npm run test:focus --workspace server -- kb-session-search`（先红后绿）；`npm run test:focus --workspace server -- session-kb-hits session-host-tool-align kb-retrieval`；`make lint`、`make typecheck`、`make anti-drift`；最后 `make check`。

Suggested fixture level: compact - 给模型的两句文本与一处计数口径，不改结构化结果与权限。
Minimal mergeable slice: atomic - 两处都是同一个工具的参数与结果契约，同一个测试文件的同一组场景；拆开只会多一次对同一文件的串行改动。

## 4. 内建命令带知识库引用 400（message-attachments「prompt 引用知识库」的种子 c）

- [ ] 4.1 核对 Context：`server/src/sessions/rest.ts:336` 的 `builtin` 计算与附件第 3 条的位置；`server/src/sessions/store-knowledge-bases.ts:38-62` 的 `admitKnowledgeBases`；`server/test/prompt-knowledge-bases.test.ts:279` 的既有用例
- [ ] 4.2 测试先行：把 `prompt-knowledge-bases.test.ts:279` 原地改为断言 400（`/compact`、` /todo` 带引用；`/compact` 带不存在的 id 也是 400）；`/compact` 不带引用与 `knowledgeBases:[]` 照常受理
- [ ] 4.3 实现：内建命令带非空 `knowledgeBases` → 400，位置在可见判定之前、与附件第 3 条相邻

Suggested fixture level: compact - 受理判定多一条拒绝，不改落库与快照。
Minimal mergeable slice: atomic - 一条判定一组用例。

## 5. 可见判定与两级归属（knowledge-bases「可见范围判定」「知识库端点」）

- [ ] 5.1 核对 Context：`server/src/kb/bases.ts:89-99` 的 `ownedBase`、`:283-284` 的 `assertOwned`（`rest.ts:195` 钩子实际调用的入口）与处理函数里的复核点（`documents.ts:364,374,396,635`、`uploads.ts:249,267`、`retrieval.ts:186,196`、`bases.ts:200`）；`kb/store.ts:158,323` 的 `listBases`；列表的编译状态读取；`web/src/lib/api-kb.ts:212` 的 `BASE_KEYS`；web 夹具 `web/test/center-kb-support.tsx`、`chat-kb-ref-support.tsx`、`api-kb-retrieval.test.ts:36`；ui-walk 桩 `web/e2e/ui-walk-center-kb.ts:46-57`
- [ ] 5.2 测试先行（server）：新文件 `server/test/kb-visibility.test.ts`，在假 RAGFlow 上用种子账号与 g1 搭多账号世界（库的范围带外写列；u4 按需带外启用），覆盖「可见范围判定」全部场景（含「只有一处可见判定」的扫描）、「知识库端点」的「403 先于 body」「不可见与不存在不可区分」（`PUT …/scope` 那两次在组 11 加）、「列表的可见集合、次序与非自有的编译状态」，以及「共享库的两级归属」的写路由 403 部分（`PUT …/scope` 的 403 在组 11 加：路由到那时才注册）。本刀里 `GET …/documents` 与 `POST …/retrieval` 对可见非所有者仍为 403（组 6、组 7 放开，用例按本刀行为写、由它们原地改）
- [ ] 5.3 测试先行（web）：新文件 `web/test/api-kb-visibility.test.ts`：`BaseView` 三键的严格解析（多键、缺键、`scope` 越界、`owner.department` 非字符串非 null 即 `requestFailed`）
- [ ] 5.4 实现新文件 `server/src/kb/visibility.ts`（design D2：一条 SQL 的 `visibleBases(viewerId)` 与 `accessOf(id, viewerId)`；列表改经它取可见集合，`kb/store.ts` 不加读 `scope` 列的 SQL）；`ownedBase` 原地改为两级（`readableBase` / `ownedBase`），`assertOwned` 拆读写两个入口，不留旧函数；本刀全部 `:id` 路由仍用 `ownedBase`；列表改为可见集合与 D2 次序，编译状态只为自有库读；`BaseView` 加 `owned`、`owner`、`scope`
- [ ] 5.5 原地改精确形状断言：`kb-bases-list.test.ts:18-30`、`kb-bases.test.ts:141-153`、`kb-bases-compile.test.ts:188`
- [ ] 5.6 实现（web）：`api-kb.ts` 的类型与解析器加三键；web 夹具、`api-kb.test.ts:77` 的 typed `BASE` 与 `api-kb-retrieval.test.ts:36` 补三键；ui-walk 的 `BASE`（`ui-walk-center-kb.ts:46-57`，`ui-walk-chat-kb.ts` 展开复用它）按 `owned:true` 自有库补三键；本刀不改任何组件；本机 `make ui-walk` 全绿，PR 附命令与退出码

Suggested fixture level: expanded - 多租户过滤的唯一判定点（灰盒例外候选）、不可探测性、跨服务严格解析。
Minimal mergeable slice: atomic - 可见判定、两级归属、列表与 `BaseView`（含 web 解析器与 ui-walk 桩）合起来才是可独立验证的「谁能看见哪些库」，且跨服务契约要求同 PR；读面的放开（组 6、组 7）已经各自拆出。

## 6. 非所有者读文档列表（knowledge-bases「文档列表与状态」「知识库端点」读路由）

- [ ] 6.1 核对 Context：`server/src/kb/documents.ts:256-268` 的 `viewOf`（无条件输出 `workspaceId` 与 `path`）、`:635` 的复核点与 `sourceChanged` 的计算路径
- [ ] 6.2 测试先行：在 `kb-visibility.test.ts` 加「非所有者看不到来源」（三个 `null`、不对所有者工作空间做文件系统调用、无审计）；把「共享库的两级归属」里 `GET …/documents` 改为 200
- [ ] 6.3 实现：`GET …/documents` 的钩子与 `documents.ts:635` 改用 `readableBase`；列表按 `owned` 分支，非所有者三键为 `null`、跳过 `sourceChanged` 的解析与 stat

Suggested fixture level: expanded - 隐私不变量（所有者沙箱路径），放开读路由与置空必须原子。
Minimal mergeable slice: atomic - 放开 `GET …/documents` 与非所有者置空必须同时合入，否则中间态把所有者路径交给非所有者。

## 7. 共享检索审计与检索测试对非所有者开放（knowledge-bases「检索测试端点」「知识库审计」`kb.shared_retrieval`）

- [ ] 7.1 核对 Context：`kb/retrieval.ts:184-240`（`readyBase`、参数比较、写锁、写回与审计）；`core/audit` 的 `emit` 与失败传播；`server/test/kb-retrieval-endpoint.test.ts`（443 行）
- [ ] 7.2 测试先行：新文件 `server/test/kb-retrieval-shared.test.ts` 覆盖「非所有者按已存参数检索」「非所有者的 body 仍须合规」「共享审计写失败不检索」；「同一知识库的写操作串行」里「非所有者的检索测试从不取锁」；把「共享库的两级归属」里 `POST …/retrieval` 改为 200
- [ ] 7.3 实现新文件 `server/src/kb/shared-audit.ts`（design D6，只在非所有者时写，detail 取判定时读到的行）；`retrieval.ts` 的非所有者分支跳过比较与写锁、检索前调用它；`POST …/retrieval` 的钩子与复核点改用 `readableBase`

Suggested fixture level: expanded - 审计时点与失败语义、不变量 1（非所有者不写回）。
Minimal mergeable slice: atomic - 放开检索测试与写共享审计必须同时合入，否则中间态出现未审计的跨账号检索。

## 8. 会话检索与知识库引用的可见集合（knowledge-bases「会话检索 `kb_search`」；message-attachments「prompt 引用知识库」的可见受理）

- [ ] 8.1 核对 Context：`server/src/kb/session-search.ts` 的文件头契约（:6「三个函数都经 `listBases(ownerId)` 读一次」）、`ownedBases`（:134，被 `execute` 与 `resolveReferences` 共用）、`definitionFor`、`execute`；`server/src/app.ts:351` 的注入与 `sessions/store-knowledge-bases.ts:18` 的注释
- [ ] 8.2 测试先行：在 `kb-session-search.test.ts` 加「可见的共享库进清单并被检索」「只有共享库的账号」「共享审计写失败只影响该库」「已中止的信号不写共享审计」；新文件 `server/test/kb-shared-audit.test.ts` 完整覆盖「共享检索审计不含问句」（检索测试与 `kb_search` 合计恰两条；u1 经 `GET /api/audit` 看不到、u3 看得到）；新文件 `server/test/prompt-knowledge-bases-shared.test.ts` 覆盖「引用共享给自己的库」
- [ ] 8.3 实现：三个函数共用一次 `visibleBases(viewer)`，原地替换 `ownedBases`（文件头契约同改）；可见的库一个都没有时没有定义；非自有库描述行附所有者账号；非自有 `ready` 库先查中止信号、再调 `auditSharedRetrieval`、再检索；`resolveReferences` 存受理那一刻的名称；`store.listBases`（`kb/store.ts:158,322-323`）此后若只剩测试在用，在本组内删除它与 `SELECT_BASES_BY_OWNER` 及其用例（AGENTS.md：无引用导出同一变更内删除）

Suggested fixture level: expanded - 给模型的工具描述、跨账号审计、不可探测性、引用受理的权限判定。
Minimal mergeable slice: atomic - 定义、执行与引用解析共用同一次可见集合读取（Code Canonicality：不得让同一文件里新旧两份读取并存），验证路径是同一组 `createKbSessionSearch` 与 prompt 路由用例。

## 9. web：共享库的只读呈现（knowledge-bases「中心「知识库」tab」非所有者部分）

- [ ] 9.1 核对 Context：`web/src/features/center/kb/` 的 `list.tsx`、`detail.tsx`、`documents-table.tsx`、`retrieval-panel.tsx`；`web/test/center-kb-list.test.tsx`（356）、`center-kb-detail.test.tsx`（443）；demo :3240-3262、:2781-2803
- [ ] 9.2 测试先行：新文件 `web/test/center-kb-shared.test.tsx` 覆盖「共享库的只读呈现」「所有者没有部门」、列表计数行、四档范围标签文案、自有库与共享库的按钮差异、共享库检索测试两个数字只读
- [ ] 9.3 实现：按 `owned` 分支渲染；共享库的来源列为 `工作空间` / `本地上传`；编译只显示标签；自有库的范围标签本刀为纯文本（组 12 改为按钮）

Suggested fixture level: compact - 纯呈现分支，数据已由组 5 给出。
Minimal mergeable slice: atomic - 列表与详情的只读呈现是同一个 `owned` 分支在相邻组件里的两处，验证路径是同一个组件测试文件。

## 10. web：引用选择列表附所有者（message-attachments「输入框知识库引用」）

- [ ] 10.1 核对 Context：`web/src/features/chat/kb-ref-picker.tsx:20-45`；`web/test/chat-kb-ref-picker.test.tsx`（483）；顺带：`web/src/features/chat/turn-actions.ts:67` 的注释仍写「两个函数引用稳定」，而 `ids` 随 `client` 变化（#1973 的修复 `a41a8444`）
- [ ] 10.2 测试先行：在 `chat-kb-ref-picker.test.tsx` 加「共享库附所有者」「内建命令带引用被拒」（后者断言既有拒绝呈现，不新增前端判定）
- [ ] 10.3 实现：非自有库附 `（<所有者账号>）`；纠正 `turn-actions.ts:67` 的注释

Suggested fixture level: compact - 一处文案分支与一处注释。
Minimal mergeable slice: atomic - 一个组件的一个分支，验证路径单一。

## 11. 打开共享：范围端点与建库范围（knowledge-bases「知识库范围端点」「知识库端点」建库、「同一知识库的写操作串行」、「知识库审计」`kb.scope`；http-service-skeleton「统一错误信封」）

- [ ] 11.1 核对 Context：`kb/bases.ts` 的建库判定与设置锁、`kb.create` 的 detail（`kb-bases.test.ts:161`）；`kb/rest.ts` 的路由注册与 body limit；`accounts/scope.ts` 的 `scopeOf`；`server/src/http/errors.ts:94-133` 的归属集与 `server/test/http-parser-owners.test.ts` 的计数
- [ ] 11.2 测试先行：新文件 `server/test/kb-scope.test.ts` 覆盖「知识库范围端点」全部场景、「知识库端点」的「建库带范围」、「不可见与不存在不可区分」里 `PUT …/scope` 的两次；在 `kb-visibility.test.ts` 的「共享库的两级归属」补上 `PUT …/scope`（合法 body）对可见非所有者 403、范围不变、无 `kb.scope`、假 RAGFlow 零请求；「同一知识库的写操作串行」的「改范围不排队」；`kb-bases.test.ts:161` 的 `kb.create` detail 加 `scope`；`http-parser-owners.test.ts` 的归属集加 `PUT …/scope`、计数改为四十（畸形 JSON 与 `text/plain` 得 400）
- [ ] 11.3 实现新文件 `server/src/kb/scope.ts`（`PUT /api/kb/bases/:id/scope`：`ownedBase` → 形状 → 所有者条件（`scopeOf`）→ 相同不写 → 一条事务 `UPDATE` + `kb.scope`，0 行 404；不取写锁；应答的 `compile` 5 s 期限、失败为 `null`）；建库 body 加 `scope?` / `groupId?`，第 5 步复用同一个所有者条件函数；`errors.ts` 归属集加该路由
- [ ] 11.4 验收清单：在 `docs/acceptance/functional-checklist.md` 的 CK 节加两行（`待签`）：
  - P2 里程碑：`zhangsan` 把「规范库」设为全员可见（组 12 合入前经 `PUT …/scope`，之后经范围对话框）后，`zhaoliu` 在会话里经「+ → 引用知识库…」选 `规范库（zhangsan）`，问一个只有该库能答的问题，回答带出处切片，检索卡显示该库；以 `lisi` 在浏览器打开 `/api/audit`，看到至少一条 `kb.shared_retrieval`，每条 actor 为 `zhaoliu`、detail 的 `ownerId` 为 `u1`、不含问句。
  - 非所有者只读：`zhaoliu` 在中心「知识库」tab 看到该库带 `只读` 与「来自 zhangsan · 平台研发部」，没有删除、入库、上传、移出，文档来源不显示路径，检索测试可用但两个参数不可改。

Suggested fixture level: expanded - 新写端点、审计、parser 归属集、与删库并发的 0 行语义，且是打开共享的开关。
Minimal mergeable slice: atomic - 建库与改范围共用同一个形状与所有者条件判定；它是打开共享的唯一开关，依赖头保证它最后合入（D12）。

## 12. web：范围对话框与新建范围（knowledge-bases「中心「知识库」tab」范围部分；account-groups「账号范围端点」的 web 客户端）

- [ ] 12.1 核对 Context：`web/src/lib/api.ts`（691 行）的审计客户端写法；`getMyScope` 放新文件 `web/src/lib/api-accounts.ts` 并由 `api.ts` 导出；`create-dialog.tsx`；demo :2737-2742、:3058-3092、:3010-3019
- [ ] 12.2 测试先行：新文件 `web/test/api-kb-scope.test.ts`：`getMyScope` 的严格解析（含 `memberCount`）、`setKnowledgeBaseScope` 与 `createKnowledgeBase` 的 `scope` 参数；新文件 `web/test/center-kb-scope.test.tsx`：「范围对话框」「没有部门与没有项目组」「当前档已不可选」「新建时设范围」「新建对话框取不到范围」、范围对话框 `getMyScope` 失败（四档与 `保存` 全部禁用、有 `role="alert"`、`setKnowledgeBaseScope` 零次，与新建对话框只留 `仅自己可见` 不同）与对话框的保存失败态
- [ ] 12.3 实现新文件 `web/src/features/center/kb/scope-dialog.tsx`（四档、预选、组下拉带人数、无组提示、部门空禁用、demo 逐字文案）；列表与详情的自有库范围标签改为按钮；新建对话框内嵌同一组控件
- [ ] 12.4 验收清单：CK 节加一行（`待签`）：`zhangsan` 在中心「知识库」tab 把一个库依次设为「项目组可见 · 内网落地专项」与「全员可见」，`zhaoliu` 刷新后两次都能看到，`lisi` 只在全员可见时看到；再设为「本部门可见」，`zhaoliu`、`lisi` 都看不到（种子里没有与 `zhangsan` 同部门的可登录账号，正向只由 server 单测覆盖）；`lisi` 在浏览器打开 `/api/audit` 看到 `zhangsan` 的三条 `kb.scope`（before → after）。部门为空时 `本部门可见` 置灰只由 12.2 的 web 单测覆盖：种子里唯一没有部门的 `wangwu` 已停用、无法登录

Suggested fixture level: expanded - 新的严格解析器与公开 API 参数（`issue-risk-contract` 的 parser / public API 触发项）。
Minimal mergeable slice: atomic - 范围对话框与新建对话框共用同一组控件与同一个 `getMyScope` 调用，拆开两 PR 改同一个新文件。

## 13. ui-walk：共享知识库分支（knowledge-bases「UI 走查共享知识库」）

- [ ] 13.1 核对 Context：`web/e2e/ui-walk-center-kb.ts`（260 行）的 route 桩与收尾写法；`ui-walk-chat-kb.ts` 的先例
- [ ] 13.2 实现：新兄弟文件 `web/e2e/ui-walk-center-kb-shared.ts` 写两段（只读呈现、范围对话框），由 `ui-walk-center-kb.ts` 调用；应答体严格按 web 解析器的键集
- [ ] 13.3 本机 `make ui-walk` 全绿，PR 附命令与退出码、截图清单

Suggested fixture level: compact - 走查脚本，桩应答，不改产品代码。
Minimal mergeable slice: atomic - 两段共用同一组 route 桩与收尾。

## 14. 收口：文档、计划状态与 Grill 结论落点核对

- [ ] 14.1 `docs/architecture/system.md`：`accounts` 行（`scopeOf`、`GET /api/accounts/me/scope`）、`kb` 行（可见判定、两级归属、范围端点、`kb.shared_retrieval`；删去「S2c change A 只按所有者判定」）、§6.1 时序图里「change A 只有自己的库」一句
- [ ] 14.2 `openspec/glossary.md`：「可见范围」写明四档判定与「动态跟随所有者当前部门 / 查看者当前成员关系」；「附件」里「只能是自己的库」改为「可见的库」；「审计」补 `kb.scope`；「host tool」里「没有库时不注册」改为「没有可见的库时不注册」
- [ ] 14.3 `IMPLEMENTATION_PLAN.md`：S2c 状态（B 交付、待 owner 签收）与 Next Step（签收后可启动 S3a（本地账号与治理，ADR-0018）与 S4a）；`smoke/kb.hurl:13` 注释里的 `BaseView` 键集同步
- [ ] 14.4 逐条核对 design.md「Grill 结论」B1–B19 的落点在代码与规格里成立，核对记录写进 PR 描述

Suggested fixture level: none - 文档与核对，没有行为变化。
Minimal mergeable slice: atomic - 收口文档随最后一个实现 PR 之后一次性落地。
