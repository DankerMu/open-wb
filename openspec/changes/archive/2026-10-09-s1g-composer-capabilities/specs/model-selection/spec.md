## ADDED Requirements

### Requirement: 模型白名单配置
服务端 SHALL 持有一份启动时确定、此后不变的模型白名单：一个有序的模型列表与其中一个缺省模型。每个模型为 `{id, name, reasoning, vision, efforts?}`：`id` 是发给上游的模型名（也是托管 `models.yml` 条目的 `id`）；`name` 是界面显示名；`reasoning` 表示支持推理；`vision` 表示支持看图；`efforts` 是该模型支持的推理强度子集（推理模型必带，`MODEL_CATALOG` 未设置时的那一项除外；`reasoning` 不为真的模型不带）。
白名单由 `agent-config.ts` 的同一个 resolver 从环境变量得出，全部校验 SHALL 先于任何文件系统、数据库或监听动作；配置错误 SHALL 使启动失败，错误信息只点名出错的键、不回显取值：

- `MODEL_CATALOG` **未设置**：白名单恰一项 `{id:<MODEL_ID 的生效值>, name:<同一个值>, reasoning:<MODEL_REASONING 的生效值>, vision:false}`，它就是缺省模型，不带 `efforts`。这是本 change 之前的单模型配置，行为不变。
- `MODEL_CATALOG` **已设置**：SHALL 是一个 JSON 文本，解析为含 1 到 32 个元素的数组；每个元素是对象，键集为 `{id, name, reasoning, vision, efforts}` 的子集且必须含 `id`。`id` 为 1 到 128 个 UTF-8 字节、不含 U+0000–U+001F 与 U+007F 的字符串，各项互不相同；`name` 为 1 到 64 个 Unicode 码点、不含同一组控制字符的字符串，缺省等于 `id`；`reasoning` 与 `vision` 为布尔，缺省 `false`；
  `reasoning` 为 `true` 的元素 SHALL 带 `efforts`，`reasoning` 不为 `true` 的元素 SHALL NOT 带它；`efforts` 为 `minimal`、`low`、`medium`、`high`、`xhigh`、`max` 的非空子集，元素不重复且按这一强度次序升序排列。空串、非 JSON、非数组、空数组、超过 32 项、多余键、类型不符、`id` 重复、`reasoning` 不为真却带 `efforts`、`reasoning` 为真却不带 `efforts`，均为启动失败并点名 `MODEL_CATALOG`。
  此时 `MODEL_ID` 若设置 SHALL 等于某一项的 `id`，该项为缺省模型，否则启动失败并点名 `MODEL_ID`；`MODEL_ID` 未设置时第一项为缺省模型。`MODEL_REASONING` SHALL NOT 与 `MODEL_CATALOG` 同时设置，同设即启动失败并点名 `MODEL_REASONING`。

白名单 SHALL 是界面可选模型的唯一来源（`GET /api/composer/options`）、会话设置校验与有效值解析的依据（session-composer-settings），以及托管 `models.yml` 的输入（model-proxy「托管 models.yml」）。所有白名单模型共用同一个上游（`MODEL_UPSTREAM_BASE_URL` / `MODEL_UPSTREAM_API_KEY`）；白名单同时是模型代理放行的 `model` 取值集合：请求体里的模型名不在白名单内的请求被代理拒绝、不到达上游，规则只由 model-proxy「透传端点与 bearer 鉴权」的 Model whitelist 一段规定，本条不复述。

#### Scenario: 未配置白名单等于单模型
- **WHEN** `MODEL_CATALOG` 未设置，分别以 `MODEL_ID`、`MODEL_REASONING` 均未设置，以及 `MODEL_ID=qwen-x`、`MODEL_REASONING=off` 解析配置
- **THEN** 前者白名单恰为 `[{id:"deepseek-v4.1-flash", name:"deepseek-v4.1-flash", reasoning:true, vision:false}]`；后者恰为 `[{id:"qwen-x", name:"qwen-x", reasoning:false, vision:false}]`；两者的缺省模型都是那唯一一项

#### Scenario: 多模型白名单与缺省模型
- **WHEN** `MODEL_CATALOG` 为 `[{"id":"m1","name":"通用","reasoning":true,"efforts":["minimal","low","medium","high","xhigh","max"]},{"id":"m2"},{"id":"m3","name":"深度","reasoning":true,"vision":true,"efforts":["low","high"]}]`，分别以 `MODEL_ID` 未设置与 `MODEL_ID=m3` 解析
- **THEN** 白名单为三项且次序不变，`m2` 的 `name` 为 `m2`、`reasoning` 与 `vision` 为 `false` 且不带 `efforts`，`m1` 与 `m3` 的 `efforts` 为所给的数组；缺省模型分别为 `m1` 与 `m3`

#### Scenario: 非法白名单使启动失败
- **WHEN** `MODEL_CATALOG` 分别为空串、`not json`、`{}`、`[]`、含 33 项的数组、`[{"name":"x"}]`、`[{"id":""}]`、`[{"id":"a"},{"id":"a"}]`、`[{"id":"a","extra":1}]`、`[{"id":"a","reasoning":"yes"}]`、`[{"id":"a","reasoning":true}]`、`[{"id":"a","efforts":["low"]}]`、`[{"id":"a","reasoning":true,"efforts":[]}]`、`[{"id":"a","reasoning":true,"efforts":["high","low"]}]`、`[{"id":"a","reasoning":true,"efforts":["ultra"]}]`、`[{"id":"a","reasoning":true,"efforts":["auto"]}]`
- **THEN** 每一个都在任何文件系统、数据库或监听动作之前启动失败，错误信息含 `MODEL_CATALOG` 而不含所给取值
- **WHEN** `MODEL_CATALOG` 合法而 `MODEL_ID=other`（不在其中）；另一例 `MODEL_CATALOG` 合法且同时设置了 `MODEL_REASONING=on`
- **THEN** 分别启动失败并点名 `MODEL_ID` 与 `MODEL_REASONING`

### Requirement: 推理强度集合
推理强度的取值域 SHALL 是七个名字：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`（`auto` 不是合法取值），其中六个强度档的次序为 `minimal < low < medium < high < xhigh < max`。每个模型的**可选强度**与**缺省强度** SHALL 由下列规则从白名单得出，供界面列举与缺省强度的计算共用（一份实现）。可选强度只决定界面列出什么：服务端对 `reasoningEffort` 的校验与有效值解析 SHALL NOT 要求取值在该模型的可选强度内（session-composer-settings「创建会话时的设置与继承」「有效值解析」）——七个名字里的任何一个都原样经 `set_thinking_level` 交给 omp，由 omp 按该模型支持的强度就近取低：

- 模型不支持推理：可选强度为空，缺省强度为 `null`。
- 模型支持推理：可选强度依次为 `off`、该模型声明的 `efforts`；不带 `efforts` 的推理模型只有 `MODEL_CATALOG` 未设置时的那一项，它的可选强度为 `off` 加全部六档。缺省强度为 `high`（omp 的 `defaultThinkingLevel` 缺省值），前提是 `high` 在可选强度内；否则取声明的 `efforts` 中不高于 `high` 的最高一档；再没有则取声明的第一档。
- `MODEL_CATALOG` 未设置时的那一项不向 omp 声明强度集合（托管 `models.yml` 字节不变），omp 按模型 id 自行得出一个集合并静默夹取：官方二进制上 `deepseek-v4.1-flash` 得到 `[low, high, max]`，`minimal` 与 `medium` 被取成 `low`、`xhigh` 被取成 `high`（design「实机核对结果」）。因此这一项上界面显示的强度可能与 omp 实际使用的不同；要两者一致，管理员改用 `MODEL_CATALOG` 并给出 `efforts`。

界面名 SHALL 为：`off` → `关闭`、`minimal` → `极低`、`low` → `低`、`medium` → `中`、`high` → `高`、`xhigh` → `很高`、`max` → `最高`。
`set_thinking_level` 对每个取值的实际结果（含夹取）在真实 omp 上的表现由官方二进制对照用例记录并钉住（「模型与强度从下一条消息起生效」的真实 omp 场景）；升级 omp 时 SHALL 重跑。

#### Scenario: 可选强度与缺省强度
- **WHEN** 对 `{reasoning:false}`、`{reasoning:true}`（不带 `efforts`，即 `MODEL_CATALOG` 未设置时的那一项）、`{reasoning:true, efforts:["low","high"]}`、`{reasoning:true, efforts:["minimal","low"]}`、`{reasoning:true, efforts:["xhigh","max"]}` 求可选强度与缺省强度
- **THEN** 依次为 `[]` / `null`；`["off","minimal","low","medium","high","xhigh","max"]` / `high`；`["off","low","high"]` / `high`；`["off","minimal","low"]` / `low`；`["off","xhigh","max"]` / `xhigh`

### Requirement: 模型与强度从下一条消息起生效
会话的模型与推理强度被修改后（session-composer-settings「修改会话设置」），SHALL 从该会话下一次派发的回合起生效，SHALL NOT 影响正在进行的回合；会话的历史上下文照常保留。生效方式是派发前的 RPC（chat-sessions「派发前按会话设置对齐进程」，命令帧见 omp-runtime「模型与推理强度命令」）：

- 每个 generation 的第一次派发之前 SHALL 无条件发送 `set_model{provider:"workbuddy", modelId:<有效模型>}`；该模型支持推理时随后发送 `set_thinking_level{level:<有效强度>}`。不依赖 spawn 的 `--model` 与 `--resume` 恢复出的状态。
- 同一个 generation 之后的派发：有效模型与上次应用的不同才发 `set_model`；刚发过 `set_model`、或有效强度与上次应用的不同（且模型支持推理）才发 `set_thinking_level`。两者都未变时不发任何命令帧。
- 次序 SHALL 恒为先 `set_model` 后 `set_thinking_level`，两者都在该回合的 `prompt` 帧之前。模型不支持推理时 SHALL NOT 发送 `set_thinking_level`。
- 任一命令失败（应答 `success` 不为真、进程退出）SHALL 使这次派发以 `agent_unavailable` 失败，按派发前失败处理（prompt → 502 并补偿受理对；重新生成的对齐发生在 `get_branch_messages` 之前，失败为 502 且不改任何行——chat-sessions「派发前按会话设置对齐进程」）。

重新生成 SHALL 使用会话当前的设置（它走同一条派发路径）。分叉出的新会话继承源会话的设置（session-metadata「fork 继承会话元数据」），其第一次派发照常应用。消息 SHALL NOT 记录生成它所用的模型或强度：消息行、消息快照与事件里都没有这样的字段。

#### Scenario: 换模型与强度后的帧序
- **WHEN** 一个有效设置为 `{m1, high}` 的会话在假 omp 真子进程上完成第一个回合；owner PATCH `{modelId:"m3", reasoningEffort:"low"}` 后发第二条 prompt；不改设置再发第三条；PATCH `{reasoningEffort:"high"}` 后发第四条；PATCH `{modelId:"m2"}`（不支持推理）后发第五条；最后发一条 probe prompt
- **THEN** 假 omp 的入站帧记录恰为 `negotiate_protocol,get_state,set_model,set_thinking_level,prompt,set_model,set_thinking_level,prompt,prompt,set_thinking_level,prompt,set_model,prompt,prompt`（最后一个 `prompt` 是 probe）；五个回合由同一个进程处理（没有因模型或强度而重启）；每条 prompt 都返回 202

#### Scenario: 新进程重新应用
- **WHEN** 上述会话的进程被空闲回收后，owner 不改设置再发一条 prompt
- **THEN** 新进程在 `prompt` 之前收到 `set_model`（会话当前的有效模型不支持推理，所以没有 `set_thinking_level`）；若把模型改回 `m1` 再发，则依次收到 `set_model`、`set_thinking_level`、`prompt`

#### Scenario: 生成中修改不打断
- **WHEN** 回合在途时 owner PATCH `{modelId:"m3"}`
- **THEN** 假 omp 在该回合结束前没有收到 `set_model`；回合照常结束；下一条 prompt 之前收到它

#### Scenario: 命令失败按派发前失败处理
- **WHEN** 假 omp 对 `set_model` 应答失败（其文档化的失败模型 id），owner 在一个 `done` 会话上发 prompt
- **THEN** 响应为 502 `agent_unavailable`；受理的用户 / 助手消息对被移除，会话状态与 `updatedAt` 复原；假 omp 没有收到 `prompt` 帧；之后把模型改为可用的再发 prompt 返回 202

#### Scenario: 真实 omp 上的模型与强度
- **WHEN** 官方 omp v18.0.10 读取含两个模型的托管 `models.yml`，宿主在回合之间发 `set_model` 切到第二个模型，再依次对 `off`、六个强度档与 `auto` 发 `set_thinking_level`（`auto` 只为记录 omp 的行为，它不在取值域内），每次之后发 `get_state`；随后跑一个回合；整个用例从一个新会话的第一个回合开始，含一个工具轮，并在换模型后的回合结束之后、历史已超出压缩保留区的前提下（手段见 tasks 1.4：cwd 的 `.omp/config.yml` 把 `compaction.keepRecentTokens` 设为 1、把 `compaction.methodOrder` 钉为 `[soft]`——只有 `soft` 方法一定向上游发请求；`keepRecentTokens` 不生效时改用一条长用户消息，方法次序的预置保留）发恰一个 `/compact` 回合；另以 `--resume` 重启同一会话后不发命令直接 `get_state`
- **THEN** `set_model` 之后 `get_state.model` 的 `provider` 与 `id` 为第二个模型；没有一次 `set_thinking_level` 被拒绝，每次之后的 `get_state.thinkingLevel` 与对照用例记录的期望表逐项相等（该表在 tasks 1.4 首次运行时按实测填入并冻结，记的是 omp 实际报出的值——不在该模型强度集合内的取值被就近取低，不要求与所发的取值相同）；该回合受控上游收到的请求体 `model` 为第二个模型的 `id` 且消息历史含此前回合的内容；整个用例里受控上游记录到的每一个请求（含工具轮、`/compact` 回合，以及 omp 在这些步骤里自己发起的任何请求——压缩、`modelRoles` 的 `smol` / `slow` 等角色、`--no-title` 下本不应出现的标题生成，以请求记录为准：记录到的全部 `model` 值都须在白名单内）的 `model` 都是托管 `models.yml` 里的 id（omp-test-harness「受控上游请求记录」），即都在白名单内；`/compact` 回合使受控上游的请求记录至少新增一条，且该回合的 `command_output` 文本不含 `Nothing to compact`，也不含 `Already compacted`——这一步零新增请求时本场景不成立；托管 `HOME` 下的全局配置文件在这些命令前后逐字节不变；重启后的 `get_state` 结果记入同一张表（它只用于说明「每个 generation 无条件应用」是否必要，不改变本条的规则）

#### Scenario: 消息不带模型
- **WHEN** 在两个不同模型下各完成一个回合后读取消息快照
- **THEN** 每条消息的键集恰为 chat-sessions「会话 REST」所列，没有任何表示模型或强度的键；`chat_messages` 没有这样的列

### Requirement: 模型与推理强度控件
输入框能力行右组（chat-web「输入框与能力栏」）SHALL 依次渲染模型控件与推理强度控件，位于 `web/src/features/chat/` 的应用层文件内，由拷入层的 dropdown-menu 组合而成，不修改拷入文件。

**模型控件**：触发按钮的文字为当前模型的 `name`，可访问名为 `模型：<name>`；名字过长时在按钮内截断，完整名字在 `title` 属性里。菜单是一个单选组，按 `options.models` 的次序列出全部模型，每项为 `menuitemradio`，显示 `name`，并在 `reasoning` 为真时带标签 `推理`、`vision` 为真时带标签 `看图`；当前模型 `aria-checked="true"`。会话视图的 `modelId` 不在 `options.models` 里时（两次请求之间配置变了）按钮文字退为该 `modelId` 原文。
**推理强度控件**：仅当当前模型 `reasoning` 为真时渲染；触发按钮的文字为当前强度的界面名（model-selection「推理强度集合」），可访问名为 `推理强度：<界面名>`。菜单是一个单选组，按当前模型的 `efforts` 次序列出，每项显示界面名，与当前强度相同的一项 `aria-checked="true"`。当前强度不在当前模型的 `efforts` 里时（服务端不按可选强度校验，它仍是七个名字之一）触发按钮照常显示它的界面名，菜单里没有任何一项被选中。当前模型不支持推理时 SHALL NOT 渲染该控件，也不摆禁用占位。
**提交**：选中当前值只关闭菜单。已选会话时分别恰调用一次 `patchSession(sessionId, {modelId})` 或 `patchSession(sessionId, {reasoningEffort})`，在途期间两个控件都禁用，成功后两个控件都以响应的会话视图为准（换模型后强度可能随之变化或消失）；失败时在输入框上就地显示 `ApiError` 的 message，显示值保持服务端原值。
欢迎态：选择只更新页面内存里的值（初值为 `options.defaults`）；换模型时强度按新模型重算——原强度在新模型的 `efforts` 里则保留，否则取其 `defaultEffort`，新模型不支持推理则无强度；首次发送的创建请求只带用户在欢迎态实际选过的东西：选过模型 → 带 `modelId`，并在该模型支持推理时带上此刻显示的 `reasoningEffort`（换模型后强度已按上面的规则重算，所见即所发）；只选过强度 → 只带 `reasoningEffort`；两者都没碰 → 两个键都不带，由服务端按最近选择继承（`defaults` 是解析后的有效值，原样发回会覆盖账号存着的原始选择）。
**可用性**：两个控件 SHALL NOT 因输入框锁定而禁用（生成中可改）；只在自己的提交在途时禁用。`options` 未取得时两个控件都不渲染。两个控件都没有「下一条消息起生效」之外的即时效果：选择之后正在生成的回答不变。

#### Scenario: 切换模型与强度
- **WHEN** `options.models` 为 `m1`（`通用`，推理）、`m2`（`m2`，不支持推理）、`m3`（`深度`，推理 + 看图，`efforts` 为 `off`、`low`、`high`）；已选会话视图为 `{modelId:"m1", reasoningEffort:"high"}`；用户打开模型菜单选 `深度`（服务端返回 `{m3, high}`），再打开强度菜单选 `低`（返回 `{m3, low}`），再选模型 `m2`（返回 `{m2, null}`）
- **THEN** 初始按钮为 `模型：通用` 与 `推理强度：高`；模型菜单恰三项，`通用` 带 `推理`，`深度` 带 `推理` 与 `看图`，`m2` 无标签；三次选择各恰一次 `patchSession`，body 依次为 `{modelId:"m3"}`、`{reasoningEffort:"low"}`、`{modelId:"m2"}`；`深度` 下强度菜单恰三项 `关闭`、`低`、`高`；最后按钮为 `模型：m2`，页面上没有推理强度控件
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
- **THEN** 选择过程中没有任何请求；选 `深度` 后强度显示为 `高`（`xhigh` 不在其 `efforts` 内，取 `defaultEffort`）；选 `m2` 后没有强度控件；选回 `通用` 后强度为其 `defaultEffort`；`createSession` 的 input 含 `modelId:"m1"` 与 `reasoningEffort:"high"`
- **WHEN** 另一例欢迎态只把强度从 `很高` 改为 `低` 后发送；再一例不碰两个控件直接发送
- **THEN** 前者的 input 含 `reasoningEffort:"low"` 而不含 `modelId`；后者两个键都不含

#### Scenario: 长名字与选项缺失
- **WHEN** 当前模型的 `name` 为 64 个码点；另一例会话视图的 `modelId` 不在 `options.models` 里；再一例 `getComposerOptions` 失败
- **THEN** 第一例按钮的 `title` 为完整名字，按钮带截断的样式声明，能力行没有把 `发送` 挤出其容器（结构断言，不作像素断言）；第二例按钮文字为该 `modelId` 原文、没有强度控件；第三例两个控件都不渲染
