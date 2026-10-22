# model-registry Spec Delta

## Purpose
模型注册表：管理员在数据库里登记 OpenAI 兼容的对话模型（每模型自带上游地址与密钥）、设全局缺省、探活；注册表快照是模型白名单的唯一来源，变更即重写托管文件、对新 spawn 与新请求生效。

## ADDED Requirements

### Requirement: 迁移 046 模型表
`server/migrations/046_models.sql` SHALL 建表 `models`：`id TEXT PRIMARY KEY`、`name TEXT NOT NULL`、`reasoning INTEGER NOT NULL CHECK (reasoning IN (0,1))`、`vision INTEGER NOT NULL CHECK (vision IN (0,1))`、`max_tokens INTEGER NOT NULL CHECK (max_tokens BETWEEN 1 AND 128000)`、`efforts TEXT NULL`（JSON 数组文本）、`upstream_base_url TEXT NULL`、`upstream_api_key TEXT NULL`、`is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1))`、`probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed'))`、`probe_at INTEGER NULL`、`probe_message TEXT NULL`、`created_at INTEGER NOT NULL`、`updated_at INTEGER NOT NULL`，表级 `CHECK ((upstream_base_url IS NULL) = (upstream_api_key IS NULL))`，以及部分唯一索引 `models_default ON models(is_default) WHERE is_default = 1`。迁移 SHALL 只建这张表与这个索引，不回填、不改其它表；`server/test/core-db-helpers.ts` 的跟踪清单 SHALL 加入 `MIGRATION_046`。

#### Scenario: 恰一个缺省
- **WHEN** 在迁移后的库里插入两行 `is_default = 1`；另一例插入一行 `upstream_base_url` 非空而 `upstream_api_key` 为 NULL
- **THEN** 第二次插入与另一例都被约束拒绝，表内容不变

### Requirement: 注册表快照是白名单的唯一来源
服务端 SHALL 在 `server/src/models/` 持有注册表：`store`（表的读写与校验）、`registry`（进程内快照 `current(): ModelCatalog` 与 `lookup(id)`）、`publish`（托管文件重写）。快照 SHALL 由表按 `created_at, id` 次序读出，每行映射为 model-selection「模型白名单配置」的白名单项 `{id, name, reasoning, vision, maxTokens, efforts?}`（`efforts` 列为 NULL 的行不带 `efforts`），`is_default = 1` 的行为缺省模型；每次写入提交后 SHALL 从表重读一次刷新快照（单进程，不做跨进程失效）。`GET /api/composer/options` 的 `models` 与 `defaults`、有效值解析（session-composer-settings「有效值解析」）、派发前对齐（chat-sessions「派发前按会话设置对齐进程」）、托管 `models.yml`、宿主 overlay 的看图角色与模型代理的放行（model-proxy「透传端点与 bearer 鉴权」）SHALL 全部读这一份快照，不再读启动配置。字段校验 SHALL 与 `resolveModelCatalog` 共用同一份规则（`validateCatalogModel`）：错误只点名字段、不回显取值。

#### Scenario: 写入后不重启即可见
- **WHEN** 管理员登记第二个模型 `m2` 并把缺省换成它，一个没有最近选择的账号随后请求 `GET /api/composer/options`，一个最近选择为 `m1` 的账号也请求一次
- **THEN** 两者的 `models` 都恰两项且次序为登记次序；前者 `defaults.modelId` 为 `m2`，后者仍为 `m1`（账号最近选择不动）；服务没有重启

#### Scenario: 删除模型后的回落
- **WHEN** 一个会话的 `modelId` 为 `m2`，管理员把缺省换回 `m1` 后删除 `m2`，该会话再发一条 prompt（假 omp 真子进程）
- **THEN** 假 omp 在 `prompt` 之前收到 `set_model{modelId:"m1"}`；会话行的 `model_id` 列不变（仍为 `m2`，有效值解析回落）；在途回合（若有）不被中断

### Requirement: 环境种子
启动阶段 `model_registry`（http-service-skeleton「服务启动与装配」）SHALL 在 `models` 表为空时把启动配置解析出的白名单逐项插入：次序即 `created_at` 次序，`defaultModelId` 那项 `is_default = 1`，每项的 `upstream_base_url` / `upstream_api_key` 取 `MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`（两者都未配置时两列为 NULL），单模型配置那一项的 `efforts` 列为 NULL。表非空时 SHALL NOT 写入任何行；此时 `MODEL_CATALOG`、`MODEL_ID`、`MODEL_REASONING`、`MODEL_VISION`、`MODEL_UPSTREAM_BASE_URL`、`MODEL_UPSTREAM_API_KEY` 中任一键被设置，SHALL 经受管 stderr writer 恰写一行 LF-terminated exact JSON `{"event":"model_env_ignored"}`（只有 `event` 一个键，无键名、无取值；写失败吞掉），位于 `server_started` 之前；六个键都未设置时不写这一行。六个键的解析与校验 SHALL 原样保留（非法值仍为 `reason: "config"` 的启动失败）。

#### Scenario: 空表种子等于启动配置
- **WHEN** 以 `MODEL_CATALOG` 为三模型 `[m1(推理,efforts 全六档), m2, m3(推理+看图, efforts low/high)]`、`MODEL_ID=m3`、`MODEL_UPSTREAM_BASE_URL` 与 `MODEL_UPSTREAM_API_KEY` 为哨兵值在空库上启动
- **THEN** `models` 表恰三行、次序 m1 m2 m3，`m3` 为缺省，三行的上游两列等于两个哨兵，`m1` / `m3` 的 `efforts` 为所给 JSON 数组、`m2` 为 NULL；托管 `models.yml` 与此前直接用该 `MODEL_CATALOG` 写出的字节相同；stderr 没有 `model_env_ignored`
- **WHEN** 以零配置（六个键都未设置、无上游）在空库上启动
- **THEN** 表恰一行 `{deepseek-v4.1-flash, reasoning 1, vision 1, max_tokens 32768, efforts NULL, 上游两列 NULL, is_default 1}`，`models.yml` 字节与此前零配置相同，启动成功

#### Scenario: 非空表忽略环境
- **WHEN** 表里已有一行 `m9`，分别以 `MODEL_ID=m1` 与以六个键都未设置启动
- **THEN** 两次表都不变、快照只有 `m9`；前者 stderr 恰一行 `{"event":"model_env_ignored"}`，后者没有
- **WHEN** 表非空且 `MODEL_CATALOG=not json`
- **THEN** 启动失败，`reason` 为 `config`（校验未因表非空而跳过）

### Requirement: 变更即发布
每次注册表写入（创建、修改、删除、换缺省；探活除外）提交后，SHALL 在同一请求内依次重写 `<agent dir>/models.yml`（model-proxy「托管 models.yml」的写出器，输入为快照）与 `host-overlay.yml`（omp-runtime「宿主 overlay」的写出器，`visionModelId` 为快照里第一个 `vision` 为真的模型，没有则 null），然后才应答。重写 SHALL 单飞：同一时刻只有一次在跑，期间到达的写入等它结束后再以最新快照重写一次（多次等待合并为一次）。启动阶段 `models_yml` 与 `host_overlay` SHALL 调同一个发布函数的两步，两条路径写出的字节相同。重写失败时 SHALL 应答 generic 500（不带典型信封），数据库与审计行保留，不回滚；下一次写入或启动再发布。正在运行的 omp 进程 SHALL NOT 被重启或通知：新 spawn 读新文件，下一次派发按快照对齐。

#### Scenario: 发布字节等于启动写出
- **WHEN** 在种子后的服务上登记带看图的 `m3`，再把服务以同样的表重启
- **THEN** 登记应答后 `models.yml` 含 `m3` 条目且 overlay 的 `modelRoles.vision` 为 `workbuddy/m3`；重启后的两个文件与登记后的字节相同

#### Scenario: 并发写入的单飞
- **WHEN** 两个管理员请求几乎同时创建 `a` 与 `b`
- **THEN** 两个请求都 201；最终 `models.yml` 恰含种子行与 `a`、`b`；重写次数不超过 3 次（每次都以当时的快照整体重写）

#### Scenario: 发布失败不回滚
- **WHEN** agent 目录被换成普通文件后管理员创建 `c`
- **THEN** 响应 500，`models` 表含 `c`，审计有 `model.create`；恢复目录后下一次成功的写入使 `models.yml` 含 `c`

### Requirement: 模型管理端点
sessions 之外的 `models` 模块 SHALL 注册六个端点，全部受既有 cookie guard 保护（未认证 401 先于一切）、只对角色恰为 `管理员`（`core/roles.ts` 的 `isAdmin`）的 principal 开放（其余 403 `forbidden`，先于 body 解析与 id 查找）、响应 `Cache-Control: no-store`、未知 `id` 404 `not_found`。视图 `ModelView` 恒为 `{id, name, reasoning, vision, maxTokens, efforts, upstream, isDefault, probe, updatedAt}`：`efforts` 为声明的数组或 `null`；`upstream` 为 `{baseUrl, hasApiKey: true}` 或 `null`；`probe` 为 `{status: "never"|"ok"|"failed", at: <epoch ms>|null, message: string|null}`。响应 SHALL NOT 含密钥。

- `GET /api/models` → 200 `{models: ModelView[]}`，按快照次序。
- `POST /api/models`：body 键集 SHALL 为 `{id, name, reasoning, vision, maxTokens, efforts, upstream}` 的子集且含 `id`，`upstream` 为 `{baseUrl, apiKey}`（两键都必填）；缺省与 `MODEL_CATALOG` 条目相同（`name = id`、布尔 `false`、`maxTokens` 32768；推理模型必带 `efforts`，非推理不得带）；`baseUrl` SHALL 整体匹配 `^https?://[^\s?#]+$`；`apiKey` SHALL 通过 `http.validateHeaderValue("authorization", "Bearer " + 取值)`。表为空时该行成为缺省。`id` 已存在 409 `conflict`；已有 32 行 400 `bad_request`；其它非法 400 `bad_request`。→ 201 `ModelView`。
- `PUT /api/models/:id`：body 键集恰为 `{name, reasoning, vision, maxTokens, efforts?, upstream}`，整体替换 `id` 以外的字段；`upstream` 为 `{baseUrl, apiKey?}` 或 `null`：`apiKey` 省略 SHALL 保留既有密钥（既无密钥则 400），`null` 清空两列。→ 200 `ModelView`。
- `DELETE /api/models/:id`：`is_default = 1` 的行 409 `model_in_use`；否则删除 → 204。
- `POST /api/models/:id/default`（无 body）：一个事务里把旧缺省清零、该行置 1 → 200 `ModelView`。
- `POST /api/models/:id/probe`（无 body）：见「探活」→ 200 `ModelView`。

每次写入 SHALL 在同一事务里记审计：kind `model.create` / `model.update` / `model.delete` / `model.default` / `model.probe`，actor 为请求 principal，`workspaceId` null，title 为中文（如 `登记模型 <name>`），detail 只含 `{modelId, name?, upstreamChanged?, status?}`——SHALL NOT 含 base URL、密钥或探活摘要。两个带 body 的路由属 content-parser 归属集（exact 400 `bad_request`）；两个无 body 的路由按 `POST /api/sessions/:id/stop` 先例（任意 body 即 400）。

#### Scenario: 权限与视图
- **WHEN** 匿名、普通账号与管理员各请求 `GET /api/models`；管理员以 `{id:"m2", upstream:{baseUrl:"https://gw.example/v1", apiKey:"<哨兵>"}}` 创建
- **THEN** 依次 401、403 `forbidden`（body 为统一信封）、200；创建 201，视图 `upstream` 为 `{baseUrl:"https://gw.example/v1", hasApiKey:true}`，响应与应用 stdout/stderr 不含哨兵；`GET /api/models` 列出种子行与 `m2`，审计有一条 `model.create`，detail 为 `{modelId:"m2", name:"m2", upstreamChanged:true}`

#### Scenario: 修改保留密钥与清空上游
- **WHEN** 管理员 `PUT /api/models/m2` body `{name:"深度", reasoning:true, vision:false, maxTokens:8192, efforts:["low","high"], upstream:{baseUrl:"https://gw2.example/v1"}}`；再 `PUT` 同 body 但 `upstream: null`；再对一个从未有密钥的模型 `PUT` 省略 `apiKey` 的 `upstream`
- **THEN** 第一次 200、`hasApiKey` 仍为 true 且代理转发该模型时带原密钥与新 base URL；第二次 200、`upstream` 为 null；第三次 400 `bad_request`，行不变

#### Scenario: 删除与缺省
- **WHEN** 管理员 `DELETE` 缺省模型；再 `POST /api/models/m2/default` 后 `DELETE` 原缺省；再 `DELETE` 一个未知 id
- **THEN** 依次 409 `model_in_use`（行不变）、200 后 204（`models.yml` 不再含原缺省；审计 `model.default` 与 `model.delete` 各一条）、404

#### Scenario: 非法 body 与归属
- **WHEN** `POST /api/models` 分别以 `{}`、`{id:"a", extra:1}`、`{id:"a", reasoning:true}`（缺 `efforts`）、`{id:"a", upstream:{baseUrl:"ftp://x"}}`、`{id:"a", upstream:{baseUrl:"https://x/v1"}}`（缺 `apiKey`）、第 33 个合法 body、malformed JSON、`text/plain` 媒体类型请求；`POST /api/models/m1/probe` 带 `{}` body
- **THEN** 全部 exact 400 `bad_request`，表与审计不变

### Requirement: 探活
`POST /api/models/:id/probe` SHALL 对该模型的上游发 `GET <baseUrl 去掉结尾斜杠>/models`，头 `authorization: Bearer <apiKey>`、`accept: application/json`，建连期限 10 s、整体期限 15 s，不跟随重定向，不重试。结果 SHALL 写入该行：2xx → `probe_status = 'ok'`、`probe_message = NULL`；其它状态 → `'failed'`、`probe_message = "HTTP <status>：<摘要>"`（摘要经 `upstreamExcerpt` 以全部已登记上游的 base URL 与密钥净化，整条 ≤200 码点）；无法建连 → `'failed'`、`"无法连接"`；超时 → `'failed'`、`"超时"`；模型没有上游 → 不发请求、`'failed'`、`"未配置上游"`。`probe_at` 为完成时刻。探活 SHALL NOT 触发托管文件重写，SHALL 记审计 `model.probe`（detail `{modelId, status}`）。同一模型的并发探活 SHALL 串行。密钥 SHALL NOT 出现在响应、审计、stdout/stderr。

#### Scenario: 四种结果
- **WHEN** 对上游为假上游（`GET /models` 答 200）的模型探活；对答 `401 {"error":{"message":"bad key <哨兵>"}}` 的探活；对指向未监听端口的探活；对指向只接受连接不应答的夹具（整体期限注入 1 s）探活；对没有上游的模型探活
- **THEN** 视图 `probe` 依次为 `{ok, <时刻>, null}`、`{failed, <时刻>, "HTTP 401：…"}`（不含哨兵）、`{failed, <时刻>, "无法连接"}`、`{failed, <时刻>, "超时"}`、`{failed, <时刻>, "未配置上游"}`；假上游记录恰一次 `GET /models` 且 bearer 为该模型密钥；最后一例假上游零请求；每次各一条 `model.probe` 审计；`models.yml` 的 mtime 不变

### Requirement: 中心页外壳
`/center` SHALL 由 `web/src/features/center/` 渲染：页内 tab 由查询参数 `?tab=<key>` 表示，tab 表 `CENTER_TABS: readonly {key, label, adminOnly}[]` 在 `tabs.ts`，本 change 只有 `{key:"models", label:"模型", adminOnly:true}`；可见 tab 为 `adminOnly` 为假或当前 principal 角色为 `管理员` 的项。`tab` 缺省、未知或指向不可见 tab 时 SHALL 以 replace 导航到第一个可见 tab；没有可见 tab 时 SHALL 渲染空态文案 `中心暂无可用内容` 且不渲染 tab 条。tab 条用拷入层 tabs 组件（`role="tablist"`，当前项 `aria-selected="true"`，切换只改 `?tab=`）。页面级 heading 仍归顶栏（spa-shell）。routeManifest 的 `/center` 描述 SHALL 为 `模型注册表`（随后续 tab 更新），不宣传未交付能力。

#### Scenario: 管理员与普通用户
- **WHEN** 管理员打开 `/center`；再打开 `/center?tab=nope`；普通用户打开 `/center?tab=models`
- **THEN** 前两次 URL 都变为 `/center?tab=models`，tab 条恰一项 `模型` 且选中；普通用户看到 `中心暂无可用内容`，没有 tab 条，URL 保持 `/center`（没有可见 tab 时不 replace）

### Requirement: 模型 tab
`/center?tab=models` SHALL 渲染模型表（拷入层 table）：每行 `id`、`name`、标签 `推理` / `看图`（按布尔）、`maxTokens`、上游（`已配置` / `未配置`）、探活（`从未` / `正常` / `失败：<message>` 与 `at` 的本地时间）、`缺省` 标记，以及行操作 `编辑`、`删除`、`设为缺省`（缺省行不渲染）、`探活`；表上方 `新增模型` 按钮。新增 / 编辑为对话框表单：`id`（编辑时只读）、`name`、`reasoning` / `vision` 复选、`maxTokens` 数字、`efforts` 六个复选（仅 `reasoning` 勾选时启用）、`上游地址`、`密钥`（编辑时 placeholder `留空保留现有密钥`，空即省略 `apiKey`）；提交恰调用一次 `createModel` / `updateModel`，在途禁用提交，失败在对话框内 `role="alert"` 显示 `ApiError.message`。保存成功且上游有改动（新建带上游；编辑改了地址或填了密钥）时 SHALL 紧接着恰调用一次 `probeModel`。`删除` 先弹确认（拷入层 alert-dialog，按钮 `取消` / `删除`）；`设为缺省` 与 `探活` 直接调用，在途禁用该行对应按钮。每次操作成功后 SHALL 重取 `listModels` 渲染。API 客户端 `web/src/lib/api-models.ts` SHALL 提供 `listModels` / `createModel(input)` / `updateModel(id, input)` / `deleteModel(id)` / `setDefaultModel(id)` / `probeModel(id)`，响应按 `ModelView` 严格解析（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型。

#### Scenario: 登记、编辑与探活
- **WHEN** 管理员点 `新增模型`，填 `id` `m2`、勾 `推理`、勾 `low` `high`、填地址与密钥，提交（假客户端返回视图）；随后编辑 `m2` 只改 `name`；再编辑改地址不填密钥
- **THEN** 第一次 `createModel` 的 input 恰为 `{id:"m2", reasoning:true, efforts:["low","high"], upstream:{baseUrl, apiKey}}`（未碰的键不发），随后恰一次 `probeModel("m2")`；第二次 `updateModel` 的 input 含 `upstream:{baseUrl}`（不含 `apiKey`）且没有探活；第三次有探活；每次成功后恰一次 `listModels`

#### Scenario: 删除与缺省
- **WHEN** 管理员对非缺省行点 `删除` 并确认；对另一行点 `设为缺省`；`deleteModel` 返回 409 信封
- **THEN** 确认后恰一次 `deleteModel`；`设为缺省` 恰一次 `setDefaultModel`，刷新后该行有 `缺省` 标记且不再有 `设为缺省` 按钮；409 时行内显示信封文案、行仍在
