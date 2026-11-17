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

## 1. 迁移 053 与账号范围读取（account-groups 全部；knowledge-bases「迁移 053 知识库范围列」；dev-stub-auth「账号与认证会话数据基座」）

- [ ] 1.1 核对 Context：`server/src/core/db/migrations/010_auth_schema_seed.sql`、`052_chat_message_knowledge_bases.sql` 的写法（事务归 runner、无 `IF NOT EXISTS`）；`server/test/core-db-helpers.ts:34-61,106-133` 的迁移清单与计数；`server/test/auth-schema.test.ts:54,446` 与 `kb-schema.test.ts:107-127,177` 的精确形状断言
- [ ] 1.2 测试先行：新文件 `server/test/migration-053.test.ts` 覆盖 account-groups「迁移 053 部门与项目组」与 knowledge-bases「迁移 053 知识库范围列」的全部场景（种子、CHECK、外键 RESTRICT 与 CASCADE、052 → 053 升级保留既有库），以及 dev-stub-auth「053 之后 Principal 不变」（登录与 `GET /api/auth/me` 不含 `department`）
- [ ] 1.3 实现 `053_kb_visibility.sql`（design D1；列级 CHECK 引用另一列已于 2026-11-17 在 node:sqlite 实测可用，以 1.2 的用例为准）
- [ ] 1.4 原地改精确形状断言：迁移清单与计数 +1；`auth-schema.test.ts` 保留 010 的 5 列契约断言、对全量迁移后的库断言多 `department`；`kb-schema.test.ts` 的列与外键清单加两列
- [ ] 1.5 核对 Context：`server/src/accounts/index.ts` 的 `registerAccounts` 与 `/api/audit` 的 no-store 写法
- [ ] 1.6 测试先行：新文件 `server/test/accounts-scope.test.ts` 覆盖「账号范围端点」全部场景（u4 先带外启用；停用账号 401；`memberCount`）
- [ ] 1.7 实现新文件 `server/src/accounts/scope.ts`：`scopeOf(db, accountId) → {department, groups:[{id, name, memberCount}]}`（组按 `name` 码点升序）；`registerAccounts` 注册 `GET /api/accounts/me/scope`

Suggested fixture level: expanded - 新 schema、种子进生产库、外键语义（RESTRICT 约束 S3a 的删组）。
Minimal mergeable slice: 1.1–1.4 为首刀：迁移由 `openDb` 自动执行，独立 SQL 加形态测试即可合并保绿（先例 `openspec/changes/archive/2026-09-24-s1a-sandbox-audit-files/tasks.md:24`），组 5 只需要它；1.5–1.7（读取函数与端点）由组 11、组 12 消费，依赖首刀的表。

## 2. 单轮检索本地截断（knowledge-bases「单轮检索」，种子 e）

- [ ] 2.1 核对 Context：关联本地文档在 `server/src/kb/retrieval.ts:114-129` 的 `retrieveForBase`；`PAGE_SIZE` 在 `server/src/kb/ragflow-retrieval.ts:26`，未导出；`server/test/kb-retrieval.test.ts`（207 行）的故障注入写法
- [ ] 2.2 测试先行：在 `kb-retrieval.test.ts` 加「上游多给时本地截断」两例（8 条全可关联 → 前 6 条；8 条中两条关联不上 → 其余 6 条）
- [ ] 2.3 实现：导出 `PAGE_SIZE`，`retrieveForBase` 在关联之后 `slice(0, PAGE_SIZE)`；`kb-retrieval-canonical.test.ts` 与检索测试、会话检索的既有用例原样全绿

Suggested fixture level: compact - 一个已有函数内的一行截断与一个常量导出，没有接口、schema 或权限变化。
Minimal mergeable slice: atomic - 一处改动对应一个场景的两例，无可再分。

## 3. 会话检索的措辞与计数（knowledge-bases「会话检索 `kb_search`」的种子 a、b）

- [ ] 3.1 核对 Context：`server/src/kb/session-search.ts` 的 `render`（:111-118，`not_ready` 固定一句）与 `parseArgs`（:78-102，去重后才判上限）；`server/test/kb-session-search.test.ts`（450 行）；chat-stream 的 `kb.hits` `status` 枚举（不改）
- [ ] 3.2 测试先行：在 `kb-session-search.test.ts` 加「重建失败与重建中分开措辞」，改写「参数校验」（六个不同的 id 与六元素含重复两例）
- [ ] 3.3 实现：`render` 按库的 `state` 分两句，`details.status` 仍为 `not_ready`；`parseArgs` 先按原始数组判 1–5 再去重

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
- [ ] 14.3 `IMPLEMENTATION_PLAN.md`：S2c 状态（B 交付、待 owner 签收）与 Next Step（签收后可启动 S3a 与 S4a；S3a 前置决策「IdP 组声明」）；`smoke/kb.hurl:13` 注释里的 `BaseView` 键集同步
- [ ] 14.4 逐条核对 design.md「Grill 结论」B1–B19 的落点在代码与规格里成立，核对记录写进 PR 描述

Suggested fixture level: none - 文档与核对，没有行为变化。
Minimal mergeable slice: atomic - 收口文档随最后一个实现 PR 之后一次性落地。
