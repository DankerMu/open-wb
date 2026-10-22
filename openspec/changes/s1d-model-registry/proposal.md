# Proposal: s1d-model-registry

> Issue type: feature（S1d 中心能力面第一刀：模型注册表 + `/center` 外壳）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明——组 1、3、9、11 为 compact）
> Blast radius: 模型白名单的来源（env → DB），每一次代理转发的放行与上游选择，托管 `models.yml` / `host-overlay.yml` 的重写时机，会话侧上游净化的密钥集，派发前对齐的重启判据，启动阶段枚举与错误码表，`/center` 路由从占位壳变成带 tab 的页面
> Evidence floor: `npm test --workspace server`（含 `WORKBUDDY_OMP_TEST=1` 官方用例）、`npm test --workspace web`、typecheck、size-guard、`make check`、`make test-guardrails`、PR CI `uid-isolation`、`make smoke`（真实端点：种子后一次对话 + 中心页改模型后新会话走新模型）

## Why

`IMPLEMENTATION_PLAN.md` S1d（F-CTR-MOD）要求中心页有「模型」tab：内网自建模型的登记、探活与缺省选择。今天模型白名单来自环境变量 `MODEL_CATALOG` / `MODEL_ID` / `MODEL_REASONING` / `MODEL_VISION`，在 `agent-config.ts` 的 resolver 里启动时定死（model-selection「模型白名单配置」：「启动时确定、此后不变」），所有模型共用一个上游 `MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`（`server/src/model-proxy/index.ts:148-156` 在注册时算一次 `upstreamLink`）。管理员改一个模型要改 env 重启；多家内网网关（不同 base URL、不同密钥）无法并存。

grill（2026-10-21，owner 逐分支拍板，凭证见 design「owner 的裁定」）定了方向：**DB 注册表取代 env**（Q5），OpenAI 兼容上游、每模型自带 base URL + 密钥，管理员增删改 + 全局缺省 + 探活（D3：http 做握手探活），变更即重写托管文件、新 spawn 生效、页面按需重取（D5），中心只有管理员能管模型（Q8），账号最近选择不动（D4）。

## What Changes

- **迁移 046 `models` 表**（`server/src/core/db/migrations/046_models.sql`）：每行 `{id, name, reasoning, vision, max_tokens, efforts, upstream_base_url, upstream_api_key, is_default, probe_status, probe_at, probe_message, created_at, updated_at}`；恰一行 `is_default = 1`（部分唯一索引）；`id` 的取值规则与 `MODEL_CATALOG` 条目相同；推理模型的 `efforts` 可为 NULL（不声明强度集合，与零配置种子行同形）；最多 32 行。密钥明文落在已经是 0600 的 SQLite 文件里（与 env 同一信任级别；ADR-0008 补充）。
- **注册表成为白名单的唯一来源**：`server/src/models/` 新模块持有进程内快照 `current(): ModelCatalog`，`GET /api/composer/options`、有效值解析、托管 `models.yml`、overlay 的看图角色、代理放行全部改读快照。`agent-config.ts` 对六个 `MODEL_*` 键的解析与校验**原样保留**，但降级为**种子**：启动时表为空才按它们写入第一批行（上游来自 `MODEL_UPSTREAM_*`，未配置时模型没有上游）；表非空时忽略它们，设置了任一键就在 stderr 写一行 `{"event":"model_env_ignored"}`。新启动阶段 `model_registry` 位于 `db` 之后、`app` 之前（同步 node:sqlite 操作，主端口绑定后的第一个请求就读到快照）。
- **代理按模型路由**（**BREAKING** 对代理内部契约）：`registerModelProxy` 不再收 `allowedModels` 与单一 `upstream`，改收 `models.lookup(id)`；每个请求在既有的媒体 / 大小 / JSON 检查之后按请求体 `model` 查注册表——查不到 400（既有白名单语义，不回显模型名）；查到但该模型没有上游 502 `agent_unavailable`（既有的「未配置上游」应答，只是从请求级变成模型级）；查到且有上游则转发到**该模型**的 base URL、带该模型的密钥。净化列表覆盖此刻全部已登记上游的 base URL 与密钥。查找发生在转发前一刻：已转发的请求不受之后的改动影响；正在用被删模型的回合，其下一次上游请求会失败。装配契约 `assembly.models ?? lookupFromCatalog(modelCatalog, upstream)` 保留静态目录作为测试接缝。
- **会话侧净化改接注册表**：`app.ts` 的上游净化闭包不再只认 env 的单一上游，每次净化现取注册表全部已登记上游的密钥与 base URL（upstream-failure 规格 delta）。否则经 UI 登记的密钥在上游 401 回显时会原文落进会话消息并展示给普通用户。
- **存活进程对新模型先重启**：每个 slot 记下启动时的模型 id 集合，派发前有效模型不在集合里就按换档位的同一路径退役再 spawn（chat-sessions 规格 delta）；omp 只在 spawn 时读 `models.yml`，对它不认识的模型发 `set_model` 会使那条消息失败。
- **管理端点**（仅 `管理员`，其余角色 403 `forbidden`）：`GET /api/models`、`POST /api/models`、`PUT /api/models/:id`、`DELETE /api/models/:id`、`POST /api/models/:id/default`、`POST /api/models/:id/probe`。响应只报 `hasApiKey`，永不回传密钥与 base URL 之外的凭证；`PUT` 省略 `apiKey` 保留既有密钥。删缺省模型 409 `model_in_use`（先换缺省）。每次写入在同一事务里记审计 `model.create` / `model.update` / `model.delete` / `model.default` / `model.probe`，detail 不含 base URL 与密钥。
- **变更即发布**：写入提交后，同一请求里串行重写 `<agent>/models.yml` 与 `host-overlay.yml`（既有原子替换写出器；看图角色取快照里第一个 `vision` 模型），并刷新快照。正在运行的 omp 进程不动：下一次 spawn 读新文件，下一次派发按快照对齐 `set_model`。
- **探活**：`POST /api/models/:id/probe` 对该模型上游发 `GET <baseUrl>/models`（bearer 为其密钥），建连 10 s / 整体 15 s；2xx 记 `ok`，其余与失败记 `failed` 并存一段经既有净化（`upstreamExcerpt`）的摘要；没有上游的模型记 `failed`、摘要 `未配置上游`。结果存表、随 `GET /api/models` 返回。假上游夹具增加 `GET /models` 供用例使用。
- **两个新错误码**：`forbidden`（403，`没有权限执行此操作`）与 `model_in_use`（409，`该模型是缺省模型，先把缺省换成别的模型`）；码表十六 → 十八。管理员判定从 `core/audit` 的私有常量提到 `core/roles.ts`（`ADMIN_ROLE`、`isAdmin`）共用。
- **`/center` 外壳**（本 change 拥有；S1d 其余三个 change 各加自己的 tab）：`web/src/features/center/` 新页面，tab 由 `?tab=<key>` 表示，tab 表 `[{key, label, adminOnly}]`（外壳先以空表合入，模型 tab 组追加 `models`（`模型`，仅管理员）；验收 SH-01 随外壳改写）；没有可见 tab 时渲染「中心暂无可用内容」空态；routeManifest 的描述改为真实内容。spa-shell「路由 IA 与侧栏」的 `/center` 句随之修改。
- **「模型」tab**：表格列出模型（id、显示名、推理 / 看图标签、输出上限、上游是否配置、探活状态与时间、缺省标记）与操作（新增、编辑、删除、设为缺省、探活）；新增 / 编辑为对话框表单；保存成功且上游有改动时页面自动探活一次。用 assistant-ui + shadcn/Tailwind（ADR-0013），不新增 `.css`。
- **模型选择器按需重取**：输入框模型菜单每次打开时调用既有 `invalidate()` 再取一次 `GET /api/composer/options`（hook 契约不变），取代「每个 client 取一次」的假定。
- **文档与验收**：`docs/architecture/system.md` 加模型注册表一节、ADR-0008 补充（凭证改存 DB、按模型净化、探活）、验收清单新增「中心·模型（CM）」一节（结论 `待签`）。

## Capabilities

### New Capabilities

- `model-registry`：模型注册表——迁移 046、注册表快照与发布（models.yml / overlay 重写）、环境种子、管理端点（CRUD / 缺省 / 探活）、审计、中心「模型」tab 与管理 API 客户端。

### Modified Capabilities

- `model-selection`：MODIFIED「模型白名单配置」（来源从 env 变为注册表；env 降为种子；每模型上游；变更对新请求生效）、「模型与推理强度控件」（模型菜单打开时重取 options）。
- `model-proxy`：MODIFIED「透传端点与 bearer 鉴权」（`registerModelProxy` 的 `models.lookup` 契约；检查次序；按模型上游；净化列表）、「假上游夹具契约」（`GET /models`）。
- `session-composer-settings`：MODIFIED「输入框选项端点」（`models` 来自注册表快照；缺省配置场景改为种子后的状态）。
- `http-service-skeleton`：MODIFIED「服务启动与装配」（六个 `MODEL_*` 键为种子语义；新阶段 `model_registry`（`db` 之后、`app` 之前）与 `reason` 枚举；`model_env_ignored` 记录；第八个模块 `models`）、「统一错误信封」（十八码；归属身份加四条）。
- `spa-shell`：MODIFIED「路由 IA 与侧栏」（`/center` 从占位壳变为带 `?tab=` 的中心页；routeManifest 描述）。
- `upstream-failure`：MODIFIED「上游原文净化」（密钥集来自注册表全部已登记上游，净化时现取）。
- `chat-sessions`：MODIFIED「派发前按会话设置对齐进程」（第 1 步加「有效模型不在 slot 启动时的模型集合里则退役重启」）。
- `chat-web`：MODIFIED「输入框与能力栏」（options 重取触发加「模型菜单打开」）。
- `omp-runtime`：MODIFIED「宿主 overlay」（随发布重写；看图块来源为注册表快照）。

## Impact

- 服务端：`server/src/models/`（新：store、registry、publish、probe、rest）、`core/db/migrations/046_models.sql`、`core/errors`、`core/roles.ts`（新）、`core/audit`（导入 `ADMIN_ROLE`）、`model-proxy/index.ts` + 新 `lookup.ts`（lookup 契约与静态适配）、`server.ts`（阶段 `model_registry`；`models_yml` / `host_overlay` 改调发布函数；`STARTUP_MODULES` 八项）、`app.ts`（代理、composer、净化闭包接注册表；`registerModels`）、`sessions/rest-composer.ts` / `store-composer.ts` / `composer-align.ts`（`ComposerConfig.modelCatalog` 改为按需取快照；slot 模型集合）、`http/errors.ts`（两码的状态；归属集加四条）、`test/support/fake-upstream.mjs`（`GET /models`）。
- 前端：`web/src/features/center/`（新）、`web/src/lib/api-models.ts`（新）+ `api.ts` 导出、`web/src/routes/manifest.ts`、`web/src/features/chat/model-picker.tsx`（打开时 `invalidate()`）。
- 测试：`server/test/core-db-helpers.ts` 加 `MIGRATION_046`；`http-typed-errors.test.ts` / `auth-lifecycle.test.ts` / `http-parser-owners.test.ts` 的十六码 / 十七条断言改十八 / 二十一；`server-startup-failure-reason.test.ts` 的阶段序列；代理用例改经 `lookupFromCatalog`；web `topbar.test.tsx` 与 `e2e/ui-walk.spec.ts` 对 `/center` 的占位断言。
- 文档：`docs/architecture/system.md`、`docs/adr/0008-model-proxy-credentials.md`（补充节）、`docs/acceptance/functional-checklist.md`（SH-01 改写 + CM 节）、`IMPLEMENTATION_PLAN.md` 的 F-CTR-MOD 行。
- 部署：首次升级到含 046 的版本时，现有 env 原样种子进表，行为不变；之后改 env 不再生效（stderr 一行提示）。密钥从 env 迁到 DB 文件（0600）。
