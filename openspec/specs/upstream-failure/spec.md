# upstream-failure Specification

## Purpose
定义回合失败对用户与运维的呈现契约：把每次失败归为一个固定原因并配一句中文说明，净化上游原文（去密钥、去上游地址的敏感部分、去服务器路径、纯文本、截断），把失败落库进快照，经事件推送，记录一行服务日志，并把 omp 的会话级重试显示为「正在重试」。

## Requirements

### Requirement: 回合失败分类
服务端 SHALL 把每个以 `error` 事件结束的回合归为下表恰一个 `reason`，按序取第一条命中的规则。输入是失败来源（`message_end`：omp 报告的 assistant 失败；`runtime`：prompt 失败应答或 supervisor 的 `applyFailure`）、`errorStatus`（可缺；不是 100–599 之间的整数时按缺失处理——web 只接受该范围，见 chat-web「API 客户端扩展」，#909 PR 4 实施补入）与 `errorMessage`。「末尾记号」指 `errorMessage` 整段文本以 `(type=wb_upstream param=<种类>)` 结尾，`<种类>` 为 `status.<三位数>`、`connect.<1–64 个 [A-Z0-9_]>`、`gateway_504`、`gateway_524`、`no_connect` 或 `no_response` 之一（model-proxy「透传端点与 bearer 鉴权」的失败摘要经 omp 后的形状），**且** `errorStatus` 等于代理为该种类发出的状态：`status.*` 与 `connect.*` 为 502，`gateway_*`、`no_connect` 与 `no_response` 为 424。出现在其它位置的同样字样、以及 `errorStatus` 不符的末尾记号（例如原样透传的 `< 500` 上游正文自带的 `type` / `param`）SHALL NOT 被采信，此时按下表其余各行分类。

| # | 条件 | `reason` | `status` | `message`（固定句子） |
|---|---|---|---|---|
| 1 | 来源为 `runtime` | `agent_failed` | null | Agent 运行失败 |
| 2 | 末尾记号 `status.<s>` | `upstream_error` | `<s>` | 上游出错：模型服务内部错误 |
| 3 | 末尾记号 `connect.<c>` 或 `no_connect` | `upstream_unreachable` | null | 上游不可达：无法连接模型服务 |
| 4 | 末尾记号 `no_response` 或 `gateway_<s>` | `upstream_timeout` | `no_response` 为 null，`gateway_<s>` 为 `<s>` | 上游超时：模型服务没有及时响应 |
| 5 | `errorStatus` 为 401 或 403 | `auth_failed` | 该值 | 鉴权失败：模型服务拒绝了配置的 API 密钥 |
| 6 | `errorStatus` 为 404 且文本含 `model`（不分大小写） | `model_not_found` | 404 | 模型不存在：模型服务找不到所请求的模型 |
| 7 | `errorStatus` 为 402；或为 429 且文本匹配 `quota`、`insufficient`、`billing`、`余额`、`额度` 之一（不分大小写） | `quota_exhausted` | 该值 | 额度不足：模型服务账户的额度已用完 |
| 8 | `errorStatus` 为 429 | `rate_limited` | 429 | 请求过于频繁：模型服务暂时限流 |
| 9 | `errorStatus` 为 408 | `upstream_timeout` | 408 | 上游超时：模型服务没有及时响应 |
| 10 | `errorStatus` 在 400–499 | `request_rejected` | 该值 | 请求被拒：模型服务拒绝了这次请求 |
| 11 | `errorStatus` ≥ 500 | `upstream_error` | 该值 | 上游出错：模型服务内部错误 |
| 12 | 其余 | `model_call_failed` | null | 模型调用失败 |

`detail` 的来源：#2–#4 为 `errorMessage` 第一行先去掉可选的 `Retry budget exhausted after <n> retry: ` / `… retries: ` 前缀、再去掉开头的 `<omp 状态码><空格>` 之后的部分；其余为整段 `errorMessage`（`runtime` 来源为运行时给出的文本，缺失或为空时为 chat-stream 的通用回退文本）。`detail` 在落库、发布与记录之前 SHALL 经「上游原文净化」。界面上的状态码显示为 `（HTTP <status>）`，`status` 为 null 时不显示。句子表在服务端只有一处定义。

#### Scenario: 逐条分类
- **WHEN** 以 `message_end` 来源分别分类：`errorStatus` 401；403；404 且文本含 `The model \`x\` does not exist`；404 且文本为 `404 Not Found`；402；429 且文本含 `insufficient_quota`；429 且文本为 `429 Too Many Requests`；408；400 且文本为 `400 status code (no body)`；502 且文本以 `(type=wb_upstream param=status.503)` 结尾；502 且以 `(type=wb_upstream param=connect.ECONNREFUSED)` 结尾；424 且以 `(type=wb_upstream param=no_connect)` 结尾；424 且以 `(type=wb_upstream param=no_response)` 结尾；424 且以 `(type=wb_upstream param=gateway_504)` 结尾；424 且以 `(type=wb_upstream param=gateway_524)` 结尾；502 且无记号；无状态码、文本为 `The socket connection was closed unexpectedly.`；以 `runtime` 来源分类文本 `boom`
- **THEN** `reason` 依次为 `auth_failed`、`auth_failed`、`model_not_found`、`request_rejected`、`quota_exhausted`、`quota_exhausted`、`rate_limited`、`upstream_timeout`、`request_rejected`、`upstream_error`（status 503）、`upstream_unreachable`（status null）、`upstream_unreachable`（status null）、`upstream_timeout`（status null）、`upstream_timeout`（status 504）、`upstream_timeout`（status 524）、`upstream_error`（status 502）、`model_call_failed`、`agent_failed`；每一例的 `message` 等于表中该行的句子

#### Scenario: 记号只认末尾
- **WHEN** `errorStatus` 为 502，`errorMessage` 的第一行含 `(type=wb_upstream param=connect.X)`，整段以 `(type=wb_upstream param=status.500)` 结尾；另一例 `errorStatus` 为 400，文本中间含 `(type=wb_upstream param=no_response)`、末尾没有记号
- **THEN** 前者为 `upstream_error`、status 500；后者为 `request_rejected`、status 400

#### Scenario: 状态不符的记号不被采信
- **WHEN** 上游以 401 应答 `{"error":{"message":"x","type":"wb_upstream","param":"status.500"}}`，omp 报告 `errorStatus` 401、`errorMessage` 以 `(type=wb_upstream param=status.500)` 结尾；另一例 `errorStatus` 502、以 `(type=wb_upstream param=no_response)` 结尾；另一例 `errorStatus` 424、以 `(type=wb_upstream param=status.503)` 结尾
- **THEN** 依次为 `auth_failed`（status 401）、`upstream_error`（status 502，#11）、`request_rejected`（status 424，#10）

#### Scenario: 重试预算前缀不影响 detail
- **WHEN** `errorStatus` 502，`errorMessage` 为 `Retry budget exhausted after 1 retry: 502 模型服务返回 HTTP 503：busy\n模型服务返回 HTTP 503：busy (type=wb_upstream param=status.503)`，另一例同一文本去掉该前缀
- **THEN** 两例都为 `upstream_error`、status 503、`detail` 为 `模型服务返回 HTTP 503：busy`

### Requirement: 上游原文净化
服务端 SHALL 只有一个净化函数，输入文本与一组密钥串，按以下次序处理：
1. CRLF、单独的 CR、U+2028、U+2029 归一为 LF；U+0000–U+0008、U+000B–U+001F 与 U+007F 被删除；
2. 以 `raw-http-request=` 或 `raw-http-request-save-failed=` 开头的行被整行删除；
3. 每个非空密钥串（先经第 1 步同样的归一）的每次逐字出现被替换为 `[已移除]`（不论长短，较长的串先替换）；
4. `Bearer` 后接空白再接一段非空白（不分大小写）被替换为 `Bearer [已移除]`；`sk-` 后接至少 16 个 `[A-Za-z0-9_-]` 的串被替换为 `[已移除]`；
5. 末尾空白被去掉；
6. 结果超过 2000 个码点时保留前 1994 个码点并接 `…（已截断）`，结果恒不超过 2000 个码点且不拆代理对。

控制字符在去密钥之前删除，使被控制字符劈开的密钥不能躲过替换后被拼回；去密钥在截断之前，使密钥不会因被截成半截而漏网。

**密钥集**由同一模块的一个纯函数导出，输入是注册表此刻全部已登记上游的 `{apiKey, baseUrl}` 列表（model-registry「注册表快照是白名单的唯一来源」的 `secrets()` 所据；change s1d-model-registry 起不再从环境变量读）与两组路径，SHALL 对每个已登记上游包含：其 apiKey；其 base URL 原串；其 userinfo 原串与其中的密码段（存在时）；其 pathname 整串（不为空、不为 `/` 时）以及其中长度不小于 8 的每个路径段；其查询串（去掉 `?`，非空时）；此外OMP 状态目录与沙箱根各四种写法——配置原值、`normalize()` 后的形式、去掉尾部 `/` 的形式（根目录 `/` 除外）、净化时现取的 `realpathSync.native`（取不到时略去）——去重后列入（#909 PR 4 / PR 5 实施补入）。没有任何已登记上游时只有两组路径。密钥集 SHALL 在每次净化时现取（注册表写入后的下一次净化即用新集合；sessions 的净化闭包不缓存上游）。模型代理对 ≥500 正文节选 SHALL 使用 `models.secrets()` 加本请求所用 route 自己的 apiKey 与 base URL 各部分（在途期间该模型被删或换密钥时旧值仍在集合里）；sessions 对每个 `detail`——含 `agent_failed` 的运行时文本（prompt 失败应答、进程异常退出等）——SHALL 使用完整的密钥集。sessions 模块 SHALL NOT 持有密钥值本身：装配方把绑定了密钥集的净化闭包交给它。展示 `detail` 的界面 SHALL 把它当纯文本。

#### Scenario: 去密钥与去路径
- **WHEN** 配置的密钥为 `k-123`，净化 `401 bad key k-123\nAuthorization: Bearer abc.def\nuse sk-AAAAAAAAAAAAAAAAAAAA\nraw-http-request=/srv/state/xdg/state/omp/logs/http-400-requests/1.json\r\nend\u0007`
- **THEN** 结果恰为 `401 bad key [已移除]\nAuthorization: Bearer [已移除]\nuse [已移除]\nend`

#### Scenario: 被控制字符劈开的密钥
- **WHEN** 配置的密钥为 `k-123`，净化 `x k-\u0000123 y\nraw-\u0000http-request=/srv/a.json`
- **THEN** 结果恰为 `x [已移除] y`

#### Scenario: 上游地址与服务器路径
- **WHEN** 配置的密钥为 `k-123`、base URL 为 `https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001`，OMP 状态目录为 `/srv/wb/state`（realpath `/data/wb/state`），沙箱根为 `/srv/wb/sandbox`，净化 `GET https://u:p4ss-secret@gw.example/tenant-0123456789/v1?org=acme-0001 failed; POST /tenant-0123456789/v1/chat/completions; p4ss-secret; tenant-0123456789; org=acme-0001; /srv/wb/state/omp/a.json; /data/wb/state/b; /srv/wb/sandbox/ws/c.txt; gw.example v1`
- **THEN** 结果恰为 `GET [已移除] failed; POST [已移除]/chat/completions; [已移除]; [已移除]; [已移除]; [已移除]/omp/a.json; [已移除]/b; [已移除]/ws/c.txt; gw.example v1`（主机名与短于 8 个字符的路径段 `v1` 保留）
- **WHEN** 一个回合以 `runtime` 来源失败，运行时文本为 `spawn failed: /srv/wb/state/home/.omp/agent/models.yml unreadable`
- **THEN** 落库、发布与快照里的 `detail` 为 `spawn failed: [已移除]/home/.omp/agent/models.yml unreadable`

#### Scenario: 截断上限
- **WHEN** 净化一个 2000 码点的文本、一个 2001 码点的文本，以及一个第 1994、1995 个码点为同一个星位字符两半的文本
- **THEN** 第一个原样返回；第二个为前 1994 个码点加 `…（已截断）`、共 2000 个码点；第三个不出现孤立代理项

#### Scenario: 注册表登记的密钥不进会话
- **WHEN** 管理员经 `POST /api/models` 登记模型 `m2`，上游为一个期望密钥为哨兵（不以 `sk-` 开头）的假上游实例，环境里没有 `MODEL_UPSTREAM_*`；一个成员账号的会话以 `m2` 发含 `WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret` 标记的 prompt（夹具正文回显其期望密钥）；另一例管理员 `PUT` 把 `m2` 换到第二个假上游实例（期望密钥为第二个哨兵）后再发一次
- **THEN** 两例的回合都以 `failed` 结束，`chat_messages` 行、会话视图、SSE 帧与应用 stdout/stderr 都不含任一哨兵，`detail` 里对应位置是 `[已移除]`

### Requirement: 迁移 043 消息错误列
迁移 `043_chat_message_error.sql` SHALL 在既有 runner 持有的事务内执行，回执紧随 `042` 之后追加；它 SHALL 只用 `ALTER TABLE … ADD COLUMN` 给 `chat_messages` 依次增加三个可空、无缺省、不带 CHECK 的列 `error_reason TEXT NULL`、`error_status INTEGER NULL`、`error_detail TEXT NULL`，不重建表、不回填、不建索引；既有列顺序、约束、索引与 `sqlite_sequence` 不变。受信迁移的计数断言随之加一。三列要么全为 NULL，要么 `error_reason` 为「回合失败分类」的一个 `reason`、`error_detail` 为净化后的文本、`error_status` 为整数或 NULL——由应用层保证。

#### Scenario: 新库与存量库
- **WHEN** `openDb` 打开一个新库，另打开一份持有前 042 条回执与消息行的存量库副本
- **THEN** 回执里 `043` 恰出现一次且紧随 `042`；三列存在、可空、无缺省；存量库每条消息的原有列值与行数不变、三列读作 NULL；`PRAGMA foreign_key_check` 为空；再次打开目录不变

#### Scenario: 中途失败可重试
- **WHEN** 在一次性副本里预置已存在的 `chat_messages.error_detail` 列使 `043` 中途失败，随后移除冲突对象重试
- **THEN** 失败时没有 `043` 的回执、前两列也未留下，此前的回执与数据不变；重试时恰应用一次

### Requirement: 失败的公开形状
supervisor 处理 `error` 事件时 SHALL 先净化 `detail`，再在发布该事件之前把 `reason`、`status`、`detail` 写入该助手消息的三个错误列，然后发布；随后的 `turn.end failed` 照旧由终态事务结算。发布的 `error` 事件负载 SHALL 恰为 `{messageId, message, reason, status, detail}`。`GET /api/sessions/:id/messages` 的每条消息 SHALL 带 `error` 键：user 消息恒为 `null`；assistant 消息三列全为 NULL 时为 `null`，否则为恰含四键的 `{reason, message, status, detail}`——`message` 由 `reason` 查「回合失败分类」的句子表得出（不落库）；`reason` 不在表内时读作 `null`。fork 拷贝助手行时三列随行拷贝；regenerate 删除旧助手行时三列随之消失；启动对账把 `running` 置为 `failed` 时不写三列。被停止的回合（`stopped`）不写三列。

#### Scenario: 刷新后看到同一条错误
- **WHEN** 一个回合因上游 401 失败，浏览器在 `turn.end` 之后重新读取快照
- **THEN** SSE 依次有 `error{messageId,message:"鉴权失败：模型服务拒绝了配置的 API 密钥",reason:"auth_failed",status:401,detail:<净化后的原文>}` 与 `turn.end failed`；快照里该助手消息 `status` 为 `failed`，`error` 逐值等于该事件去掉 `messageId` 的四键对象；user 消息的 `error` 为 `null`

#### Scenario: 落库先于发布
- **WHEN** 桩运行时让一个回合以 `message_end{stopReason:"error",errorStatus:502}`（文本以 `(type=wb_upstream param=status.500)` 结尾）结束，测试在 `error` 事件的发布回调里同步读取该助手行
- **THEN** 读到的三列已是 `upstream_error`、500 与净化后的 `detail`，而行状态仍为 `running`；`turn.end` 之后为 `failed`

#### Scenario: 拷贝、删除与对账
- **WHEN** 对末条助手已带错误列的会话 fork 到该轮之后、对另一个同样的会话 regenerate，并在另一个库里留下一条 `running` 消息后重启
- **THEN** fork 出的助手行三列与源行逐值相同；regenerate 后旧行与其三列都不存在、新行三列为 NULL；对账后的 `failed` 消息三列为 NULL、快照 `error` 为 `null`

### Requirement: 上游失败日志
supervisor 发布 `reason` 不为 `agent_failed` 的 `error` 事件时 SHALL 经 sessions 的 `log` 端口恰交出一条记录 `{event:"upstream_failed", sessionId, reason, status}`（`status` 为整数或 null），生产入口按 http-service-skeleton「服务启动与装配」把它写成一行 application stderr。记录 SHALL NOT 含 `detail`、上游正文、文件路径或任何凭据；写失败不影响回合与进程。重试后成功的回合不产生记录。

#### Scenario: 每个失败回合一行
- **WHEN** 三个回合分别以上游 401、上游 503（封顶一轮重试后失败）与 omp 进程异常退出结束，另一个回合在一次重试后成功
- **THEN** `log` 端口恰收到两条记录：`{event:"upstream_failed",sessionId:<第一个>,reason:"auth_failed",status:401}` 与 `{event:"upstream_failed",sessionId:<第二个>,reason:"upstream_error",status:503}`；没有其它 `upstream_failed` 记录

### Requirement: 重试提示事件
omp 开始一轮会话级自动重试时，supervisor SHALL 发布归约器产出的 `turn.retry{messageId}`：它占用当代环形缓冲的一个序号、按既有顺序发布，SHALL NOT 落库，也不改变消息或会话的任何列；失败那一轮已经累积的 `thinking` SHALL NOT 因重试被清除（重试成功的回合的 thinking 可能是两轮首尾相接，已接受残余；有正文输出的回合 omp 不重试）。快照里没有「重试中」：经完整快照恢复的连接在下一个事件之前看到普通的 running；同一 epoch 内带 `Last-Event-ID` 的重连按既有回放规则重放它。

#### Scenario: 重试提示可回放不可快照
- **WHEN** 回合发布 `turn.retry` 之后，一个订阅者以该事件之前的游标重连，另一个订阅者重新读取快照
- **THEN** 前者收到该 `turn.retry`；后者的快照中该助手消息为 `running`、`error` 为 `null`，且与发布前相比没有任何字段变化

### Requirement: 截断尾部丢弃的计算上界
`upstreamExcerpt(text, secrets, cut)` 在 `cut` 为真时「丢掉末尾恰为某个密钥开头一段」（model-proxy「透传端点与 bearer 鉴权」≥500 一节）的比较 SHALL 只对可能命中的前缀计算替换形状。替换形状的末码元只能是该前缀的末码元或 `[已移除]` 的末码元 `]`，据此文本末码元既不是前缀末码元也不是 `]` 时跳过。替换形状的计算量 SHALL 有固定上界：替换链里只保留是该密钥子串或含 `[已移除]` 任一码元的密钥（其余必不命中）；每次在长度 n 的串里搜长度 m 的模式按朴素搜索比较次数的上界 (n − m + 1) × max(m, 短模式折算量) 加固定折算量计入，`split` 另按命中次数计入，每次与文本末尾的比较按 head 长度加固定折算量计入；累计超过常量预算时 SHALL fail closed——整段节选为空串（代理 `message` 为 `模型服务返回 HTTP <status>`，探活摘要为空），SHALL NOT 返回部分丢弃的结果或保留任何尾部。预算内的结果 SHALL 与逐前缀全量比较逐字节相同；预算 SHALL 足以让 50 个上游、合计 300 条密钥（密钥长至 164 码元）、截断正文以 `[已移除]` 结尾的常规部署不触发 fail closed。会话侧「上游原文净化」（不带 `cut`）不受此约束、行为不变；model-registry「探活」摘要经 `upstreamExcerpt` 同样受此约束。

#### Scenario: 病态密钥集不阻塞
- **WHEN** 密钥集来自一条约 16 KB、约 1780 个长度 ≥ 8 的路径段的 base URL，正文 16 KiB、`cut` 为真且以 `[已移除]` 结尾；另一例为十个上游合计 ≥ 1000 条密钥、同样以 `[已移除]` 结尾的正文
- **THEN** 两例单次 `upstreamExcerpt` 都在 1000 ms 内返回 `""`

#### Scenario: 计费不随模式结构失准
- **WHEN** 正文为 `a`×16000 后接 ` busy ]`（16 KiB 级、`cut` 为真、以 `]` 结尾），密钥集依次为：(1) `a`×16000 与中间是 `]` 的长模式 `a`×4000 + `]` + `a`×3999；(2) `a`×16000 与首码元密集的短模式 `aaaaa]`、`aaaa]`、`aaa]`、`aa]`、`a]`；(3) 一条路径是 `a`×16000 的地址加一个短密钥 `ab`；(4) 路径是 `/`×16000 的地址与 `https://api.openai.com/v1` 并存
- **THEN** 每例单次 `upstreamExcerpt` 在 1000 ms 内返回：(1)(2) 为 `""`（模式含 `[已移除]` 的码元而留在替换链里，按比较次数计费超出预算）；(3)(4) 为 `[已移除] busy ]`（短密钥不是长地址的子串、不含标记码元，被移出替换链）

#### Scenario: 剪枝后的大密钥集照常放行
- **WHEN** 同一 16 KB 密钥集，正文 16 KiB、`cut` 为真，末码元不出现在任何密钥里（如 `}`）
- **THEN** 1000 ms 内返回非空节选，等于该正文按「上游原文净化」与节选规则得到的结果（不丢任何尾部）

#### Scenario: 常规规模行为不变
- **WHEN** 50 个上游（每个 `https://<host>/<段>/<段>/<段>/v1` 形地址，三个段长度均 ≥ 8 且互不相同，加 32 位与 164 位密钥各一组；每上游 6 条密钥——密钥、base URL、pathname、三个段——合计 300 条），截断正文分别以某密钥开头一段结尾、以 `[已移除]` 结尾；另有较短密钥跨在较长密钥被截断开头的边界上的情形
- **THEN** `upstreamExcerpt(…, true)` 与修复前的逐前缀全量比较逐字节相同，均未 fail closed
