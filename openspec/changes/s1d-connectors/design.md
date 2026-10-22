# Design: s1d-connectors

## Context

事实基线（worktree 基于 origin/master `c3c6bb53`，2026-10-22 读码；omp 语义读冻结源码 `resource/oh-my-pi`（v18.0.10）与 `docs/`，并对钉住二进制 v18.12.3 做字符串核对；每组第一个任务仍核对行号）：

- **omp 读 MCP 配置**：native provider 依次读 `<cwd>/.omp/mcp.json`、`<cwd>/.omp/.mcp.json`（project 级）、`<agentDir>/mcp.json`、`<agentDir>/.mcp.json`（user 级）（`discovery/builtin.ts:205-210`）；`agentDir` = `PI_CODING_AGENT_DIR`（宿主设为 `<state>/home/.omp/agent`，`spawn-env.ts:21-35`）。同名先到者胜、不合并；`mcp.enableProjectConfig: false`（宿主 overlay 已钉，`host-overlay.ts:165-166`）在去重前丢掉全部 project 级条目（`mcp/config.ts:116-117`）。文件缺失跳过、不可解析或单个 server 配置非法只记错误，omp 不退出（`docs/mcp-config.md:527-529`、`docs/mcp-runtime-lifecycle.md:51-56`）。
- **schema**：`{mcpServers: {<name>: {type?: "stdio"|"http"|"sse", command, args, env, cwd, url, headers, enabled, timeout}}}`；stdio 必有 `command`，http / sse 必有 `url`，两者都给是错误（`mcp/config.ts:317-347`）。
- **omp 会改写的取值**：发现时对整个 `mcpServers` 做 `${VAR}` / `${VAR:-默认}` 插值（`discovery/builtin.ts:111`、`discovery/helpers.ts:447-453`）；连接时 stdio 的 `env` 值与 http 的 `headers` 值再经 `resolveConfigValue`：以 `!` 开头的值作为 shell 命令执行（omp uid、10 s、结果缓存），恰为某个环境变量名的值被替换为该变量的值（`config/resolve-config-value.ts:21-26`）。
- **`--no-extensions` 不挡 `mcp.json`**：它只设 `disableExtensionDiscovery`，native provider 照读（`main.ts:1367-1369`；主规格 omp-runtime :574-577 的真实 omp 场景即在 `--no-extensions` 下）。
- **单个 server 停用**：`disabledExtensions` 元素 `mcp:<server 名>` 精确匹配去掉该 server（`capability/mcp.ts:101`、`capability/index.ts:111-113`；二进制核对一致）。omp 自己的 UI 已改用 `mcp.json` 的 `disabledServers`、把 `mcp:<名>` 称为 legacy，运行时仍支持——升级时复核。
- **生命周期**：`rpc-ui` 下 MCP 发现推迟到会话建立之后在后台进行（`sdk.ts:1930,4182`），工具经 `refreshMCPTools` 到达；server 随 omp 进程存亡；缺省超时 30 s（`mcp/timeout.ts:3-17`）。stdio server 由 omp 以 `{...Bun.env, ...config.env}` 拉起，cwd 缺省为会话目录，以 omp uid 运行（`mcp/transports/stdio.ts:579-608`）——它继承 omp 的整个环境（含 `WORKBUDDY_MODEL_TOKEN`）。
- **工具名与审批**：工具名 `mcp__<server>_<tool>`，各段小写、`[a-z_]` 之外（含数字）一律变 `_` 并合并、总长 ≤64（`mcp/tool-bridge.ts:362-407`）；MCP 工具的审批类别是 `write`（`tool-bridge.ts:501,613`）——宿主缺省档 `write`（`只问命令`）下不弹确认，`always-ask`（`每次都问`）下弹 `Allow tool: <名>`。server 的 instructions 以 `## MCP Server Instructions` 追加进系统提示词（≤4000 字符，`sdk.ts:3034,3066-3076`）；MCP 工具不在 `get_state.dumpTools` 里（`tools/essential-tools.ts:43-45`、`session/session-tools.ts:909-924`），系统提示词的 `## MCP Tool Routes` 段列出 `- <工具名> → …`（`sdk.ts:3050-3064`）——可观察面是轮询 `get_state.systemPrompt`。
- **宿主现状**：没有任何 MCP 登记；托管 agent 目录 `2750`（`state-layout.ts:59,73-74`），`models.yml` 经 `replaceFile` 0640 写出（`models-yml.ts:14-31`）；omp-runtime 布局表（:357-371）没有 `mcp.json`；ADR-0010 :98 同。CONTEXT.md:53 不变量 #4「kb-service 凭证与模型网关密钥不得出现在 omp 子进程可读环境」，:33「连接器 = MCP 连接器，仅显式配置不自动发现」。
- **测试夹具**：假 omp 不读 `mcp.json`、没有 MCP；仓库没有 MCP server 夹具；官方用例经 `world.runtime.command({type:"get_state"})` 读 `systemPrompt`（`omp-official-project-config.test.ts:302-307`）。
- **兄弟 change**：`s1d-experts-skills` 提供会话配置文件（`<state>/session-config/<key>.yml`，一行 `disabledExtensions: [<JSON 字符串>…]`，`2710` / `0640`，退出即删）、会话能力端点、能力指纹、中心 `专家` / `技能` tab 与「能力」弹层；启动模块十个、归属身份二十五条（其 http-service-skeleton delta）。`s1d-model-registry` 提供 `forbidden`、管理端点与单飞发布的写法、`validateUpstream` 的地址规则。
- **demo**：`connectors:[]` 与注释「内网连接器（GitLab 等）待部署后接入」（:1611-1612）；空态 `尚未接入内网连接器` 与说明（:3218-3225）；非空布局 `已连接` / `连接` / `断开`（:3208-3235，SaaS OAuth 语义，本 change 不用）。
- **行数**：`app.ts` 491（两个兄弟 change 之后约 560）、`server.ts` 743（`s1d-model-registry` 之后 ≤780）、`host-overlay.ts` 241、`state-layout.ts` 122。

## Goals / Non-Goals

**Goals:**

- 管理员在 `/center?tab=connectors` 登记 stdio / http MCP 连接器、改、删、启停、探活；登记即生效于之后的每次 spawn（存活会话在下一条消息前重启）。
- 普通用户在同一 tab 改自己的账号缺省，在输入框「能力」弹层改当前会话；omp 真的不拉起被停用的连接器（官方用例观察到）。
- 写进 `mcp.json` 的每个值都按字面被 omp 使用：没有命令执行、插值或环境变量替换的口子。

**Non-Goals:**

- `sse` 类型、OAuth / `auth` 字段、`cwd` 与 `timeout` 的登记（缺省即可）。
- 按账号登记的私有连接器（需要改 ADR-0010 的共享 HOME 布局；grill 已定管理员全局登记）。
- 专家声明连接器。
- 连接器工具单独的审批策略（沿用 omp 对 MCP 工具的 `write` 类别与会话档位）。
- 拉起 stdio server 做握手探活（grill：stdio 只校验命令存在）。
- 把连接器状态（连上 / 失败）实时推给前端（omp 不把 MCP 连接状态送到 RPC）。

## Decisions

### owner 的裁定（2026-10-21，grill，已定，不是选项）

| 分支 | 结论 | 由谁定 |
|---|---|---|
| 谁登记 | 管理员全局登记（不改共享 HOME 布局） | owner |
| 类型 | stdio + http | owner |
| 事实源与写出 | DB 为事实源，生成 `mcp.json`（0640） | owner |
| 凭证 | 只进 `env` / `headers`，不进 `args` | owner |
| 探活 | http 握手探活；stdio 只校验命令存在 | owner D3 |
| 会话启停 | 会话 overlay 的 `disabledExtensions: [mcp:<名称>]` | owner |
| 中心与会话入口 | 中心 tab 改账号缺省；「能力」弹层改会话 | owner R5 |
| 权限 | 连接器登记仅管理员 | owner Q8 |

### 起草者的技术决定

- **D1 迁移 048**（`server/src/core/db/migrations/048_connectors.sql`）：`connectors(name TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('stdio','http')), description TEXT NOT NULL, command TEXT NULL, args TEXT NULL, env TEXT NULL, url TEXT NULL, headers TEXT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')), probe_at INTEGER NULL, probe_message TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((type = 'stdio' AND command IS NOT NULL AND url IS NULL AND headers IS NULL) OR (type = 'http' AND url IS NOT NULL AND command IS NULL AND args IS NULL AND env IS NULL)))`；`args` 为 JSON 字符串数组、`env` / `headers` 为 JSON 对象文本；≤32 行。`account_connector_prefs(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, disabled_connectors TEXT NOT NULL, updated_at INTEGER NOT NULL)`；`ALTER TABLE chat_sessions ADD COLUMN disabled_connectors TEXT NOT NULL DEFAULT '[]'`。
- **D2 名称**：`^[a-z](?:[a-z_]{0,30}[a-z])?$`，创建后不可改（删了再建）。理由：omp 把工具名规整为 `mcp__<名>_<工具>` 且 `[a-z_]` 之外变 `_`，允许数字或大写会让两个连接器的工具同名；`mcp:<名>` 精确匹配也要求名称就是 omp 看到的 server 名。
- **D3 取值规则**（`server/src/connectors/validate.ts`）：
  - stdio：`command` 为绝对路径（`/` 开头、≤1024 字节、无控制字符）；`args` ≤32 项、每项 ≤1024 码点；`env` ≤32 键，键 `^[A-Z_][A-Z0-9_]{0,63}$`，值 1..4096 码点。
  - http：`url` 整体匹配 `^https?://[^\s#@]+$`（与 `s1d-model-registry` 的上游地址同一规则，共用 `validateUpstream` 的地址部分）；`headers` ≤32 个，名为 RFC 7230 token，值经 `http.validateHeaderValue`。
  - 所有写进 `mcp.json` 的字符串（`command`、`args`、`env` 值、`url`、`headers` 值）：不得以 `!` 开头、不得含 `${`；`env` / `headers` 的值不得恰为 omp 环境白名单里的变量名（`spawn-env.ts` 的那份清单，导出复用）。违反 400，message 只点名字段。
  - `description` 0..200 码点。
- **D4 托管 `mcp.json`**（`server/src/connectors/mcp-json.ts`）：内容 = `{"mcpServers": {<名>: {type, command, args, env} | {type, url, headers}}}`，只含 `enabled = 1` 的行，按名称排序，`JSON.stringify(…, null, 2)` 加换行；没有启用的连接器时写 `{"mcpServers":{}}` 加换行（覆盖残留）。经 `replaceFile(agentDir, "mcp.json", …)` 0640。发布器：`createMcpPublisher({agentDir: () => string | null, store})` 单飞（与 `s1d-model-registry` D7 同一写法），`agentDir()` 在启动阶段 `mcp_json` 之前为 null（只改 DB、不写文件）。启动阶段 `mcp_json` 紧接 `host_overlay`，失败 `reason: "mcp_json"`。每个写端点 = 校验 → 事务（写表 + 审计）→ 发布 → 应答；发布失败 generic 500 + `onPublishFailed` 记录 `{"event":"mcp_publish_failed"}`，行与审计保留（与模型注册表同一规则）。
- **D5 端点**（`server/src/connectors/rest.ts`，模块 `connectors`）：
  - `GET /api/connectors` → 200 `{connectors: ConnectorView[]}`，按名称排序。管理员视图 `{name, type, description, enabled, command, args, envKeys, url, headerKeys, probe: {status, at, message}, updatedAt}`（stdio 的 `url` / `headerKeys` 为 null，http 的 `command` / `args` / `envKeys` 为 null）；普通用户只见 `enabled` 的行且视图为 `{name, type, description}`。永不回传 `env` / `headers` 的值。
  - `POST /api/connectors` body `{name, type, description?, command?, args?, env?, url?, headers?, enabled?}`（键集严格、按类型禁止对方的键）→ 201；重名 409 `conflict`；第 33 个 400。
  - `PUT /api/connectors?name=` body 同 POST 去掉 `name` 与 `type`（整体替换；`env` / `headers` 的值为 `null` = 保留该键既有的值，键不存在则 400）→ 200。
  - `DELETE /api/connectors?name=` → 204（停用列表里的同名项留着无害）。
  - `POST /api/connectors/probe?name=`（无 body）→ 200 管理员视图（D6）。
  - 次序：401 → 非管理员的写与探活 403 `forbidden`（先于 body 与 name）→ `name` 缺失 / 空 / 多值 400 → 未知 404 → body 400；no-store；`POST /api/connectors`、`PUT /api/connectors` 进归属集（body limit 64 KiB）。
  - 审计 `connector.create` / `.update` / `.delete` / `.probe`，detail `{name, type, status?}`。
- **D6 探活**（`server/src/connectors/probe.ts`）：http → `POST <url>`，请求头为登记的 `headers` 加 `content-type: application/json`、`accept: application/json, text/event-stream`，body 为 JSON-RPC `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"workbuddy-probe","version":"1"}}}`；建连 10 s / 整体 15 s，不跟随重定向；2xx 且响应体（JSON，或 `text/event-stream` 的第一个 `data:` 事件）是带 `result` 的 JSON-RPC 对象 → `ok`；其它 → `failed`，message 规则同模型探活（`HTTP <status>：<净化摘要>` ≤200 码点、`无法连接`、`超时`、`响应不是 MCP 初始化结果`），摘要净化覆盖该连接器全部 `headers` 值。stdio → `fs.stat` 为常规文件且对 app 进程可执行（`access X_OK`）→ `ok`，否则 `failed`、`命令不存在或不可执行`；不拉起进程。探活不发布、不改 `enabled`。
- **D7 账号缺省与会话**：`GET /api/connectors/defaults` → `{disabledConnectors: string[]}`、`PUT` 整体替换（≤32、名称规则同 D2、不要求已登记，body limit 16 KiB）。`POST /api/sessions` 加 `disabledConnectors`（同规则，初值 body ?? 账号缺省 ?? `[]`）；会话能力端点的 body / 应答加 `disabledConnectors`（`PUT` 的非空子集规则不变）；fork 复制该列。spawn 时会话配置文件的 `disabledExtensions` = 停用技能 `skill:<名>` ∪ 停用连接器 `mcp:<名>`（`s1d-experts-skills` D1 的写出器原样复用，排序去重）。
- **D8 派发对齐**：能力指纹 = `s1d-experts-skills` 定义的会话配置文件指纹再并上托管 `mcp.json` 的字节（读当前文件；缺失按空串）。连接器的任何登记变化 → 存活会话下一次派发重启；什么都没变 → 复用。
- **D9 中心「连接器」tab**（`CENTER_TABS` 插在 `skills` 之后、`models` 之前，`adminOnly: false`；routeManifest 描述按「中心页外壳」规则为 `专家、技能与连接器`（该规则随本 change 改为「顿号连接、末项前用 `与`」））：列表（名称、类型 `stdio` / `http`、描述，管理员另见命令或地址、探活状态、`启用` 开关）；每行 `默认启用` 开关（账号缺省，`PUT /api/connectors/defaults` 整表，含列表外名称）；管理员另有 `新增连接器` / `编辑`（对话框：名称（编辑只读）、类型 select、描述、stdio 的命令 / 参数（每行一个）/ 环境变量（键值对，编辑时值 placeholder `留空保留现有值`）、http 的地址 / 请求头（同上））/ `删除`（确认）/ `探活`；保存成功且非 stdio 的地址或请求头有改动时自动探活一次（同模型 tab）。空态 `尚未接入内网连接器` 与 demo 说明。
- **D10 「能力」弹层**：技能段之后加 `连接器` 段，列出 `GET /api/connectors` 的（启用的）连接器各一个开关；欢迎态初值取账号缺省、会话中取能力，切换恰一次 `PUT …/capabilities {disabledConnectors}`；读取时机与失败态同技能段。
- **D11 ADR-0015「MCP 连接器凭证对 omp uid 可读」**：连接器的 `env` / `headers` 必须交给 omp（它拉起 server、发请求），所以与模型网关密钥（ADR-0008：omp 环境零凭证）不同，它们存在 0640 的托管 `mcp.json` 里、omp uid 可读，stdio server 还继承 omp 的环境；登记仅管理员、值不回传、审计不含值。CONTEXT.md 不变量 #4 只管模型网关与 kb-service 凭证，不涵盖连接器——ADR 写明这条边界。
- **D12 文档**：`system.md` 加「连接器」一节（端点、`mcp.json`、审批类别 `write` 意味着 `只问命令` 下 MCP 调用不弹确认）；omp-runtime 与 ADR-0010 布局表加 `mcp.json`；验收清单「中心·连接器（CC）」。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 连接器的 `env` / `headers` 值不进响应、审计、日志、stderr、错误 message；夹具里的值用哨兵。
- 产品代码单文件 ≤800 行；`server.ts` 超过 780 行时把 `mcp_json` 阶段并进 `s1d-model-registry` 抽出的 `startup-registry.ts`（或同样抽出）。
- 不新增 `.css`；规格 delta 只改列出的 requirement；以兄弟 change 的 delta 为底的块在其 MODIFIED 文本上再改。

## Risks / Trade-offs

- **[连接器凭证对 omp uid 可读]** → ADR-0015；登记仅管理员。
- **[stdio server 继承 omp 环境]**（含本 generation 的模型代理令牌）→ server 由管理员登记的可执行文件提供、与 omp 同一信任域；写进 ADR-0015。
- **[`只问命令` 下 MCP 调用不弹确认]** omp 把 MCP 工具归为 `write` → system.md 与验收行写明；需要确认的会话用 `每次都问`。
- **[连接器任一变化重启全部存活会话的下一条]** 与模型注册表的「新模型先重启」同代价；登记操作稀少。
- **[`mcp:<名>` 被 omp 称为 legacy]** 18.12.3 仍支持 → 官方用例钉住，升级时复核。
- **[项目层 `.env` 定义的变量名与某个值相同]** `resolveConfigValue` 会替换 → 只拦白名单里的变量名；项目 `.env` 由会话属主控制、只影响其本人会话，接受。
- **[MCP 发现是后台的]** 官方用例轮询 `get_state.systemPrompt`，不在 `ready` 后立即断言。

## Migration Plan

1. 组 1（迁移 048 与 store）在 `s1d-experts-skills` 的迁移 047 之后合。
2. 组 2（`mcp.json` 写出与发布、启动阶段、官方前提用例）。
3. 组 3（管理端点与审计）、组 4（探活）、组 5（账号缺省、会话能力与派发指纹）。
4. 组 6（中心 tab）、组 7（「能力」弹层）。回滚 = 回退代码；`mcp.json` 留着时 omp 仍会读它——回滚时连同删除该文件（写进 system.md）。

## Not yet specified

- 连接器级的账号可见性（某些连接器只给某些部门）。
- 连接器 `timeout` / `cwd` 的登记。
- 把 MCP server 的连接失败展示给用户（omp 不经 RPC 报告）。

## Open Questions

无（grill 已定方向；D2 名称规则、D3 取值规则、D8 指纹并入 `mcp.json`、D11 ADR 是起草者按事实细化，登记在 Epic 待 owner 知悉）。

## Sketch seams under test

- 组 1：迁移 048 约束（类型形状 CHECK、级联、列缺省）；store 校验（名称、D3 每条拒绝规则、上限）——`:memory:` + 真实迁移。
- 组 2：`mcp.json` 字节（排序、只含启用行、空表、JSON 转义）；发布器单飞、`agentDir()` 为 null 时不写；启动阶段 `mcp_json` 的位置与失败 `reason`；官方 omp 用例（`WORKBUDDY_OMP_TEST=1`）：stdio 夹具 `fake-mcp-server.mjs` 登记进 `mcp.json`，`--no-extensions` 下轮询 `get_state.systemPrompt` 出现 `mcp__<名>_echo` 的路由；会话配置文件含 `mcp:<名>` 时不出现；值 `${PATH}` 被 D3 拒绝的反证（store 层）。
- 组 3：整体挂载（401 / 403 / 400 / 404 次序、两种视图、值不回传、`null` 保留、审计 detail 无值、发布失败 500 + 记录、归属身份与模块数）。
- 组 4：http 夹具 `initialize` 的 ok / 非 2xx / 非 MCP 响应 / SSE 响应 / 超时 / 无法连接；stdio 的存在 / 不可执行 / 不存在；摘要净化。
- 组 5：账号缺省端点；会话创建与能力端点的 `disabledConnectors`；spawn 的会话配置文件同时含 `skill:` 与 `mcp:`；派发指纹（改连接器 → 下一条重启；不改 → 复用）；fork 复制。
- 组 6：`center-connectors*.test.tsx`（假 `ApiClient`；两种视图、管理员表单、`null` 保留、默认启用开关整表、自动探活、空态）；中心用例的 tab 条与描述。
- 组 7：「能力」弹层连接器段（开关、`PUT`、欢迎态初值与带入 `POST /api/sessions`）。

## 行数预算

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/server.ts` | 743（+兄弟） | ≤790 | 阶段 `mcp_json`；超过即并进 `startup-registry.ts` |
| `server/src/app.ts` | 491（+兄弟 ~560） | ~585 | 注册 `connectors` |
| `server/src/connectors/*.ts` | 新 | 各 ≤400 | validate / store / mcp-json / probe / rest |
| `web/src/features/center/connectors/*` | 新 | 各 ≤400 | |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` F-CTR-CON（:117）、S1d（:247-255）；PLAN §3.3「连接器」；CONTEXT.md「连接器」。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0008（对照）、0010（布局）、0012（overlay 与 MCP）、新 0015。
- 兄弟 change：`s1d-model-registry`（Epic #1640）、`s1d-experts-skills`。
