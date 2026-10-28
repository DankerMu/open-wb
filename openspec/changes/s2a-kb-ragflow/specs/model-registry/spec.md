## MODIFIED Requirements

### Requirement: 中心页外壳
`/center` SHALL 由 `web/src/features/center/` 渲染：页内 tab 由查询参数 `?tab=<key>` 表示，tab 表 `CENTER_TABS: readonly {key, label, adminOnly, requiresKb?}[]` 在 `tabs.ts`，依次为 `{key:"experts", label:"专家", adminOnly:false}`、`{key:"skills", label:"技能", adminOnly:false}`、`{key:"connectors", label:"连接器", adminOnly:false}`、`{key:"knowledge-bases", label:"知识库", adminOnly:false, requiresKb:true}`、`{key:"models", label:"模型", adminOnly:true}`、`{key:"mount-sources", label:"挂载源", adminOnly:true}`（`专家`、`技能` 与 `连接器` 三项见 experts「中心「专家」tab」、skill-switches「中心「技能」tab」与 connectors「中心「连接器」tab」，`挂载源` 见 workspace-mounts「中心「挂载源」tab」，`知识库` 见 knowledge-bases「中心「知识库」tab」）；可见 tab 为 `adminOnly` 为假或当前 principal 角色为 `管理员` 的项，且带 `requiresKb:true` 的项另须 `GET /api/kb/status` 应答为 `enabled:true`（中心页每次挂载读取一次；读取失败或在途时视为不可见，不阻塞其它 tab 的渲染，读到之后再按规则重算——当前 `?tab=knowledge-bases` 在读到之前不触发 replace 导航）。`tab` 缺省、未知或指向不可见 tab 时 SHALL 以 replace 导航到第一个可见 tab；没有可见 tab 时 SHALL 渲染空态文案 `中心暂无可用内容` 且不渲染 tab 条（按上面的 tab 表不会发生：`专家`、`技能` 与 `连接器` 对所有人可见；规则保留）。tab 条用拷入层 tabs 组件（`role="tablist"`，当前项 `aria-selected="true"`，切换只改 `?tab=`）。页面级 heading 仍归顶栏（spa-shell）。routeManifest 的 `/center` 描述 SHALL 与可见内容一致：按 tab 表次序连接对所有人可见（`adminOnly` 为假）的 tab 的 label——相邻两项之间用顿号 `、`，只有最后两项之间改用 `与`（只有一项时即该 label），仅管理员可见的 tab 与带 `requiresKb:true` 的 tab 不进描述（`模型` 与 `挂载源` 两个 tab 只对管理员可见，`知识库` 只在知识库开启时可见，描述不对所有部署宣传它们）——tab 表只有 `专家` 与 `模型` 时为 `专家`，只有 `专家`、`技能` 与 `模型` 时为 `专家与技能`，上面的完整 tab 表下为 `专家、技能与连接器`；不宣传未交付能力。

#### Scenario: 管理员与普通用户
- **WHEN** 管理员打开 `/center`；再打开 `/center?tab=nope`；再打开 `/center?tab=models`；普通用户打开 `/center?tab=models`；普通用户打开 `/center`
- **THEN** 管理员前两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条依次恰为 `专家`、`技能`、`连接器`、`模型`、`挂载源` 五项（假客户端的知识库状态为 `{enabled:false}`）且 `专家` 选中；第三次 URL 保持 `/center?tab=models`、`模型` 选中；普通用户两次 URL 都以 replace 变为 `/center?tab=experts`，tab 条恰为 `专家`、`技能`、`连接器` 三项（没有 `模型` 与 `挂载源`）且 `专家` 选中，页面不出现 `中心暂无可用内容`；routeManifest 的 `/center` 描述为 `专家、技能与连接器`

#### Scenario: 知识库 tab 随开关显隐
- **WHEN** 假客户端的 `GET /api/kb/status` 为 `{enabled:true, …}` 时管理员与普通用户分别打开 `/center`；为 `{enabled:false}` 时普通用户打开 `/center?tab=knowledge-bases`；状态请求挂起时普通用户打开 `/center?tab=knowledge-bases`，随后应答 `{enabled:true, …}`
- **THEN** 管理员 tab 条依次为 `专家`、`技能`、`连接器`、`知识库`、`模型`、`挂载源`，普通用户为 `专家`、`技能`、`连接器`、`知识库`，两者的 routeManifest 描述都仍为 `专家、技能与连接器`；`enabled:false` 时 URL 以 replace 变为 `/center?tab=experts` 且没有 `知识库`；挂起期间 URL 不变、不渲染 `中心暂无可用内容`，应答后 `知识库` 选中

### Requirement: 模型 tab
`/center?tab=models` SHALL 渲染模型表（拷入层 table）：每行 `id`、`name`、标签 `推理` / `看图`（按布尔）、`maxTokens`、上游（`已配置` / `未配置`）、探活（`从未` / `正常` / `失败：<message>` 与 `at` 的本地时间）、`缺省` 标记，以及行操作 `编辑`、`删除`、`设为缺省`（缺省行不渲染）、`探活`；表上方 `新增模型` 按钮。新增 / 编辑为对话框表单：`id`（编辑时只读）、`name`、`reasoning` / `vision` 复选、`maxTokens` 数字、`efforts` 六个复选（仅 `reasoning` 勾选时启用；视图 `efforts` 为 null 的推理模型预填为一个都不勾，旁注 `不勾选即不声明强度集合，界面列全部档位`；一个都不勾则提交不带 `efforts`）、`上游地址`、`密钥`（编辑时 placeholder `留空保留现有密钥`，空即省略 `apiKey`）；提交前 SHALL 在客户端按与服务端相同的规则逐字段校验并在字段旁显示具体原因（`id` 字节数与控制字符、`name` 码点数与控制字符、`maxTokens` 范围、地址格式、带地址且无已存密钥时必填密钥、填了密钥必填地址），服务端 400 的统一文案只作兜底；提交恰调用一次 `createModel` / `updateModel`，在途禁用提交，失败在对话框内 `role="alert"` 显示 `ApiError.message`。两个对话框 SHALL 接入 ui-primitives 规定的 Escape 关闭回退（`useEscapeFallback`），与既有覆盖层同一行为。保存成功且上游有改动（新建带上游；编辑改了地址或填了密钥）时 SHALL 紧接着恰调用一次 `probeModel`。`删除` 先弹确认（拷入层 alert-dialog，按钮 `取消` / `删除`）；`设为缺省` 与 `探活` 直接调用，在途禁用该行对应按钮。每次操作成功后 SHALL 重取 `listModels` 渲染；收到非信封的 500（发布失败）时同样重取（行已写入）并在页顶 `role="alert"` 显示 `REQUEST_FAILED_MESSAGE`。模型表下方 SHALL 在 `GET /api/kb/status` 为 `enabled:true` 时渲染「知识库模型」段（knowledge-bases 与 ragflow-backend 的设置端点）：嵌入模型的名称、上游地址（`已配置` / `未配置` 密钥）与探活状态，`编辑` 打开对话框（`名称`、`上游地址`、`密钥`——首次必填、之后 placeholder `留空保留现有密钥`），保存后若上游有改动恰调用一次 `probeKbEmbedding`；`知识库对话模型` 下拉（对话模型表里带上游的 `id` 加 `不使用`），改动即恰一次 `updateKbSettings({chatModelId})`；知识库数、文档数与重建状态（`重建中 N 个` / `重建失败 N 个`），有失败时显示 `重试失败的重建`（恰一次 `retryKbRebuild`）。更换嵌入模型名称或上游地址且知识库数大于 0 时，保存 SHALL 先弹确认（拷入层 alert-dialog，正文 `更换嵌入模型会重建全部 <知识库数> 个知识库（共 <文档数> 份文档），重建期间不能入库。`，按钮 `取消` / `重建并保存`），确认后带 `confirmRebuild:true` 恰调用一次 `updateKbSettings`；取消则不发请求。设置读取失败时该段显示 `知识库服务暂不可用` 与 `重试`。API 客户端 `web/src/lib/api-models.ts` SHALL 提供 `listModels` / `createModel(input)` / `updateModel(id, input)` / `deleteModel(id)` / `setDefaultModel(id)` / `probeModel(id)`，查询参数 `id` 经 `encodeURIComponent`，响应按 `ModelView` 严格解析（键集与类型不符即 `requestFailed`），`api.ts` 导出其类型。

#### Scenario: 登记、编辑与探活
- **WHEN** 管理员点 `新增模型`，填 `id` `m2`、勾 `推理`、勾 `low` `high`、填地址与密钥，提交（假客户端返回视图）；随后编辑 `m2` 只改 `name`；再编辑改地址不填密钥
- **THEN** 第一次 `createModel` 的 input 恰为 `{id:"m2", reasoning:true, efforts:["low","high"], upstream:{baseUrl, apiKey}}`（未碰的键不发），随后恰一次 `probeModel("m2")`；第二次 `updateModel` 的 input 含 `upstream:{baseUrl}`（不含 `apiKey`）且没有探活；第三次有探活；每次成功后恰一次 `listModels`

#### Scenario: 删除与缺省
- **WHEN** 管理员对非缺省行点 `删除` 并确认；对另一行点 `设为缺省`；`deleteModel` 返回 409 信封
- **THEN** 确认后恰一次 `deleteModel`；`设为缺省` 恰一次 `setDefaultModel`，刷新后该行有 `缺省` 标记且不再有 `设为缺省` 按钮；409 时行内显示信封文案、行仍在

#### Scenario: 更换嵌入模型需确认
- **WHEN** 知识库设置为 `{embedding:{name:"bge-m3", …}, bases:2, documents:5, …}` 时管理员把名称改为 `text-embedding-3-small` 并保存，在确认框点 `取消`；再保存并点 `重建并保存`
- **THEN** 确认框正文含 `2 个知识库（共 5 份文档）`；取消后没有 `updateKbSettings` 请求；确认后恰一次 `updateKbSettings`，其 input 含 `confirmRebuild:true`，随后恰一次 `probeKbEmbedding`

### Requirement: 模型管理端点
sessions 之外的 `models` 模块 SHALL 注册六个端点（路由身份 `GET /api/models`、`POST /api/models`、`PUT /api/models`、`DELETE /api/models`、`POST /api/models/default`、`POST /api/models/probe`），全部受既有 cookie guard 保护（未认证 401 先于一切）、只对角色恰为 `管理员`（`core/roles.ts` 的 `isAdmin`）的 principal 开放（其余 403 `forbidden`，先于 body 解析与 id 查找）、响应 `Cache-Control: no-store`、未知 `id` 404 `not_found`。模型 id SHALL 经查询参数 `?id=<encodeURIComponent(id)>` 传递而不进路径（http-service-skeleton 对 `/api/*` 下任何百分号编码的路径分量一律 typed 404，带 `/` 的 id 如 `Qwen/Qwen2.5-72B-Instruct` 进不了路径）：`id` 缺失、为空、出现多次 → 400 `bad_request`（在管理员判定之后、查找之前）；解码后的值与模型 id 逐码元比较。注册在 createApp 次序的最后、作为第八个模块 `models` 进入启动记录。视图 `ModelView` 恒为 `{id, name, reasoning, vision, maxTokens, efforts, upstream, isDefault, probe, updatedAt}`：`efforts` 为声明的数组或 `null`；`upstream` 为 `{baseUrl, hasApiKey: true}` 或 `null`；`probe` 为 `{status: "never"|"ok"|"failed", at: <epoch ms>|null, message: string|null}`。响应 SHALL NOT 含密钥。

- `GET /api/models` → 200 `{models: ModelView[]}`，按快照次序。
- `POST /api/models`：body 键集 SHALL 为 `{id, name, reasoning, vision, maxTokens, efforts, upstream}` 的子集且含 `id`，`upstream` 为 `{baseUrl, apiKey}`（两键都必填）；缺省与 `MODEL_CATALOG` 条目相同（`name = id`、布尔 `false`、`maxTokens` 32768；非推理模型不得带 `efforts`；推理模型可不带——存 NULL，表示不声明强度集合，model-selection「推理强度集合」）；`baseUrl` SHALL 整体匹配 `^https?://[^\s#@]+$`（允许路径与查询串，不允许 userinfo 与 fragment）；`apiKey` SHALL 通过 `http.validateHeaderValue("authorization", "Bearer " + 取值)`。表为空时该行成为缺省。`id` 已存在 409 `conflict`；已有 32 行 400 `bad_request`；其它非法 400 `bad_request`。→ 201 `ModelView`。
- `PUT /api/models?id=<id>`：body 键集恰为 `{name, reasoning, vision, maxTokens, efforts?, upstream}`，整体替换 `id` 以外的字段（推理模型省略 `efforts` 即存 NULL）；`upstream` 为 `{baseUrl, apiKey?}` 或 `null`：`apiKey` 省略 SHALL 保留既有密钥（既无密钥则 400），`null` 清空两列；`baseUrl` 逐字等于已存地址去掉 userinfo 后的视图形式时 SHALL 沿用已存地址（含 userinfo，不再套地址规则）——`apiKey` 省略则密钥也沿用，给了 `apiKey` 则只换密钥（仍经 header 值校验）——使编辑 env 种子行只改名或只换密钥都不丢地址里的凭证。知识库开启且该行是知识库对话模型时（change s2a-kb-ragflow）：`upstream: null` → 409 `kb_model_in_use`，行不变；`upstreamChanged` 为真 → 在本地写入之前经装配注入的知识库钩子把新上游重新下发到 RAGFlow，下发失败按 ragflow-backend「RAGFlow 出站请求」映射（503 `kb_unavailable` / 400 `kb_rejected`），行、审计与 `models.yml` 都不变。→ 200 `ModelView`。
- `DELETE /api/models?id=<id>`：`is_default = 1` 的行 409 `model_in_use`；知识库开启且该行是知识库对话模型时 409 `kb_model_in_use`（change s2a-kb-ragflow，ragflow-backend「知识库模型设置」）；否则删除 → 204。
- `POST /api/models/default?id=<id>`（无 body）：一个事务里把旧缺省清零、该行置 1 → 200 `ModelView`；该行已是缺省时 200、不记审计、不发布。
- `POST /api/models/probe?id=<id>`（无 body）：见「探活」→ 200 `ModelView`。

每次写入 SHALL 在同一事务里记审计：kind `model.create` / `model.update` / `model.delete` / `model.default` / `model.probe`，actor 为请求 principal，`workspaceId` null，title 为中文（如 `登记模型 <name>`），detail 只含 `{modelId, name?, upstreamChanged?, status?}`——SHALL NOT 含 base URL、密钥或探活摘要。两个带 body 的路由属 content-parser 归属集（exact 400 `bad_request`）；两个无 body 的路由按 `POST /api/sessions/:id/stop` 先例（任意 body 即 400）。

#### Scenario: 权限与视图
- **WHEN** 匿名、普通账号与管理员各请求 `GET /api/models`；管理员以 `{id:"m2", upstream:{baseUrl:"https://gw.example/v1", apiKey:"<哨兵>"}}` 创建
- **THEN** 依次 401、403 `forbidden`（body 为统一信封）、200；创建 201，视图 `upstream` 为 `{baseUrl:"https://gw.example/v1", hasApiKey:true}`，响应与应用 stdout/stderr 不含哨兵；`GET /api/models` 列出种子行与 `m2`，审计有一条 `model.create`，detail 为 `{modelId:"m2", name:"m2", upstreamChanged:true}`

#### Scenario: 非管理员先于 body 与 id
- **WHEN** 普通账号对 `POST /api/models` 与 `PUT /api/models?id=m1` 发 malformed JSON 与 `text/plain` 正文；对 `DELETE`、`default`、`probe` 用未知 id 与缺失的 `id`；对两个 bodyless 路由带 `{}`
- **THEN** 全部 403 `forbidden` 统一信封、no-store；表、审计与假上游请求数都不变

#### Scenario: 编辑种子行
- **WHEN** 管理员对零配置种子行 `deepseek-v4.1-flash`（推理，`efforts` NULL）`PUT` 只改 `name`、不带 `efforts`；再 `PUT` 带 `efforts:["low","high"]`；对一个带 `/` 的 id `Qwen/Qwen2.5-72B-Instruct` 先 `POST` 再 `PUT /api/models?id=Qwen%2FQwen2.5-72B-Instruct`；再对 `PUT /api/models`（无 `id`）与 `PUT /api/models?id=&id=m1` 发合法 body
- **THEN** 第一次 200、视图 `efforts` 为 null、`models.yml` 该条目仍无 `thinking` 映射；第二次 200 后条目带 `thinking.efforts: [low, high]`；第三例 201 与 200，`GET /api/models` 列出该 id 原文；最后两例 400 `bad_request`，行不变

#### Scenario: 种子行带 userinfo 只改名
- **WHEN** env 种子行的上游地址为 `https://u:<哨兵>@host/v1`；管理员 `PUT /api/models?id=<该行>` 只改 `name`，`upstream` 为 `{baseUrl: "https://host/v1"}`（视图里的地址，不带 `apiKey`）
- **THEN** 200；存储地址与密钥逐字不变（仍含 userinfo）；审计 `model.update` 的 `upstreamChanged` 为 false；视图 `upstream.baseUrl` 仍为 `https://host/v1`、响应不含哨兵
- **WHEN** 随后同一行 `PUT` 的 `upstream` 为 `{baseUrl: "https://host/v1", apiKey: <新密钥>}`
- **THEN** 200；存储地址仍逐字含 userinfo、密钥换为新值；审计 `upstreamChanged` 为 true（给出了 `apiKey`）

#### Scenario: 修改保留密钥与清空上游
- **WHEN** 管理员 `PUT /api/models?id=m2` body `{name:"深度", reasoning:true, vision:false, maxTokens:8192, efforts:["low","high"], upstream:{baseUrl:"https://gw2.example/v1"}}`；再 `PUT` 同 body 但 `upstream: null`；再对一个从未有密钥的模型 `PUT` 省略 `apiKey` 的 `upstream`
- **THEN** 第一次 200、`hasApiKey` 仍为 true 且代理转发该模型时带原密钥与新 base URL；第二次 200、`upstream` 为 null；第三次 400 `bad_request`，行不变

#### Scenario: 删除与缺省
- **WHEN** 管理员 `DELETE` 缺省模型；再 `POST /api/models/default?id=m2` 后 `DELETE` 原缺省；再 `DELETE` 一个未知 id
- **THEN** 依次 409 `model_in_use`（行不变）、200 后 204（`models.yml` 不再含原缺省；审计 `model.default` 与 `model.delete` 各一条）、404

#### Scenario: 非法 body 与归属
- **WHEN** `POST /api/models` 分别以 `{}`、`{id:"a", extra:1}`、`{id:"a", efforts:["low"]}`（非推理带 `efforts`）、`{id:"a", upstream:{baseUrl:"ftp://x"}}`、`{id:"a", upstream:{baseUrl:"https://x/v1"}}`（缺 `apiKey`）、第 33 个合法 body、malformed JSON、`text/plain` 媒体类型请求；`POST /api/models/probe?id=m1` 带 `{}` body
- **THEN** 全部 exact 400 `bad_request`，表与审计不变

#### Scenario: 知识库对话模型受保护
- **WHEN** 知识库开启且 `m2` 被指定为知识库对话模型；管理员 `DELETE /api/models?id=m2`；`PUT` `m2` 只改 `name`；`PUT` `m2` 换密钥（假 RAGFlow 应答成功）；知识库关闭的另一个实例里对同样被引用的 `m3` `DELETE`
- **THEN** 删除 409 `kb_model_in_use`、行不变；只改 `name` 200 且假 RAGFlow 没有收到下发；换密钥 200 且假 RAGFlow 在本地写入之前恰收到一次带新密钥的下发；知识库关闭时删除 204，`kb_settings.chat_model_id` 变为 NULL
