# connectors Specification

## Purpose
MCP 连接器由管理员全局登记（stdio 或 http），DB 为事实源，宿主据此生成 omp 每次 spawn 读取的托管 `mcp.json`；普通用户可在账号与会话两级停用连接器。本能力覆盖连接器数据、取值规则、托管文件、管理端点、探活、账号缺省与中心「连接器」tab。

## ADDED Requirements

### Requirement: 迁移 048 连接器 schema
迁移 `048_connectors.sql` SHALL 在既有 runner 持有的事务内原子执行，回执紧随 `047_experts_skills.sql`：建表 `connectors(name TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('stdio','http')), description TEXT NOT NULL, command TEXT NULL, args TEXT NULL, env TEXT NULL, url TEXT NULL, headers TEXT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)), probe_status TEXT NOT NULL DEFAULT 'never' CHECK (probe_status IN ('never','ok','failed')), probe_at INTEGER NULL, probe_message TEXT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`，并有 CHECK：`type = 'stdio'` 时 `command` 非空且 `url`、`headers` 为空；`type = 'http'` 时 `url` 非空且 `command`、`args`、`env` 为空。建表 `account_connector_prefs(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, disabled_connectors TEXT NOT NULL, updated_at INTEGER NOT NULL)`；给 `chat_sessions` 加列 `disabled_connectors TEXT NOT NULL DEFAULT '[]'`。`args` 为 JSON 字符串数组、`env` / `headers` 为 JSON 对象、`disabled_connectors` 为 JSON 字符串数组文本。

#### Scenario: 形状约束
- **WHEN** 插入 `type='stdio'` 而 `command` 为 NULL 的行；插入 `type='http'` 而 `env` 非 NULL 的行；在已有会话的库上运行迁移
- **THEN** 前两次被 CHECK 拒绝；既有会话的 `disabled_connectors` 为 `[]`

### Requirement: 连接器取值规则
连接器 SHALL 满足：`name` 匹配 `^[a-z](?:[a-z_]{0,30}[a-z])?$` 且创建后不可改；`description` 0..200 码点；stdio：`command` 为 `/` 开头的绝对路径、≤1024 字节、无控制字符，`args` ≤32 项、每项 ≤1024 码点，`env` ≤32 键、键匹配 `^[A-Z_][A-Z0-9_]{0,63}$`、值 1..4096 码点；http：`url` 整体匹配 `^https?://[^\s#@]+$`，`headers` ≤32 个、名为 RFC 7230 token、值通过 Node `http.validateHeaderValue`。任何将写进托管 `mcp.json` 的字符串（`command`、`args` 各项、`env` 值、`url`、`headers` 值）SHALL NOT 以 `!` 开头、SHALL NOT 含 `${`；`env` 与 `headers` 的值 SHALL NOT 恰等于 omp 子进程环境白名单中的任一变量名（omp 会把这三种写法分别当作执行命令、插值与环境变量替换）。连接器至多 32 个。违反任一条 SHALL 400 `bad_request`，message 只点名字段、不回显取值。

#### Scenario: omp 会改写的取值被拒
- **WHEN** 管理员以 `env:{TOKEN:"!cat /etc/passwd"}`、`headers:{authorization:"Bearer ${WORKBUDDY_MODEL_TOKEN}"}`、`env:{X:"PATH"}`、`args:["${HOME}"]`、`name:"git2"`、`name:"Git"`、`command:"node"` 各提交一次 `POST /api/connectors`
- **THEN** 全部 400 `bad_request`，message 不含提交的值，表与 `mcp.json` 不变

### Requirement: 托管 mcp.json
宿主 SHALL 把 `enabled = 1` 的连接器写成 `<OMP_STATE_DIR>/home/.omp/agent/mcp.json`：内容为 `{"mcpServers": {<name>: <条目>}}` 以两空格缩进的 JSON 加换行，`name` 按字典序；stdio 条目恰为 `{"type":"stdio","command","args","env"}`（`args` 缺省 `[]`、`env` 缺省 `{}`），http 条目恰为 `{"type":"http","url","headers"}`（`headers` 缺省 `{}`）；没有启用的连接器时内容为 `{"mcpServers": {}}` 加换行。文件经原子替换写出、终态 `0640`。启动阶段 `mcp_json` 位于 `host_overlay` 之后写一次（失败 `reason: "mcp_json"`）；此后每次连接器写入在同一请求里于事务提交后重写（单飞：同一时刻只有一次重写在跑，后到者以最新状态再写一次）；`mcp_json` 阶段之前的写入只改 DB。重写失败 SHALL 使该请求以 generic 500 结束、经注入的记录口写一行 `{"event":"mcp_publish_failed"}`，DB 行与审计保留，下一次写入或启动再写。

#### Scenario: 内容与启停
- **WHEN** 登记 stdio `b` 与 http `a`（带请求头哨兵），再把 `b` 的 `enabled` 改为 false，再删除 `a`
- **THEN** 三次后的 `mcp.json` 依次为含 `a`、`b`（`a` 在前）的对象、只含 `a` 的对象、`{"mcpServers": {}}`；文件模式 `0640`；响应、审计与 stderr 不含请求头哨兵

#### Scenario: 官方 omp 读取并按会话停用
- **WHEN** 官方 omp（`WORKBUDDY_OMP_TEST=1`，`--no-extensions` 与既有宿主 overlay 照旧）以登记了 stdio 夹具 `echo_server`（工具 `echo`）的 `mcp.json` 启动；另一次会话配置文件的 `disabledExtensions` 含 `mcp:echo_server`
- **THEN** 第一次轮询 `get_state.systemPrompt`（≤30 s）出现 `mcp__echo_server_echo` 的路由行；第二次在同一时限内始终不出现，夹具进程没有被拉起

### Requirement: 连接器管理端点
`connectors` 模块 SHALL 注册（cookie guard，no-store）：
- `GET /api/connectors` → 200 `{connectors: ConnectorView[]}`，按名称排序。管理员见全部行，视图 `{name, type, description, enabled, command, args, envKeys, url, headerKeys, probe: {status, at, message}, updatedAt}`（另一类型的字段为 null；`envKeys` / `headerKeys` 为键名字典序数组）；其它角色只见 `enabled` 的行，视图恰为 `{name, type, description}`。任何视图 SHALL NOT 含 `env` 或 `headers` 的值。
- `POST /api/connectors`，body `{name, type, description?, command?, args?, env?, url?, headers?, enabled?}`（键集严格，含另一类型的键即 400）→ 201 管理员视图；重名 409 `conflict`；第 33 个 400。
- `PUT /api/connectors?name=<name>`，body 为 POST 去掉 `name`、`type` 的同一形状（整体替换；`env` / `headers` 中值为 `null` 的键保留该键既有的值，既有值里没有该键则 400）→ 200。
- `DELETE /api/connectors?name=<name>` → 204。
- `POST /api/connectors/probe?name=<name>`（无 body）→ 200 管理员视图（「连接器探活」）。
检查次序：未认证 401 → 非管理员对后四者 403 `forbidden`（先于 body 解析与 name 查找）→ `name` 缺失、空或多值 400 → 未知 404 → body 400。`POST /api/connectors` 与 `PUT /api/connectors` SHALL 进 content-parser 归属集（body limit 64 KiB）。每次写入与探活 SHALL 在同一事务里记审计 `connector.create` / `connector.update` / `connector.delete` / `connector.probe`，`detail = {name, type, status?}`，不含任何 `env` / `headers` 值、命令参数或地址。

#### Scenario: 两种视图与保留值
- **WHEN** 管理员登记 stdio `gitlab`（`env:{TOKEN:<哨兵>}`）与停用的 http `wiki`；普通用户 `GET`；管理员 `PUT ?name=gitlab` 带 `env:{TOKEN:null, EXTRA:"1"}`
- **THEN** 普通用户只得到 `[{name:"gitlab", type:"stdio", description:""}]`；管理员视图 `envKeys` 为 `["TOKEN"]` 且全文不含哨兵；`PUT` 后 `mcp.json` 中 `gitlab.env` 为 `{EXTRA:"1", TOKEN:<哨兵>}`

#### Scenario: 非管理员
- **WHEN** 普通用户对 `POST /api/connectors`（malformed JSON）、`PUT ?name=gitlab`、`DELETE`（缺 name）、`POST /api/connectors/probe?name=nope` 各发一次
- **THEN** 全部 403 `forbidden`、no-store，表、审计与 `mcp.json` 不变

### Requirement: 连接器探活
`POST /api/connectors/probe?name=` SHALL：http 连接器向其 `url` 发一次 POST，请求头为登记的 `headers` 加 `content-type: application/json` 与 `accept: application/json, text/event-stream`，body 为 MCP `initialize` 的 JSON-RPC 请求（`protocolVersion: "2025-03-26"`、`clientInfo.name: "workbuddy-probe"`）；建连期限 10 s、整体 15 s，不跟随重定向、不重试；响应为 2xx 且其 JSON（或 `text/event-stream` 第一个 `data:` 事件的 JSON）是含 `result` 的 JSON-RPC 对象 → `ok`、message null；非 2xx → `failed`、`HTTP <status>：<摘要>`（摘要经净化，覆盖该连接器全部请求头值，≤200 码点）；2xx 但不是 MCP 初始化结果 → `响应不是 MCP 初始化结果`；连接失败 → `无法连接`；期限到 → `超时`。stdio 连接器 SHALL NOT 拉起任何进程：`command` 是对 app 进程可执行的常规文件 → `ok`，否则 `failed`、`命令不存在或不可执行`。结果写入该行（`probe_status`、`probe_at`、`probe_message`）；探活 SHALL NOT 重写 `mcp.json`、SHALL NOT 改 `enabled`；同一连接器的并发探活串行，在途期间被删 → 结果丢弃、404。

#### Scenario: http 与 stdio
- **WHEN** 对指向 http MCP 夹具（答 `initialize` 结果）、指向答 401 且回显请求头哨兵的夹具、指向答 200 `{"ok":true}` 的夹具、指向未监听端口的 http 连接器各探活一次；对 `command` 为存在的可执行文件与不存在路径的 stdio 连接器各探活一次
- **THEN** 结果依次 `ok`、`failed`（`HTTP 401：…` 不含哨兵）、`failed`（`响应不是 MCP 初始化结果`）、`failed`（`无法连接`）、`ok`、`failed`（`命令不存在或不可执行`）；`mcp.json` 的 mtime 不变；每次一条 `connector.probe` 审计

### Requirement: 连接器账号缺省
`connectors` 模块 SHALL 注册 `GET /api/connectors/defaults` → 200 `{disabledConnectors: string[]}`（本账号 `account_connector_prefs` 的列表原样，字典序）与 `PUT /api/connectors/defaults`，body `{disabledConnectors: string[]}`（键集严格；≤32 项；名称规则同「连接器取值规则」；去重；不要求已登记；body limit 16 KiB，进归属集）→ 200 同 GET。账号缺省只决定之后新建会话的初值。不审计。

#### Scenario: 缺省决定新会话
- **WHEN** 账号 `PUT /api/connectors/defaults {disabledConnectors:["gitlab"]}` 后创建会话（body 不带 `disabledConnectors`）
- **THEN** 该会话能力的 `disabledConnectors` 为 `["gitlab"]`，其 spawn 的会话配置文件 `disabledExtensions` 含 `"mcp:gitlab"`

### Requirement: 中心「连接器」tab
`/center?tab=connectors`（`label` `连接器`，对所有人可见，`CENTER_TABS` 中位于 `skills` 之后、`models` 之前）SHALL 渲染 `GET /api/connectors` 的列表：每行名称、类型、描述与开关 `默认启用`（accessible name `默认启用 <名称>`；切换恰一次 `PUT /api/connectors/defaults`，body 为切换后的完整列表，含列表外的名称；在途禁用、失败回滚并显示 `ApiError.message`）。管理员另见：命令或地址、探活状态（`从未` / `正常` / `失败：<message>`）、`启用` 开关（`PUT` 该连接器）、行操作 `编辑` / `删除`（确认）/ `探活`，页顶 `新增连接器`；新增 / 编辑对话框字段为名称（编辑时只读）、类型（select，编辑时只读）、描述，stdio 的命令、参数（每行一个）与环境变量（键值对），http 的地址与请求头（键值对）；编辑时已有键的值输入框为空、placeholder `留空保留现有值`，留空提交该键为 `null`；提交前按「连接器取值规则」在客户端逐字段校验并显示原因；保存成功且 http 的地址或请求头有改动时紧接着恰一次探活；对话框接 `useEscapeFallback`。没有可见连接器时显示 `尚未接入内网连接器` 与 demo 说明文案。API 客户端 `web/src/lib/api-connectors.ts` 提供 `listConnectors` / `createConnector` / `updateConnector` / `deleteConnector` / `probeConnector` / `getConnectorDefaults` / `putConnectorDefaults`，`name` 经 `encodeURIComponent`，按角色两种视图严格解析。

#### Scenario: 普通用户与管理员
- **WHEN** 普通用户打开 `/center?tab=connectors` 并关闭 `gitlab` 的 `默认启用`；管理员打开同一页并新增 http 连接器 `wiki`（地址与一个请求头）
- **THEN** 普通用户的行没有命令、地址与管理按钮，`PUT /api/connectors/defaults` 恰一次 body `{disabledConnectors:["gitlab"]}`；管理员恰一次 `createConnector` 后恰一次 `probeConnector("wiki")`，随后列表重取
