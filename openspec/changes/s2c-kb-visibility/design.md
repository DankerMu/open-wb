# Design: s2c-kb-visibility

## Context

change A（`s2c-kb-session`，2026-11-13 归档，CK-15–CK-20 owner 签为通过）让会话里的模型经 `kb_search` 检索知识库，但「可见」恒等于「拥有」。
本 change 补上 F-CTR-KB4：可见范围四档、共享只读（CONTEXT.md 不变量 1）、跨账号检索审计，以及 A 留下的种子 (a)(b)(c)(e)。

现状（2026-11-17 核查）：
- `accounts` 只有 `id, account, role, disabled, password_hash`（`010_auth_schema_seed.sql:5-30`）；`Principal` 恰为 `{id, account, role}`（`auth/index.ts:33-37`），`GET /api/auth/me` 的应答形状被 dev-stub-auth 钉死。
- 仓库里没有部门与项目组的任何表、列或代码。
- 知识库归属只有一个判定 `ownedBase`（`kb/bases.ts:89-99`），由 `kb/rest.ts:194-197` 的 preParsing 钩子在 body 之前调用；`listBases(ownerId)` 是 `WHERE owner_id = ?`（`kb/store.ts:158`）。
- 检索测试在参数不同时取写锁写回（`kb/retrieval.ts:227-239`），检索本身不审计。
- 审计 `query` 只按 actor 过滤，管理员看全部（`core/audit/index.ts:70-96`）；没有审计界面（S3b）。
- 会话检索 `session-search.ts` 只有一次 `listBases(ownerId)` 读取；引用受理在 `sessions/store-knowledge-bases.ts:38-62`。
- demo 行为：`KB_SCOPES`（`resource/workbuddy-live-demo.html:2737-2742`）、`visibleKbs()`（:2750-2755）、范围对话框（:3058-3092）、非所有者呈现（:2781-2803、:3240-3262）、共享检索审计（:2844-2846）。

## Grill 结论（2026-11-17，owner 逐分支拍板）

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| B1 | 部门来源 | `accounts.department` 列，应用侧只读；种子按 demo；S3a 改由 IdP 下发 | D1 |
| B2 | 项目组 | 两张表 + 「我所在的组」只读路径，种子 g1；管理与解散随 S3a | D1、Non-Goals |
| B3 | 共享检索审计 | 每次调用对每个实际检索的非自有库一条，actor=检索者，detail 不含问句与命中；可见者为检索者与管理员；检索测试同理 | D6 |
| B4 | 非所有者读面 | 文档列表可见但不给来源；检索测试可用、参数只读 | D5 |
| B5 | 设置入口 | 新建对话框 + 范围按钮；只有所有者能改；实际变更记 `kb.scope` | D3、D9 |
| B6 | 库清单 | `kb_search` 描述列全部可见库，非自有附所有者账号，不设上限 | D7 |
| B7 | 种子 a/b/e | 按状态分措辞；按原始数组计数再去重；单轮检索本地截 6 | D7、D8 |
| B8 | 停用与管理员 | 所有者停用不影响可见；管理员无特权 | D2 |
| B9 | 本部门档 | 动态跟随所有者当前部门；所有者部门空不可选（400）；空部门查看者不匹配 | D2、D3 |
| B10 | 项目组档 | 只能选自己所在的组（400）；按查看者当前成员判；一库一组 | D2、D3 |
| B11 | 非所有者写 | 403 `forbidden`，先于 body，不审计；不可见 404 | D2 |
| B12 | 非所有者检索测试参数 | 忽略 body 的两个参数，按已存值检索，不写回 | D5 |
| B13 | 收回共享 | 引用受理扩为可见库；快照不重新校验；下次派发前重算清单；不做取消共享提示 | D7、D10 |
| B14 | 审计时点 | 发出 RAGFlow 请求前写；不发请求不记；审计写失败不检索 | D6 |
| B15 | 验收 | 多账号单测 + web 单测 + ui-walk 桩 + owner 双浏览器 CK；不改 CI | D11 |
| B16 | 内置命令带引用 | 400，与附件同规则；web 沿用附件的拒绝呈现，不做前端分类 | D10 |
| B17 | S4a | 串行，B 合入后启动 | Non-Goals |
| B18 | 非 ready 时改范围 | 任何 `state` 都可改，不取写锁 | D3 |
| B19 | 共享库编译状态 | 只为自有库读；非自有 `compile` 恒为 `null`，界面只显示标签 | D4 |

## Goals / Non-Goals

**Goals:**
- 所有者能把自己的知识库设为四档之一；其他账号按档位看到、检索、引用它，但不能改动它（不变量 1）。
- 不可见的库对查看者仍不可探测（404 与不存在相同）。
- 每次对非自有库的实际检索都留下审计（glossary「审计」：共享 KB 检索）。
- 修掉 A 留下的 (a)(b)(c)(e)。

**Non-Goals:**
- **项目组的增删改、成员管理与解散**（解散时以它共享的库退回仅自己并逐库审计，demo :2991-3000）：S3a 账号 tab。本 change 的 `scope_group_id` 外键为 `RESTRICT`，S3a 删组前必须先处理引用它的库。
- **部门的真实来源**：S3a 的 OIDC 声明。本 change 没有写部门的接口。
- **所有者查看谁检索了自己的库**：复活条件：S3b 审计页提出需求。
- **审计记录问句**：复活条件：合规要求追查检索内容。
- **管理员看全部库**：复活条件：治理需求。
- **`kb_list` 工具**：维持 A 的复活条件（描述明显拖长上下文，或 owner 走查发现模型选不准库）。
- **取消共享的前端提示**（demo :2844）：发送时不可见的引用已经是 404；复活条件：owner 走查认为困扰。
- **web 侧判定内置命令**：复活条件：内置命令带附件或引用的拒绝成为常见困扰。
- **CI 里的双账号端到端走查**：S3b（P3 里程碑「双账号验收脚本化进 Playwright 走查」）。
- **S4a**：保持串行，本 change 合入后启动，计划里的依赖不改。
- **检索卡的持久化**（A 的 G12，种子 d）：维持 A 的复活条件。

## Decisions

### D1 迁移 053：账号侧与知识库侧同一个迁移

`server/src/core/db/migrations/053_kb_visibility.sql`，事务与回执归 runner：
- `ALTER TABLE accounts ADD COLUMN department TEXT NULL CHECK (department IS NULL OR (typeof(department)='text' AND length(department) BETWEEN 1 AND 64 AND <无 C0/DEL>))`。
- `project_groups(id TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL)`，`id` 与 `name` 各带长度与控制字符 CHECK。
- `project_group_members(group_id REFERENCES project_groups(id) ON DELETE CASCADE, account_id REFERENCES accounts(id) ON DELETE CASCADE, PRIMARY KEY(group_id, account_id))`，加 `(account_id)` 索引（「我所在的组」按账号查）。
- `ALTER TABLE knowledge_bases ADD COLUMN scope TEXT NOT NULL DEFAULT 'me' CHECK (scope IN ('me','dept','group','all'))`；
  `ADD COLUMN scope_group_id TEXT NULL REFERENCES project_groups(id) ON DELETE RESTRICT CHECK ((scope = 'group') = (scope_group_id IS NOT NULL))`。
  2026-11-17 在 node:sqlite 上实测：`ADD COLUMN` 的列级 CHECK 可以引用另一列且生效，外键 `RESTRICT` 生效。
- 种子：`UPDATE accounts` 给 u1 `平台研发部`、u2 `数据部`、u3 `产品部`（demo :1401-1406），u4 留空；`project_groups` 一行 `g1 / 内网落地专项`，成员 u1、u2（demo :1409-1410）。与 010 的种子账号同一先例：生产库里也有这几行。

理由：部门与项目组是知识库可见范围的唯一消费者（glossary「项目组」：只影响 KB 可见范围），一个迁移让「范围列引用组表」在同一事务里成立。
备选「部门放独立 profile 表」：多一次 join，换不来任何行为，剪掉。

迁移目录计数断言在它的权威文件里 +1（Code Canonicality）。

### D2 可见判定只有一处，归属分两级

新文件 `server/src/kb/visibility.ts`：
- `visibleBases(viewerId)`：一条 SQL，返回 `{base, owned, owner:{id, account, department}, group:{id, name} | null}[]`，次序为自有库按 `created_at` 升序在前、其余可见库按 `created_at` 升序在后（同一时间戳按 `id`）。谓词：
  `kb.owner_id = :viewer OR kb.scope = 'all' OR (kb.scope = 'dept' AND viewer.department IS NOT NULL AND viewer.department = owner.department) OR (kb.scope = 'group' AND EXISTS (成员 (scope_group_id, :viewer)))`。
- `accessOf(id, viewerId)`：同一谓词限定到一个 id，返回同一形状或 `null`。
- SQL 读 `accounts` 与 `project_group_members`：依赖规则 2 已声明 `kb → accounts（可见范围）`；表由 accounts 拥有，kb 只读。

两级归属替换 `ownedBase`（`bases.ts:89-99` 原地改，不留旧函数）：
- `readableBase(id, viewer)`：`accessOf` 为 `null` → 404 `not_found`。
- `ownedBase(id, viewer)`：`accessOf` 为 `null` → 404；`owned` 为假 → 403 `forbidden`。
- `kb/rest.ts` 的 preParsing 钩子（经 `bases.ts:283-284` 的 `assertOwned`）按路由选两者之一，判定仍先于 body、`doc` 参数与 `state`，不发出站请求、不写审计。`assertOwned` 拆成读、写两个入口；处理函数里的复核点（`documents.ts:364,374,396,635`、`uploads.ts:249,267`、`retrieval.ts:186,196`、`bases.ts:200`）随之换成对应的一级，读路由的复核点用 `readableBase`。读路由：`GET …/documents`、`POST …/retrieval`。写路由：`DELETE /api/kb/bases/:id`、`POST …/documents`、`DELETE …/documents`、`POST …/documents/reingest`、`POST …/uploads`、`PUT …/scope`。

管理员没有分支（B8）；停用账号不进谓词（B8）。动态部门与动态成员关系由谓词每次现查得到（B9、B10）。

备选「单一 404」（写路由对可见库也 404）：同一个 id 的 GET 200、DELETE 404 自相矛盾，403 才能断言不变量 1；owner 选 403。

### D3 范围的写入

- **建库**：body 键集加可选的 `scope`、`groupId`。第 1 步（不读库）校验：`scope ∈ {me, dept, group, all}`；`groupId` 只在 `scope:"group"` 时出现且为非空字符串，其余档位出现即 400。第 5 步（锁内，紧随重名与上限，先于任何 RAGFlow 请求）读所有者：`dept` 而所有者部门为空 → 400；`group` 而所有者不是该组成员（含组不存在）→ 400。缺省 `me`。
- **`PUT /api/kb/bases/:id/scope`**：第 1 步 `ownedBase`；第 2 步 body 键集恰为 `scope` 与（`group` 时必有、其余时不得有）`groupId`，规则同建库；第 3 步所有者条件；第 4 步与已存值相同 → 200、不写、不审计；第 5 步一条事务里 `UPDATE` 并审计 `kb.scope`，`UPDATE` 影响 0 行（并发删库）→ 404。所有者条件先于「相同不写」：失去条件后重存同一范围得 400，web 的对话框因此在当前档不可选时不预选（D9）。应答 200 `BaseView`；范围的判定与写入不读 RAGFlow，应答的 `compile` 按 D4 的规则为这个库现读（调用者恒为所有者，5 s 期限，超时或失败为 `null`，应答仍 200）。
- 新路由属于 content-parser 归属集（http-service-skeleton「统一错误信封」，三十九条 → 四十条，`server/src/http/errors.ts:94-133` 的集合与它的计数断言原地改）：畸形 JSON 与错误媒体类型得 400，不是 generic 500。
- 不取知识库写锁，任何 `state` 都可改（B18）：范围只写本地列，与 RAGFlow 无关；与删库并发时由 0 行判定兜底。

### D4 `BaseView` 三键与列表

- `BaseView` 恰为原十一键加 `owned`（布尔）、`owner`（`{id, account, department}`，`department` 可为 `null`）、`scope`（`{scope, group}`，`group` 为 `{id, name}` 或 `null`）。
- `GET /api/kb/bases` 列出 `visibleBases(principal)`，次序见 D2。编译状态只为 `owned` 的库读取（共用 5 s 期限）；非自有库 `compile` 恒为 `null`，不发出站请求（B19）。
- 建库、改范围的应答同形。
- web 按严格键集解析 `BaseView`（`web/src/lib/api-kb.ts:212`），所以服务端加键与 web 解析器 SHALL 在同一个 PR 里改，否则合入即让中心 tab 与引用选择列表 `requestFailed`（A 组 7 第三刀的先例）。

### D5 非所有者的读面

- **文档列表**：`readableBase` 放行。非所有者的每条 `workspaceId`、`path`、`sourceChanged` 为 `null`；不做源文件 stat（所有者沙箱的路径与状态不外泄，也不以查看者身份解析别人的工作空间）。`source` 仍为 `workspace` / `upload`。
- **检索测试**：`readableBase` 放行，body 校验（第 2 步）不变。非所有者跳过第 4 步：不比较、不取锁、不写回，按已存值检索（B12）；应答的 `retrieval` 为已存值。非 `ready` 仍 409 `kb_rebuilding`。检索前写 `kb.shared_retrieval`（D6）。

### D6 跨账号检索审计 `kb.shared_retrieval`

新文件 `server/src/kb/shared-audit.ts`：`auditSharedRetrieval(deps, viewerId, access)`，只在 `owned` 为假时写：
- kind `kb.shared_retrieval`，title `检索共享知识库`，actor 为检索者，`workspace_id` 为 null；detail 恰为 `{id, name, ownerId, scope:{scope, groupId}}`（取判定可见时读到的那一行）。
- 时点：判定可见且 `ready` 之后、调用单轮检索之前（B14）。会话检索在写之前先查中止信号，已中止即为 `failed`，不写、不检索（「不发请求不记」）。审计写失败：检索测试为通用 500；会话检索里该库为 `failed`，不检索，其余库照常。
- 会话检索与检索测试都只经这一个函数写；自己的库不写（S2b：检索本身不审计）。

### D7 会话检索的可见集合与种子 (a)(b)

`session-search.ts` 原地改：
- `definitionFor(viewer)`：库清单取 `visibleBases(viewer)`，可见的库一个都没有时没有定义（只有共享库的账号也有定义：P2 里程碑正是这条路径）。omp-runtime「`kb_search` 的注册」与 tool-approval「审批请求识别」里「所有者没有库」的说法同步改为「没有可见的库」；描述里自有库的行仍为 `- <名称>（<id>）`，非自有库为 `- <名称>（<id>，所有者 <account>）`（B6，不同所有者可同名）。注册比较的「库清单」仍是 `[{id, name}]`：账号与所有者不可变，名称不可改，`{id, name}` 足以判定描述是否变化。
- `execute`：逐库用 `visibleBases` 的结果判定；不可见与不存在同为 `not_found`。可见、`ready` 的非自有库先写 `kb.shared_retrieval`（D6）再检索。
- (a)：`state` 为 `rebuilding` 时文本 `正在重建，本轮未检索`，为 `rebuild_failed` 时 `重建失败，本轮未检索`；`details` 的 `status` 两者仍为 `not_ready`（chat-stream 的 `kb.hits` 严格解码 `status ∈ {ok, not_found, not_ready, failed}`，不动跨服务枚举）。
- (b)：原始 `kb_ids` 的元素个数先判 1–5（与 schema `maxItems` 一致），超过 5 即 `一次至多检索 5 个知识库`；通过后按首次出现去重。

### D8 单轮检索本地截断（种子 e）

关联本地文档在 `kb/retrieval.ts` 的 `retrieveForBase`（:114-129，`ragflow-retrieval.ts:28` 注释「D2 的关联在调用点」）。截断放在这里、关联之后 `slice(0, PAGE_SIZE)`；`PAGE_SIZE` 从 `ragflow-retrieval.ts:26` 导出复用，不另写常量。检索测试与会话检索都经它，所以「每库至多 6 条」对两者都成立，上游多给时 `kb.hits` 不再整条丢弃。

### D9 账号范围端点与 web

- 新文件 `server/src/accounts/scope.ts`：`scopeOf(db, accountId) → {department, groups:[{id, name, memberCount}]}`（组按 `name` 升序；`memberCount` 供对话框按 demo :3068 显示「（N 人）」）；`registerAccounts` 注册 `GET /api/accounts/me/scope`，登录即可，与知识库开关无关，no-store。`Principal` 与 `GET /api/auth/me` 不改（dev-stub-auth 钉死了形状）。
- kb 的建库第 5 步与改范围第 3 步复用 `scopeOf` 判所有者的部门与成员关系，不另写一份查询。
- web：新 `scope-dialog.tsx`（四档单选、`项目组` 带组下拉、无组提示、部门空时 `本部门可见` 禁用并注明原因），列表行与详情头部的范围按钮打开它，新建对话框内嵌同一组控件；只有 `owned` 的库渲染范围按钮。对话框打开时取一次 `GET /api/accounts/me/scope`。范围对话框预选当前档与当前组；当前档已不可选时不预选、`保存` 禁用。新建对话框取不到时只留 `仅自己可见`，建库不受影响。文案逐字取 demo（:2738-2741、:3059、:3068-3071）。

### D10 引用受理（B13、B16）

- `resolveReferences(viewer, ids)` 用 `visibleBases`：任一不可见 → 404，与不存在、知识库关闭不可区分。存下的名称是受理那一刻的名称；快照读取不重新校验（A 的契约不变）。
- 内置命令（`classifyPrompt` 判为 `builtin`）带非空 `knowledgeBases`：400 `bad_request`，在引用的可见判定之前，与附件第 3 条同一位置判定（`sessions/rest.ts:336` 已算出 `builtin`）。
- web 不做内置命令判定：400 时引用保留并显示拒绝的 message，与附件一致（B16）。

### D11 验收

- server：新测试文件在假 RAGFlow 上搭多账号世界（u1、u2、u3 与 g1 种子；u4 是停用账号，需要「部门为空的查看者 / 所有者」时测试带外把它的 `disabled` 置 0），覆盖四档 × 查看者、403/404、非所有者文档列表与检索测试、`kb.scope` 与 `kb.shared_retrieval`、种子 (a)(b)(c)(e)。既有用例「文档路由的所有权」按两级判定原地改写。
- web：组件测试覆盖非所有者呈现、范围对话框、引用选择列表的所有者字样。
- ui-walk：`web/e2e/ui-walk-center-kb.ts` 加一条分支（`page.route` 桩：一个自有库、一个共享库），走查只读呈现与范围对话框。
- 验收清单 CK 节新增行（`待签`）：共享库的引用与会话检索加审计（P2 里程碑）、非所有者只读、范围设置与审计；种子行为不单列。owner 在真实栈上用两个浏览器走查。

### D12 打开共享是最后一刀

只有 `PUT …/scope` 与建库的 `scope` 能把库设为非 `me`（种子里没有知识库）。在它合入之前，所有可见性代码对用户都是惰性的；它一合入，非所有者就能看到别人的库。
所以「打开共享」（tasks 组 11）SHALL 排在所有读面与审计之后：非所有者文档列表的隐私形态、检索测试的共享审计、`kb_search` 与引用的可见集合、web 的只读呈现与引用选择列表的所有者字样。
各组的测试用带外写列造出非 `me` 的库，不依赖组 11。这样 master 上不存在「能共享、却泄露路径 / 漏审计 / 引用与检索自相矛盾」的中间态。

## Sketch seams under test

- **HTTP 路由经 `app.inject`，对假 RAGFlow**（既有 seam，kb 用例的通用写法）：四档、两级归属、范围端点、文档列表与检索测试的非所有者形态、审计全部在这一层可观察，测试不需要伸进 `visibility.ts`。
- **`createKbSessionSearch` 的 `definitionFor` / `execute`**（既有 seam，A 的 `kb-session-search.test.ts`）：会话检索的可见集合、描述行、(a)(b)、`kb.shared_retrieval` 时点在这里断言，不经 omp。
- **prompt 路由经 `app.inject`（stub supervisor）**（既有 seam，`prompt-knowledge-bases.test.ts`）：引用的可见受理与内置命令 400。
- **迁移经 `openDb(":memory:")`**（既有 seam）：053 的 schema、CHECK、外键与种子。
- **web 组件对假 `ApiClient`**（既有 seam）：中心 tab 与引用选择列表；`api-kb.ts` 的严格解析经客户端用例。
- **ui-walk 的 `page.route` 桩**（既有 seam，`ui-walk-center-kb.ts`）。

## Risks / Trade-offs

- **工具描述随「全员」档变长** → 不设上限（B6）；风险由 owner 走查发现，复活 `kb_list`。
- **可见判定每次现查** → 列表、文档、检索、`kb_search` 每次各一条带 join 的 SQL；知识库数在内网规模下（每账号 ≤ 50）开销可忽略，不加缓存。
- **跨服务严格解析** → `BaseView` 加键与 web 解析器同 PR（D4），任务切片按此约束。
- **多租户过滤是灰盒决定的例外候选**（IMPLEMENTATION_PLAN S2c Review attention）→ 两级归属的 PR 标注请求白盒审查。
- **种子数据进生产库** → 与 010 同一先例；S3a 接入 IdP 时部门被真实值覆盖，`g1` 由 S3a 的管理面处置。
- **`scope_group_id` 的 `RESTRICT`** → S3a 删组前必须先把引用它的库退回 `me`（demo 的解散行为），否则删除失败；这是有意的：不留指向不存在的组的库。

## Migration Plan

- 053 只追加列与表，既有库的 `scope` 为 `me`，行为与本 change 之前相同。
- 回退：迁移不逆转（账本拒收多出的回执）；回退代码时保留迁移，旧代码只按 `owner_id` 判定，新列与新表无害。

## Open Questions

- IdP 是否带组声明（自建 vs 同步）：需甲方信息，S3a 前关闭。不影响本 change 的表结构：两张组表与来源无关，改为同步时由同步器写同一组表。

## Not yet specified

无。
