# Tasks: s1d-model-registry

> 跟踪：Stage 5 在 Epic 下建子 issue，十一个任务组各一个子 issue、各一个 PR（Stage 3 Review 3 按宽度门禁把原七组拆成十一组，每组 `atomic`）。依赖（真实依赖，不串成线性链）：组 2 依赖组 1（store 抛 `model_in_use`）；组 3 依赖组 2（快照由 store 读）；组 4 独立（代理 lookup 契约 + 静态适配）；组 5 依赖组 3 与组 4（装配把注册表接进代理、composer、净化闭包）；组 6 依赖组 5（slot 的模型集合来自快照）；组 7 依赖组 5；组 8 依赖组 7（探活端点挂在 REST 骨架上）；组 9 独立；组 10 依赖组 7、组 8 与组 9；组 11 独立（只改 picker 与 chat-web 用例）。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实，出入先改 design 再继续；密钥、上游地址、测试主机不进任何被跟踪文件；产品代码单文件 ≤800 行，`auth-lifecycle.test.ts` 与 `use-chat-session.ts` 不再往里加；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（密钥 / base URL 进响应、审计、stderr、models.yml、会话 detail） | 是 | 组 4、组 5（净化闭包）、组 7、组 8 的哨兵断言 |
| 代理放行语义回归（未登记模型被转发、重复 `model` 键） | 是 | 组 4 沿用既有 `model-guard` 用例 |
| 启动阶段与失败记录（新阶段位置、种子失败、env 忽略、首请求前快照就绪） | 是 | 组 5 |
| 两份真相（快照 vs 表 vs 托管文件 vs 存活进程） | 是 | 组 3 单飞与字节用例、组 6 |
| 权限（非管理员写注册表） | 是 | 组 7 先于 body 的 403 矩阵 |
| 迁移与 DB 约束 | 是 | 组 2 |

## 1. 错误码与管理员判定（http-service-skeleton「统一错误信封」）

- [ ] 1.1 核对 design Context：`core/errors/index.ts:5-22`、`http/errors.ts` 状态表、`core/audit/index.ts:13,81`、三处计数守卫 `http-typed-errors.test.ts:123`、`auth-lifecycle.test.ts:705`、`http-parser-owners.test.ts:50,271`。
- [ ] 1.2 测试先行：三处「恰十六码」改十八（`auth-lifecycle.test.ts:705-724` 的 `codes` 表补两条条目——`satisfies` 穷尽守卫要求——与标题，+2 行）；新文件 `server/test/http-typed-errors-s1d.test.ts`：两码的状态 / message / 与同状态码兄弟的互异（skeleton 场景「两个 s1d 新码」）；新 `server/test/core-roles.test.ts`（`isAdmin`：`管理员` 真；`管理员 `、`admin`、空串假）。
- [ ] 1.3 `core/errors/index.ts` 加 `forbidden`、`model_in_use`；`http/errors.ts` 加 403 / 409 映射（归属集清单不动，归组 7）。
- [ ] 1.4 新 `server/src/core/roles.ts`（`ADMIN_ROLE`、`isAdmin`）；`core/audit/index.ts` 改导入、删私有常量。
- [ ] 1.5 `docs/architecture/system.md` 错误码列举（若有）同步两码。

Suggested fixture level: compact - 纯枚举与纯函数扩展，三处计数守卫直接钉住，无 IO、无权限面变化（403 的消费者在组 7）。
Minimal mergeable slice: atomic - 两码与 `isAdmin` 都是组 7 的前置且各自只有一条计数 / 纯函数验证路径，拆开没有独立可验收行为。

## 2. 迁移 046 与注册表 store（model-registry「迁移 046 模型表」+「注册表快照是白名单的唯一来源」的 store 部分 +「环境种子」的纯 DB 部分 + model-selection「模型白名单配置」的 `validateCatalogModel`）

- [ ] 2.1 核对 Context：`model-catalog.ts:48-83` 的校验分支、`agent-config.ts:237-243` 的 header 判定、`core-db-helpers.ts:8-27`、`server/src/core/db/migrations/045_*` 为最后一个迁移。
- [ ] 2.2 测试先行（新 `server/test/models-store.test.ts`，`:memory:` + 真实迁移）：建表与两条约束；`create` 合法缺省 / 重复 id 409 / 第 33 个 400 / model-selection「非法白名单使启动失败」清单的单项 body 各 400（`requireEfforts:false` 下 `[{"id":"a","reasoning":true}]` 合法、`efforts` 存 NULL）/ 错误 message 不含取值；首行自动缺省；`update` 整体替换、省略 `apiKey` 保留、无密钥时省略 400、`upstream: null` 清空、推理模型省略 `efforts` 存 NULL；`remove` 缺省 409、非缺省删除；`setDefault` 事务（旧清新立，中途失败两者都不变；已是缺省 → 无写入标记）；`seedIfEmpty`（空表插入三模型 + 缺省 + 单模型 `efforts` NULL；只设一个上游键 → 两列 NULL；非空表返回 `skipped` 且不写）；`list()` 次序；`toCatalog(rows)` 与 `resolveModelCatalog(env)` 对同一输入深等于；带 `/`、空格、`%` 的 id 往返；`MIGRATION_046` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 2.3 `server/src/core/db/migrations/046_models.sql` 按 design D3 建表与索引；`core-db-helpers.ts` 加常量。
- [ ] 2.4 `model-catalog.ts`：导出 `validateCatalogModel(input, {requireEfforts})`，`parseCatalog` 改调它（`requireEfforts: true`）；`agent-config.ts` 的 header 判定提成导出的 `validateUpstream({baseUrl, apiKey})`（地址正则 `^https?://[^\s#@]+$`）。
- [ ] 2.5 新 `server/src/models/store.ts`：`createModelStore(db)` → `{list, get, routeOf, create, update, remove, setDefault, seedIfEmpty, recordProbe, toCatalog, secrets}`；全部 `HttpError`；只有 `routeOf` 与 `secrets` 返回密钥。

Suggested fixture level: expanded - 新迁移（persisted schema）与密钥落库（credentials at rest），尽管全部是纯 DB 用例。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者、store 没有迁移跑不起来；`validateCatalogModel` 的提取是 store 校验的唯一来源，单独提取没有可验收行为（既有 env 用例已覆盖）。

## 3. 注册表快照与发布模块（model-registry「注册表快照是白名单的唯一来源」的快照部分 +「变更即发布」的单飞与字节）

- [ ] 3.1 核对 Context：`models-yml.ts:14-31`、`host-overlay.ts:207-235` 的签名；system.md §4 依赖规则（写出器以函数注入，`models` 不导入 model-proxy / sessions）。
- [ ] 3.2 测试先行（新 `server/test/models-registry.test.ts`、`server/test/models-publish.test.ts`）：`current()` / `lookup()` / `secrets()` / `refresh()` 对 store 写入的反映；`createPublisher({agentDir, stateDir, proxyBaseUrl: () => string | null, browserEnabled, registry, writeModelsYml, writeOverlay})`：两个写出器按序各恰一次、参数等于快照与第一个 `vision`；`proxyBaseUrl()` 为 null 时不调写出器直接返回；并发三次 `publish()` ≤3 次写出且终态为最后快照；写出器抛出时 `publish()` 拒绝；真实写出器下字节 = `writeManagedModelsYml` / `writeHostOverlay` 直接调用（复用 `model-proxy-models-yml.test.ts`、`omp-host-overlay.test.ts` 的基线文件）。
- [ ] 3.3 新 `server/src/models/registry.ts` 与 `server/src/models/publish.ts`（单飞 + 合并等待；无 `await` 之外的共享状态）。

Suggested fixture level: compact - 纯函数与注入写出器的模块，不碰生产装配、不写真实托管目录（字节用例用既有基线在临时目录跑）。
Minimal mergeable slice: atomic - 快照与发布共用同一份 `current()`，发布没有快照无输入、快照没有消费者只能由发布与组 5 证明；两者各一条验证路径但都在同一新模块内，拆开只剩无行为的类型。

## 4. 代理按模型路由（model-proxy「透传端点与 bearer 鉴权」）

- [ ] 4.1 核对 Context：`model-proxy/index.ts:38-42,91-96,148-156,161-210,262-271`，`model-guard.ts` 的扫描接口，既有 `model-proxy-*.test.ts` 与 `test/support/omp-official-proxied.ts` 的装配方式（`assembly.modelCatalog` / `upstream`）。
- [ ] 4.2 测试先行：既有代理用例改经 `staticRegistry`；新 `server/test/model-proxy-routing.test.ts`：未登记 400 不回显 / 登记无上游 502 / malformed + 无上游 400（次序变化）/ 两模型两个假上游各收自己的请求与 bearer / 500 摘要净化覆盖两个上游哨兵与 base URL / 转发后 lookup 改变不影响在途流、第二请求 400；`model-guard` 既有用例不改。
- [ ] 4.3 `ModelProxyOptions` 改为 `{tokens, models, connectDeadlineMs?, firstByteDeadlineMs?}`；删 `allowedModels` / `upstream` 与注册时的 `upstreamLink`；`authenticate` 只做 bearer；白名单判定改为 `lookup !== undefined`，route 交给转发；净化密钥集 = `models.secrets()` + 本 route。
- [ ] 4.4 新 `server/src/model-proxy/lookup.ts`：`ModelRegistry` 接口（`current`、`lookup`、`secrets(): readonly string[]`、`refresh`）与 `staticRegistry(catalog, upstream?)`（`refresh` 空操作；`secrets` 按 upstream-failure 密钥集规则导出）；`app.ts` 装配 `const registry = assembly?.models ?? staticRegistry(assembly?.modelCatalog ?? resolveModelCatalog({MODEL_ID: runtime.modelId}), assembly?.upstream)`，代理收 `registry`（`AssemblyDependencies.models?: ModelRegistry`；`modelCatalog` / `upstream` 保留）。
- [ ] 4.5 官方 omp 用例与 `make smoke` 假上游路径保持绿；`docs/architecture/system.md` 9.5 加「按模型路由」一段。

Suggested fixture level: expanded - 改每一次模型转发的放行与凭证选择（Auth / credentials 触发项）。
Minimal mergeable slice: atomic - 查找契约、次序与净化集是同一个请求路径的三段：只换契约不改次序则「无上游先 502」与按模型上游矛盾；不改净化集则第二个上游的密钥可能出现在第一个上游的失败摘要里；`staticRegistry` 是让组 4 在组 5 之前独立保绿的适配，没有它生产装配无定义。

## 5. 启动装配：阶段、种子、快照接管与会话侧净化（http-service-skeleton「服务启动与装配」+ model-registry「环境种子」+「注册表快照是白名单的唯一来源」+「变更即发布」的启动两步 + session-composer-settings「输入框选项端点」+ upstream-failure「上游原文净化」+ omp-runtime「宿主 overlay」的重写时机）

- [ ] 5.1 核对 Context：`server.ts:96,137,302-314,425,476,497,532-549`、`app.ts:208-216,241,249,337-358`、`rest-composer.ts:41`、`store-composer.ts:26,104-107`、`composer-align.ts:22`、`store-view.ts:76`、`server-startup-failure-reason.test.ts:284-298`、`server-startup-order.test.ts:222`（完整代理回合）。
- [ ] 5.2 测试先行：`server-startup-failure-reason.test.ts:144-328` 在 `db` 例与 `app` 例之间加 `model_registry`（迁移后把 `models` 换成只读视图）；新 `server/test/server-startup-model-seed.test.ts`（零配置 / 三模型 + 上游哨兵 / 只设 base URL / 非空表 + `MODEL_ID` → `model_env_ignored` 恰一行 / 非空表 + 六键未设置零行 / 非空表 + `MODEL_CATALOG=not json` 仍 `config` / 主端口绑定后立刻 `GET /api/composer/options` 的 `models` 恰为种子项 / `models.yml` 与 overlay 字节 = 既有基线 / `models_yml` 阶段之前经 store 写入 + `refresh` 不触发文件重写、启动随后按新快照发布一次）；composer options 用例加「store 写入 + `refresh` 后不重启即变化」与甲乙缺省（model-registry 场景「写入后不重启即可见」）；新 `server/test/session-message-error-registry.test.ts`：注册表登记的哨兵密钥经假上游 401 回显后 `chat_messages` / 会话视图 / SSE / stderr 无哨兵与 base URL（upstream-failure 新场景，含 `PUT` 换密钥的第二例）；`omp-host-overlay` 用例加「看图块随注册表重写」（直接调 `publish()`）。
- [ ] 5.3 `server.ts`：阶段 `model_registry`（`seedIfEmpty` → `refresh`；`model_env_ignored`）插在 `db` 与 `app` 之间；`models_yml` / `host_overlay` 改调注入了真实写出器的 `publish()` 两步（`reason` 不变）；`proxyBaseUrl` getter（`models_yml` 之前为 null）；`SessionRuntime.modelId` 取快照缺省；`STARTUP_MODULES` 不动（八模块记录归组 7）。
- [ ] 5.4 `app.ts`：生产装配经 `assembly.models` 传真注册表（4.4 的同一条装配规则，三处共用那个 `registry` 对象）；`composer.modelCatalog` 改 getter 读 `registry.current()`；`redactUpstream` 改为每次现取 `registry.secrets()` 加两组路径，删 `assembly.upstream` 在净化闭包里的用法；`server.ts` 的 `appAssemblyOf` 传 `models: registry`。
- [ ] 5.5 `docs/architecture/system.md` 启动阶段表加 `model_registry`、§4 注明写出器注入；部署文档 / `.env.example`（若有）注明六键为首次种子。

Suggested fixture level: expanded - 改生产启动顺序、启动失败枚举、托管文件写出时机与会话侧凭证净化（production config / file publish / credentials 触发项）。
Minimal mergeable slice: atomic - 阶段、种子、快照接管与净化闭包是同一条「注册表成为真相」的装配：只加阶段不接快照则两份真相并存；只接快照不种子则零配置启动表为空、写出器拒绝空列表；净化闭包不接注册表则接管后登记的密钥立即可泄露——三者任一单独合入都是未关闭的口子。

## 6. 存活进程的模型集合（chat-sessions「派发前按会话设置对齐进程」第 1 步）

- [ ] 6.1 核对 Context：`composer-align.ts:29-52`、`supervisor.ts:80,454-463`、`pool.ts` slot 记录的档位字段；design D19 前提。
- [ ] 6.2 测试先行：`composer-align` 纯函数用例（`reusable(live, effective)` 带 `live.modelIds`：不在集合 → false）；新 `server/test/session-dispatch-model-set.test.ts`（假 omp 真子进程：登记 `m2` + 设缺省 → 下一条 prompt 退役重启、argv `--model workbuddy/m2`、`stream_epoch` 加一、新进程收到 `set_model`、第三条不重启；删除 `m2` → 不重启、`set_model{m1}`、会话行不变）；官方 omp 用例 `omp-official-model-set.test.ts`（`WORKBUDDY_OMP_TEST=1`：启动后把 `m2` 加进 `models.yml` 再 `set_model` → 记录确切应答；若 `success` 为真则在 design D19 登记并把判据改为可选）。
- [ ] 6.3 slot 记录启动时的模型 id 集合（取自 `registry.current()`）；`reusable()` 加判据；退役走既有 `ReadmissionRequired` 路径。

Suggested fixture level: expanded - 改派发路径的重启判据（Critical Path「omp 子进程治理」）。
Minimal mergeable slice: atomic - 集合记录与判据是同一条判断的写与读；真实 omp 用例是前提凭据，与判据同 PR 否则前提未钉。

## 7. 管理端点与审计（model-registry「模型管理端点」+ http-service-skeleton「统一错误信封」的归属身份与八个模块）

- [ ] 7.1 核对 Context：`http/errors.ts:45-75` 的 `CONTENT_PARSER_OWNED_ROUTES`、`http-parser-owners.test.ts:28-29` 的身份清单、`http/path-classifier.ts:19-23`（编码路径 404，所以 id 走 `?id=`）、`server-assembly.test.ts:156`、`fake-omp-proxy.mjs:2`（回合只能以列表第一个模型跑）；`core/audit` 的 `emit` 签名；`smoke/*.hurl` 的写法。
- [ ] 7.2 测试先行（新 `server/test/models-rest.test.ts`，整体挂载）：401 / 403 矩阵（普通账号 × 本组五端点 × malformed JSON、`text/plain`、未知 id、缺失 id、bodyless 带 `{}`：全部 403 且表、审计、假上游请求数不变）/ `id` 缺失、空、多值 400 / 404 / 键集严格清单 / 201 视图不含密钥 + `hasApiKey` / `PUT` 四例（保留密钥、清空、无密钥省略 400、种子行省略 `efforts` 存 NULL 与带 `efforts`）/ 带 `/` 的 id 经 `?id=Qwen%2F…` 往返 / `DELETE` 三例 / `default` 两例（含已是缺省幂等、无审计无发布）/ 四种审计 kind（`model.probe` 在组 8）与 detail 不含哨兵与 base URL / `http-parser-owners` 二十一条身份（本组把四条身份一次加齐，probe 的身份先于其路由存在）+ `POST /api/models`、`PUT /api/models` 的 content-parser 400 + `default` 带 `{}` 400 / 发布失败：agent 目录换成普通文件 → 500 非信封 + 注入的 `onPublishFailed` 收到恰一次记录 + 行与审计保留 + 恢复后再写入使 `models.yml` 含该模型 / 启动记录八个模块（`server-assembly.test.ts:156` 的次序断言同步）/ 在途回合：假 omp 真子进程 + 假上游两轮脚本以缺省模型 `m1` 跑回合，第一轮工具执行期间 `PUT /api/models?id=m1` 以 `upstream: null` → 200、无进程退役、第二轮 502、回合 `failed`、`detail` 无上游内容（model-registry 场景「注册表写入不打断…」）。
- [ ] 7.3 新 `server/src/models/rest.ts`（五端点：`GET /api/models`、`POST /api/models`、`PUT /api/models?id=`、`DELETE /api/models?id=`、`POST /api/models/default?id=`；`id` 查询参数解码后比较；写入事务内 `emit`；成功后 `registry.refresh()` + `publish()`；探活端点整体归组 8，本组不注册 `POST /api/models/probe`、也不放 501 占位）。
- [ ] 7.4 `app.ts` 注册 `registerModels(app, {db, store, registry, publish, emit, isAdmin, onPublishFailed})` 为第八个模块（`AssemblyDependencies.onPublishFailed?: () => void`；`server.ts` 传写 `{"event":"model_publish_failed"}` 的受管 stderr writer）；`http/errors.ts` 归属集一次加齐 `POST /api/models`、`PUT /api/models`、`POST /api/models/default`、`POST /api/models/probe`（身份静态存在，probe 路由由组 8 注册）；`server.ts` `STARTUP_MODULES` 加 `models`。
- [ ] 7.5 `make smoke` 的 hurl 加「管理员登记模型 → `GET /api/composer/options` 含它 → 删除」三步；`docs/architecture/system.md` 加「模型注册表」一节（端点、审计 kind、发布）；ADR-0008 加「2026-10-21 补充（s1d-model-registry）」（密钥落 DB 0600、按模型净化、会话侧密钥集改接注册表）。

Suggested fixture level: expanded - 管理员写路径与凭证入库（Auth / credentials 触发项）。
Minimal mergeable slice: atomic - 五个端点共用同一套 403 / 404 / 键集 / 审计 / 发布骨架与同一个整体挂载用例文件；归属集（四条身份一次加齐）与八模块记录的改动必须与路由同 PR 否则三处守卫红。探活已按宽度门禁拆到组 8。

## 8. 探活（model-registry「探活」+ model-proxy「假上游夹具契约」的 `GET /models`）

- [ ] 8.1 核对 Context：`fake-upstream.mjs:123` 的路由分发、`upstream-failure.ts` 的 `upstreamExcerpt` 签名、`http/errors.ts` 归属集。
- [ ] 8.2 测试先行：假上游夹具自测加「Models listing for probes」三例（200 / `GET /models` 的 401 回显 bearer / `modelsStatus: 503`；`modelsRequests()`；chat-completions 的 401 正文与 `requests()` 不变）；新 `server/test/models-probe.test.ts`：四种结果 + 无上游零请求 + 并发串行 + 在途删除 404 且结果丢弃 + 应用 stdout/stderr 无密钥哨兵 + `models.yml` mtime 不变 + 摘要 200 码点截断 + `model.probe` 审计 + 普通账号 403（含缺失 id）+ bodyless 带 `{}` 的 content-parser 400。
- [ ] 8.3 `fake-upstream.mjs` 加 `GET /models` / `GET /v1/models` 与 `start({modelsStatus})`、`modelsRequests()`。
- [ ] 8.4 新 `server/src/models/probe.ts`（`probeUpstream({baseUrl, apiKey}, {connectDeadlineMs: 10000, totalDeadlineMs: 15000, secrets})` → `{status, message}`；期限常量本模块自有）；`rest.ts` 加 `POST /api/models/probe?id=`（串行、在途删除 404；归属身份已由组 7 加齐）。
- [ ] 8.5 ADR-0008 补充节的探活段（向外发带密钥的请求的边界）。

Suggested fixture level: expanded - 向外发带密钥的请求（outbound with credentials）。
Minimal mergeable slice: atomic - 夹具的 `GET /models` 没有探活就没有消费者；探活没有夹具无法按规格验证；两者共一条验证路径（`models-probe.test.ts`）。

## 9. 中心页外壳（model-registry「中心页外壳」+ spa-shell「路由 IA 与侧栏」+ 验收 SH-01）

- [ ] 9.1 核对 Context：`routes/manifest.ts:29-35`、`router.tsx:71-94` 的 `PlaceholderPage`、六个断言占位文案的用例（`web/test/topbar.test.tsx:191-201`、`chat-page-session-meta-support.tsx:119`、`chat-fork-button.test.tsx:592`、`chat-stop-button.test.tsx:448`、`chat-undo.test.tsx:726`、`chat-regenerate-button.test.tsx:625`）、`web/e2e/ui-walk-layout.ts:497-521`（无 `/center` 分支）、`features/settings/page.tsx` 的卡片样式、拷入层缺 `tabs`（按 ADR-0013 拷入）、`docs/acceptance/functional-checklist.md:53` SH-01。
- [ ] 9.2 测试先行：六个用例的 `中心暂不可用` 改为 `中心暂无可用内容`；新 `web/test/center-page.test.tsx`（空表：管理员与普通用户都空态、`?tab=models` 不被 replace；注入一张含 `adminOnly` tab 的表：管理员 tab 条 + 选中、普通用户空态、`?tab=unknown` replace 为首个可见 tab）；`e2e/ui-walk-layout.ts` 的 `expectAuthenticatedRoute` **新增** `/center` 分支断言空态文案；routeManifest 描述 `中心暂无可用内容` 的断言。
- [ ] 9.3 拷入 `tabs` 组件；新 `web/src/features/center/{page.tsx,tabs.ts}`（`CENTER_TABS` 为空表）；`routes/manifest.ts` 描述改 `中心暂无可用内容`；路由接入。
- [ ] 9.4 验收清单 SH-01 的期望改为「以成员账号登录，中心页显示『中心暂无可用内容』、没有 tab」、结论改 `待签`；LG-01 核对不动。

Suggested fixture level: compact - 纯前端路由壳，无数据、无权限面；可见变化只有一句文案。
Minimal mergeable slice: atomic - 页面、tab 表、`?tab=` 规则与 SH-01 改写是同一个可见变化（占位 → 空态壳），拆开任一部分都没有独立可验收行为。

## 10. 模型 tab（model-registry「模型 tab」+ 验收清单 CM 节 + F-CTR-MOD 行）

- [ ] 10.1 核对 Context：拷入层缺 `table`、`checkbox`、`select`（按 ADR-0013 拷入）；`escape-fallback.ts` 的用法；`web/src/lib/composer-contract.ts` 的严格解析写法；`api.ts` 导出面（chat-web「API 客户端源码模块划分」的 800 行与 knip 约束）。
- [ ] 10.2 测试先行（新 `web/test/center-models*.test.tsx`，假 `ApiClient`）：列表列与标签；新增表单 input 只带碰过的键 + 保存后恰一次 `probeModel`；编辑省略密钥不探活、改地址探活；种子行 `efforts` null 的预填（一个都不勾 + 旁注）与提交不带 `efforts`；客户端逐字段校验文案（五类）；删除确认与 409 行内文案；设缺省；探活在途禁用；非信封 500 后重取 + 页顶提示；两个对话框的 Escape 回退；真表下的「管理员与普通用户」场景（管理员见 `模型` tab 且选中、`?tab=nope` 被 replace 为 `models`、普通用户空态且 URL 保持 `/center?tab=models`）；`api-models.ts` 严格解析（缺键 / 多键 → `requestFailed`）与 `?id=` 的 `encodeURIComponent`。
- [ ] 10.3 拷入三个组件；新 `web/src/lib/api-models.ts` + `api.ts` 导出；`features/center/models/{list.tsx,form-dialog.tsx,use-models.ts}`；`tabs.ts` 追加 `{models, 模型, adminOnly: true}`；`routes/manifest.ts` 描述改 `模型注册表`。
- [ ] 10.4 验收清单新增「中心·模型（CM）」一节（CM-01 登记并自动探活、CM-02 编辑种子行只改名、CM-03 删缺省被拒 / 换缺省后删除、CM-04 普通用户空态而管理员见 `模型` tab（SH-01 保持成员账号的空态）、CM-05 新会话走新缺省模型、CM-06 存活会话切到新模型的第一条消息成功、CM-07 输入框菜单打开看到新模型；结论 `待签`）；`IMPLEMENTATION_PLAN.md` F-CTR-MOD 行指向本 change 并注明「对话模型；嵌入 / 重排随 kb-service」；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: expanded - 管理员录入上游密钥的表单与管理 API 客户端（credentials 触发项），尽管服务端契约已由组 7 / 8 钉住。
Minimal mergeable slice: atomic - 列表、表单、删除确认与 API 客户端是同一个 tab 的一条组件用例路径；追加 `CENTER_TABS` 项没有面板就是占位（规格禁止）。

## 11. 模型菜单打开时重取（model-selection「模型与推理强度控件」+ chat-web「输入框与能力栏」）

- [ ] 11.1 核对 Context：`model-picker.tsx` 的 `DropdownMenu` 用法、`use-chat-session.ts:756-793` 的返回对象（没有 `invalidate`）、`page.tsx:108` / `conversation-view.tsx:92,96` 的 props 链、`web/test/chat-composer-options.test.tsx:561-570,588-609`。
- [ ] 11.2 测试先行：`model-picker` 用例加「打开模型菜单恰一次 `invalidate()`、强度菜单不调」与「打开菜单看到新登记的模型」（重取落地菜单不关闭、`getComposerOptions` 共两次）；`chat-composer-options.test.tsx:561-570`（带 `modelId` 的 patch 失败）与 :588-609（deferred 队列）按「除模型菜单打开引发的之外」调整计数与队列，其余计数用例核对不打开模型菜单。
- [ ] 11.3 `model-picker.tsx` 加 `onModelMenuOpen` prop → `invalidate()`；`use-chat-session.ts` 返回对象加一行 `invalidateComposerOptions: composer.invalidate`（唯一改动，→796 行），经 `page.tsx` / `conversation-view.tsx` 的 props 链接入；`composer-options.ts` 注释同步。

Suggested fixture level: compact - 单个控件多一次既有的重取调用，无新数据面。
Minimal mergeable slice: atomic - 一个 prop、返回对象一行与两个计数用例的调整是同一次行为变化。
