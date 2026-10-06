## ADDED Requirements

### Requirement: 迁移 040 会话输入框设置列
迁移 `040_chat_session_composer.sql` SHALL 在既有 runner 持有的事务内执行，回执紧随实施时迁移目录中已存在的上一个文件之后追加，不改变账本校验与任何更早的回执；它 SHALL NOT 重建任何表，只用 `ALTER TABLE … ADD COLUMN` 给 `chat_sessions` 增加恰三个可空、无缺省的列：
`approval_mode TEXT NULL CHECK (approval_mode IN ('always-ask','write','yolo'))`；`model_id TEXT NULL`（无 CHECK，是否在白名单内由读取时的有效值解析决定）；
`reasoning_effort TEXT NULL CHECK (reasoning_effort IN ('off','minimal','low','medium','high','xhigh','max','auto'))`。既有行的全部原有列值、外键、级联、索引与 `sqlite_sequence` 值 SHALL 不变，三个新列读作 NULL；没有回填。
更早的迁移文件 SHALL NOT 被编辑。受信任迁移目录计数断言 SHALL 随之加一。列里存的是用户的原始选择，对外使用的值见「有效值解析」。

#### Scenario: 新库与存量库
- **WHEN** `openDb` 打开一个新库；另一例打开一个回执止于上一个迁移、含两个账号的会话、消息与步骤的文件库
- **THEN** 回执里 `040` 恰出现一次且排在此前全部回执之后；`chat_sessions` 有 `approval_mode`、`model_id`、`reasoning_effort` 三列，均可空且无缺省；存量库每一行的原有列值与行数不变、三个新列读作 NULL；`PRAGMA foreign_key_check` 为空；再次打开目录不变

#### Scenario: 列约束
- **WHEN** 分别把 `approval_mode` 写为 `always-ask`、`write`、`yolo`、NULL，以及 `Write`、`auto`、`''`；把 `reasoning_effort` 写为八个合法取值之一与 NULL，以及 `ultra`、`High`、`''`；把 `model_id` 写为任意非空文本与 NULL
- **THEN** 合法取值全部写入；`approval_mode` 与 `reasoning_effort` 的非法取值被 SQLite 拒绝；`model_id` 的任意文本被接受

#### Scenario: 中途失败原子回滚
- **WHEN** 在一份一次性副本里预置冲突对象（已存在的 `chat_sessions.approval_mode` 列）使 `040` 中途失败，随后移除冲突对象重试
- **THEN** 失败时没有任何 `040` 的列或回执留下，此前的回执与数据不变；重试时 `040` 恰应用一次

### Requirement: 迁移 041 账号最近选择表
迁移 `041_account_composer_prefs.sql` SHALL 在既有 runner 持有的事务内原子建立表 `account_composer_prefs`：`account_id TEXT NOT NULL PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE`；`approval_mode TEXT NULL` 与 `reasoning_effort TEXT NULL`，各带与迁移 040 同名列相同的 CHECK；`model_id TEXT NULL`；
`updated_at INTEGER NOT NULL CHECK (typeof(updated_at)='integer' AND updated_at >= 0)`（epoch 毫秒）。回执紧随 `040` 之后；不使用 `IF NOT EXISTS`；更早的迁移文件 SHALL NOT 被编辑；受信任迁移目录计数断言 SHALL 随之加一。每个账号至多一行；没有行表示该账号从未做过选择。

#### Scenario: 建表与约束
- **WHEN** `openDb` 打开新库与存量库，随后写入一行合法数据、对同一 `account_id` 再插入一行、写入非法的 `approval_mode` / `reasoning_effort` / 负的 `updated_at`、引用不存在的账号
- **THEN** 表存在且回执 `041` 紧随 `040`；合法行写入；重复主键、非法取值与不存在的账号均被 SQLite 拒绝；存量库的其它表数据不变

#### Scenario: 随账号级联
- **WHEN** 测试里删除一个在该表有行、且没有被审计行引用的账号
- **THEN** 该账号的 `account_composer_prefs` 行随之删除，其它账号的行不变

### Requirement: 有效值解析
服务端 SHALL 以一个不读库、不读环境的纯函数，从「三个原始值（各可为 null）」与「当前配置（`APPROVAL_MAX_MODE`、模型白名单）」算出会话输入框设置的有效值 `{approvalMode, modelId, reasoningEffort}`；会话视图、`GET /api/composer/options` 的 `defaults`、spawn 参数与派发前的 RPC SHALL 全部使用它的结果，不得各自另算：

- `approvalMode`：档位按 `always-ask < write < yolo` 排序；取原始值（null 时取 `write`）与 `APPROVAL_MAX_MODE` 二者中较小的一个。
- `modelId`：原始值是白名单里某一项的 `id` 时取它，否则（null、或已不在白名单）取缺省模型的 `id`（model-selection「模型白名单配置」）。
- `reasoningEffort`：上一步得到的模型不支持推理时为 `null`；支持时，原始值在该模型的可选强度（model-selection「推理强度集合」）内则取它，否则取该模型的缺省强度。

该函数 SHALL NOT 改写任何存储值：配置变化（调低最高档、从白名单移除模型）只改变之后读到的有效值；配置恢复后原始选择重新生效。

#### Scenario: 夹取与回落
- **WHEN** 白名单为 `[{id:"m1",reasoning:true},{id:"m2",reasoning:false},{id:"m3",reasoning:true,efforts:["low","high"]}]`、缺省模型 `m1`，分别以下列原始值与最高档求有效值：`(null,null,null)` / `yolo`；`("yolo","m3","xhigh")` / `write`；`("write","gone","medium")` / `yolo`；`("always-ask","m2","high")` / `yolo`；`("write","m3","low")` / `always-ask`；`("yolo","m1","auto")` / `yolo`
- **THEN** 结果依次为 `{write,m1,high}`、`{write,m3,high}`（`xhigh` 不在 `m3` 的可选强度内，回落到其缺省 `high`）、`{write,m1,medium}`、`{always-ask,m2,null}`、`{always-ask,m3,low}`、`{yolo,m1,auto}`；函数不产生任何写入

### Requirement: 创建会话时的设置与继承
`POST /api/sessions` 的 body SHALL 可选携带 `approvalMode`、`modelId`、`reasoningEffort` 三键（键集与其余形状规则见 session-metadata「会话创建与空间绑定」）。校验 SHALL 在任何写入之前完成，任一不合法即 400 `bad_request`、不写会话行、不写审计、不改账号最近选择：

- `approvalMode` SHALL 是 `always-ask` / `write` / `yolo` 之一，且不高于 `APPROVAL_MAX_MODE`。
- `modelId` SHALL 是白名单里某一项的 `id`（字符串精确相等）。
- `reasoningEffort` SHALL 是字符串，且在「本次创建所得模型」的可选强度内；该模型取 body 的 `modelId`，body 未给时取该账号最近选择经「有效值解析」得到的模型。模型不支持推理时任何 `reasoningEffort` 都不合法；`null` 不是合法取值。

合法请求 SHALL 在创建会话行的同一个 SQLite 事务内：把三列分别写为 body 给出的值，未给出的键取该账号 `account_composer_prefs` 行的同名原始列值（没有行或该列为 NULL 则写 NULL）；对 body 给出的每一个键，把该值写入 `account_composer_prefs` 的同名列并更新 `updated_at`（没有行则插入，未给出的列保持原值或 NULL）；按 session-permission-tier「档位变更审计」写创建时的审计。
返回的会话视图 SHALL 带这三键的有效值。未携带这三键的创建 SHALL NOT 改动 `account_composer_prefs`。

#### Scenario: 缺省与显式
- **WHEN** 一个从未做过选择的账号以无 body 创建会话；随后以 `{approvalMode:"always-ask", modelId:"m3", reasoningEffort:"low"}` 创建第二个会话（白名单同「有效值解析」的场景，`APPROVAL_MAX_MODE` 未设置）
- **THEN** 第一次 201 的视图 `approvalMode="write"`、`modelId="m1"`、`reasoningEffort="high"`，会话行三列为 NULL，`account_composer_prefs` 没有该账号的行；第二次 201 的视图三键为 `always-ask`、`m3`、`low`，会话行三列为这三个值，该账号的最近选择行为同样三个值

#### Scenario: 新会话沿用最近选择
- **WHEN** 上一场景之后同一账号再以无 body 创建第三个会话；另一个账号也以无 body 创建会话
- **THEN** 第三个会话的视图三键为 `always-ask`、`m3`、`low`，其行三列为这三个值；另一个账号的会话视图为 `write`、`m1`、`high`

#### Scenario: 非法取值
- **WHEN** `APPROVAL_MAX_MODE=write` 时以 `{approvalMode:"yolo"}` 创建；以及任意配置下以 `{approvalMode:"Write"}`、`{approvalMode:null}`、`{modelId:"nope"}`、`{modelId:1}`、`{modelId:"m2", reasoningEffort:"high"}`、`{modelId:"m3", reasoningEffort:"xhigh"}`、`{reasoningEffort:null}` 创建
- **THEN** 均为 400 `bad_request` 与 no-store；没有新的会话行与审计行；`account_composer_prefs` 不变

### Requirement: 修改会话设置
`PATCH /api/sessions/:id` 的 body SHALL 可携带 `approvalMode`、`modelId`、`reasoningEffort`（与 `title`、`scene`、`pinned`、`archived` 同属一个键集，鉴权、owner 预检、整体校验与 UPDATE 规则见 session-metadata「会话元数据修改」）。三键的取值规则与「创建会话时的设置与继承」相同，其中 `reasoningEffort` 所对的模型取 body 的 `modelId`，body 未给时取该会话当前的有效模型。
合法请求 SHALL 在同一个 SQLite 事务内：把给出的键写入会话行的同名列（原始值）；把这些键写入该账号 `account_composer_prefs` 的同名列并更新 `updated_at`；按 session-permission-tier「档位变更审计」在有效档位实际变化时写审计。只给 `modelId` 时 SHALL NOT 改动 `reasoning_effort` 列（新模型下的有效强度由解析得出）。
会话处于任何状态（含 `running`、控制占用被持有）时都可修改；修改 SHALL NOT 调用 supervisor、不向 omp 发任何帧、不改 `updated_at` / `status` / `stream_epoch`：新值在下一次派发时才被读取（chat-sessions「派发前按会话设置对齐进程」）。响应的会话视图 SHALL 带修改后的有效值。

#### Scenario: 修改并回显有效值
- **WHEN** owner 对一个三列均为 NULL 的 `done` 会话依次 PATCH `{approvalMode:"yolo"}`、`{modelId:"m3"}`、`{reasoningEffort:"low"}`、`{modelId:"m2"}`、`{modelId:"m1"}`（白名单同上，最高档未限制）
- **THEN** 各返回 200；视图依次为 `{yolo,m1,high}`、`{yolo,m3,high}`、`{yolo,m3,low}`、`{yolo,m2,null}`、`{yolo,m1,low}`（`reasoning_effort` 列一直是 `low`，回到支持它的模型后重新生效）；全程 `updatedAt`、`status` 不变；该账号最近选择行最终为 `yolo`、`m1`、`low`

#### Scenario: 运行中修改不触及在途回合
- **WHEN** 会话 `running`（假 omp 的回合在途）时 owner PATCH `{approvalMode:"always-ask", modelId:"m3"}`
- **THEN** 200；假 omp 没有收到任何新帧，进程没有退出，回合照常结束；快照里会话视图为新值

#### Scenario: 非法取值与越过最高档
- **WHEN** `APPROVAL_MAX_MODE=write` 时 PATCH `{approvalMode:"yolo"}`；以及 PATCH `{modelId:"nope"}`、`{reasoningEffort:"xhigh"}`（当前有效模型为 `m3`）、`{reasoningEffort:"high"}`（当前有效模型为 `m2`）、`{modelId:"m2", reasoningEffort:"off"}`、`{title:"好", approvalMode:"x"}`
- **THEN** 均为 400 `bad_request`，会话行各列（含 `title`）不变，`account_composer_prefs` 与审计不变

#### Scenario: 隔离
- **WHEN** 第二个账号对第一个账号的会话 PATCH `{approvalMode:"yolo"}`，以及对不存在的会话 id 做同样请求
- **THEN** 两者均为逐字相同的 404 `not_found`，先于 body 解析；会话行、第二个账号的最近选择与审计都不变

### Requirement: 输入框选项端点
sessions 模块 SHALL 注册 `GET /api/composer/options`，受既有 cookie guard 保护（未认证 401），响应 `Cache-Control: no-store`；它不读取任何会话，不接受查询参数。200 的 body SHALL 恰含四个键：

- `approvalModes`：按 `always-ask`、`write`、`yolo` 的次序列出不高于 `APPROVAL_MAX_MODE` 的档位（至少一项）。
- `models`：按白名单次序，每项恰为 `{id, name, reasoning, vision, efforts, defaultEffort}`；`efforts` 是该模型的可选强度（不支持推理时为 `[]`），`defaultEffort` 是其缺省强度（不支持推理时为 `null`）。
- `defaults`：`{approvalMode, modelId, reasoningEffort}`，为请求账号 `account_composer_prefs` 行（没有则三者为 null）经「有效值解析」得到的值。
- `upload`：`{maxBytes, maxFiles}`，即 `UPLOAD_MAX_BYTES` 与 `UPLOAD_MAX_FILES` 的生效值。

响应 SHALL NOT 含上游地址、密钥或任何其它配置。

#### Scenario: 缺省配置
- **WHEN** 四个新环境变量与 `MODEL_CATALOG` 都未设置、`MODEL_ID` 与 `MODEL_REASONING` 取缺省，一个从未做过选择的账号请求该端点
- **THEN** 200 且 body 恰为 `{approvalModes:["always-ask","write","yolo"], models:[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:false, efforts:["off","minimal","low","medium","high","xhigh","max","auto"], defaultEffort:"high"}], defaults:{approvalMode:"write", modelId:"deepseek-v4.1-flash", reasoningEffort:"high"}, upload:{maxBytes:524288000, maxFiles:10}}`，带 no-store

#### Scenario: 封顶、白名单与账号各自的缺省
- **WHEN** `APPROVAL_MAX_MODE=write`、白名单为前述三项、`UPLOAD_MAX_BYTES=1048576`、`UPLOAD_MAX_FILES=3`；账号甲的最近选择为 `yolo`、`m3`、`low`，账号乙没有最近选择；两个账号各请求一次；匿名请求一次
- **THEN** 两个账号的 `approvalModes` 都是 `["always-ask","write"]`，`models` 恰三项且 `m2` 的 `efforts` 为 `[]`、`defaultEffort` 为 `null`，`m3` 的 `efforts` 为 `["off","low","high","auto"]`；甲的 `defaults` 为 `{write,m3,low}`，乙的为 `{write,m1,high}`；`upload` 为 `{maxBytes:1048576, maxFiles:3}`；匿名请求 401
