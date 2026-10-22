# Tasks: s1d-connectors

> 跟踪：Stage 5 在 Epic 下建子 issue，七个任务组各一个子 issue、各一个 PR。下文「专家技能组 N」指 `s1d-experts-skills` tasks.md 的任务组 N（Epic #1654：组 1 = #1656、组 2 = #1655、组 5 = #1659、组 6 = #1660、组 8 = #1662、组 10 = #1664）。依赖（真实依赖）：组 1 依赖专家技能组 2（迁移 047 先于 048）；组 2 依赖组 1、#1647（启动阶段 `models_yml` / `host_overlay` 与 `server.ts` 行数）与专家技能组 1（官方前提用例要用会话配置文件写 `mcp:<名>`）；组 3 依赖组 2（写后发布）、#1641（`forbidden`）与专家技能组 5（启动模块记录与归属身份计数守卫在其上再加）；组 4 依赖组 3（探活路由挂在端点模块上）；组 5 依赖组 3（归属身份计数再加一、store）与专家技能组 6（能力指纹与 spawn 能力接线）；组 6 依赖组 4、组 5（账号缺省端点）与专家技能组 8（`tabs.ts` 与中心用例）；组 7 依赖组 5、组 6（`api-connectors.ts`）与专家技能组 10（「能力」弹层）。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实；连接器的 `env` / `headers` 值不进任何响应、审计、日志；产品代码单文件 ≤800 行；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| omp 改写取值（`!` 命令、`${}` 插值、环境变量名替换） | 是 | 组 1 校验、组 2 官方用例的反证 |
| 凭证泄露（`env` / `headers` 值进响应、审计、日志、探活摘要） | 是 | 组 3、组 4 的哨兵断言 |
| omp 前提（`--no-extensions` 下读用户级 `mcp.json`、`mcp:<名>` 停用、后台发现的可观察面） | 是 | 组 2 官方用例 |
| 两份真相（DB vs `mcp.json` vs 存活进程） | 是 | 组 2 发布、组 5 指纹 |
| 权限（非管理员写入） | 是 | 组 3 的 403 矩阵 |
| 迁移与 DB 约束 | 是 | 组 1 |

## 1. 迁移 048 与连接器 store（connectors「迁移 048 连接器 schema」「连接器取值规则」）

- [ ] 1.1 核对 Context：迁移目录（`s1d-experts-skills` 合入后最后为 047）、`server/test/core-db-helpers.ts`、`spawn-env.ts` 的环境白名单（导出复用）、`s1d-model-registry` 的 `validateUpstream` 地址部分。
- [ ] 1.2 测试先行：新 `server/test/connectors-store.test.ts`（`:memory:` + 真实迁移）：迁移 048 的两条形状 CHECK、级联、`chat_sessions.disabled_connectors` 缺省；`validate` 的每条规则（名称正反例含 `git2` / `Git` / `a_`；stdio 绝对路径；`args` / `env` 上限与键名；http 地址与请求头；`!` 开头、含 `${`、值恰为白名单变量名三类在每个字段上各一例）与 message 不含取值；`create` / `update`（`null` 保留、键不存在 400）/ `remove` / 第 33 个 400；`account_connector_prefs` 读写；`MIGRATION_048` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 1.3 `048_connectors.sql`；新 `server/src/connectors/{validate.ts,store.ts}`；`spawn-env.ts` 导出白名单名称表（不改行为）。

Suggested fixture level: expanded - 新迁移与凭证落库（persisted schema + credentials at rest），并承担拦住 omp 取值改写的唯一闸门。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者；取值规则是 store 写入的唯一入口，拆开则存在未校验的写入路径。

## 2. 托管 mcp.json 与发布（connectors「托管 mcp.json」；omp-runtime「OMP_STATE_DIR 托管布局」；ADR-0015）

- [ ] 2.1 核对 Context：`state-layout.ts` 的 agent 目录模式、`replace-file.ts`、`models-yml.ts` 的写出与 `server.ts` 的 `models_yml` / `host_overlay` 阶段（`s1d-model-registry` 组 5 合入后的写法）、omp 源码 `discovery/builtin.ts` 与 `capability/mcp.ts` 的读取与停用规则、`server/test/support/omp-official*.ts` 的 `get_state` 写法。
- [ ] 2.2 测试先行：新 `server/test/connectors-mcp-json.test.ts`（字节：排序、只含启用行、空表、JSON 转义、0640；发布器单飞与 `agentDir()` 为 null 时不写；写出失败抛出）；`server-startup-failure-reason.test.ts` 加 `mcp_json` 阶段例（`host_overlay` 之后）；启动用例：零连接器启动后 `mcp.json` 为空对象、状态根与 agent 目录的精确清单随之更新；新 stdio MCP 夹具 `server/test/support/fake-mcp-server.mjs`（JSON-RPC over stdio：`initialize`、`tools/list` 返回 `echo`、`tools/call`）与其自测；新官方 omp 用例 `server/test/omp-official-connectors.test.ts`（`WORKBUDDY_OMP_TEST=1`）：connectors「官方 omp 读取并按会话停用」两例，轮询 `get_state.systemPrompt` ≤30 s；uid-isolation：omp uid 能读 `mcp.json`、不能写（`server/test/linux/uid-isolation.test.ts` 的托管布局用例加一项，CI `uid-isolation`）。
- [ ] 2.3 新 `server/src/connectors/mcp-json.ts`（内容生成 + `createMcpPublisher`）；`server.ts` 启动阶段 `mcp_json`（超过 780 行即并进 `startup-registry.ts`）；`.github/scripts/ci-uid-isolation.sh` 官方用例清单加 `test/omp-official-connectors.test.ts`、`scripts/test-ci-harness.sh` 期望同步。
- [ ] 2.4 `docs/adr/0015-mcp-connector-credentials.md`（design D11）；`docs/architecture/system.md`「连接器」一节的 `mcp.json` 段、启动阶段表加 `mcp_json`；ADR-0010 布局表 agent 目录行加 `mcp.json`。

Suggested fixture level: expanded - 新的托管配置文件与启动阶段（production config / file publish），omp 每次 spawn 按它拉起进程；三个 omp 前提由官方二进制钉住。
Minimal mergeable slice: atomic - 写出器、发布器与启动阶段是同一份文件的生成与落地：只有写出器没有阶段则文件从不出现，只有阶段没有发布则登记后不生效；官方前提用例与之同 PR，否则「`--no-extensions` 下仍读 `mcp.json`」「`mcp:<名>` 停用」两个前提未钉。

## 3. 连接器管理端点与审计（connectors「连接器管理端点」；http-service-skeleton 三条）

- [ ] 3.1 核对 Context：`http/errors.ts` 归属集与 `http-parser-owners.test.ts` 身份清单（`s1d-experts-skills` 组 5 合入后二十五条）、启动模块列表（十个）、`core/roles` 的 `isAdmin`、`s1d-model-registry` 的 `models/rest.ts` 写法。
- [ ] 3.2 测试先行：新 `server/test/connectors-rest.test.ts`（整体挂载）：401 / 403 矩阵（普通用户 × 四个写与探活路由 × malformed / 缺 name / 未知 name）先于 body；`name` 缺失 / 空 / 多值 400；404；键集严格与跨类型键 400；两种视图（普通用户只见启用行三键）；全文无 `env` / `headers` 哨兵；`PUT` 的 `null` 保留与键不存在 400；重名 409；三种审计 kind 与 detail；发布失败（agent 目录换成普通文件）→ 500 非信封 + `onPublishFailed` 恰一次 + 行保留 + 恢复后再写入生效；no-store；`POST /api/connectors`、`PUT /api/connectors` 的 content-parser 400；启动记录十一个模块、归属身份二十七条。
- [ ] 3.3 新 `server/src/connectors/rest.ts`（不含探活路由）；`app.ts` 注册模块 `connectors`（`onPublishFailed` 沿用模型注册表的注入口）；归属集加两条身份；`STARTUP_MODULES` 加 `connectors`；三处模块列表断言同步。
- [ ] 3.4 `docs/architecture/system.md`「连接器」一节加端点、视图与审计 kind。

Suggested fixture level: expanded - 管理员写路径与凭证入库（Auth / credentials 触发项）。
Minimal mergeable slice: atomic - 四个方法共用同一套 401 / 403 / 404 / 键集 / 审计 / 发布骨架与一个整体挂载用例文件；归属集与模块记录必须与路由同 PR。探活按宽度门禁拆到组 4。

## 4. 连接器探活（connectors「连接器探活」）

- [ ] 4.1 核对 Context：`s1d-model-registry` 的 `models/probe.ts` 与 `upstreamExcerpt` 净化、组 3 的 rest 模块。
- [ ] 4.2 测试先行：新 http MCP 夹具 `server/test/support/fake-mcp-http.mjs`（`initialize` 的 JSON 与 SSE 两种应答、可脚本化状态码与回显请求头）；新 `server/test/connectors-probe.test.ts`：「http 与 stdio」场景六例 + SSE 应答 `ok` + 超时（整体期限注入 1 s）+ 并发串行 + 在途删除 404 + 摘要不含请求头哨兵 + `mcp.json` mtime 不变 + `connector.probe` 审计 + 普通用户 403 + bodyless 带 `{}` 的 content-parser 400。
- [ ] 4.3 新 `server/src/connectors/probe.ts`；`rest.ts` 加 `POST /api/connectors/probe?name=`；归属集加一条身份（二十八条）。

Suggested fixture level: expanded - 向外发带请求头凭证的请求（outbound with credentials）。
Minimal mergeable slice: atomic - 夹具没有探活就没有消费者，探活没有夹具无法按规格验证；两者共一条验证路径。

## 5. 账号缺省、会话能力与派发指纹（connectors「连接器账号缺省」；skill-switches 三条；session-metadata 两条；chat-sessions「派发前按会话设置对齐进程」）

- [ ] 5.1 核对 Context：`s1d-experts-skills` 的 `rest-capabilities.ts`、会话创建初值、fork 事务、spawn 能力接线与指纹（其组 5、组 6 合入后的代码）。
- [ ] 5.2 测试先行：`server/test/connectors-defaults.test.ts`（`GET` / `PUT /api/connectors/defaults` 键集、上限、名称规则、不要求已登记、content-parser 400）；会话能力用例扩展：`POST /api/sessions` 带 `disabledConnectors` 与账号缺省初值、能力端点的 `disabledConnectors`、fork 复制；spawn 用例：会话配置文件 `disabledExtensions` 同时含 `skill:` 与 `mcp:` 且排序去重；派发用例（假 omp 真子进程）：登记 / 修改 / 停用某连接器后下一条重启、`mcp.json` 不变则复用。
- [ ] 5.3 账号缺省端点（`connectors/rest.ts`，归属集加一条，二十九条）；会话创建键、能力端点与 fork 加 `disabledConnectors`；spawn 能力合并 `mcp:<名>`；能力指纹并入当前 `mcp.json` 字节。
- [ ] 5.4 `docs/architecture/system.md`「连接器」一节加账号缺省、会话停用与「连接器变化使存活会话下一条重启」。

Suggested fixture level: expanded - 改派发路径的重启判据与会话创建契约（Critical Path「omp 子进程治理」+ persisted state）。
Minimal mergeable slice: atomic - 账号缺省、会话列与 spawn 合并是同一个停用集合的写、存、用；指纹并入 `mcp.json` 与之同 PR，否则登记变化后存活进程永远读旧文件。

## 6. 中心「连接器」tab（connectors「中心「连接器」tab」；model-registry「中心页外壳」；验收 CC 节）

- [ ] 6.1 核对 Context：`features/center/tabs.ts` 与中心用例（`s1d-experts-skills` 组 8 合入后）、`s1d-model-registry` 的模型 tab 表单与自动探活写法、拷入层（`select`、`switch`）。
- [ ] 6.2 测试先行：新 `web/test/center-connectors*.test.tsx`（假 `ApiClient`）：普通用户视图（无命令 / 地址 / 管理按钮）与 `默认启用` 整表 `PUT`（含列表外名称、在途禁用、失败回滚）；管理员视图、`启用` 开关、新增 stdio / http 表单（客户端校验三类改写取值与名称规则、只发碰过的键）、编辑时留空为 `null`、保存后自动探活规则、删除确认、探活在途禁用、Escape 回退、空态文案；`api-connectors.ts` 两种视图严格解析与 `name` 编码；中心用例的 tab 条（普通用户 `专家`、`技能`、`连接器`）与 routeManifest 描述 `专家、技能与连接器`；`e2e/ui-walk-layout.ts` 的 `/center` 分支核对不受影响。
- [ ] 6.3 新 `web/src/lib/api-connectors.ts` + `api.ts` 导出；`web/src/features/center/connectors/{list.tsx,form-dialog.tsx,use-connectors.ts}`；`tabs.ts` 插入 `{connectors, 连接器, adminOnly:false}`；routeManifest 描述。
- [ ] 6.4 验收清单新增「中心·连接器（CC）」CC-01 管理员登记 stdio 连接器后新会话可用其工具、CC-02 登记 http 连接器并探活、CC-03 普通用户关闭默认启用后新会话不加载、CC-04 含 `!` / `${` 的取值被拒、CC-05 `只问命令` 下 MCP 调用不弹确认而 `每次都问` 下弹；结论 `待签`；`IMPLEMENTATION_PLAN.md` F-CTR-CON 行指向本 change；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: expanded - 管理员录入连接器凭证的表单（credentials 触发项），尽管服务端契约已由组 3–5 钉住。
Minimal mergeable slice: atomic - 列表、两种视图、表单与 API 客户端是同一个 tab 的一条组件用例路径；追加 tab 项没有面板就是占位。

## 7. 「能力」弹层的连接器段（skill-switches「输入框「能力」弹层」）

- [ ] 7.1 核对 Context：`s1d-experts-skills` 组 10 合入后的 `capability-popover.tsx` 与 `use-session-capabilities.ts`、`welcome-options.ts`。
- [ ] 7.2 测试先行：`web/test/chat-capability-popover.test.tsx` 加连接器段：只列启用的连接器、开关初值（欢迎态取账号缺省、会话中取能力）、切换恰一次 `PUT …/capabilities {disabledConnectors}`、失败回滚、欢迎态动过才在 `POST /api/sessions` 带 `disabledConnectors`、读取中与失败态；读取时机（欢迎态第一次打开弹层取一次 `listConnectors` 与 `getConnectorDefaults`）。
- [ ] 7.3 `capability-popover.tsx` 加连接器段；`use-session-capabilities.ts` 与 `welcome-options.ts` 加 `disabledConnectors`；`api-session-capabilities.ts` 解析加键。
- [ ] 7.4 验收清单新增 CH 行「会话中关掉一个连接器，下一条回答不再能用它的工具」；结论 `待签`；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 弹层多一段开关与一个请求键，服务端契约与 omp 效果由组 2、组 5 钉住。
Minimal mergeable slice: atomic - 开关、初值与请求键是同一个可见行为的一条组件用例路径。
