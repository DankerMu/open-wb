# Tasks: s1d-connectors

> 跟踪：Stage 5 在 Epic 下建子 issue，八个任务组（1、2a、2b、3、4、5、6、7）各一个子 issue、各一个 PR。下文「专家技能组 N」指 `s1d-experts-skills` tasks.md 的任务组 N（Epic #1654：组 1 = #1656、组 2 = #1655、组 5 = #1659、组 6 = #1660、组 8 = #1662、组 9 = #1663、组 10 = #1664）。依赖（真实依赖）：组 1 依赖专家技能组 2（迁移 047 先于 048）；组 2a 依赖组 1 与 #1647（启动阶段 `models_yml` / `host_overlay` 与 `server.ts` 行数）；组 2b 依赖组 2a（官方用例的 `mcp.json` 由 2a 的内容生成函数写出）与专家技能组 1（会话配置文件写 `mcp:<名>`）；组 3 依赖组 2a（写后发布）、#1641（`forbidden`）与专家技能组 5（启动模块记录与归属身份计数守卫在其上再加）；组 4 依赖组 3（探活路由挂在端点模块上；归属身份 27 → 28）与 #1650（模型探活的 `upstreamExcerpt` 净化）；组 5 依赖组 4（串行：归属身份 28 → 29 精确断言，与组 4 并行会互相打架；store）、专家技能组 6（能力指纹与 spawn 能力接线）、#1663（专家技能组 9：web 的 `api-session-capabilities.ts` 严格解析器）与 #1664（专家技能组 10：其用例手写的能力应答须在三键之前已在主干）；组 6 依赖组 4、组 5（账号缺省端点）与专家技能组 8（`tabs.ts` 与中心用例）；组 7 依赖组 5（能力应答三键已解析）、组 6（`api-connectors.ts`）与专家技能组 10（「能力」弹层）。
> 通用纪律见 design「通用纪律」：测试先行；每组第一个任务核对 design「Context」的行号与事实；连接器的 `env` / `headers` 值不进任何响应、审计、日志；产品代码单文件 ≤800 行；不新增 `.css`；官方二进制用例本机以 `WORKBUDDY_OMP_TEST=1` 与 `var/omp/omp`（v18.12.3）跑。
> 文档与验收行随组走（AGENTS.md:169-170）；改变用户可见行为的组在同一 PR 增改验收行并写 `待签`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| omp 改写取值（`!` 命令、`${}` 插值、环境变量名替换） | 是 | 组 1 校验与 `OMP_CHILD_ENV_NAMES` 覆盖用例、组 3 的 REST 拒绝 |
| 凭证泄露（`env` / `headers` 值进响应、审计、日志、探活摘要） | 是 | 组 3、组 4 的哨兵断言 |
| omp 前提（`--no-extensions` 下读用户级 `mcp.json`、`mcp:<名>` 停用、后台发现的可观察面、`xd://` 挂载） | 是 | 组 2b 官方用例 |
| 两份真相（DB vs `mcp.json` vs 存活进程） | 是 | 组 2a 发布、组 5 指纹 |
| 权限（非管理员写入） | 是 | 组 3 的 403 矩阵、组 4 的探活 403 |
| 凭证被整体替换清掉 | 是 | 组 3 的「启用开关不丢凭证」、组 6 的 `启用` 开关 body |
| 迁移与 DB 约束 | 是 | 组 1 |

## 1. 迁移 048 与连接器 store（connectors「迁移 048 连接器 schema」「连接器取值规则」）

- [ ] 1.1 核对 Context：迁移目录（`s1d-experts-skills` 合入后最后为 047）、`server/test/core-db-helpers.ts`、`server/src/sessions/omp/spawn-env.ts` 的 `ompSpawnEnv` 与 `SUDO_PRESERVE_ENV`、`process.ts` 的 sudo 前缀、`s1d-model-registry` 的 `validateUpstream` 地址部分。
- [ ] 1.2 测试先行：新 `server/test/connectors-store.test.ts`（`:memory:` + 真实迁移）：迁移 048 的两条形状 CHECK、级联、`chat_sessions.disabled_connectors` 缺省；`validate` 的每条规则（名称 `^[a-z]{1,32}$` 正反例含 `git2` / `Git` / `a_` / `git_lab` / 33 个字母；stdio 绝对路径；`args` / `env` 上限与键名；http 地址与请求头；含 `${` 在五个字段上各一例（`command`、`url` 用形状合法的值，如 `/usr/bin/${X}`、`https://h/${X}`）、`!` 开头在 `args`、`env` 值、`headers` 值上各一例、值恰为 `OMP_CHILD_ENV_NAMES` 成员只在 `env` 值与 `headers` 值上各一例，含 `headers:{authorization:"WORKBUDDY_MODEL_TOKEN"}` 与 `env:{X:"HOME"}`）与 message 不含取值；`create` / `update`（`null` 保留、键不存在 400、省略 `env` / `headers` 即为空、省略 `enabled` 即为 `true`、连接参数变化复位探活三列而只改 `description` / `enabled` 不复位）/ `remove` / 第 33 个 400；新 `server/test/omp-spawn-env-names.test.ts`：`ompSpawnEnv(...)` 在带与不带 `browserBin` / `LANG` / `TMPDIR` 两种输入下输出的每个键都在 `OMP_CHILD_ENV_NAMES` 里，`SUDO_PRESERVE_ENV` 的每个名称、sudo 注入的十一个名称与 `PI_NO_PTY` / `PI_NO_TITLE` / `PI_NOTIFICATIONS` / `__PI_NATIVE_VARIANT_CACHE` / `EXA_API_KEY` / `BUN_BE_BUN` 都在；`account_connector_prefs` 读写；`MIGRATION_048` 进 `TRACKED_MIGRATION_FILENAMES`。
- [ ] 1.3 `048_connectors.sql`；新 `server/src/connectors/{validate.ts,store.ts}`；`spawn-env.ts` 在 `ompSpawnEnv` 旁导出 `OMP_CHILD_ENV_NAMES`（design D3，不改 `ompSpawnEnv` 的行为）。

Suggested fixture level: expanded - 新迁移与凭证落库（persisted schema + credentials at rest），并承担拦住 omp 取值改写的唯一闸门。
Minimal mergeable slice: atomic - 迁移没有 store 就没有读者；取值规则是 store 写入的唯一入口，拆开则存在未校验的写入路径。

## 2a. 托管 mcp.json、发布与启动阶段（connectors「托管 mcp.json」；omp-runtime「OMP_STATE_DIR 托管布局」；omp-uid-isolation「Linux 隔离证明」；ADR-0015）

- [ ] 2a.1 核对 Context：`state-layout.ts` 的 agent 目录模式、`core/replace-file.ts`、`server/src/model-proxy/models-yml.ts` 的写出与 `server.ts` 的 `models_yml` / `host_overlay` 阶段（`s1d-model-registry` 组 5 合入后的写法）、design Context「既有用例」列出的 agent 目录清单断言、`server/test/linux/uid-isolation.test.ts` 的托管布局用例。
- [ ] 2a.2 测试先行：新 `server/test/connectors-mcp-json.test.ts`（字节：`JSON.stringify(…, null, 2) + "\n"`、排序、只含启用行、空表恰为 `{\n  "mcpServers": {}\n}\n`、JSON 转义、0640；发布器单飞与 `agentDir()` 为 null 时不写；写出失败抛出）；`server-startup-failure-reason.test.ts` 加 `mcp_json` 阶段例（`host_overlay` 之后）；启动用例：零连接器启动后 `mcp.json` 恰为空表字节。同 PR 改写死 agent 目录精确清单 `["host-overlay.yml","models.yml"]` 的既有断言为三项（加 `mcp.json`）：`server/test/server-startup-layout.test.ts:84,201`、`server-startup-overlay.test.ts:129,208,240`、`server-startup-order.test.ts:144`（状态根清单不变：`mcp.json` 在 agent 目录里）。uid-isolation：`server/test/linux/uid-isolation.test.ts` 的托管布局用例加一项——omp uid 能读 `mcp.json`、覆写 `EACCES`、字节与 `0640` 不变；负对照：变异写出函数以 `0600` 写出时 `read=ok` 的断言失败（omp-uid-isolation「托管 mcp.json 对 omp uid 可读不可写」；CI `uid-isolation`）。
- [ ] 2a.3 新 `server/src/connectors/mcp-json.ts`（内容生成 + `createMcpPublisher`）；`server.ts` 启动阶段 `mcp_json`（`server.ts` 超过 780 行即把该阶段并进 `startup-registry.ts`，design「通用纪律」）。
- [ ] 2a.4 `docs/adr/0015-mcp-connector-credentials.md`（design D11：每个登录成员都能经 agent 读 `mcp.json` 拿到全部启用连接器的凭证、只登记所有成员都可持有的凭证；stdio server 继承 omp 的环境——含项目 `.env` 补进的 `NODE_OPTIONS`、`LD_PRELOAD`——与会话 cwd，与 ADR-0012 项目内工具残余同类；既有残余 `CLAUDE_CONFIG_DIR` 经项目 `.env` 引出 `~/.claude.json` 用户级 MCP，只报告；`OMP_CHILD_ENV_NAMES` 之外只在 `.env` 定义的名称为已接受残余）；`docs/architecture/system.md`「连接器」一节的 `mcp.json` 段（含回滚：回退代码时连同删除 `<state>/home/.omp/agent/mcp.json`，否则 omp 仍会读它）、启动阶段表加 `mcp_json`；ADR-0010 布局表 agent 目录行加 `mcp.json`。

Suggested fixture level: expanded - 新的托管配置文件与启动阶段（production config / file publish），omp 每次 spawn 按它拉起进程；文件对 omp uid 的读写边界由 uid-isolation 钉住。
Minimal mergeable slice: atomic - 写出器、发布器与启动阶段是同一份文件的生成与落地：只有写出器没有阶段则文件从不出现，只有阶段没有发布则登记后不生效；agent 目录清单断言与 uid-isolation 探针随文件出现同 PR 改，否则既有用例变红。

## 2b. 官方 omp 前提用例（connectors「托管 mcp.json」的「官方 omp 读取并按会话停用」）

- [ ] 2b.1 核对 Context：omp 源码 `discovery/builtin.ts` 与 `capability/mcp.ts` 的读取与停用规则、`session/session-tools.ts:909-924` 的 `xd://` 挂载条件、`sdk.ts:3050-3076` 的两个系统提示词段、`server/test/support/omp-official*.ts` 的 `get_state` 写法、`omp-official-project-config.test.ts` 的标记文件写法、`.github/scripts/ci-uid-isolation.sh` 的官方用例清单与 `scripts/test-ci-harness.sh` 的期望。
- [ ] 2b.2 测试先行：新 stdio MCP 夹具 `server/test/support/fake-mcp-server.mjs`（JSON-RPC over stdio：`initialize` 返回 argv 给出的哨兵 `instructions`、`tools/list` 返回 `echo`、`tools/call`；启动时写出 argv 给出路径的标记文件）与其自测；新官方 omp 用例 `server/test/omp-official-connectors.test.ts`（`WORKBUDDY_OMP_TEST=1`）：经 2a 的内容生成函数写出登记了 `echo` 与 `other`（同一夹具、各自的哨兵与标记文件）的 `mcp.json`，一次 spawn 的会话配置文件 `disabledExtensions` 为 `["mcp:other"]`；轮询 `get_state.systemPrompt`（≤30 s）直到 `## MCP Server Instructions` 段出现 `echo` 的哨兵（正对照），再断言 `other` 的哨兵不在、`other` 的标记文件不存在而 `echo` 的存在、`## MCP Tool Routes` 段含 `xd://mcp__echo_echo`。
- [ ] 2b.3 `.github/scripts/ci-uid-isolation.sh` 官方用例清单加 `test/omp-official-connectors.test.ts`、`scripts/test-ci-harness.sh` 期望同步。

Suggested fixture level: expanded - 三个 omp 前提（`--no-extensions` 下仍读用户级 `mcp.json`、`mcp:<名>` 停用、`xd://` 挂载的可观察面）由钉住的官方二进制钉住。
Minimal mergeable slice: atomic - 夹具、官方用例与 CI 清单是同一条验证路径：夹具没有官方用例就没有消费者，官方用例不进 CI 清单就不在 PR CI 里跑。

## 3. 连接器管理端点与审计（connectors「连接器管理端点」；http-service-skeleton 三条）

- [ ] 3.1 核对 Context：`http/errors.ts` 归属集与 `http-parser-owners.test.ts` 身份清单（`s1d-experts-skills` 组 5 合入后二十五条）、启动模块列表（十个）与 design Context「既有用例」列出的四处模块列表断言及 `spyRegistrationOrder`、`core/roles` 的 `isAdmin`、`s1d-model-registry` 的 `models/rest.ts` 写法与其 `DELETE` 带 body 的处理。
- [ ] 3.2 测试先行：新 `server/test/connectors-rest.test.ts`（整体挂载）：401 / 403 矩阵（未认证与普通用户 × 三个写路由 `POST` / `PUT` / `DELETE` × malformed / 缺 name / 未知 name）先于 body，以及 `GET` 按角色过滤（探活路由的 401 / 403 在组 4 的 4.2）；`name` 缺失 / 空 / 多值 400；404；键集严格与跨类型键 400、`null` 给不存在的键 400、第 33 个 400（connectors「键集、上限与保留值的拒绝」）；两种视图（普通用户只见启用行三键）；全文无 `env` / `headers` 哨兵；`PUT` 的 `null` 保留、整体替换的缺省（省略 `env` / `headers` 即空、省略 `enabled` 即 `true`）、「启用开关不丢凭证」、「探活状态随连接参数复位」；omp 会改写的取值经 REST 被拒且表与 `mcp.json` 字节不变（connectors「omp 会改写的取值被拒」）；「内容与启停」的 REST 流程（登记、停用、删除后的三份 `mcp.json` 字节）；REST 写入后 `mcp.json` 仍为 `0640`、属主不变、agent 目录无残留临时文件（omp-runtime「托管 mcp.json 的模式与属主」）；重名 409；三种审计 kind 与 detail；发布失败（agent 目录换成普通文件）→ generic 500 + `onPublishFailed` 恰一次 `{"event":"mcp_publish_failed"}` + 行与审计保留 + 恢复后再写入生效（connectors「发布失败」）；`DELETE` 带 malformed body 仍为既有的 generic 500（`DELETE` 不进归属集）；no-store；`POST /api/connectors`、`PUT /api/connectors` 的 content-parser 400；启动记录十一个模块、归属身份二十七条。
- [ ] 3.3 新 `server/src/connectors/rest.ts`（不含探活路由）；`app.ts` 注册模块 `connectors`（`onPublishFailed` 沿用模型注册表的注入口）；归属集加两条身份；`STARTUP_MODULES` 加 `connectors`；四处模块列表断言同步（`server-assembly.test.ts:156` 的注册次序与 `:457-468`、`server-startup-order.test.ts:44-52`、`server-startup-preview.test.ts:58-66`），并在 `server-assembly.test.ts:544-571` 的 `spyRegistrationOrder` 加 `registerConnectors` 的 spy。
- [ ] 3.4 `docs/architecture/system.md`「连接器」一节加端点、视图与审计 kind。

Suggested fixture level: expanded - 管理员写路径与凭证入库（Auth / credentials 触发项）。
Minimal mergeable slice: atomic - 四个方法（`GET` 与三个写）共用同一套 401 / 403 / 404 / 键集 / 审计 / 发布骨架与一个整体挂载用例文件；归属集与模块记录必须与路由同 PR。探活按宽度门禁拆到组 4。

## 4. 连接器探活（connectors「连接器探活」）

- [ ] 4.1 核对 Context：`s1d-model-registry` 的 `models/probe.ts` 与 `upstreamExcerpt` 净化、组 3 的 rest 模块。
- [ ] 4.2 测试先行：新 http MCP 夹具 `server/test/support/fake-mcp-http.mjs`（`initialize` 的 JSON 与 SSE 两种应答、可脚本化状态码与回显请求头）；新 `server/test/connectors-probe.test.ts`：「http 与 stdio」场景六例 + SSE 应答 `ok` + 超时（整体期限注入 1 s）+ 并发串行 + 在途删除 404（connectors「SSE 应答、超时与在途删除」）+ 摘要不含请求头哨兵 + `mcp.json` mtime 不变 + `connector.probe` 审计 + 探活路由的 401 / 403 矩阵（未认证与普通用户 × malformed / 缺 name / 未知 name，先于 name 查找；connectors「非管理员」的探活一腿）+ bodyless 带 `{}` 的 content-parser 400；归属身份二十八条。
- [ ] 4.3 新 `server/src/connectors/probe.ts`（摘要净化复用 #1650 的 `upstreamExcerpt`）；`rest.ts` 加 `POST /api/connectors/probe?name=`；归属集加一条身份（二十八条）；`docs/architecture/system.md`「连接器」节补探活路由、两种判定与 `connector.probe` 审计。

Suggested fixture level: expanded - 向外发带请求头凭证的请求（outbound with credentials）。
Minimal mergeable slice: atomic - 夹具没有探活就没有消费者，探活没有夹具无法按规格验证；两者共一条验证路径。

## 5. 账号缺省、会话能力与派发指纹（connectors「连接器账号缺省」；skill-switches「会话能力端点」「停用技能对 omp 生效」；session-metadata 两条；chat-sessions「派发前按会话设置对齐进程」；chat-web「输入框与能力栏」的能力应答三键）

- [ ] 5.1 核对 Context：`s1d-experts-skills` 的 `rest-capabilities.ts`、会话创建初值、fork 事务、spawn 能力接线与指纹（其组 5、组 6 合入后的代码）、`server/src/sessions/composer-align.ts` 的指纹函数与 `supervisor.ts` 的行数、`web/src/lib/api-session-capabilities.ts` 的 `hasExactlyKeys` 与 `web/test/support.ts` 的 capabilities 缺省应答（#1663 合入后）。
- [ ] 5.2 测试先行：`server/test/connectors-defaults.test.ts`（`GET` / `PUT /api/connectors/defaults` 键集、上限、名称规则、不要求已登记、content-parser 400）；会话能力用例扩展：`POST /api/sessions` 带 `disabledConnectors` 与账号缺省初值、能力端点的 `disabledConnectors`、fork 复制；spawn 用例：会话配置文件 `disabledExtensions` 同时含 `skill:` 与 `mcp:` 且排序去重；派发用例（假 omp 真子进程）：登记 / 修改 / 停用某连接器后下一条重启、`mcp.json` 不变则复用、chat-sessions「在途回合中修改连接器不打断」；同 PR 改专家技能组 6.2 的 `composer-align` 纯函数用例（指纹函数的签名多了 `mcp.json` 字节参数，既有用例补传空串并加一例「字节不同 → 不可复用」）。
- [ ] 5.3 账号缺省端点（`connectors/rest.ts`，归属集加一条，二十九条）；会话创建键、能力端点与 fork 加 `disabledConnectors`；spawn 能力合并 `mcp:<名>`；能力指纹并入当前 `mcp.json` 字节（读取与并入放进 `composer-align.ts`，`supervisor.ts` 只多传一个参数，保住 ≤800 行）。
- [ ] 5.4 web 的能力应答随服务端同 PR 改三键：测试先行——`web/test/api-session-capabilities.test.ts`（或该解析器的既有用例文件）证明三键应答 `{expertId, disabledSkills, disabledConnectors}` 被接受、旧的两键应答被拒（`hasExactlyKeys`）；`web/src/lib/api-session-capabilities.ts` 解析加 `disabledConnectors`（字符串数组）；`web/test/support.ts` 的 `/api/sessions/<id>/capabilities` 缺省应答改为 `{expertId: null, disabledSkills: [], disabledConnectors: []}`；专家技能组 9、10 用例里手写的能力应答（`web/test/chat-expert-picker.test.tsx`、`web/test/chat-capability-popover.test.tsx` 等，按 `capabilities` 检索）一并补 `disabledConnectors`。
- [ ] 5.5 `docs/architecture/system.md`「连接器」一节加账号缺省、会话停用与「连接器变化使存活会话下一条重启」。

Width exception: multi-path - 能力应答多一个键时，web 的严格解析器（`hasExactlyKeys`，专家技能组 9）在同一刻会把三键应答当无效响应：服务端与 `api-session-capabilities.ts` / `web/test/support.ts` 必须同 PR，否则两侧之间的任何一个提交都让会话页的能力读取失败。
Suggested fixture level: expanded - 改派发路径的重启判据与会话创建契约（Critical Path「omp 子进程治理」+ persisted state）。
Minimal mergeable slice: atomic - 账号缺省、会话列与 spawn 合并是同一个停用集合的写、存、用；指纹并入 `mcp.json` 与之同 PR，否则登记变化后存活进程永远读旧文件。

## 6. 中心「连接器」tab（connectors「中心「连接器」tab」；model-registry「中心页外壳」；验收 CC 节）

- [ ] 6.1 核对 Context：`features/center/tabs.ts` 与中心用例（`s1d-experts-skills` 组 8 合入后）、`s1d-model-registry` 的模型 tab 表单与自动探活写法、拷入层（`select`、`switch`）。
- [ ] 6.2 测试先行：新 `web/test/center-connectors*.test.tsx`（假 `ApiClient`）：普通用户视图（无命令 / 地址 / 管理按钮）与 `默认启用` 整表 `PUT`（含列表外名称、在途禁用、失败回滚）；管理员视图、`启用` 开关（切换恰一次 `PUT`，body 由管理员视图构造：stdio `gitlab` 的 body 恰为 `{description, command, args, env:{TOKEN:null}, enabled:false}`，connectors「启用开关与空态」）、编辑对话框的 body 同一构造（未填的凭证键为 `null`）、新增 stdio / http 表单（客户端校验名称规则与 `!` 开头 / 含 `${` 两类改写取值，第三类（值恰为 `OMP_CHILD_ENV_NAMES` 成员）由服务端 400、对话框就地显示其 message、只发碰过的键）、编辑时留空为 `null`、保存后自动探活规则、删除确认、探活在途禁用、Escape 回退、空态（标题 `尚未接入内网连接器`、说明 `公网 SaaS 连接器（文档/邮箱/IM）在内网部署下已移除。内网 GitLab 等系统部署完成后在此接入。`，管理员仍见 `新增连接器`、普通用户没有）；`api-connectors.ts` 两种视图严格解析与 `name` 编码；中心用例的 tab 条（普通用户 `专家`、`技能`、`连接器`）与 routeManifest 描述 `专家、技能与连接器`；`web/e2e/ui-walk-layout.ts` 的 `/center` 分支核对不受影响。
- [ ] 6.3 新 `web/src/lib/api-connectors.ts` + `api.ts` 导出；`web/src/features/center/connectors/{list.tsx,form-dialog.tsx,use-connectors.ts}`；`tabs.ts` 插入 `{connectors, 连接器, adminOnly:false}`；routeManifest 描述。
- [ ] 6.4 验收清单新增「中心·连接器（CC）」CC-01 管理员登记 stdio 连接器后新会话可用其工具、CC-02 登记 http 连接器并探活、CC-03 普通用户关闭默认启用后新会话不加载、CC-04 含 `!` / `${` 的取值被拒、CC-05 `只问命令` 下 MCP 调用不弹确认，`每次都问` 下弹 `Allow tool: write` 且带 `Path: xd://mcp__<连接器>_<工具>`（MCP 工具挂在 `xd://` 下经 `write` 调用，会话里的步骤名为 `write`、工具段摘要计为 `新建`）；结论 `待签`；`IMPLEMENTATION_PLAN.md` F-CTR-CON 行指向本 change；`web/test/functional-checklist.test.ts` 通过。
- [ ] 6.5 `docs/architecture/system.md`「连接器」一节加审批行为（design D12）：MCP 工具挂在 `xd://mcp__<server>_<tool>` 下、模型经 `write` 调用，`每次都问` 下确认卡为 `Allow tool: write` 带 `Path: xd://mcp__…`，`只问命令` 下不弹确认；步骤名为 `write`、摘要计为 `新建`（沿用 #1570 的 `xd://` 先例，不钉 `tools.xdev`）；需要确认的会话用 `每次都问`。

Suggested fixture level: expanded - 管理员录入连接器凭证的表单（credentials 触发项），尽管服务端契约已由组 3–5 钉住。
Minimal mergeable slice: atomic - 列表、两种视图、表单与 API 客户端是同一个 tab 的一条组件用例路径；追加 tab 项没有面板就是占位。

## 7. 「能力」弹层的连接器段（skill-switches「输入框「能力」弹层」；chat-web「输入框与能力栏」的读取时机；session-sidebar「欢迎页场景胶囊与场景化快捷任务」「会话 DTO 严格解析」）

- [ ] 7.1 核对 Context：`s1d-experts-skills` 组 10 合入后的 `capability-popover.tsx` 与 `use-session-capabilities.ts`、`welcome-options.ts`、`api.ts` 的 `ChatSessionCreateInput`、`web/test/support.ts` 的路由表（`:95`、`:132` 对未登记路径抛 `unexpected request`）。
- [ ] 7.2 测试先行：`web/test/chat-capability-popover.test.tsx` 加连接器段：只列启用的连接器、开关初值（欢迎态取账号缺省、会话中取能力）、切换恰一次 `PUT …/capabilities {disabledConnectors}`、失败回滚、欢迎态动过才在 `POST /api/sessions` 带 `disabledConnectors`、读取中与失败态；读取时机（欢迎态第一次打开弹层取一次 `listConnectors` 与 `getConnectorDefaults`，会话中第一次打开取一次 `listConnectors`；五种读取都不计入 `getComposerOptions` 的调用计数、不使其失效，只动连接器开关的首次发送之后不重取输入框选项——chat-web「能力读取时机」）；`createSession({…, disabledConnectors})` 的请求 body（session-sidebar「会话 DTO 严格解析」）。`web/test/support.ts` 加缺省应答 `GET /api/connectors` → `{connectors: []}` 与 `GET /api/connectors/defaults` → `{disabledConnectors: []}`，否则每个打开 `能力` 弹层的既有用例都会撞上 `unexpected request`；逐个复核专家技能组 9.2 与 10.2 列出的计数类用例（`chat-archive.test.tsx:472`、`chat-page-session-delete.test.tsx:160/531/592`、`chat-page-search.test.tsx:146/167`、`chat-list-events.test.tsx:288`、`chat-page-new-session-wiring.test.tsx:51`、`chat-attachments-first-send.test.tsx:115`、`chat-page-first-send-rejected.test.tsx:256`、`chat-page-slash-support.tsx:222`，以及 `chat-capability-popover.test.tsx` 的既有请求计数）。
- [ ] 7.3 `capability-popover.tsx` 加连接器段；`use-session-capabilities.ts` 与 `welcome-options.ts` 加 `disabledConnectors`；`api.ts` 的 `ChatSessionCreateInput` 加 `disabledConnectors?`（能力应答的解析已由组 5 改为三键，本组只用）。
- [ ] 7.4 验收清单新增 CH 行「会话中关掉一个连接器，下一条回答不再能用它的工具」；结论 `待签`；`web/test/functional-checklist.test.ts` 通过。

Suggested fixture level: compact - 弹层多一段开关与一个请求键，服务端契约与 omp 效果由组 2b、组 5 钉住。
Minimal mergeable slice: atomic - 开关、初值与请求键是同一个可见行为的一条组件用例路径。
