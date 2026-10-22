# Proposal: s1d-connectors

> Issue type: feature（S1d 中心能力面第三刀：MCP 连接器）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: 托管 agent 目录多一个 `mcp.json`（omp 每次 spawn 读取并按其拉起 MCP server）、启动阶段多一步 `mcp_json`、会话配置文件的 `disabledExtensions` 多 `mcp:<名称>` 元素、派发前对齐的能力指纹并入 `mcp.json` 字节、`POST /api/sessions` 与会话能力端点多一个键、迁移 048、`/center` 多一个 tab、输入框「能力」弹层多一段
> Evidence floor: `npm test --workspace server`（含 `WORKBUDDY_OMP_TEST=1` 官方用例）、`npm test --workspace web`、typecheck、size-guard、`make check`、`make test-guardrails`、`make ui-walk`、PR CI `uid-isolation`
> 依赖：建在 `s1d-model-registry`（Epic #1640：`forbidden` 码、管理端点与发布的写法、启动阶段）与 `s1d-experts-skills`（会话配置文件机制、会话能力端点、派发对齐的能力指纹、中心 tab、「能力」弹层）之上。归档顺序：`s1d-model-registry` → `s1d-experts-skills` → 本 change。迁移编号 048（049 预留给 S1b 挂载）。

## Why

`IMPLEMENTATION_PLAN.md` S1d 要求中心页的「连接器」tab（F-CTR-CON：MCP 连接器，仅显式配置），并注明「MCP 配置注入 omp 需一眼白盒」。今天宿主 overlay 钉 `mcp.enableProjectConfig: false`，项目层的 MCP 配置不会被拉起，平台级也没有任何登记入口（ADR-0012：「需要 MCP 时由管理员装到平台级配置」），所以会话里没有 MCP 工具。

grill（2026-10-21，owner 逐分支拍板）定了方向：**管理员全局登记** stdio 与 http 两类连接器，DB 为事实源，生成托管的用户级 `mcp.json`（0640）；凭证只进 `env` / `headers`，不进 `args`；http 做握手探活，stdio 只校验命令存在；连接器登记仅管理员；会话级启停经会话配置文件的 `disabledExtensions: ["mcp:<名称>"]`；中心 tab 改账号缺省，输入框「能力」弹层改会话。

## What Changes

- **迁移 048**（`048_connectors.sql`）：`connectors` 表（名称、类型、描述、stdio 的命令 / 参数 / 环境、http 的地址 / 请求头、启用、探活结果）；`account_connector_prefs`（账号缺省停用的连接器名）；`chat_sessions.disabled_connectors`。
- **托管 `mcp.json`**：启用的连接器写成 `<state>/home/.omp/agent/mcp.json`（`{"mcpServers":{…}}`，原子替换，0640）；新启动阶段 `mcp_json`（`host_overlay` 之后）写一次，每次连接器写入在同一请求里重写（单飞）。omp 在每次 spawn 时读它（`--no-extensions` 不影响用户级 `mcp.json`）。
- **取值规则**：名称 `^[a-z](?:[a-z_]{0,30}[a-z])?$`（omp 把工具名规整为 `mcp__<名>_<工具>`、只保留 `[a-z_]`，限制字母与下划线才不会撞名）；stdio 命令为绝对路径；http 地址同模型上游规则；任何写进 `mcp.json` 的字符串都不得以 `!` 开头、不得含 `${`，`env` / `headers` 的值不得恰为 omp 环境白名单里的变量名——这三种写法 omp 会当作执行命令、插值或取环境变量（design D3）。
- **连接器端点** `/api/connectors`：`GET`（所有人；普通用户只见启用的连接器的名称、类型与描述，管理员另见命令、参数、地址、`env` / `headers` 的键名与探活结果，永不回传 `env` / `headers` 的值）；`POST` / `PUT ?name=` / `DELETE ?name=` / `POST /api/connectors/probe?name=`（仅管理员，其余 403 `forbidden`）。`PUT` 的 `env` / `headers` 值为 `null` 表示保留既有值。审计 `connector.create` / `connector.update` / `connector.delete` / `connector.probe`，detail 不含值。
- **探活**：http 连接器对其地址 POST 一次 MCP `initialize`（带登记的请求头，10 s / 15 s 期限），2xx 且得到 JSON-RPC `result` 为 `ok`；stdio 连接器只检查命令是存在的可执行常规文件，不拉起进程。
- **账号缺省与会话**：`GET /api/connectors/defaults` / `PUT /api/connectors/defaults`（账号缺省停用列表）；`POST /api/sessions` 与 `GET` / `PUT /api/sessions/:id/capabilities` 加 `disabledConnectors`；每次 spawn 的会话配置文件 `disabledExtensions` = 停用技能的 `skill:<名>` ∪ 停用连接器的 `mcp:<名>`。
- **派发对齐**：能力指纹并入托管 `mcp.json` 的字节——连接器登记有任何变化，存活会话在下一条消息前重启并读到新文件。
- **中心「连接器」tab**（人人可见，排在 `技能` 之后、`模型` 之前）：连接器列表与 `默认启用` 开关；管理员另有 `新增连接器`、`编辑`、`删除`、`探活`；没有连接器时空态 `尚未接入内网连接器`（demo 文案）。
- **「能力」弹层**加连接器一段（启用的连接器各一个开关）。
- **文档**：ADR-0015「MCP 连接器凭证对 omp uid 可读」（与模型网关密钥「omp 环境零凭证」的区别与理由）、`system.md`「连接器」一节、omp-runtime 布局表加 `mcp.json`、验收清单「中心·连接器（CC）」一节。

## Capabilities

### New Capabilities
- `connectors`: 连接器数据、取值规则、托管 `mcp.json`、管理端点、探活、账号缺省、中心「连接器」tab。

### Modified Capabilities
- `omp-runtime`: 「OMP_STATE_DIR 托管布局」（agent 目录加托管 `mcp.json`，`0640`）。以 `s1d-experts-skills` 的 delta 为底。「宿主 overlay」不改（`mcp.enableProjectConfig: false` 只管项目层，与平台级 `mcp.json` 并存不失真）。
- `skill-switches`（由 `s1d-experts-skills` 新建）: 「会话能力端点」「停用技能对 omp 生效」「输入框「能力」弹层」加连接器。
- `chat-sessions`: 「派发前按会话设置对齐进程」（`disabled_connectors` 进有效能力，能力指纹并入 `mcp.json` 字节；以 `s1d-experts-skills` 的 delta 为底）。
- `session-metadata`: 「会话创建与空间绑定」「fork 继承会话元数据」（`disabledConnectors`；以 `s1d-experts-skills` 的 delta 为底）。
- `http-service-skeleton`: 「服务启动与装配」（阶段 `mcp_json`、模块 `connectors`）、「统一错误信封」（归属身份二十九条）、「Shared agent module assembly」（以 `s1d-experts-skills` 的 delta 为底）。
- `model-registry`（由 `s1d-model-registry` 新建）: 「中心页外壳」（tab 表加 `connectors`、描述规则改为顿号连接末两项用 `与`；以 `s1d-experts-skills` 的 delta 为底）。
- `omp-uid-isolation`: 「Linux 隔离证明」（托管布局用例另证 omp uid 能读、不能覆写 `mcp.json`；以 `s1d-experts-skills` 的 delta 为底）。

## Impact

- 服务端：新 `server/src/connectors/`（store、mcp-json 写出与发布、probe、rest）、`server.ts` 阶段、`app.ts` 注册、`sessions/` 的会话能力与派发指纹。
- 前端：新 `web/src/features/center/connectors/`、`web/src/lib/api-connectors.ts`、`tabs.ts`、能力弹层。
- 测试夹具：新 stdio MCP server 夹具 `server/test/support/fake-mcp-server.mjs`（官方 omp 用例用）与 http MCP 夹具（探活用）。
- 文档：ADR-0015、`system.md`、ADR-0010 布局表、验收清单 CC 节、`IMPLEMENTATION_PLAN.md` F-CTR-CON 行。
