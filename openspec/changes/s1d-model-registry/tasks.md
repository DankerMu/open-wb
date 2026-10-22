# Tasks: s1d-model-registry

> 跟踪：Stage 5 在 Epic 下建子 issue，组 6 按宽度门禁拆为 6a（中心外壳）/ 6b（模型 tab + 选择器重取 + 文档验收），其余五组各一个子 issue，共七个、各一个 PR。依赖（真实依赖，不串成线性链）：组 2 依赖组 1（store 抛 `model_in_use`）；组 3 依赖组 2 与组 4（装配把注册表接进代理的 `models` 契约）；组 4 只依赖组 1（`forbidden` 不用，但 lookup 夹具的 400 / 502 语义与组 1 无关——组 4 实际独立，列作「依赖组 1」只为合入次序简单；Stage 5 按独立处理）；组 5 依赖组 3；组 6a 独立；组 6b 依赖组 5 与组 6a。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实，出入先改 design 再继续；密钥、上游地址、测试主机不进任何被跟踪文件；产品代码单文件 ≤800 行，贴近上限的测试文件不再往里加，新用例进新文件；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169）；验收清单新增行结论一律 `待签`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 凭证泄露（密钥 / base URL 进响应、审计、stderr、models.yml） | 是 | 组 4、组 5、组 3 的哨兵断言 |
| 代理放行语义回归（未登记模型被转发、重复 `model` 键） | 是 | 组 4 沿用既有 `model-guard` 用例 |
| 启动阶段与失败记录（新阶段、种子失败、env 忽略） | 是 | 组 3 |
| 两份真相（快照 vs 表 vs 托管文件） | 是 | 组 3 单飞与字节用例 |
| 权限（非管理员写注册表） | 是 | 组 5 先于 body 的 403 |
| 迁移与 DB 约束 | 是 | 组 2 |

## 1. 错误码与管理员判定（http-service-skeleton「统一错误信封」+ 「公共错误类型归属 core」不变）

- [ ] 1.1 核对 design Context 的错误码与 `ADMIN_ROLE` 事实（`core/errors/index.ts:5-22`、`http/errors.ts`、`core/audit/index.ts:13,81`、三个计数测试的行号）。
- [ ] 1.2 测试先行：`http-typed-errors.test.ts:123` 与 `auth-lifecycle.test.ts:705` 的「恰十六码」改十八并加两码的状态 / message 断言；新文件 `core-roles.test.ts`（`isAdmin`：`管理员` 真；`管理员 `、`admin`、空串假）；http-service-skeleton 新场景「两个 s1d 新码」的测试路由用例。
- [ ] 1.3 `core/errors/index.ts` 加 `forbidden`、`model_in_use`；`http/errors.ts` 加 403 / 409 映射。
- [ ] 1.4 新 `server/src/core/roles.ts`（`ADMIN_ROLE`、`isAdmin(principal: {role: string})`）；`core/audit/index.ts` 改导入、删私有常量；`audit-core` 既有用例保持绿。
- [ ] 1.5 规格主文件暂不改（归档时合并 delta）；`docs/architecture/system.md` 错误码表（若有列举）同步两码。

Suggested fixture level: compact - 纯枚举与纯函数扩展，既有计数测试直接钉住，无 IO、无权限面变化（403 的消费者在组 5）。
Minimal mergeable slice: atomic - 两码与 `isAdmin` 都是组 5 的前置且各自只有一条计数 / 纯函数验证路径，拆开没有独立可验收行为。

## 2. 迁移 046 与注册表 store（model-registry「迁移 046 模型表」「注册表快照是白名单的唯一来源」的 store 部分 + 「环境种子」的纯 DB 部分 + model-selection「模型白名单配置」的 `validateCatalogModel`）

- [ ] 2.1 核对 Context：`model-catalog.ts:48-83` 的校验分支、`core-db-helpers.ts:8-27` 的清单形状、`045_*` 为最后一个迁移。
- [ ] 2.2 测试先行（新文件 `models-store.test.ts`，`:memory:` + 真实迁移）：建表与两条约束（部分唯一索引、上游两列同 NULL）；`create` 的合法缺省 / 重复 id 409 / 第 33 个 400 / model-selection「非法白名单使启动失败」清单的单项 body 各 400（错误 message 不含取值）；首行自动缺省；`update` 整体替换、省略 `apiKey` 保留、无密钥时省略 400、`upstream: null` 清空；`remove` 缺省 409 `model_in_use`、非缺省 204 语义；`setDefault` 事务（旧清新立，中途失败两者都不变）；`seedIfEmpty`（空表插入三模型 + 缺省 + 单模型配置 `efforts` NULL；非空表返回 `skipped` 且不写）；`list()` 次序；`toCatalog(rows)` 与 `resolveModelCatalog(env)` 对同一输入深等于；`MIGRATION_046` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 2.3 `server/migrations/046_models.sql` 按 design D3 建表与索引；`core-db-helpers.ts` 加常量。
- [ ] 2.4 `model-catalog.ts`：把单项校验提成导出的 `validateCatalogModel(input: unknown, {fieldPrefix}): CatalogModel`，`parseCatalog` 改调它；新增 `validateUpstream({baseUrl, apiKey})`（复用 `agent-config.ts:241` 的 header 判定，提成共享函数）。
- [ ] 2.5 新 `server/src/models/store.ts`：`createModelStore(db)` → `{list, get, create, update, remove, setDefault, seedIfEmpty, recordProbe, toCatalog, secrets}`；全部 `HttpError`；密钥只在 `get`/`routeOf` 的内部返回，`list` 的视图映射只给 `hasApiKey`。

Suggested fixture level: expanded - 新迁移（persisted schema）与密钥落库（credentials at rest），尽管全部是纯 DB 用例。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者、store 没有迁移跑不起来；`validateCatalogModel` 的提取是 store 校验的唯一来源，单独提取没有可验收行为（既有 env 用例已覆盖）。

## 3. 启动装配、快照与发布（http-service-skeleton「服务启动与装配」+ model-registry「环境种子」「注册表快照是白名单的唯一来源」「变更即发布」+ session-composer-settings「输入框选项端点」+ model-selection「模型与强度从下一条消息起生效」的回落场景）

- [ ] 3.1 核对 Context：`server.ts:137,302-314,541-549`、`app.ts:212-241`、`rest-composer.ts:34-60`、`store-composer.ts:26,104-107`、`composer-align.ts:22`、`supervisor.ts:80`（`SessionRuntime.modelId` 的消费者——确无则删字段，有则改读快照缺省）。
- [ ] 3.2 测试先行：`server-startup-order.test.ts` 的阶段序列加 `model_registry`（位置、失败 `reason`：空库上把 `models` 换成只读视图）；新 `server-startup-model-seed.test.ts`（零配置 / 三模型 + 上游哨兵的种子行、`models.yml` 字节等于既有基线、非空表 + `MODEL_ID` 的 `model_env_ignored` 恰一行、非空表 + 六键未设置零行、非空表 + `MODEL_CATALOG=not json` 仍 `config` 失败）；新 `models-publish.test.ts`（`publish()` 两文件字节 = `writeManagedModelsYml` / `writeHostOverlay` 直接调用；看图角色随快照；单飞：并发三次写入 ≤3 次重写、终态等于最后快照；失败抛出且不留临时文件）；`composer-options` 用例加「写入后不重启即变化」与甲 / 乙缺省（model-registry 场景）；假 omp 真子进程用例「删除模型后的回落」（`set_model` 回落缺省、会话行不变）。
- [ ] 3.3 新 `server/src/models/registry.ts`（`createModelRegistry(store)` → `{current(), lookup(id), secrets(), refresh()}`，快照同步读）与 `server/src/models/publish.ts`（`createPublisher({agentDir, stateDir, proxyBaseUrl, browserEnabled, registry})` → `publish(): Promise<void>` 单飞 + 合并等待）。
- [ ] 3.4 `server.ts`：阶段 `model_registry`（`seedIfEmpty` → `refresh`；`model_env_ignored` 记录）；`models_yml` / `host_overlay` 改调 `publish()` 的两步（保持两个 `reason` 不变）；`SessionRuntime.modelId` 按 3.1 结论处理；`app.ts`：`assembly.registry` 取代 `assembly.modelCatalog`，代理收 `registry`（组 4 的契约），`composer.modelCatalog` 改为 getter。
- [ ] 3.5 `rest-composer.ts` / `store-view.ts` / `store-composer.ts` / `composer-align.ts` 经 getter 读快照（签名不变，核对无一处缓存 `modelCatalog` 到模块级）。
- [ ] 3.6 `docs/architecture/system.md` 启动阶段列表加 `model_registry`；`.env.example`（若有）与部署文档注明六键为首次种子。

Suggested fixture level: expanded - 改生产启动顺序、启动失败枚举与托管文件的写出时机（production config / file publish 触发项）。
Minimal mergeable slice: atomic - 种子、快照、发布与装配是同一条「注册表成为真相」的通路：只加阶段不接快照则两份真相并存且 `models.yml` 与 composer options 可能不一致；只接快照不种子则零配置启动的表为空、`models.yml` 写出器拒绝空列表、启动失败。

## 4. 代理按模型路由（model-proxy「透传端点与 bearer 鉴权」）

- [ ] 4.1 核对 Context：`model-proxy/index.ts:38-42,91-96,148-156,166-210,262-271`，`model-guard.ts` 的扫描接口，既有 `model-proxy-*.test.ts` 的装配方式。
- [ ] 4.2 测试先行：既有代理用例改用 `models` 夹具（`lookupFromCatalog` 或手写 lookup）；新 `model-proxy-routing.test.ts`：未登记 400 不回显 / 登记无上游 502 / malformed + 无上游 400（次序变化）/ 两模型两个假上游各收自己的请求与 bearer / 500 摘要净化覆盖两个上游哨兵与 base URL / 转发后 lookup 改变不影响在途流、第二请求 400；`model-guard` 既有用例（重复 `model` 键等）不改。
- [ ] 4.3 `ModelProxyOptions` 改为 `{tokens, models: ModelLookup, connectDeadlineMs?, firstByteDeadlineMs?}`；删 `allowedModels` / `upstream` 与注册时的 `upstreamLink`；`authenticate` 只做 bearer；`parseJsonBytes` 的白名单判定改为 `lookup !== undefined`，并把返回的 route 交给转发；转发用 `joinChatCompletions(route.upstream.baseUrl)` 与 `Bearer <route.upstream.apiKey>`；净化密钥集每次取 `models.secrets()`。
- [ ] 4.4 `app.ts` 无 assembly 时的 `lookupFromCatalog(catalog, upstream?)`（`server/src/model-proxy/lookup.ts`）；assembly 提供 `models` 时直接用（组 3 接注册表）。
- [ ] 4.5 官方 omp 用例（`WORKBUDDY_OMP_TEST=1`）与 `make smoke` 的假上游路径保持绿；`docs/architecture/system.md` 9.5 加「按模型路由」一段；ADR-0008 补充节的代理部分。

Suggested fixture level: expanded - 改每一次模型转发的放行与凭证选择（Auth / credentials 触发项）。
Minimal mergeable slice: atomic - 查找契约、次序与净化集是同一个请求路径的三段：只换契约不改次序则「无上游先 502」与按模型上游矛盾；不改净化集则第二个上游的密钥可能出现在第一个上游的失败摘要里。

## 5. 管理端点、审计与探活（model-registry「模型管理端点」「探活」+ http-service-skeleton「统一错误信封」的归属身份）

- [ ] 5.1 核对 Context：`http/path-classifier.ts`（或归属集所在处）与 `http-parser-owners.test.ts:28,49` 的身份清单；`core/audit` 的 `emit` 签名；`fake-upstream.mjs` 是否已有 `GET /models`（没有则加，按「假上游夹具契约」补 delta 场景——若需要则在本组补 model-proxy delta 的 ADDED 场景）。
- [ ] 5.2 测试先行（新 `models-rest.test.ts`，整体挂载 + 假上游）：401 / 403（普通账号，先于 body：malformed body 仍 403）/ 404 / 键集严格清单 / 201 视图不含密钥 / `PUT` 三例 / `DELETE` 三例 / `default` 后 composer options 甲乙差异 / 五种审计 kind 与 detail 不含哨兵与 base URL / `http-parser-owners` 二十一条 / 两个 bodyless 路由带 `{}` 400；新 `models-probe.test.ts`：四种结果 + 无上游零请求 + 并发探活串行 + stdout/stderr 无哨兵 + `models.yml` mtime 不变。
- [ ] 5.3 新 `server/src/models/probe.ts`（`probeUpstream({baseUrl, apiKey}, {connectDeadlineMs, totalDeadlineMs, secrets})` → `{status, message}`，复用 `upstream-failure.ts` 的净化）与 `server/src/models/rest.ts`（六端点；写入事务内 `emit`；成功后 `registry.refresh()` + `publish()`；探活不发布）。
- [ ] 5.4 `app.ts` 注册 `registerModels(app, {db, store, registry, publish, emit})`；归属集加四条身份。
- [ ] 5.5 `docs/architecture/system.md` 加「模型注册表」一节（端点、审计 kind、探活）；ADR-0008 加「2026-10-21 补充（s1d-model-registry）」（密钥落 DB 0600、按模型净化、探活发出带密钥的请求的边界）。

Suggested fixture level: expanded - 管理员写路径、凭证入库与向外发带密钥的探活请求（Auth / credentials / outbound）。
Minimal mergeable slice: 端点 + 审计为首刀（5.1–5.4 除探活、5.5 的端点部分）；探活为后继（`probe.ts`、`POST …/probe`、`models-probe.test.ts`、ADR 的探活段），依赖首刀的视图与路由骨架。两者各有独立验证路径（REST 用例不需要上游；探活用例需要假上游的 `GET /models`）。Stage 5 可按宽度门禁拆成 5a / 5b。

## 6. 中心外壳与模型 tab（model-registry「中心页外壳」「模型 tab」+ spa-shell「路由 IA 与侧栏」+ model-selection「模型与推理强度控件」的重取 + 验收清单）

- [ ] 6.1 核对 Context：`routes/manifest.ts:29-35`、`routes/ui-walk` 对 `/center` 的断言、`features/settings/page.tsx` 的卡片样式、拷入层已有的 `tabs` / `table` / `dialog` / `alert-dialog` / `checkbox` / `select` 组件（缺的按 ADR-0013 的拷入流程加）、`model-picker.tsx` 的 `DropdownMenu` 用法与 `use-chat-session.ts` 里 `invalidate` 的传递。
- [ ] 6.2 测试先行（外壳）：`ui-walk` 的 `/center`（管理员 tab 条 + `模型` 选中；普通用户空态无 tab 条；`?tab=nope` replace 为 `models`；普通用户 `?tab=models` 保持 URL）；routeManifest 描述 `模型注册表`。
- [ ] 6.3 新 `web/src/features/center/{page.tsx,tabs.ts}`；`routes/manifest.ts` 描述改写；spa-shell 既有 `/center` 占位断言改写。
- [ ] 6.4 测试先行（模型 tab）：新 `features/center/models/*.test.tsx`（假 `ApiClient`）：列表列与标签；新增表单的 input 只带碰过的键 + 保存后恰一次 `probeModel`；编辑省略密钥不探活、改地址探活；删除确认与 409 行内文案；设缺省；探活按钮在途禁用；`api-models.ts` 严格解析（缺键 / 多键 → `requestFailed`）；`model-picker` 打开菜单恰一次 `invalidate()`、强度菜单不调（model-selection 两个场景）。
- [ ] 6.5 新 `web/src/lib/api-models.ts` + `api.ts` 导出；`features/center/models/{list.tsx,form-dialog.tsx,use-models.ts}`；`model-picker.tsx` 加 `onModelMenuOpen` → `invalidate()`，`use-chat-session.ts` 传入。
- [ ] 6.6 验收清单新增「中心·模型（CM）」一节（CM-01 登记并探活、CM-02 编辑保留密钥、CM-03 删缺省被拒 / 换缺省后删除、CM-04 普通用户空态、CM-05 新会话走新缺省模型、CM-06 输入框菜单看到新模型；结论 `待签`）；`IMPLEMENTATION_PLAN.md` F-CTR-MOD 行指向本 change；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 纯前端与文档；服务端契约已由组 5 钉住，UI 用假客户端验证。
Minimal mergeable slice: 中心外壳为首刀（6.1 的外壳部分、6.2、6.3），模型 tab 为后继（6.4、6.5、6.6），后继依赖首刀的 `CENTER_TABS` 与页面骨架，也依赖组 5 的端点。两者各自只有一条验证路径（`ui-walk` vs 组件用例）。Stage 5 按宽度门禁拆成 6a / 6b。
