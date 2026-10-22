# model-selection Spec Delta

> s1d-model-registry：白名单的来源从启动配置改为注册表快照（model-registry）；六个 `MODEL_*` 键降为种子；每模型自带上游；推理模型可不带 `efforts`（NULL = 不声明）；模型菜单打开时重取 options。三条 requirement 逐字沿用主规格，有意改动只有：「模型白名单配置」的来源句、`efforts` 措辞、种子段、唯一来源段、POST-400 子句、空库子句与新场景；「推理强度集合」的两个 bullet 三句与补救句；「模型与推理强度控件」的括注「两次请求之间注册表变了」（原「配置变了」）、`invalidate()` 句、两处 THEN 增补与新场景。

## MODIFIED Requirements

### Requirement: 模型白名单配置
服务端 SHALL 持有一份模型白名单：一个有序的模型列表与其中一个缺省模型，来源是注册表快照（model-registry「注册表快照是白名单的唯一来源」），注册表写入后立即变化、不需要重启。每个模型为 `{id, name, reasoning, vision, maxTokens, efforts?}`：`id` 是发给上游的模型名（也是托管 `models.yml` 条目的 `id`）；`name` 是界面显示名；`reasoning` 表示支持推理；`vision` 表示支持看图；`maxTokens` 是该模型单次回复的输出上限（写进托管 `models.yml` 的 `maxTokens`，omp 以 `min(maxTokens, 64000)` 作普通回合上游请求的输出上限（64000 是 omp v18.0.10 的 OpenAI 系夹取值；字段按 omp 的 compat 推断，本托管 provider 发 `max_completion_tokens`；compaction、分支摘要等 omp 内部请求另设更小的上限）；owner 2026-10-18 裁决：按模型可配，缺省 32768）；`efforts` 是该模型支持的推理强度子集（`reasoning` 不为真的模型不带；推理模型可以不带——`MODEL_CATALOG` 未设置时的那一项与注册表里 `efforts` 列为 NULL 的行——此时不向 omp 声明强度集合，见「推理强度集合」）。
字段规则 SHALL 只有一份实现（`validateCatalogModel`），环境解析与注册表的 REST 写入共用（REST 的差异只有两处：`id` 以外都可省略取缺省，推理模型可不带 `efforts`——model-registry「模型管理端点」）。环境变量 `MODEL_CATALOG`、`MODEL_ID`、`MODEL_REASONING`、`MODEL_VISION` 仍由 `agent-config.ts` 的同一个 resolver 解析，全部校验 SHALL 先于任何文件系统、数据库或监听动作；配置错误 SHALL 使启动失败，错误信息只点名出错的键、不回显取值；但解析结果只作**种子**：表为空的首次启动把它写入注册表（model-registry「环境种子」），之后不再读它们：

- `MODEL_CATALOG` **未设置**：白名单恰一项 `{id:<MODEL_ID 的生效值>, name:<同一个值>, reasoning:<MODEL_REASONING 的生效值>, vision:<MODEL_VISION 的生效值>, maxTokens:32768}`，它就是缺省模型，不带 `efforts`。`MODEL_VISION` 取 `on`（缺省）或 `off`，映射为 `true`/`false`，其它取值（含空串）启动失败并点名 `MODEL_VISION`（owner 2026-10-18，#912：单模型配置可声明看图，缺省 `on`——当前模型 deepseek-v4.1-flash 能看图）。除 `maxTokens`（此前固定 8192）与 `vision`（此前固定 `false`）外与最初的单模型配置相同。
- `MODEL_CATALOG` **已设置**：SHALL 是一个 JSON 文本，解析为含 1 到 32 个元素的数组；每个元素是对象，键集为 `{id, name, reasoning, vision, maxTokens, efforts}` 的子集且必须含 `id`。`id` 为 1 到 128 个 UTF-8 字节、不含 U+0000–U+001F 与 U+007F 的字符串，各项互不相同；`name` 为 1 到 64 个 Unicode 码点、不含同一组控制字符的字符串，缺省等于 `id`；`reasoning` 与 `vision` 为布尔，缺省 `false`；`maxTokens` 为 1 到 128000 的整数（上限即托管 `models.yml` 对每个模型固定的 `contextWindow`），缺省 32768；
  `reasoning` 为 `true` 的元素 SHALL 带 `efforts`，`reasoning` 不为 `true` 的元素 SHALL NOT 带它；`efforts` 为 `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 的非空子集，元素不重复且按这一强度次序升序排列。空串、非 JSON、非数组、空数组、超过 32 项、多余键、类型不符、`id` 重复、`reasoning` 不为真却带 `efforts`、`reasoning` 为真却不带 `efforts`、`maxTokens` 不是整数或不在 1 到 128000 之内，均为启动失败并点名 `MODEL_CATALOG`。
  此时 `MODEL_ID` 若设置 SHALL 等于某一项的 `id`，该项为缺省模型，否则启动失败并点名 `MODEL_ID`；`MODEL_ID` 未设置时第一项为缺省模型。`MODEL_REASONING` SHALL NOT 与 `MODEL_CATALOG` 同时设置，同设即启动失败并点名 `MODEL_REASONING`；`MODEL_VISION` 同样 SHALL NOT 与 `MODEL_CATALOG` 同时设置，同设即启动失败并点名 `MODEL_VISION`。

白名单 SHALL 是界面可选模型的唯一来源（`GET /api/composer/options`；该端点的模型项 SHALL NOT 带 `maxTokens`——上限只进托管 `models.yml`）、会话设置校验与有效值解析的依据（session-composer-settings），以及托管 `models.yml` 的输入（model-proxy「托管 models.yml」）；白名单次序中第一个 `vision` 为真的模型是 omp 的看图角色（omp-runtime「宿主 overlay」的看图块），注册表写入后随发布重写。每个模型各自带（或不带）上游地址与密钥（model-registry「模型管理端点」；`MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY` 只在种子时给第一批行）；白名单同时是模型代理放行的 `model` 取值集合：请求体里的模型名不在白名单内的请求被代理拒绝、不到达上游，放行的请求转发到该模型自己的上游，规则只由 model-proxy「透传端点与 bearer 鉴权」的 Model whitelist 一段规定，本条不复述。

#### Scenario: 未配置白名单等于单模型
- **WHEN** `MODEL_CATALOG` 未设置，分别以 `MODEL_ID`、`MODEL_REASONING`、`MODEL_VISION` 均未设置，以 `MODEL_VISION=on`，以及 `MODEL_ID=qwen-x`、`MODEL_REASONING=off`、`MODEL_VISION=off` 解析配置
- **THEN** 前两者白名单恰为 `[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:true, maxTokens:32768}]`；后者恰为 `[{id:"qwen-x", name:"qwen-x", reasoning:false, vision:false, maxTokens:32768}]`；三者的缺省模型都是那唯一一项；在空库上启动时注册表恰含该项

#### Scenario: 多模型白名单与缺省模型
- **WHEN** `MODEL_CATALOG` 为 `[{"id":"m1","name":"通用","reasoning":true,"efforts":["minimal","low","medium","high","xhigh","max"]},{"id":"m2","maxTokens":8192},{"id":"m3","name":"深度","reasoning":true,"vision":true,"efforts":["low","high"]}]`，分别以 `MODEL_ID` 未设置与 `MODEL_ID=m3` 解析
- **THEN** 白名单为三项且次序不变，`m2` 的 `name` 为 `m2`、`reasoning` 与 `vision` 为 `false`、`maxTokens` 为 8192 且不带 `efforts`，`m1` 与 `m3` 的 `efforts` 为所给的数组、`maxTokens` 为 32768；缺省模型分别为 `m1` 与 `m3`

#### Scenario: 非法白名单使启动失败
- **WHEN** `MODEL_CATALOG` 分别为空串、`not json`、`{}`、`[]`、含 33 项的数组、`[{"name":"x"}]`、`[{"id":""}]`、`[{"id":"a"},{"id":"a"}]`、`[{"id":"a","extra":1}]`、`[{"id":"a","reasoning":"yes"}]`、`[{"id":"a","reasoning":true}]`、`[{"id":"a","efforts":["low"]}]`、`[{"id":"a","reasoning":true,"efforts":[]}]`、`[{"id":"a","reasoning":true,"efforts":["high","low"]}]`、`[{"id":"a","reasoning":true,"efforts":["ultra"]}]`、`[{"id":"a","reasoning":true,"efforts":["auto"]}]`、`[{"id":"a","maxTokens":0}]`、`[{"id":"a","maxTokens":128001}]`、`[{"id":"a","maxTokens":1.5}]`、`[{"id":"a","maxTokens":"32768"}]`、`[{"id":"a","maxTokens":null}]`、`[{"id":"a","maxTokens":-1}]`
- **THEN** 每一个都在任何文件系统、数据库或监听动作之前启动失败，错误信息含 `MODEL_CATALOG` 而不含所给取值；同一组输入里的单项（去掉数组层与计数类的例子，`[{"id":"a","reasoning":true}]` 除外——REST 允许推理模型不带 `efforts`）作为 `POST /api/models` 的 body 时各为 400 `bad_request`
- **WHEN** `MODEL_CATALOG` 合法而 `MODEL_ID=other`（不在其中）；另一例 `MODEL_CATALOG` 合法且同时设置了 `MODEL_REASONING=on`；另一例 `MODEL_CATALOG` 合法且同时设置了 `MODEL_VISION=on`
- **THEN** 分别启动失败并点名 `MODEL_ID`、`MODEL_REASONING` 与 `MODEL_VISION`
- **WHEN** `MODEL_CATALOG` 未设置，`MODEL_VISION` 分别为空串、`yes`、`ON`、`true`
- **THEN** 每一个都在任何文件系统、数据库或监听动作之前启动失败，错误信息含 `MODEL_VISION` 而不含所给取值
- **WHEN** `MODEL_CATALOG` 分别为 `[{"id":"a","maxTokens":1}]` 与 `[{"id":"a","maxTokens":128000}]`
- **THEN** 两者都解析成功，白名单恰一项，`maxTokens` 分别为 1 与 128000（边界值包含在内）

#### Scenario: 注册表写入后白名单变化
- **WHEN** 种子为单模型的服务上，管理员登记 `m2`（推理，`efforts` low/high）并设为缺省
- **THEN** 白名单变为两项、缺省为 `m2`，`GET /api/composer/options` 的 `models` 立即含 `m2`，托管 `models.yml` 含 `m2` 条目；没有重启

### Requirement: 推理强度集合
推理强度的取值域 SHALL 是七个名字：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（`auto` 不是合法取值），其中六个强度档的次序为 `minimal < low < medium < high < xhigh < max`。每个模型的**可选强度**与**缺省强度** SHALL 由下列规则从白名单得出，供界面列举与缺省强度的计算共用（一份实现）。可选强度只决定界面列出什么：服务端对 `reasoningEffort` 的校验与有效值解析 SHALL NOT 要求取值在该模型的可选强度内（session-composer-settings「创建会话时的设置与继承」「有效值解析」）——七个名字里的任何一个都原样经 `set_thinking_level` 交给 omp，由 omp 按该模型支持的强度就近取低：

- 模型不支持推理：可选强度为空，缺省强度为 `null`。
- 模型支持推理：可选强度依次为 `off`、该模型声明的 `efforts`；不带 `efforts` 的推理模型（`MODEL_CATALOG` 未设置时的那一项，以及注册表里 `efforts` 列为 NULL 的行）的可选强度为 `off` 加全部六档。缺省强度为 `high`（omp 的 `defaultThinkingLevel` 缺省值），前提是 `high` 在可选强度内；否则取声明的 `efforts` 中不高于 `high` 的最高一档；再没有则取声明的第一档。
- 不带 `efforts` 的推理模型不向 omp 声明强度集合（托管 `models.yml` 字节不变），omp 按模型 id 自行得出一个集合并静默夹取：官方二进制上 `deepseek-v4.1-flash` 得到 `[low, high, max]`，`minimal` 与 `medium` 被取成 `low`、`xhigh` 被取成 `high`（design「实机核对结果」）。因此这一项上界面显示的强度可能与 omp 实际使用的不同；要两者一致，管理员在中心「模型」tab 给该模型勾选 `efforts`（model-registry「模型 tab」）。

界面名 SHALL 为：`off` → `关闭`、`minimal` → `极低`、`low` → `低`、`medium` → `中`、`high` → `高`、`xhigh` → `很高`、`max` → `最高`。
`set_thinking_level` 对每个取值的实际结果（含夹取）在真实 omp 上的表现由官方二进制对照用例记录并钉住（「模型与强度从下一条消息起生效」的真实 omp 场景）；升级 omp 时 SHALL 重跑。

#### Scenario: 可选强度与缺省强度
- **WHEN** 对 `{reasoning:false}`、`{reasoning:true}`（不带 `efforts`，即 `MODEL_CATALOG` 未设置时的那一项）、`{reasoning:true, efforts:["low","high"]}`、`{reasoning:true, efforts:["minimal","low"]}`、`{reasoning:true, efforts:["xhigh","max"]}` 求可选强度与缺省强度
- **THEN** 依次为 `[]` / `null`；`["off","minimal","low","medium","high","xhigh","max"]` / `high`；`["off","low","high"]` / `high`；`["off","minimal","low"]` / `low`；`["off","xhigh","max"]` / `xhigh`

### Requirement: 模型与推理强度控件
输入框能力行右组（chat-web「输入框与能力栏」）SHALL 依次渲染模型控件与推理强度控件，位于 `web/src/features/chat/` 的应用层文件内，由拷入层的 dropdown-menu 组合而成，不修改拷入文件。

**模型控件**：触发按钮的文字为当前模型的 `name`，可访问名为 `模型：<name>`；名字过长时在按钮内截断，完整名字在 `title` 属性里。菜单是一个单选组，按 `options.models` 的次序列出全部模型，每项为 `menuitemradio`，显示 `name`，并在 `reasoning` 为真时带标签 `推理`、`vision` 为真时带标签 `看图`；当前模型 `aria-checked="true"`。会话视图的 `modelId` 不在 `options.models` 里时（两次请求之间注册表变了）按钮文字退为该 `modelId` 原文。**模型菜单每次打开时 SHALL 恰调用一次 `invalidate()`**（chat-web「输入框与能力栏」的同一重取入口）再取一次 `GET /api/composer/options`；重取在途与失败期间菜单显示上一份，落地后更新、菜单不关闭。强度菜单打开不重取。
**推理强度控件**：仅当当前模型 `reasoning` 为真时渲染；触发按钮的文字为当前强度的界面名（model-selection「推理强度集合」），可访问名为 `推理强度：<界面名>`。菜单是一个单选组，按当前模型的 `efforts` 次序列出，每项显示界面名，与当前强度相同的一项 `aria-checked="true"`。当前强度不在当前模型的 `efforts` 里时（服务端不按可选强度校验，它仍是七个名字之一）触发按钮照常显示它的界面名，菜单里没有任何一项被选中。当前模型不支持推理时 SHALL NOT 渲染该控件，也不摆禁用占位。
**提交**：选中当前值只关闭菜单。已选会话时分别恰调用一次 `patchSession(sessionId, {modelId})` 或 `patchSession(sessionId, {reasoningEffort})`，在途期间两个控件都禁用，成功后两个控件都以响应的会话视图为准（换模型后强度可能随之变化或消失）；失败时在输入框上就地显示 `ApiError` 的 message，显示值保持服务端原值。
欢迎态：选择只更新页面内存里的值（初值为 `options.defaults`）；换模型时强度按新模型重算——原强度在新模型的 `efforts` 里则保留，否则取其 `defaultEffort`，新模型不支持推理则无强度；首次发送的创建请求只带用户在欢迎态实际选过的东西：选过模型 → 带 `modelId`，并在该模型支持推理时带上此刻显示的 `reasoningEffort`（换模型后强度已按上面的规则重算，所见即所发）；只选过强度 → 只带 `reasoningEffort`；两者都没碰 → 两个键都不带，由服务端按最近选择继承（`defaults` 是解析后的有效值，原样发回会覆盖账号存着的原始选择）。
**可用性**：两个控件 SHALL NOT 因输入框锁定而禁用（生成中可改）；只在自己的提交在途时禁用。`options` 未取得时两个控件都不渲染。两个控件都没有「下一条消息起生效」之外的即时效果：选择之后正在生成的回答不变。

#### Scenario: 切换模型与强度
- **WHEN** `options.models` 为 `m1`（`通用`，推理）、`m2`（`m2`，不支持推理）、`m3`（`深度`，推理 + 看图，`efforts` 为 `off`、`low`、`high`）；已选会话视图为 `{modelId:"m1", reasoningEffort:"high"}`；用户打开模型菜单选 `深度`（服务端返回 `{m3, high}`），再打开强度菜单选 `低`（返回 `{m3, low}`），再选模型 `m2`（返回 `{m2, null}`）
- **THEN** 初始按钮为 `模型：通用` 与 `推理强度：高`；模型菜单恰三项，`通用` 带 `推理`，`深度` 带 `推理` 与 `看图`，`m2` 无标签；三次选择各恰一次 `patchSession`，body 依次为 `{modelId:"m3"}`、`{reasoningEffort:"low"}`、`{modelId:"m2"}`；`深度` 下强度菜单恰三项 `关闭`、`低`、`高`；最后按钮为 `模型：m2`，页面上没有推理强度控件；模型菜单的两次打开各恰一次 `invalidate()`，强度菜单打开时没有
- **WHEN** 另一例已选会话视图为 `{modelId:"m3", reasoningEffort:"xhigh"}`（不在 `深度` 的 `efforts` 里），用户打开强度菜单
- **THEN** 按钮为 `推理强度：很高`；菜单恰三项 `关闭`、`低`、`高`，没有任何一项 `aria-checked="true"`

#### Scenario: 生成中可改且不影响在途回合
- **WHEN** 回合进行中打开模型菜单并选择另一个模型
- **THEN** 控件可操作，恰一次 `patchSession`；没有发出 prompt、stop、regenerate；`生成中` 与 `停止` 保持

#### Scenario: 失败回退
- **WHEN** 选择模型时 `patchSession` 返回 400 信封；另一例因网络异常失败
- **THEN** 输入框上分别显示信封文案与 request_failed 的安全文案；模型与强度按钮的文字保持选择前的值；控件恢复可用

#### Scenario: 欢迎态的选择
- **WHEN** 欢迎态 `options.defaults` 为 `{modelId:"m1", reasoningEffort:"xhigh"}`，用户先选模型 `深度`，再选模型 `m2`，再选回 `通用`，然后发送
- **THEN** 选择过程中除模型菜单打开引发的 `getComposerOptions` 外没有任何请求；选 `深度` 后强度显示为 `高`（`xhigh` 不在其 `efforts` 内，取 `defaultEffort`）；选 `m2` 后没有强度控件；选回 `通用` 后强度为其 `defaultEffort`；`createSession` 的 input 含 `modelId:"m1"` 与 `reasoningEffort:"high"`
- **WHEN** 另一例欢迎态只把强度从 `很高` 改为 `低` 后发送；再一例不碰两个控件直接发送
- **THEN** 前者的 input 含 `reasoningEffort:"low"` 而不含 `modelId`；后者两个键都不含

#### Scenario: 长名字与选项缺失
- **WHEN** 当前模型的 `name` 为 64 个码点；另一例会话视图的 `modelId` 不在 `options.models` 里；再一例 `getComposerOptions` 失败
- **THEN** 第一例按钮的 `title` 为完整名字，按钮带截断的样式声明，能力行没有把 `发送` 挤出其容器（结构断言，不作像素断言）；第二例按钮文字为该 `modelId` 原文、没有强度控件；第三例两个控件都不渲染

#### Scenario: 打开菜单看到新登记的模型
- **WHEN** 第一次取得的 `options.models` 只有 `m1`，之后 `getComposerOptions` 改为返回 `m1`、`m2`，用户打开模型菜单
- **THEN** 打开瞬间菜单为一项，重取落地后菜单为两项且不关闭；`getComposerOptions` 共被调用两次
