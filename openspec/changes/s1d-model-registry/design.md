# Design: s1d-model-registry

## Context

事实基线（origin/master `c3c6bb53`，2026-10-21 读码；每组第一个任务核对行号）：

- 白名单解析：`server/src/model-catalog.ts:48-83` `resolveModelCatalog(env)` 纯函数（`MODEL_CATALOG` JSON ≤32 项，`{id,name,reasoning,vision,maxTokens,efforts?}`，`id` 1–128 UTF-8 字节无控制字符，`name` ≤64 码点，`maxTokens` 1..128000 缺省 32768，推理模型必带非空升序 `efforts`）；`agent-config.ts:77-90` 的 `resolveAgentSettings` 解析 `MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`（:241 header 合法性）。`effectiveComposer` :116（模型不在白名单取缺省）、`selectableEfforts` :86、`defaultEffort` :91 都只吃 `ModelCatalog`。
- 装配：`server.ts:137` 把 `config.modelCatalog.defaultModelId` 交给 `SessionRuntime.modelId`（`supervisor.ts:80` 注释：no spawn reads it）；`server.ts:541-549` 阶段 `models_yml` 调 `writeManagedModelsYml(ompAgentDir, {proxyBaseUrl, models})`，紧接 `host_overlay` 调 `writeHostOverlay(stateDir, {browserEnabled, visionModelId: models.find(vision)?.id ?? null})`（`host-overlay.ts:207-227`）。启动阶段枚举 `server.ts:302-314`（`config|db|app|listen|state_layout|sandbox_root|preview_listen|models_yml|host_overlay|preview_cache|publish`）。`app.ts:212-216` `modelCatalog = assembly?.modelCatalog ?? resolveModelCatalog({MODEL_ID})`，`registerModelProxy(app, {tokens, allowedModels: new Set(ids), upstream?})`；:241 `composer: {approvalMaxMode, modelCatalog}`。
- 代理：`model-proxy/index.ts:38-42` `ModelProxyOptions {tokens, upstream?, allowedModels}`；:91-96 注册时 `upstreamLink(options)` 算一次（:148-156 含 `upstreamSecretList({apiKey, baseUrl})`）；:262-271 `authenticate`：无效 bearer 401，`upstream === undefined` → 502 `agent_unavailable`；:166-210 `parseJsonBytes` 在媒体 / 大小 / JSON 检查后以 `isAllowedModel(JSON.parse(text), text, allowedModels)` 查白名单（原文顶层 `model` 扫描，`model-guard.ts`）。规格 model-proxy「透传端点与 bearer 鉴权」:67-100。
- 托管写出器：`models-yml.ts:14-31` `writeManagedModelsYml`（空列表拒绝；`replaceFile` 原子替换 0640）；`modelLines` :37-63 恒写 `reasoning` 与 `input`。
- composer：`rest-composer.ts:34-60` `GET /api/composer/options`（`composer.modelCatalog.models.map(...)`，body 恰四键，web `composer-contract.ts:100` 严格键集）；`store-composer.ts:26` `ComposerConfig = Parameters<typeof effectiveComposer>[1]`，:104-107 写入时 `config.modelCatalog`；`composer-align.ts:22` 派发前对齐。web `composer-options.ts:9-27`「每个 client 取一次」+ `invalidate()`（调用方 `use-chat-session.ts:229,550,610`）；`model-picker.tsx` 用拷入层 dropdown-menu。
- 错误码：`core/errors/index.ts:5-22` 十六码冻结表；`http/errors.ts` 状态映射（403 只有 `account_disabled`、`sandbox_denied`）；`http-typed-errors.test.ts:123`、`auth-lifecycle.test.ts:705` 断言「恰十六码」，`http-parser-owners.test.ts:28,49` 断言十七条归属身份。管理员：`core/audit/index.ts:13` 私有 `ADMIN_ROLE = "管理员"`，:81 唯一用处；`Principal {id, account, role}`（`auth/index.ts:32-36`）。
- 审计：`core/audit/index.ts:55-70` `emit(db, {kind, actorId, title, detail?, workspaceId?, ts?})`；既有 kind 形如 `workspace.create`、`session.browser`、`file.upload`。
- 迁移：`server/migrations/` 止于 `045_chat_interleaved_segments.sql`；`server/test/core-db-helpers.ts:8-27` 每个文件一个 `MIGRATION_0NN` 常量进 `TRACKED_MIGRATION_FILENAMES`。
- 前端路由：`web/src/routes/manifest.ts:29-35` `/center` 描述「中心暂不可用」；spa-shell「路由 IA 与侧栏」:24 「`/center` 明确展示暂不可用状态…`/center` 为扁平路由（页内 tab 属 S1d）」。`features/settings/page.tsx` 的 `SettingsSection` / `SettingsRow` 是卡片页的既有样式参照。验收清单节前缀 LG / SH / CH / SL / FL / ST（`web/test/functional-checklist.test.ts` 机械检查）。
- omp：托管 `models.yml` 与 `host-overlay.yml` 在 spawn 时被读（`--config` overlay，`process.ts:102` `--model workbuddy/<id>`）；运行中的进程不重读。

## Goals / Non-Goals

**Goals:**

- 管理员在 `/center?tab=models` 登记 OpenAI 兼容模型（每模型自带 base URL + 密钥）、改、删、设缺省、探活；改动后新建 / 新 spawn 的会话走新模型，不重启服务。
- 白名单只有一个来源（注册表快照）：composer options、有效值解析、`models.yml`、overlay 看图角色、代理放行五处读同一份。
- 代理按请求体 `model` 选上游与密钥；密钥不进 omp 环境、不进响应、不进审计、不进日志（CONTEXT.md 不变量 #4 与既有净化纪律）。
- 升级无感：表空时 env 原样种子，`make dev` 零配置与 CI 假上游都不改启动方式。
- `/center` 有一个可承载后续 tab 的壳（`?tab=`、tab 表、管理员可见性、空态）。

**Non-Goals:**

- 嵌入 / 重排模型的登记（PLAN §3.3「对话 / 嵌入 / 重排」）：kb-service 未立项，YAGNI；写入「Not yet specified」。
- 非 OpenAI 兼容协议（Anthropic / Gemini 原生）：owner D2 定 OpenAI 兼容。
- 账号级模型可见性 / 按账号启停、配额计量：ADR-0008 重开条件未触发。
- 密钥加密存储、密钥轮换提醒：DB 文件 0600 已与 env 同一信任级别（ADR-0008 补充记录）。
- 运行中 omp 进程的热切换：owner D5——新 spawn 生效；在途进程继续用旧模型直到回收。
- 模型 `id` 重命名（`PUT` 不改 `id`；删了再建）。
- 导入 / 导出注册表、批量登记。
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

- **D1 注册表模块**：`server/src/models/`——`store.ts`（纯 DB：校验、CRUD、缺省、种子、探活结果写入；抛 `HttpError`）、`registry.ts`（进程内快照 `current(): ModelCatalog` + `lookup(id)`；每次写入后从表重读一次刷新快照——单进程，不做跨进程失效）、`publish.ts`（串行重写 `models.yml` 与 overlay）、`probe.ts`、`rest.ts`。快照是同步读：`effectiveComposer` 等纯函数的调用方拿 `registry.current()` 再传入，`ComposerConfig.modelCatalog` 改为 getter（`get modelCatalog() { return registry.current(); }`），三处调用方（`rest-composer.ts:41`、`store-view.ts:76`、`composer-align.ts:22`、`store-composer.ts:104`）不改签名。
- **D2 种子语义**：启动阶段 `model_registry`（在 `preview_listen` 之后、`models_yml` 之前）：表空 → 把 `config.modelCatalog.models` 逐项插入（次序即 `created_at` 次序），`defaultModelId` 那项 `is_default = 1`，每项 `upstream_* = MODEL_UPSTREAM_*`（两者都未配置时为 NULL——`make dev` 零配置照常起，代理对该模型答既有的 502）；表非空 → 不写；此时六个 `MODEL_*` 键任一设置了，经既有受管 stderr writer 写一行 `{"event":"model_env_ignored"}`（只此一键，`sandbox_root_unchanged` 先例），不是失败。阶段任一步抛出 → `reason: "model_registry"`。`agent-config.ts` 对六个键的校验原样保留（非法值仍 `config` 失败——操作员的拼写错误不该因为表非空而被吞掉）。
- **D3 表结构（046）**：`models(id TEXT PRIMARY KEY, name TEXT NOT NULL, reasoning INTEGER NOT NULL CHECK (reasoning IN (0,1)), vision INTEGER NOT NULL CHECK (vision IN (0,1)), max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 128000), efforts TEXT NULL, upstream_base_url TEXT NULL, upstream_api_key TEXT NULL, is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)), probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')), probe_at INTEGER NULL, probe_message TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((upstream_base_url IS NULL) = (upstream_api_key IS NULL)))` + `CREATE UNIQUE INDEX models_default ON models(is_default) WHERE is_default = 1`。`efforts` 是 JSON 数组文本（推理模型必非 NULL；非推理 NULL——与 `MODEL_CATALOG` 的规则一致；种子时「单模型配置不带 efforts」的那一项例外地存 NULL 且 `reasoning = 1`，读出为不带 `efforts` 的 `CatalogModel`，`models.yml` 字节因此不变）。≤32 行由 store 在插入前计数保证（不用触发器）。列表次序 `ORDER BY created_at, id`。
- **D4 校验复用**：store 的字段校验与 `resolveModelCatalog` 共用一份规则——把 `model-catalog.ts` 里的单项校验（`isModelId`、name、maxTokens、efforts）提成可导出的 `validateCatalogModel(input): CatalogModel`，env 解析与 REST 都调它；错误仍只点名字段、不回显取值。`upstream.baseUrl` 规则：整体匹配 `^https?://[^\s?#]+$`（可带路径，如 `https://host/v1`；不带 query / fragment；显式空串非法）；`apiKey` 用既有 `http.validateHeaderValue("authorization", "Bearer " + 取值)`（`agent-config.ts:241` 同一判定），空串非法。
- **D5 代理契约**：`registerModelProxy(app, {tokens, models})`，`models: {lookup(id: string): ModelRoute | undefined}`，`ModelRoute = {upstream: {baseUrl, apiKey} | undefined}`；`secrets(): readonly string[]` 一并提供（全部已登记上游的 base URL 与密钥，净化用）。检查次序改为：bearer（401）→ 媒体 / 大小 / JSON 语法 → 顶层 `model` 扫描（原规则不变）→ `lookup`：`undefined` → 400 `bad_request`（不回显）；`upstream` 缺 → 502 `agent_unavailable`；否则用该模型的 `joinChatCompletions(baseUrl)` 与 `Bearer <apiKey>` 转发。**行为差异**（规格 delta 明写）：此前「未配置上游」在读 body 之前就 502，现在 body 不合法或模型未登记先 400；只有登记了但没上游的模型才 502。`app.ts` 的默认装配（无 assembly）给代理的是从静态目录生成的 lookup（`lookupFromCatalog(catalog, upstream)`），组 4 不依赖组 2 / 组 3。
- **D6 在途语义**：`lookup` 在转发前一刻调用，之后的改动不影响该请求（流式响应继续从旧上游读）。删除模型不中断任何在途请求与回合；下一次派发按 `effectiveComposer` 回落缺省模型（既有规则）。
- **D7 写入流水线**：每个写端点 = 校验 → 一个 SQLite 事务（表写入 + 审计 `emit`）→ `registry.refresh()` → `publish()`（单飞：同一时刻只有一次重写在跑，后到的等前一次完成后再写一次、合并多次等待；每次用快照重写 `models.yml` 再 `host-overlay.yml`，两者都是既有原子替换）→ 200。`publish()` 抛出 → 响应 generic 500，DB 与审计保留（注册表已经是真相，下一次写入或启动会再发布；不回滚——回滚会让「已审计的变更不存在」）。启动的 `models_yml` / `host_overlay` 两阶段改调同一个 `publish()` 的两步，保证两条路径字节相同。
- **D8 删除规则**：只有一条——`is_default = 1` 的行不能删（409 `model_in_use`）。因为恒有恰一行缺省，这同时覆盖「最后一个模型」：想删它先得把缺省换给别的模型，而只剩一个时换不了。`POST /api/models/:id/default` 在一个事务里清旧立新。
- **D9 错误码**：加 `forbidden`（403，`没有权限执行此操作`）与 `model_in_use`（409，`该模型是缺省模型，先把缺省换成别的模型`）。备选「非管理员答 404 隐藏存在」否决：中心页要能告诉普通用户「这是管理员功能」而不是「不存在」。`ADMIN_ROLE` 与 `isAdmin(principal)` 落 `server/src/core/roles.ts`，`core/audit` 改导入（core 不导入 http / feature，规则不变）。
- **D10 REST 形状**：
  - `GET /api/models` → 200 `{models: ModelView[]}`，`ModelView = {id, name, reasoning, vision, maxTokens, efforts (推理模型为声明数组或 null，非推理 null), upstream: {baseUrl, hasApiKey: true} | null, isDefault, probe: {status, at, message}, updatedAt}`；按列表次序。
  - `POST /api/models` body `{id, name?, reasoning?, vision?, maxTokens?, efforts?, upstream?: {baseUrl, apiKey}}`（键集严格，未知键 400；缺省同 `MODEL_CATALOG`：`name = id`、布尔 false、32768；首个登记的模型自动成缺省——只在表为空时发生）→ 201 `ModelView`；`id` 已存在 409 `conflict`；第 33 个 400 `bad_request`。
  - `PUT /api/models/:id` body `{name, reasoning, vision, maxTokens, efforts?, upstream: {baseUrl, apiKey?} | null}`（整体替换 `id` 以外的字段；`apiKey` 省略 = 保留既有密钥，此时必须已有密钥否则 400；`upstream: null` 清空上游）→ 200 `ModelView`。
  - `DELETE /api/models/:id` → 204；缺省行 409 `model_in_use`。
  - `POST /api/models/:id/default`（无 body）→ 200 `ModelView`。
  - `POST /api/models/:id/probe`（无 body）→ 200 `ModelView`（已含新探活结果）。
  - 全部：未认证 401 先于一切；非管理员 403 `forbidden` 先于 body 解析与 id 查找；未知 `id` 404 `not_found`；`Cache-Control: no-store`。两个带 body 的路由进 content-parser 归属集（exact 400），两个无 body 的按 stop / regenerate 先例（任意 body 即 400）。
- **D11 探活**：`GET <baseUrl 去掉结尾斜杠>/models`，`authorization: Bearer <apiKey>`，`accept: application/json`；建连期限 10 s（`DEFAULT_CONNECT_DEADLINE_MS`）、整体 15 s；2xx → `ok`、`probe_message = null`；非 2xx → `failed`、`probe_message = "HTTP <status>：<upstreamExcerpt(body)>"`（≤200 码点）；连接 / 超时 → `failed`、`"无法连接"` / `"超时"`；没有上游 → 不发请求，`failed`、`"未配置上游"`。探活不改其它列、不触发 `publish()`（探活结果不进 `models.yml`），但记审计 `model.probe`（detail `{modelId, status}`）。同一模型并发探活：后到的等前一次结束再发（与 publish 同样的单飞）。
- **D12 审计**：kind `model.create` / `model.update` / `model.delete` / `model.default` / `model.probe`；title 中文（如 `登记模型 <name>`）；detail 只含 `{modelId, name?, upstreamChanged?: boolean, status?}`——没有 base URL、没有密钥、没有探活摘要（摘要可能含上游回显）。
- **D13 overlay 的看图角色**：`publish()` 每次按快照算 `visionModelId`（第一个 `vision` 模型），`writeHostOverlay` 的内容规则不变（omp-runtime「宿主 overlay」不改），只是多了重写时机。`SessionRuntime.modelId` 改为取快照缺省（`supervisor.ts:80` 注释说没有 spawn 读它；任务 3 核对后若确无消费者则删字段）。
- **D14 `/center` 外壳**：`web/src/features/center/page.tsx` + `tabs.ts`（`CENTER_TABS: readonly {key, label, adminOnly}[]`，本 change 只有 `models`）；`?tab=<key>` 不在可见 tab 里（含缺省、未知、管理员专属对普通用户）→ replace 为第一个可见 tab；没有可见 tab → 空态「中心暂无可用内容」。tab 条用拷入层 `tabs`（shadcn）组件；页内 heading 归顶栏（spa-shell 规则不变）。后续 change 往 `CENTER_TABS` 追加。
- **D15 「模型」tab**：`features/center/models/`——列表（拷入层 `table`）、表单对话框（`dialog` + `input` + `checkbox` + `select`；`efforts` 为六个复选）、删除确认（`alert-dialog`）。API 客户端 `web/src/lib/api-models.ts`（`listModels` / `createModel` / `updateModel` / `deleteModel` / `setDefaultModel` / `probeModel`，严格解析同 composer-contract 纪律），`api.ts` 导出类型。保存成功且 `upstream` 有改动（新建带上游，或编辑改了 baseUrl / 给了新 apiKey）时页面紧接着调 `probeModel` 一次（服务端不隐式探活）。探活 / 保存在途各自禁用对应按钮；失败在对话框或行内显示 `ApiError.message`。
- **D16 模型菜单重取**：`model-picker.tsx` 的模型 `DropdownMenu` `onOpenChange(true)` 时调 `invalidate()`（props 新增）；在途与失败期间 `options` 仍是上一份（hook 既有规则），菜单内容在重取落地后更新。欢迎态与已选会话相同。强度菜单不重取。
- **D17 迁移文档**：ADR-0008 加「2026-10-21 补充（s1d-model-registry）」一节；`system.md` 加 9.x「模型注册表」；`IMPLEMENTATION_PLAN.md` F-CTR-MOD 行标记归属本 change。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 密钥、上游地址、测试主机不进任何被跟踪文件（夹具用 `fake-upstream.mjs` 与哨兵值）；审计 / stderr / 响应 / 错误 message 永不含密钥与 base URL（既有 `upstreamSecretList` 纪律）。
- 产品代码单文件 ≤800 行（`scripts/size-guard.sh`）；贴近上限的既有测试文件不再往里加，新用例进新文件。
- 不新增 `.css`；组件只用拷入层（`web/src/components/ui/`），按 ADR-0013。
- 规格 delta 只改列出的 requirement；没列的逐字沿用主规格。

## 规格影响

- 新 `model-registry`；MODIFIED `model-selection`、`model-proxy`、`session-composer-settings`、`http-service-skeleton`、`spa-shell`（见 proposal）。
- 不改 `omp-runtime`「宿主 overlay」（内容规则不变）、`audit-core`（kind 自由）、`chat-web`「输入框与能力栏」（模型菜单的重取写在 model-selection「模型与推理强度控件」里）。

## Risks / Trade-offs

- **密钥落 DB 明文**：与 env 同级（都是 app-server 进程可读、0600 文件 / 进程环境）；备份 DB 即备份密钥——ADR-0008 补充写明，部署文档提示。加密需要密钥管理，YAGNI。
- **代理检查次序变化**：未登记模型 + 无上游从 502 变 400。只影响没有上游的部署的错误码，CI 假上游不受影响。
- **`publish()` 失败后的半状态**：DB 已改、文件没改到，直到下次写入或重启。可观察（500 + stderr 原因不带路径），接受。
- **两份真相的窗口**：快照与表之间只有 `refresh()` 的一瞬；单进程、写入串行，接受。
- **表非空时 env 被忽略**：操作员改 env 以为生效——`model_env_ignored` 一行 + 文档。
- **探活发出带密钥的请求**：只对管理员登记的 base URL、只在管理员点下时发；不自动周期探活。
- **`/center` 对普通用户是空态**：直到专家 / 技能 change 加入人人可见的 tab。routeManifest 描述按真实内容写，不宣传未交付能力。

## Migration Plan

1. 组 1（错误码 + roles）与组 4（代理 lookup，静态 lookup 适配）各自独立合入，行为不变。
2. 组 2（046 + store + 种子纯函数）合入：迁移建空表，没有读者。
3. 组 3（装配）合入：启动种子 → 快照 → 发布；env 首次种子进表。回滚 = 回退代码，表留着无害。
4. 组 5（REST + 探活 + 审计）、组 6a（中心壳）、组 6b（模型 tab + 选择器重取 + 文档 / 验收）依次合入。
5. 不需要数据回填脚本；没有删除旧列。

## Not yet specified

- 嵌入 / 重排模型的登记与 kb-service 的消费（PLAN §3.3）：kb-service 未立项，字段与探活方式都说不清。
- 模型级的账号可见性 / 配额（ADR-0008 重开条件）。
- 密钥加密存储与轮换提醒。
- 中心页对普通用户的默认 tab 与空态文案的最终形态：要等专家 / 技能 tab 落地后看一眼。

## Open Questions

无（能改变规格、方案或任务切分的问题都已在 grill 里拍板；D9 的码表与 D5 的次序变化是起草者按既有纪律细化，Stage 3 可挑）。

## Sketch seams under test

- 组 1：`core/errors` 码表（十八码：`http-typed-errors.test.ts:123`、`auth-lifecycle.test.ts:705` 的计数与两码的状态 / message）；`core/roles.ts` 的 `isAdmin`（纯函数：`管理员` 为真、其它含 `管理员 ` 为假）；`core/audit` 行为不变（`audit-core` 既有用例）。
- 组 2：`migrations/046_models.sql`（`core-db-*.test.ts` 的迁移清单；部分唯一索引：两行 `is_default = 1` 被拒；`CHECK` 对上游两列同 NULL）；`models/store.ts` 纯 DB 用例（`:memory:`）：创建 / 重复 id 409 / 第 33 个 400 / `validateCatalogModel` 与 `resolveModelCatalog` 共用的非法表（沿用 model-selection「非法白名单使启动失败」的输入清单）/ 省略 `apiKey` 保留 / `upstream: null` 清空 / 删缺省 409 / 换缺省事务 / 种子（空表插入 + 缺省 + 单模型配置的 `efforts` NULL；非空表不写）/ 列表次序 / `toCatalog()` 与 `resolveModelCatalog` 对同一输入输出相等。
- 组 3：`server-startup-order.test.ts` 阶段序列（`model_registry` 的位置；失败 `reason`）；`model_env_ignored` 一行（表非空 + `MODEL_ID` 设置）与零行（未设置）；`publish()` 字节 = 既有 `writeManagedModelsYml` / `writeHostOverlay` 字节（`model-proxy-models-yml.test.ts`、`omp-host-overlay.test.ts` 的基线文件直接复用）；单飞（两次并发写入只产生按序的两次重写，最终文件等于最后快照）；`GET /api/composer/options` 读快照（写入后不重启即变化，`defaults` 对账号最近选择仍回落）；`composer-align` 在快照变化后下一次派发发 `set_model`（假 omp 真子进程：改缺省 + 删模型后的回落）。
- 组 4：`registerModelProxy` 的 `models.lookup` 夹具用例（既有 `model-proxy-*.test.ts` 改装）：未登记 400 不回显 / 登记无上游 502 / 两个模型两个假上游各收到自己的请求与自己的 bearer / 净化列表覆盖两个上游的哨兵 / 转发后 lookup 改变不影响在途流；`app.ts` 默认装配的 `lookupFromCatalog`；官方 omp 用例（`WORKBUDDY_OMP_TEST=1`）照旧绿。
- 组 5：`models/rest.ts` 整体挂载用例：401 / 403（普通账号，先于 body）/ 404 / 键集严格 / 201 视图不含密钥、`hasApiKey` / `PUT` 省略 `apiKey` / `DELETE` 缺省 409 / `default` 换缺省后 `GET /api/composer/options` 的 `defaults.modelId` 对无最近选择的账号变化、对有最近选择的不变（owner D4）/ 审计五种 kind 与 detail 不含哨兵 / 内容解析归属（`http-parser-owners.test.ts` 二十一条）；`probe.ts`：假上游 `GET /models` 2xx → ok、`WORKBUDDY_FAKE_STATUS` 风格的非 2xx → failed 摘要经净化、不可连 → `无法连接`、慢应答 → `超时`、无上游 → `未配置上游` 且零请求、应用 stdout/stderr 无密钥哨兵。
- 组 6a：`routes/ui-walk` 的 `/center`（管理员见 tab 条与 `模型`；普通用户见空态；`?tab=unknown` 被 replace）；routeManifest 描述断言。
- 组 6b：`features/center/models` 用例（假 `ApiClient`）：列表渲染 / 新增对话框提交 body / 编辑省略密钥 / 删除确认 / 设缺省 / 探活按钮与保存后自动探活恰一次 / 错误行内显示；`model-picker` 打开菜单恰一次 `invalidate()`；`api-models.ts` 严格解析；验收清单 CM 行格式（`functional-checklist.test.ts`）。

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/model-proxy/index.ts` | ~520 | ~540 | lookup 替换 allowedModels / upstream |
| `server/src/server.ts` | ~640 | ~670 | 新阶段 + publish 调用 |
| `server/src/models/*.ts` | 新 | 各 ≤400 | store / registry / publish / probe / rest 分文件 |
| `web/src/features/center/*` | 新 | 各 ≤400 | page / tabs / models 分文件 |
| `server/test/*` 贴近上限者 | — | — | 新用例进新文件 |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` S1d F-CTR-MOD；PLAN §3.3「模型」。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0008（代理凭证，本 change 补充）、0010（专用 uid：DB 0600 的前提）、0012（overlay）、0013（前端栈）。
- 既有 change：`2026-10-20-omp-pin-18-12`（`models.yml` 恒写 `reasoning` / `input`）、s1g（白名单与 composer options）。
