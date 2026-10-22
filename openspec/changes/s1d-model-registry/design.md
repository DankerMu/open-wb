# Design: s1d-model-registry

## Context

事实基线（origin/master `c3c6bb53`，2026-10-21 读码，Stage 3 核对后修正；每组第一个任务仍核对行号）：

- 白名单解析：`server/src/model-catalog.ts:49-80` `resolveModelCatalog(env)` 纯函数（`MODEL_CATALOG` JSON ≤32 项，`{id,name,reasoning,vision,maxTokens,efforts?}`，`id` 1–128 UTF-8 字节无控制字符，`name` ≤64 码点，`maxTokens` 1..128000 缺省 32768，推理模型必带非空升序 `efforts`）；`selectableEfforts` :83、`defaultEffort` :88、`effectiveComposer` :116（模型不在白名单取缺省）都吃 `CatalogModel` / `ModelCatalog`。`agent-config.ts:77-90` 解析 `MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`（只设其一即视为无上游，`server.ts:190-191`），:237-243 用 `http.validateHeaderValue`（:239）校验密钥。
- 装配：`server.ts:96` `STARTUP_MODULES` 固定七项；:137 把 `config.modelCatalog.defaultModelId` 交给 `SessionRuntime.modelId`（消费者：`app.ts:210-216`（`modelId` :214）无 assembly 时的回落、:218 `resolveModelCatalog`；`supervisor.ts:80` 注释）；:425 阶段 `app`（`createApp`），:476 主 `listen`，:497 `await owned.preview.listen(...)`（让出事件循环），:541-545 阶段 `models_yml` 调 `writeManagedModelsYml(ompAgentDir, {proxyBaseUrl, models})`、紧接 `host_overlay` 调 `writeHostOverlay(stateDir, {browserEnabled, visionModelId})`（`host-overlay.ts:207-241`）。启动阶段枚举 `server.ts:302-313`（`config|db|app|listen|state_layout|sandbox_root|preview_listen|models_yml|host_overlay|preview_cache|publish`）；逐阶段 `reason` 用例在 `server/test/server-startup-failure-reason.test.ts:144-328`（`db` 例 :152、`app` 例 :160，新阶段的用例落在两者之间）。`app.ts:218-220` `modelCatalog = assembly?.modelCatalog ?? resolveModelCatalog({MODEL_ID: runtime.modelId})`、`registry = assembly?.models ?? staticRegistry(modelCatalog, assembly?.upstream)`、`registerModelProxy(app, { tokens, models: registry })`（组 4 后）；:244 `composer: {approvalMaxMode, modelCatalog}`；:252 `redactUpstream: upstreamRedactor(assembly?.upstream, runtime)`，:340-362 只用单一 `upstream` 调 `upstreamSecretList`——**会话侧净化只认 env 上游**（规格 upstream-failure「上游原文净化」:55 同样把密钥集定义为配置的 `MODEL_UPSTREAM_*`）。
- 代理：`model-proxy/index.ts:38-47` `ModelProxyOptions {tokens, upstream?, allowedModels}`；:91-96 注册时 `upstreamLink(options)` 算一次（:148-159 `upstreamSecretList({apiKey, baseUrl})`）；:263-272 `authenticate`：无效 bearer 401，`upstream === undefined` → 502；:161-221 `parseJsonBytes` 在媒体 / 大小 / JSON 检查后以 `isAllowedModel(JSON.parse(text), text, allowedModels)` 查白名单（`model-guard.ts` 原文顶层 `model` 扫描）。规格 model-proxy「透传端点与 bearer 鉴权」:67-162；「假上游夹具契约」:8-66——`server/test/support/fake-upstream.mjs:123` 对非 POST 或其它路径一律 404，**没有 `GET /models`**。
- 托管写出器：`models-yml.ts:14-32` `writeManagedModelsYml`（空列表拒绝；`replaceFile` 原子替换 0640）；`modelLines` :37-63 恒写 `reasoning` 与 `input`。omp 只在 spawn 时读 `models.yml` 与 overlay（`process.ts:102` `--model workbuddy/<id>`）；运行中的进程不重读——对 spawn 后才登记的模型发 `set_model` 的真实行为已由 D19 的官方 omp 用例实测为被拒（应答见 D19）。
- 派发对齐：chat-sessions「派发前按会话设置对齐进程」:640-：第 1 步只按档位决定退役重启；`composer-align.ts:29-34` `reusable()` 只看档位，:45-61 `alignModel` 模型不同就发 `set_model`（:50-51），:39-43 注释「拒绝即派发前失败并退役 slot」；`supervisor.ts:448-451` 档位不同 → `#retireSlot` + `fresh()`，:461-463 对齐后取进程失败的 `ReadmissionRequired` 重新准入、其它错误直接抛给调用方。
- composer：`rest-composer.ts:34-60` `GET /api/composer/options`（body 恰四键，web `composer-contract.ts:100` 严格键集）；`store-composer.ts:26` `ComposerConfig = Parameters<typeof effectiveComposer>[1]`，:104-107 写入时读 `config.modelCatalog`；`composer-align.ts:22`、`store-view.ts:76`、`rest-composer.ts:41` 都经 `ComposerConfig` 读。web `composer-options.ts:9-27`「每个 client 取一次」+ `invalidate()`（`use-chat-session.ts:229,550,610` 在内部使用；:756-793 的返回对象里**没有**它，`page.tsx:108`、`conversation-view.tsx:92/96` 向下传的是 `composerOptions`）；`model-picker.tsx` 用拷入层 dropdown-menu；规格 chat-web「输入框与能力栏」:670 把重取触发列为封闭列表；既有计数用例 `web/test/chat-composer-options.test.tsx:561-570`（带 `modelId` 的 patch 失败：`asked` 恰 1）与 :588-609（deferred 队列 `[FIRST, refetch, FIRST]`）在步骤里打开模型菜单选模型，D16 落地后各多一次重取。
- 错误码：`core/errors/index.ts:5-22` 十六码冻结表；`http/errors.ts` 状态映射（403 只有 `account_disabled`、`sandbox_denied`），:56-74 `CONTENT_PARSER_OWNED_ROUTES` 即归属集。计数守卫三处：`http-typed-errors.test.ts:123`、`auth-lifecycle.test.ts:705-724`（`codes` 表 `satisfies Record<HttpErrorCode,…>` 加编译期穷尽守卫——增码必须补两条条目，不是改计数字面；该文件 788 行）、`http-parser-owners.test.ts:50,271`（`SIXTEEN_CODES` 与 `HTTP_ERROR_MESSAGES` 键集相等）；另 `http-typed-errors.test.ts:144-158`「五种 409 以 code 区分」以 `toEqual` 钉死五个 409 码并断言 message 集合 `size` 为 5——加 `model_in_use` 后改为六；`sendHttpError`（`http/errors.ts:24-28`）不设 no-store，no-store 由路由负责，「两个 s1d 新码」场景经一条自设 no-store 的测试路由断言（沿 `http-typed-errors.test.ts:247-266` 的写法）；`docs/architecture/system.md:31` 写「十六码」，:29-31 core 模块表与 :100 目录树无 `core/roles`；归属身份清单在 `http-parser-owners.test.ts:28-29`；`server-assembly.test.ts:156` 断言模块注册次序。`http/path-classifier.ts:19-23`：`/api/*` 下任何经过百分号解码的路径一律改写为 typed 404（主规格 skeleton:237,244-245 钉住）——模型 id 不能进路径。管理员：`core/audit/index.ts:13` 私有 `ADMIN_ROLE = "管理员"`，唯一用处在 :81 `query()` 的可见性过滤（非管理员加 `actor_id = ?`，管理员见全部；守卫 `core-audit.test.ts:198`，`:11` 的 `管理员 ` 近似值为假）——这是必须保留的权限行为；`Principal {id, account, role}`（`auth/index.ts:32-36`）。
- 审计：`core/audit/index.ts:55-70` `emit(db, {kind, actorId, title, detail?, workspaceId?, ts?})`；既有 kind 形如 `workspace.create`、`session.browser`。
- 迁移：`server/src/core/db/migrations/` 止于 `045_chat_interleaved_segments.sql`（runner 经 `migration-assets.ts:13-15` `trackedMigrationAssets()` 读 :5 的 `TRACKED_MIGRATIONS_DIRECTORY`）；`server/test/core-db-helpers.ts:8-26` 每个文件一个 `MIGRATION_0NN` 常量、:27-47 `TRACKED_MIGRATION_FILENAMES`、:91-122 `COMPLETE_CATALOG.receipts` 止于 `[19, MIGRATION_045]`；`migration-045.test.ts:280-282` 绝对钉长度 19 与末项 045（:282 同时钉 `COMPLETE_CATALOG.sequenceRows` 的 19，`core-db-helpers.ts:113` 随之改 20）。新表还会碰到每个迁移都要同步的四处既有夹具（组 2 开工核对补记，先例为 045 的 `3fb1e02e`）：`auth-schema.test.ts:496-508` 的业务表全集、`core-db-session-fixture.ts:306-309` `preservedState` 的 `indexSql` 排除表清单（整表新建的表不进 ADD COLUMN 升级比对）、`core-db-chat-step-output.test.ts:69-85` 与 `migration-034.test.ts:258-275` 的「之后的迁移」排除清单。事务先例：`sessions/store-branch.ts:171` `runOwnedTransaction`（SQLite 不能嵌套 `BEGIN`）。
- 依赖规则：`docs/architecture/system.md:84-86`——feature 之间只允许显式声明的依赖，其余经 core；`models-yml.ts` 在 model-proxy、`host-overlay.ts` 在 sessions/omp。
- 前端：`web/src/routes/manifest.ts:29-35` `/center` 描述「中心暂不可用」；`web/test/topbar.test.tsx:191-201` 与另外五个经真实路由打开 `/center` 的用例（`chat-page-session-meta-support.tsx:119` 的 `leaveChatPage` 辅助、`chat-fork-button.test.tsx:592`、`chat-stop-button.test.tsx:448`、`chat-undo.test.tsx:726`、`chat-regenerate-button.test.tsx:625`）断言占位文案 `中心暂不可用`（来自 `router.tsx:71-75` 的 `PlaceholderPage` 读 `manifest.description`）；`web/e2e/ui-walk.spec.ts:75` 只在 ROUTES 表里有 `/center` 的 heading `中心`，`ui-walk-layout.ts:497-521` 的 `expectAuthenticatedRoute` 没有 `/center` 分支（成员 `zhangsan` 登录，`ui-walk-layout.ts:7`）；spa-shell「路由 IA 与侧栏」:24；`docs/acceptance/functional-checklist.md:53` SH-01（已签 `通过`）写「中心页只显示暂不可用的说明」。拷入层 `web/src/components/ui/` 现有 alert-dialog、dialog、input、label、radio-group 等，**没有** `tabs`、`table`、`checkbox`（`tabs` 已由组 9 拷入；表单无下拉字段，不拷 `select`）；覆盖层统一接 `useEscapeFallback`（`web/src/components/escape-fallback.ts`）。`features/settings/page.tsx` 的 `SettingsSection` / `SettingsRow` 是卡片页样式参照。验收清单节前缀 LG / SH / CH / SL / FL / ST。
- 行数（size-guard 800）：`server.ts` 743、`app.ts` 494（组 4 后）、`model-proxy/index.ts` 539、`use-chat-session.ts` 795、`auth-lifecycle.test.ts` 788。
- 假 omp：`server/test/support/fake-omp-proxy.mjs:2` 固定读 `models.yml` 的第一条模型 id 发起回合——假 omp 上的回合只能以列表第一个模型跑。

## Goals / Non-Goals

**Goals:**

- 管理员在 `/center?tab=models` 登记 OpenAI 兼容模型（每模型自带 base URL + 密钥）、改、删、设缺省、探活；改动后新建 / 新 spawn 的会话走新模型，不重启服务；存活进程对新模型的第一条消息也成功（先退役再 spawn）。
- 白名单只有一个来源（注册表快照）：composer options、有效值解析、`models.yml`、overlay 看图角色、代理放行、会话侧净化密钥集六处读同一份。
- 代理按请求体 `model` 选上游与密钥；密钥不进 omp 环境、不进响应、不进审计、不进日志、不进会话 `detail`（CONTEXT.md 不变量 #4 与既有净化纪律）。
- 升级无感：表空时 env 原样种子，`make dev` 零配置与 CI 假上游都不改启动方式；主端口绑定前快照已就绪。
- `/center` 有一个可承载后续 tab 的壳（`?tab=`、tab 表、管理员可见性、空态）。

**Non-Goals:**

- 嵌入 / 重排模型的登记（PLAN §3.3）：kb-service 未立项，YAGNI；计划 F-CTR-MOD 只写「登记 + 探活」、P4 把嵌入模型当 onnx 部署产物，与此一致。
- 非 OpenAI 兼容协议：owner D2 定 OpenAI 兼容。
- 账号级模型可见性 / 按账号启停、配额计量：ADR-0008 重开条件未触发。
- 密钥加密存储、密钥轮换提醒：DB 文件 0600 已与 env 同一信任级别（ADR-0008 补充记录）。
- 运行中 omp 进程的热切换：owner D5——新 spawn 生效；在途进程继续用旧模型直到回收或下一次派发触发重启。
- 模型 `id` 重命名（`PUT` 不改 `id`；删了再建）。
- 导入 / 导出注册表、批量登记；周期性自动探活。
- 中心其它 tab（专家、技能、连接器归 S1d 另三个 change；知识库、权限、审计、账号归后续阶段）。
- `--tools` 对 MCP 工具的过滤实测（grill 开放项 3）：与本 change 无关，只登记。

## Decisions

### owner 的裁定（2026-10-21，grill，已定，不是选项）

| 分支 | 结论 | 由谁定 |
|---|---|---|
| S1d 拆几个 change | 4 个：模型注册表、专家 + 技能（含中心外壳里的 tab）、连接器、S1b 挂载另算 | owner Q1 |
| 模型来源 | DB 注册表取代 env；env 只作首次种子 | owner Q5 |
| 上游协议与凭证 | OpenAI 兼容；每模型 base URL + 密钥存 DB，代理按模型路由 | owner D2（连接器那题的「凭证存 DB」同一精神，本 change 沿用） |
| 探活 | http 做握手探活（对上游发一个真实请求），不做 stdio | owner D3 |
| 缺省模型 | 管理员设全局缺省；账号最近选择（`account_composer_prefs`）不动 | owner D4 |
| 生效方式 | 变更即重写托管文件，新 spawn 生效，页面按需重取 | owner D5 |
| 谁能管 | 模型 tab 仅管理员（「专家人人可自建，其余仅管理员」） | owner Q8 |
| 中心入口 | 中心改账号缺省；会话级能力走输入框「能力」弹层（属专家 + 技能 change，本 change 不碰） | owner R5 |

### 起草者的技术决定

- **D1 注册表模块**：`server/src/models/`——`store.ts`（纯 DB；写方法自持事务（本地事务小函数，沿 `auth/session.ts:90-119`）并接受 `within?: (row) => void` 在 COMMIT 前同事务调用——审计由调用方经它写入，见 tasks 2.5；校验、CRUD、缺省、种子、探活结果写入；抛 `HttpError`；导出 `{list, get, routeOf, create, update, remove, setDefault, seedIfEmpty, recordProbe, toCatalog, secrets}`，`routeOf(id)` 与 `secrets(): readonly string[]`（按 upstream-failure 密钥集规则从全部行导出）是仅有的两个返回密钥材料的读，只供 `registry` 使用）、`registry.ts`（进程内快照：`current(): ModelCatalog`、`lookup(id)`、`secrets(): readonly string[]`（按 upstream-failure 密钥集规则导出的字符串列表）、`refresh()`；每次写入后从表重读一次刷新——单进程，不做跨进程失效）。接口 `ModelRegistry = {current, lookup, secrets, refresh}` 是代理（`lookup`、`secrets`）、composer（`current`）与净化闭包（`secrets`）共用的一个对象；`model-proxy/lookup.ts` 的 `staticRegistry(catalog, upstream?)` 实现同一接口（`refresh` 空操作）作为静态测试接缝、`publish.ts`（串行重写两个托管文件）、`probe.ts`、`rest.ts`。快照是同步读：`ComposerConfig.modelCatalog` 改为 getter（`get modelCatalog() { return registry.current(); }`），四处调用方（`rest-composer.ts:41`、`store-view.ts:76`、`composer-align.ts:22`、`store-composer.ts:104`）不改签名、不得把 `modelCatalog` 缓存到模块级。`models` 模块不导入 model-proxy 与 sessions：两个写出器以函数注入 `createPublisher`（依赖规则 system.md §4 不变）。
- **D2 启动阶段与种子**：新阶段 `model_registry` 位于 `db` 之后、`app` 之前（种子插入与首次 `refresh()` 都是同步 node:sqlite 操作，不依赖 listen；createApp 拿到的注册表已填好，主端口绑定后的第一个请求就读到快照——沿 #1337 / B4「首请求时状态已在」的既有纪律）。表空 → 把 `config.modelCatalog.models` 逐项插入（次序即 `created_at` 次序），`defaultModelId` 那项 `is_default = 1`，每项 `upstream_* = MODEL_UPSTREAM_*`（**未同时配置**时两列都 NULL，与今天「未同时配置即无上游」相同；env 的 base URL 原样写入、不套 REST 地址规则——含 userinfo 时由组 7 的视图去掉 userinfo 再回显）；`created_at` 取同一基准时刻 + 下标，严格递增，`list()` 次序即 env 次序；判空与全部插入在一个事务里，任一插入失败表保持为空；表非空 → 不写，六键任一设置了就经受管 stderr writer 写一行 `{"event":"model_env_ignored"}`（只此一键）。阶段任一步抛出 → `reason: "model_registry"`。`agent-config.ts` 对六键的校验原样保留（非法值仍 `config` 失败）。发布（`models_yml` / `host_overlay`）仍在 listen 之后：`createPublisher` 的 `proxyBaseUrl` 是 getter（与 `preview.port` 同一模式），在 `models_yml` 阶段之前的 REST 写入只刷新快照、不发布（`publish()` 在 base URL 未知时直接返回；启动阶段随后整体发布一次）。
- **D3 表结构（046，`server/src/core/db/migrations/046_models.sql`）**：`models(id TEXT PRIMARY KEY, name TEXT NOT NULL, reasoning INTEGER NOT NULL CHECK (reasoning IN (0,1)), vision INTEGER NOT NULL CHECK (vision IN (0,1)), max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 128000), efforts TEXT NULL, upstream_base_url TEXT NULL, upstream_api_key TEXT NULL, is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)), probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')), probe_at INTEGER NULL, probe_message TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((upstream_base_url IS NULL) = (upstream_api_key IS NULL)))` + `CREATE UNIQUE INDEX models_default ON models(is_default) WHERE is_default = 1`。`efforts` 是 JSON 数组文本；非推理 NULL；推理模型可为 NULL = 不声明强度集合（`models.yml` 不写 `thinking`，界面列全部六档，omp 自行推导）——零配置种子行与 REST 省略 `efforts` 都落这一形态。≤32 行由 store 在插入前计数保证。列表次序 `ORDER BY created_at, id`。
- **D4 校验复用**：把 `model-catalog.ts` 的单项校验提成导出的 `validateCatalogModel(input, {requireEfforts})`——env（`MODEL_CATALOG`）传 `requireEfforts: true`（规则不变），REST 传 `false`；错误仍只点名字段、不回显取值。`validateUpstream({baseUrl, apiKey})`：`baseUrl` 整体匹配 `^https?://[^\s#@]+$`（允许路径与查询串，禁止 userinfo——否则 `GET /api/models` 的 `baseUrl` 会把密码回显给其他管理员——与 fragment；显式空串非法）；`apiKey` 用既有 `http.validateHeaderValue("authorization", "Bearer " + 取值)`（从 `agent-config.ts:237-243` 提成共享函数），空串非法。
- **D5 代理契约**：`registerModelProxy(app, {tokens, models})`，`models: Pick<ModelRegistry, "lookup" | "secrets">`，即 `{lookup(id) → {upstream?: {baseUrl, apiKey}} | undefined, secrets(): readonly string[]}`（`exactOptionalPropertyTypes`：无上游是 `{}`）；顶层 `model` 的 id 由 `model-guard.ts` 新导出的扫描函数给出（`isAllowedModel` 委托它，判定只此一份）。检查次序：bearer（401）→ 媒体 / 大小 / JSON 语法 → 顶层 `model` 扫描（原规则不变）→ `lookup`：`undefined` → 400（不回显）；`upstream` 缺 → 502 `agent_unavailable`；否则用该模型的 `joinChatCompletions(baseUrl)` 与 `Bearer <apiKey>` 转发。**行为差异**（规格 delta 明写）：此前「未配置上游」在读 body 之前就 502，现在 body 不合法或模型未登记先 400。装配契约（唯一一条，三处用同一个对象）：`const registry = assembly?.models ?? staticRegistry(assembly?.modelCatalog ?? resolveModelCatalog({MODEL_ID: runtime.modelId}), assembly?.upstream)`——`AssemblyDependencies.models?: ModelRegistry`（生产装配传真注册表），`modelCatalog` / `upstream` 保留为静态测试接缝（十余个测试文件在用）；代理收 `registry`，composer 的 getter 读 `registry.current()`，净化闭包读 `registry.secrets()`；`SessionRuntime.modelId` 保留（无 assembly 时的回落）。5xx 节选的密钥集 = `models.secrets()` 加本请求 route 自己的 key / base URL（在途期间换密钥或删模型时旧值仍在）。`lookup` 本身抛出（真注册表首次 `refresh()` 之前；D2 保证 createApp 之前已 refresh，生产不可达）→ 502 `agent_unavailable`、不回显，后续请求照常（组 4 实现：`model-proxy/index.ts:251-255`，用例 `model-proxy-routing.test.ts:108`）。
- **D6 在途语义**：`lookup` 在每次转发前一刻调用；已转发的单次请求（含其流式响应）不受之后改动影响。删除模型或清空上游**不中断**任何服务端对象（进程、回合、审批都不动），但正在用该模型的回合的**下一次**上游请求会被代理答 400 / 502，回合以 `failed` 结束（上游失败分类按既有规则）；该会话下一条 prompt 按 `effectiveComposer` 回落缺省模型。派发路径第 1 步退役的 `await` 期间若发生删除并发布，以已删 id spawn 的新进程按既有「派发前失败」502 处理，不挂起。
- **D7 写入流水线**：每个写端点 = 校验 → 一个 SQLite 事务（表写入 + 审计 `emit`）→ `registry.refresh()` → `publish()`（单飞：同一时刻只有一次重写在跑，后到的等前一次完成后再以最新快照写一次、多次等待合并；`proxyBaseUrl()` 还是 null——`models_yml` 阶段之前——时直接返回，启动阶段随后整体发布）→ 应答（201 / 200 / 204）。`publish()` 抛出 → generic 500 + 经 `assembly.onPublishFailed?: (record: ModelPublishFailedRecord) => void`（`models/publish.ts` 导出该类型；与 `log` / `warn` sink 同一写法，`server.ts` 直接传 `writeRecord` 并把该类型加进其 union；未注入不写）一行 `{"event":"model_publish_failed"}`，DB 与审计保留、不回滚（回滚会让「已审计的变更不存在」）；下一次写入或启动再发布。启动的 `models_yml` / `host_overlay` 两阶段调同一个 `publish()`，两条路径字节相同；两个失败 reason 由 `server.ts` 注入的 `writeOverlay` 包装在 `stage === "models_yml"` 时切到 `host_overlay` 区分（`publish.ts` 不加分步接口；启动之后的发布不改 stage）。
- **D8 删除规则**：只有一条——`is_default = 1` 的行不能删（409 `model_in_use`）。恒有恰一行缺省，所以同时覆盖「最后一个模型」。`POST /api/models/default?id=` 在一个事务里清旧立新；对已是缺省的行 200、不审计、不发布。
- **D9 错误码**：加 `forbidden`（403，`没有权限执行此操作`）与 `model_in_use`（409，`该模型是缺省模型，先把缺省换成别的模型`）。备选「非管理员答 404」否决：中心页要能告诉普通用户「这是管理员功能」而不是「不存在」。`ADMIN_ROLE` 与 `isAdmin(principal)` 落 `server/src/core/roles.ts`，`core/audit` 改导入。
- **D10 REST 形状**：
  - `GET /api/models` → 200 `{models: ModelView[]}`，`ModelView = {id, name, reasoning, vision, maxTokens, efforts (数组或 null), upstream: {baseUrl, hasApiKey: true} | null, isDefault, probe: {status, at, message}, updatedAt}`；按列表次序。
  - `POST /api/models` body `{id, name?, reasoning?, vision?, maxTokens?, efforts?, upstream?: {baseUrl, apiKey}}`（键集严格；缺省同 `MODEL_CATALOG`；推理模型可不带 `efforts`；首个登记的模型自动成缺省——只在表为空时发生）→ 201；`id` 已存在 409 `conflict`；第 33 个 400。
  - `PUT /api/models?id=<id>` body `{name, reasoning, vision, maxTokens, efforts?, upstream: {baseUrl, apiKey?} | null}`（整体替换 `id` 以外的字段；推理模型省略 `efforts` 即 NULL；`apiKey` 省略 = 保留既有密钥，此时必须已有密钥否则 400；`apiKey` 省略且 `baseUrl` 等于已存地址去掉 userinfo 的视图形式 = 沿用已存地址（种子行 userinfo 不丢，组 10 落地于 `store.update`）；`upstream: null` 清空）→ 200。
  - `DELETE /api/models?id=<id>` → 204；缺省行 409 `model_in_use`。
  - `POST /api/models/default?id=<id>`、`POST /api/models/probe?id=<id>`（无 body）→ 200 `ModelView`。
  - 全部：未认证 401 先于一切；非管理员 403 `forbidden` 先于 body 解析与 id 查找；`id` 缺失 / 空 / 多值 400；未知 `id` 404；no-store。id 走查询参数而不进路径：`http/path-classifier.ts:19-23` 把 `/api/*` 下任何百分号编码的路径分量改写为 404（主规格钉住的守卫，不开口子），vLLM 风格的 `Qwen/Qwen2.5-72B-Instruct` 只能经 `?id=` 传。两个带 body 的路由进 content-parser 归属集（exact 400），两个无 body 的按 stop / regenerate 先例。模块 `models` 作为第八个 `STARTUP_MODULES` 在 accounts 之后注册。
- **D11 探活**：上游取自 `registry.lookup(id).upstream`；`GET <baseUrl 去掉结尾斜杠>/models`，`authorization: Bearer <apiKey>`，`accept: application/json`；建连期限 10 s、整体 15 s（常量在 `models/probe.ts` 自己定义，不导入 model-proxy（共用的错误正文读取器先从 `model-proxy/error-body.ts` 移到 `core/error-body.ts`））；不跟随重定向、不重试。2xx → `ok`、`message = null`；非 2xx → `failed`、`"HTTP <status>：<摘要>"`（`upstreamExcerpt` 的结果再截到 200 码点：超出保留前 194 个码点接 `…（已截断）`）；连接被拒 / 重置 / DNS → `"无法连接"`；两个期限到期 → `"超时"`；没有上游 → 不发请求、`"未配置上游"`。不触发 `publish()`，记审计 `model.probe`（detail `{modelId, status}`）。同一模型并发探活串行（`rest.ts` 内按 id 的 Promise 链，结算即删条目）；在途期间该行被删 → 结果丢弃、404（`store.recordProbe` 的 `changes === 0`；探活前 `store.get(id)` 不存在即 404、不发请求）。2xx 不核对 `data[].id`（Not yet specified）。HTTP 客户端为 `node:http(s).request`（不跟随重定向）；非 2xx 正文经 `core/error-body.ts` `readErrorBody`（本组从 `model-proxy/` 原样移入 `core/`，与 `upstream-failure.ts` 同层；16 KiB / 5 s，`cut` 传给 `upstreamExcerpt`）；2xx 正文不读（`response.resume()` 后即结算）；整体期限在读非 2xx 正文期间到期 → `超时`；摘要净化集 = `registry.secrets()` ∪ 所探上游自身的 `upstreamSecretList`（在途期间被 `PUT` 换掉的旧密钥仍被去掉，同 D5）。期限经 `AssemblyDependencies.probeDeadlines?` 注入（生产不传）。
- **D12 审计**：kind `model.create` / `model.update` / `model.delete` / `model.default` / `model.probe`；title 中文；detail 只含 `{modelId, name?, upstreamChanged?: boolean, status?}`——没有 base URL、密钥、探活摘要。`upstreamChanged`：create 为「带了上游」；`PUT` 为「`upstream` null 与非 null 互换，或 base URL 不同，或给出了 `apiKey`」。
- **D13 overlay 与 `SessionRuntime.modelId`**：`publish()` 每次按快照算 `visionModelId`，`writeHostOverlay` 的内容规则不变，但写入时机多了「随发布重写」、看图块来源改为快照——omp-runtime「宿主 overlay」出 delta（「启动期确定、此后不变」改为「快照的纯函数」）。`SessionRuntime.modelId` 保留，生产装配取快照缺省。
- **D14 `/center` 外壳**：`web/src/features/center/page.tsx` + `tabs.ts`（`CENTER_TABS: readonly {key, label, adminOnly, Panel}[]`，`Panel` 为面板组件；`CenterPage` 收可选 prop `tabs`（缺省 `CENTER_TABS`）供用例注入；空态文案是 `page.tsx` 自有常量，与 routeManifest description 无关；管理员判定为 `web/src/lib/roles.ts` 的 `isAdmin`（`role === "管理员"` 严格相等，`quick-login.tsx` 的局部 `ADMIN_ROLE` 改导入它））；`?tab=<key>` 不在可见 tab 里 → replace 为第一个可见 tab；没有可见 tab → 空态「中心暂无可用内容」且不改 URL。外壳组以**空表**合入（人人看到空态；SH-01 改写为空态文案并回到 `待签`），模型 tab 组追加 `{models, 模型, adminOnly}`。tab 条用拷入层 `tabs`（按 ADR-0013 拷入 `tabs`、`table`、`checkbox` 三个组件——外壳组拷 `tabs`，模型 tab 组拷 `table`、`checkbox`；radix-nova 的裸 `data-*` 变体由组 10 在 `theme.css` 一次绑定，#1706）。页内 heading 归顶栏。
- **D15 「模型」tab**：`features/center/models/`——列表（`table`）、表单对话框（`dialog` + `input` + `checkbox`；`efforts` 六个复选，视图为 null 的推理模型预填一个都不勾并旁注语义，一个都不勾则提交不带 `efforts`）、删除确认（`alert-dialog`）；两个对话框接 `useEscapeFallback`。提交前客户端按服务端同一规则逐字段校验并显示具体原因（服务端 400 的固定文案只作兜底）。API 客户端 `web/src/lib/api-models.ts`（六方法；查询参数 `id` 经 `encodeURIComponent`；严格解析），`api.ts` 导出类型。保存成功且 `upstream` 有改动（新建带上游；编辑后视图有上游且地址与打开时不同或填了密钥）时页面紧接着调 `probeModel` 一次（服务端不隐式探活）；编辑种子行只改名时，服务端把与视图形式相同的地址按已存地址（含 userinfo）写回，不丢凭证、`upstreamChanged` 为 false。客户端细节（碰过的键、校验六类文案、错误分流、固定文案）以 tasks 10.2 为准。每次操作成功后重取列表；收到非信封 500（发布失败）同样重取并在页顶显示 `REQUEST_FAILED_MESSAGE`。
- **D16 模型菜单重取**：`model-picker.tsx` 的模型 `DropdownMenu` `onOpenChange(true)` 时调 `invalidate()`。`use-chat-session.ts` 的返回对象加一行 `invalidateComposerOptions: composer.invalidate`（795 → 796 行，仍在上限内；这是该文件唯一允许的改动），经 `page.tsx` / `conversation-view.tsx` 既有的 props 链传到 picker。hook 契约不变；chat-web「输入框与能力栏」的触发列表加一项，并注明既有计数场景的断言按「除模型菜单打开引发的之外」计——`chat-composer-options.test.tsx:561-570` 与 :588-609 两个用例随之调整（各多一次 `getComposerOptions`）。
- **D17 文档**：ADR-0008 加「2026-10-21 补充（s1d-model-registry）」；`system.md` 加「模型注册表」一节、启动阶段表加 `model_registry`、§4 不新增 feature 依赖（写出器注入）；`IMPLEMENTATION_PLAN.md` F-CTR-MOD 行指向本 change 并注明「对话模型；嵌入 / 重排随 kb-service」。
- **D18 会话侧净化密钥集**（Stage 3 三路同时命中）：`app.ts` 的 `upstreamRedactor` 不再接收 `assembly.upstream`，改为每次净化时现取 D5 那个 `registry.secrets()` 加两组路径（静态接缝下就是 `staticRegistry` 的 `secrets()`）；upstream-failure「上游原文净化」出 delta。没有这一条，经 UI 登记的密钥在上游 401 回显时会原文落进 `chat_messages` 并展示给普通用户。
- **D19 存活进程的模型集合**（Stage 3 三路同时命中）：每个 slot 记下启动时注册表快照的模型 id 集合；派发前对齐第 1 步在「档位不同」之外加「有效模型不在集合里」→ 退役 + 新准入（`reusable()` 返回 false，走 `supervisor.ts:448-451` 的 `!reusable` 分支 `#retireSlot` + `fresh()`——与档位不同同一路径；不发 `set_model` 给不认识它的进程；集合在 `#onNewSlot` 构造 slot 时经 `composer.modelCatalog` getter 读取）；集合里的照常 `set_model`。chat-sessions 出 delta。前提「omp 对未加载模型的 `set_model` 失败」以官方 omp 用例钉住；**实测（#1648，`omp-official-model-set.test.ts`，omp v18.12.3，2026-10-22 darwin-arm64）：被拒**——以只含 `m1` 的 `models.yml` 启动、启动后用生产写出器把 `m2` 加进去（等 2 s）：`get_available_models` 的 `workbuddy` 条目仍只有 `m1`（不热读文件）；`set_model{provider:"workbuddy", modelId:"m2"}` 的原始应答为 `{"type":"response","command":"set_model","success":false,"error":"Model not found: workbuddy/<m2>"}`（`runtime.command()` 只剩 `AgentUnavailableError: set_model failed`）；之后 `get_state` 仍报 `workbuddy/m1`，进程存活，下一回合的上游请求只点名 `m1`。对照：同一会话以新 spawn 在两模型文件上 `--resume`，同一 `set_model` 被接受、`get_state` 报 `workbuddy/m2`。前提成立，判据为必需。
- **D20 假上游 `GET /models`**：`fake-upstream.mjs` 加 `GET /models` 与 `GET /v1/models`（期望 bearer → 200 固定单模型列表；`start({modelsStatus})` 脚本非 2xx；401 的 `error.message` 回显所给 bearer，供净化用例当哨兵；`handle.modelsRequests()` 记录）；model-proxy「假上游夹具契约」出 delta；`requests()`（chat-completions 记录）不变。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 密钥、上游地址、测试主机不进任何被跟踪文件（夹具用 `fake-upstream.mjs` 与哨兵值）；审计 / stderr / 响应 / 错误 message / 会话 `detail` 永不含密钥与 base URL。
- 产品代码单文件 ≤800 行（`scripts/size-guard.sh`）；`auth-lifecycle.test.ts`（788）只补两条 `codes` 条目（→790），新断言进新文件；`use-chat-session.ts`（795）只加返回对象的一行（→796）；`server.ts` 的发布与种子两个阶段已在组 5 抽到 `server/src/startup-registry.ts`（硬上限 800）。
- 不新增 `.css`；组件只用拷入层（`web/src/components/ui/`），缺的按 ADR-0013 拷入流程加。
- 规格 delta 只改列出的 requirement；没列的逐字沿用主规格（MODIFIED 块与主规格逐字比对，差异只剩有意的编辑）。

## 规格影响

- 新 `model-registry`；MODIFIED `model-selection`（三条）、`model-proxy`（透传 + 假上游夹具）、`session-composer-settings`、`http-service-skeleton`（三条）、`spa-shell`、`upstream-failure`（D18）、`chat-sessions`（D19）、`chat-web`（D16）、`omp-runtime`「宿主 overlay」（D13）。
- 不改 `audit-core`（kind 自由）、`omp-test-harness`（chat-completions 记录不变；`GET /models` 的记录是夹具自己的 handle）。

## Risks / Trade-offs

- **密钥落 DB 明文**：与 env 同级（都是 app-server 进程可读、0600 文件 / 进程环境）；备份 DB 即备份密钥——ADR-0008 补充写明。加密需要密钥管理，YAGNI。
- **代理检查次序变化**：未登记模型 + 无上游从 502 变 400。只影响没有上游的部署的错误码。
- **`publish()` 失败后的半状态**：DB 已改、文件没改到，直到下次成功的写入发布或重启。可观察（500 + `model_publish_failed`），接受。其间每次派发到未发布的模型都是新 spawn → `set_model` 被拒（`Model not found`）→ 退役 → 502，直到下一次成功发布为止——不是「一次 502 后自愈」（那只对下面的窄窗口成立）。另：同一 id 的 `PUT` 改了 `reasoning` / `vision` / `maxTokens` 时，存活进程仍用 spawn 时 `models.yml` 的旧条目（模型集合只记 id），直到进程被回收或因档位 / 新模型重启；规格允许（omp 只在 spawn 时读文件）。
- **D19 多一次重启**：登记新模型后，每个存活会话切到它的第一条消息多一次 spawn（与换档位同一代价）。
- **表非空时 env 被忽略**：`model_env_ignored` 一行 + 文档。
- **探活发出带密钥的请求**：只对管理员登记的 base URL、只在管理员点下时发。**接受的风险（owner 2026-10-22 确认接受）**：`PUT` 只改地址时保留已存密钥（spec「修改保留密钥与清空上游」），探活（组 10 改地址后自动探活）随即把该密钥发往新地址——任一管理员（或被劫持的管理员会话）可借此取出 API 从不回显的密钥；管理员也可让服务端向任意（含内网）地址发 GET 并读回 ≤200 码点摘要。管理员是受信角色，接受；重开条件：要求改地址必须重给密钥 / 限制出站目标。
- **探活跨 `PUT`**：探活开始后、完成前该行的上游被 `PUT` 改掉，结果按旧上游写在新配置上；下一次探活覆盖，接受。
- **`/center` 对普通用户是空态**：直到专家 / 技能 change 加入人人可见的 tab。
- **真实 omp 行为（已实测）**：D19 的前提（未加载模型的 `set_model` 被拒）由官方用例 `omp-official-model-set.test.ts` 钉住，v18.12.3 实测被拒（`Model not found: workbuddy/<id>`，确切应答见 D19）；omp 升级若改为热读 `models.yml`，该用例变红，判据仍保留（不依赖 omp 是否热读文件，代价是首次切到新登记模型时一次重启）。
- **refresh 与 publish 之间的窄窗口**：在这之间 spawn 的进程记下的集合含尚未写进 `models.yml` 的模型，可能触发一次派发前失败（502）后自愈；窗口是一次文件重写的时长，接受。

## Migration Plan

1. 组 1（错误码 + roles）、组 4（代理 lookup + 静态适配）、组 9（中心壳空表）、组 11（选择器重取）互不依赖，各自合入行为不变或可见面极小。
2. 组 2（046 + store + 种子纯函数）合入：迁移建空表，没有读者；组 3（注册表模块）随后（它读 store）。
3. 组 5（装配：阶段、种子、快照接管、净化闭包）合入：env 首次种子进表。回滚 = 回退代码，表留着无害。
4. 组 6（存活进程集合）、组 7（REST + 审计）、组 8（探活）、组 10（模型 tab + 文档验收）依次合入。
5. 不需要数据回填脚本；没有删除旧列。

## Not yet specified

- 嵌入 / 重排模型的登记与 kb-service 的消费（PLAN §3.3）：kb-service 未立项。
- 模型级的账号可见性 / 配额（ADR-0008 重开条件）。
- 密钥加密存储与轮换提醒。
- 探活核对 `data[].id` 含该模型（served name 与登记 id 不一致时现在显示「正常」）：要先看内网网关实际返回什么。
- 中心页对普通用户的默认 tab 与空态文案的最终形态：等专家 / 技能 tab 落地后看一眼。

## Open Questions

无（能改变规格、方案或任务切分的问题都已在 grill 里拍板；D9 的码表、D5 的次序变化与 D19 的重启判据是起草者按既有纪律细化，Stage 3 已审）。

## Sketch seams under test

- 组 1：`core/errors` 码表（十八码：`http-typed-errors.test.ts:123`、`http-parser-owners.test.ts:50,271`；`auth-lifecycle.test.ts:705-724` 的 `codes` 表补两条条目、标题改十八；两码的状态 / message 与兄弟互异断言进新文件 `http-typed-errors-s1d.test.ts`）；`core/roles.ts` 的 `isAdmin`（纯函数）；`core/audit` 既有用例不变。
- 组 2（种子不经 `validateUpstream`：env base URL 含 `@` 时逐字节入表）：`toCatalog(rows)` 纯函数；`046_models.sql`（迁移清单；部分唯一索引；上游两列同 NULL 的 CHECK）；`models/store.ts` 纯 DB 用例（`:memory:` + 真实迁移）：创建 / 重复 id 409 / 第 33 个 400 / `validateCatalogModel` 两种 `requireEfforts` 下的非法表 / 省略 `apiKey` 保留 / `upstream: null` / 删缺省 409 / 换缺省事务 / 已是缺省的幂等 / 种子（空表 + 缺省 + 单模型 `efforts` NULL + 只设一个上游键 → 两列 NULL；非空表不写）/ 列表次序 / `toCatalog(rows)` 与 `resolveModelCatalog` 对同一输入 `toStrictEqual` / 带 `/` 的 id。
- 组 3：`registry.ts`（`current` / `lookup` / `secrets` / `refresh`）与 `publish.ts`（注入的两个写出器被按序调用、字节 = 直接调用；`proxyBaseUrl` getter 未知时跳过；单飞合并；失败抛出）——纯函数 + 假写出器。
- 组 4：代理用例改用 `models` 夹具：未登记 400 不回显 / 登记无上游 502 / malformed + 无上游 400 / 两模型两个假上游各收自己的请求与 bearer / 500 摘要净化覆盖两个上游哨兵 / 转发后 lookup 改变不影响在途流；`staticRegistry(catalog, upstream?)`；官方 omp 用例照旧绿。
- 组 5（以 tasks 5.2 为准）：`server-startup-failure-reason.test.ts:144-328` 加 `model_registry`（`db` 之后、`app` 之前；迁移后 `DROP TABLE models` 换同名空视图）；编译入口 `server-startup-model-seed.test.ts`（零配置 / 三模型 + 上游哨兵 / 只设 base URL / 非空表 + `MODEL_ID` 的 `model_env_ignored` / 非空表 + 六键未设置零行 / 非空表 + `MODEL_CATALOG=not json` 仍 `config` / 主端口绑定后第一个 composer options 已是种子项 / `models.yml` 与 overlay 字节 = 既有基线；启动记录的模块数仍是七）；进程内 `startup-registry.test.ts`（`proxyBaseUrl()` 为 null 时写入 + `refresh` + `publish()` 不写文件、设定地址后发布一次按新快照——该场景唯一证据，外部进程无法确定性命中窗口；`writeOverlay` 包装只在 `models_yml` 阶段切 stage；六键 `env[key] !== undefined` 判定，env 作参数传入）；composer options「写入后不重启即变化」与甲乙缺省（store 直接写 + `refresh`）；会话侧净化：CI 可跑的 `session-registry-redaction.test.ts`（受控子进程经 createApp，沿 `session-message-error.test.ts:267-305`；store 写入哨兵密钥 + `refresh` 后 401 回显、`update` 换第二个密钥再断言；哨兵 base URL 不带 `@`）为主证据，官方 omp `omp-official-registry-secrets.test.ts`（`WORKBUDDY_OMP_TEST=1`）为真实二进制的本机证明；`server-upstream-failed-log.test.ts` 走注册表路径。（supervisor 重启判据与官方 omp「未加载模型的 set_model」用例归组 6，见 tasks.md 6.2。）
- 组 7：`models/rest.ts` 整体挂载：401 / 403 先于 body 与 id（五端点矩阵）/ `id` 缺失、空、多值 400 / 404 / 键集严格 / 201 视图不含密钥 / `PUT` 四例（含种子行与 `?id=Qwen%2F…`）/ `DELETE` 三例 / `default` 两例 / 四种审计 kind 与 detail 不含哨兵 / 归属二十一条身份（含 `POST /api/models/probe` 的身份，其 content-parser 400 用例在组 8）/ 三条新路由的 content-parser 400 / bodyless `default` 带 `{}` / 发布失败 500 + `onPublishFailed` 记录 + 行保留 + 恢复后再发布 / 启动记录八个模块（`server-assembly.test.ts:156` 的次序断言同步）/ 注册表写入不打断在途对象（假 omp 真子进程 + 假上游 `WORKBUDDY_FAKE_HANG` + 共享注册表的独立 `/v1` 注入 3 s 首字节期限：挂起期间 `PUT upstream: null` → 200、无退役、上游请求记录不增；两个回合都 `failed`，第二个回合假上游零新请求；424 / 502 的分类归组 4 代理层用例）；`make smoke` 的 hurl 加「登记 → composer options 含它 → 删除」。
- 组 8：`probe.ts`：假上游 `GET /models` 四种结果 + 无上游零请求 + 并发串行 + 在途删除 404 + stdout/stderr 无哨兵 + `models.yml` mtime 不变 + 200 码点截断 + probe 路由的 content-parser 400 与 403；假上游夹具自测（`GET /models` 三例；chat-completions 的 401 正文不变）。
- 组 9：`topbar.test.tsx:191-201` 与另外五个用例（`chat-page-session-meta-support.tsx:119`、`chat-fork-button.test.tsx:592`、`chat-stop-button.test.tsx:448`、`chat-undo.test.tsx:726`、`chat-regenerate-button.test.tsx:625`）的占位文案改为空态文案；新 `center-page.test.tsx`（空表：所有人空态、URL 不变；注入含 adminOnly tab 的表：管理员 tab 条、裸 `/center` 与 `?tab=unknown` replace、普通用户空态）；`e2e/ui-walk-layout.ts` 的 `expectAuthenticatedRoute` **新增** `/center` 分支断言空态文案；routeManifest 描述 `中心暂无可用内容`；SH-01 改写。
- 组 10：`web/test/center-models*.test.tsx`（假 `ApiClient`）+ `ui-variant-bindings.test.ts`（#1706）：列表 / 新增 input 只带碰过的键 + 自动探活恰一次 / 编辑省略密钥不探活、改地址探活 / 种子行 `efforts` null 的预填与提交 / 客户端逐字段校验 / 删除确认与 409 / 设缺省 / 探活在途禁用 / 500 后重取与页顶提示 / Escape 回退；真表下的「管理员与普通用户」场景（管理员见 `模型` tab 且选中、`?tab=nope` 被 replace、普通用户空态且 URL 不变）；routeManifest 描述 `模型注册表`；`api-models.ts` 严格解析与 `?id=` 编码；验收清单 CM 行格式；SH-01 的账号限定（成员账号空态；管理员的 tab 在 CM-04）。
- 组 11：`model-picker` 打开模型菜单恰一次 `invalidate()`、强度菜单不调（model-selection 两个场景）；`chat-composer-options.test.tsx:561-570` 与 :588-609 按「除模型菜单打开引发的之外」调整计数与 deferred 队列；`use-chat-session.ts` 返回对象多一行。

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/server.ts` | 743 | 组 5 后 778；组 7 后 787 | 组 5 已抽 `startup-registry.ts`；组 7 的 `STARTUP_MODULES`、union、`publish` / `onPublishFailed` 注入与 catch 入口 stage 捕获留在 `server.ts`（≤800 硬上限，不再抽取） |
| `server/src/model-proxy/index.ts` | 539 | ~560 | lookup 替换 allowedModels / upstream |
| `server/src/app.ts` | 491 | 组 7 后 537；组 8 ~545 | `staticRegistry` 装配、净化闭包、`registerModels`、`onPublishFailed`、`probeDeadlines` |
| `server/test/support/fake-upstream.mjs` | 699 | ~740 | `GET /models` 两条路由、`modelsStatus`、`modelsRequests()`；夹具自测进新文件 `fake-upstream-models.test.ts`（`fake-upstream.test.ts` 711 不加行） |
| `server/src/models/*.ts` | 新 | 各 ≤400 | store / registry / publish / probe / rest 分文件 |
| `web/src/features/center/*` | 新 | 各 ≤400 | page / tabs / models 分文件 |
| `web/src/features/chat/use-chat-session.ts` | 795 | 796 | 返回对象加一行（D16） |
| `server/test/auth-lifecycle.test.ts` | 788 | 790 | 补两条 `codes` 条目，新断言进新文件 |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` S1d F-CTR-MOD；PLAN §3.3「模型」。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0008（代理凭证，本 change 补充）、0010（专用 uid：DB 0600 的前提）、0012（overlay）、0013（前端栈）。
- 既有 change：`2026-10-20-omp-pin-18-12`（`models.yml` 恒写 `reasoning` / `input`）、s1g（白名单与 composer options）。
