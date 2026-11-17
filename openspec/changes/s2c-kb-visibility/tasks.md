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
> `knowledge_bases` 列与外键清单（`kb-schema.test.ts:107-127,177`）、`BaseView` 键集（`kb-bases-list.test.ts:18-30`、`kb-bases.test.ts:141-153`、`kb-bases-compile.test.ts:188`）、`kb.create` detail（`kb-bases.test.ts:161`、`kb-bases-compile.test.ts:162`）、content-parser 归属集计数（`server/test/http-parser-owners.test.ts`）。

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
| 组 4：内建命令判定先于解析器 | 是 | `/compact` 带 `[K9]` 得 400 而非 404；知识库关闭时 `admitKnowledgeBases(["k1"], true, "u1", undefined)` 抛 `bad_request`；解析器不被调用 |
| 组 4：「无引用」只有一处定义 | 是 | 判定放在 `admitKnowledgeBases` 内、`store-knowledge-bases.ts:43-45` 的空值短路之后（同 `prompt-attachments.ts:142` 的写法），`rest.ts` 不另写「非空」判断；缺省与 `[]` 照常受理 |
| 组 4：只拦 `builtin` | 是 | 去首尾空白后的 ` /todo` 是 builtin（`prompt-attachments.ts:63` 先 trim）；`/todo import …`、未知 `/x`、`/skill:<名>` 不是（`slash-commands.ts:286-309`），带引用照常受理；用 `/todo import a.md` 作已绿的反向守卫 |
| 组 4：web / ui-walk / smoke | 否 | `web/e2e/ui-walk-chat-kb.ts` 不发 `/compact`，`smoke/` 无 `knowledgeBases`；web 用例在组 10 |
| 组 5：可见判定只有一处 | 是 | `kb/visibility.ts` 两条语句共用同一谓词常量，查看者经 `JOIN accounts AS v ON v.id = ?` 只绑定一次；扫描用例对三类 SQL 字面量断言「命中文件集合恰为点名文件」（非空，防空过），`accounts/scope.ts` 在白名单内 |
| 组 5：不可探测 | 是 | 七条 `:id` 路由对不可见库与不存在 id：状态码、body 字节、去掉 `date` 后的响应头全等；坏 body、超 16 KiB、`doc=`、bodyless 带 `{}`、上传错媒体类型下仍逐字节相同；零出站、无审计、行不变 |
| 组 5：403 先于 body、不写 | 是 | 本刀七条路由（含 `GET …/documents`、`POST …/retrieval`）对可见非所有者都 403 同一信封；畸形或超限请求也是 403 不是 400；零出站；`audit_events`、`knowledge_bases`、`kb_documents` 逐行不变 |
| 组 5：现查与无特权 | 是 | 带外改部门、删/加成员、改组名、停用所有者后，同一 cookie 下一次请求即变；u3（管理员）只看到 `all`；查看者部门为空、所有者部门为空都不匹配 |
| 组 5：列表次序 | 是 | 自有库 `created_at` 晚于他人库仍排在前；他人库两行 `created_at` 相同、插入次序与 id 次序相反，结果按 id；自有的第二个库带外写 `created_at = A2+1`，不靠同毫秒 |
| 组 5：非自有不读编译 | 是 | 非自有 raptor 库与非自有两开关都关的库 `compile` 都为 `null`；假 RAGFlow 只收到自有 raptor 库的文档列表与任务日志两条读取 |
| 组 5：跨服务严格解析 | 是 | 同一 PR 改 `api-kb.ts` 解析器、`center-kb-support.tsx` 的 `base()`、两个 typed `BASE`、`api-kb.test.ts:212-226` 的 `malformed` 映射（不改即 typecheck 红）、ui-walk 的 `BASE`；ui-walk 对新 build 的 `web/dist` 跑 |
| 组 5：死代码 | 是 | `readableBase` 本刀只作 `ownedBase` 的第一级，模块内、不导出；路由钩子的读入口由组 6（第一个使用者）加，本刀 `assertOwned` 只此一个入口 |
| 组 5：白盒 | 是 | 多租户过滤（灰盒例外候选，design Risks）：PR 标题与描述写明「请求白盒审查」 |
| 组 6：只放开一处读路由 | 是 | 只有 `rest.ts:246-248` 的 `GET …/documents` 改用读入口；`POST …/retrieval`（`:286-289`）与五条写路由的钩子、`documents.ts:365,375,397`、`uploads.ts:251,269`、`retrieval.ts:186`、`bases.ts:212,261,303` 的复核点仍为 `ownedBase`；「共享库的两级归属」里检索测试仍断言 403 |
| 组 6：「不解析、不 stat」可证伪 | 是 | 非所有者若照旧以自己身份调 `sourceChangedOf`，`rootOf(u2, W1)` 得 null（`source-file.ts:204` → `:140`），三个 `null` 与 `node:fs` 记录器都照样绿；唯一能分辨的观察点是 `app.workspaces.store.rootOf` 的 spy（与 kb 的 sources 同一对象，`kb/index.ts:167-168`），同一用例里 u1 的请求作阳性对照 |
| 组 6：原子性 | 是 | 钩子改读级、`documents.ts:636` 复核点改读级、非所有者三键置空在同一个实现提交里（仓库按 `--merge` 合并，提交级中间态也会进 master 历史）；只改其一时「非所有者看不到来源」为红（403 或泄露 `W1` / `docs/a.md`） |
| 组 6：既有用例的 403→200 | 是 | `kb-visibility.test.ts:237`、`:256` 与「共享库的两级归属」三处原地改；`:261` 的 404 与「不可见与不存在不可区分」（`:329` 遍历 `VALID`）不变 |
| 组 6：白盒 | 是 | 隐私（所有者沙箱路径）与沙箱边界：PR 标题与描述写明「请求白盒审查」 |
| 组 7：不变量 1（非所有者不写回、从不取锁） | 是 | 非所有者以与已存值不同的参数检索：重建器持锁时 200（所有者同情形 409，`kb-retrieval-endpoint.test.ts:345-353`）、写者持锁时不等待即 200，`writeWaiters` 恒为 0；已存两列与 `updated_at` 逐值不变，没有 `kb.retrieval_settings`，检索 body 带已存值 |
| 组 7：审计时点与失败语义 | 是 | 挂起假 RAGFlow 的检索路由，`gate.reached` 时已恰一条 `kb.shared_retrieval`（写在请求之前）；检索 503 时审计照样一条（与结果无关）；按 kind 的触发器让审计写失败 → 通用 500 逐字节、零出站、零审计；400 / 409 / 404 都不写 |
| 组 7：只放开一处读路由，写回复核仍为写级 | 是 | `rest.ts:293` 的钩子改为 `readableBase`；首判 `readableBase`，锁内写回 `saveLocked` 仍为 `ownedBase`；靠 grep 证据兜底（锁内复核误降为读级时测试抓不到） |
| 组 7：既有用例的 403→200 与 403→400 | 是 | 「两级归属」的检索测试改为 200（需要先在假 RAGFlow 种数据集，否则是 503）；「403 先于 body」剔除 `MALFORMED` 里的检索超限一条（可见的非所有者此后得 400）；「不可见与不存在不可区分」原样遍历全部（仍是 404） |
| 组 7：自有库永不写共享审计 | 是 | `auditSharedRetrieval` 在 `owned` 时直接返回；所有者对 `dept` 库检索（参数相同与不同各一次），`kb.shared_retrieval` 为 0 条；`kb-retrieval-endpoint.test.ts` 不改、全绿 |
| 组 7：原子性 | 是 | 钩子改读级、非所有者分支、`shared-audit.ts` 放在同一个实现提交里（按 `--merge` 合并，提交级的中间态也会进 master 历史）；只改钩子时会出现未审计的跨账号检索 |
| 组 7：白盒 | 是 | 多租户过滤与跨账号读：PR 标题与描述写明「请求白盒审查」 |
| 组 8：一次读取、不留旧读法 | 是 | `definitionFor`、`execute`、`resolveReferences` 都经同一个 `visibleOf(viewerId)`（`visibility.visibleBases` 一次）；`grep -n "listBases\b\|SELECT_BASES_BY_OWNER" server/src server/test` 为空（`listBasesInState` 除外） |
| 组 8：描述行与次序 | 是 | 非自有行 `- <名称>（<id>，所有者 <account>）`；K1 的 `created_at` 早于 A2，结果仍是 A2 在前（只按建库时间排会红） |
| 组 8：先查中止、再审计、再检索 | 是 | 已中止的信号：K 为 `failed`，`kb.shared_retrieval` 0 条，假 RAGFlow 0 请求；`gate.reached` 时共享审计已恰 1 条；触发器让审计写失败：K 为 `failed`，只收到 A2 的检索 |
| 组 8：审计失败只影响该库 | 是 | try/catch 只包 `auditSharedRetrieval` 这一调用，不包检索；捕获后不记日志、不重抛；同调用里自有库照常 `ok`，`isError` 为假 |
| 组 8：哨兵与审计可见性 | 是 | 问句带 `CONTENT_SENTINEL`：`audit_events` 全表原始行、三份 `GET /api/audit` body、`world.logged` 都不含它；u1 看不到，u2 与 u3 各看到恰两条 |
| 组 8：收回共享 | 是 | 带外 `SET scope='me', scope_group_id=NULL`（053:53 的 CHECK 要求两列同改）之后，定义里没有 K1、执行为 `not_found`、没有新审计；已受理消息的快照不变 |
| 组 8：死代码 | 是 | 同一提交删 `store.listBases`、`SELECT_BASES_BY_OWNER` 与 `kb-store.test.ts:194-205`；`BASE_ORDER` 留（`SELECT_BASES_BY_STATE` 仍在用）；knip 绿 |
| 组 8：白盒 | 是 | 跨账号检索与多租户过滤：PR 标题与描述写明「请求白盒审查」 |
| 组 9：规格场景与本刀的差异 | 是 | 「共享库的只读呈现」（spec.md:534）写「A 的行有范围按钮 `仅自己可见`」，详情头部（spec.md:462）亦为按钮；本刀按 9.3 两处都是纯文本、不是按钮，用例断言「没有该名称的按钮」；组 12 在 `center-kb-shared.test.tsx` 原地改为按钮，不另写一份 |
| 组 9：既有定位器 | 是 | `rowOf`（`center-kb-support.tsx:285-291`）、`findByRole("cell",{name})`（`center-kb-detail.test.tsx:51`）、ui-walk `ui-walk-center-kb.ts:129`（`exact:true`）都按名称格全文匹配：自有库的名称格 SHALL 只有名称；`只读` 与 `来自 …` 只出现在共享库的名称格 |
| 组 9：编译格按 `owned` 分支，不按 `compile` 判空 | 是 | 共享库只出标签、不出 `状态未知`；自有库 `compile:null` 仍为 `状态未知`（`list.tsx:87`，`center-kb-list.test.tsx` 既有用例原样绿） |
| 组 9：只读数字可证伪 | 是 | jsdom 里 `fireEvent.change` 对 readOnly 输入照样触发；判别断言是「改值后仍为 `0.2`，请求 body 带已存值」，只断言 `readOnly` 属性抓不到仍接着 `onChange` 的实现 |
| 组 9：对自有库用户可见 | 是 | 计数行与 `范围` 列（`仅自己可见`）本刀即对所有用户可见；本刀不加 CK 行（D12，issue Out of Scope），PR 描述按偏离写明「可见变化 + CK 行在 11.4 / 12.4」 |
| 组 9：ui-walk 自有分支 | 是 | 列表加一列、详情头部加范围标签只改自有分支的版面；CI `ui-walk`（`all-checks-passed` 成员，`make check` 不跑）须绿，本机亦跑一次；`范围` 列在表格容器的 `overflow-x-auto` 里，不得进入检索测试区域的祖先宽度（`ui-walk-center-kb.ts` 的 `expectPanelFits`） |
| 组 10：所有者字样与库名同一个文本串 | 是 | 后缀写进 `kb-ref-picker.tsx:145` 那个 span，模板串 `${base.name}（${base.owner.account}）`；`options()`（`chat-kb-ref-support.tsx:120-129`）只比按钮 `textContent`，相邻 span 的写法也会绿；判别断言是 `within(dialog).getByText("规范库（zhangsan）",{exact:true})`（只认元素自身的文本节点）；ui-walk `ui-walk-chat-kb.ts:111` 按 `exact:true` 匹配可访问名，状态字样那种相邻 span 只能用正则（`:131-132`），组 13 与 11.4 的 CK 行要的是精确名 |
| 组 10：按 `owned` 分支，不按所有者或范围 | 是 | 自有库 `产品文档` 用 `base()` 缺省的 `owner.account:"zhangsan"`（`center-kb-support.tsx:46-47`），再补 `scope:{scope:"all",group:null}`：按「有 owner」或按 `scope !== "me"` 判的实现会出 `产品文档（zhangsan）`；半角括号、多空格、取 `owner.id` 或 `department` 的实现，都被 `options` 的精确比较抓到 |
| 组 10：标签与气泡只写库名 | 是 | `onToggle(base)`（`:142`）不动，`toggleKbRef` 只拷 `{id,name}`（`kb-refs-state.ts:14`），规格 spec.md:56「每项显示库名」；点选共享库后 `tagNames()` 为 `["规范库"]`、有 `移除 规范库`，把带后缀的名字交给 `onToggle` 的实现在这里变红 |
| 组 10：只有「共享库附所有者」先红后绿 | 是 | web 本来没有内建命令判定（design B16、D10），`chat-kb-ref-picker.test.tsx:265-288` 已证明 400 时引用保留；「内建命令带引用被拒」开工即绿，是守卫；判别断言：prompt body 恰为一条 `{message:"/compact",knowledgeBases:[PRODUCT.id]}`（前端拦截则零条，剥掉键则少键），`alerts()` 恰为服务端的 message |
| 组 10：对用户惰性 | 是 | 组 11 之前没有 `owned:false` 的库（D12）；ui-walk 桩 `BASE` 是自有库，`ui-walk-chat-kb.ts` 不变；本组不加 CK 行（11.4 的 P2 里程碑行已写 `规范库（zhangsan）`） |
| 组 11：打开共享的唯一开关（D12） | 是 | 依赖头保证最后合入（← 1 第二刀、6–10）；合入即对非所有者生效。PR 标题与描述写「多租户过滤与跨账号共享：请求白盒审查」 |
| 组 11：ragflow-backend 增量规格 | 是 | 主规格 ragflow-backend/spec.md:79-81 写死「十三条」，kb-disabled.test.ts:2 要求逐组扩表；#2037 fixture 审查时补了 MODIFIED「知识库可用性」改为十四条，实现方同 PR 扩表 |
| 组 11：判定次序 | 是 | 钩子 ownedBase 先于 body（坏 JSON 的 PUT 对可见非所有者 403，不是 400）；处理函数 ownedBase → 形状 → scopeOf 条件 → 与 access.scope 相同不写 → inTransaction 里 UPDATE，changes 为 0 抛 404 回滚，再写 kb.scope；条件先于「相同」（失去成员后重存同一范围 400） |
| 组 11：0 行 404 只能注入 | 是 | 第 1–5 步是同一连接上的同步调用，真实删库落不进这一段，只会在重读时 404；0 行分支用 TEMP 触发器 BEFORE UPDATE OF scope … RAISE(IGNORE) 注入（先例 auth-session.test.ts:394-401），另写一例真实删库交错；不为测试加 await 或注入点 |
| 组 11：不取写锁、任何 state | 是 | 入库持锁（上传挂起）时 PUT 立即 200，入库仍未落定，writeWaiters 为 0；重建器持锁且 rebuilding 时 200 不是 409；rebuild_failed 同样 200 |
| 组 11：一条事务 | 是 | 触发器拒绝 kb.scope 审计：通用 500，范围不变，isTransaction 为 false；只改 UPDATE、不包事务的实现会留下没有审计的范围变更 |
| 组 11：应答 compile 的 5 s 期限 | 是 | 经 bases 的同一个 compileStatus 实例 read([base])（同一期限）；假 RAGFlow 关闭时 null 仍 200；挂起加 300 ms 期限仍 200；开 RAPTOR 的阳性对照恰读两条 |
| 组 11：建库范围的次序 | 是 | 第 1 步不读库（未配置嵌入时坏范围 400，不是 409）；第 5 步在锁内、重名之后（重名加坏组得 409 conflict）、出站之前（raptor:true 的 u3、u4 零出站） |
| 组 11：SQL 落点与 scopeOf 复用 | 是 | 写 scope 的 SQL 只有一条，在 kb/scope.ts；扫描集合原地扩为 kb/scope.ts、kb/visibility.ts，scope.ts 的 SQL 字面量恰为那条 UPDATE；department 与 project_group_members 两个集合不变（证明复用 scopeOf） |
| 组 11：归属集与计数 | 是 | errors.ts 集合加一条，共四十条；http-parser-owners 改为 40 条、PUT 8 条；kb-disabled 表十四条；kb.create detail 在 kb-bases.test.ts:168 与 kb-bases-compile.test.ts:162 两处原地改 |
| 组 11：冒烟按名选库 | 是 | 共享打开后列表含他人同名库：kb.hurl:194 与 kb-cleanup.hurl:32、45、56 加所有者过滤；:184 按 id，不改；smoke-kb 为 review-only |
| 组 11：CK 行字面量 | 是 | /api/audit 只给 actorId（core/audit/index.ts:140），写 u2 不写 zhaoliu；计数行以 zhaoliu 名下没有库为前提（list.tsx:163） |
| 组 12：新的严格解析器 | 是 | `getMyScope` 按 account-groups/spec.md:29-31、:37 恰为 `{department, groups}`，组内恰为 `{id, name, memberCount}`；`memberCount` 为正安全整数，`0`、`-1`、`1.5`、`"2"`、`2 ** 53` 都是 `requestFailed(200)`；唯一来源是 `server/src/accounts/scope.ts:8-24`；ui-walk 的桩在组 13 |
| 组 12：PUT 与 POST 的 `scope` 不对称 | 是 | PUT 必带 `scope` 键（`server/src/kb/scope.ts:85-88`，缺键 400），设回仅自己可见发 `{"scope":"me"}`；建库为仅自己可见时 body 不带 `scope`（spec.md:450）；非 group 档两处都不带 `groupId`（带 `null` 也是 400，`kb/scope.ts:37-52`）；断言用 `toStrictEqual` 与原始 body 串，不用 `toEqual` |
| 组 12：fakeKb 的缺省方法 | 是 | `center-kb-support.tsx:249` 展开真实客户端：不补成功的缺省 `getMyScope`，新建对话框走真实 fetch，多出一条 alert，`center-kb-list.test.tsx:355` 的 `findByRole("alert")` 变红；support 补 `getMyScope`、`setKnowledgeBaseScope`，并让 `createKnowledgeBase` 回显请求的范围 |
| 组 12：客户端键集守卫 | 是 | `api-files-archive.test.ts:246-320,344` 断言客户端恰为已归类的方法：两个新方法加进 `OTHER_CLIENT_METHODS`；issue AC 的 test:focus 模式不含这个文件，回归命令补 `api-files-archive` |
| 组 12：组 9 的用例原地改 | 是 | `center-kb-shared.test.tsx:88,199` 的按钮名加 `仅自己可见`；:174、:179 改为「自有库是按钮、共享库是纯文本」；:153 标题与 :2 头注同步；不另写一份 |
| 组 12：两个对话框的失败态不同 | 是 | 范围对话框取不到范围：四档与 `保存` 全部禁用、有 alert、`setKnowledgeBaseScope` 零次；新建对话框：只留 `仅自己可见`、有 alert、建库照常且不带 `scope`；判别断言是对 `scopeOptions` 整表 `toEqual` |
| 组 12：读取在点击事件里发出 | 是 | `getMyScope()` 在打开对话框的点击里发出（先例 `kb-ref-picker.tsx:24-27`）；面板挂载时零次，每次打开恰一次；不传 signal，迟到的应答按打开序号丢弃 |
| 组 12：保存恰一次、不在前端短路 | 是 | 在途时 `保存`、`取消`、四档都禁用，ref 拦同一帧的第二次；原样保存也发一次（spec.md:459，偏离 demo :3084；服务端遇到相同范围 200、不写、不审计） |
| 组 12：用应答替换列表行 | 是 | 成功后按 id 用应答的 BaseView 整行替换，不重取列表，再 `invalidateRefetch`（`use-kb.ts:23-24`）；判别：应答带一个请求推不出的 `documents:7` |
| 组 12：范围按钮不冒泡、任何 state 都有 | 是 | 先 `stopPropagation`，否则点按钮会进入详情；`rebuilding` 的自有行也有范围按钮（B18），只是没有 `删除知识库` |
| 组 12：Radix RadioGroup 的第一个使用者 | 是 | 拷入层 `radio-group.tsx` 仓内没有使用者；受控「无选中」与表单内隐藏 input 未实测；断言只看 `aria-checked`、`disabled` 与 label 文本；与实测不符时停下来报告 |
| 组 12：ui-walk 版面 | 是 | 自有行的范围格与详情头部从 span 变成按钮；CI `ui-walk`（`all-checks-passed` 成员，`make check` 不跑）须绿，本机跑一次；范围对话框的走查在组 13 |
| 组 12：CK 行字面量 | 是 | `/api/audit` 只给 actorId（组 11 裁定），写 `u1`；CK-21/22 已随 #2054 进 master，新行编号 CK-23 |
| 组 13：调用点与用例计数 | 是 | 新段由 `walkKbRetrieval` 在 `finally`（`ui-walk-center-kb.ts:151-156`）之后、`logout`（:157）之前调用一次，`ui-walk.spec.ts` 不改；用例数不变，仍为 17 passed、1 skipped（(7+2)×2 减 mobile-dark 的 pre-paint skip）；放在 `try` 里会让新段按 pattern 撤桩时连父级的同名桩一起撤掉 |
| 组 13：import 环 | 是 | 新文件从 `ui-walk-center-kb.js` 导入 `BASE`、`STATUS`、`json`、`shot`，后者反向导入新文件；新文件先求值，顶层的 `{ ...BASE }`（`ui-walk-chat-kb.ts:33-36` 的写法）会触发 TDZ。桩对象一律在函数里现造，顶层只放字面量常量 |
| 组 13：桩的键集与 oracle | 是 | `BaseView` 十四键（`api-kb.ts:220-235`）、`DocumentView` 十一键（:236-248）、`GET /api/accounts/me/scope` 恰 `department, groups`，组内恰 `id, name, memberCount`（组 12 契约）；只回 200。PUT 未桩时打到真实服务，得 503 `kb_disabled`，console error 会让 oracle 变红 |
| 组 13：判别断言 | 是 | PUT 应答带 `documents:7`，判别「用应答整行替换」与本地拼行；列表 GET 恰 1 次、范围 GET 点按钮前 0 次、之后恰 1 次（种子里 zhangsan 的真实范围与桩值相同，只能靠计数证明走的是桩）；PUT 的 body 用 `toStrictEqual`，并比对原始串 |
| 组 13：撤桩 | 是 | 新段自己的 `finally` 按装桩的逆序 `unroute` 五个 pattern；调用点在父级撤桩之后，所以按 pattern 撤不会误伤 |
| 组 13：宽度检查 | 是 | `expectPanelFits`（:237-256）是模块私有的，对 portal 出来的对话框会在 :251 失败，不导出也不复用；用 `expectNoHorizontalOverflow` 加本地的 scrollWidth / boundingBox 检查 |
| 组 13：Radix 在真实 Chromium | 是 | 拷入层 `RadioGroup` 与 `Select` 第一次进 ui-walk（组 12 只在 jsdom 测过）；`Select` 打开时其余内容被设为 aria-hidden，选项要从 `page` 找；与实测不符时停下来报告 |
| 组 13：时限 | 是 | 宿主用例沿用配置的 30 s（`playwright.config.ts`），没有 `setTimeout`；基线 desktop-light 1.1 s、mobile-dark 1.7 s；任一 project 超过 24 s 停下来报告，不改 spec 文件 |
| 组 13：依赖组 12 的产物 | 是 | 分支从合入 #2038 之后的 master 切出；ui-walk 对本分支新 build 的 `web/dist` 跑（`ci-compiled-server.sh` 本身不 build） |
| 组 13：失败路径、CK 行、产品代码 | 否 | oracle 不放行 4xx/5xx，失败态、没有部门与没有项目组、新建对话框的范围由 `center-kb-scope.test.tsx` 覆盖；不改产品代码、不加 CK 行 |

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

- [x] 3.1 核对 Context：`server/src/kb/session-search.ts` 的 `render`（:111-118，`not_ready` 固定一句）与 `parseArgs`（:78-102，去重后才判上限）；`server/test/kb-session-search.test.ts`（450 行）；chat-stream 的 `kb.hits` `status` 枚举（不改）
- [x] 3.2 测试先行：在 `kb-session-search.test.ts` 加「重建失败与重建中分开措辞」，改写「参数校验」（六个不同的 id 与六元素含重复两例）
- [x] 3.3 实现：`render` 按库的 `state` 分两句，`details.status` 仍为 `not_ready`；`parseArgs` 先按原始数组判 1–5 再去重
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

- [x] 4.1 核对 Context：`server/src/sessions/rest.ts:336` 的 `builtin` 计算与附件第 3 条的位置；`server/src/sessions/store-knowledge-bases.ts:38-62` 的 `admitKnowledgeBases`；`server/test/prompt-knowledge-bases.test.ts:279` 的既有用例
- [x] 4.2 测试先行：把 `prompt-knowledge-bases.test.ts:279` 原地改为断言 400（`/compact`、` /todo` 带引用；`/compact` 带不存在的 id 也是 400）；`/compact` 不带引用与 `knowledgeBases:[]` 照常受理
- [x] 4.3 实现：内建命令带非空 `knowledgeBases` → 400，位置在可见判定之前、与附件第 3 条相邻
  - 组 4 约定（#2030 fixture 审查补；4.2–4.3 照此实现与测试）：
    - 4.1 的行号更正：`admitKnowledgeBases` 为 `store-knowledge-bases.ts:38-61`；`builtin` 在 `rest.ts:336` 是实参内联、不是绑定。
    - 实现：`rest.ts` 在 `:331` 之前提出 `const builtin = classifyPrompt(text, skills).kind === "builtin";`，`:336` 与 `:340` 共用；`:357` 的 `command` 不动。`admitKnowledgeBases(value, builtin, ownerId, resolve)`：`:43-45` 空值返回 `[]` 之后紧接 `if (builtin) throw new HttpError("bad_request")`，先于形状检查与 `resolve?.`；`:31-37` 的 JSDoc 与 `rest.ts:339` 的注释补一句「内建命令带引用 400，先于可见判定（与附件第 3 条同一规则）」。
    - 测试（`prompt-knowledge-bases.test.ts:279` 原地改，仍在「受理、后缀与落库」describe 内，改名「内建命令带非空引用 400，先于可见判定；不带引用与 `[]` 照常受理」）：
      - 同一会话依次 `expectRefused(world, session, body, 400, BAD_REQUEST_ENVELOPE)`：`{message:"/compact", knowledgeBases:[K1]}`、`{message:" /todo", knowledgeBases:[K1]}`、`{message:"/compact", knowledgeBases:[K9]}`；每次返回的 audit `toEqual([])`；前后 `world.ragflow()` 不变。改前依次为 202、202、404，三例都先红。
      - 各用新会话 `expectAdmitted`：`{message:"/compact"}` 与 `{message:"/compact", knowledgeBases:[]}`，派发文本恰为 `"/compact"`，`columnOf(...).map(r => r.knowledge_bases)` 为 `[null, null]`。
      - 反向守卫（已绿）：新会话 `{message:"/todo import a.md", knowledgeBases:[K1]}` 202，派发文本恰为模板串「一个空格 + `/todo import a.md${K1_SEGMENT}`」（`/todo import` 是 text 类，`toWireText`（`slash-commands.ts:312-314`）加转义前导空格，规格 `message-attachments/spec.md:72`），列为 `K1_COLUMN`。`K1_SEGMENT` 与 `K1_SUFFIX` 的导入因此仍在用。
    - `:424-428` 的三处直调原地补 `builtin` 实参（`false`）；同一用例加 `admitKnowledgeBases(["k1"], true, "u1", undefined)` 抛 `code:"bad_request"`、`admitKnowledgeBases([], true, "u1", undefined)` 为 `[]`。
    - 测试文件头 `:2-5` 补一句「#2030 s2c-kb-visibility 组 4：内建命令带非空引用 400，先于可见判定」。
    - 非目标：已落库的内建命令引用行（只有 `rest.ts:340` 调用判定，快照与对位不重验）；web（组 10 只加用例）；可见受理（组 8）。
    - 行数：`rest.ts` 619 → ≤ 626（Biome 折行，原估 ≤ 623）；`store-knowledge-bases.ts` 140 → ≤ 145；测试 465 → ≤ 500。
    - 回归命令：`npm run test:focus --workspace server -- prompt-knowledge-bases`（先红后绿）；`npm run test:focus --workspace server -- session-prompt-attachments session-rest-slash slash-commands`；`make lint`、`make typecheck`、`make anti-drift`；最后 `make check`。

Suggested fixture level: compact - 受理判定多一条拒绝，不改落库与快照。
Minimal mergeable slice: atomic - 一条判定一组用例。

## 5. 可见判定与两级归属（knowledge-bases「可见范围判定」「知识库端点」）

- [x] 5.1 核对 Context：`server/src/kb/bases.ts:89-99` 的 `ownedBase`、`:283-284` 的 `assertOwned`（`rest.ts:195` 钩子实际调用的入口）与处理函数里的复核点（`documents.ts:364,374,396,635`、`uploads.ts:249,267`、`retrieval.ts:186,196`、`bases.ts:200`）；`kb/store.ts:158,323` 的 `listBases`；列表的编译状态读取；`web/src/lib/api-kb.ts:212` 的 `BASE_KEYS`；web 夹具 `web/test/center-kb-support.tsx`、`chat-kb-ref-support.tsx`、`api-kb-retrieval.test.ts:36`；ui-walk 桩 `web/e2e/ui-walk-center-kb.ts:46-57`
- [x] 5.2 测试先行（server）：新文件 `server/test/kb-visibility.test.ts`，在假 RAGFlow 上用种子账号与 g1 搭多账号世界（库的范围带外写列；u4 按需带外启用），覆盖「可见范围判定」全部场景（含「只有一处可见判定」的扫描）、「知识库端点」的「403 先于 body」「不可见与不存在不可区分」（`PUT …/scope` 那两次在组 11 加）、「列表的可见集合、次序与非自有的编译状态」，以及「共享库的两级归属」的写路由 403 部分（`PUT …/scope` 的 403 在组 11 加：路由到那时才注册）。本刀里 `GET …/documents` 与 `POST …/retrieval` 对可见非所有者仍为 403（组 6、组 7 放开，用例按本刀行为写、由它们原地改）
- [x] 5.3 测试先行（web）：新文件 `web/test/api-kb-visibility.test.ts`：`BaseView` 三键的严格解析（多键、缺键、`scope` 越界、`owner.department` 非字符串非 null 即 `requestFailed`）
- [x] 5.4 实现新文件 `server/src/kb/visibility.ts`（design D2：一条 SQL 的 `visibleBases(viewerId)` 与 `accessOf(id, viewerId)`；列表改经它取可见集合，`kb/store.ts` 不加读 `scope` 列的 SQL）；`ownedBase` 原地改为两级（`readableBase` / `ownedBase`），`assertOwned` 拆读写两个入口，不留旧函数；本刀全部 `:id` 路由仍用 `ownedBase`；列表改为可见集合与 D2 次序，编译状态只为自有库读；`BaseView` 加 `owned`、`owner`、`scope`
- [x] 5.5 原地改精确形状断言：`kb-bases-list.test.ts:18-30`、`kb-bases.test.ts:141-153`、`kb-bases-compile.test.ts:188`
- [x] 5.6 实现（web）：`api-kb.ts` 的类型与解析器加三键；web 夹具、`api-kb.test.ts:77` 的 typed `BASE` 与 `api-kb-retrieval.test.ts:36` 补三键；ui-walk 的 `BASE`（`ui-walk-center-kb.ts:46-57`，`ui-walk-chat-kb.ts` 展开复用它）按 `owned:true` 自有库补三键；本刀不改任何组件；本机 `make ui-walk` 全绿，PR 附命令与退出码
  - 组 5 约定（#2031 fixture 审查补；5.2–5.6 照此实现与测试）：
    - 5.1 行号更正：`retrieval.ts` 的复核点是 `:187`（`readyBase`，`:182-191`，被 `:199`、`:232` 调用）；`kb-bases-compile.test.ts` 的 201 字面量是 `:182-193`；ui-walk 的 `BASE` 是 `ui-walk-center-kb.ts:46-58`。其余 5.1 行号已核实。
    - 与 5.4 的差异（审查裁定）：5.4 的「`assertOwned` 拆读写两个入口」改为本刀只有写入口——本刀没有读路由使用者，读入口与 `readableBase` 的导出由组 6（第一个使用者）加，免得留无引用导出。
    - 新文件 `server/src/kb/visibility.ts`（≤ 110 行）：
      - 导出 `createKbVisibility(db: DatabaseSync)`，返回 `{ visibleBases(viewerId: string): BaseAccess[]; accessOf(id: string, viewerId: string): BaseAccess | null }`。
      - 导出 `interface BaseAccess { base: KnowledgeBase; owned: boolean; owner: { id: string; account: string; department: string | null }; scope: { scope: "me" | "dept" | "group" | "all"; group: { id: string; name: string } | null } }`。在 D2 的形状上加 `scope`：`BaseView` 与组 7 的审计 detail 都取它。`KnowledgeBase` 不加字段（`kb-store.test.ts:165` 等是整对象断言）。
      - `store.ts` 只把 `function toBase` 改成导出，供映射用（不加 SQL，`store.ts` 658 行不增）。
      - SQL：一个 SELECT 常量加一个谓词常量，两条预编译语句共用：
        `SELECT kb.*, kb.owner_id = v.id AS owned, o.account AS owner_account, o.department AS owner_department, g.name AS group_name FROM knowledge_bases AS kb JOIN accounts AS o ON o.id = kb.owner_id JOIN accounts AS v ON v.id = ? LEFT JOIN project_groups AS g ON g.id = kb.scope_group_id`
        谓词：`(kb.owner_id = v.id OR kb.scope = 'all' OR (kb.scope = 'dept' AND v.department IS NOT NULL AND v.department = o.department) OR (kb.scope = 'group' AND EXISTS (SELECT 1 FROM project_group_members AS m WHERE m.group_id = kb.scope_group_id AND m.account_id = v.id)))`
        - `visibleBases`：`WHERE <谓词> ORDER BY owned DESC, kb.created_at, kb.id`，`.all(viewerId)`。
        - `accessOf`：`WHERE kb.id = ? AND <谓词>`，`.get(viewerId, id)`（占位符次序：v 在前）。
        - 不按角色分支，不读 `disabled`，不缓存；JS 里不排序。
      - 映射：`owned` 为 `row.owned === 1`；`owner` 按 `id`（取 `kb.owner_id`）、`account`、`department` 的键序构造；`scope` 为 `{ scope, group }`，`scope_group_id` 为 NULL 时 `group` 为 `null`，否则为 `{ id, name }`。
      - 装配：`kb/index.ts` 在 `const store = createKbStore(app.db)` 之后建 `const visibility = createKbVisibility(app.db)`，传给 `createKbBases`、`createKbDocuments`、`createKbUploads`、`createKbRetrieval`。各自的依赖接口加 `visibility: Pick<ReturnType<typeof createKbVisibility>, "accessOf">`，bases 再加 `"visibleBases"`。测试里没有直接构造这四个模块，无连带改动。
    - `bases.ts` 两级归属（`:88-99` 原地改，不留旧函数）：
      - 模块内 `readableBase(visibility, id, viewerId): BaseAccess`：`accessOf` 为 `null` 时抛 `not_found`。本刀不导出，组 6 导出并接到读路由。
      - `export function ownedBase(visibility, id, viewerId): BaseAccess`：先走 `readableBase`，`owned` 为假时抛 `forbidden`。
      - 8 个调用点只改第一个实参并解构 `{ base }`：`bases.ts:200`、`documents.ts:364,374,396,635`、`uploads.ts:249,267`、`retrieval.ts:187`（`readyBase` 的第一个参数从 store 改为 visibility）。
      - `assertOwned`（`:282-285`）照旧是钩子唯一入口，改为调用新的 `ownedBase`；`rest.ts:194-197` 的钩子不改。本刀不加读入口（组 6 加）。
      - `viewOf`（`:169-188`）改为 `viewOf(access, documents, compile)`，输出键序为 `id, name, template, raptor, graph, state, stateMessage, documents, compile, retrieval, createdAt, owned, owner, scope`。
      - 建库（`:235-248`）：`try` 里只 `createBase`，`catch` 照旧 discard 后重抛；`try` 之后再 `return viewOf(ownedBase(visibility, base.id, ownerId), 0, createdCompile(base))`。读访问失败不会触发删 RAGFlow 资源。
      - 列表（`:267-273`）：`const accesses = visibility.visibleBases(viewerId); const owned = accesses.filter(a => a.owned).map(a => a.base); const compiles = await compileStatus.read(owned);` 按 id 建表回填；非自有库恒为 `null`，包括两开关都关的库。只调用一次 `read`，5 s 期限共用（`compile-status.ts:137-160`）。
      - `KbBasesDependencies.store` 的 Pick 删掉 `"listBases"`（`:47`）。`store.listBases` 仍由 `session-search.ts:135,158` 使用，knip 不报，组 8 删。
      - 注释同步：`bases.ts:13,17-18,88,267,282`；`rest.ts:23-25,30,33,36`，「所有权」改为「归属（不可见 404、可见非所有者 403）」。
    - 新测试文件 `server/test/kb-visibility.test.ts`（≤ 560 行）：
      - 夹具：世界用 `useSettingsWorlds` 加 `configuredWorld`；次序用例用 `chatWorld`（`kb-settings-helpers.ts`）。member、peer、admin 分别是 u1（zhangsan）、u2（zhaoliu）、u3（lisi）。u4 每个用例按需先 `enableAccount(world.db, "u4")`（`session-db-helpers.ts:127`），再取 `cookieFor(world.app, "wangwu")`（`session-rest-helpers.ts:221`），本文件写一个小助手直接 `app.inject`。库行用 `insertRow` 加 `BASE_ROW`、`COMPILE_ROW`、`UPLOAD_ROW` 与 `hex`（`kb-store-helpers.ts:18-39`），`T0` 为 1_760_000_000_000。期望值一律写字面量。
      - 常量：U1 = `{id:"u1",account:"zhangsan",department:"平台研发部"}`；U2 = `{id:"u2",account:"zhaoliu",department:"数据部"}`；U3 = `{id:"u3",account:"lisi",department:"产品部"}`；G1 = `{scope:"group",group:{id:"g1",name:"内网落地专项"}}`。
      - 「四档 × 查看者」：u1 名下带外插入 Km=hex(1)（me，T0+1）、Kd=hex(2)（dept，T0+2）、Kg=hex(3)（group/g1，T0+3）、Ka=hex(4)（all，T0+4）。
        - 各人列表的 id：u1 `[Km,Kd,Kg,Ka]`；u2 `[Kg,Ka]`；u3 `[Ka]`；u4 `[Ka]`。
        - u2 的两项按 14 键 `toEqual`。Kg 为 `{…, compile:null, owned:false, owner:U1, scope:G1, createdAt:T0+3}`；Ka 的 `scope` 为 `{scope:"all",group:null}`，`compile` 为 `null`。
        - u1 的 Kd 为 `owned:true`、`compile:{raptor:"off",graph:"off"}`、`scope:{scope:"dept",group:null}`。
        - `world.sent()` 为 `[]`。u3 请求 `GET …/Km/documents` 得 404，请求 `GET …/Ka/documents` 得 403。
      - 「同部门与空部门」：`UPDATE accounts SET department='平台研发部' WHERE id='u2'` 之后，u2 为 `[Kd,Kg,Ka]`。再把 u1 的部门改为 NULL：u2 为 `[Kg,Ka]`，其中 Kg 的 `owner.department` 为 `null`；u4 为 `[Ka]`；u1 仍为四个。
      - 「成员关系现查」：u2 请求 `GET …/Kg/documents` 得 403（本刀）；删除成员行 `(g1,u2)` 之后 u2 为 `[Ka]`、同一请求得 404 `NOT_FOUND`；插入成员行 `(g1,u3)` 后 u3 为 `[Kg,Ka]`；`UPDATE project_groups SET name='新专项'` 后 u3 的 Kg `scope` 为 `{scope:"group",group:{id:"g1",name:"新专项"}}`。
      - 「停用的所有者」：`disableAccount(world.db,"u1")` 之后，u2 为 `[Kg,Ka]`，`owner` 都是 U1。
      - 「共享库的两级归属（本刀七条都 403）」：K=hex(1)（u1，all，ready），带 `UPLOAD_ROW` 一行文档。
        - peer 依次请求：GET 文档列表、POST retrieval（合法 body，参数与已存值不同）、DELETE 库、POST documents（`{workspaceId:"w1",paths:["a.md"]}`）、`DELETE …/documents?doc=doc-1`、`POST …/reingest?doc=doc-1`、`POST …/uploads?name=a.md`（`application/octet-stream`）。
        - 七次都是 403、信封都是 `FORBIDDEN`（`kb-settings-helpers.ts:42`）、都带 `cache-control: no-store`；`world.sent()` 为 `[]`。
        - 前后快照逐行相等：`SELECT * FROM knowledge_bases ORDER BY id`、`SELECT * FROM kb_documents ORDER BY id`、`SELECT * FROM audit_events ORDER BY id`。
        - 用例名注明「组 6、组 7 把前两次原地改为 200」。
      - 「403 先于 body」：peer 对 K 发以下请求都是 403：`raw("POST", …/documents, "{not json", "text/plain")`；`DELETE …/documents?doc=`；`POST …/retrieval` 带 16 KiB+1 的 body；`POST …/reingest` 带 `{}`；`POST …/uploads?name=a.md` 用 `text/plain`。owner 对这些请求得 400 的对照已有用例覆盖，不再写：`kb-retrieval-endpoint.test.ts:296-303`、`kb-ingest-workspace.test.ts:329`、`kb-documents-reingest.test.ts:569`。
      - 「不可见与不存在不可区分」：K 为 `me`，幽灵 id 为 `"e".repeat(32)`。上面七条路由与四个坏请求，peer 各对 K 和幽灵 id 发一次；两两比较：`statusCode` 都是 404；`body` 字符串全等且等于 `NOT_FOUND`；去掉 `date` 后的 `headers` 全等。零出站，三张表的快照不变。
      - 「列表的可见集合、次序与非自有的编译状态」：
        - 准备：先插 K3=hex(3)（u3，all，`BASE_ROW`，T0），再插 K1=hex(1)（u1，all，`COMPILE_ROW`，`dataset_id:"ds-k1"`，T0）和 K2=hex(2)（u1，me，T0-1）；peer `POST` 建 A2：`{name:"A2",template:"naive",raptor:true}`，得 201；带外插 B2=hex(5)（u2，`BASE_ROW`，`created_at` 为 A2 的 `createdAt` + 1）；然后 `world.forget()`。
        - 期望：peer 列表 id 为 `[A2,B2,K1,K3]`；`owned` 为 `[true,true,false,false]`；`owner` 为 `[U2,U2,U1,U3]`；`compile` 依次为 `{raptor:"pending",graph:"off"}`、`{raptor:"off",graph:"off"}`、`null`、`null`；`routes(world.sent())` 为 `["GET /api/v1/datasets/<A2 的 datasetId>/documents","GET /api/v1/datasets/<A2 的 datasetId>/ingestions"]`。实测与此不符时停下报告，不改期望。
      - 「只有一处可见判定」：写法照 `server-handshake-log.test.ts:465-471`，用 `readdirSync(server/src, {recursive:true})` 取全部 `.ts`；每个文件先删块注释 `/\/\*[\s\S]*?\*\//g` 和整行 `//` 注释；再取字面量 ``/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g``；SQL 字面量指匹配 `/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|WHERE)\b/` 的那些。命中文件集合（排序后）断言：`/\bscope(?:_group_id)?\b/` 恰为 `["kb/visibility.ts"]`（组 11 加写入 SQL 时原地扩）；`/\bproject_group_members\b/` 与 `/\bdepartment\b/` 都恰为 `["accounts/scope.ts","kb/visibility.ts"]`。
    - 允许的既有文件原地改动（只限这些）：
      - `kb-bases-list.test.ts:19-31` 改为十四键排序：`["compile","createdAt","documents","graph","id","name","owned","owner","raptor","retrieval","scope","state","stateMessage","template"]`；`:43` 的「十一键」改为「十四键」。
      - `kb-bases.test.ts:135` 标题改为十四键；`:141-153` 加 `owned:true, owner:{id:"u1",account:"zhangsan",department:"平台研发部"}, scope:{scope:"me",group:null}`；`:161` 的 `kb.create` detail 不改（组 11 加）。
      - `kb-bases-compile.test.ts:182-193` 加同样三键。
      - `kb-bases-helpers.ts:58-70` 的 `BaseBody` 加三键。
      - web `api-kb.ts`：`:23-24` 旁加 `const BASE_SCOPES = ["me","dept","group","all"] as const`，不导出；`:98-111` 的 `BaseView` 加三键，类型内联写，不另导出类型（knip）；`:212-224` 的 `BASE_KEYS` 加 `"owned","owner","scope"`；`:345-354` 旁加 `parseOwner`（恰 `id,account,department` 三键；`id`、`account` 为字符串，`department` 用 `isNullableString`）与 `parseScope`（恰 `scope,group` 两键；`scope` 在 `BASE_SCOPES` 里；`group` 为 `null` 或恰 `id,name` 两个字符串）；`:356-391` 的 `parseBaseView` 加三键；不校验「`scope` 为 group 当且仅当 `group` 非空」（先例 `api-kb.ts:345`：服务端 CHECK 是权威）。
      - `api-kb.test.ts:77-89` 的 `BASE` 加三键（与 u1 自有、`me` 同值）；`:212-226` 的 `malformed` 映射加 `owned:[1,"true",null]`、`owner:[null,"u1",[]]`、`scope:[null,"me",[]]`，注释写「内层形状的拒绝用例在 `api-kb-visibility.test.ts`」。
      - `api-kb-retrieval.test.ts:29-41` 的 `BASE` 加三键。
      - `center-kb-support.tsx:32-48` 的 `base()` 默认值加 `owned:true`、`owner:U1`、`scope:{scope:"me",group:null}`，注释改为十四键。
      - `ui-walk-center-kb.ts:46-58` 的 `BASE` 加同样三键。`ui-walk-chat-kb.ts:33-36` 与 `chat-kb-ref-support.tsx` 经展开或 `base()` 跟随，不改。
      - `smoke/kb.hurl:12-13` 注释的键表改为十四键，断言不改。
    - 新 web 测试 `web/test/api-kb-visibility.test.ts`（≤ 200 行）：视图取 `base()`（`center-kb-support.tsx`）；不复制 `api-kb-retrieval.test.ts:43-58` 的 `METHODS`，也不复制 `api-kb.test.ts:136` 的 `malformed`（jscpd）。
      - 通过（`listKnowledgeBases` 的 200 `{bases:[…]}`，`toStrictEqual`）：自有 me；`owned:false` 且 `owner.department:null` 加 G1；`dept`；`all`。
      - `createKnowledgeBase` 的 201：自有一例通过；`owner` 多一键一例 `requestFailed(201)`。
      - 拒绝（列表 200，`expectRequestFailure(…, 200)`）：`owner`：多键；缺 `id`、`account`、`department`；`id` 或 `account` 为 `1`、`null`；`department` 为 `1`、`true`、`{}`。`scope`：多键；缺 `scope`、`group`；`scope` 为 `"team"`、`""`、`"ME"`、`null`、`1`；`group` 为 `"g1"`、`1`、`[]`；`group` 多键；`group` 缺 `id`、`name`；`group.id` 或 `group.name` 为 `1`、`null`。
    - 行数（上限 800）：server 源码 `bases.ts` 296 → ≤ 340；`documents.ts` 675 → ≤ 680；`uploads.ts` 277 → ≤ 282；`retrieval.ts` 241 → ≤ 246；`index.ts` 194 → ≤ 200；`rest.ts` 308 → ≤ 312；`store.ts` 658 不增。server 测试 `kb-bases-list.test.ts` 145 → ≤ 150；`kb-bases.test.ts` 439 → ≤ 445；`kb-bases-compile.test.ts` 603 → ≤ 608；`kb-bases-helpers.ts` 182 → ≤ 186。web `api-kb.ts` 610 → ≤ 665；`api-kb.test.ts` 688 → ≤ 700；`api-kb-retrieval.test.ts` 327 → ≤ 333；`center-kb-support.tsx` 346 → ≤ 352；`ui-walk-center-kb.ts` 260 → ≤ 266。PR 预计超过 400 行，援引组 5 的 Width exception。
    - 非目标：`PUT …/scope` 及其 404 / 403；建库带 `scope` 与 `kb.create` detail（组 11）；放开读路由与 `readableBase` 的导出（组 6、组 7）；`session-search.ts` 与引用受理改用可见集合，删除 `store.listBases`（组 8）；任何 web 组件（组 9 起）；功能验收清单行（本刀对用户惰性，D12）；文档同步（组 14）。
    - 回归命令：`npm run test:focus --workspace server -- kb-visibility`（先红后绿）；`npm run test:focus --workspace server -- kb-visibility kb-bases kb-bases-list kb-bases-compile kb-documents kb-upload kb-ingest kb-retrieval-endpoint kb-compile-status kb-session-search prompt-knowledge-bases`；`npm run test:focus --workspace web -- api-kb center-kb chat-kb-ref`；`make lint`、`make typecheck`、`make anti-drift`（knip：`toBase`、`BaseAccess`、`createKbVisibility` 都有使用者；jscpd）、`make check`。ui-walk（先例：归档 `2026-11-13-s2c-kb-session/tasks.md:652`）：先 `npm run build --workspace web && npm run build --workspace server`，确认 `var/omp/omp` 存在，再用全新状态目录、清掉知识库环境变量（`env -u RAGFLOW_BASE_URL -u RAGFLOW_API_KEY_FILE`）以 CI 同款变量执行 `bash .github/scripts/ci-compiled-server.sh ui-walk`（脚本在 `:113` 跑 `make ui-walk`）；PR 附命令、退出码与两个 project 的计数，用完删掉状态目录。PR 标题与描述标注「多租户过滤：请求白盒审查」。

Suggested fixture level: expanded - 多租户过滤的唯一判定点（灰盒例外候选）、不可探测性、跨服务严格解析。
Minimal mergeable slice: atomic - 可见判定、两级归属、列表与 `BaseView`（含 web 解析器与 ui-walk 桩）合起来才是可独立验证的「谁能看见哪些库」，且跨服务契约要求同 PR；读面的放开（组 6、组 7）已经各自拆出。

## 6. 非所有者读文档列表（knowledge-bases「文档列表与状态」「知识库端点」读路由）

- [x] 6.1 核对 Context：`server/src/kb/documents.ts:256-268` 的 `viewOf`（无条件输出 `workspaceId` 与 `path`）、`:635` 的复核点与 `sourceChanged` 的计算路径
- [x] 6.2 测试先行：在 `kb-visibility.test.ts` 加「非所有者看不到来源」（三个 `null`、不对所有者工作空间做文件系统调用、无审计）；把「共享库的两级归属」里 `GET …/documents` 改为 200
- [x] 6.3 实现：`GET …/documents` 的钩子与 `documents.ts:635` 改用 `readableBase`；列表按 `owned` 分支，非所有者三键为 `null`、跳过 `sourceChanged` 的解析与 stat
  - 组 6 约定（#2032 fixture 审查补；6.2–6.3 照此实现与测试）：
    - 6.1 行号更正：`viewOf` 是 `documents.ts:257-270`，列表复核点是 `:636`（`list` 在 `:635`），`sourceChangedOf` 在 `:621-631`（`sources.stat` 在 `:626`）；tasks 头部「`api-kb.ts:419-420`」现为类型 `:135-136,140`、解析器 `:471-472,476`；头部 `documents.ts` 675 现为 676。
    - `bases.ts`：`readableBase`（`:91-98`）改为 `export`，`:91` 注释去掉「组 6 起」的预告；返回对象在 `assertOwned`（`:301-304`）旁加 `assertReadable(id: string, viewerId: string): void`，只调 `readableBase(visibility, id, viewerId)`，注释「读路由的归属判定（不可见 404，可见即放行），先于 body 解析」。不加别的入口，不改 `ownedBase`。
    - `rest.ts`：在 `:193-197` 的 `ownedBase` 钩子旁加 `readableBase: BasePreParsing`，调 `bases().assertReadable(...)`；只有 `GET …/documents`（`:246-248`）改用它，其余六条（含 `:288` 的检索测试，组 7 改）仍为 `ownedBase`。文件头 `:23-25` 改为「写路由不可见 404、可见非所有者 403；读路由 `GET …/documents` 不可见 404、可见即放行（`POST …/retrieval` 组 7 放开）」。
    - `documents.ts`：`:48` 导入加 `readableBase`；`list` 改为 `const { base, owned } = readableBase(visibility, id, actorId)`；所有者照旧 `viewOf(document, run, await sourceChangedOf(document, actorId))`；非所有者为 `{ ...viewOf(document, run, null), workspaceId: null, path: null }`，不调用 `sourceChangedOf`。`viewOf` 的签名与键序不改（`uploads.ts:210`、`documents.ts:435,517` 不动）；非所有者照常读本地行与 RAGFlow。文件头 `:26-32` 的「列表」段补一句：调用者不是所有者时三键为 `null`，不解析、不 stat。
    - PR 附 grep 证据：`grep -n "readableBase(" server/src` 恰为 `bases.ts` 的定义、`ownedBase` 体内一处、`assertReadable` 一处、`documents.ts` 的 `list` 一处；`grep -n "ownedBase(" server/src` 只比改前少 `documents.ts:636` 一处。写路由处理函数里的复核点若误降为读级会被钩子掩盖，测试抓不到，靠这条 grep 与白盒审查兜底。
    - 新用例「非所有者看不到来源」进 `kb-visibility.test.ts`，用 `useIngestWorlds()`（`kb-ingest-helpers.ts:127`），在文件顶部与 `useSettingsWorlds()` 并列登记（两者收尾互不相干，输出收集器可嵌套，见 `support/output-sentinel.ts:8-12`）：
      - `const world = await openIngest()`；`world.fw.world.db.prepare("UPDATE knowledge_bases SET scope = 'all' WHERE id = ?").run(world.baseId)`。
      - 工作空间来源：`const source = await ingestedRow(world, "docs/a.md", "one")`。本地上传：`const rf = world.fake.addDocument(world.datasetId, { name: "b.txt", content: "x", ingestionStatus: "COMPLETED", chunkCount: 7 })`，`const upload = world.store.addDocument({ kbId: world.baseId, ragflowDocumentId: rf, name: "b.txt", size: 1, source: "upload" })`。
      - 带外 `UPDATE kb_documents SET created_at = ? WHERE id = ?`：`source` 为 1000，`upload` 为 2000。之后 `world.write("docs/a.md", "one rewritten")`。
      - `const rootOf = vi.spyOn(world.fw.rest.app.workspaces.store, "rootOf")`。
      - u1：`send(world.fw.rest, "member", "GET", url)` 得 200，`documents` 按字面量 `toEqual`：`[{ id: source.id, name: "a.md", size: 3, source: "workspace", workspaceId: W1, path: "docs/a.md", status: "unparsed", chunkCount: null, message: null, sourceChanged: true, createdAt: 1000 }, { id: upload.id, name: "b.txt", size: 1, source: "upload", workspaceId: null, path: null, status: "done", chunkCount: 7, message: null, sourceChanged: null, createdAt: 2000 }]`（`unparsed` 照 `kb-documents-list.test.ts:407-444` 的实测）。`expect(rootOf).toHaveBeenCalledWith({ id: "u1" }, W1)`（阳性对照，证明 spy 接在真实路径上）。
      - `rootOf.mockClear()`；记 `auditRows(world.fw.world).length`，并断言它大于 0（入库已写 `kb.ingest`，防空过）。
      - u2：`const cookie = await cookieFor(world.fw.rest.app, "zhaoliu")`，`world.fw.rest.app.inject({ method: "GET", url, headers: { cookie } })` 得 200、`cache-control: no-store`；`documents` 为上面两条把 `workspaceId`、`path`、`sourceChanged` 都换成 `null`（字面量写出，`source` 依次 `workspace`、`upload`，`status` 与 `chunkCount` 同 u1）。`expect(rootOf).not.toHaveBeenCalled()`；审计行数不变。
      - 实测与这些字面量不符时停下报告，不改期望。
    - 既有用例原地改（只限这些）：
      - `:8` 文件头改为「`GET …/documents` 已由组 6 放开；`POST …/retrieval` 由组 7 原地改为 200」。
      - `:237`：u3 请求 `KA` 的文档列表改为 200，`json()` 为 `{ documents: [] }`（`ds-4` 不在假 RAGFlow，按 not-found 读成空表）。
      - `:256`：u2 请求 `KG` 改为 200；`:261` 删成员后的 404 不变。
      - `:312-316`：标题改为「…检索测试与五条写路由 403、文档列表 200，零写入（组 7 把检索测试原地改为 200）」。`VALID` 本身不拆，`:329` 照旧遍历全部七条。先 `await expectAllForbidden(world, VALID.slice(1), id)`，再由 peer 请求 `GET …/${id}/documents`，得 200、`no-store`、`{ documents: [{ id: "doc-1", name: "a.txt", size: 3, source: "upload", workspaceId: null, path: null, status: "missing", chunkCount: null, message: null, sourceChanged: null, createdAt: T0 }] }`；`routes(world.sent())` 为 `["GET /api/v1/datasets/ds-1/documents"]`；三张表的快照不变。
      - 「列表的可见集合、次序与非自有的编译状态」（#2048 的 P2）：在 `:366` 之后、`:368` 的 `forget()` 之前加 `addBase(world, 0, { owner_id: "u3", scope: "all", created_at: T0 + 1 })`；期望改为 id `[a2.id, hex(5), hex(1), hex(3), hex(0)]`，`owned` `[true, true, false, false, false]`，`owner` `[U2, U2, U1, U3, U3]`，`compile` 末尾再加一个 `null`；`routes` 不变。只按 id 排序的实现会让 `hex(0)` 排在非自有第一位，从而变红。
    - `kb-documents-list.test.ts` 不改（「别人的库」那个用例是 `me` 档，仍为 404）；所有者视图的既有用例原样全绿。
    - 行数（上限 800）：`documents.ts` 676 → ≤ 690；`bases.ts` 315 → ≤ 325；`rest.ts` 308 → ≤ 318；`kb-visibility.test.ts` 384 → ≤ 500（实测 497：约定要求的字面量逐字写出）。
    - 非目标：`POST …/retrieval` 与 `retrieval.ts`（组 7）；web 解析器与组件（`DocumentView` 已可为 null，组 9 呈现）；功能验收清单行（D12，对用户惰性）；`smoke/`。
    - 回归命令：`npm run test:focus --workspace server -- kb-visibility`（先红后绿）；`npm run test:focus --workspace server -- kb-visibility kb-documents-list kb-documents kb-bases kb-upload kb-ingest kb-retrieval-endpoint`；`make lint`、`make typecheck`、`make anti-drift`（knip：`readableBase`、`assertReadable` 都有使用者）、`make check`。

Suggested fixture level: expanded - 隐私不变量（所有者沙箱路径），放开读路由与置空必须原子。
Minimal mergeable slice: atomic - 放开 `GET …/documents` 与非所有者置空必须同时合入，否则中间态把所有者路径交给非所有者。

## 7. 共享检索审计与检索测试对非所有者开放（knowledge-bases「检索测试端点」「知识库审计」`kb.shared_retrieval`）

- [x] 7.1 核对 Context：`kb/retrieval.ts:184-240`（`readyBase`、参数比较、写锁、写回与审计）；`core/audit` 的 `emit` 与失败传播；`server/test/kb-retrieval-endpoint.test.ts`（443 行）
- [x] 7.2 测试先行：新文件 `server/test/kb-retrieval-shared.test.ts` 覆盖「非所有者按已存参数检索」「非所有者的 body 仍须合规」「共享审计写失败不检索」；「同一知识库的写操作串行」里「非所有者的检索测试从不取锁」；把「共享库的两级归属」里 `POST …/retrieval` 改为 200
- [x] 7.3 实现新文件 `server/src/kb/shared-audit.ts`（design D6，只在非所有者时写，detail 取判定时读到的行）；`retrieval.ts` 的非所有者分支跳过比较与写锁、检索前调用它；`POST …/retrieval` 的钩子与复核点改用 `readableBase`
  - 组 7 约定（#2033 fixture 审查补；7.2–7.3 照此实现与测试）：
    - 7.1 行号更正：`readyBase` 是 `retrieval.ts:181-191`（`ownedBase` 在 `:186`），被 `saveLocked`（`:197-215`，调用在 `:198`）与 `test`（`:229-238`，调用在 `:231`）调用；`writeBack` 是 `:217-225`；检索路由的钩子是 `rest.ts:293`；`kb-retrieval-endpoint.test.ts` 443 行，已核实。
    - 新文件 `server/src/kb/shared-audit.ts`（≤ 45 行）：
      - `export interface SharedRetrievalEvent { kind: "kb.shared_retrieval"; actorId: string; title: string; detail: { id: string; name: string; ownerId: string; scope: { scope: BaseAccess["scope"]["scope"]; groupId: string | null } } }`。
      - `export function auditSharedRetrieval(deps: { audit: (event: SharedRetrievalEvent) => void }, viewerId: string, access: BaseAccess): void`：`access.owned` 为真时直接返回。否则调用一次 `deps.audit`：`kind`、`actorId: viewerId`、`title: "检索共享知识库"`；detail 键序为 `{ id: access.base.id, name: access.base.name, ownerId: access.owner.id, scope: { scope: access.scope.scope, groupId: access.scope.group?.id ?? null } }`；不传 `workspaceId`，`emit` 写成 null。
      - 不重读库：detail 只取调用方首判得到的 `access`。不开事务（「单独写入」），不吞错：写失败原样抛出，由调用方决定。检索测试照常传播，结果为通用 500；会话检索在组 8 里捕获，记为该库 `failed`。组 8 原样复用这个函数，在 `createKbSessionSearch` 的依赖里加 `audit` 并在 `index.ts:198` 接线，这些是组 8 的事。
    - `retrieval.ts`：
      - `readyBase` 原地改为 `function ready(access: BaseAccess): BaseAccess`，只判 `state !== "ready"` 就抛 409 `kb_rebuilding`。
      - `saveLocked` 改为 `const { base } = ready(ownedBase(visibility, id, ownerId))`：锁内写回仍为写级。
      - `test(id, body, viewerId)`：`parseTest(body)`，然后 `const access = ready(readableBase(visibility, id, viewerId))`，然后 `const used = !access.owned || sameParameters(access.base, request) ? access.base : await writeBack(id, request, viewerId)`，然后 `auditSharedRetrieval(dependencies, viewerId, access)`，最后 `retrieveForBase(dependencies, used, …)`。次序与规格一致：归属（钩子）→ body → state → 所有者比较 → 共享审计 → 检索。
      - 无条件调用、由函数内部判 `owned`：「自有库不写」只在一处成立，所有者的既有用例也覆盖到那条返回分支。非所有者不进 `writeBack`。
      - `KbRetrievalDependencies.audit` 改为 `(event: AuditEvent | SharedRetrievalEvent) => void`，`index.ts` 不改。
      - 文件头 `:17-21` 与 `:228` 改为「判定次序 body → 可读重读 → `state`；所有者比较参数、必要时取锁写回；非所有者跳过比较与锁，按已存值检索，检索前写 `kb.shared_retrieval`；对自己的库检索不审计」。
    - `rest.ts`：`:293` 的 `preParsing: ownedBase` 改为 `readableBase`。文件头 `:23-26` 改为「读路由 `GET …/documents`、`POST …/retrieval` 不可见 404、可见即放行」；`:37-38` 补一句「非所有者按已存参数检索并审计」。
    - PR 附 grep 证据：`grep -n "readableBase(" server/src` 比改前多一处，恰为 `retrieval.ts` 的 `test`；`grep -n "ownedBase(" server/src` 条数不变（10 条），其中 `retrieval.ts` 那一处在 `saveLocked`；`grep -n "preParsing: ownedBase" server/src/kb/rest.ts` 从 6 条变为 5 条，`preParsing: readableBase` 恰 2 条（文档列表、检索测试）。
    - 新测试文件 `server/test/kb-retrieval-shared.test.ts`（≤ 340 行）：
      - 夹具与身份：`useIngestWorlds()`。库为 u1 的 `world.baseId`，名称 `` `库 ${world.baseId}` ``。每个用例先带外执行 `UPDATE knowledge_bases SET scope='dept', retrieval_threshold=0.35, retrieval_vector_weight=0.5 WHERE id=?` 与 `UPDATE accounts SET department='平台研发部' WHERE id='u2'`。检索者是 u2：`cookieFor(world.fw.rest.app, "zhaoliu")`（`session-rest-helpers.ts:221`）加 `world.fw.rest.app.inject`，同组 6 的写法。不复制 `kb-retrieval-endpoint.test.ts:62-93` 的 `retrievals`、`storedOf`、`expectAnswer`（jscpd），行读取与请求过滤就地内联写。
      - 「非所有者按已存参数检索」：u2 以 `{question:"销售额", threshold:0.1, vectorWeight:0.9}` 检索，得 200、`no-store`，body 为 `{hits:[], retrieval:{threshold:0.35, vectorWeight:0.5}}`；假 RAGFlow 恰收到一次 `POST /api/v1/retrieval`，body 带 `similarity_threshold:0.35`、`vector_similarity_weight:0.5`；两列与 `updated_at` 逐值等于检索前；`world.audits("kb.retrieval_settings")` 为 `[]`；`world.audits("kb.shared_retrieval")` 为 `[{actorId:"u2", title:"检索共享知识库", detail:{id:world.baseId, name:`库 ${world.baseId}`, ownerId:"u1", scope:{scope:"dept", groupId:null}}, workspaceId:null}]`。另一例：把库改为 `scope='group', scope_group_id='g1'`，detail 的 `scope` 为 `{scope:"group", groupId:"g1"}`。
      - 时点：`const gate = world.fake.fault("POST /api/v1/retrieval", {kind:"hold"})`，发请求后 `await gate.reached`，此时共享审计已恰一条，然后 `gate.release()`，应答 200。另一例用 `fault(…, {kind:"status", status:503})`：应答 503 `kb_unavailable`，共享审计仍恰一条。
      - 「非所有者的 body 仍须合规」：`threshold:1.5` 得 400 `bad_request`；以 `padded(16*1024+1, …)`（`mounts-rest-helpers.ts`）的超限 body 得 400；`setState("rebuild_failed")` 与 `setState("rebuilding")` 带合法 body 都得 409 `kb_rebuilding`；`rebuilding` 带坏 body 得 400（body 先于 state）。每次 `world.lines()` 为 `[]`，`audit_events` 总行数不变。
      - 「共享审计写失败不检索」：`world.fw.world.db.exec("CREATE TRIGGER refuse_shared BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.shared_retrieval' BEGIN SELECT RAISE(ABORT, 'injected'); END")`（先例 `kb-retrieval-endpoint.test.ts:39`）。合法 body 得 500，`response.body` 恰为 `JSON.stringify({error:{message:"服务器内部错误"}})`；`world.lines()` 为 `[]`；审计总行数不变；两列与 `updated_at` 不变。
      - 「非所有者的检索测试从不取锁」（规格只在「同一知识库的写操作串行」正文里有这句，没有单列场景，这里补上）：参数必须与已存值不同，否则所有者的快路径也会绿。`holdWriteLock(world, "rebuild")`（`kb-upload-helpers.ts:170`）期间，u2 以 `{0.1, 0.9}` 检索得 200，`retrieval` 为 `{0.35, 0.5}`；`holdWriteLock(world)`（写者）期间同一请求不等待即 200；两次都断言 `world.locks.writeWaiters(world.baseId)` 为 0，然后 `await release()`。
      - 所有者对共享库：u1（`send(world.fw.rest, "member", …)`）对同一个 `dept` 库，以 `{0.35, 0.5}` 检索时零审计；以 `{0.1, 0.9}` 检索时恰一条 `kb.retrieval_settings`。`kb.shared_retrieval` 为 `[]`。
      - 实测与这些字面量不符时停下报告，不改期望。
    - 既有用例原地改（只限这些）：
      - `kb-visibility.test.ts:8` 文件头改为「`GET …/documents` 与 `POST …/retrieval` 已由组 6、组 7 放开」。
      - `kb-visibility.test.ts:317-343`「共享库的两级归属」：标题改为「…五条写路由 403、文档列表与检索测试 200，写路由零写入」；`sharedWorld` 之后执行 `const ds = world.fake.addDataset(); world.db.prepare("UPDATE knowledge_bases SET dataset_id = ? WHERE id = ?").run(ds, id)`（`ds-1` 不在假 RAGFlow，检索会是 503：`fake-ragflow-retrieval.mjs:184-185` → `ragflow-client.ts:469`）；改为 `expectAllForbidden(world, VALID.slice(2), id)`；之后 peer 先发文档列表（期望同前，只把路由改为 `ds`），再发 `VALID[1]` 的检索，得 200、`no-store`，body 为 `{hits:[], retrieval:{threshold:0.2, vectorWeight:0.7}}`；`routes(world.sent())` 为 `` [`GET /api/v1/datasets/${ds}/documents`, "POST /api/v1/retrieval"] ``，第二条的 `json` 带 `similarity_threshold:0.2`、`vector_similarity_weight:0.7`；`knowledge_bases`、`kb_documents` 的快照不变；`audit_events` 恰比之前多一行：`kind:"kb.shared_retrieval"`、`actor_id:"u2"`，`detail` 逐字为 `{"id":"<hex(1)>","name":"库 1","ownerId":"u1","scope":{"scope":"all","groupId":null}}`。
      - `kb-visibility.test.ts:345-349`「403 先于 body」：改为 `expectAllForbidden(world, MALFORMED.filter(([name]) => name !== "POST 检索测试 16 KiB+1"), id)`。标题注明「检索测试是读路由，可见非所有者的超限 body 为 400，见 `kb-retrieval-shared.test.ts`」。`MALFORMED` 本身不拆，`:356` 照旧遍历全部，仍是 404。
      - `kb-retrieval-endpoint.test.ts`、`http-parser-owners.test.ts`、`kb-disabled.test.ts` 不改，原样全绿（`:324` 的「别人的 id」是 `me` 档，仍为 404）。
    - TDD 配对：`shared-audit.ts` 没有同名测试。PR 写明它的配对是 `kb-retrieval-shared.test.ts`（组 8 的 `kb-shared-audit.test.ts` 再覆盖会话一侧）。
    - 行数（上限 800）：`retrieval.ts` 240 → ≤ 262；`shared-audit.ts` 新增 ≤ 45；`rest.ts` 313 → ≤ 316；`kb-visibility.test.ts` 497 → ≤ 520（放宽组 6 定的 ≤ 500）；`kb-retrieval-shared.test.ts` 新增 ≤ 340。`bases.ts`、`index.ts`、`documents.ts` 不改。
    - 非目标：会话检索的共享审计与 `index.ts:198` 接线、「共享检索审计不含问句」的哨兵与 `GET /api/audit` 可见性（组 8）；web 检索面板只读（组 9）；功能验收清单行（D12，对用户惰性）；`smoke/`。
    - 回归命令：`npm run test:focus --workspace server -- kb-retrieval-shared`（先红后绿）；`npm run test:focus --workspace server -- kb-retrieval-shared kb-retrieval-endpoint kb-retrieval kb-visibility kb-session-search http-parser-owners kb-disabled`；`make lint`、`make typecheck`、`make anti-drift`（knip：`SharedRetrievalEvent`、`auditSharedRetrieval` 都有使用者；jscpd），`make check`。

Suggested fixture level: expanded - 审计时点与失败语义、不变量 1（非所有者不写回）。
Minimal mergeable slice: atomic - 放开检索测试与写共享审计必须同时合入，否则中间态出现未审计的跨账号检索。

## 8. 会话检索与知识库引用的可见集合（knowledge-bases「会话检索 `kb_search`」；message-attachments「prompt 引用知识库」的可见受理）

- [x] 8.1 核对 Context：`server/src/kb/session-search.ts` 的文件头契约（:6「三个函数都经 `listBases(ownerId)` 读一次」）、`ownedBases`（:134，被 `execute` 与 `resolveReferences` 共用）、`definitionFor`、`execute`；`server/src/app.ts:351` 的注入与 `sessions/store-knowledge-bases.ts:18` 的注释
- [x] 8.2 测试先行：在 `kb-session-search.test.ts` 加「可见的共享库进清单并被检索」「只有共享库的账号」「共享审计写失败只影响该库」「已中止的信号不写共享审计」；新文件 `server/test/kb-shared-audit.test.ts` 完整覆盖「共享检索审计不含问句」（检索测试与 `kb_search` 合计恰两条；u1 经 `GET /api/audit` 看不到、u3 看得到）；新文件 `server/test/prompt-knowledge-bases-shared.test.ts` 覆盖「引用共享给自己的库」
- [x] 8.3 实现：三个函数共用一次 `visibleBases(viewer)`，原地替换 `ownedBases`（文件头契约同改）；可见的库一个都没有时没有定义；非自有库描述行附所有者账号；非自有 `ready` 库先查中止信号、再调 `auditSharedRetrieval`、再检索；`resolveReferences` 存受理那一刻的名称；`store.listBases`（`kb/store.ts:158,322-323`）此后若只剩测试在用，在本组内删除它与 `SELECT_BASES_BY_OWNER` 及其用例（AGENTS.md：无引用导出同一变更内删除）
  - 组 8 约定（#2034 fixture 审查补；8.2–8.3 照此实现与测试）：
    - 8.1 行号更正：`store.listBases` 是 `kb/store.ts:158`（SQL）与 `:322-324`（含注释行）；`session-search.ts` 依赖接口是 `:41-43`，`ownedBases` 是 `:134-135`，`searchOne` 是 `:137-153`，`definitionFor` 是 `:157-173`（`:158` 是第二处读取），`execute` 是 `:176-190`（`:181` 读取，`:186` 是 render 取 state 的地方），`resolveReferences` 是 `:193-204`；`app.ts:351` 只核对、不改（`ownerId` 就是会话所有者，也就是查看者）；`store-knowledge-bases.ts` 的注释是 `:17-20` 和 `:35`。
    - 与 8.2 的差异（审查裁定）：
      - 四个 `kb_search` 场景按 8.2 原地加进 `kb-session-search.test.ts`。组 3 定的 ≤ 480 是给本组留的余量，硬上限是 800；这个文件不在 tasks 头部的冻结名单里。
      - 「引用共享给自己的库」原地加进 `prompt-knowledge-bases.test.ts`，不新建 `prompt-knowledge-bases-shared.test.ts`。理由：`openKbWorld`（`:66-95`）和 K1/K3 常量都是这个文件的局部定义；新建文件就得复制世界的搭法（jscpd 会报），或者为一个场景再抽一层 helper。AC 里的过滤串 `prompt-knowledge-bases` 已经能覆盖到它。PR 描述里写明这一条。
    - 新 helper `server/test/kb-session-search-helpers.ts`（≤ 100 行）：把 `kb-session-search.test.ts` 里的以下内容原样搬过去，原文件改成导入（不留两份）：`ROUTE`（`:20`）、`SessionSearch` 类型（`:38`）、`retrievals`（`:122-123`）；`:40-57` 的 spy 与取值，改成 `export function useSessionSearch(): () => SessionSearch`，在调用它的文件里登记 beforeEach/afterEach；`BaseSeed` 与 `seedBase`（`:59-95`）；新加 `export function share(world, id, scope: "me" | "group" | "all")`，执行 `UPDATE knowledge_bases SET scope = ?, scope_group_id = ? WHERE id = ?`，`scope` 为 `group` 时组 id 用 `'g1'`，否则用 NULL（053:64 的种子里 g1 的成员是 u1、u2）。
    - `session-search.ts`（原地改，206 → ≤ 225）：
      - 依赖接口：删掉 `store` 上额外的 `& Pick<…, "listBases">`；新增 `visibility: Pick<ReturnType<typeof createKbVisibility>, "visibleBases">` 和 `audit: (event: SharedRetrievalEvent) => void`；删掉 `import type { createKbStore }`（若不再使用）。
      - 用 `const visibleOf = (viewerId) => new Map(visibility.visibleBases(viewerId).map((access) => [access.base.id, access]))` 原地替换 `ownedBases`。三个函数各调用一次读取；`definitionFor` 遍历 `visibility.visibleBases(viewerId)` 的结果（SQL 的 D2 次序：自有在前，再按 `created_at`、`id`），JS 里不排序。
      - `definitionFor`：结果为空时返回 `null`；描述行自有库为 `- ${name}（${id}）`，非自有库为 `- ${name}（${id}，所有者 ${owner.account}）`；`bases` 仍为 `[{id, name}]`、次序相同。
      - `:24` 改为「检索当前账号可见的知识库（含共享给它的），返回…」，其余三行不变。现有用例只检查关键词，不受影响。
      - `searchOne(kbId, access: BaseAccess | undefined, viewerId, question, signal)` 的判定次序：1. `undefined` → `not_found`；2. 非 `ready` → `not_ready`；3. `if (!access.owned && signal.aborted) return failed`；4. `try { auditSharedRetrieval(dependencies, viewerId, access) } catch { return failed }`，无条件调用，`owned` 时由这个函数自己返回（同组 7）；5. `retrieveForBase(...)`。第 3、4 步都在第一个 `await` 之前。catch 里不记日志、不重抛。自有库的路径不变。`outcome` 取 `access?.base`。
      - `execute`：`render(entry, visible.get(entry.kbId)?.base.state)`，用的是同一份 `visible`（组 3 约定的那一处跟着换）。
      - `resolveReferences`：只用一次 `visibleOf`，按输入次序给出 `{id, name: access.base.name}`。
      - 文件头 `:6-9` 改为：「可见的库」只有一份读取（`visibleBases(viewerId)`，D2 次序）；不可见与不存在同为 `not_found`；可见、`ready` 的非自有库先查中止信号，再写 `kb.shared_retrieval`（`shared-audit.ts`），写失败该库为 `failed`、不检索；对自己的库检索不审计；不写回。
    - 装配：`kb/index.ts:198` 改为 `createKbSessionSearch({ store, client, onRerankDegraded, visibility, audit })`（用的是 `:119` 和 `:122` 已经建好的那两份）。`index.ts` 200 → ≤ 208（格式化可能把调用折成多行）。
    - 注释同步：`store-knowledge-bases.ts:18-19` 与 `:35` 里的 "one of that account's bases" / "not this account's base" 改成 "visible to that account"；`sessions/host-tool-align.ts:29` 的 "(knowledge base off or no base)" 改成 "no visible base"。
    - 删除：`kb/store.ts:158` 的 `SELECT_BASES_BY_OWNER`、`:322-324` 的 `listBases` 及其注释、`kb-store.test.ts:194-205` 的「按 owner 列出」用例。`BASE_ORDER` 保留。PR 附 grep 证据：`grep -rn "listBases\b\|SELECT_BASES_BY_OWNER" server/src server/test` 为空。
    - `kb-session-search.test.ts` 新加四个场景（479 → ≤ 600；文件头加一句「#2034 s2c-kb-visibility 组 8：可见集合与共享审计」）。A2 = `"f6".repeat(16)`，名称「销售手册」，`ownerId:"u2"`，`createdAt: 2_500`。审计用 `world.audits("kb.shared_retrieval")` 读。
      - 「可见的共享库进清单并被检索」：在 `seeded()` 之后 `share(world, K1, "group")`，再种 A2。`definitionFor("u2")` 描述里以 `- ` 开头的行恰为 `[`- 销售手册（${A2}）`, `- 产品文档（${K1}，所有者 zhangsan）`]`，`bases` 为 `[{id:A2,name:"销售手册"},{id:K1,name:"产品文档"}]`。`fault(ROUTE,{kind:"hold"},{times:2})` 之后以 u2 执行 `{question:QUESTION, kb_ids:[K1, A2, K2]}`；`await gate.reached` 时共享审计已恰 1 条；再 poll 到 2 次检索，然后 release。结果 `toStrictEqual`：text 为 `知识库「产品文档」（K1）：命中 0 条`、`知识库「销售手册」（A2）：命中 0 条`、`知识库 ${K2}：未找到该知识库` 三段，以空行隔开；details 依次为 ok/ok/`{kbId:K2,name:null,status:"not_found",hits:[]}`；`isError:false`。两次检索的 `dataset_ids` 为 d1 与 A2 的数据集（`arrayContaining`）；K1 那次带 0.35/0.5。共享审计恰为 `[{actorId:"u2",title:"检索共享知识库",detail:{id:K1,name:"产品文档",ownerId:"u1",scope:{scope:"group",groupId:"g1"}},workspaceId:null}]`。接着 `share(world, K1, "me")`，以同样参数再执行一次：K1 为 `not_found`；共享审计仍为 1 条；`definitionFor("u2").bases` 为 `[{id:A2,…}]`。
      - 「只有共享库的账号」：`seeded()` 之后 `share(world, K1, "all")`。`definitionFor("u2")` 以 `- ` 开头的行恰为 `[`- 产品文档（${K1}，所有者 zhangsan）`]`，`bases` 为 `[{id:K1,name:"产品文档"}]`。`share(world, K1, "me")` 之后返回 `null`。`world.fake.requests()` 为 `[]`。
      - 「共享审计写失败只影响该库」：`share(K1,"all")`，种 A2，再执行组 7 的触发器（`kb-retrieval-shared.test.ts:26-27` 的 `REFUSE_SHARED`，写成本地常量）。u2 以 `[K1, A2]` 执行，`toStrictEqual`：text 为 `知识库「产品文档」（K1）：检索失败` 与 `知识库「销售手册」（A2）：命中 0 条`；details 为 `failed` 与 `ok`；`isError:false`。`retrievals` 的 `dataset_ids` 恰为 `[[A2 的数据集]]`；`auditCount` 不变；`world.logged` 不变。
      - 「已中止的信号不写共享审计」：`share(K1,"all")`，`controller.abort()` 之后再以 u2 执行 `[K1]`。`toStrictEqual({text:`知识库「产品文档」（K1）：检索失败`, details:{bases:[{kbId:K1,name:"产品文档",status:"failed",hits:[]}]}, isError:true})`。共享审计为 `[]`（这条才是区分用的断言）；`world.fake.requests()` 为 `[]`。
    - 新文件 `server/test/kb-shared-audit.test.ts`（≤ 170 行）：
      - 夹具：`useIngestWorlds()` 加 `useSessionSearch()`；K = `world.baseId`（u1，名称 `` `库 ${K}` ``），`share(world, K, "group")`；种 A2（u2）。问句 `Q = `销售额 ${CONTENT_SENTINEL}``，这样收尾时的 stdout/stderr 哨兵检查自动生效。
      - 检索测试：u2 用 `cookieFor(world.fw.rest.app, "zhaoliu")` 发 `POST /api/kb/bases/K/retrieval`，body 为 `{question:Q, threshold:0.2, vectorWeight:0.7}`，得 200。会话检索：`search().execute("u2", {question:Q, kb_ids:[K, A2]}, signal)`，`isError:false`。
      - 审计行：`SELECT actor_id, kind, title, detail, workspace_id FROM audit_events WHERE kind='kb.shared_retrieval' ORDER BY id` 恰两行，两行相同：actor `u2`、title `检索共享知识库`、workspace NULL，detail 原始串逐字为 `{"id":"<K>","name":"库 <K>","ownerId":"u1","scope":{"scope":"group","groupId":"g1"}}`。没有 detail.id 为 A2 的审计。
      - 哨兵：`JSON.stringify(SELECT * FROM audit_events)` 不含 `CONTENT_SENTINEL`；`JSON.stringify(world.logged)` 也不含。
      - `GET /api/audit?limit=200`：u1 用 `send(world.fw.rest,"member","GET",…)`，events 里没有 `kb.shared_retrieval`；u3 用 `"admin"`，u2 用 cookie，各自恰两条 `kb.shared_retrieval`，`actorId` 都是 `u2`，detail 同上；三份 body 都不含哨兵，都带 `cache-control: no-store`。依据：`accounts/index.ts:14`、`core/audit/index.ts:81-84`（非管理员按 actor 过滤）。若 `send` 不透传查询串或假 RAGFlow 进程会把请求打到 stdout，改用本地哨兵在数据库与 API 上逐项断言，并在偏离里写明。
    - `prompt-knowledge-bases.test.ts` 原地加 `describe("prompt 引用知识库: 引用共享给自己的库 (#2034)")`（484 → ≤ 530）：`openKbWorld()` 之后带外 `UPDATE knowledge_bases SET scope='all' WHERE id=K1`，K3 仍为 me（即规格里的 P）。u2 = `cookieFor(world.app,"zhaoliu")`，会话用 `openBound(world.app, u2, "proj").session()`（先例 `session-prompt-attachments.test.ts:385-387`）。`send(world, s, {message:"查一下", knowledgeBases:[K1]}, u2)` 得 202，`calls` 1 次，`audit` 为 `[]`；`columnOf` 的用户行 `knowledge_bases` 为 `[{"id":"<K1>","name":"产品文档"}]`。以 `[K3]` 和 `[K9]` 分别 `send(…, u2)`：都是 404 `NOT_FOUND_ENVELOPE`，两个 `response.body` 全等，没有新增行。然后 `UPDATE … SET scope='me' WHERE id=K1`，用 `getSessionMessages(world.app, s, u2)` 读快照：那条用户消息的 `knowledgeBases` 为 `[{id:K1,name:"产品文档"}]`。全程 `world.ragflow()` 不变。
    - 行数汇总：`session-search.ts` ≤ 225；`index.ts` ≤ 208；`store.ts` 658 → ≤ 654；`store-knowledge-bases.ts` 145 不增；`kb-session-search.test.ts` ≤ 600；`kb-session-search-helpers.ts` ≤ 100；`kb-shared-audit.test.ts` ≤ 170；`prompt-knowledge-bases.test.ts` ≤ 530；`kb-store.test.ts` 711 → ≤ 700。
    - TDD 配对：`session-search.ts` 的配对是 `kb-session-search.test.ts` 加 `kb-shared-audit.test.ts`。
    - 非目标：`docs/architecture/knowledge-base.md:410`（「`session-search.ts:134-135` 只读 `listBases`」，留给组 14 同步）；`kb-visibility.test.ts:364` 的标题措辞；web 选择列表（组 10）；`PUT …/scope`（组 11，所以这里收回共享用带外 UPDATE）；功能验收清单（D12）；`app.ts`。
    - 实测与上面这些字面量不符时停下来报告，不改期望。
    - 回归命令：`npm run test:focus --workspace server -- kb-session-search kb-shared-audit`（先红后绿）；`npm run test:focus --workspace server -- kb-session-search kb-shared-audit prompt-knowledge-bases session-host-tool-align kb-store kb-retrieval-shared kb-visibility session-kb-hits session-kb-search-approval omp-host-tools`；`make lint`、`make typecheck`、`make anti-drift`（knip：`listBases` 删掉之后不留无引用导出，helper 的导出都有使用者；jscpd），最后 `make check`。

Suggested fixture level: expanded - 给模型的工具描述、跨账号审计、不可探测性、引用受理的权限判定。
Minimal mergeable slice: atomic - 定义、执行与引用解析共用同一次可见集合读取（Code Canonicality：不得让同一文件里新旧两份读取并存），验证路径是同一组 `createKbSessionSearch` 与 prompt 路由用例。

## 9. web：共享库的只读呈现（knowledge-bases「中心「知识库」tab」非所有者部分）

- [x] 9.1 核对 Context：`web/src/features/center/kb/` 的 `list.tsx`、`detail.tsx`、`documents-table.tsx`、`retrieval-panel.tsx`；`web/test/center-kb-list.test.tsx`（356）、`center-kb-detail.test.tsx`（443）；demo :3240-3262、:2781-2803
- [x] 9.2 测试先行：新文件 `web/test/center-kb-shared.test.tsx` 覆盖「共享库的只读呈现」「所有者没有部门」、列表计数行、四档范围标签文案、自有库与共享库的按钮差异、共享库检索测试两个数字只读
- [x] 9.3 实现：按 `owned` 分支渲染；共享库的来源列为 `工作空间` / `本地上传`；编译只显示标签；自有库的范围标签本刀为纯文本（组 12 改为按钮）
  - 组 9 约定（#2035 fixture 审查补；9.2–9.3 照此实现与测试）：
    - 9.1 行号核实：`list.tsx` 159 行（`HEADERS` :14，`CompileCell` :74-95，`删除知识库` :139-151）；`detail.tsx` 131 行（标题 :54-61，入库工具条 :62-78，文档表 :87-101，检索测试 :102-109）；`documents-table.tsx` 113 行（`HEADERS` :7，`sourceText` :27-32，操作列 :78-106）；`retrieval-panel.tsx` 127 行（数字框 :60-73，`UnitField` :79-106）；`center-kb-list.test.tsx` 356、`center-kb-detail.test.tsx` 443、`center-kb-retrieval.test.tsx` 647（头部冻结，本组不碰）。demo：计数行 :3244、`只读` :3249、`来自` :3250、只读提示 :2803。
    - 文案逐字（spec.md:440-442、:462、:465、:476）：
      - 计数行 `我的 <owned 数> 个 · 共享给我 <非 owned 数> 个`，用一个模板串（单个文本节点）。
      - 范围：`me` → `仅自己可见`，`dept` → `本部门可见`，`group` → `项目组可见 · <scope.group.name>`，`all` → `全员可见`。`group` 档而 `group` 为 null 在输入域外（053 CHECK），渲染 `项目组可见`，不写用例。
      - `只读`；`来自 <owner.account> · <owner.department>`，部门为 null 时 `来自 <owner.account>`。
      - 只读提示 `共享给你的知识库只读：可检索、可在会话中引用，不能增删文档。需要补充内容请联系 <owner.account>。`。
      - 来源列 `工作空间` / `本地上传`。
      - demo 的 `title` 悬停文案（:3249、:3254）是非目标。
    - `list.tsx`（159 → ≤ 220）：
      - 计数行：`KnowledgeBaseList` 在表格之上渲染 `<p className="ui-muted">`，由 `bases` 现算（删库、建库后跟着变，不另取）。没有知识库时只有空态 `还没有知识库`，没有计数行；`embeddingReady:false` 有库时照常显示。计数行不放 `panel.tsx`（PR 边界）。
      - `HEADERS` 改为 `["名称","模板","编译","文档","状态","范围","操作"]`（按 spec.md:439 的次序，范围在标记之后）。
      - 新导出 `ScopeLabel({ scope })`：纯文本 `<span className={TAG}>`，自有库与共享库同用。四档文案只在此一处（组 12 的按钮与对话框从这里取，不另写一份）。
      - 名称格：自有库只有 `base.name`。共享库为名称加 `<span className={TAG}>只读</span>`，下一行 `<p>`（`text-xs text-muted-foreground`）写 `来自 …`；两者各自独立成元素，`getByText(…, {exact:true})` 可以定位。
      - `CompileCell` 按 `base.owned` 分支：共享库只出开着的类型标签，不出状态文案与旁注。
      - `删除知识库` 只在 `owned && state !== "rebuilding"` 时渲染。共享库整行没有按钮，点行与 Enter 照常进详情。
      - 复杂度 ≤ 15：名称格抽成局部组件 `NameCell`，不在 `map` 里堆三元式。
    - `detail.tsx`（131 → ≤ 160）：
      - `<h3>` 文本不变（区域名仍为 `<库名> · 文档`，ui-walk :130 依赖它）；`ScopeLabel` 放在 `<h3>` 外，作同一个 `flex flex-wrap` 行的兄弟。自有库本刀也显示纯文本标签，组 12 改为按钮。
      - 共享库：用 `MUTED`（`ingest-tree.tsx:8`）的 `<p>` 只读提示代替入库工具条，与 `state` 无关（`rebuild_failed` 时也显示）；不渲染 `IngestDialog` 与 `UploadButton`。
      - 自有库分支不变；`useKbDocuments` 照旧（共享库也会读一次 `listWorkspaces`，不改不断言）。
      - 检索测试仍只在 `ready` 时渲染。
    - `documents-table.tsx`（113 → ≤ 135）：新 prop `owned: boolean`；`sourceText`：`upload` → `本地上传`；`path === null` → `工作空间`（服务端只对非所有者置空，所以按数据判，自有库不会走到）；其余不变。共享库不渲染 `操作` 列：表头为 `["名称","来源","大小","状态"]`，没有操作单元格。自有库的表头与行不变（`center-kb-detail.test.tsx:97-99`、CK-07 不动）。
    - `retrieval-panel.tsx`（127 → ≤ 145）：`UnitField` 加 `readOnly`，取值为 `!base.owned`；只读时传 `readOnly`，并且不传 `onChange`（受控输入会被 React 还原），不用 `disabled`。请求 body 仍为两个框的当前值，即已存值（服务端对非所有者本来就忽略）。成功后照旧取应答的 `retrieval` 显示（只读），并经 `onRetrieval` 同步列表；`use-retrieval.ts` 不改。
    - 新文件 `web/test/center-kb-shared.test.tsx`（≤ 320 行，文件头注明 `#2035 s2c-kb-visibility 组 9`）：
      - 夹具复用 `center-kb-support.tsx` 的 `base`、`doc`、`fakeKb`、`READY`、`renderPanel`、`rowOf`。本地 `shared(id, patch)` = `base(id, { owned:false, owner:{id:"u1",account:"zhangsan",department:"平台研发部"}, scope:{scope:"all",group:null}, compile:null, ...patch })`。共享库的行用 `screen.getByText("来自 …",{exact:true}).closest("tr")` 定位，不改 `rowOf`。打开详情的助手以行元素为参数；若 jscpd 报它与 `center-kb-detail.test.tsx:50-55` 重复，就把 `openDetail` 挪进 `center-kb-support.tsx`，加可选参数 `row`，两边都导入，不留两份。
      - 「共享库的只读呈现」：A = `base("a",{name:"我的库"})`，K = `shared("k",{name:"规范库",raptor:true,documents:2})`。K 的两份文档为 `doc("d1",{name:"spec.md",workspaceId:null,path:null,sourceChanged:null})` 与 `doc("d2",{name:"notes.md",source:"upload",workspaceId:null,path:null,sourceChanged:null})`。列表：计数行 `我的 1 个 · 共享给我 1 个`；K 行有 `只读` 与 `来自 zhangsan · 平台研发部`，第 6 列为 `全员可见`，编译格的文本恰为 `RAPTOR`，`queryAllByRole("button")` 为空；A 行各格依次为 `["我的库","通用","","0","","仅自己可见","删除知识库"]`，按钮名恰为 `["删除知识库"]`，没有 `只读` 与 `来自`；页面没有 `状态未知`。进 K 的详情：表头为 `["名称","来源","大小","状态"]`；两行来源为 `工作空间`、`本地上传`；只读提示逐字；区域内按钮名恰为 `["检索"]`；`全员可见` 在区域内。
      - 「所有者没有部门」：`shared("k",{owner:{id:"u1",account:"zhangsan",department:null}})`。`getByText("来自 zhangsan",{exact:true})`；该行 `textContent` 不含 `·`。范围用 `all`，因为 `group` 档的文案本身带 ` · `。
      - 列表计数行：两个自有 → `我的 2 个 · 共享给我 0 个`；两个共享 → `我的 0 个 · 共享给我 2 个`；空列表 → `还没有知识库`，没有匹配 `/^我的 \d+ 个/` 的文本；一自有一共享，删掉自有的那个 → `我的 0 个 · 共享给我 1 个`，`listKnowledgeBases` 仍为 1 次。
      - 四档范围标签：依次为自有 `me`、共享 `dept`、自有 `group`（`{id:"g1",name:"内网落地专项"}`）、共享 `all`（`graph:true`）。按行序第 6 列为 `仅自己可见`、`本部门可见`、`项目组可见 · 内网落地专项`、`全员可见`；四个文案都没有同名按钮；共享 `all` 行的编译格为 `知识图谱`。打开自有 `group` 库的详情：`项目组可见 · 内网落地专项` 是纯文本、不是按钮。
      - 自有库与共享库的按钮差异：A、K 都是 `rebuild_failed`，各一份工作空间来源的文档（K 的 `path` 为 null）。A 行有 `删除知识库`，K 行没有任何按钮；A 的详情有 `移出`；K 的详情没有 `移出`、`重新入库`、`从工作空间入库`、`上传文件`，有只读提示，没有 `检索测试`。
      - 共享库检索测试两个数字只读：K 为 `ready`，`retrieval:{threshold:0.2,vectorWeight:0.7}`。两个数字框 `readOnly === true`、`disabled === false`；`fireEvent.change(相似度阈值,{target:{value:"0.9"}})` 之后值仍为 `"0.2"`，没有 `填 0 到 1 之间的数字`；先 `retrieveFromKnowledgeBase.mockImplementationOnce` 返回 `{hits:[],retrieval:{threshold:0.3,vectorWeight:0.6}}`，再填问句 `销售额` 点 `检索`：恰一次调用，参数 `("k",{question:"销售额",threshold:0.2,vectorWeight:0.7})`；之后两个框为 `"0.3"`、`"0.6"`，仍为 readOnly；`listKnowledgeBases` 仍为 1 次。对照：自有库 A 的数字框 `readOnly === false`。
    - 既有用例只许原地改 `center-kb-list.test.tsx:141-163`：表头加 `范围`；三行的格各在第 6 位插入 `仅自己可见`（`["规范库","手册","","3","","仅自己可见","删除知识库"]`、`["表格库","表格","RAPTOR已完成知识图谱编译中","0","重建中","仅自己可见",""]`、`["法规库","法规","","1","重建失败","仅自己可见","删除知识库"]`）。`:236`、`:328` 的第 2 列（编译格）不变。其余 kb 测试文件不改。
    - TDD：没有新生产文件。四个组件的配对测试是 `center-kb-shared.test.tsx`；先写红的用例再实现。
    - 非目标：范围按钮与对话框，新建对话框的范围（组 12）；引用选择列表（组 10）；ui-walk 共享分支与截图（组 13）；CK 行（11.4 的「非所有者只读」行由组 11 写，届时建议在期望里补上 `我的 0 个 · 共享给我 1 个`）；共享库详情跳过 `listWorkspaces`；demo 的 `title` 悬停文案。
    - 实测与上面这些字面量不符时停下来报告，不改期望。
    - 回归命令：`npm run test:focus --workspace web -- center-kb-shared`（先红后绿）；`npm run test:focus --workspace web -- center-kb`；`make lint`、`make typecheck`、`make anti-drift`（jscpd：打开详情的助手；knip：`ScopeLabel` 有使用者）；本机 ui-walk（自有分支版面有变化）；最后 `make check`。本刀不附截图，也不做 UI 视觉声明。

Suggested fixture level: compact - 纯呈现分支，数据已由组 5 给出。
Minimal mergeable slice: atomic - 列表与详情的只读呈现是同一个 `owned` 分支在相邻组件里的两处，验证路径是同一个组件测试文件。

## 10. web：引用选择列表附所有者（message-attachments「输入框知识库引用」）

- [x] 10.1 核对 Context：`web/src/features/chat/kb-ref-picker.tsx:20-45`；`web/test/chat-kb-ref-picker.test.tsx`（483）；顺带：`web/src/features/chat/turn-actions.ts:67` 的注释仍写「两个函数引用稳定」，而 `ids` 随 `client` 变化（#1973 的修复 `a41a8444`）
- [x] 10.2 测试先行：在 `chat-kb-ref-picker.test.tsx` 加「共享库附所有者」「内建命令带引用被拒」（后者断言既有拒绝呈现，不新增前端判定）
- [x] 10.3 实现：非自有库附 `（<所有者账号>）`；纠正 `turn-actions.ts:67` 的注释
  - 组 10 约定（#2036 fixture 审查补；10.2–10.3 照此实现与测试）：
    - 10.1 行号更正：`kb-ref-picker.tsx:20-45` 是 `ListState` 与 `useKbRefDialog`，不是落点；落点是 `KbRefOptions`（:106-162）：文档注释 :102-105，`onToggle(base)` :142，名称 span :145，状态字样 :146-150；标签区 `KbRefTags`（:165-196）用 `ref.name`（:179-180、:183），不改。`chat-kb-ref-picker.test.tsx` 483 行，「拒绝后保留」:265-288（`envelope` 是两参版本，code 为 `rejected`）。`turn-actions.ts:67` 核实：`kbRefIds` 在派发回调依赖表 :378，`clearKbRefs` 在 :371、:693；`kb-refs-state.ts:72-80` 的 `ids` 依赖 `[client]`，`:29` 的注释已正确。
    - 文案逐字（specs/message-attachments/spec.md）：
      - 非自有库：`<库名>（<owner.account>）`，全角括号 U+FF08 / U+FF09，中间没有空格（:50；场景 :84-86 为 `规范库（zhangsan）`）；自有库只有库名；次序同应答（:50）。
      - 审查裁定（规格没有字面量）：非自有且非 `ready` 的库按 :50 的列举次序为 `名称（账号）状态`，例如 `法规库（zhaoliu）重建中`。
      - 标签只写库名（:56）；被拒时保留并显示拒绝的 message（:63、:88-90）；服务端 400 文案 `请求格式不正确`（`server/src/core/errors/index.ts:6`）。
    - `kb-ref-picker.tsx`（196 → ≤ 200）：:145 的 span 内容改为：`owned` 为真时 `base.name`，否则模板串 `${base.name}（${base.owner.account}）`；一个模板串、同一个 span（截断一起作用），不另加 span、不加 `title`；`onToggle(base)` 原样，标签、`移除 <库名>`、气泡都只写库名；:102-104 的注释补「`owned` 为假的库附 `（<所有者账号>）`」；不改 `useKbRefDialog`、`KbRefTags`、`kb-refs-state.ts`。
    - `turn-actions.ts:67`（769 行不变）：整行替换为 ``  /** 某个会话的知识库引用：发送时按标签次序读 id，受理后与撤回回填时清空，未受理不动（`clear` 引用稳定，`ids` 随 `client` 换新）。 */``；PR 附 `grep -rn "两个函数引用稳定" web/src` 为空。
    - `chat-kb-ref-picker.test.tsx`（483 → ≤ 550）：
      - 文件头 :1-4 补「共享库附所有者」「内建命令带引用被拒」（#2036 s2c-kb-visibility 组 10）；从 `chat-kb-ref-support.js` 补导入 `exchange`，其余沿用已导入的辅助函数。
      - 本地常量：`SHARED = base("kb-shared",{name:"规范库",owned:false,owner:{id:"u1",account:"zhangsan",department:"平台研发部"},scope:{scope:"all",group:null},compile:null})`；`OWNED_ALL = { ...PRODUCT, scope:{scope:"all",group:null} }`（自有、已共享出去）。
      - 「共享库附所有者」第一例：`mountSelected({ ...kbRoutes([OWNED_ALL, SHARED]), ...turn(SA, [], exchange("查一下", [SHARED])) })`，`openPicker()`；`options(dialog)` 恰为 `[{text:"产品文档",pressed:false,disabled:false},{text:"规范库（zhangsan）",pressed:false,disabled:false}]`；`within(dialog).getByText("规范库（zhangsan）",{exact:true})` 存在，页面没有匹配 `/产品文档（/` 的文本；`toggle(dialog,"规范库")` 后 `options(dialog)[1].pressed` 为 true，`closePicker`；`tagNames()` 为 `["规范库"]`，`within(tagArea()).getByRole("button",{name:"移除 规范库"})` 存在；`typeDraft("查一下")`、`clickSend()`，等 `tagArea()` 为 null；`promptBodies(fetchMock, A)` 为 `[{message:"查一下",knowledgeBases:["kb-shared"]}]`，`alerts()` 为 `[]`。
      - 「共享库附所有者」第二例（审查裁定）：`kbRoutes([SHARED, base("kb-law",{name:"法规库",owned:false,owner:{id:"u2",account:"zhaoliu",department:"数据部"},state:"rebuilding"})])`；`options(dialog).map(({text}) => text)` 恰为 `["规范库（zhangsan）","法规库（zhaoliu）重建中"]`（各取自己的所有者，所有者字样在状态字样之前）。
      - 「内建命令带引用被拒」一例：`mountSelected(turn(SA, [() => jsonResponse({error:{code:"bad_request",message:"请求格式不正确"}}, 400)]))`（内联 `jsonResponse`，不用两参 `envelope`）；`refer("产品文档")`、`typeDraft("/compact")`、`clickSend()`（必须点按钮：斜杠候选会吞掉 Enter，见 `chat-page-slash.test.tsx` J5）；`await waitFor(() => expect(alerts()).toEqual(["请求格式不正确"]))`；`tagNames()` 为 `["产品文档"]`，`composer().value` 为 `"/compact"`；`promptBodies(fetchMock, A)` 恰为 `[{message:"/compact",knowledgeBases:[PRODUCT.id]}]`（前端判定内建命令的实现为零条或少键）。本例开工即绿（守卫），PR 描述写明。
      - jscpd 若报它与 :265-288 重复：本文件内抽局部函数 `sendRejected(draft, response)` 两处共用，不留两份。
    - TDD：没有新生产文件；`kb-ref-picker.tsx` 的配对测试是 `chat-kb-ref-picker.test.tsx`；「共享库附所有者」两例先红后绿。
    - 非目标：前端判定内建命令（B16、D10）；标签、气泡、`kb-search-card.tsx` 的库名；`kb-refs-state.ts`、`use-chat-session.ts` 的代码；ui-walk（`BASE` 是自有库，共享分支在组 13）；CK 行（D12，在 11.4）。本组不跑本机 ui-walk、不做截图声明；CI `ui-walk` 须绿。
    - 实测与上面这些字面量不符时停下来报告，不改期望；`alerts()` 混进斜杠目录读取的提示时也停下来报告。
    - 回归命令：`npm run test:focus --workspace web -- chat-kb-ref`（先红后绿）；`make lint`、`make typecheck`、`make anti-drift`；最后 `make check`。

Suggested fixture level: compact - 一处文案分支与一处注释。
Minimal mergeable slice: atomic - 一个组件的一个分支，验证路径单一。

## 11. 打开共享：范围端点与建库范围（knowledge-bases「知识库范围端点」「知识库端点」建库、「同一知识库的写操作串行」、「知识库审计」`kb.scope`；http-service-skeleton「统一错误信封」）

- [x] 11.1 核对 Context：`kb/bases.ts` 的建库判定与设置锁、`kb.create` 的 detail（`kb-bases.test.ts:161`）；`kb/rest.ts` 的路由注册与 body limit；`accounts/scope.ts` 的 `scopeOf`；`server/src/http/errors.ts:94-133` 的归属集与 `server/test/http-parser-owners.test.ts` 的计数
- [x] 11.2 测试先行：新文件 `server/test/kb-scope.test.ts` 覆盖「知识库范围端点」全部场景、「知识库端点」的「建库带范围」、「不可见与不存在不可区分」里 `PUT …/scope` 的两次；在 `kb-visibility.test.ts` 的「共享库的两级归属」补上 `PUT …/scope`（合法 body）对可见非所有者 403、范围不变、无 `kb.scope`、假 RAGFlow 零请求；「同一知识库的写操作串行」的「改范围不排队」；`kb-bases.test.ts:161` 与 `kb-bases-compile.test.ts:162` 的 `kb.create` detail 加 `scope`；`http-parser-owners.test.ts` 的归属集加 `PUT …/scope`、计数改为四十（畸形 JSON、空 JSON 与 `text/plain` 得 400）；`kb-disabled.test.ts` 的路由表加 `PUT …/scope`，恰十四条（ragflow-backend「知识库可用性」）
- [x] 11.3 实现新文件 `server/src/kb/scope.ts`（`PUT /api/kb/bases/:id/scope`：`ownedBase` → 形状 → 所有者条件（`scopeOf`）→ 相同不写 → 一条事务 `UPDATE` + `kb.scope`，0 行 404；不取写锁；应答的 `compile` 5 s 期限、失败为 `null`）；建库 body 加 `scope?` / `groupId?`，第 5 步复用同一个所有者条件函数；`errors.ts` 归属集加该路由
- [x] 11.4 验收清单：在 `docs/acceptance/functional-checklist.md` 的 CK 节加两行（`待签`）：
  - P2 里程碑：`zhangsan` 把「规范库」设为全员可见（组 12 合入前经 `PUT …/scope`，之后经范围对话框）后，`zhaoliu` 在会话里经「+ → 引用知识库…」选 `规范库（zhangsan）`，问一个只有该库能答的问题，回答带出处切片，检索卡显示该库；以 `lisi` 在浏览器打开 `/api/audit`，看到至少一条 `kb.shared_retrieval`，每条 `actorId` 为 `u2`（即 `zhaoliu`）、detail 的 `ownerId` 为 `u1`、不含问句。
  - 非所有者只读：`zhaoliu` 在中心「知识库」tab 看到该库带 `只读` 与「来自 zhangsan · 平台研发部」，没有删除、入库、上传、移出，文档来源不显示路径，检索测试可用但两个参数不可改。
  - 组 11 约定（#2037 fixture 审查补；11.2–11.4 照此实现与测试）：
    - 规格前置（已由编排方在 fixture 提交里补齐，实现方不改 openspec/）：`specs/ragflow-backend/spec.md` 的 MODIFIED「知识库可用性」把「十三条 / 十三次」改为十四（先例 archive/2026-11-08-s2b-kb-retrieval/specs/ragflow-backend/spec.md:51）；11.2 的 parser 输入以 http-service-skeleton/spec.md:117 的三种为准；11.4 的 actor 改为 `actorId`。
    - 11.1 行号核实与更正：
      - `bases.ts` 320 行：`BODY_KEYS` :32，`parseCreate` :116-135，`createLocked` :228-262（就绪、重名、上限 :230-242，`createBase` 与 `kb.create` :248-256，detail :254），设置锁在 `create` :296-299，`viewOf` :177-200（不导出），`ownedBase` :101-107。
      - `rest.ts` 313 行：路由 :229-312，`BASE_BODY_LIMIT` :76（16 KiB），钩子 :195-202。`accounts/scope.ts:8-24` 的 `scopeOf`。
      - `errors.ts` 的集合是 :94-134（:133 是最后一条，:134 收尾）；注释里的「三十九」在 :67 与 :138，枚举在 :85-89。
      - `http-parser-owners.test.ts` 387 行：`KB_OWNER_IDENTITIES` :29-38，三十九条清单 :41-74，计数 :201-212（PUT 为 :209）。
      - `kb.create` detail：`kb-bases.test.ts:161` 是标题，detail 在 :168；`kb-bases-compile.test.ts:158-165`（detail :162，同样 toEqual）。
      - 其余：`compile-status.ts:28` 的 5 s、`:137-160` 的 `read`；`index.ts:157` 的 compileStatus 内联建；`store.ts:635` 的 `inTransaction` 模块私有；`kb-disabled.test.ts:20-42,71-77`（恰十三条）；`kb-visibility.test.ts` 517 行（VALID :95，MALFORMED :125，扫描 :290-315，:308 是 scope 集合）。
    - 字面量（逐字）：
      - 路由 `PUT /api/kb/bases/:id/scope`，body 上限 16 KiB，no-store（knowledge-bases/spec.md:52）。
      - 审计 kind `kb.scope`，title `修改知识库可见范围`（:410），workspaceId 为 null；detail 键序 `{id, before:{scope, groupId}, after:{scope, groupId}}`（:405）；只在实际变化时写（:415）。
      - `kb.create` 的 detail 为 `{id, template, raptor, graph, scope:{scope, groupId}}`（:390）。
      - 应答为 200 的十四键 BaseView（:61）；建库的 201 带 `scope`（:189）。归属集恰四十条（http-service-skeleton/spec.md:118）。
      - 所有者的部门与成员关系与端点用同一个读取函数（account-groups/spec.md:35）。
    - 与 11.2、11.3 的差异（审查裁定，PR 按偏离写明）：
      - 「不可见与不存在不可区分」的两次 PUT 不在 kb-scope.test.ts 另写：把 PUT 加进 kb-visibility 的 VALID，由既有循环（:376）覆盖。
      - 「改范围不排队」进 kb-scope.test.ts（kb-visibility 已近上限）。
      - 「与删库并发」的 0 行用触发器注入（第 1–5 步同步，真实删库落不进这一段），另写一例真实删库交错作补充。
      - 建库与改范围的写入共用 scope.ts 里同一条 UPDATE；建库在 `createBase` 的 `within` 里执行。store.ts 的 INSERT 与 43 处 `createBase` 调用点都不改。
      - 写入只改两列，不动 `updated_at`（`updatedAt` 只在 `toBase` 映射，store.ts:615，不进 BaseView）；测试钉住。
    - 新文件 `server/src/kb/scope.ts`（≤ 110 行；头注释写 s2c-kb-visibility D3、D12，knowledge-bases「知识库范围端点」）：
      - 依赖方向只能是 bases.ts → scope.ts。scope.ts 从 `./store.js` 导入 `inTransaction`（store.ts:635 只加 export，不另写事务助手），从 `../accounts/scope.js` 导入 `scopeOf`，从 `./ragflow-route.js` 导入 `isRecord`；`BaseAccess` 只作类型导入；不导入 bases.ts。
      - 唯一的 SQL：`UPDATE knowledge_bases SET scope = ?, scope_group_id = ? WHERE id = ?`。
      - `export function parseScope(body)`（body 为 `Record<string, unknown>`）返回 `{scope, groupId}`，键序固定：`scope` 缺省 `me`，其它值必须是 me、dept、group、all 之一；`group` 时 `groupId` 必须是非空字符串；其余档位只要 body 有 `groupId` 键就 400（含 `groupId:null`）；不读库，建库第 1 步与改范围第 2 步共用。
      - `export function createKbScope(deps: { db; audit })` 返回三个方法：
        - `assertQualified(ownerId, ref)`：只有 dept、group 才调 `scopeOf`；dept 要 `department` 非空，group 要 `groups` 里有该 id（含组不存在）；不满足抛 `bad_request`。
        - `write(id, ref)`：执行那条 UPDATE，返回 `Number(changes)`，不开事务。
        - `change(access, body, actorId)`：形状（body 不是对象、没有 `scope` 键、或有 `scope`/`groupId` 之外的键时 400，再调 `parseScope`）→ `assertQualified(access.owner.id, ref)` → `before = {scope: access.scope.scope, groupId: access.scope.group?.id ?? null}`，与 ref 相同就返回不写 → 否则 `inTransaction`：先 `write`，为 0 抛 `not_found`（回滚），再 audit。不读库行、不读 RAGFlow、不取锁。
      - 审计事件的 interface 留在模块内，不导出（knip）。
    - `bases.ts`（320 → ≤ 350）：
      - `BODY_KEYS` 加 `scope`、`groupId`；`CreateRequest` 加 `scope`（取 `parseScope` 的返回类型）；`parseCreate` 末尾调 `parseScope(body)`。依赖加 `scope`（`createKbScope` 的返回类型，类型导入）。
      - `createLocked` 在 :240-242 的上限判定之后调 `scope.assertQualified(ownerId, request.scope)`；`within` 改为先 `scope.write(id, request.scope)`，再 audit，detail 末尾加 `scope: request.scope`。
      - 新方法 `async setScope(id, body, ownerId)`：`scope.change(ownedBase(visibility, id, ownerId), body, ownerId)`；重读 `const access = ownedBase(…)`；`const [compile = null] = await compileStatus.read([access.base])`；返回 `viewOf(access, store.countDocuments(id), compile)`。本地读失败照常抛出（同列表）。
      - 文件头 :8-19 补「范围」一段。
    - `rest.ts`（313 → ≤ 325）：加 `SCOPE_ROUTE = "/api/kb/bases/:id/scope"`；`app.put` 注册，选项 `{ onRequest: noStore, preParsing: ownedBase, bodyLimit: BASE_BODY_LIMIT }`，处理函数调 `bases().setScope(request.params.id, request.body, principalOf(request).id)`。知识库关闭时也照常注册（rest.ts:21）。文件头补一段。
    - `index.ts`（200 → ≤ 205）：audit（:122）之后加 `const scope = createKbScope({ db: app.db, audit })`，传给 `createKbBases`。`app.ts` 不改。
    - `errors.ts`（199 → ≤ 201）：:130 之后加 `"PUT /api/kb/bases/:id/scope"`；:67、:138 的「三十九」改「四十」；:85-89 的枚举加这条。
    - 新测试文件 `server/test/kb-scope.test.ts`（≤ 520 行；文件头写 #2037 s2c-kb-visibility 组 11）：
      - 夹具：同时登记 `useSettingsWorlds()` 与 `useIngestWorlds()`（先例 kb-visibility.test.ts:41-42）。复用 `createdBase`、`deleteBase`、`auditsOf`、`baseCount`、`NOT_FOUND`、`GENERIC_500`、`COMPILE_OFF`（kb-bases-helpers），`BAD_REQUEST`、`addCompileBase`、`routes`（kb-settings-helpers），`holdWriteLock`（kb-upload-helpers.ts:170），`LIST`、`UPLOAD`（kb-ingest-helpers），`totalChanges`、`enableAccount`（session-db-helpers），`cookieFor`，`padded`，`PARSER_INPUTS`（http-guard-helpers.ts:66），`expectAnswer`。
      - u4：`enableAccount(world.db,"u4")`，`cookieFor(world.app,"wangwu")`，加 `app.inject`；若 jscpd 报与 kb-visibility 的 `wangwuIds` 重复，挪进 kb-settings-helpers 共用。
      - kb.scope 读法：`SELECT actor_id, title, detail, workspace_id FROM audit_events WHERE kind = 'kb.scope' ORDER BY id`，detail 按原始串比较（钉住键序）。
      - 「改范围并审计」：u1 `createdBase(world,"规范库")` 得 K 与 201 的 `created`；读 `updated_at`；`world.forget()`。PUT `{scope:"group",groupId:"g1"}`：200、no-store，body toEqual `{...created, scope:{scope:"group",group:{id:"g1",name:"内网落地专项"}}}`；记 `totalChanges`，再提交同一 body：200、同一 body，差为 0。PUT `{scope:"all"}`：body `{...created, scope:{scope:"all",group:null}}`。kb.scope 恰两行：actor `u1`、title `修改知识库可见范围`、workspace null；detail 原始串依次为 `{"id":"<K>","before":{"scope":"me","groupId":null},"after":{"scope":"group","groupId":"g1"}}` 与 `{"id":"<K>","before":{"scope":"group","groupId":"g1"},"after":{"scope":"all","groupId":null}}`。设为 group 后 peer 列表 id 为 `[K]`、`owned:false`，admin 列表 `[]`；设为 all 后 admin 列表 `[K]`。行的 `scope_group_id` 为 null，`updated_at` 等于建库时的值；`world.sent()` 为 `[]`。（抓「相同仍 UPDATE」「应答由请求拼出没带组名」「只写一列」。）
      - 「所有者条件与形状」：u4 建「空部门库」（201）再 PUT `{scope:"dept"}`；u3 `createdBase(…,"admin")` 建库再 PUT `{scope:"group",groupId:"g1"}`。u1 的 K 依次提交 `{scope:"group"}`、`{scope:"all",groupId:"g1"}`、`{scope:"group",groupId:"nope"}`、`{scope:"me",extra:1}`、`{}`、`{scope:"team"}`、`{scope:"ME"}`、`{scope:null}`、`{scope:"me",groupId:null}`、`{scope:"group",groupId:""}`、`{scope:"group",groupId:1}`、`{scope:"group",groupId:"g1",extra:1}`，另用 raw 的 `[]` 与 `"all"`（application/json）。每次 400 `BAD_REQUEST`、no-store；`SELECT id, scope, scope_group_id, updated_at FROM knowledge_bases ORDER BY id` 前后相等，kb.scope `[]`，`world.sent()` `[]`。最后 u1 PUT `{scope:"dept"}` 得 200、`scope:{scope:"dept",group:null}`、kb.scope 一条（阳性对照）。
      - 「重建中也能改」（ingest 世界）：`setState("rebuilding")`，`const release = holdWriteLock(world,"rebuild")`，记 `world.lines().length`；`send(world.fw.rest,"member","PUT",…,{scope:"all"})`：200，body `state:"rebuilding"`、`scope:{scope:"all",group:null}`、`compile` 为 `COMPILE_OFF`；`world.locks.writeWaiters(world.baseId)` 为 0；`world.audits("kb.scope")` 恰一条（me → all）；新增 lines `[]`；`await release()`。再 `setState("rebuild_failed")`，PUT `{scope:"me"}` 得 200，kb.scope 共两条。（取锁或按 state 拦截的实现得 409。）
      - 「读编译状态失败不影响改范围」：阳性 `addCompileBase(world,1)`，`const ds = world.fake.addDataset()` 并带外改 `dataset_id`，`forget`；PUT `{scope:"all"}` 得 200、`compile:{raptor:"pending",graph:"off"}`，`routes(world.sent())` 恰为 `GET …/datasets/<ds>/documents` 与 `GET …/datasets/<ds>/ingestions`。不可达：`await world.fake.close()`；PUT `{scope:"me"}` 得 200、`compile:null`、`scope:{scope:"me",group:null}`；kb.scope 共两条。期限：`configuredWorld(open,{compileStatusDeadlineMs:300})`，同样建库，`fault(LIST,{kind:"hang"})`；PUT `{scope:"all"}` 得 200、`compile:null`，耗时 ≥ 299 ms；kb.scope 一条；`world.db.isTransaction` 为 false。
      - 「已失去条件时重存同一范围」：K 经 PUT 设为 group/g1（200），`DELETE FROM project_group_members WHERE group_id='g1' AND account_id='u1'`；再提交同一 body：400，行仍 group/g1，kb.scope 仍一条；PUT `{scope:"me"}`：200，kb.scope 两条，第二条 detail 原始串 `{"id":"<K>","before":{"scope":"group","groupId":"g1"},"after":{"scope":"me","groupId":null}}`。
      - 「与删库并发」：注入 `CREATE TEMP TRIGGER scope_race BEFORE UPDATE OF scope ON knowledge_bases BEGIN SELECT RAISE(IGNORE); END`；PUT `{scope:"all"}` 得 `expectAnswer(…,404,NOT_FOUND)`，kb.scope `[]`，行仍 me，`isTransaction` false；`DROP TRIGGER scope_race` 后同一请求 200，kb.scope 一条（抓「不看 changes 就 200 加审计」）。真实交错：另建 K2，`const gate = world.fake.fault("DELETE /api/v1/datasets",{kind:"hold"})`，`const removing = deleteBase(world,K2)`，`await gate.reached`；此时 PUT K2 `{scope:"all"}` 得 200，`writeWaiters(K2)` 为 0；`gate.release()` 后 `removing` 得 204；再 PUT K2 `{scope:"me"}` 得 404 `NOT_FOUND`；K2 的 kb.scope 恰一条。
      - 「改范围不排队」（ingest 世界）：写入 docs/a.md，`const gate = world.fake.fault(UPLOAD,{kind:"hold"})`，`const pending = world.ingest(["docs/a.md"])`，登记 settled 标志，`await gate.reached`；PUT `{scope:"all"}` 得 200；此时 settled 为 false，`writeWaiters` 为 0，kb.scope 一条，`world.countOf(UPLOAD)` 为 1；`gate.release()` 后 `pending` 得 201。
      - 「建库带范围」（`chatWorld`）：u1 建 `{name:"组库",template:"naive",scope:"group",groupId:"g1"}`：201，`scope:{scope:"group",group:{id:"g1",name:"内网落地专项"}}`、`owned:true`；u1 建 `{name:"部门库",template:"naive",scope:"dept"}`：201，`scope:{scope:"dept",group:null}`。`auditsOf(world,"kb.create")` 两个 detail toEqual `{id,template:"naive",raptor:false,graph:false,scope:{scope:"group",groupId:"g1"}}` 与 `{…,scope:{scope:"dept",groupId:null}}`；两行 scope 列相符。`forget()`，记 `baseCount`。以下各为 400 `BAD_REQUEST`：u4 带 `raptor:true` 的 `{scope:"dept"}`；u3 带 `raptor:true` 的 `{scope:"group",groupId:"g1"}`；u1 `{scope:"all",groupId:"g1"}`；u1 `{scope:"team"}`；u1 不带 scope 只带 `groupId:"g1"`。u1 用重名「组库」加 `{scope:"group",groupId:"nope"}`：409 conflict（第 4 步先于第 5 步）。以上全部 `world.sent()` `[]`，`baseCount` 与 kb.create 条数不变。另开未配置嵌入的世界 `open()`：u1 带 `{scope:"all",groupId:"g1"}` 得 400（第 1 步不读库）；u4 带 `{scope:"dept"}` 得 409 `kb_not_ready`（条件在就绪之后）。
      - 「归属路由」（http-service-skeleton:116-118）：u1 自己的 K，`PARSER_INPUTS` 四项、`text/plain` 的 `{"scope":"all"}`、`padded(16*1024+1,{scope:"all"})` 每次 400 `BAD_REQUEST`、no-store；行不变，kb.scope `[]`，`world.sent()` `[]`；最后 `padded(16*1024,{scope:"all"})` 得 200（忘了 16 KiB 上限的实现在 +1 得 200）。
      - 「一条事务」：`CREATE TEMP TRIGGER refuse_scope BEFORE INSERT ON audit_events WHEN NEW.kind = 'kb.scope' BEGIN SELECT RAISE(ABORT, 'injected'); END`；PUT `{scope:"all"}` 得 500、body `GENERIC_500`；行仍 me，`isTransaction` false。
    - 既有用例原地改（只限这些）：
      - `kb-visibility.test.ts`（517 → ≤ 540；放宽组 7 的 ≤ 520）：VALID 末尾加一项，名 `PUT 范围`，调 `w.call("PUT", <BASES>/<id>/scope, "peer", { scope: "group", groupId: "g1" })`（peer 是 g1 成员：钩子误用读级、按调用者判条件的实现会 200）；MALFORMED 末尾加一项，名 `PUT 范围 坏 JSON`，调 `w.raw("PUT", <BASES>/<id>/scope, "{not json", "application/json", "peer")`（没有钩子的实现在「403 先于 body」得 400）。:318 标题改为「…六条写路由 403…」；:5、:94、:124 的注释同步（「组 11 之前没有改范围的路由」「七条」「五种」）。:308 改为 `["kb/scope.ts","kb/visibility.ts"]`，另断言 kb/scope.ts 的 SQL 字面量恰为 `["UPDATE knowledge_bases SET scope = ?, scope_group_id = ? WHERE id = ?"]`；:309-313 的 department、project_group_members 两个集合不变。
      - `kb-bases.test.ts:161,168`：标题改为「恰五键」，detail 加 `scope: { scope: "me", groupId: null }`（442 → ≤ 450）。`kb-bases-compile.test.ts:162` 同样改（606 → ≤ 615，放宽组 5 的 ≤ 608）。
      - `http-parser-owners.test.ts`（387 → ≤ 395）：`KB_OWNER_IDENTITIES` 加 `["PUT", "/api/kb/bases/:id/scope"]`，注释八条改九条；`THIRTY_NINE_OWNER_IDENTITIES` 改名 `FORTY_OWNER_IDENTITIES`，标题与注释三十九改四十；:203-204 的 39 改 40，:209 的 PUT 7 改 8；`NON_OWNER_METHODS` 加 GET、POST 的 `/api/kb/bases/:id/scope`；`LOOKALIKES` 加 `["PUT", "/api/kb/bases/abc/scope"]`。
      - `kb-disabled.test.ts`（111 → ≤ 113）：ROUTES 加 PUT …/scope（body:true）；:71-77 的十三改十四；文件头补「s2c-kb-visibility 组 11 加范围端点，表恰十四条」（只在开启时注册的实现得 404，变红）。
      - 测试助手的方法联合加 PUT：`kb-settings-helpers.ts:100-105` 的 `World.call`、`mounts-rest-helpers.ts:173-182` 的 `send`。
    - 冒烟（只能经 make smoke-kb 验证，review-only，PR 写明）：
      - `kb.hurl:194` 拆两行：`$.bases[?(@.owner.account=='zhangsan' && @.name=='smoke-kb')]` not exists，smoke-kb-compile 同样一行。
      - `kb-cleanup.hurl:32,45` 的取值加 `@.owner.account=='zhangsan' &&`；`:56` 同 kb.hurl:194 拆两行。
      - 用 owner.account 不用 owned==true：嵌套成员加 && 加字符串比较在 kb.hurl:184 有先例，布尔字面量与括号在仓库 hurl 里没有先例；拆两行避开 && 与 || 的优先级。
      - `kb.hurl:184` 按 id 过滤，不改。`kb-cleanup.hurl:23-24` 是对原始正文 replaceRegex，不改；文件头注明：若可见的他人同名库存在而 zhangsan 的不在，:32 取不到值，清理失败（Makefile:104 不改变退出码），也删不到别人的库。
      - `kb.hurl:12` 注释的 body 键集加 `scope`、`groupId`。
    - 11.4 验收清单，CK 节在 CK-20 之后加两行，结论都写 `待签`：
      - CK-21 操作：由 owner 执行（agent 不得代签）。在 CK-15 那台接上共用 RAGFlow 栈与真实模型上游的服务上，`zhangsan` 的「规范库」里有已切片的 `manual.pdf`（CK-06）。以 `zhangsan` 把「规范库」设为全员可见：组 12 合入前，先在浏览器打开 `/api/kb/bases` 记下「规范库」的 `id`，再在开发者工具控制台以同一登录态发 `PUT /api/kb/bases/<该 id>/scope`，`Content-Type` 为 `application/json`，body `{"scope":"all"}`；组 12 合入后改为点「规范库」一行的范围按钮，选「全员可见」并保存。然后以 `zhaoliu` 新建会话，打开输入框「+」菜单选 `引用知识库…`，选 `规范库（zhangsan）`，问一个只有 `manual.pdf` 里才有的事实，等回答结束。最后以 `lisi` 在浏览器打开 `/api/audit`。期望：设范围得 200（组 12 后为对话框关闭、按钮变为「全员可见」）；选择列表有 `规范库（zhangsan）`；回答的事实与 `manual.pdf` 原文一致；助手消息有「知识库检索」卡，卡头 `知识库检索 · 规范库`，展开一行能看到 `manual.pdf` 与切片原文；模型没有检索时记 `不通过` 并注明；`/api/audit` 至少一条 `kind` 为 `kb.shared_retrieval`，每条 `actorId` 为 `u2`（即 `zhaoliu`），detail 的 `ownerId` 为 `u1`、`name` 为 `规范库`，标题与 detail 都不含问句；页面没有错误提示。
      - CK-22 操作：由 owner 执行（agent 不得代签）。接 CK-21（「规范库」为全员可见，`zhaoliu` 名下没有知识库）。以 `zhaoliu` 打开「中心」的「知识库」tab；点「规范库」一行；在「相似度阈值」与「向量权重」里试着改数字，再填问句点「检索」。期望：计数行 `我的 0 个 · 共享给我 1 个`（list.tsx:163）；「规范库」一行带 `只读` 与「来自 zhangsan · 平台研发部」，整行没有按钮；详情没有「从工作空间入库」「上传文件」，原入库工具条位置显示「共享给你的知识库只读：可检索、可在会话中引用，不能增删文档。需要补充内容请联系 zhangsan。」（detail.tsx:71）；文档表没有「操作」列，也没有「移出」「重新入库」；`manual.pdf` 来源为「本地上传」，`guide.pdf` 来源只写「工作空间」，没有空间名与路径；「检索测试」可用，两个数字改不动、仍是 zhangsan 保存的值，检索照常出结果；页面没有错误提示。
      - 写完跑 `npm run test:focus --workspace web -- functional-checklist`（格式守卫 web/test/functional-checklist.test.ts:15-33）。
    - 行数汇总：`scope.ts` ≤ 110、`kb-scope.test.ts` ≤ 520；`bases.ts` ≤ 350；`rest.ts` ≤ 325；`index.ts` ≤ 205；`errors.ts` ≤ 201；`store.ts` 653 不变（只加 export）。PR 预计超过 400 行，援引 issue 的 Width exception（merged-tasks）。
    - TDD 配对：`scope.ts` 对应 `kb-scope.test.ts`；`bases.ts`、`rest.ts` 的改动由同一文件加 kb-visibility、kb-bases 的原地改动覆盖。
    - PR：标题与描述写「多租户过滤与跨账号共享：请求白盒审查」；附 grep 证据：`grep -rn "scope_group_id\|SET scope" server/src` 只命中 kb/scope.ts 与 kb/visibility.ts；`grep -n "PUT /api/kb/bases/:id/scope" server/src/http/errors.ts` 恰一行。
    - 非目标：web 范围对话框、新建时设范围、`getMyScope`（组 12）；ui-walk（组 13）；system.md、glossary、计划状态（组 14）；项目组管理（S3a）；管理员特权（没有分支）；应答编译状态的本地行读取失败（同列表，照常 500）；`updated_at` 之外的 schema。
    - 实测与上面这些字面量不符时停下来报告，不改期望；`RAISE(IGNORE)` 使 changes 为 0 以及 Biome 折行后的行数，以实测为准。
    - 回归命令：先红后绿 `npm run test:focus --workspace server -- kb-scope`（kb-visibility、http-parser-owners、kb-disabled、kb-bases 的原地改动在实现前也应为红）；`npm run test:focus --workspace server -- kb-scope kb-bases http-parser-owners kb-visibility kb-disabled kb-settings kb-retrieval-shared kb-ingest-workspace kb-compile-status accounts-scope`；`npm run test:focus --workspace web -- functional-checklist`；`make lint`、`make typecheck`、`make anti-drift`（knip：`inTransaction`、`parseScope`、`createKbScope` 都有使用者；jscpd：不另写事务助手）；最后 `make check`。`make smoke` 本机不必跑（CI 照跑）；`make smoke-kb` review-only，PR 写明；无 web 改动，不跑 ui-walk。

Suggested fixture level: expanded - 新写端点、审计、parser 归属集、与删库并发的 0 行语义，且是打开共享的开关。
Minimal mergeable slice: atomic - 建库与改范围共用同一个形状与所有者条件判定；它是打开共享的唯一开关，依赖头保证它最后合入（D12）。

## 12. web：范围对话框与新建范围（knowledge-bases「中心「知识库」tab」范围部分；account-groups「账号范围端点」的 web 客户端）

- [x] 12.1 核对 Context：`web/src/lib/api.ts`（691 行）的审计客户端写法；`getMyScope` 放新文件 `web/src/lib/api-accounts.ts` 并由 `api.ts` 导出；`create-dialog.tsx`；demo :2737-2742、:3058-3092、:3010-3019
- [x] 12.2 测试先行：新文件 `web/test/api-kb-scope.test.ts`：`getMyScope` 的严格解析（含 `memberCount`）、`setKnowledgeBaseScope` 与 `createKnowledgeBase` 的 `scope` 参数；新文件 `web/test/center-kb-scope.test.tsx`：「范围对话框」「没有部门与没有项目组」「当前档已不可选」「新建时设范围」「新建对话框取不到范围」、范围对话框 `getMyScope` 失败（四档与 `保存` 全部禁用、有 `role="alert"`、`setKnowledgeBaseScope` 零次，与新建对话框只留 `仅自己可见` 不同）与对话框的保存失败态
- [x] 12.3 实现新文件 `web/src/features/center/kb/scope-dialog.tsx`（四档、预选、组下拉带人数、无组提示、部门空禁用、demo 逐字文案）；列表与详情的自有库范围标签改为按钮；新建对话框内嵌同一组控件
- [x] 12.4 验收清单：CK 节加一行（`待签`）：`zhangsan` 在中心「知识库」tab 把一个库依次设为「项目组可见 · 内网落地专项」与「全员可见」，`zhaoliu` 刷新后两次都能看到，`lisi` 只在全员可见时看到；再设为「本部门可见」，`zhaoliu`、`lisi` 都看不到（种子里没有与 `zhangsan` 同部门的可登录账号，正向只由 server 单测覆盖）；`lisi` 在浏览器打开 `/api/audit` 看到 `zhangsan` 的三条 `kb.scope`（before → after）。部门为空时 `本部门可见` 置灰只由 12.2 的 web 单测覆盖：种子里唯一没有部门的 `wangwu` 已停用、无法登录
  - 组 12 约定（#2038 fixture 审查补；12.2–12.4 照此实现与测试）：
    - 前置：#2054（组 11）已合入。服务端契约：`GET /api/accounts/me/scope` 的 200 恰为 `scopeOf` 的返回值（`server/src/accounts/scope.ts:8-24`，注册在 `accounts/index.ts:21-27`，no-store）；`PUT /api/kb/bases/:id/scope` 的键集恰为 `scope`，group 档另带 `groupId`；缺 `scope` 键即 400（`kb/scope.ts:85-88`）；非 group 档出现 `groupId` 键即 400，含 `null`（`kb/scope.ts:37-52`）；成功为 200 的十四键 BaseView（`kb/rest.ts:302-304`）。
    - 12.1 行号核实与更正：
      - `api.ts` 691 行。审计客户端：类型 :93-110；签名 :188；`parseAuditList` :403-410；实现 :567-589（`request(…, 200)` 后严格解析，失败抛 `requestFailed(200)`）。transport :541-550；`createKbMethods` 的展开 :565；kb 类型导出 :663-675；`getRequestOptions` :440-446。
      - `api-kb.ts` 是 662 行（头部写 610，已过时）。:5 写「十四个方法」；`CreateKnowledgeBaseInput` :121-127；`KbMethods` :184-200；`isPositiveSafeInteger` :262-265（模块私有，`composer-contract.ts:45-47` 另有一份）；`jsonBody` :552-559；`createKnowledgeBase` :613-616（body 原样序列化）；`retrieveFromKnowledgeBase` :653-660。`api-kb.test.ts` 是 695 行（头部写 688），冻结，不加用例。
      - `list.tsx` 211 行：`SCOPE_TEXT` :37-42，`ScopeLabel` :82-86，列表注释 :143-147，范围格 :187-189，`删除知识库` :190-203。组 9 给的 ≤ 220 已基本用完，本组放宽。
      - `detail.tsx` 144 行：注释 :29-30，头部 :58-68。`create-dialog.tsx` 178 行：`Values` :21，`toInput` :34-37，注释 :59-63，复选 :147-160，alert :161-165，Dialog 外壳 :103-118。`panel.tsx` 125 行：`restoreFocus` :39-42，新建按钮 :60-69，列表 :77-86，详情 :87-97，新建对话框 :98-107。`use-kb.ts` 216 行：头注 :11-27（本地改动清单 :23-24），`updateBases` :96-99，`invalidateRefetch` :129-131。
      - `messageOf` 已在 `ingest-tree.tsx:12` 导出，复用，不另写。
      - demo：`KB_SCOPES` :2737-2742（四档 :2738-2741）。新建对话框：`可见范围` :3010，提示 :3013，`项目组` :3015，人数 :3018，无组提示 :3019。范围对话框是 :3058-3091（不是 :3058-3092）：标题 :3059，预选当前档 :3061，`项目组` :3065，选项与预选当前组 :3068，无组提示 :3069，审计提示 :3071，`取消`、`保存` :3072，相同即关 :3084，toast :3089。
      - 拷入层 `components/ui/radio-group.tsx` 仓内尚无使用者，本组是第一个。
    - 字面量（逐字）：
      - 范围对话框的可访问名为 `「<库名>」可见范围`，括号 U+300C / U+300D（spec.md:452，demo :3059）。
      - 四档名与说明（spec.md:455，demo :2738-2741）：`仅自己可见`：`只有你能检索与引用，文档留在你的沙箱内`；`本部门可见`：`同部门同事可检索与引用，但不能改动内容`；`项目组可见`：`指定项目组的成员可检索与引用，可跨部门`；`全员可见`：`全公司可检索与引用，适合口径、规范类文档`。
      - 部门旁注 `你的账号没有部门信息`（:456）。下拉标签 `项目组`（demo :3065）；每项 `<组名>（<memberCount> 人）`，全角括号 U+FF08 / U+FF09，数字与「人」之间一个半角空格（:457，demo :3068）。
      - 无组提示 `你还不属于任何项目组，请让管理员在「中心 → 账号」中把你加入`（:457，demo :3069）。
      - 审计提示 `共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。`（:458，demo :3071），只出现在范围对话框。
      - 按钮 `保存`、`取消`（demo :3072）。新建对话框里这组控件的标签为 `可见范围`（demo :3010）。
      - 范围按钮的文案与 `ScopeLabel` 同出一处（组 9 约定：四档文案只此一处）。
    - 审查裁定（规格没写；按此实现与测试，PR 按偏离写明）：
      - 读取时点：`getMyScope()` 在打开对话框的点击里发出，不放在 effect 里（`kb-ref-picker.tsx:24-27` 先例）；面板挂载时不读，每打开一次恰调用一次；不传 signal（`mock.calls` 为 `[[]]`）；迟到的应答按打开序号丢弃。
      - 读取在途：范围对话框四档都禁用、都不选中，`保存` 禁用，没有 alert；新建对话框 `仅自己可见` 选中且可用，其余三档禁用，没有 alert，`创建` 照常可用。
      - 范围对话框取不到范围：四档禁用且都不选中（预选只在取得之后计算）；`取消` 可用；不加重试按钮，关闭后重开即重读。
      - 预选：`me`、`all` 恒可选；`dept` 要 `department !== null`；`group` 要当前组在 `groups` 里。可选时选中当前档，`group` 档的下拉选中当前组。改选 `项目组可见` 时下拉缺省为当前组（若在 `groups` 里），否则 `groups[0]`。缺省值由状态派生，不用 effect 同步。
      - 禁用：`本部门可见` 只看 `department === null`。`项目组可见` 在 `groups` 为空时不禁用；选中后不渲染下拉、显示无组提示，`保存`（新建对话框里是 `创建`）禁用。
      - 原样保存也恰调用一次 `setKnowledgeBaseScope`（spec.md:459），偏离 demo :3084 的前端短路。
      - 新建对话框不加 demo :3013 的提示与 :3071 的审计提示；两个对话框都不做 demo :3089 的 toast。
    - `web/src/lib/api-accounts.ts`（新文件，≤ 70 行；头注写 s2c-kb-visibility 组 12、account-groups「账号范围端点」）：
      - `export type MyScope = { department: string | null; groups: { id: string; name: string; memberCount: number }[] }`。
      - 模块私有 `parseMyScope`：`hasExactlyKeys(value, ["department","groups"])`；`department` 为 `null` 或字符串；`groups` 经 `parseJsonArray`，每项 `hasExactlyKeys(["id","name","memberCount"])`，`id`、`name` 为字符串，`memberCount` 用内联的 `isNonNegativeSafeInteger(x) && x > 0`（不新增第三份 `isPositiveSafeInteger`）；不判非空串与次序。
      - `export function createAccountMethods(onUnauthorized, { request, getRequestOptions, requestFailed })`，返回 `Pick<ApiClient, "getMyScope">`：`request("/api/accounts/me/scope", getRequestOptions(options?.signal), onUnauthorized, 200)`，解析为 null 抛 `requestFailed(200)`（同 `api.ts:567-589`）。
    - `api.ts`（691 → ≤ 705）：导入 `createAccountMethods` 与 `type MyScope`；`ApiClient` 加 `getMyScope(options?): Promise<MyScope>` 与 `setKnowledgeBaseScope(id, input: KbScopeInput, options?): Promise<BaseView>`；`createApiClient` 展开 `...createAccountMethods(onUnauthorized, transport)`；导出 `type { MyScope }`，kb 类型导出加 `KbScopeInput`。
    - `api-kb.ts`（662 → ≤ 685）：`export type KbScopeInput = { scope: "me" | "dept" | "all" } | { scope: "group"; groupId: string }`（判别联合）；`CreateKnowledgeBaseInput` 改为原四键交上「不带范围」或 `KbScopeInput` 之一，方法体不改（body 原样序列化，只发所给的键）；`setKnowledgeBaseScope(id, input, options)` = `parsed(basePath(id) + "/scope", jsonBody("PUT", input, requestOptions(options?.signal)), 200, parseBaseView)`；`KbMethods` 加这个名字；:5 改为「十五个方法对应十五条路由」。
    - `web/src/features/center/kb/scope-dialog.tsx`（新文件，≤ 260 行；头注写 s2c-kb-visibility D9、knowledge-bases「中心「知识库」tab」范围对话框）：
      - `export const SCOPES`：四档 `{ value, label, description }`，次序 me、dept、group、all。`list.tsx` 删掉 `SCOPE_TEXT`，`ScopeLabel` 改从 `SCOPES` 取名（文案只此一处）；scope-dialog 不导入 list.tsx（避免成环）。
      - `export function useMyScope(client)`：返回 `{ state, load }`；`state` 为 `{status:"loading"}`、`{status:"ready", scope}` 或 `{status:"failed", message}`；`load()` 递增打开序号并发出一次 `client.getMyScope()`；失败文案取 `messageOf`。由 panel 持有一份，两个对话框共用。
      - `export function ScopeFields({ state, value, groupId, onChange, onGroupChange, fallback })`：拷入层 `RadioGroup`，`aria-label="可见范围"`；每档一个 `RadioGroupItem`，以 `Label htmlFor` 关联，可访问名恰为档名；说明是独立元素，经 `aria-describedby` 关联；另含部门旁注、下拉、无组提示。下拉用拷入层 `Select`，触发器名为 `项目组`，在 `SelectValue` 里显式写选中项文案（同 `create-dialog.tsx:136`）。`fallback`：新建对话框 `"me-only"`、范围对话框 `"none"`。复杂度 ≤ 15：下拉抽成 `GroupField`。
      - `export function ScopeDialog({ base, state, client, restoreFocus, onSaved, onCancel })`：拷入层 `Dialog`，标题为「「」+ 库名 +「」可见范围」；外壳同 `create-dialog.tsx:103-118`（`useEscapeFallback`，`onCloseAutoFocus` 还焦点）。「取不到范围」与「保存失败」各一个 `p`（`role="alert"`，样式同 `create-dialog.tsx:18-19` 的 `ERROR_TEXT`）。`保存` 恰调用一次 `client.setKnowledgeBaseScope(base.id, input)`（恰两个参数）：group 档 `{scope:"group", groupId}`，其余档 `{scope}`（含 `{scope:"me"}`）。在途时 `保存`、`取消`、四档与下拉都禁用，Escape 与遮罩关不掉，`useRef` 拦同一帧第二次点击。成功调 `onSaved(view)`；失败显示信封文案，选择保持，`保存` 恢复可用。
      - jscpd 若报 Dialog 外壳与 `create-dialog.tsx:103-118`、`ingest-dialog.tsx:125-140` 重复：抽成 kb 目录里一个导出组件三处共用，不留三份。
    - `list.tsx`（211 → ≤ 240）：`ScopeLabel({ base, onScope })`：`base.owned` 为真时渲染拷入层 `Button`（`size="sm"`、`variant="outline"`，可访问名恰为范围文案），`onClick` 先 `stopPropagation` 再 `onScope(base, event.currentTarget)`；否则仍是组 9 的纯文本 span。任何 `state` 都渲染范围按钮（B18，`rebuilding` 也有）。`KnowledgeBaseList` 加 prop `onScope(base, trigger)`；:82 与 :143-147 的注释同步。
    - `detail.tsx`（144 → ≤ 155）：加 prop `onScope(trigger)`，头部渲染 `ScopeLabel`（传 `base` 与 `onScope`）；:29-30 的注释改为「自有库为按钮」。
    - `create-dialog.tsx`（178 → ≤ 230）：加 prop `scope`（`useMyScope` 的 state）；`Values` 加 `scope` 与 `groupId`；复选之后、alert 之前渲染标签 `可见范围` 与 `fallback="me-only"` 的 `ScopeFields`；`toInput`：`me` 不带范围键，`group` 带 `scope` 与 `groupId`，其余档只带 `scope`；选 `项目组可见` 而 `groups` 为空时 `创建` 禁用；两条 alert（取不到范围、建库失败）并存时各占一个元素；:59-63 的注释补范围。
    - `panel.tsx`（125 → ≤ 150）：持有 `useMyScope(client)` 与正在设置的库 id（每次从 `view.bases` 现取该行）；`新建知识库` 的点击里调 `load()`；`onScope` 里设 `opener`、调 `load()`、打开 `ScopeDialog`；`onSaved` 里 `kb.replaceBase(view)` 并关闭；还焦点沿用 `restoreFocus`。
    - `use-kb.ts`（216 → ≤ 232）：新方法 `replaceBase(view)`，经 `updateBases` 按 id 整行换成应答，再 `invalidateRefetch()`；头注 :23-24 的本地改动清单加「改范围成功」。
    - 夹具 `web/test/center-kb-support.tsx`（349 → ≤ 400）：导出 `GROUPS = [{id:"g1",name:"内网落地专项",memberCount:2},{id:"g2",name:"数据治理",memberCount:3}]` 与 `MY_SCOPE: MyScope = {department:"平台研发部", groups:[GROUPS[0]]}`（account-groups/spec.md:41）；`fakeKb` 加 `getMyScope`（记 `["getMyScope"]`，返回 `MY_SCOPE` 的拷贝）与 `setKnowledgeBaseScope(id, input)`（记入 calls，按 `GROUPS` 取组名改表，返回该行拷贝）；`createKnowledgeBase` 按请求的范围生成 `scope`，与 `setKnowledgeBaseScope` 共用同一个局部函数。缺省成功是硬要求（否则 `center-kb-list.test.tsx:355` 等变红）。
    - 新文件 `web/test/api-kb-scope.test.ts`（≤ 260 行；头注 #2038 s2c-kb-visibility 组 12；接缝同 `api-kb-visibility.test.ts`：真实 `createApiClient` 加替身 `fetch`）：
      - getMyScope 请求：`fetch.mock.calls` `toStrictEqual` `[["/api/accounts/me/scope",{method:"GET",credentials:"same-origin",cache:"no-store"}]]`；传 signal 时 init 多一个 `signal`。
      - 原样通过（`toStrictEqual`）：`{department:"平台研发部",groups:[{id:"g1",name:"内网落地专项",memberCount:2}]}`、`{department:null,groups:[]}`、两个组时保持应答次序。
      - 拒绝（`expectRequestFailure(…, 200)`）：外层多一键、缺 `department`、缺 `groups`、`department` 为 `1`/`true`/`{}`、`groups` 为 `null`/`{}`/`"g1"`、整个应答为 `[]` 或 `null`；组项多一键、各缺一键、`id`/`name` 为 `1` 或 `null`、`memberCount` 为 `0`/`-1`/`1.5`/`"2"`/`null`/`true`/`2 ** 53`。201 为 `requestFailed(201)`；503 信封 `{status:503, code:"kb_unavailable", message:"知识库服务暂不可用"}` 原样透传。
      - setKnowledgeBaseScope：id `kb/1 中` 的地址为 `/api/kb/bases/kb%2F1%20%E4%B8%AD/scope`；init `toStrictEqual` `{method:"PUT",credentials:"same-origin",headers:{"Content-Type":"application/json"},body}`，`body` 依次为原始串 `{"scope":"group","groupId":"g1"}`、`{"scope":"me"}`、`{"scope":"all"}`；200 的 BaseView 原样返回；201 为 `requestFailed(201)`；缺 `scope` 键的 BaseView 为 `requestFailed(200)`；400 信封（`bad_request`、`请求格式不正确`）原样透传。
      - createKnowledgeBase 的范围：body 原始串 `{"name":"组库","template":"naive","scope":"group","groupId":"g1"}` 与 `{"name":"全员库","template":"naive","scope":"all"}`；201 带 `scope:{scope:"group",group:{id:"g1",name:"内网落地专项"}}` 的视图原样通过。
      - 不复制 `api-kb-retrieval.test.ts` 的 401 用例块（jscpd）。
    - 新文件 `web/test/center-kb-scope.test.tsx`（≤ 480 行；头注 #2038 组 12）。本地助手：`scopeOptions(dialog)`（每个 `role="radio"` 取 `{name: label[for=id] 的文本, checked: aria-checked 为 "true", disabled: 按钮的 disabled}`）、`scopeDialog(name)`（`findByRole("dialog", {name: "「" + name + "」可见范围"})`）、`alertsIn(dialog)`。
      - 「范围对话框」：A = `base("a",{name:"规范库"})`，渲染后 `getMyScope` 零次。`getMyScope` 以 deferred 挂起，点 A 行的 `仅自己可见` 按钮：对话框名 `「规范库」可见范围`；没有 `规范库 · 文档` 区域（不冒泡）；挂起时四项都 `{checked:false, disabled:true}`，`保存` 禁用，`alertsIn` 为 `[]`。放行返回 `MY_SCOPE`：`scopeOptions` `toEqual` `[{name:"仅自己可见",checked:true,disabled:false},{name:"本部门可见",checked:false,disabled:false},{name:"项目组可见",checked:false,disabled:false},{name:"全员可见",checked:false,disabled:false}]`；四句说明与审计提示都能 `getByText(…, {exact:true})`；没有部门旁注与 `项目组` 下拉。点 `项目组可见`：下拉出现，触发器 `内网落地专项（2 人）`，`openOptions(dialog,"项目组")` 恰为 `["内网落地专项（2 人）"]`，选中它。`setKnowledgeBaseScope.mockImplementationOnce` 挂起，放行返回 `{...A, scope:{scope:"group",group:{id:"g1",name:"内网落地专项"}}, documents:7}`；点 `保存`：在途时 `保存`、`取消` 禁用，再点不再调用；放行后对话框关闭，`mock.calls` `toStrictEqual` `[["a",{scope:"group",groupId:"g1"}]]`；A 行第 6 格按钮为 `项目组可见 · 内网落地专项`，第 4 格为 `7`；焦点在该按钮；`getMyScope` 1 次，`listKnowledgeBases` 1 次。进 A 的详情点头部同名按钮：`项目组可见` 选中、下拉 `内网落地专项（2 人）`；选 `仅自己可见`（下拉消失）保存：第二次调用 `toStrictEqual` `["a",{scope:"me"}]`；详情头部与列表行按钮都为 `仅自己可见`；`getMyScope` 共 2 次。
      - 「两个项目组」：`getMyScope` 返回 `{department:"平台研发部",groups:GROUPS}`；B 为 group/g2 的自有库：预选 `项目组可见`，下拉 `数据治理（3 人）`（不是首项），下拉文案恰为 `["内网落地专项（2 人）","数据治理（3 人）"]`；C 为 `me`：改选 `项目组可见` 时下拉缺省 `内网落地专项（2 人）`，改选 `数据治理（3 人）` 后保存，调用 `toStrictEqual` `["c",{scope:"group",groupId:"g2"}]`，按钮为 `项目组可见 · 数据治理`。
      - 「没有部门与没有项目组」：`{department:null,groups:[]}`：`仅自己可见` 选中可用，`本部门可见` `{checked:false,disabled:true}`，`项目组可见`、`全员可见` 可用；旁注逐字存在；点禁用的 `本部门可见` 后仍未选中；选 `项目组可见`：无下拉、无组提示逐字存在、`保存` 禁用；选 `全员可见`：提示消失、`保存` 可用；`取消` 关闭，`setKnowledgeBaseScope` 零次。同一应答下打开新建对话框：`scopeOptions` 与旁注相同；选 `项目组可见` 后出现无组提示，`创建` 禁用。
      - 「当前档已不可选」：A 为 group/g1，`{department:"平台研发部",groups:[]}`：四项都未选中、都不禁用，`保存` 禁用，无下拉与无组提示；选 `全员可见` 后 `保存` 可用。D 为 dept，`{department:null,groups:[GROUPS[0]]}`：四项都未选中，`本部门可见` 禁用，`保存` 禁用。阳性对照 E 为 dept，在 `MY_SCOPE` 下 `本部门可见` 选中、`保存` 可用。另：`base("r",{name:"重建库",state:"rebuilding"})` 那一行按钮名恰为 `["仅自己可见"]`（B18）。
      - 「范围对话框取不到范围」（describe 名写明与新建对话框不同）：`getMyScope.mockRejectedValueOnce(new ApiError(503,"kb_unavailable","知识库服务暂不可用"))`；`alertsIn(dialog)` 为 `["知识库服务暂不可用"]`；四项都 `{checked:false,disabled:true}`；`保存` 禁用、`取消` 可用；点 `全员可见` 再点 `保存`，`setKnowledgeBaseScope` 零次；`pageAlerts()` 为 `[]`；`取消` 后关闭，焦点回 A 行按钮。
      - 「保存失败」：`setKnowledgeBaseScope.mockRejectedValueOnce(new ApiError(400,"bad_request","请求格式不正确"))`；选 `全员可见` 保存：对话框仍在，`alertsIn` 为 `["请求格式不正确"]`，`全员可见` 仍选中，`保存` 可用；A 行按钮仍为 `仅自己可见`；`listKnowledgeBases` 1 次；`pageAlerts()` 为 `[]`。再点 `保存`（缺省成功）：关闭，按钮为 `全员可见`，共调用 2 次。
      - 「新建时设范围」：`getByRole("radiogroup",{name:"可见范围"})` 存在，`仅自己可见` 选中，四项都可用。第一次：名称 `规范库`、模板 `手册`、选 `全员可见`、点 `创建`：`createKnowledgeBase.mock.calls` `toStrictEqual` `[[{name:"规范库",template:"manual",scope:"all"}]]`，新行按钮 `全员可见`。第二次：`手册库`，范围保持 `仅自己可见`：第 2 次调用 `toStrictEqual` `[{name:"手册库",template:"manual"}]`。第三次：`组库`，选 `项目组可见`（下拉缺省 `内网落地专项（2 人）`）：`toStrictEqual` `[{name:"组库",template:"manual",scope:"group",groupId:"g1"}]`。`getMyScope` 共 3 次。
      - 「新建对话框取不到范围」：同样的 503；对话框内 alert 恰为 `["知识库服务暂不可用"]`；`仅自己可见` `{checked:true,disabled:false}`，其余三档 `{checked:false,disabled:true}`；没有部门旁注；填 `规范库`、选 `手册`、点 `创建`：对话框关闭，`createKnowledgeBase.mock.calls` `toStrictEqual` `[[{name:"规范库",template:"manual"}]]`。
    - 既有用例只许原地改：
      - `center-kb-shared.test.tsx`（269 → ≤ 275）：:2 的「（本刀为纯文本，组 12 改为按钮）」改为「自有库为按钮（组 12）」；:88 与 :199 改为 `["仅自己可见","删除知识库"]`；:153 标题改为「…自有库为按钮、共享库为纯文本…」；:174 改为按行断言第 6 格里的按钮名 `[["仅自己可见"],[],["项目组可见 · 内网落地专项"],[]]`；:179 改为在 `detail` 范围内 `getByRole("button",{name:"项目组可见 · 内网落地专项"})` 存在；共享库相关的 :84、:102、:200 不变。
      - `api-files-archive.test.ts`（367 → ≤ 371）：`OTHER_CLIENT_METHODS` 在 :303 之后加 `"setKnowledgeBaseScope"`，再加注释「账号范围（account-groups「账号范围端点」）」与 `"getMyScope"`。
      - 不改：`center-kb-list.test.tsx`（:154-171 第 6 格文本仍是 `仅自己可见`；:302、:330-332、:359 的建库参数不带 `scope`，本身就是守卫；:355 的单个 alert 依赖 fake 的缺省 `getMyScope`）、`api-kb.test.ts`、`center-kb-retrieval.test.tsx`、`center-kb-detail.test.tsx`。
    - TDD 配对：`scope-dialog.tsx` 对 `center-kb-scope.test.tsx`；`api-accounts.ts` 对 `api-kb-scope.test.ts`（文件名按 12.2，PR 写明）。先红后绿。
    - PR 边界偏离（PR 写明）：issue 的 PR Boundary 没列 `panel.tsx`、`use-kb.ts`、`center-kb-support.tsx`、`center-kb-shared.test.tsx`、`api-files-archive.test.ts`（接线或原地改）；diff 预计超过 400 行，援引 Width exception（merged-tasks）。
    - 12.4 验收清单：CK 节在 CK-22 之后加 CK-23，结论 `待签`：
      - 操作：由 owner 执行（agent 不得代签）。在 CK-21 那台服务上，以 `zhangsan` 打开「中心」的「知识库」tab，点 `新建知识库`，名称填「范围库」，模板保持缺省，可见范围保持 `仅自己可见`，点 `创建`。然后点「范围库」一行的范围按钮 `仅自己可见`，在对话框里选 `项目组可见`，项目组选 `内网落地专项（2 人）`，点 `保存`；以 `zhaoliu`、`lisi` 各刷新自己的「知识库」tab。回到 `zhangsan` 再打开该对话框，选 `全员可见` 并保存，两人各刷新。`zhangsan` 第三次打开，选 `本部门可见` 并保存，两人各刷新。最后以 `lisi` 在浏览器打开 `/api/audit`。
      - 期望：新建对话框的「可见范围」有四档，各带说明，`仅自己可见` 选中，四档都可选；建成后该行的范围按钮为 `仅自己可见`。对话框标题为「「范围库」可见范围」，打开时选中当前档（第二次打开时为 `项目组可见`，项目组为 `内网落地专项（2 人）`）；`本部门可见` 可选；有提示「共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。」。每次保存后对话框关闭，按钮依次变为 `项目组可见 · 内网落地专项`、`全员可见`、`本部门可见`。项目组档：`zhaoliu` 的列表有「范围库」，带 `只读`、「来自 zhangsan · 平台研发部」与纯文本的 `项目组可见 · 内网落地专项`（不是按钮）；`lisi` 的列表没有。全员档：两人都有，标签为 `全员可见`。本部门档：两人都没有（种子里没有与 `zhangsan` 同部门的可登录账号，正向只由 server 单测覆盖）。`/api/audit` 里 `kind` 为 `kb.scope`、detail 的 `id` 为「范围库」的事件恰三条：`actorId` 都为 `u1`（即 `zhangsan`），标题为 `修改知识库可见范围`；按时间先后 before 到 after 依次为 `{"scope":"me","groupId":null}` 到 `{"scope":"group","groupId":"g1"}`、`{"scope":"group","groupId":"g1"}` 到 `{"scope":"all","groupId":null}`、`{"scope":"all","groupId":null}` 到 `{"scope":"dept","groupId":null}`。页面没有错误提示。部门为空时 `本部门可见` 置灰只由 web 单测覆盖：种子里唯一没有部门的 `wangwu` 已停用，无法登录。
      - 写完跑 `npm run test:focus --workspace web -- functional-checklist`（守卫 `web/test/functional-checklist.test.ts:15-33` 拒绝带 `#` 的选择器样写法与 px）。
    - 非目标：ui-walk 的范围对话框段与 `GET /api/accounts/me/scope` 的桩（组 13）；system.md 与术语表（组 14）；getMyScope 的重试按钮、跨多次打开的缓存或预取；demo :3013 的提示、:3089 的 toast、前端短路相同范围；共享库改范围；项目组管理与「中心 → 账号」入口（S3a）；管理员特权；本组不附截图、不做 UI 视觉声明。
    - 实测与上面这些字面量不符时停下来报告，不改期望。Radix `RadioGroup` 在 jsdom 里的受控「无选中」、点击禁用项、表单内隐藏 input 是否进入 `getAllByRole("radio")` 都未实测；与 `scopeOptions` 断言不符时停下来报告，不得不加说明就改用原生 radio。
    - 回归命令：先红后绿 `npm run test:focus --workspace web -- api-kb-scope center-kb-scope`；`npm run test:focus --workspace web -- center-kb api-kb api-files-archive functional-checklist`；`make lint`、`make typecheck`、`make anti-drift`（knip：`MyScope`、`KbScopeInput`、`SCOPES`、`useMyScope`、`ScopeFields`、`ScopeDialog`、`createAccountMethods`、`GROUPS`、`MY_SCOPE` 都有使用者，`SCOPE_TEXT` 无残留；jscpd：Dialog 外壳、api 测试的信封与 401 用例块）；本机 `make ui-walk`（对新 build 的 web/dist，PR 附命令与退出码）；最后 `make check`。

Suggested fixture level: expanded - 新的严格解析器与公开 API 参数（`issue-risk-contract` 的 parser / public API 触发项）。
Minimal mergeable slice: atomic - 范围对话框与新建对话框共用同一组控件与同一个 `getMyScope` 调用，拆开两 PR 改同一个新文件。

## 13. ui-walk：共享知识库分支（knowledge-bases「UI 走查共享知识库」）

- [x] 13.1 核对 Context：`web/e2e/ui-walk-center-kb.ts`（260 行）的 route 桩与收尾写法；`ui-walk-chat-kb.ts` 的先例
- [x] 13.2 实现：新兄弟文件 `web/e2e/ui-walk-center-kb-shared.ts` 写两段（只读呈现、范围对话框），由 `ui-walk-center-kb.ts` 调用；应答体严格按 web 解析器的键集
- [x] 13.3 本机 `make ui-walk` 全绿，PR 附命令与退出码、截图清单
  - 组 13 约定（#2039 fixture 审查补；13.2–13.3 照此实现与测试）：
    - 前置：#2038（组 12）已合入，分支从其后的 master 切出。DOM 契约以组 12 约定为准：四档文案与对话框名、`ScopeFields`、`ScopeDialog`、`list.tsx` 的范围按钮先 `stopPropagation`、`panel.tsx` 在点击里 `load()`、`replaceBase` 整行替换。
    - 13.1 行号核实（#2038 合入前的 master）：
      - `ui-walk-center-kb.ts` 263 行（不是 260）：`STATUS` :37-44（已导出），`BASE` :46-61（头部写 :46-57，已过时），`DOCUMENT` :63-75，`json` :104-105，`walkKbRetrieval` :108-158（装桩 :115-125，`try` :126-150，`finally` 按 pattern 撤桩 :151-156，`logout` :157），`expectPanelFits` :237-256（模块私有），`shot` :258-263。
      - `ui-walk-chat-kb.ts` 282 行：导入 :12，`BASES` 在顶层展开 `BASE` :33-36（该文件不在环里），逆序撤桩 :271-282。
      - `ui-walk.spec.ts` 724 行，7 个用例，宿主用例 :124-134；`ui-walk-sessions.spec.ts` 2 个用例。`playwright.config.ts`：`testMatch` 为 `ui-walk*.spec.ts`（新文件不会被当成 spec），`timeout` 30_000，`desktop-light`（1440×900 浅色）与 `mobile-dark`（390×844 深色）。
      - 解析器：`api-kb.ts` 的 `BASE_KEYS` :220-235，`DOCUMENT_KEYS` :236-248，`parseOwner` :357-365，`parseScope` :379-386，`parseBaseList` :445-447，`parseDocumentList` :496-499；`hasExactlyKeys`（`api-json.ts:10-18`）只比键集不比键序。
      - 呈现：`list.tsx` 的 `NameCell` :89-103、计数行 :163；`detail.tsx` 的只读提示 :69-73、入库工具条只在自有库渲染 :74-90；`documents-table.tsx` 的共享表头 :7-9、`工作空间` :35；`retrieval-panel.tsx` 只读时不接 `onChange` :103-104（组 12 合入后以实际行号为准）。
      - 守卫覆盖面：jscpd 含 `web/**`；knip 的 web `project` 只有 `src/**`、`test/**`，不看 e2e；`web/tsconfig.json` 含 `e2e`；Biome 含 `web/**`（认知复杂度 ≤ 15）；size-guard 生效。
    - 调用点（PR 边界）：`ui-walk-center-kb.ts`（263 → ≤ 267）只改三处：一行 `import { walkKbShared } from "./ui-walk-center-kb-shared.js";`；`finally` 闭合（:156）与 `await logout(page, oracle, project);`（:157）之间加 `await walkKbShared(page, project);`；文件头注释加一句指向共享分支。其余不动，`expectPanelFits` 不导出，`ui-walk.spec.ts` 不改。
    - 新文件 `web/e2e/ui-walk-center-kb-shared.ts`（≤ 240 行）：
      - 头注：knowledge-bases「UI 走查共享知识库」，s2c-kb-visibility 任务 13.2，#2039；两段的内容；只回 200 的原因（oracle）；为什么不得在顶层读导入值（import 环）。
      - 从 `./ui-walk-center-kb.js` 导入 `BASE`、`json`、`STATUS`、`shot`；另导入 `expectNoHorizontalOverflow`、`type WalkProject`。导出唯一的 `walkKbShared(page, project)`。
      - import 环规则：模块顶层只放字符串、数字、字面量对象，不得读四个导入值；桩对象由函数现造（`ownBase()`、`sharedBase()`、`savedBase()`）。违反时 ESM 加载期抛 `ReferenceError`，整个 ui-walk 变红。
      - 复杂度 ≤ 15：装桩、列表段、详情段、对话框段各自成函数。
    - 桩（应答只走 `json(route, …)`；handler 只记录与 fulfill，断言写在 handler 之外）：
      - `**/api/kb/status` → `STATUS`。
      - `**/api/kb/bases`：只应答 GET，计数 `listReads`；GET 之外 `route.fallback()`。应答 `{bases:[ownBase(), sharedBase()]}`，自有库在前。`ownBase()` = `{ ...BASE, id:"kb-walk-own", name:"我的库" }`（`scope` 为 `{scope:"me",group:null}`，`documents:1`）。`sharedBase()` = `{ ...BASE, id:"kb-walk-shared", name:"规范库", raptor:true, compile:null, owned:false, owner:{id:"u2",account:"zhaoliu",department:"数据部"}, scope:{scope:"all",group:null} }`（`documents:1`，`state:"ready"`）。
      - `**/api/kb/bases/kb-walk-shared/documents`：只应答 GET，`{documents:[…]}`，恰一条 `{id:"doc-walk-shared", name:"spec.md", size:2048, source:"workspace", workspaceId:null, path:null, status:"done", chunkCount:3, message:null, sourceChanged:null, createdAt:1_760_000_000_000}`（`done` 不触发 3 秒刷新；误进自有库详情会打到真实服务，由 oracle 抓住）。
      - `**/api/accounts/me/scope`：只应答 GET，计数 `scopeReads`，应答 `{department:"平台研发部", groups:[{id:"g1", name:"内网落地专项", memberCount:2}]}`。
      - `**/api/kb/bases/kb-walk-own/scope`：只应答 PUT；记录 `{method, pathname, body: postDataJSON(), raw: postData()}`，应答 `savedBase()` = `{ ...ownBase(), documents:7, scope:{scope:"group", group:{id:"g1", name:"内网落地专项"}} }`。
      - 次序：先装五个桩，再 `page.goto("/center?tab=knowledge-bases")`。父级的桩已在它的 `finally` 里撤掉，STATUS 要重新装。
    - 第 1 段「只读呈现」（`main = page.locator("main")`）：
      - 定位：自有行 = `main.getByRole("row").filter({ has: page.getByRole("cell", { name: "我的库", exact: true }) })`；共享行 = `main.getByRole("row").filter({ has: page.getByText("来自 zhaoliu · 数据部", { exact: true }) })`（共享库名称格全文不只是库名，不能精确匹配名称格）。
      - 列表：`getByText("我的 1 个 · 共享给我 1 个", { exact: true })` 可见；共享行有 `只读`（exact），第 3 格 `toHaveText("RAPTOR")`，第 6 格 `toHaveText("全员可见")`，行内按钮 `toHaveCount(0)`；阳性对照：自有行按钮 `toHaveText(["仅自己可见","删除知识库"])`；`main.getByText("状态未知")` 为 0 个；`scopeReads` 为 0；`expectNoHorizontalOverflow(page)`；`shot(page, 共享行, "kb-shared-<project>-list")`。
      - 点共享行的 `来自 zhaoliu · 数据部` 进详情。`detail = main.getByRole("region", { name: "规范库 · 文档", exact: true })`：`getByRole("columnheader")` `toHaveText(["名称","来源","大小","状态"])`；`spec.md` 行的来源格为 `工作空间`；只读提示逐字 `共享给你的知识库只读：可检索、可在会话中引用，不能增删文档。需要补充内容请联系 zhaoliu。`；`全员可见` 是纯文本；`从工作空间入库`、`上传文件` 各 `toHaveCount(0)`；区域内全部按钮 `toHaveText(["检索"])`；`getByRole("spinbutton", { name: "相似度阈值", exact: true })` 与 `向量权重` 都 `not.toBeEditable()`、`toBeEnabled()`，值为 `0.2`、`0.7`；`expectNoHorizontalOverflow(page)`；本地检查区域 `scrollWidth <= clientWidth`；`shot(page, detail, "kb-shared-<project>-detail")`。
    - 第 2 段「范围对话框」（承接第 1 段，不重新加载；共享库详情仍开着）：
      - 点自有行的 `仅自己可见` 按钮。对话框从 `page` 找：`page.getByRole("dialog", { name: "「我的库」可见范围", exact: true })`（对话框打开时 `#root` 被设为 aria-hidden，同 `ui-walk-center-kb.ts:182`）。
      - 打开后：`scopeReads` 为 1；`dialog.getByRole("radio")` 的可访问名依次为 `["仅自己可见","本部门可见","项目组可见","全员可见"]`，`仅自己可见` `toBeChecked()`，四项都 `toBeEnabled()`；审计提示 `共享只给读权限：他人可检索与引用，不能增删文档或改设置。切换范围会记入审计。`（exact）可见；对话框里没有 `combobox`。
      - 点 `项目组可见`：它变为 checked；`dialog.getByRole("combobox", { name: "项目组", exact: true })` `toHaveText("内网落地专项（2 人）")`；点开下拉，`page.getByRole("option")` `toHaveText(["内网落地专项（2 人）"])`，点它；`page.getByRole("listbox")` 回到 `toHaveCount(0)`，触发器文案不变；`expectNoHorizontalOverflow(page)`；本地检查对话框 `scrollWidth <= clientWidth`，`boundingBox` 的 `x >= 0` 且 `x + width` 不超过视口宽；`shot(page, dialog, "kb-shared-<project>-dialog")`。
      - 点 `保存` 后：对话框 `toHaveCount(0)`；PUT 记录 `toStrictEqual` `[{method:"PUT", pathname:"/api/kb/bases/kb-walk-own/scope", body:{scope:"group",groupId:"g1"}, raw:'{"scope":"group","groupId":"g1"}'}]`；自有行按钮变为 `["项目组可见 · 内网落地专项","删除知识库"]`，`main` 里已没有 `仅自己可见` 按钮；自有行第 4 格为 `7`；`listReads` 为 1；`scopeReads` 为 1；`规范库 · 文档` 区域仍在，`我的库 · 文档` 区域为 0 个；`expectNoHorizontalOverflow(page)`；`shot(page, 自有行, "kb-shared-<project>-saved")`。
    - 截图：设了 `UI_WALK_SHOT_DIR` 才截（沿用 `shot`）。新增 4 张 × 2 个 project = 8 张：`kb-shared-{desktop-light,mobile-dark}-{list,detail,dialog,saved}.png`。PR 附清单。
    - 收尾：桩与断言包在 `try` 里，`finally` 按装桩的逆序 `unroute` 五个 pattern，不另做导航；随后父级 `logout`。
    - error oracle：桩不出现 4xx/5xx；不加放行项。
    - 非目标：失败路径（`getMyScope` 503、保存 400）、没有部门与没有项目组、当前档已不可选、在途禁用、还焦点、新建对话框的范围、详情头部的范围按钮（由 `center-kb-scope.test.tsx` 覆盖）；改 `ui-walk.spec.ts` 或 `setTimeout`；导出 `expectPanelFits`；CK 行；产品代码。
    - TDD：没有新生产文件；走查脚本没有配对单测，PR 写明。
    - 时限：宿主用例两个 project 的耗时与基线（desktop-light 1.1 s、mobile-dark 1.7 s）对比写进 PR；任一超过 24 s 停下来报告。
    - jscpd 若报新文件与 `ui-walk-center-kb.ts:115-125` 或 `ui-walk-chat-kb.ts:52-55` 的装桩块重复：停下来报告，不扩大 PR 边界。
    - 实测与上面这些字面量不符时停下来报告，不改期望。真实 Chromium 里未实测、不符时同样停下来报告、不得不加说明就换定位器的：`RadioGroup` 的 radio 个数与可访问名；`Select` 触发器的可访问名 `项目组` 与文案；选项与 listbox 在 portal 里的可见性；`not.toBeEditable()` 对 readOnly 数字框的判定。
    - 回归命令：`make lint`、`make typecheck`、`make anti-drift`；`npm run build --workspace web` 之后，对本分支 `web/dist` 起 `.github/scripts/ci-compiled-server.sh ui-walk`（假上游）并设 `UI_WALK_SHOT_DIR=<scratchpad 目录>`，期望退出 0、`17 passed`、`1 skipped`；PR 附命令、退出码与 8 张截图清单；最后 `make check`。

Suggested fixture level: compact - 走查脚本，桩应答，不改产品代码。
Minimal mergeable slice: atomic - 两段共用同一组 route 桩与收尾。

## 14. 收口：文档、计划状态与 Grill 结论落点核对

- [x] 14.1 `docs/architecture/system.md`：`accounts` 行（`scopeOf`、`GET /api/accounts/me/scope`）、`kb` 行（可见判定、两级归属、范围端点、`kb.shared_retrieval`；删去「S2c change A 只按所有者判定」）、§6.1 时序图里「change A 只有自己的库」一句
- [x] 14.2 `openspec/glossary.md`：「可见范围」写明四档判定与「动态跟随所有者当前部门 / 查看者当前成员关系」；「附件」里「只能是自己的库」改为「可见的库」；「审计」补 `kb.scope`；「host tool」里「没有库时不注册」改为「没有可见的库时不注册」
- [x] 14.3 `IMPLEMENTATION_PLAN.md`：S2c 状态（B 交付、待 owner 签收）与 Next Step（签收后可启动 S3a（本地账号与治理，ADR-0018）与 S4a）；`smoke/kb.hurl:13` 注释里的 `BaseView` 键集同步
- [x] 14.4 逐条核对 design.md「Grill 结论」B1–B19 的落点在代码与规格里成立，核对记录写进 PR 描述

Suggested fixture level: none - 文档与核对，没有行为变化。
Minimal mergeable slice: atomic - 收口文档随最后一个实现 PR 之后一次性落地。
