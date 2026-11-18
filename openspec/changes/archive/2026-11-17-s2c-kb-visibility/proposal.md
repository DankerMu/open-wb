# Proposal: s2c-kb-visibility

> Issue type: feature（P2 第三刀后半：知识库可见范围；S2c 拆成两个 change，本 change 为 B，A 是已归档的 `s2c-kb-session`）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: 多租户过滤（灰盒例外候选，IMPLEMENTATION_PLAN S2c Review attention）：知识库从「只有所有者」变成按四档可见，所有 `/api/kb/bases/:id/*` 路由的归属判定改为「可见 / 拥有」两级；新迁移 053（`accounts.department`、项目组两张表、`knowledge_bases` 的范围两列）；`BaseView` 多三键（web 严格解析，同 PR 改两端）；会话检索与知识库引用的可见集合扩大；两种新审计 kind；内置命令带知识库引用改为 400
> Evidence floor: `npm test --workspace server`、`npm test --workspace web`、typecheck、size-guard、`make check`、`make ui-walk`；真实 RAGFlow 上的双账号行为只在 owner 验收走一轮（CK 行）
> 依赖：建在 `s2c-kb-session` 归档后的主规格之上（knowledge-bases「知识库端点」「检索测试端点」「会话检索 `kb_search`」，message-attachments「prompt 引用知识库」「输入框知识库引用」）；术语见 `openspec/glossary.md`「可见范围」「项目组」「审计」；不变量见 CONTEXT.md 1、2。

## Why

`IMPLEMENTATION_PLAN.md` S2c 的验收是「会话内 KB 引用给出带出处切片，共享检索入审计」（P2 里程碑）。change A 交付了前半句，
「可见」仍等于「自己拥有」。F-CTR-KB4（可见范围四档、共享只读、跨账号检索审计）一行代码都没有：
- `accounts` 没有部门列，仓库里没有项目组（`010_auth_schema_seed.sql:5-30`）。
- 所有知识库路由经 `ownedBase` 判定，别人的库一律 404（`server/src/kb/bases.ts:89-99`）。
- 检索测试在参数变化时写回所有者的参数（`server/src/kb/retrieval.ts:227-239`），放开给非所有者前必须拆开「检索」与「写回」。
- 审计里没有任何 KB 检索类 kind。

A 收口时还留下五个种子（IMPLEMENTATION_PLAN「Next Step」2026-11-13）：(a) `rebuild_failed` 的库被报成「正在重建」；(b) `kb_ids` 计数口径不一致；
(c) 内置命令带知识库引用被受理；(e) 每库至多 6 条只靠 RAGFlow 遵守。owner 2026-11-17 裁定 (a)(b)(c)(e) 并入本 change，(d) 维持 A 的 G12。

## What Changes

- **账号的部门与项目组**（新 capability `account-groups`）：
  - 迁移 053 给 `accounts` 加只读的 `department` 列，建 `project_groups`、`project_group_members` 两张表；种子按 demo 填部门（u1 平台研发部、u2 数据部、u3 产品部，u4 空）与项目组 `g1 内网落地专项`（u1、u2）。
  - 应用侧没有写部门与项目组的接口；部门、项目组的增删改与解散都在 S3a 由管理员维护（ADR-0018：没有统一身份系统）。
  - `GET /api/accounts/me/scope` 回调用者的部门与所在项目组，供范围对话框用。
- **可见范围四档**（knowledge-bases）：
  - `knowledge_bases` 加 `scope`（`me` / `dept` / `group` / `all`，缺省 `me`）与 `scope_group_id`。
  - 查看者可见 = 自己的库 ∪ `all` ∪（`dept` 且查看者部门非空并等于所有者**当前**部门）∪（`group` 且查看者**当前**是该组成员）。管理员没有特权；所有者停用不影响可见。
  - 建库 body 可带 `scope` / `groupId`；新端点 `PUT /api/kb/bases/:id/scope` 改范围，只有所有者能改，任何 `state` 都可改，不取知识库写锁；`dept` 要求所有者部门非空，`group` 要求所有者是该组成员，否则 400。
  - 实际变化记 `kb.scope`（`before` → `after`）；建库的 `kb.create` detail 多 `scope`。
- **共享只读**（不变量 1）：
  - 路由的归属判定分两级：不可见一律 404（不可探测不变）；可见而不是所有者时，读路由（文档列表、检索测试）放行，写路由（删库、入库、上传、移出、重新入库、改范围）403 `forbidden`，先于 body 解析，不写审计。
  - 非所有者读文档列表时 `workspaceId`、`path`、`sourceChanged` 为 `null`（所有者沙箱里的路径不外泄）。
  - 非所有者做检索测试：body 校验不变，`threshold` / `vectorWeight` 的值被忽略，按已存值检索，绝不写回。
  - `BaseView` 多 `owned`、`owner{id, account, department}`、`scope{scope, group}` 三键；非自有库的 `compile` 恒为 `null`，列表不为它们读 RAGFlow。
  - 列表次序：自己的库按建库时间升序在前，其余可见库按建库时间升序在后。
- **跨账号检索审计**：
  - 新 kind `kb.shared_retrieval`：会话检索与检索测试每次对一个可见、`ready` 的非自有库发出 RAGFlow 请求**之前**写一条，actor 为检索者，detail `{id, name, ownerId, scope}`，不含问句与命中。审计写失败则该库不检索。
  - 审计查询不变：检索者本人与管理员可见，所有者看不到。
- **会话检索与引用的可见集合**：
  - `kb_search` 的定义列出全部可见库，非自有库的行附所有者账号；执行按可见判定，不可见与不存在同为 `not_found`。
  - 知识库引用的受理范围扩为可见库；已存的引用快照不重新校验。
  - 种子 (a)：`rebuild_failed` 的库文本为 `重建失败，本轮未检索`（`details.status` 仍为 `not_ready`，`kb.hits` 的枚举不变）；(b)：`kb_ids` 按原始数组判 1–5，通过后去重；(e)：单轮检索本地截到 6 条（检索测试与会话检索共用）。
  - 种子 (c)：内置命令带非空 `knowledgeBases` 一律 400 `bad_request`（与附件同一条规则）；web 沿用附件的拒绝呈现。
- **web**：
  - 中心知识库 tab：新建对话框带范围选择，列表与详情头部的范围按钮打开范围对话框（四档单选，`项目组` 带组下拉，无组时提示请管理员加入，部门为空时 `本部门可见` 置灰）。
  - 非所有者：列表显示 `只读` 标签与「来自 <账号> · <部门>」，没有删除、范围按钮、入库、上传、重新入库、移出；文档表不显示来源；检索测试的两个参数只读；编译只显示标签不显示状态。
  - 引用选择列表里非自有库附所有者账号。
- **验证**：
  - server 用例在假 RAGFlow 上搭多账号世界，覆盖四档、403/404、只读、审计与种子；web 单测覆盖非所有者呈现与范围对话框。
  - `ui-walk-center-kb.ts` 加非所有者与范围对话框分支（`page.route` 桩）。
  - 验收清单 CK 节加行（`待签`），owner 在真实栈上用两个浏览器走查，其中一行即 P2 里程碑验收。
- **文档**：`docs/architecture/system.md` 的 `accounts`、`kb` 两行与 §6.1；`openspec/glossary.md`「可见范围」「附件」「审计」「host tool」；`CONTEXT.md` 开放问题不动；`IMPLEMENTATION_PLAN.md` S2c 状态与 Next Step（同时纠正 A 签收后未更新的两处）。

## Capabilities

### New Capabilities
- `account-groups`: 账号的部门与项目组——迁移 053 的账号侧部分、种子、只读的「我的范围」端点；应用侧无写接口（S3a 接入真实来源与管理面）。

### Modified Capabilities
- `knowledge-bases`: 迁移 053 的知识库侧两列；可见判定与两级归属；范围端点与建库范围；`BaseView` 三键与列表次序；文档列表与检索测试的非所有者形态；单轮检索本地截断；会话检索的可见集合与 (a)(b)；审计表加 `kb.scope`、`kb.shared_retrieval`；中心 tab 的非所有者呈现与范围对话框；ui-walk 分支。
- `message-attachments`: 引用的受理范围扩为可见库、内置命令带引用 400；引用选择列表附所有者。
- `dev-stub-auth`: `accounts` 的持久契约随迁移 053 多一列 `department`（010 的契约原样，053 追加）。
- `omp-runtime`: `kb_search` 的定义来源从「所有者没有库」改为「没有可见的库」。
- `tool-approval`: `kb_search` 传输层放行的措辞同步「可见的库」。
- `http-service-skeleton`: content-parser 归属集加 `PUT /api/kb/bases/:id/scope`（三十九条 → 四十条）。

## Impact

- **server**：
  - 新文件：`server/src/core/db/migrations/053_kb_visibility.sql`、`server/src/accounts/scope.ts`（部门与项目组的读取与端点）、`server/src/kb/visibility.ts`（可见判定与两级归属）、`server/src/kb/scope.ts`（范围端点）、`server/src/kb/shared-audit.ts`（`kb.shared_retrieval`）。
  - 改动：`kb/bases.ts`（`ownedBase` 换成两级判定、建库范围、`BaseView`）、`kb/rest.ts`（preParsing 钩子分读写、注册范围路由）、`kb/store.ts`（范围写入；可见列表的 SQL 只在 `kb/visibility.ts`，`listBases` 无调用者后删除）、`kb/documents.ts`（非所有者形态）、`kb/retrieval.ts`（读写拆开、审计）、`kb/retrieval.ts` 与 `kb/ragflow-retrieval.ts`（关联之后截断，导出 `PAGE_SIZE`）、`kb/session-search.ts`（可见集合、(a)(b)、审计）、`sessions/store-knowledge-bases.ts` 与 `sessions/rest.ts`（内置命令带引用）、`accounts/index.ts`（注册端点）、`http/errors.ts`（content-parser 归属集加 `PUT …/scope`）；`app.ts` 预期不改。
- **web**：`lib/api-kb.ts`（`BaseView` 三键、`setKnowledgeBaseScope`）、新 `lib/api-accounts.ts` 或并入既有客户端（`getMyScope`）、`features/center/kb/`（list、detail、create-dialog、documents-table、retrieval-panel，新 `scope-dialog.tsx`）、`features/chat/kb-ref-picker.tsx`；顺带纠正 `features/chat/turn-actions.ts:67` 的注释漂移。
- **测试与走查**：`server/test/` 新增多账号可见性、范围端点、共享审计、迁移 053 用例；既有归属用例（「文档路由的所有权」）按两级判定改写；`web/test/` 对应组件；`web/e2e/ui-walk-center-kb.ts`。
- **不受影响**：omp 子进程治理（`kb_search` 的注册与协议不变，只是库清单变长）、RAGFlow 出站形状（除截断外）、CI 文件。
- **回滚**：迁移 053 不逆转（账本拒收）；回退代码时保留迁移，新列与新表无害，所有库按旧代码只对所有者可见。
