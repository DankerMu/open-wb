# Design: s1d-connectors

## Context

事实基线（worktree 基于 origin/master `c3c6bb53`，2026-10-22 读码；omp 语义读冻结源码 `resource/oh-my-pi`（v18.0.10）与 `docs/`，并对钉住二进制 v18.12.3 做字符串核对；每组第一个任务仍核对行号）：

- **omp 读 MCP 配置**：native provider 依次读 `<cwd>/.omp/mcp.json`、`<cwd>/.omp/.mcp.json`（project 级）、`<agentDir>/mcp.json`、`<agentDir>/.mcp.json`（user 级）（`discovery/builtin.ts:205-210`）；`agentDir` = `PI_CODING_AGENT_DIR`（宿主设为 `<state>/home/.omp/agent`，`spawn-env.ts:21-35`）。同名先到者胜、不合并，另按等价连接（同一 `command` / `args` / `env` / `cwd` 或同一 `url` / `headers`）去重（`capability/mcp.ts:73-93`）；`mcp.enableProjectConfig: false`（宿主 overlay 已钉，`host-overlay.ts:165-166`）在去重前丢掉全部 project 级条目（`mcp/config.ts:116-117`）。文件缺失跳过、不可解析或单个 server 配置非法只记错误，omp 不退出（`docs/mcp-config.md:527-529`、`docs/mcp-runtime-lifecycle.md:51-56`）。
- **schema**：`{mcpServers: {<name>: {type?: "stdio"|"http"|"sse", command, args, env, cwd, url, headers, enabled, timeout}}}`；stdio 必有 `command`，http / sse 必有 `url`，两者都给是错误（`mcp/config.ts:317-347`）。
- **omp 会改写的取值**：发现时对整个 `mcpServers` 做 `${VAR}` / `${VAR:-默认}` 插值（`discovery/builtin.ts:111`、`discovery/helpers.ts:447-453`）；连接时 stdio 的 `env` 值与 http 的 `headers` 值再经 `resolveConfigValue`：以 `!` 开头的值作为 shell 命令执行（omp uid、10 s、结果缓存），恰为某个环境变量名的值被替换为该变量的值（`config/resolve-config-value.ts:21-26`）。
- **`--no-extensions` 不挡 `mcp.json`**：它只设 `disableExtensionDiscovery`，native provider 照读（`main.ts:1367-1369`；主规格 omp-runtime :574-577 的真实 omp 场景即在 `--no-extensions` 下）。
- **单个 server 停用**：`disabledExtensions` 元素 `mcp:<server 名>` 精确匹配去掉该 server（`capability/mcp.ts:101`、`capability/index.ts:111-113`；二进制核对一致）。omp 自己的 UI 已改用 `mcp.json` 的 `disabledServers`、把 `mcp:<名>` 称为 legacy，运行时仍支持——升级时复核。
- **生命周期**：`rpc-ui` 下 MCP 发现推迟到会话建立之后在后台进行（`sdk.ts:1930,4182`），工具经 `refreshMCPTools` 到达；server 随 omp 进程存亡；缺省超时 30 s（`mcp/timeout.ts:3-17`）。stdio server 由 omp 以 `{...Bun.env, ...config.env}` 拉起，cwd 缺省为会话目录，以 omp uid 运行（`mcp/transports/stdio.ts:579-608`）——它继承 omp 的整个环境（含 `WORKBUDDY_MODEL_TOKEN`，以及 omp 启动时从项目 `.env` 补进来的变量，如 `NODE_OPTIONS`、`LD_PRELOAD`：`utils/src/env.ts:240-247`）与会话 cwd。
- **工具名、挂载与审批**：工具名 `mcp__<server>_<tool>`，各段小写、`[a-z_]` 之外（含数字）一律变 `_` 并合并、总长 ≤64（`mcp/tool-bridge.ts:362-407`）。MCP 工具是 discoverable 的；`tools.xdev` 缺省为 true（`config/settings-schema.ts:4670`），宿主 overlay 不钉它——工具集含 `read` 与 `write`、没有 code mode 时，MCP 工具不进直接工具面，而挂在 `xd://mcp__<server>_<tool>` 下（`session/session-tools.ts:909-924`）。模型以 `write`、`path: "xd://mcp__…"`、JSON 参数作 `content` 调用它。所以审批与观察面都是 `write` 的：`每次都问` 下确认卡为 `Allow tool: write` 带 `Path: xd://mcp__…`（`tools/approval.ts:268`、`tools/write.ts:566`）；`只问命令` 下没有确认卡；会话里的步骤名为 `write`，工具段摘要按 chat-web「工具段摘要与折叠」的既有表计为 `新建`（主规格 chat-web:811）。这与 #1570 起「写 `xd://browser` 就是一次 write」的既有先例一致（主规格 chat-stream:103-104）。系统提示词的 `## MCP Tool Routes` 段逐行列出「`- "<MCP 工具名>" →` 加反引号包住的 `xd://mcp__<server>_<tool>`」（`sdk.ts:3050-3064`、`prompts/system/mcp-xdev-guidance.md`）；server 的 instructions 以 `## MCP Server Instructions` 下的 `### <server>` 追加（≤4000 字符，`sdk.ts:3066-3076`）；MCP 工具不在 `get_state.dumpTools` 里（`tools/essential-tools.ts:43-45`）。可观察面是轮询 `get_state.systemPrompt`。
- **omp 子进程的环境变量名**（D3 的拒绝集合）：`resolveConfigValue` 以 `$envExact(<值>)` 查 omp 进程环境，命中即替换（`config/resolve-config-value.ts:21-26`）。omp 进程环境里的名称来自：`ompSpawnEnv` 设的键（`server/src/sessions/omp/spawn-env.ts:21-73`：`PATH`、`HOME`、三个 `XDG_*_HOME`、`PI_CODING_AGENT_DIR`、`PI_CONFIG_FILES`、`PI_CONFIG_DIR`、`OMP_PROFILE`、`PI_PROFILE`、`WORKBUDDY_MODEL_TOKEN`、`PI_BROWSER_RELAY`、`PI_BROWSER_CMUX`、`PUPPETEER_PROXY`、`PUPPETEER_PROXY_IGNORE_CERT_ERRORS`、`OTEL_SDK_DISABLED`、`no_proxy`、`NO_PROXY`，有时另有 `LANG`、`TMPDIR`、`PUPPETEER_EXECUTABLE_PATH`）；`OMP_USER` 模式下 sudo 保留的 `SUDO_PRESERVE_ENV`（`spawn-env.ts:13-14`，与上一组同名）与 sudo 自身注入的 `USER`、`LOGNAME`、`SHELL`、`MAIL`、`TERM`、`SUDO_USER`、`SUDO_UID`、`SUDO_GID`、`SUDO_COMMAND`、`SUDO_HOME`、`SUDO_TTY`（`argv.ts:50-77` 的 `ompCommand`：`sudo -n -u <ompUser> --preserve-env=… [TMPDIR=<tmpdir>] -- setpriv …`；后两个视 sudo 版本与有无终端而定）；omp 自设的 `PI_NO_PTY`（`main.ts:1521`）、`PI_NO_TITLE`（`main.ts:1529`，宿主每次传 `--no-title`）、`PI_NOTIFICATIONS`（`modes/rpc/rpc-mode.ts:710`）、`__PI_NATIVE_VARIANT_CACHE`（`natives/native/loader-state.js:261,418`，x64 的 CPU 检测）、有 Exa 配置时的 `EXA_API_KEY`（`sdk.ts:361`），以及 omp 给自己子进程设的 `BUN_BE_BUN`（`subprocess/worker-runtime.ts:213`、`utils/src/ptree.ts:619`，不在 omp 自身环境里，列入集合无害）；`OMP_USER` 模式下 PAM 从主机配置补进来的名称（如 `/etc/environment` 的变量，随主机而定，omp-uid-isolation 已规定不以闭集断言）；以及 omp 启动时从项目 / agent / profile / home 的 `.env` 补进来的变量（`utils/src/env.ts:240-247`）。前三类宿主知道并钉成常量；PAM / 主机补进来的名称是开放集合、由部署者控制；`.env` 一类由会话属主控制。
- **宿主现状**：没有任何 MCP 登记；托管 agent 目录 `2750`（`state-layout.ts:59,73-74`），`models.yml` 经 `replaceFile` 0640 写出（`server/src/model-proxy/models-yml.ts:14-31`）；omp-runtime 布局表（:357-371）没有 `mcp.json`；ADR-0010 :98 同。CONTEXT.md:53 不变量 #4「kb-service 凭证与模型网关密钥不得出现在 omp 子进程可读环境」，:33「连接器 = MCP 连接器，仅显式配置不自动发现」。
- **测试夹具**：假 omp 不读 `mcp.json`、没有 MCP；仓库没有 MCP server 夹具；官方用例经 `world.runtime.command({type:"get_state"})` 读 `systemPrompt`（`omp-official-project-config.test.ts:302-307`）。
- **兄弟 change**：`s1d-experts-skills` 提供会话配置文件（`<state>/session-config/<key>.yml`，一行 `disabledExtensions: [<JSON 字符串>…]`，`2710` / `0640`，退出即删）、会话能力端点、能力指纹、中心 `专家` / `技能` tab 与「能力」弹层；启动模块十个、归属身份二十五条（其 http-service-skeleton delta）。`s1d-model-registry` 提供 `forbidden`、管理端点与单飞发布的写法；上游地址规则是 `server/src/agent-config.ts:254` 的模块私有 `UPSTREAM_BASE_URL`，导出的只有地址与密钥合判的 `validateUpstream` 与只判密钥的 `validateUpstreamKey`（组 1 在同文件补导出只判地址的 `validateUpstreamBaseUrl`，`validateUpstream` 改为调用它、行为不变）。
- **demo**：`connectors:[]` 与注释「内网连接器（GitLab 等）待部署后接入」（:1611-1612）；空态 `尚未接入内网连接器` 与说明（:3218-3225）；非空布局 `已连接` / `连接` / `断开`（:3208-3235，SaaS OAuth 语义，本 change 不用）。
- **行数**：`app.ts` 491（两个兄弟 change 之后约 560）、`server.ts` 743（`s1d-model-registry` 之后 ≤780）、`server/src/sessions/supervisor.ts` 785（#1648 与专家技能组 6 还要加）、`server/src/sessions/composer-align.ts` 61、`host-overlay.ts` 241、`state-layout.ts` 122。
- **既有用例**：agent 目录精确清单 `["host-overlay.yml","models.yml"]` 写死于 `server/test/server-startup-layout.test.ts:84,201`、`server-startup-overlay.test.ts:129,208,240`、`server-startup-order.test.ts:144`（`mcp.json` 不在状态根，状态根清单不变）；启动模块列表写死于 `server-assembly.test.ts:156`（注册次序）与 `:457-468`、`server-startup-order.test.ts:44-52`、`server-startup-preview.test.ts:58-66`，注册次序的 spy 在 `server-assembly.test.ts:544-571` 的 `spyRegistrationOrder`；web 的 `web/test/support.ts:95,132` 对未登记路径抛 `unexpected request`。

## Goals / Non-Goals

**Goals:**

- 管理员在 `/center?tab=connectors` 登记 stdio / http MCP 连接器、改、删、启停、探活；登记即生效于之后的每次 spawn（存活会话在下一条消息前重启）。
- 普通用户在同一 tab 改自己的账号缺省，在输入框「能力」弹层改当前会话；omp 真的不拉起被停用的连接器（官方用例观察到）。
- 写进 `mcp.json` 的每个值都按字面被 omp 使用：没有命令执行、插值或环境变量替换的口子。

**Non-Goals:**

- `sse` 类型、OAuth / `auth` 字段、`cwd` 与 `timeout` 的登记（缺省即可）。
- 按账号登记的私有连接器（需要改 ADR-0010 的共享 HOME 布局；grill 已定管理员全局登记）。
- 专家声明连接器。
- 连接器工具单独的审批策略（沿用 omp 把 MCP 工具挂在 `xd://` 下经 `write` 调用的审批与会话档位）。
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

- **D1 迁移 048**（`server/src/core/db/migrations/048_connectors.sql`）：`connectors(name TEXT NOT NULL PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('stdio','http')), description TEXT NOT NULL, command TEXT NULL, args TEXT NULL, env TEXT NULL, url TEXT NULL, headers TEXT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')), probe_at INTEGER NULL, probe_message TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, CHECK ((type = 'stdio' AND command IS NOT NULL AND url IS NULL AND headers IS NULL) OR (type = 'http' AND url IS NOT NULL AND command IS NULL AND args IS NULL AND env IS NULL)))`；`args` 为 JSON 字符串数组、`env` / `headers` 为 JSON 对象文本；≤32 行。`account_connector_prefs(account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, disabled_connectors TEXT NOT NULL, updated_at INTEGER NOT NULL)`；`ALTER TABLE chat_sessions ADD COLUMN disabled_connectors TEXT NOT NULL DEFAULT '[]'`。
- **D2 名称**：`^[a-z]{1,32}$`（只有小写字母），创建后不可改（删了再建）。理由：omp 把 `[a-z_]` 之外的字符规整为 `_`、再以 `_` 连接成 `mcp__<server>_<tool>`。允许数字或大写，`Git` 与 `git` 同名、`git2lab` 规整成 `git_lab`；允许 `_`，`git_lab` 的工具 `x` 与 `git` 的工具 `lab_x` 都成 `mcp__git_lab_x`。只剩小写字母时，server 段里没有 `_`，第一个 `_` 就是分隔符，两个连接器的工具不会同名。`mcp:<名>` 精确匹配也要求名称就是 omp 看到的 server 名。同一规则用于账号缺省、会话能力与会话创建里的 `disabledConnectors` 各项。
- **D3 取值规则**（`server/src/connectors/validate.ts`）：
  - stdio：`command` 为绝对路径（`/` 开头、≤1024 字节、无控制字符）；`args` ≤32 项、每项 ≤1024 码点；`env` ≤32 键，键 `^[A-Z_][A-Z0-9_]{0,63}$`，值 1..4096 码点。
  - http：`url` 整体匹配 `^https?://[^\s#@]+$`（与 `s1d-model-registry` 的上游地址同一规则：`agent-config.ts` 新导出的 `validateUpstreamBaseUrl`，`validateUpstream` 的地址部分改为调用它）；`headers` ≤32 个，名为 RFC 7230 token，值经 `http.validateHeaderValue`。
  - 所有写进 `mcp.json` 的字符串（`command`、`args`、`env` 值、`url`、`headers` 值）：不得以 `!` 开头、不得含 `${`；`env` / `headers` 的值不得恰为 `OMP_CHILD_ENV_NAMES` 里的任一名称。违反 400 `bad_request`，message 为该码的固定文案 `请求格式不正确`（`HttpError` 只收 code，与兄弟 store 同一写法），不回显取值。
  - `OMP_CHILD_ENV_NAMES`：`server/src/sessions/omp/spawn-env.ts` 在 `ompSpawnEnv` 旁导出的常量，为 Context「omp 子进程的环境变量名」前三类的并集——`ompSpawnEnv` 在任何选项下可能设置的每个键（含 `WORKBUDDY_MODEL_TOKEN`、`HOME` 与全部 `PI_*`）、`SUDO_PRESERVE_ENV` 的每个名称、sudo 注入的十一个名称、omp 自设的 `PI_NO_PTY`、`PI_NO_TITLE`、`PI_NOTIFICATIONS`、`__PI_NATIVE_VARIANT_CACHE`、`EXA_API_KEY` 与 `BUN_BE_BUN`。单元测试断言 `ompSpawnEnv(...)` 在带与不带 `browserBin` / `LANG` / `TMPDIR` 两种输入下输出的每个键都在集合里，以后给 `ompSpawnEnv` 加键而忘了这里会失败。
  - 残余：只在项目 `.env`（或 agent / home `.env`）里定义的名称不在集合里。值恰为这样的名称时 omp 会替换成该变量的值；要利用它，攻击者得知道管理员登记的字面值，而 `.env` 由会话属主控制、只影响其本人会话。PAM / 主机配置补进来的名称（开放集合）同样不在集合里：替换出来的是部署者自己的主机配置，且只有管理员能登记取值。两者都列为已接受残余（见 Risks）。
  - `description` 0..200 码点。
- **D4 托管 `mcp.json`**（`server/src/connectors/mcp-json.ts`）：内容 = `JSON.stringify({mcpServers: {<名>: {type, command, args, env} | {type, url, headers}}}, null, 2) + "\n"`，只含 `enabled = 1` 的行，按名称排序；这是唯一的写法，没有启用的连接器时同一写法得到恰为 `{\n  "mcpServers": {}\n}\n` 的字节（覆盖残留）。经 `replaceFile(agentDir, "mcp.json", …)` 0640。发布器：`createMcpPublisher({agentDir: () => string | null, store})` 单飞（与 `s1d-model-registry` D7 同一写法），`agentDir()` 在启动阶段 `mcp_json` 之前为 null（只改 DB、不写文件）。启动阶段 `mcp_json` 紧接 `host_overlay`，失败 `reason: "mcp_json"`。每个写端点 = 校验 → 事务（写表 + 审计）→ 发布 → 应答；发布失败 generic 500 + `onPublishFailed` 记录 `{"event":"mcp_publish_failed"}`，行与审计保留（与模型注册表同一规则）。
- **D5 端点**（`server/src/connectors/rest.ts`，模块 `connectors`）：
  - `GET /api/connectors` → 200 `{connectors: ConnectorView[]}`，按名称排序。管理员视图 `{name, type, description, enabled, command, args, envKeys, url, headerKeys, probe: {status, at, message}, updatedAt}`（stdio 的 `url` / `headerKeys` 为 null，http 的 `command` / `args` / `envKeys` 为 null）；普通用户只见 `enabled` 的行且视图为 `{name, type, description}`。永不回传 `env` / `headers` 的值。
  - `POST /api/connectors` body `{name, type, description?, command?, args?, env?, url?, headers?, enabled?}`（键集严格、按类型禁止对方的键）→ 201；重名 409 `conflict`；第 33 个 400。
  - `PUT /api/connectors?name=` body 同 POST 去掉 `name` 与 `type` → 200。整体替换：省略的可选键取 POST 的缺省（`description` `""`、`args` `[]`、省略 `env` / `headers` 即为空、省略 `enabled` 即为 `true`）；`env` / `headers` 的值为 `null` = 保留该键既有的值，键不存在则 400。解析 `null` 之后 `command`、`args`、`env`、`url`、`headers` 任一变化 → 同一事务里 `probe_status='never'`、`probe_at=NULL`、`probe_message=NULL`（旧的探活结果不再说明新参数）；只改 `description` / `enabled` 不复位。整体替换会清掉没带的凭证，所以客户端（D9）总是按管理员视图构造完整 body、凭证键一律带 `null`。
  - `DELETE /api/connectors?name=` → 204（停用列表里的同名项留着无害）。
  - `POST /api/connectors/probe?name=`（无 body）→ 200 管理员视图（D6）。
  - 次序：401 → 非管理员的写与探活 403 `forbidden`（先于 body 与 name）→ `name` 缺失 / 空 / 多值 400 → 未知 404 → body 400；no-store；`POST /api/connectors`、`PUT /api/connectors` 进归属集（body limit 64 KiB）。
  - 审计 `connector.create` / `.update` / `.delete` / `.probe`，detail `{name, type, status?}`。
- **D6 探活**（`server/src/connectors/probe.ts`）：http → `POST <url>`，请求头为登记的 `headers` 加 `content-type: application/json`、`accept: application/json, text/event-stream`，body 为 JSON-RPC `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"workbuddy-probe","version":"1"}}}`；建连 10 s / 整体 15 s，不跟随重定向；2xx 且响应体（JSON，或 `text/event-stream` 的第一个 `data:` 事件）是带 `result` 的 JSON-RPC 对象 → `ok`；其它 → `failed`，message 规则同模型探活（`HTTP <status>：<净化摘要>` ≤200 码点、`无法连接`、`超时`、`响应不是 MCP 初始化结果`），摘要净化覆盖该连接器全部 `headers` 值。stdio → `fs.stat` 为常规文件且对 app 进程可执行（`access X_OK`）→ `ok`，否则 `failed`、`命令不存在或不可执行`；不拉起进程。探活不发布、不改 `enabled`。
- **D7 账号缺省与会话**：`GET /api/connectors/defaults` → `{disabledConnectors: string[]}`、`PUT` 整体替换（≤32、名称规则同 D2、不要求已登记，body limit 16 KiB）。`POST /api/sessions` 加 `disabledConnectors`（同规则，初值 body ?? 账号缺省 ?? `[]`）；会话能力端点的 body / 应答加 `disabledConnectors`（`PUT` 的非空子集规则不变）；fork 复制该列。spawn 时会话配置文件的 `disabledExtensions` = 停用技能 `skill:<名>` ∪ 停用连接器 `mcp:<名>`（`s1d-experts-skills` D1 的写出器原样复用，排序去重）。
- **D8 派发对齐**：能力指纹 = `s1d-experts-skills` 定义的会话配置文件指纹再并上托管 `mcp.json` 的字节（读当前文件；缺失按空串）。连接器的任何登记变化 → 存活会话下一次派发重启；什么都没变 → 复用。
- **D9 中心「连接器」tab**（`CENTER_TABS` 插在 `skills` 之后、`models` 之前，`adminOnly: false`；routeManifest 描述按「中心页外壳」规则为 `专家、技能与连接器`（该规则随本 change 改为「顿号连接、末项前用 `与`」））：列表（名称、类型 `stdio` / `http`、描述，管理员另见命令或地址、探活状态、`启用` 开关）；每行 `默认启用` 开关（账号缺省，`PUT /api/connectors/defaults` 整表，含列表外名称）；管理员的 `启用` 开关与编辑对话框按当前管理员视图构造 `PUT` body：`description` 与按类型的 `command` / `args` 或 `url` 取自视图（对话框里改过的取改后值），`envKeys` / `headerKeys` 每个名称映射为 `null`（对话框里填了新值的取新值），`enabled` 为切换后的值（对话框为视图中的值）——切换启停不丢凭证；管理员另有 `新增连接器` / `编辑`（对话框：名称（编辑只读）、类型 select、描述、stdio 的命令 / 参数（每行一个）/ 环境变量（键值对，编辑时值 placeholder `留空保留现有值`）、http 的地址 / 请求头（同上））/ `删除`（确认）/ `探活`；保存成功且非 stdio 的地址或请求头有改动时自动探活一次（同模型 tab）。空态：标题 `尚未接入内网连接器`，说明 `公网 SaaS 连接器（文档/邮箱/IM）在内网部署下已移除。内网 GitLab 等系统部署完成后在此接入。`（demo :3218-3225 的文案去掉「知识库由本应用自建……」一句：知识库不在本 change）；管理员在空态下仍见 `新增连接器`。
- **D10 「能力」弹层**：技能段之后加 `连接器` 段，列出 `GET /api/connectors` 的（启用的）连接器各一个开关；欢迎态初值取账号缺省、会话中取能力，切换恰一次 `PUT …/capabilities {disabledConnectors}`；读取时机与失败态同技能段；`GET /api/connectors` 与 `GET /api/connectors/defaults` 与既有三种读取一样不计入、也不使 `getComposerOptions` 的缓存失效，只动连接器开关的首次发送不属于「设置保存」（chat-web「能力读取时机」改为五种读取；session-sidebar 的首次发送 body 与 `createSession` input 加 `disabledConnectors`）。
- **D11 ADR-0015「MCP 连接器凭证对 omp uid 可读」**：连接器的 `env` / `headers` 必须交给 omp（它拉起 server、发请求），所以与模型网关密钥（ADR-0008：omp 环境零凭证）不同，它们存在 0640 的托管 `mcp.json` 里、omp uid 可读；登记仅管理员、值不回传、审计不含值。ADR 写明暴露面：
  - **每个登录成员都能拿到全部启用连接器的凭证**：agent 读 `~/.omp/agent/mcp.json` 属于读档、不需审批，任何会话都能读出。所以只登记所有成员都可以持有的凭证。
  - **stdio server 继承 omp 的环境与会话 cwd**：含本 generation 的模型代理令牌，以及 omp 从项目 `.env` 补进来的 `NODE_OPTIONS`、`LD_PRELOAD` 等（`utils/src/env.ts:240-247`）。这与 ADR-0012 记的「项目内工具」残余同类。
  - **既有残余（只报告，不在本 change 修）**：项目 `.env` 可设 `CLAUDE_CONFIG_DIR`（omp 启动时补进环境，`utils/src/env.ts:240-247`），omp 的 `claude` provider 据此改读 `<CLAUDE_CONFIG_DIR>/.claude.json` 作为**用户级** MCP 配置（`config/claude-paths.ts:11-17`、`discovery/claude.ts:63`）。`mcp.enableProjectConfig: false` 只丢 project 级条目，挡不住这条。
  - CONTEXT.md 不变量 #4 只管模型网关与 kb-service 凭证，不涵盖连接器——ADR 写明这条边界。
- **D12 文档**：`system.md` 加「连接器」一节——端点、`mcp.json`、回滚时连同删除 `mcp.json`（组 2a 的 2a.4）；审批行为（组 6 的 6.5）：MCP 工具挂在 `xd://mcp__<server>_<tool>` 下、模型经 `write` 调用，`每次都问` 下确认卡为 `Allow tool: write` 带 `Path: xd://mcp__…`，`只问命令` 下不弹确认，步骤名为 `write`、摘要计为 `新建`。omp-runtime 与 ADR-0010 布局表加 `mcp.json`；验收清单「中心·连接器（CC）」。

### 通用纪律

- 测试先行；每组第一个任务核对本节「Context」的行号与事实，出入先改 design 再继续。
- 连接器的 `env` / `headers` 值不进响应、审计、日志、stderr、错误 message；夹具里的值用哨兵。
- 产品代码单文件 ≤800 行；`server.ts` 加阶段后若超过 780 行，把 `mcp_json` 阶段并进 `s1d-model-registry` 抽出的 `startup-registry.ts`（或同样抽出）——唯一的规则，行数预算表同此。`supervisor.ts` 不放指纹代码：`mcp.json` 字节读取与并入指纹放进既有 `composer-align.ts`，`supervisor.ts` 只多传一个参数。
- 不新增 `.css`；规格 delta 只改列出的 requirement；以兄弟 change 的 delta 为底的块在其 MODIFIED 文本上再改。

## Risks / Trade-offs

- **[每个登录成员都能读到全部启用连接器的凭证]** agent 读 `mcp.json` 不需审批 → ADR-0015；登记仅管理员，只登记所有成员都可持有的凭证。
- **[stdio server 继承 omp 环境与会话 cwd]**（含本 generation 的模型代理令牌与项目 `.env` 补进的 `NODE_OPTIONS`、`LD_PRELOAD`）→ 与 ADR-0012 的项目内工具残余同类；写进 ADR-0015。
- **[项目 `.env` 的 `CLAUDE_CONFIG_DIR` 引出用户级 MCP]**（既有残余，不由本 change 引入）`mcp.enableProjectConfig: false` 挡不住 → 只在 ADR-0015 报告，不修。
- **[`只问命令` 下 MCP 调用不弹确认]** MCP 工具挂在 `xd://` 下经 `write` 调用 → system.md 与验收行写明；需要确认的会话用 `每次都问`（确认卡为 `Allow tool: write` 带 `Path: xd://mcp__…`）。
- **[工具段摘要把 `xd://` 调用计为 `新建`]**（范围外说明）：自 #1570 起每个 `xd://` 设备的 `write` 调用都这样计，MCP 只是又一个设备；本 change 不改摘要表。
- **[连接器任一变化重启全部存活会话的下一条]** 与模型注册表的「新模型先重启」同代价；登记操作稀少。
- **[`mcp:<名>` 被 omp 称为 legacy]** 18.12.3 仍支持 → 官方用例钉住，升级时复核。
- **[值恰为只在项目 `.env` 里定义的变量名]** `resolveConfigValue` 会替换 → 只拦 `OMP_CHILD_ENV_NAMES`；要利用它得知道管理员登记的字面值，`.env` 由会话属主控制、只影响其本人会话，接受为残余；`OMP_USER` 模式下 PAM 从主机配置补进来的名称（开放集合）同理不拦，替换出来的是部署者自己的主机配置、只有管理员能登记取值，接受为残余。
- **[MCP 发现是后台的]** 官方用例轮询 `get_state.systemPrompt`，不在 `ready` 后立即断言。

## Migration Plan

1. 组 1（迁移 048 与 store）在 `s1d-experts-skills` 的迁移 047 之后合。
2. 组 2a（`mcp.json` 写出与发布、启动阶段 `mcp_json`、uid-isolation 探针、文档）；组 2b（stdio 夹具、官方 omp 用例、CI 清单）在 2a 之后。
3. 组 3（管理端点与审计）→ 组 4（探活）→ 组 5（账号缺省、会话能力与派发指纹、web 的能力应答解析改三键）。三组串行：归属身份计数 27 → 28 → 29 由各组精确断言，并行会互相打架；组 5 另依赖专家技能组 9（#1663，严格解析器所在；以及 #1664，其用例手写的能力应答）。
4. 组 6（中心 tab）、组 7（「能力」弹层）。回滚 = 回退代码；`mcp.json` 留着时 omp 仍会读它——回滚时连同删除该文件（写进 system.md，组 2a 的 2a.4）。

依赖图（`←` 左边的组依赖右边各项；与 tasks.md 头部一致）：

```
组 1  ← 专家技能组 2
组 2a ← 组 1、#1647
组 2b ← 组 2a、专家技能组 1
组 3  ← 组 2a、#1641、专家技能组 5
组 4  ← 组 3、#1650
组 5  ← 组 4、专家技能组 6、#1663（专家技能组 9）、#1664（专家技能组 10）
组 6  ← 组 4、组 5、专家技能组 8
组 7  ← 组 5、组 6、专家技能组 10
```

## Not yet specified

- 连接器级的账号可见性（某些连接器只给某些部门）。
- 连接器 `timeout` / `cwd` 的登记。
- 把 MCP server 的连接失败展示给用户（omp 不经 RPC 报告）。

## Open Questions

无待决项（grill 已定方向；D2 名称规则、D3 取值规则、D8 指纹并入 `mcp.json`、D11 ADR 是起草者按事实细化，登记在 Epic 待 owner 知悉）。

待 owner 知悉（Stage 4 round 1 裁定，不阻塞）：MCP 工具挂在 `xd://mcp__…` 下、经 `write` 调用——`每次都问` 下确认卡为 `Allow tool: write`，`只问命令` 下不弹，步骤名 `write`、摘要计为 `新建`。沿用 #1570「写 `xd://browser` 就是一次 write」的先例，不钉 `tools.xdev`。

## Sketch seams under test

- 组 1：迁移 048 约束（类型形状 CHECK、级联、列缺省）；store 校验（名称、D3 每条拒绝规则、上限）——`:memory:` + 真实迁移。
- 组 2a：`mcp.json` 字节（排序、只含启用行、空表恰为 `{\n  "mcpServers": {}\n}\n`、JSON 转义）；发布器单飞、`agentDir()` 为 null 时不写；启动阶段 `mcp_json` 的位置与失败 `reason`；uid-isolation：omp uid 能读不能写，`0600` 写出的负对照。
- 组 2b：stdio 夹具 `fake-mcp-server.mjs`（`initialize` 返回哨兵 `instructions`、启动写标记文件）自测；官方 omp 用例（`WORKBUDDY_OMP_TEST=1`）：一次 spawn 登记 `echo` 与 `other`、会话配置文件停用 `mcp:other`，轮询 `get_state.systemPrompt` 直到 `echo` 的哨兵出现，再断言 `other` 的哨兵与标记文件都不在、`xd://mcp__echo_echo` 在路由段。
- 组 3：整体挂载（三个写路由与 GET 过滤的 401 / 403 / 400 / 404 次序、两种视图、值不回传、`null` 保留、整体替换的缺省、启用开关不丢凭证、探活结果复位、改写取值被拒且表与文件不变、内容与启停、`0640` 无残留临时文件、审计 detail 无值、发布失败 500 + 记录、`DELETE` 带坏 body 仍 generic 500、归属身份 27 与模块数 11）。
- 组 4：http 夹具 `initialize` 的 ok / 非 2xx / 非 MCP 响应 / SSE 响应 / 超时 / 无法连接；stdio 的存在 / 不可执行 / 不存在；在途删除 404；摘要净化；探活路由的 401 / 403；归属身份 28。
- 组 5：账号缺省端点；会话创建与能力端点的 `disabledConnectors`；web 的能力应答严格解析三键（两键拒绝）；spawn 的会话配置文件同时含 `skill:` 与 `mcp:`；派发指纹（改连接器 → 下一条重启；不改 → 复用；在途回合中修改不打断）；fork 复制；归属身份 29。
- 组 6：`center-connectors*.test.tsx`（假 `ApiClient`；两种视图、管理员表单、`null` 保留、`启用` 开关的 body、默认启用开关整表、自动探活、空态文案）；中心用例的 tab 条与描述。
- 组 7：「能力」弹层连接器段（开关、`PUT`、欢迎态初值与带入 `POST /api/sessions`）；读取时机（五种读取不计入 `getComposerOptions`）。

## 行数预算

| 文件 | 现状 | 预计 | 说明 |
|---|---|---|---|
| `server/src/server.ts` | 743（+兄弟） | ≤780 | 阶段 `mcp_json`；超过 780 即并进 `startup-registry.ts`（「通用纪律」同一规则） |
| `server/src/sessions/supervisor.ts` | 785（+#1648、+专家技能组 6） | 不超过兄弟之后 +3 | 只多传 `mcp.json` 字节一个参数；指纹代码进 `composer-align.ts`，保住 ≤800 |
| `server/src/sessions/composer-align.ts` | 61（+兄弟） | ~90 | `mcp.json` 字节读取与并入指纹 |
| `server/src/app.ts` | 491（+兄弟 ~560） | ~585 | 注册 `connectors` |
| `server/src/connectors/*.ts` | 新 | 各 ≤400 | validate / store / mcp-json / probe / rest |
| `web/src/features/center/connectors/*` | 新 | 各 ≤400 | |

## Traceability

- 需求：`IMPLEMENTATION_PLAN.md` F-CTR-CON（:117）、S1d（:247-255）；PLAN §3.3「连接器」；CONTEXT.md「连接器」。
- grill 凭证：本 design「owner 的裁定」（2026-10-21）。
- 相关 ADR：0008（对照）、0010（布局）、0012（overlay 与 MCP）、新 0015。
- 兄弟 change：`s1d-model-registry`（Epic #1640）、`s1d-experts-skills`。
