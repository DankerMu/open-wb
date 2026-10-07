# Tasks: s1f-session-list-temp-space

> 执行顺序：0 ∥（1 → 2 → 3 → 4 → 5 → 6）→ 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16 → 17 → 18 → 19 → 20。
> 组 0（真实 omp 核对）不依赖任何代码，可与组 1–6 并行，但**必须在组 7 开工前完成**（含 0.2 的结论记录与必要的规格修订）：它的结论决定组 7–12、18 是否按现规格实现（design D11 的三行表）。
> 服务端组（1–12）彼此串行（共享迁移序号、`store-metadata.ts`、`rest-metadata.ts`、`session-delete.ts`）。组 6（列表事件）的端点（6.1、6.2）只依赖组 1，可与组 2–5 并行开发；它的触发点接线（6.3–6.5）依赖组 2、4、5 的写入口，排在其后合入。
> web 组（13–18）依赖对应的服务端组：13 ← 4、6、11；14 ← 1、6；15 ← 1、14；16 ← 2、15；17 ← 4、5、13；18 ← 10–13。既有走查步骤的改写不在组 19：第 6 步随 14.4 的 PR、第 7 与 11 步随组 15 的 PR 合入（旧步骤在新界面上必红）。组 19 只有追加的冒烟与走查步骤，依赖组 2、5、17、18；组 20 的 20.1（术语）可提前。
>
> 通用纪律：
> - 每组按各自的 `Minimal mergeable slice` 拆成小 PR，每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿、主干可运行。PR diff 以 400 行为评审参考，超出时按任务再拆。
> - **严格键集同刀落地**：会话 DTO 的三键（组 1）、消息 `undo` 与 prompt 202 的 `undo`（组 10）在服务端与 web 解析必须同一个 PR 合入，否则会话页整体失效。这两组因此跨 server 与 web，是有意的例外。
> - **行数上限 800**：`server/src/sessions/store.ts`（797）不再加行，新逻辑进新模块；`supervisor.ts`（提案时 800；10.3 之后 761）只按 design D15 列出的三处改，且先做腾行（任务 10.3）；`server/test/session-rest.test.ts`（789）、`web/e2e/ui-walk-sessions.spec.ts`（776）、`web/e2e/ui-walk-layout.ts`（793）不净增行，新测试与新走查步骤写进新文件。
> - **knip 的真实前提**：`knip.json` 里 server 与 web 两个 workspace 的 `entry` 都含 `test/**/*.test.ts(x)`，被自己的测试文件引用的导出不算未引用。所以带单测的新模块可以先于它的生产调用方合入；切片行里凡是把任务捆在一起的，理由都是运行期的（主干行为或门禁会坏），不是 knip。
> - **分层守卫**：`web/src/features/chat/` 下新增或重写的 `.ts`/`.tsx` 在同一个 PR 里登记进 `web/test/ui-layering.test.ts` 的 `MIGRATED_AREAS` 并同步清单断言；已登记文件只可从 `web/src/ui` 导入 `Icon`、`IconName`、`BrandMark`、`useEscapeFallback`，不得导入 `useToast`、`Menu`、`Dialog`、`Button` 等旧基元。`chat-module-layout.test.ts` 的导入方向与导出归属约束照旧。
> - **拷入层**（`web/src/components/ui`、`web/src/components/assistant-ui`）不改：本 change 只用已拷入的 `button`、`input`、`dialog`、`alert-dialog`、`dropdown-menu`、`collapsible`、`tooltip`。若确需改动，只限 ADR-0013 的六类修改并在 PR 说明；不拷入新的 registry 组件。`web/src/ui/**` 冻结。
> - knip（无未引用导出）、jscpd（重复 ≤3%）、覆盖率 ≥80% 照常；不以收窄 include 或 skip 换绿。
> - TDD：新增生产文件先写失败测试。每个行为任务给出**变异证据**（去掉或写反对应实现时哪条测试判红），写进 PR 描述。
> - 既有断言只要还有意义就不删除、不削弱；因规格条文在本 change 被改而改写的断言，写进 PR 的偏离记录。
> - 用户可见的变化在 `docs/acceptance/functional-checklist.md` 增改对应行，结论一律 `待签`；agent 不把任何行改为 `通过` / `不通过`。清单行不写带单位的像素值与点号、井号开头的选择器。
> - Critical Paths（AGENTS.md）：组 3、5、7、8、9、10、11、12 触及沙箱与文件边界 / omp 子进程治理，PR 标注请求白盒审查。
> - 仓库是公开的：任何被跟踪文件里不出现主机绝对路径、用户名、IP 或密钥。
> - 本 change 的 MODIFIED 以主规格现文本为底；计数是「主规格现值加本 change 的增量」（design D15）。归档前按任务 20.7 重新对底。

## 0. 前置核对 — 真实 omp 上的 `branch` 与 `--resume`

- [x] 0.1 用 `var/omp/omp`（官方 release v18.0.10，`make omp-fetch`）与受控上游写一个一次性脚本（放在未跟踪的工作目录，不入库），按 design D11 的三行表逐点核对并保存命令与输出：
  - (a) 两轮会话；临时进程 `--resume <会话文件>` → `get_branch_messages` → 对**第二条**用户条目 `branch` → `get_state` 取新文件 → 关停；新进程 `--resume <新文件>`：握手成功、`get_branch_messages` 恰含第一条用户条目、再发一条 prompt 能完成。全部满足即成立。
  - (b) 同样的流程对**第一条**用户条目 `branch`：新文件存在、`--resume` 握手成功、`get_branch_messages` 为空、随后的 prompt 能完成。全部满足即成立。
  - (c) 第一轮发普通 prompt（不建清单），第二轮发 `WORKBUDDY_TODO …`（受控上游让模型建清单）；对第二条用户条目 `branch` 后 `--resume <新文件>`，发 `/todo`：输出恰为 `No todos. Use /todo append <task> to start one.` 即成立；仍列出第二轮建的任务即不成立。
- [x] 0.2 结论落定（一个只改本 change 目录的 PR；组 7 起的任务以它合入为前提）：把三点的结论（成立 / 不成立、所用命令与输出，不含主机信息）记在 design D11 表后的「核对结论」一段。三点都成立时 PR 只加这一段。任一点不成立时，同一个 PR 按 design D11 表的「不成立时的处置」一列改规格与任务，文本以该列为准：
  - (a) 不成立：在本文件文首加一行「组 7–12、13.1 的 `undoMessage`、组 18、19.2 的撤回步骤暂停」，change 停在组 6 之后，报告给 owner（撤回路径不成立，回到设计阶段）；不自行换实现方式。
  - (b) 不成立：message-undo「对话原地回退」第 3 步加「被撤回的是该会话的首条用户消息时不发 `branch`」、第 5 步改为「此时 `omp_session_file` 置 NULL」，场景「撤回第一条」的 THEN 改为「其后的 prompt 不带 `--resume` 启动并 202」；任务 11.5 的实现与 11.7 里「不改 `omp_session_file`」的变异证据随之改。
  - (c) 不成立：`chat_turn_snapshots` 不建 `todo` 列——workspace-snapshots「迁移 039 回合快照登记表」与「受理时做快照」删去 `todo`、删场景「记录当时的任务清单」；message-undo「对话原地回退」第 5 步删去 `todo` 的写回，场景「任务清单回到当时」改为「撤回后 `todo` 与撤回前相同」；本 change 的 `specs/session-todo/spec.md` 删去「任务清单持久化」的 MODIFIED，只留「任务清单快照」；design D9、D11 的对应句与任务 10.1、10.2、10.5、11.2 里的 `todo` 一并删去。
  PR 合入前 `openspec validate s1f-session-list-temp-space --strict --no-interactive` 通过。

Suggested fixture level: none - 只产出核对结论与（必要时）规格修订，没有运行时代码；实现风险由后续各组的 fixture 承担
Minimal mergeable slice: 0.1 + 0.2 一个 PR（结论与它引起的规格修订不能分开：只记结论不改规格，后续各组就会按不成立的规格实现）

## 1. 契约 — 会话视图三键（server + web 同刀）

- [x] 1.1 迁移 `server/src/core/db/migrations/037_chat_session_archive.sql`：`chat_sessions.archived_at`（可空、非负整数 CHECK）。测试加在迁移测试文件：新库与止于 036 的存量库两条路径、列约束的合法与非法取值、受信任迁移计数 +1（chat-sessions「会话数据 schema」的「Migration 037 on fresh and populated databases」「Migration 037 column constraint」）。
  新用例写进新的测试文件（先例 `core-db-session-todo.test.ts`；`core-db-chat-schema.test.ts` 已近 800 行，不净增）。「受信任迁移计数」落在 `server/test/core-db-helpers.ts` 的 `TRACKED_MIGRATION_FILENAMES` 与 `COMPLETE_CATALOG`（回执与序号 10 → 11）。
  把 036 写死为末位、或写死 `chat_sessions` 列清单的既有断言随之同步（只改期望的末位、列清单与回执数，不删除、不削弱，逐条写进 PR 的偏离记录）：`core-db-session-todo.test.ts`、`migration-034.test.ts`、`core-db-chat-schema.test.ts`、`core-db-chat-step-output.test.ts`、`core-db-session-fixture.ts`。
- [x] 1.2 迁移 `038_workspace_temporary.sql`：`workspaces.temporary`（NOT NULL DEFAULT 0、0/1 CHECK）。同一迁移测试文件：存量行读作 0、非法取值被拒、计数 +1、036→037→038 按序且 038 失败时 037 保留（temporary-workspaces「迁移 038 临时标记」两个场景）。
  次序与失败保留的出处是 chat-sessions「会话数据 schema」的「Migrations 037 to 039 apply in order」，本任务只做其中 037→038 的部分：回执止于 036 的文件库依次应用 037、038、各追加一次回执；预置一个无约束的 `workspaces.temporary` 列让 038 失败时 037 及其回执保留、没有 038 的回执，去掉该列后重试 038 恰应用一次（先例 `core-db-session-todo.test.ts` 的 036 冲突用例）。凡涉及 039 的子句归 10.1。
  新用例写进新的测试文件（或 1.1 的 `core-db-session-archive.test.ts`，不让任何文件超过 800 行）。计数缝同 1.1（`core-db-helpers.ts`，回执与序号 11 → 12）。把 037 写死为末位、写死回执数或写死 `workspaces` 列清单的既有断言随之同步（只改期望的末位、回执数与列清单，不删除、不削弱，逐条写进 PR 的偏离记录）：`workspaces-schema.test.ts`（五列全等断言）、`core-db-session-todo.test.ts`、`migration-034.test.ts`、`core-db-chat-step-output.test.ts`，以及运行后实际变红的同类断言。
- [x] 1.3 服务端视图：`SESSION_COLUMNS` / `SessionDbRow` / `toSessionView`（`store.ts` 内只改列集与映射，超行则把列集与映射移到 `store-branch.ts` 或新的 `store-view.ts`）增加 `archivedAt`、`pendingApproval`（`EXISTS` 子查询）、`temporaryWorkspace`（关联 `workspaces.temporary`）；`createSession`、`patchSession`、fork 提交返回的视图同步。测试（新文件 `server/test/session-view-keys.test.ts`，REST seam）：session-metadata「会话视图扩展键」三个场景、chat-sessions「Session views carry the three extension keys」——此时归档与临时空间尚未有写入口，用直接写库构造归档行与绑定临时空间的行。
  到线上的映射面一并改（只改 `store.ts` 三键到不了响应）：`server/src/sessions/rest.ts` 的 `PublicSession` 与 `toPublicSession`（列表、fork、快照三个出口都走它）、`server/src/sessions/store-metadata.ts` 的 `CreatedSessionView` 与 `createSession` 手写的视图字面量。键序为既有八键之后依次 `archivedAt`、`pendingApproval`、`temporaryWorkspace`（既有测试按 `Object.keys` 的次序断言）。`store.ts` 已 797 行：列集、行类型与映射移到新的 `store-view.ts`，由 `store.ts` 再导出，既有导入方不改。
  既有的服务端键集断言随之同步（只改期望的键集与空值夹具，不删除、不削弱，写进 PR 的偏离记录）：`server/test/session-meta-fixtures.ts` 的 `SESSION_VIEW_KEYS` / `NULL_SESSION_META`（扇出到 fork、快照、todo 各测试），`session-metadata-rest.test.ts` 与 `session-title-rollback.test.ts` 的 `EIGHT_KEYS`，`session-fork.test.ts` 的键集断言。
  过渡偏离：规格两条场景里「无 body 创建 → `temporaryWorkspace` 为 true」在本刀不成立（无 body 创建此时仍是 `workspaceId:null`），本刀的测试用直接写库构造、smoke 断言 false；5.6 / 5.8 再回到规格字面。写进 PR 的偏离记录。
- [x] 1.4 web 解析：`web/src/lib/session-contract.ts` 的会话解析改为十一键并逐键校验（含 `workspaceId:null` 且 `temporaryWorkspace:true` 拒绝），`ChatSession` 类型同步；`patchSession` 的 patch 类型加 `archived`。测试改写 `web/test` 里的会话契约用例：session-sidebar「会话 DTO 严格解析」两个场景、chat-web「API 客户端扩展」的「八键会话与思考、变更字段严格解析」。全仓测试夹具里的会话对象补三键（集中在既有夹具 `web/test/session-meta-fixtures.ts` 的 `NULL_SESSION_META` 与 `web/test/chat-page-session-meta-support.tsx`）。
- [x] 1.5 `smoke/session-meta.hurl`：键数断言 8 → 11 及三键取值（`archivedAt` null、`pendingApproval` false、`temporaryWorkspace` false）；无 body 创建的 `workspaceId == null` 断言此时仍成立，不动（它在 5.8 随创建语义一起改）。`make smoke` 两遍通过。
- [x] 1.6 变异证据：服务端少发一键 → 1.3 与 1.5 判红；web 仍按八键解析 → 1.4 的「十一键接受」判红；`pendingApproval` 恒 false → 1.3「三键的取值」判红。

Suggested fixture level: expanded - 公共 API 的严格键集、两个 schema 迁移、server 与 web 必须同时改
Risk packs: Public API（1.3 / 1.5 的键集场景）、Schema / 字段名（1.1 / 1.2 迁移测试、1.3 取值场景）、Legacy compatibility（1.4 的严格解析拒绝旧八键；1.3 + 1.4 + 1.5 同刀）；不选 File IO、Concurrency、Auth（本组无写入口、无文件操作）。
Minimal mergeable slice: 1.1、1.2 各自可先单独合入（只增列的迁移，自带迁移测试，没有读者也绿）；1.3 + 1.4 + 1.5 atomic: 会话 DTO 是双侧严格键集，服务端加键与 web 解析任一侧单独合入都会让会话页把全部响应判为非法

## 2. server — 归档

- [x] 2.1 `server/src/core/errors` 增加 `session_archived`（message `会话已归档，恢复后才能继续对话`），`server/src/http` 的状态映射为 409。测试：http-service-skeleton「归档与撤回冲突的错误码」中 `session_archived` 的一半；既有「N 码」断言的计数同步（十三 → 十四，11.1 再加到十五）。
- [x] 2.2 `store-metadata.ts` 的 `patchSession` 支持 `archived`：`true` 用带条件的 UPDATE（`status != 'running'`）并由路由在同一同步段内检查控制占用，条件不满足时整个 PATCH 不写；`false` 置 NULL。`rest-metadata.ts` 的 body 校验加 `archived`（布尔）。测试（新文件 `server/test/session-archive.test.ts`）：session-metadata「会话归档」的「归档与恢复」「运行中与占用期间不能归档」「鉴权」，「会话元数据修改」的「归档键与其它键一起修改」与「非法 body 与鉴权」里新增的两例。
  **实施注记（fixture 评审补充）**：
  - 控制占用的检查口：`rest-metadata.ts` 的依赖增加 `supervisor: Pick<SessionSupervisorPort, "controlHeld">`（由 `rest.ts` 注册处传入；prompt 路由已有同样的用法）。`archived: true` 时先查 `controlHeld`，命中即 409 `session_busy`，与 UPDATE 之间没有 await。
  - 带条件的 UPDATE 命中 0 行有两种含义，`patchSession` 因此返回三态：视图 / 行不存在（→ 404，同今天）/ 条件不满足（→ 409 `session_busy`）。「条件不满足」由同一同步段内按 owner 复读该行是否存在判定。409 时整个 PATCH 不写，也不调 `noteTitleWrite`。
  - `archived: true` 写 `archived_at = COALESCE(archived_at, ?)`（重复归档不改时间）；`status != 'running'` 的条件只在 body 带 `archived: true` 时加到整条 UPDATE 上，其余 PATCH 的行为不变。
- [ ] 2.3 只读拦截：prompt 路由（`rest.ts`，与受理同一同步段）、regenerate 与 fork 的预检（`branching.ts`）对 `archived_at` 非 NULL 返回 409 `session_archived`，位于 owner 预检与 body 校验之后、`session_busy` 之前。测试（同文件）：「归档后只读」（undo 一项留到 11.4）、「归档与受理不并发成功」、chat-sessions「Archived session refuses prompts」、turn-control「已归档的源会话」。
- [ ] 2.4 变异证据：去掉 UPDATE 的 `status` 条件 → 「运行中不能归档」判红；去掉 prompt 的拦截 → 「归档后只读」判红；把拦截放到 `session_busy` 之后不影响这些用例，另加一条「已归档且占用被持有时返回 `session_archived`」钉住次序。

Risk packs: Public API（PATCH 新键、409 的两种来源）、Concurrency / ordering（归档与运行中 / 控制占用的互斥，检查与写入之间无 await）、Auth（owner 作用域与 404 口径）、Error handling（0 行的三态）。
Suggested fixture level: expanded - 公共 API 新键与新错误码、与 prompt 受理的并发互斥、权限式的只读拦截
Minimal mergeable slice: 2.1 + 2.2（错误码与 PATCH `archived`，只读拦截未接时归档只是一个被存下的时间戳，主干保持绿）；2.3 随后

## 3. server — 临时空间的 store 与可见性

本组不改 `POST /api/sessions`：做完之后还没有任何 REST 路径会创建临时空间（创建语义在 5.6 才切换，排在「随最后一个会话删除」之后）。

- [x] 3.1 工作空间 store（`server/src/workspaces/store.ts`）：`list` 排除 `temporary = 1`；新增在调用方事务内创建临时空间的方法（行 `id` 随机、`dir = name = tmp-<id>`、`temporary = 1`，复用 `create` 的目录确保与补偿，不复制实现；id 生成器可注入以便测试碰撞与占位）。测试（新文件 `server/test/workspace-store-temporary.test.ts`；`workspace-store.test.ts` 已 798 行，不加行）：workspaces「列表不含临时空间」、temporary-workspaces「目录创建失败不留行」的 store 层一半（空间行不留、空目录被移除）与随机 id 冲突重试、`POST /api/workspaces` 与临时空间重名 409。
  事务契约：新方法自己不发 `BEGIN` / `COMMIT` / `ROLLBACK`（既有的创建失败补偿在处于事务中时会 `ROLLBACK`，不能原样复用——那会回滚调用方的事务，违反 workspaces「调用方事务与路径边界」）；与 `create` 共用的只是目录确保与逆序移除本次新建的空目录。方法自身失败时移除本次新建的目录后重抛，回滚归调用方。
  调用方事务在方法返回之后才失败时，目录也得能撤掉：方法的返回值带一个「移除本次新建的空目录」的补偿出口（5.6 的「临时空间创建失败不留会话」用它），本任务的测试覆盖它。
  id 生成器经 `WorkspaceStoreOptions` 的可选字段注入；碰撞重试有上限（常量生成器不得死循环，超限即抛），重试要同时认账号内 `name` / `dir` 唯一约束与全局主键 `id` 的冲突。
- [x] 3.2 测试辅助函数（`server/test/support/`）：用 3.1 的方法建一个临时空间，并直接写库插入绑定它的会话行。组 3–5 的 REST 测试用它构造「用临时空间的会话」；5.6 之后的新测试可以直接走无 body 创建。
- [x] 3.3 可见性：`GET /api/workspaces` 不含临时空间；tree / dirs / file / commands / project-config 对所有者的临时空间 id 正常、对他人 404；`POST /api/sessions` 显式携带临时空间的 `workspaceId` → 404（`rest-metadata.ts`）。测试（新文件 `server/test/session-temp-workspace.test.ts`）：temporary-workspaces「列表不含临时空间而按 id 可达」「不能显式绑定临时空间」、session-metadata「他人与不存在的空间一致 404」、workspaces「临时空间不在列表里，转正后出现」的前半（后半在 4.2）。
  前向同步点（#921 留下）：`server/test/session-view-keys.test.ts` 里「绑定创建」一例经 `POST /api/sessions` 显式绑定 `temporary = 1` 的空间，本任务落地后该路径是 404——该例改用 3.2 的辅助函数构造，`store-metadata.ts` 的 `createSession` 里为它读 `workspaces.temporary` 的那一次读随 5.6 的创建语义一起定去留。这是按规格改写，不算削弱既有断言。
  **实施注记（fixture 评审补充）**：显式绑定的 404 判定落在 `store-metadata.ts` 的 `createSession` 事务里——既有的那次 `SELECT temporary` 读到 1 时抛 `HttpError("not_found")`，由 `runOwnedTransaction` 回滚，不写会话行、不写 `session.bind` 审计；不给 workspace store 加方法、不改装配（`rootOf` 不区分临时与否，路由手里只有它）。响应与「他人 / 不存在的空间」的 404 逐字节相同。其余全是测试：`rootOf` 与 `list` 的现状已满足 tree / dirs / file / commands / project-config 的可达性。场景原文里「由无 body 创建产生的 T」在 5.6 之前不成立，用 3.2 的辅助函数构造。
- [x] 3.4 变异证据：`list` 不过滤 → 3.3 判红；去掉显式绑定的 404 → 「不能显式绑定临时空间」判红；临时空间的目录确保不走补偿 → 「目录创建失败不留行」判红。

Suggested fixture level: expanded - 沙箱内建目录与失败补偿、公共列表的可见性规则（Critical Path）
Risk packs: File IO / path safety（3.1 的目录确保与补偿场景）、Error handling / rollback（「目录创建失败不留行」、补偿出口）、Public API（3.3 的列表与 404 场景）、Concurrency / shared state（调用方事务契约、id 碰撞重试）；不选 Schema（列在 1.2 已加）、Config。
Minimal mergeable slice: 3.1 + 3.2（store 能建、列表不列；没有 REST 路径创建临时空间，线上行为不变）；3.3 随后

## 4. server — 转正

- [x] 4.1 store：`promote(principal, workspaceId, name)`——名字校验复用 `create` 的校验函数；一条所有者作用域且带 `temporary = 1` 条件的 UPDATE 与 `workspace.promote` 审计同事务；唯一冲突映射 `conflict`。测试：store 层的成功、冲突、非临时、他人四例。
  **实施注记（fixture 评审补充）**：
  - `promote` 返回五键的空间记录；UPDATE 命中 0 行（不是临时空间 / 他人的 / 不存在——store 不区分）返回 `null`，不写审计；4.2 的路由在 owner 预检之后把 `null` 映射为 400。方法自带 BEGIN / COMMIT，失败 ROLLBACK（仿 `create`，没有目录步骤——转正不移动目录）。
  - 审计 `workspace.promote` 的 `title` 为 `另存为工作空间 <name>`，`detail` 为 `{root}`。
  - 测试写进 `server/test/workspace-store-temporary.test.ts` 或新文件（`workspace-store.test.ts` 已 798 行）。四例之外加第五例：审计写入失败时该行仍是 `temporary = 1`、`name` 不变——4.3 的「审计移出事务 → 审计失败用例判红」靠它。
- [ ] 4.2 路由 `POST /api/workspaces/:id/promote`（`server/src/workspaces/rest.ts`）：no-store、owner 判定先于 body 校验、body 恰 `{name}`；加入 content-parser 归属集（`server/src/http` 的归属清单，十二 → 十三；11.1 再加到十四）。测试（新文件 `server/test/workspace-promote.test.ts`，临时空间会话用 3.2 的辅助函数构造）：temporary-workspaces「转正」四个场景；http-service-skeleton「撤回与转正路由属于归属集」中 promote 的一半；workspaces「临时空间不在列表里，转正后出现」的后半。
- [ ] 4.3 变异证据：UPDATE 去掉 `temporary = 1` 条件 → 「对正式空间 promote 为 400」判红；审计移出事务 → 审计失败用例判红；转正时移动目录（故意）→ 「`notes.md` 的 inode 不变 / cwd 不变」判红。

Risk packs: Error handling / rollback（审计与 UPDATE 同事务）、Auth（所有者作用域，0 行不区分原因）、Schema（`temporary = 1` 条件与所有者内名字唯一）、Public API（4.2 的新端点与归属集）。
Suggested fixture level: expanded - 新的公共端点、审计同事务、归属集变更
Minimal mergeable slice: 4.1 可先单独合入（store 方法由自己的 store 测试引用）；4.2 随后

## 5. server — 临时空间随最后一个会话删除，然后切换创建语义

先做删除清理（5.1–5.5），再让 `POST /api/sessions` 开始创建临时空间（5.6–5.9）。这个次序保证主干上不存在「能建临时空间、删会话却不清理」的中间态。

- [x] 5.1 `store-metadata.ts` 的 `deleteSession` 事务：读出被删会话的 `workspace_id`；若该空间 `temporary = 1` 且删除后无其它会话引用，删空间行并写 `workspace.delete` 审计；返回值带上「需删除的临时空间 `{id, ownerId}`」供提交后清理。测试（新文件 `server/test/session-delete-temp-workspace.test.ts`，用 3.2 的辅助函数与 fork 构造）：temporary-workspaces「共用与随最后一个会话删除」五个场景（磁盘断言在 5.2 之后补全）、session-metadata「fork 继承会话元数据」的「继承临时空间」。
  **实施注记（fixture 评审补充）**：
  - 事务内的次序：删会话行 → 数剩余引用（归档的会话也算）→ 无引用才删空间行 → 两条审计。迁移 035 的 `workspace_id` 是 `ON DELETE SET NULL`：漏判引用就删空间行，会把兄弟会话静默解绑。
  - `workspace.delete` 审计的 `detail.root` 是 `join(realpath(SANDBOX_ROOT), ownerId, "tmp-" + id)` 的纯拼接，在删空间行之前算好；`createSessionMetadataStore` 的 options 为此增加 `sandboxRoot`。不经 `workspaceRootOf`——它在根被换成符号链接或普通文件时抛错，会让 DELETE 变成 5xx，与「不是目录则不删、报告一次、仍 204」冲突。
  - `deleteSession` 的返回值增加可选的 `temporaryWorkspace: {id, ownerId}`，只在空间行确实被删时给出。
- [x] 5.2 目录删除（新模块 `server/src/workspaces/temp-dir-remove.ts`，由 `session-delete.ts` 在提交后调用）：账号根 realpath 下的 `lstat` 校验 → `rename` 进 `ompTrashDir` → trash 内递归删除；`ENOENT` 复查；其它失败报告。与 `session-delete.ts` 既有的产物目录 trash 流程共用同一个「移入 trash 再删」函数（抽出来，不复制——jscpd）。测试（同文件）：temporary-workspaces「临时空间目录的删除」的「经 trash 删除且不跟随链接」「目标被换成符号链接」「删除失败不影响响应」；session-metadata「删除连同快照与独占的临时空间」的目录部分（快照部分留到 12.3）。
  **实施注记（fixture 评审补充）**：
  - `temp-dir-remove.ts` 不导入 `sessions/`：trash 目录、账号根与报告函数由调用方传入，保留 `rename` 的测试 seam。`session-delete.ts` 导入它（这是 `sessions/` 对 `workspaces/` 的第一处导入，写进 PR）；`SessionDeleterDependencies` 为此增加 `sandboxRoot`。
  - 共用的「移入 trash 再删」函数从 `session-delete.ts` 的产物目录流程抽出；本任务里它对 `EXDEV` 仍是「报告且不碰原位置」，原地删除的退路在 5.3 作为只对临时目录开启的参数加入——产物目录的行为不变，`removeSessionFile` 的签名不变（既有 trash 测试依赖它）。
  - 「目标被换成符号链接」在模块 seam 上测：直接调导出的删除函数，经 `rename` seam 或前置钩子注入替换（先例 `session-delete-trash.test.ts`）。「删除失败不影响响应」用 0500 子目录构造，以 root 运行时跳过。
  - 被删会话的快照目录在 12.3（#953）之前不清；此刻没有生产写入者，不留残余。
- [ ] 5.3 `EXDEV` 退路：`rename` 以 `EXDEV` 失败时再 `lstat` 后原地递归删除。测试：「跨文件系统退为原地删除」（注入 `rename` 失败）。
- [ ] 5.4 真实两文件系统验证（design D8 的首次验证）：在测试 VPS 上把 `SANDBOX_ROOT` 与 `OMP_STATE_DIR` 放在两个文件系统（如 tmpfs 与磁盘），删除一个用临时空间的会话，确认 `rename` 真的给出 `EXDEV`、目录被原地删除、无残留；结果（命令与输出，不含主机信息）写进 PR 描述。退路不成立时停下来报告。
- [x] 5.5 变异证据（删除）：不判引用计数直接删 → 「共用时保留到最后一个会话」判红；计数排除归档会话 → 「归档的会话仍算使用者」判红；递归删除改为跟随符号链接 → 「不跟随链接」判红；`lstat` 校验去掉 → 「目标被换成符号链接」判红。
- [ ] 5.6 切换创建语义：`store-metadata.ts` 的 `createSession` 在未给 `workspaceId` 时于同一事务里调用 3.1 的方法并绑定；不写 `session.bind` / `workspace.create`。`createApp` 把 store 的方法注入会话模块（不反向导入）。测试（`server/test/session-temp-workspace.test.ts`）：session-metadata「会话创建与空间绑定」的「无 body 与空对象按默认创建」「绑定自有工作空间并选择场景」「只选场景不选空间」「非法 body 形状」「临时空间创建失败不留会话」、temporary-workspaces「不带空间创建会话」「每个新会话各有自己的临时空间」「目录创建失败不留行」的 REST 一半、chat-sessions「Create list and empty history」、http-service-skeleton「会话元数据 parser owner 的真实 HTTP 边界」里无 body 创建的 THEN、session-metadata「绑定不可改与工作目录」的三会话 cwd 场景与「存量未绑定会话照常可用」（其中 `undo` 断言留到 10.6）。
- [ ] 5.7 改写受语义变化波及的既有测试（与 5.6 同 PR）：凡以无 body 的 `POST /api/sessions` 创建后断言 `workspaceId:null` 或 cwd 为账号根的用例，按意图二选一——意图是「普通新会话」的改断言为临时空间根；意图是「未绑定会话」的改为直接写库构造 `workspace_id` 为 NULL 的行（抽一个测试辅助函数）。逐条写进 PR 偏离记录。同时核对 `web/e2e/ui-walk.spec.ts` 与 `web/e2e/ui-walk-sessions.spec.ts`：经首次发送创建的会话现在用临时空间，凡依赖「跑在账号根目录」或能力栏读作 `任务启动于 未绑定` 的断言按新契约改写（此时 web 还没有 `临时空间` 标签，改为不断言该标签的文本，17.1 落地后由 19.2 断言）。
- [ ] 5.8 冒烟与走查的清理（与 5.6 同 PR，否则 `make smoke` 在 5.6 合入时必红或留下临时空间）：
  - `smoke/session-meta.hurl` 第 2 步改为 chat-harness「会话元数据 HTTP 冒烟」的文本——无 body 创建返回 `temporaryWorkspace` true 与 32 位十六进制的 `workspaceId`、`GET /api/workspaces` 不含它、其 tree 200 且 `entries` 为空、显式绑定它 404；第 8 步末尾删除该会话后 tree 404（归档的三条断言留到 19.1）。
  - `smoke/chat.hurl` 按 chat-harness「冒烟与走查不留会话与临时空间」追加删除步骤：它创建的每个会话与 fork 出的会话在最后一次 logout 之前 `DELETE` → 204，门控与对应的创建 / fork 步骤一致。
  - `web/e2e/ui-walk.spec.ts`：会话 id 取自被观察的 `POST /api/sessions` 201 响应，`finally` 里经请求上下文 `DELETE`（204 或 404）。
  - 验证：干净的沙箱与数据库上 `make smoke` 两遍、`make ui-walk` 一遍，之后 `workspaces` 表没有 `temporary = 1` 的行、账号根下没有 `tmp-` 开头的目录（chat-harness 场景「连跑两遍不积累临时空间」；快照目录那一半在 12.3 之后成立）。
- [ ] 5.9 变异证据（创建）：临时空间创建放到事务外 → 「目录创建失败不留行」或「临时空间创建失败不留会话」判红；`chat.hurl` 不删会话 → 5.8 的残留检查判红；创建时写了 `session.bind` → 「无 body 与空对象按默认创建」的「审计无新增行」判红。

Risk packs: File IO / path safety / delete（账号根下的 `lstat` 校验、不跟随链接、经 trash 删除）、Error handling / partial failure（提交后清理失败只报告，响应仍 204）、Concurrency / ordering（引用计数与 fork、删行与删目录的先后）、Auth（所有者作用域）、Legacy compatibility（产物目录与会话文件的既有删除行为不变）。
Suggested fixture level: expanded - 删除用户文件、路径安全、审计、跨文件系统退路、公共 API 的 BREAKING 语义变化与存量兼容（Critical Path）
Minimal mergeable slice: 5.1 + 5.2 一起（删了行不删目录会留下无主目录）→ 5.3 + 5.4（此前跨文件系统部署只是报告并残留，不影响同文件系统的默认布局）→ 5.6 + 5.7 + 5.8 atomic: 创建语义一变，断言 `workspaceId:null` 的既有测试与冒烟立刻红、不删会话的冒烟立刻开始积累临时空间，三者必须同一个 PR

## 6. server — 列表事件连接

- [ ] 6.1 通知器与路由（新模块 `server/src/sessions/list-events.ts`）：按账号登记连接；`GET /api/sessions/events` 复用 `stream/sse.ts` 的 SSE 头常量、心跳常量与注入时钟（把共用的头与心跳写出函数从 `sse.ts` 导出，不复制）；`preClose` 销毁；关停后新连接 502；不写 `id:`。测试（新文件 `server/test/session-list-events.test.ts`，真实监听 + 原生读流）：session-list-push「列表事件端点」三个场景。
- [ ] 6.2 背压与隔离：每条连接至多一条未写出的 `sessions.changed`；写失败只关该连接。测试：「一条连接写失败不影响请求」与一条合并用例（暂停读取时连发 5 次 notify，恢复后收到的条数 ≥1 且 <5）。
- [ ] 6.3 触发点接线之一——会话 CRUD 与 fork：会话创建、PATCH（含归档与恢复）、删除、fork 提交，在各自事务提交之后调用 `notify(ownerId)`（`rest-metadata.ts` / `session-delete.ts` / `rest.ts` 的 fork 路由处）。测试：session-list-push「每个触发点各自通知」里这五项（表驱动：每项写入之后所有者的连接恰多至少一条 `sessions.changed`）、「被拒绝的写入不通知」。
- [ ] 6.4 触发点接线之二——回合生命周期与审批：prompt 受理与受理被补偿、regenerate 提交在 `rest.ts` 的对应路由处通知；回合终态落库、审批行插入与结算经 supervisor 既有的同步观察口 `onEvent` 得到（`turn.end`、`approval.request`、`approval.resolved` 三种事件；在 `sessions/index.ts` 里把通知器的观察函数与装配传入的 `onEvent` 串接：先调通知器（try/catch、丢弃结果），再调装配传入的 `onEvent` 并把它的返回值原样返回；所有者由 store 的会话行解析）。**不改 `supervisor.ts`**。测试：「状态变化推送给所有者的每条连接」「待决确认的出现与结算」、「每个触发点各自通知」里受理、回合结束、受理被补偿、regenerate 四项；另加一条「通知器的观察函数抛错时回合照常结束、supervisor 没有保留故障」；既有的「`onEvent` 返回 thenable 即故障」测试在串接之后原样通过。
- [ ] 6.5 触发点接线之三——工作空间：`POST /api/workspaces` 与转正成功之后通知（`workspaces/rest.ts`，通知器由 `createApp` 注入，`workspaces/` 不导入 `sessions/`）。测试：「每个触发点各自通知」里这两项。
- [ ] 6.6 变异证据（逐触发点）：对 6.3–6.5 的十一个触发点各去掉一次通知调用，「每个触发点各自通知」里对应的那一项判红（表驱动测试逐项断言，不合并成总数）；通知发在提交之前且事务回滚 → 「被拒绝的写入不通知」的回滚例判红；按连接而非按账号过滤错误 → `lisi` 收到事件判红；串接函数吞掉装配方 `onEvent` 的返回值 → 既有的观察口同步返回值违规测试判红。

Suggested fixture level: expanded - 新的公共端点、长连接与关停、跨模块的触发点接线、账号隔离
Minimal mergeable slice: 6.1 + 6.2（端点可连、无触发点时只有心跳，主干行为不变）；6.3、6.4、6.5 各自一个 PR（每个 PR 让表驱动测试里自己那几项由预期失败转绿）

## 7. server — 托管布局与快照配置

- [x] 7.1 `server/src/sessions/omp/state-layout.ts`：`LAYOUT` 增加 `["snapshots", APP_PRIVATE]`，导出 `ompSnapshotsDir(stateDir)`。测试加在既有布局测试：omp-runtime「快照目录属于布局」。
  既有的状态根目录列举断言随之同步（只在期望的列举里加 `snapshots`，不删除、不削弱，写进 PR 的偏离记录）：测试侧独立的布局表 `server/test/omp-layout-helpers.ts` 的 `LAYOUT_TABLE`、`omp-state-layout.test.ts` 的根目录列举，以及两处启动测试 `server-startup-layout.test.ts`、`server-startup-order.test.ts` 里写死的状态根目录列举。omp 用户对该目录 `EACCES` 的实机验证在 10.8。
- [x] 7.2 `server/src/agent-config.ts`：解析 `SNAPSHOT_MAX_FILE_BYTES`、`SNAPSHOT_MAX_TOTAL_BYTES`、`SNAPSHOT_MAX_ENTRIES`（沿用 `resolvePositiveInteger`）与 `SNAPSHOT_EXCLUDE_NAMES`（逗号分隔、逐名校验；默认 `node_modules,.venv,__pycache__`，不含 `.git`）；默认值见 workspace-snapshots「快照上限与配置」。测试加在配置测试：默认值、合法覆盖、「配置非法」各例，以及 http-service-skeleton「服务启动与装配」（十九项、四个新键的默认与非法值）与「Shared agent module assembly」的「Pure source and compiled configuration identity」。
  「十九项」是规格口径（主规格十五项加本 change 的四项），不是代码里的计数：S1g 的三个标量键（#986）已先合入，代码与测试里也没有字面的键数断言——本任务不新增字面计数断言，以四个新键的默认值、覆盖值与非法值断言满足场景；`server/src/server.ts` 配置 seam 注释里的键数本任务不改，由 S1g 的任务 2.4 一次改到当时的真实值。四个字段此时不接入装配（接线在 10.5）。

Suggested fixture level: expanded - 生产配置面与受保护目录布局（Critical Path：omp 子进程治理的目录权限）
Minimal mergeable slice: 7.1、7.2 各自可单独合入（7.1 建出一个暂时无人使用的目录；7.2 的解析结果由配置测试引用，消费者在组 8 接上）

## 8. server — 快照落盘（take）

- [x] 8.1 新模块 `server/src/workspaces/snapshots.ts` 的 `take`：遍历、清单、各类条目规则、`0700` / `0600` 权限、结果三态（`ok` / `too_large` / `failed`）、非 `ok` 时删掉半份。快照根与上限由调用方传入（生产装配在 10.5 接上；本组以测试为入口）。测试（新文件 `server/test/workspace-snapshots-take.test.ts`，真实临时目录）：workspace-snapshots「快照的存放位置」第一个场景、「快照内容规则」三个场景。
  入口形状在本任务定下，8.2、8.3 只往选项对象里加字段、不改签名：`take` 收一个选项对象，至少含工作空间根、快照根、`workspaceId`、`userMessageId` 与排除名单；数值上限（8.2）与上一份快照（8.3）是之后加进同一对象的字段。「各类条目」场景要求 `node_modules/` 以 `excluded` 进 `skipped`、`docs/node_modules` 普通文件照常进快照，所以**按名排除目录在本任务实现**（名单由调用方传入）；8.2 做三个数值上限与「版本库目录进快照」。结果类型现在就含 `too_large`，本任务没有产生它的路径。
  「失败不留半份」的 IO 错误用 `vi.spyOn(fs.promises, …)` 注入：`take` 是异步的（快照期间仍要能应答停止），模块经 `node:fs` 的 `promises` 对象调用文件系统，该对象与测试拿到的是同一个，所以不需要 `syncBuiltinESMExports()`。普通文件按 design D9「快照期间可能有写入者」以 `O_NOFOLLOW | O_NONBLOCK` 打开、`fstat` 后从句柄复制，测试覆盖三种分类之后的替换：文件换成指向工作空间外的符号链接（外部内容不进 `tree/`）、文件换成 FIFO（`take` 在有限时间内返回，条目按 `special` 跳过）、父目录换成指向工作空间外的符号链接（登记的残余：用例只钉住「按句柄读取」这一层，不声称挡住它；目录条目在 `readdir` 之前被替换的那一种没有用例，也挡不住）。调用方错误（`workspaceId` / `userMessageId` 不合法、快照根在工作空间之内）在落盘前抛 `TypeError`，不属于三态结果——10.5 的调用方要自己兜住；「读不了的子目录」在 root 下不成立，用例按 `geteuid() === 0` 跳过（先例 `sandbox-dirs.test.ts`）。
- [x] 8.2 上限：单文件、总量、条目数（按名排除目录已在 8.1 实现）；越限即停；`.git` 不被排除。测试：「快照上限与配置」的「单文件上限」「总量与条目上限」「版本库目录进快照」。
  测试写进新文件 `server/test/workspace-snapshots-limits.test.ts`（`workspace-snapshots-take.test.ts` 已 732 行）；该文件里的本地夹具（建工作空间、放文件、读清单等）抽到 `server/test/workspace-snapshots-helpers.ts`，两个测试文件与 8.3、9.1 共用（不复制实现，原文件的断言不改）。
  计量口径：三个上限是 `take` 选项对象里新加的字段，本任务只加字段、不改签名。单文件与总量都用打开后 `fstat` 的 `size`；超过单文件上限的文件不读内容、不计入总量与条目数；`entries` 的条目数含目录与符号链接；被排除的目录与 `skipped` 的条目不计数；恰等于上限不算超限。总量或条目数将被越过时在**读那个文件之前**停止并返回 `too_large`（越限的那个文件不被读取），走既有的「非 `ok` 删半份」路径。
  快照期间有写入者时上限仍要成立（design D9）：复制一个文件至多读它 `fstat` 的 `size` 个字节——复制期间被追加的内容不进快照，`tree/` 下副本的长度等于清单里的 `size`，总量上限不会被绕过。加一条用例钉住。
  复制期间被截短的文件：清单 `size` 记实际复制的字节数（副本长度恒等于清单 `size`，总量按实际累计）。三个上限不是正的安全整数时属调用方错误，落盘前抛 `TypeError`（否则与 `NaN` 比较恒为假，上限被静默关掉）。
- [x] 8.3 去重：`take` 的选项对象加「上一份快照的消息 id」（可缺省；受信任的 `chat_messages.id`，与 `userMessageId` 同样校验，目录由快照根 / `workspaceId` / 该 id 拼出，不收任意路径）。次序：打开 → `fstat` → 是否普通文件 → 单文件上限 → 条目与总量上限（`claim`）→ 比对 `ino`、`size`、`mtimeMs`、`ctimeMs` 四项（打开后的 `fstat` 对上一份清单里同 `path` 的 `file` 条目；清单的 `file` 条目为此加记 `ino`，见 design D9）→ 命中则从上一份的 `tree/<path>` 建硬链接、不读内容，否则经句柄复制。被链接的文件照常计入总量与条目数。退路：上一份的目录或清单不存在、读不了、不可解析 → 当作没有上一份；`link` 的任何失败 → 句柄复制；两者都不使快照 `failed`。链接源只能是上一份的 `tree/<path>`，任何路径都不指向工作空间。**写时复制放弃**（design D9「快照期间可能有写入者」末段）：规格「未变文件的去重」与 D9「机制」里的 `COPYFILE_FICLONE` 已随本任务删去。测试（新文件 `server/test/workspace-snapshots-dedup.test.ts`，复用 `workspace-snapshots-helpers.ts`）：「未变文件的去重」四个场景（断言 inode 与 `nlink`；「删除较早的一份」直接删目录，删除函数在 9.3），另加：上一份清单不可解析时退为复制、`link` 失败时退为复制、命中的文件计入总量与条目上限（8.2 的越限即停对链接路径同样成立，读取桩扩到 `link`）、上一份的 id 不合法时落盘前抛 `TypeError`。「内容变了而 mtime 被改回」靠 `ctime` 判别：改写前留出足够间隔，避免在 CI 的粗粒度时钟上偶发红。
- [x] 8.4 变异证据：跟随符号链接 → 「各类条目」里指向工作空间外的链接被复制，判红；比对只看 `mtime` → 「内容变了而 mtime 被改回」判红；在工作空间与快照之间建硬链接 → 「不是同一个 inode」判红；越限后继续复制 → 用一个会抛错的读取桩证明越限后没有再读文件；把 `.git` 加回默认排除 → 「版本库目录进快照」判红。
  证据分布：跟随符号链接 → PR #1147（#937）；越限后继续复制、`.git` 加回默认排除 → PR #1154（#938）；比对只看 `mtime`、工作空间与快照之间建硬链接 → PR #1155（#939）。#939 另加一条：比对不看 `ino` → 「换父目录后的同名文件不被当作未变」判红。

Suggested fixture level: expanded - 文件 IO、路径安全、资源上限与大输入（Critical Path）
Risk packs: File IO / path safety（8.1 的条目规则与替换用例、8.3 的 inode 断言）、Resource limits / large input（8.2 三个上限与越限即停）、Error handling / partial outputs（「失败不留半份」、`too_large` 删半份）、Auth / permissions（`0700` / `0600`）；不选 Schema、Config（配置键在 7.2）、Public API（本组无生产调用方）。
Minimal mergeable slice: 8.1（无去重、无上限的正确快照；模块由自己的测试文件引用，尚无生产调用方，线上行为不变）；8.2、8.3 各自随后

## 9. server — 快照还原（restore）与目录清理

- [x] 9.1 `snapshots.ts` 的 `restore`：结构校验先行；删除多余条目、确保目录；文件按三步判定（`ino` 与三元组都相等不动 → 大小相同且内容逐字节相同不动 → 写回：临时文件上设好 `mtime` 与权限位 `(清单 mode & 0o777) | 0o660` 后 `rename`）；重建符号链接；`skipped` 之下不碰；返回 `{restored,removed,skipped,failed}`，`restored` 只计内容被写回的文件与重建的符号链接，`removed` 把递归删除的目录计一项。测试（新文件 `server/test/workspace-snapshots-restore.test.ts`）：workspace-snapshots「还原」的「还原改动、新增与删除」「只计内容确有变化的文件」「跳过项不动并列出」「版本库随撤回还原」「写回文件的权限位」「结构性失败不动工作空间」「幂等」。
  「未变则不动」的判定同样要比 `ino`（#939 的同一条理由：只比大小与两个时间时，换掉父目录能让还原把另一个文件留在原地）；清单的 `file` 条目自 #939 起带 `ino`。`tree/` 下的文件可能与别的快照共享 inode（硬链接去重）：还原与清理对 `tree/` 只读、只删，不原地写、不 `chmod`。
  结构校验细化：清单 JSON 可解析、`entries` / `skipped` 是数组、每个条目的类型与字段齐全、`path` 是相对 POSIX 路径（无空分量、`.`、`..`、不以 `/` 开头）；任何一条不合法都在动工作空间之前抛错。
  处理次序：先删多余条目（遍历只用 `lstat`，不进入符号链接；目录递归删除计一项）→ 自顶向下确保目录（同名的非目录先删——是符号链接时只删链接本身；新建目录 `mkdir` 后经 `O_DIRECTORY | O_NOFOLLOW` 句柄 `fchmod 0o2770`）→ 文件 → 符号链接。
  读工作空间文件一律经 `O_NOFOLLOW | O_NONBLOCK` 句柄并 `fstat` 确认是普通文件（与 8.1 同一手法；design D10）。写回：同目录、独占新建、名字带随机后缀的临时文件，内容从 `tree/<path>` 复制，**经临时文件的句柄** `fchmod` 与 `futimes`（清单 `mtime`）之后才 `rename` 到位；`rename` 之后不再按最终路径做任何操作。第二步的内容比较至多读清单 `size` 个字节。清单里位于某个 `skipped` 路径之下的条目按 `skipped` 处理（不碰）。崩溃留下的临时文件在下次还原时作为多余条目被删。
  单条目的非权限类错误（`ENOENT`、`ENOTEMPTY`、`EIO` 等）向外抛（部分还原、可重试，由 12.1 映射为服务错误）；`EACCES` / `EPERM` 记 `failed` 继续（9.2）。
  模块落点：`restore` 与父目录校验函数 `parentsAreReal` 在新模块 `server/src/workspaces/snapshots-restore.ts`（`snapshots.ts` 留给 `take` 与 9.3 的删除函数）；入参是 `{ workspaceRoot, snapshotDir }`，快照目录由 12.1 的调用方从受信任的行拼出。`removed` 只计清单里没有的多余条目（每个最顶层删除计一项）；清单路径上类型不对的占位者被替换时不计入 `removed`。写回文件的 `atime` 取清单的 `mtime`。某级父目录缺失（例如它因 `EACCES` 没建成）时该条目记 `failed`、不抛。测试分两个文件：`workspace-snapshots-restore.test.ts`（规格场景）与 `workspace-snapshots-restore-safety.test.ts`（白盒、替换与损坏快照）。
  非目标：非 UTF-8 文件名与遍历中途消失的条目（#1148 待定规格）——按上一条规则处理，不为它加用例。测试里改 umask 的用例在 `afterEach` 还原 umask。
- [x] 9.2 路径安全：每次写 / 删之前逐级 `lstat` 父目录，遇符号链接或非目录记 `failed` 并跳过；单条目 `EACCES` / `EPERM` 记 `failed` 继续。父目录校验是一个导出的函数（测试 seam）：「父目录被换成符号链接」第二段直接对它给出一条某级父目录为符号链接的路径，9.4 的「去掉父目录校验」变异也靠它判红。测试：「父目录被换成符号链接」两段。
- [ ] 9.3 `removeSnapshot(workspaceId, messageId)` 与 `removeWorkspaceSnapshots(workspaceId)`：只在快照根下、分量校验为十六进制 id 与十进制消息 id；不存在视为成功。测试：非法分量被拒、删除较早一份后较晚一份仍可读（与 8.3 的场景呼应）。
  **实施注记（9.3，fixture 评审补充）**：
  - 两个函数都带快照根：`removeSnapshot({ snapshotsRoot, workspaceId, messageId })`、`removeWorkspaceSnapshots({ snapshotsRoot, workspaceId })`，落在 `server/src/workspaces/snapshots.ts`（还原模块不动）。分量校验与 `take` 同一套（空间 id 是 32 位小写十六进制；消息 id 是正的安全整数），不合法时在触碰磁盘之前抛 `TypeError`。
  - 只做递归删除（目标不存在视为成功）；SHALL NOT 对 `tree/` 里的文件做 `chmod` 或任何写入——它们与相邻快照共享 inode。其它错误原样抛给调用方（接线点负责报告，见 10.5 / 12.3）。
  - 测试新文件 `server/test/workspace-snapshots-remove.test.ts`：非法分量逐类被拒且磁盘无变化（含 `..`、带分隔符、大写十六进制、非整数 / 0 / 负数 / 超安全整数的消息 id）；不存在视为成功；删除较早一份后较晚一份仍逐字节可读、共享文件的 `nlink` 由 2 变 1；`removeWorkspaceSnapshots` 不触及另一个空间的目录；快照根下的 `<workspaceId>` 是指向根外目录的符号链接时不跟随（根外内容不被删）。
  - 变异证据：去掉空间 id 校验 → 非法分量例判红；去掉消息 id 校验 → 同上；不存在时抛错 → 「不存在视为成功」判红；`removeSnapshot` 删整个空间目录 → 「较晚一份仍可读」判红。
  Risk packs（9.3）: File IO / path safety / delete、Error handling。
- [x] 9.4 变异证据：先删后校验 → 「结构性失败不动工作空间」判红；写回改用硬链接 → 新增一条「还原后改写工作空间文件，快照内容不变」判红；去掉 `skipped` 的豁免 → 「跳过项不动」判红；去掉父目录校验 → 9.2 第二段判红；去掉第二步的内容比较 → 「幂等」的 `restored=0` 与「只计内容确有变化的文件」判红；写回时权限位直接取清单 `mode` → 「写回文件的权限位」判红；写回靠 umask 而不显式 `chmod` → 同一场景（umask `0o077`）判红。

Suggested fixture level: expanded - 在用户工作空间里写与删文件、路径安全、权限位规则（Critical Path）
Risk packs: File IO / path safety / overwrite（9.1 的删除与写回、9.2 的父目录校验、no-follow 读取）、Auth / permissions（「写回文件的权限位」）、Error handling / partial outputs（「结构性失败不动工作空间」「幂等」、部分还原可重试）、Legacy compatibility（没有 `ino` 的清单落到第二步）；不选 Schema、Config、Public API（本组无生产调用方）。
Minimal mergeable slice: 9.1 + 9.2 一起（没有父目录校验的还原不可合入）；9.3 随后

## 10. 契约 — 快照登记、派发前步骤、受理时做快照、消息 `undo` 键

- [x] 10.1 迁移 `039_chat_turn_snapshots.sql` 与迁移测试：workspace-snapshots「迁移 039 回合快照登记表」两个场景、chat-sessions「Migrations 037 to 039 apply in order」。
  迁移测试写进新文件 `server/test/core-db-turn-snapshots.test.ts`（`core-db-chat-schema.test.ts` 已 773 行）。既有的迁移账本断言随之同步（只改期望的末位、回执数与目录，不删除、不削弱，写进 PR 的偏离记录；先例 1.1 / 1.2）：`server/test/core-db-helpers.ts`（`MIGRATION_039`、`TRACKED_MIGRATION_FILENAMES`、`COMPLETE_CATALOG` 的回执与 `sequenceRows`）、`core-db-session-todo.test.ts` 的回执数、`migration-034.test.ts`、`core-db-chat-step-output.test.ts`、`core-db-workspace-temporary.test.ts`（账本，以及 038 失败用例补「没有 039 的表与回执，重试后 038、039 各应用一次」）。
- [x] 10.2 新模块 `server/src/sessions/store-undo.ts`（先只含快照登记行的读写）：写一行（`outcome`、`skipped`、`todo`）、按消息读、取某工作空间最近一条 `ok`、读某会话全部快照登记。单测覆盖四种 `outcome` 与 `skipped` 的 200 项截断。
  口径：「最近一条 `ok`」按 `message_id DESC` 取（自增主键，确定；`created_at` 同毫秒不确定）。`skipped` 列存规格「受理时做快照」给的形状 `{count:<总数>,paths:[至多前 200 项 {path,reason}]}` 的 JSON，没有跳过项存 NULL；截断在本模块的写函数里做（调用方传完整列表）。`todo` 与 `chat_sessions.todo` 的存储文本逐字相同：沿用 `store.ts` 对文本列的 `CAST … AS BLOB` 加解码器约定，不经 JS 字符串往返改写。入参类型在本模块自己定义，不从 `workspaces/` 导入；`store.ts`（上限附近）不加行。
  交给 10.5 的接口（#942 落地）：`insertTurnSnapshot` / `readTurnSnapshot` / `latestOkTurnSnapshot` / `listSessionTurnSnapshots`。`createdAt` 由调用方给；`todo` 传 `chat_sessions.todo` 的存储原文（`CAST(todo AS BLOB)` 加解码器读出，不经解析）；写入失败（主键、外键）会抛，10.5 的「自身不抛」包装要接住并按没有快照行处理；会话的全部登记按历史顺序（消息 `created_at`、`id` 升序）返回。读到不合形状的 `skipped` 文本时返回空而不抛。
- [x] 10.3 `supervisor.ts` 腾行（**行为不变的重构，单独一个 PR**）：按 design D15 把 `#pushNow` 里调用 `onEvent` 观察口并检查同步返回值的那一段挪进 `supervisor-faults.ts`（一个返回「违规错误或 undefined」的函数），把 `#readReplay` 挪进 `supervisor-subscribers.ts`；仍不足 30 行时依次再挪 `streamCursor` 的取值、`#retain`、`subscribe` 的「登记 → 读重放 → 失败撤销 → 组装返回值」段（design D15 第 1 点的第五段），够 30 行即止；五段挪完仍不足就停下报告。约束：`supervisor.ts` 继续再导出 `StreamCursor` 与 `SessionStreamLiveHandler`（既有导入方不改）；两个辅助模块不得在运行时导入 `supervisor.ts` 或 `pool.ts` 形成环（类型导入可以）；不删、不缩写既有注释来凑行；同步段内的调用次序与 await 位置逐一保持（`#pushNow` 的 ring push → fanout → 观察口，`#retain` 的入列 → `onError` → 违规入列）。目标：合入后 `supervisor.ts` 不超过 770 行（为 10.4 的至多 10 行与 11.5 的至多 12 行留出余量，并剩 8 行以上）。验证：`make check`（既有 supervisor / 事件流 / 观察口测试全绿，不新增、不改写任何断言）与 `wc -l` 结果写进 PR 描述。
- [x] 10.4 派发前步骤端口：`supervisor.prompt` / `#prompt` 增加可选的第三个参数 `beforeDispatch`，在 `#stops.open` 之后、等待旧进程退出之前 await 它，其后沿用既有的 closed / claim 复核；它拒绝时走既有的派发失败路径（释放该回合的 stop 状态、向调用方拒绝）。测试（supervisor 单元 seam，用可控的 Promise，不涉及快照模块）：chat-sessions「Stop during the pre-dispatch step keeps its intent」两段、turn-control「准入与前代退役等待期间停止」里派发前步骤一例。
- [ ] 10.5 快照步骤与路由接线：新模块 `server/src/sessions/turn-snapshot.ts`（自身不抛——未绑定不写行；命令回合写 `command`；其余调用 `take` 并写结果；失败只报告）；`createApp` 用 7.1 / 7.2 的布局与配置构造唯一的快照服务并注入；`rest.ts` 把步骤作为 `beforeDispatch` 传给 `supervisor.prompt`，受理与该调用之间不加 await；受理被补偿后删快照目录。测试（新文件 `server/test/prompt-snapshot.test.ts`，REST seam + fake omp）：workspace-snapshots「受理时做快照」六个场景（含「快照期间停止与删除」）、chat-sessions「Snapshot precedes dispatch and never blocks it」、http-service-skeleton「Shared agent module assembly」里快照服务的装配句。此时登记行已写入但还不经任何视图暴露。
  去重的接线（#939 留下）：调用 `take` 前用 10.2 的「取该工作空间最近一条 `ok`」查出上一份的 `message_id`，作为 `previousMessageId` 传入；查不到时**省略**该字段（传 `null` 会在落盘前抛 `TypeError`，被本模块的「自身不抛」吞成每个空间首回合都 `failed`）。REST 层加一条断言：同一空间连续两个回合、其间未改的文件在两份快照里是同一个 inode（`nlink` ≥ 2）——否则漏接时去重在生产上不生效而测试全绿。
- [ ] 10.6 消息视图 `undo` 与 prompt 202 的 `undo`（server）：`getMessages` 的出口在序列化处合入快照登记（不给 `store.ts` 加行：在路由的预解析缓存处或 `store-undo.ts` 的投影函数里合并）；202 body 加 `undo`。测试（同文件）：message-undo「可撤回状态」两个场景、chat-sessions「User messages carry an undo state」与「Accepted prompt and concurrent busy」的 `undo` 断言、turn-control「从此处分叉 REST」的「分叉共用临时空间且不带快照」、「stopped 终态」的「停止后继续对话」（三键）、session-metadata「存量未绑定会话照常可用」的 `unbound` 断言。
- [ ] 10.7 web 解析（与 10.6 同 PR）：`session-contract.ts` 的消息解析加 `undo`、prompt 202 解析加 `undo`；视图里由 202 本地加入的用户消息带上该值（`stream.ts` / `turn-actions.ts` 的受理处）。测试：chat-web「消息 undo 键严格解析」「prompt 的 202 带 undo」；测试夹具的消息对象补 `undo`。`smoke/chat.hurl` 与 `smoke/session-meta.hurl` 里对 202 body 键数的断言（如有）同步。
- [ ] 10.8 uid 隔离下的两条集成测试（排在 10.5 之后，因为场景要「完成一轮带快照的回合」）：在 `.github/scripts/ci-uid-isolation.sh` 里增补——omp 用户列举 `<OMP_STATE_DIR>/snapshots` 得 `EACCES`（workspace-snapshots「omp 用户不可达」）；快照时为 `0644` 的文件被 omp 用户删除、还原后 omp 用户可追加写（「还原出的文件对 omp 用户可写」，直接调用 9.1 的 `restore`）。该脚本只在 GitHub hosted runner 上运行，本地不可跑；`scripts/test-ci-harness.sh` 对它有字符串替换式的变异检查，新增步骤同步补一条变异（去掉该断言 → 判红）。验证：CI 的 `uid-isolation` job 绿，加本地 `make test-guardrails`。
- [ ] 10.9 变异证据：把快照改成在路由里 `supervisor.prompt` 之前 await → 「快照期间停止与删除」判红（没有 `abort`，回合跑完）；`beforeDispatch` 放到准入之后 → 10.4「no process is spawned … before the step settles」判红；快照放到派发之后 → 「fake omp 收到 prompt 帧晚于快照目录出现」判红；快照失败时让 prompt 失败 → 「快照失败不挡发送」判红；regenerate 误做快照 → 新增断言「regenerate 前后快照行数不变」判红；fork 拷贝了快照行 → 「分叉共用临时空间且不带快照」判红；web 不解析 `undo` → 10.7 判红。

Suggested fixture level: expanded - schema 迁移、双侧严格键集、Critical Path 文件 `supervisor.ts` 的重构与端口变更、prompt 受理路径上的文件 IO 与补偿
Risk packs: Schema / migrations（10.1 两个建表场景与次序场景、账本同步面）、Public API 严格键集（10.6 + 10.7 同刀）、Concurrency / ordering（10.3 行为不变、10.4 的派发前步骤与停止语义）、File IO 与 Error handling / rollback（10.5 的快照步骤自身不抛、补偿后删目录）、Legacy compatibility（存量库升级路径、`supervisor.ts` 导出面）；Auth 由 10.8 的 uid-isolation 验证承接。
Minimal mergeable slice: 10.1 + 10.2（表与登记行读写，由迁移测试与单测引用）→ 10.3（腾行，行为不变）→ 10.4（端口，未被 REST 使用时行为不变）→ 10.5（开始做快照、写登记行，不暴露）→ 10.6 + 10.7 atomic: 消息 `undo` 键与 202 的 `undo` 是双侧严格键集，任一侧单独合入会让会话页把全部响应判为非法 → 10.8

## 11. server — 撤回：对话原地回退

前提：任务 0.2 已合入（design D11 的核对结论）；(a) 不成立时本组不开工。

- [ ] 11.1 `core/errors` 增加 `undo_conflict`（409，message `其它会话在这之后改动过工作空间`）；`POST /api/sessions/:id/undo` 加入 content-parser 归属集（十三 → 十四）。测试：http-service-skeleton「归档与撤回冲突的错误码」「撤回与转正路由属于归属集」中 undo 的部分，以及「统一错误信封」各场景里的计数（十五码、fourteen identities）。
- [ ] 11.2 撤回事务（`store-undo.ts`）：CAS 复核 → 删除该消息及其后的消息行 → 置 `omp_session_file`、`status`、`updated_at`、`todo` → `session.undo` 审计；返回被删消息的快照登记供清理。单测：删除范围（步骤、审批、快照行级联）、`status` 的三种取值与 `idle`、`todo` 还原（session-todo「任务清单持久化」的「快照步骤只读、撤回写回」）、CAS 失败不写、审计失败回滚（message-undo「审计失败则不回退」）。
- [ ] 11.3 `branching.ts` 抽取（**行为不变的重构，单独一个 PR**）：把 `alignBranchEntries` / `branchTo` 与临时进程的准入、握手、关停抽成 fork 与撤回共用的函数（不复制）。验证：既有 fork / regenerate 测试全绿，不改任何断言。
- [ ] 11.4 路由与前置校验（新模块 `server/src/sessions/undo.ts` 的入口部分，只供 `sessions/` 内使用；`rest.ts` 只加注册调用）：body 形状、owner 预检、前置校验第 1–5 步、控制占用的登记与在每条结束路径上的释放。本组只支持 `files:"keep"`；`restore` / `force` 暂返回 400，12.1 接上。测试（新文件 `server/test/session-undo.test.ts`，REST seam + fake omp `branch`）：message-undo「撤回 REST」的「形状与鉴权」「前置校验的各拒绝」「撤回期间的并发请求」、session-metadata「归档后只读」的 undo 一项与「撤回持有占用时删除被拒」、turn-control「撤回各 RPC 间隙的并发请求」。
- [ ] 11.5 编排与提交（`undo.ts`）：退役本会话进程 → 临时进程 `get_branch_messages` → 对位 → `branch` → `get_state` → 关停 → 11.2 的事务。**`supervisor.ts` 的改动面**（design D15 第 3 点，至多 12 行，行数写进 PR 描述）：把传给 `new Forks(…)` 的端口对象提成局部常量同时传给 `new Undos(…)`、一个经 `#control` 包装的公开方法 `undo(…)`、`shutdown()` 里收掉在途的撤回临时进程。测试（同文件）：message-undo「对话原地回退」的「撤回中间的一条」「撤回第一条」「剩余历史的状态」「任务清单回到当时」「对位失败与进程失败」「最终事务复核失败」、omp-pool「撤回的临时进程计入上限」「撤回先退回本会话进程」「撤回遇池满」；另加一条「关停时在途撤回的临时进程被收掉」。
- [ ] 11.6 通知：提交后 `notify` 与 `notifyRewound`（组 6 的通知器）。测试：session-list-push「撤回发两种事件」。
- [ ] 11.7 变异证据：不退役原进程 → 「原有存活进程在临时进程 spawn 之前已退出」判红；删除范围写成只删该消息之后 → 「撤回中间的一条」判红；不改 `omp_session_file` → 「随后的 prompt 以 `--resume <新文件>` 启动」判红；校验次序把 `session_busy` 放到归档之前 → 归档会话在占用期间的用例判红；`undo` 不经 `#control` 登记 → 「关停时在途撤回的临时进程被收掉」判红。

Suggested fixture level: expanded - 新的公共端点、会话历史的破坏性改写、子进程治理与 `supervisor.ts` 接线、并发互斥、审计
Minimal mergeable slice: 11.1（错误码与归属集，由信封测试引用）→ 11.2（事务，自带单测）→ 11.3（重构，行为不变）→ 11.4 + 11.5 + 11.6 一个 PR（运行期理由：只有前置校验而没有编排的路由不能返回任何成功结果，不可单独上线；`keep` 模式的完整撤回是最小可用形态）

## 12. server — 撤回：文件还原、冲突与清理

- [ ] 12.1 `undo.ts` 接入还原：`restore` / `force` 在事务之前调用 `snapshots.restore`；结构性失败 → 通用 5xx 且不进事务；200 的 `files` 对象（`paths` 至多 200 项、相对路径）。测试（新文件 `server/test/session-undo-files.test.ts`）：message-undo「文件还原与结果」六个场景（含「版本库连同提交一起还原」）、「撤回审计与通知」的「审计形状」（其 WHEN 用 `files:"force"`，所以挂在本任务而不是组 11）。
- [ ] 12.2 冲突与同空间运行（查询放在 `store-undo.ts`）：前置校验第 6 步（同空间另一会话 `running` → 409 `session_busy`）与第 7 步——`restore` 时按 message-undo「共用空间冲突」的判据查库：另一个会话（同所有者、同 `workspace_id`）自己活动过（有自己的快照登记行，或 `updated_at > created_at`），且（有登记行 `created_at >= T`，或 `updated_at >= T`，或 `status='failed'` 且 `updated_at` 等于其末条助手消息的 `created_at`）→ 409 `undo_conflict`。测试：「共用空间冲突」八个场景（「别的会话在那之后有过回合」「重叠回合」「仅有 fork 拷贝行的会话不算」「分叉会话只重新生成过拷贝来的末轮」「被启动对账置为失败的回合」「别的会话只在那之前活动过」「别的会话正在运行」「他人的会话不参与判定」），store 直接调 `Date.now()`、没有时钟注入口，测试用 fake timers（`vi.useFakeTimers` 只接管 `Date`，或 `vi.setSystemTime`）排出 t1 < t2 < t3，不为此给 store 加时钟参数；turn-control「stopped 终态」的「对账不触碰 stopped」里 `updated_at` 不变的断言。
- [ ] 12.3 清理接线：撤回提交后删除被移除消息的快照目录；会话删除提交后删除其各快照目录（`session-delete.ts` 用 11.2 / 10.2 的读取）；临时空间目录删除时一并删其整个快照目录（5.2 的模块里补调用）。测试：workspace-snapshots「快照清理」三个场景、session-metadata「删除连同快照与独占的临时空间」的快照部分与「绑定正式空间的会话只清自己的快照」、「归档保留临时空间与快照」；chat-harness「连跑两遍不积累临时空间」里快照目录那一半。
- [ ] 12.4 变异证据：`keep` 时也还原 → 「只撤回对话」判红；冲突判定不限同一所有者 → 「他人的会话不参与判定」判红；`force` 也做冲突判定 → 「以 `force` 重发 200」判红；还原放到事务之后 → 「还原的结构性失败」里消息行已被删，判红；清理删了别的会话的快照 → 「另一个会话的快照仍可读」判红；冲突判据逐条变异——去掉 `updated_at >= T` 一支（或退回「另一会话有 `created_at >= T` 的消息」的旧判据）→ 「重叠回合」判红；去掉第 2 条「自己活动过」（或把 `updated_at > created_at` 写成 `>=`）→ 「仅有 fork 拷贝行的会话不算」判红；第 2 条只留登记行一支（去掉 `updated_at > created_at`）→ 「分叉会话只重新生成过拷贝来的末轮」判红；去掉 `failed` 一支 → 「被启动对账置为失败的回合」第一段判红；把 `failed` 一支写成不看 `updated_at` → 同场景第二段判红。

Suggested fixture level: expanded - 在共用工作空间里还原与删除文件、跨会话冲突判定、失败后的可重试性（Critical Path）
Minimal mergeable slice: 12.1 + 12.2 一起（没有冲突判定的 `restore` 会静默冲掉别的会话的改动，不可单独合入）；12.3 随后（此前只是快照目录不被清理）

## 13. web lib — API 客户端与列表事件连接器

- [ ] 13.1 `web/src/lib/api-sessions.ts`：`undoMessage(id, messageId, files)` 与响应解析（`session`、`draft`、`files` 的严格形状）。测试：chat-web「撤回与转正方法」的 undo 部分。
- [ ] 13.2 `web/src/lib/api.ts`（或工作空间客户端所在文件）：`promoteWorkspace(id, name)`。测试：同一场景的 promote 部分。
- [ ] 13.3 列表事件连接器（新文件 `web/src/lib/session-list-events.ts`，纯逻辑、不渲染）：打开 `EventSource`、`open`（区分首次与再次打开）/ `sessions.changed` / `session.rewound` 回调、坏数据忽略、`close`；无 `EventSource` 时返回空实现。单测用假 `EventSource`：事件分发、首次与再次 `open` 的区分、非法 `data` 与非法 `sessionId` 被忽略、关闭后不再回调。
- [ ] 13.4 变异证据：`files` 解析放宽为任意对象 → 「200 body 缺 `files` / `mode` 非法」判红；连接器不校验 `sessionId` → 坏数据用例判红；连接器不区分首次与再次 `open` → 13.3 对应单测判红。

Suggested fixture level: compact - 独立的客户端方法与一个无状态连接器，各自一条单测路径，不改既有入口
Minimal mergeable slice: 13.1、13.2、13.3 各自可单独合入（每个导出都由自己的单测文件引用；调用方在组 14、17、18 接上）

## 14. web — 列表重建：分组、折叠、状态标记、搜索

- [ ] 14.1 纯函数（在 `web/src/features/chat/session-groups.ts` 里**新增**，旧的筛选函数、`SessionFilter` 类型与 `DEFAULT_SESSION_FILTER` 此时保留不动——它们仍被 `session-filter.tsx`、`use-chat-session.ts`、`session-sidebar.tsx`、`page.tsx` 与既有测试引用，删除动作在 14.4）：`groupSessions(sessions, workspaces, mode, now)` 产出置顶区与按工作空间 / 按时间的有序分组（含分组键）、`searchSessions(sessions, query)`、归档与否的划分。单测（新文件，不改写既有分组测试）：session-sidebar「按工作空间分组」「切换为按时间」「未知空间与读取失败」的归组部分、时间分组的日历日边界（今天 0 点、6 天前、7 天前、晚于当前）、搜索的大小写与空白。
- [ ] 14.2 本地记忆（新文件 `web/src/features/chat/session-list-prefs.ts`）：两个 `localStorage` 键的读写与容错。单测：缺失、非法值、解析失败、读写抛错。
- [ ] 14.3 状态标记（`status-label.ts` 加 `等待确认`；新组件）：六种文案的可访问名、三种可见标记与 `data-status-mark`、减少动态效果下不转动。组件测试：session-sidebar「会话状态标记」两个场景、chat-web「列表条目的状态元素」。
- [ ] 14.4 重写 `session-sidebar.tsx`（拷入层的 `button`、`input`、`collapsible`、`dropdown-menu` + Tailwind）：`新建会话`、搜索框、`分组方式` 菜单、可折叠分组、条目、空态；删除 `session-filter.tsx` 及其测试，删除 `session-groups.ts` 里的筛选函数、`SessionFilter` 类型与 `DEFAULT_SESSION_FILTER`，既有分组测试里针对筛选的用例随之删除（写进偏离记录）；`use-chat-session.ts` / `page.tsx` 去掉筛选状态、加搜索与分组状态。整页测试（新文件 `web/test/chat-session-list.test.tsx`）：「分组侧栏」八个场景、「标题搜索」的「过滤与恢复」「不影响主区」、spa-shell「列表区承载重建后的会话列表」。
- [ ] 14.5 既有走查第 6 步的改写（**与 14.4 同 PR**，否则 `make ui-walk` 在 14.4 合入时必红——旧步骤取 `筛选任务` 按钮）：`web/e2e/ui-walk-sessions.spec.ts` 的第 6 步按 chat-harness「UI 走查会话元数据」改为分组头折叠、搜索、`分组方式` 切换、无 `筛选任务`。选择器集中在新 helper `web/e2e/ui-walk-session-list.ts`，被改写的步骤移进该 helper，`ui-walk-sessions.spec.ts` 不净增行。验证：`make ui-walk`。
- [ ] 14.6 迁移登记（与 14.4 同 PR）：`session-sidebar.tsx`、`session-groups.ts`、`session-list-prefs.ts`、`session-path.ts` 及本组新增文件加入 `MIGRATED_AREAS` 并同步清单断言；`SESSION_LIST_FILES` 里移除已迁移与已删除的文件名。`chat.css` 中只属于被重写组件的规则随之删除。
- [ ] 14.7 列表事件接入页面：`use-chat-session.ts` 持有 13.3 的连接器——`open` 与 `sessions.changed` 触发单飞的列表重取（通知触发的失败静默），再次 `open` 时按规则补读所选会话的快照，`session.rewound` 触发所选会话的快照重读；卸载 / 换账号关闭。整页测试（新文件 `web/test/chat-list-events.test.tsx`）：session-list-push「web 列表事件消费」七个场景。
- [ ] 14.8 SL 行：在 `docs/acceptance/functional-checklist.md` 新增「会话列表（SL）」节，写分组与折叠、切换按时间、三种状态标记、搜索、无筛选入口、另一个标签页的变化不刷新就出现在列表里各一行，结论 `待签`；原会话节里描述三分区与筛选的行改写或删除并在 PR 说明。
- [ ] 14.9 变异证据：置顶会话同时留在工作空间分组 → 「按工作空间分组」判红；折叠不写存储 → 「折叠与记忆」判红；搜索包含归档会话 → 「过滤与恢复」判红；通知到达时并发重取 → 「单飞与尾随重取」判红；重连后不补读所选会话 → 「重连补读所选会话」判红；已登记文件导入 `useToast` → 分层守卫判红。

Suggested fixture level: expanded - 重写会话页的共享入口组件、浏览器本地持久化、与实时通道的并发（单飞与 fence）、改写 CI 门禁的走查步骤
Minimal mergeable slice: 14.1 + 14.2（只新增纯函数与偏好读写，旧筛选导出原样保留，编译与既有测试不受影响）→ 14.3 → 14.4 + 14.5 + 14.6 atomic: 侧栏重写删除了 `筛选任务`，旧走查步骤与分层守卫的清单断言在同一刻失效，三者必须同一个 PR → 14.7（+ 14.8）

## 15. web — 条目菜单与对话框（无提示）

- [ ] 15.1 列表区顶部提示（`role="alert"` + `关闭提示`，下一次列表动作清除）与 `session-actions.ts` 的改写：去掉全部 `useToast` 调用，成功无提示，失败按「对话框内 / 列表区顶部」分流；「只采用所改的键」「被取代的响应」「换账号后丢弃」的既有规则保留。
- [ ] 15.2 重写 `session-menu.tsx`（`dropdown-menu`）：六项与次序、`归档` 在运行中禁用、`另存为工作空间` 只在临时空间会话上；本组先接 `重命名`、`置顶`、`删除`，`归档` / `另存` / `导出` 的菜单项与其动作在组 16、17 一起出现（不摆空项）。
- [ ] 15.3 重写 `rename-dialog.tsx`（`dialog` + `input`）与 `delete-dialog.tsx`（`alert-dialog`）：行为与既有规格一致，去掉提示；删除确认文案的三种变体（共用判定用已加载的列表，含归档）。
- [ ] 15.4 整页测试（新文件 `web/test/chat-session-menu.test.tsx`，旧的菜单 / 重命名 / 删除测试迁入并改写）：session-sidebar「会话条目菜单与重命名」中「从条目菜单重命名」「重命名失败保留对话框」「重命名请求中」「顶栏重命名入口」「置顶菜单文案与提示」「迟到的元数据响应」「删除确认文案」「删除当前会话」「删除请求中」；每条断言页面不出现 `已重命名` / `已更新置顶状态` / `任务已删除`。
- [ ] 15.5 既有走查第 7、11 步的改写（**与 15.1–15.4 同 PR**，否则 `make ui-walk` 必红——旧步骤断言 `任务已删除` 的轻提示可见）：按 chat-harness「UI 走查会话元数据」改为「从 `ui-walk-sessions` 分组移到 `置顶任务`」与「删除无提示」，仍经 `ui-walk-session-list.ts`，`ui-walk-sessions.spec.ts` 不净增行。验证：`make ui-walk`。
- [ ] 15.6 迁移终态：`session-menu.tsx`、`session-actions.ts`、`rename-dialog.tsx`、`delete-dialog.tsx` 登记；`SESSION_LIST_FILES` 清空并删除该常量与豁免分支；`web/src/features/chat/chat.css` 删除、`web/src/styles/legacy.css` 去掉对它的导入；守卫改为断言 ui-foundation「会话页迁移终态」（含四个注入样本）。`chat.css` 选择器归属断言的测试随文件删除而删除。
- [ ] 15.7 SL 行：重命名、置顶、删除（三种确认文案）、失败就地显示各一行，`待签`。
- [ ] 15.8 变异证据：成功后调用任何提示 → 15.4 的无提示断言判红；删除确认不区分共用 → 「删除确认文案」判红；保留 `chat.css` → 终态守卫判红；守卫保留豁免名单 → 注入样本「未登记的会话列表文件」不判失败，守卫自证测试判红。

Suggested fixture level: expanded - 重写共享的列表动作入口、失败呈现规则改变、分层守卫终态与 legacy 样式删除、改写 CI 门禁的走查步骤
Minimal mergeable slice: 15.1 + 15.2 + 15.3 + 15.4 + 15.5 atomic: 菜单、两个对话框与动作层互相依赖旧基元，逐个替换会让同一条动作一半有提示一半没有；提示一去掉，旧走查的 `任务已删除` 断言同时失效 → 15.6 紧随其后单独合入（纯守卫与样式删除）

## 16. web — 归档视图与只读会话

- [ ] 16.1 菜单 `归档` 动作与归档视图（新文件 `web/src/features/chat/archived-view.tsx`）：`已归档` 入口、标题、`返回会话列表`、平铺列表、菜单 `恢复` / `删除`、焦点归还；搜索在归档视图内生效。整页测试（新文件 `web/test/chat-archive.test.tsx`）：session-sidebar「归档视图」三个场景、「归档当前会话」、「标题搜索」的「归档视图里搜索」、「空状态」的全部已归档一例。
- [ ] 16.2 只读会话（会话页的共享入口 `conversation-view.tsx` / `page.tsx` + 新文件 `archived-notice.tsx`）：`archivedAt` 非 null 时不渲染输入框、能力栏、停靠区，显示说明与 `恢复`；`message-action-row.tsx` 在只读时不渲染 `重新生成` / `从此处分叉`（`撤回` 在 18.1 加入时同样处理）。整页测试（同文件）：chat-web「归档会话只读呈现与恢复」三段；另加一条回归：未归档的会话（`archivedAt` 为 null）输入框、能力栏、停靠区与两条操作行按钮都照常渲染。
- [ ] 16.3 新文件登记进 `MIGRATED_AREAS`；SL 行：归档、查看已归档、恢复、归档后只读、运行中不能归档各一行，`待签`。
- [ ] 16.4 变异证据：归档会话仍出现在 `置顶任务` → 「查看、恢复」判红；只读时仍渲染输入框 → 16.2 判红；只读判定写反（未归档也隐藏输入框）→ 16.2 的回归用例判红；`恢复` 失败时切回可写 → 第三段判红。

Suggested fixture level: expanded - 16.2 改会话页的共享入口（`conversation-view.tsx`、`page.tsx`、`message-action-row.tsx`），失败模式是未归档会话的输入框或操作行被误隐藏；16.1 是独立的新视图
Minimal mergeable slice: 16.1（能归档、能在归档视图里恢复与删除；此时打开归档会话仍显示输入框，发送会被服务端 409 拒绝并就地显示——可接受的中间态）；16.2 随后

## 17. web — 临时空间、产物卡与导出记录

- [ ] 17.1 临时空间的呈现：`capability-bar.tsx` 的只读标签加 `任务启动于 临时空间`（判定在最前：`temporaryWorkspace` 为 true）；用临时空间的会话以其 `workspaceId` 取命令目录与项目配置（核对现有取用处是否已按 `workspaceId` 传参，只补缺口）。测试：session-sidebar「未选择空间发送得到临时空间会话」「会话开始后只读」、chat-web「已选会话工作空间只读」（四种取值）；另加回归：绑定正式空间与未绑定的存量会话的标签不变。
- [ ] 17.2 另存为工作空间（新文件 `web/src/features/chat/promote-dialog.tsx` + 13.2 的 `promoteWorkspace`）：对话框、校验、请求、成功后重取列表与工作空间。整页测试（新文件 `web/test/chat-promote.test.tsx`）：session-sidebar「另存为工作空间对话框」三个场景、「菜单项」场景。
- [ ] 17.3 导出记录（新文件 `web/src/features/chat/export-markdown.ts` 纯函数 + 下载触发）：内容生成（块之间恰一个空行；空正文与无步骤的助手消息按规格）、文件名清洗、当前会话用视图 / 其它会话现读快照、失败走列表区顶部提示。单测逐字节断言 session-sidebar「导出内容」「空正文的助手消息」；整页测试「非当前会话与失败」（下载以对 `URL.createObjectURL` 与锚点点击的桩断言）。
- [ ] 17.4 新文件登记进 `MIGRATED_AREAS`；SL 行：未选空间发送进入临时空间分组、能力栏标签、另存为工作空间、删除临时空间会话的确认文案、导出记录的内容各一行；CH 行：临时空间会话里助手写出的文件有产物卡并可预览 / 下载 / 复制、文件变更卡只显示文件名且没有「查看详情」一行。全部 `待签`。
- [ ] 17.5 临时空间会话的产物卡（owner C-26）：把文件变更卡、产物卡与产物面板三处的「空间可解析」判定收成一个函数（先 grep 这三处对 `listWorkspaces` 结果的取用，统一成 `workspaceId` 非 null 且（在已读取的列表里 或 `temporaryWorkspace` 为 true））；临时空间会话的行只显示空间内相对路径、不渲染 `查看详情`，产物卡与面板行的操作按钮照常渲染并以会话的 `workspaceId` 调 `fetchPreview`。测试（改写 / 新增在既有的产物卡测试文件）：turn-artifacts「文件变更卡」的「空间不可解析」（改写后）与「临时空间会话的文件变更卡」、「产物卡」的「临时空间会话照常渲染产物卡」（含转正后的一段）、「产物面板」的「临时空间会话的面板行」；既有三条 Requirement 的其余场景原样保持通过。
- [ ] 17.6 变异证据：标签判定只看 `workspaceId` 是否在列表里 → 临时空间会话显示 `已绑定空间`，判红；导出包含 thinking → 「导出内容」判红；`另存为工作空间` 出现在正式空间会话上 → 「只在临时空间的会话上出现」判红；空间可解析判定不认 `temporaryWorkspace` → 「临时空间会话照常渲染产物卡」判红；临时空间会话渲染了 `查看详情` → 「临时空间会话的文件变更卡」判红；临时空间判定依赖空间列表读取成功 → 这两个场景里「空间列表读取失败的另一例」判红。

Suggested fixture level: expanded - 17.1 改会话页共享的 `capability-bar.tsx`，17.5 改文件变更卡 / 产物卡 / 产物面板共用的空间解析判定（失败模式是正式空间会话的产物卡或 `查看详情` 被误改）；17.2、17.3 是独立的新文件
Minimal mergeable slice: 17.1、17.2、17.3、17.5 各自可单独合入（互不依赖；17.4 的清单行随对应任务的 PR 添加）

## 18. web — 撤回

- [ ] 18.1 `撤回` 按钮（`message-action-row.tsx`）：位于 `从此处分叉` 之前；锁定时禁用；`undo` 非 `available` 时 `aria-disabled` 加五种原因的可访问描述（含 owner C-23 的 `命令消息无法撤回` 与 C-24 的 `这条消息没有文件快照，无法撤回`）；归档会话不渲染。动作（`turn-actions.ts` 或新文件 `undo-actions.ts`，遵守 `page → use-chat-session → turn-actions` 的导入方向）：调用 13.1 的 `undoMessage(…, "restore")`、请求期间锁输入框（不算生成中）、200 后重读快照、覆盖草稿、聚焦、更新列表条目；失败就地显示；所有权 fence（切会话 / 换账号 / 卸载后丢弃响应）。整页测试（新文件 `web/test/chat-undo.test.tsx`）：message-undo「web 撤回」的「撤回并回填」「不可撤回的原因」「失败就地显示」「锁定与归档时」、chat-web「用户消息操作行的按钮与次序」。
- [ ] 18.2 冲突对话框（新文件 `undo-conflict-dialog.tsx`，`alert-dialog`）：标题、说明（`这条消息发出之后，共用这个工作空间的其它会话还运行过回合。连文件一起还原会把它们的改动一并冲掉。`）、三个按钮、`取消` / Escape 的焦点归还、`keep` / `force` 重发。整页测试：「冲突三选一」两段。
- [ ] 18.3 未还原文件说明（`composer-dock.tsx` 上方的一条 `role="status"`，可关闭，下次发送或切换会话消失）：`skipped` / `failed` 的列表与「等共 N 项」。整页测试：「列出未还原的文件」。
- [ ] 18.4 与列表事件的配合：本页有在途撤回时忽略自己的 `session.rewound`（已由 200 之后的重读覆盖）。测试：在途撤回期间派发 `session.rewound`，消息快照读取恰一次。
- [ ] 18.5 新文件登记进 `MIGRATED_AREAS`；CH 行：撤回并回填、一次退回多轮、文件一并还原（含 git 仓库里回合做的提交被撤销）、五种不可撤回原因、冲突三选一、未还原文件说明各一行，`待签`。若 #908 已合入，行里写「把鼠标移到该消息上」。
- [ ] 18.6 变异证据：撤回前弹确认 → 「没有出现确认框」判红；不覆盖已有草稿 → 「草稿为 `第二个问题`」判红；`aria-disabled` 的按钮仍发请求 → 「不可撤回的原因」判红；冲突时直接 `force` → 「取消后没有第二个请求」判红；去掉 fence → 新增「请求在途时切换会话，草稿不变」判红。

Suggested fixture level: expanded - 破坏性操作的入口（不确认）、覆盖用户草稿、冲突分支、所有权 fence 与实时通道并发
Minimal mergeable slice: 18.1 + 18.2 一个 PR（没有冲突对话框时 `undo_conflict` 只能显示成一条报错，用户无路可走）；18.3、18.4 随后

## 19. harness — 追加的冒烟与走查

既有步骤的改写已随功能 PR 完成：`session-meta.hurl` 的键数（1.5）与无 body 创建（5.8）、`chat.hurl` 与 `ui-walk.spec.ts` 的清理（5.8）、走查第 6 步（14.5）与第 7、11 步（15.5）。本组只有追加的断言。

- [ ] 19.1 `smoke/session-meta.hurl` 第 8 步的归档断言（依赖组 2；可在组 5 之后任何时候合入）：`PATCH {"archived":true}` → 200 且 `archivedAt` 非 null、prompt → 409 `session_archived`、`PATCH {"archived":false}` → 200，随后的 `DELETE` 与 tree 404 沿用 5.8 的断言。`make smoke` 连跑两遍通过，文件不留下它创建的会话与临时空间（chat-harness「临时空间与归档在冒烟里可见」）。
- [ ] 19.2 追加的六步（chat-harness「UI 走查临时空间、撤回与归档」，写进 `web/e2e/ui-walk-session-list.ts`）：临时空间（含产物卡预览与文件变更卡无 `查看详情`）、列表事件、撤回、撤回后继续与 fork 验证、归档、删除。两个 project 都跑；error oracle 的预期 401 次数不变。
- [ ] 19.3 量 `make ui-walk` 总时长并写进 PR：须在既有 `globalTimeout` 内。超出时停下来报告（改 `globalTimeout` 要改规格，不在实现期自行放宽）。
- [ ] 19.4 变异证据：按 chat-harness 两个「候选实现的反例」场景各做一次（撤回不还原文件、临时空间进列表、临时空间会话不渲染产物卡、删除后目录残留、归档会话接受 prompt），确认对应断言判红。

Suggested fixture level: expanded - CI 门禁的真实栈冒烟与走查、总时长上限、与真实 omp 的回退路径
Minimal mergeable slice: 19.1 单独可合；19.2 + 19.3 在组 18 之后一个 PR

## 20. 文档与验收清单

- [x] 20.1 `CONTEXT.md`：改写「任务 task」词条（侧栏不再有「任务」分区；`临时空间` 分组的含义）；新增「临时空间」「回合快照」「撤回」「归档」四条术语与边界说明；「工作空间」词条补一句「临时空间是带标记的工作空间，文件页不列出」。
- [ ] 20.2 ADR-0013 增补（2026-10-06，change `s1f-session-list-temp-space`）：不用 `adapters.threadList`（「接入方式」对应一行的最终决定与理由）；会话列表动作的提示退场与失败呈现规则；会话视图由八键扩为十一键。
- [ ] 20.3 ADR-0010 增补：`<OMP_STATE_DIR>/snapshots`（`0700`）进入托管布局；临时空间目录经 trash 中转删除与 `EXDEV` 原地删除的残余；快照遍历（`take`）读到工作空间之外的两种残余（中间路径分量被替换；目录条目——含工作空间根自身——在 `lstat` 与 `readdir` 之间被换成符号链接、外部目录被整棵复制）与缓解（普通文件按句柄 `O_NOFOLLOW` 读取）；快照还原由 app 用户在共享目录里写 / 删文件的残余与缓解（逐级 `lstat`、本会话进程先退役、同空间运行时拒绝）；还原写回的文件权限位规则（属主属组读写一律补上）；升级说明（无需手工步骤）。
- [ ] 20.4 部署与运维说明（放在现有部署文档或 README 的配置节，先 grep 现有位置，不新建重复文档）：四个 `SNAPSHOT_*` 环境变量与默认值；默认排除名单只含依赖目录、`.git` 进快照，带大仓库的空间更容易触发条目 / 总量上限以及可以怎么调（调大上限，或把 `.git` 加回排除名单并接受提交不随撤回还原）；`snapshots` 目录的磁盘规划与进程被杀后可能残留的半份快照目录（停服务后可手工删除没有登记行的目录）；每个会话页标签页多一条 SSE 与 HTTP/1.1 连接数的提示；回滚后可手工清理的目录。
- [ ] 20.5 `IMPLEMENTATION_PLAN.md`：S1f 的 change C 状态行与交付记录（只记事实，不改 owner 决定的条文）；`docs/architecture/system.md` 若列有模块 / 端点清单则补新端点与新模块。
- [ ] 20.6 `docs/acceptance/functional-checklist.md` 收口：核对组 14–18 新增的 SL / CH 行齐全、ID 不重复、全部 `待签`、格式守卫通过。（design D16 的九项「起草者自定的呈现细节」在建 Epic 时原样列进 Epic 描述供 owner 知悉；这是建 issue 的动作，不是实现任务，也不卡任何任务。）
- [ ] 20.7 归档前对底：本 change 归档之前，用当时的 `openspec/specs/**` 对本 change 的每一条 MODIFIED 重新 diff（按条文、按场景）。diff 里只允许出现 design D15 重叠表与 D15 首段列出的增量；若 S1g 或 D 的内容已先进入主规格（次序被打乱），把它们的句子与场景并回本 change 的对应条文、计数改为「当时的值加本 change 的增量」后再归档。核对结果写进归档 PR 的描述。

Suggested fixture level: none - 只改文档与清单，无运行时行为
Minimal mergeable slice: 20.1 可最先单独合入；20.2–20.5 在对应功能组合入后各自可单独合入；20.6、20.7 最后
