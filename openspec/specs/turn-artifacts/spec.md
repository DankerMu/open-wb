# turn-artifacts Specification

## Purpose
定义「这一轮改了哪些文件」的端到端契约：从 omp `edit`/`write` 工具结束帧的 `details` 推导候选变更，在绑定工作空间根内做 realpath 归属判定与相对化，`chat_steps.changes` 持久化与 `files.changed` 事件，快照步骤 `changes`，以及 web 的文件变更卡与按扩展名派生的产物卡（HTML、图片、代码）；两种卡片的定位动作打开工作空间侧边栏（workspace-sidebar）。纯归约器侧映射见 chat-stream `纯协议事件归约`，web DTO/事件解析见 chat-web；本 spec 拥有推导、归属、上限、持久化次序与呈现。

## Requirements

### Requirement: 文件变更推导与归属
纯归约器 SHALL 只对已知 running 调用的 `tool_execution_end` 推导候选变更，且仅当该调用在 `tool_execution_start` 登记的工具名 ∈ {`edit`, `write`, `browser`}（`browser` 是写到 `xd://browser` 的 `write` 调用登记的名字，chat-stream「纯协议事件归约」；`ast_edit` 的 details 无 `diff`/`path`/`perFileResults`，不在集合内；结束帧自带的 `toolName` 不参与判定）、帧与结果都未标记失败（`isError` 与 `result.isError` 均不为 `true`）、`result.details` 为普通对象时；读取 SHALL 不访问对象原型（只读自有属性）。
- `edit`：`details.perFileResults` 为非空数组时，对其中每个 `path` 为非空字符串且 `diff` 为字符串的元素各产生一个候选；否则 `details.path` 为非空字符串且 `details.diff` 为字符串时产生一个候选；两者皆不满足则不产生。候选 `kind:"edit"`，`added` 为该 diff 按 `\n` 切分后匹配 `^\+\d+\|` 的行数，`removed` 为匹配 `^-\d+\|` 的行数（omp 编号 diff 格式 `+N|text`/`-N|text`/` N|text`，上下文行与其它行不计）。
- `write`：`details.resolvedPath` 为非空字符串时产生一个候选 `{kind:"write", added:null, removed:null}`（omp write 帧无 diff，故无行数）；缺失则不产生。
- `browser`（#912，浏览器截图）：`details.xdev` 为普通对象且自有 `tool` 恰为 `"browser"`、`xdev.inner` 为普通对象、`inner.screenshots` 为数组时，其中每个自有 `dest` 为非空字符串的元素产生一个候选 `{path:<dest>, kind:"write", added:null, removed:null}`（omp v18.0.10 `tab.screenshot()` 记录的保存路径；宿主 overlay 的 `screenshotDir: screenshots` 使它是相对会话 `<CWD>` 的路径）；其它情形（`open`/`close`、没有截图的 `run`、`help` 模式）不产生。截图写到 `TMPDIR`、状态目录等空间外位置时由下面的归属判定丢弃。
有候选时，归约器 SHALL 在该调用的 `step.end` 之前、同一返回结果中紧邻输出一条 `files.changed{messageId, stepId:<toolCallId 字符串>, files:[{path:<details 中的原始路径>, added, removed, kind}]}`（候选按上述出现次序）；无候选时不输出。`bash`、`read`、`memory_edit` 及其它任何工具 SHALL 永不产生 `files.changed`（浏览器 `run` 脚本经页面下载等途径写出的文件同样不进入）：经 bash/heredoc/脚本等途径写入的文件不进入文件变更卡，这是明确的覆盖边界而非遗漏。
SessionSupervisor SHALL 在持久化前对候选做归属判定（归约器无 IO，此步属 supervisor）；归约器输出里的原始路径 SHALL NOT 出现在 SSE 或 `chat_steps.changes` 中：
1. 会话未绑定工作空间（`workspace_id` 为 NULL）→ 丢弃整条事件，不落库、不发布，该步骤 `changes` 保持 NULL；此时不做任何文件系统访问。事件的 `stepId` 不是本回合已登记的调用时同样丢弃。
2. 原始候选上限：一条事件的候选超过 100 个时，只判定派生次序中的前 100 个，其余丢弃且 SHALL NOT 为它们做任何文件系统访问（不记录被丢弃的数量）。路径解析：绝对路径原样使用；相对路径以该会话 omp 进程的 `--cwd`（即绑定空间根，见 session-metadata）为基准拼接；随后做词法规范化（折叠 `.`、`..`、重复与结尾的路径分隔符，等同 Node `path.resolve`），后续各步只使用规范化后的路径。规范化后的路径 UTF-8 编码超过 4096 字节或路径分量超过 128 个时 SHALL 直接丢弃该候选，不做任何文件系统访问（`realpath` 逐分量解析，代价随分量数平方增长；穿过空间内自指符号链接的超长路径解析结果很短，第 4 步的 1024 字节规则拦不住）。同一条事件内规范化后相同的路径 SHALL 只做一次第 3 步的文件系统判定，其余复用首次的第 3–4 步结果（判定为丢弃的同样复用）。
3. 取该路径的 realpath；路径不存在（`lstat` 无此条目，例如 edit 删除了文件）时取其父目录的 realpath 再拼接文件名，拼接出的位置上已有条目（`lstat` 有此条目或失败）则丢弃；路径存在但取不到 realpath（悬空符号链接、符号链接环、无权限）、父目录的 realpath 也取不到、或路径无法交给文件系统（含 NUL 字节、过长），则丢弃该候选。结果 SHALL 严格位于绑定空间根的 realpath 之内（以「根 realpath + 路径分隔符」为前缀；根自身、根外路径、与根同前缀的兄弟目录、经符号链接逃出根的路径一律丢弃）；空间根 SHALL 是规范路径：其 realpath 取不到或不等于它自身（根被换成符号链接、经符号链接到达）时丢弃整条事件。
4. 保存值为该 realpath 相对空间根 realpath、以 `/` 分隔的路径（经空间内符号链接到达空间内文件的候选保存的是其真实位置）；UTF-8 编码超过 1024 字节的丢弃。
5. 同一步骤内解析到同一相对路径的多个候选合并为一项，`added`/`removed` 求和（`kind:"write"` 的项保持 `null`），位置与 `kind` 取首次出现处。
6. 合并后超过 50 项时只保留派生次序中的前 50 项，其余丢弃，不记录被丢弃的数量（因第 2 步，这 50 项取自前 100 个原始候选）。单条事件的同步文件系统判定因此至多 100 个互不相同的路径，每个路径不超过 4096 字节、128 个分量。
7. 无候选幸存 → 不落库、不发布、不占 ring 序号。
取证分工：`±` 行数推导只由 fake-omp `edit-write` 场景驱动的服务端集成测试证明；真 omp 链路（ui-walk，受控假上游 `WORKBUDDY_WRITE` 标记，见 omp-test-harness `受控上游思考与写入标记`）只能证明 `write` 变更（`写入`、无行数）；浏览器截图候选由真实 omp + Chromium 的 browser-runtime「CI browser-image job」证明，服务端测试以帧常量驱动归约器与归属判定。
有幸存项时，supervisor SHALL 先提交该步骤行的 `chat_steps.changes`（JSON 数组文本，元素键恰为 `path`、`added`、`removed`、`kind` 且按此次序；只写入仍为 `running` 的步骤行，写不到恰一行即为失败），提交成功后以持久化步骤数字 id 发布 `files.changed{messageId, stepId:<数字步骤 id>, files}`（`files` 与该列解析后等值），随后才落库并发布该调用的 `step.end`（`step.end` 的落库不读写 `changes`）；落库失败 SHALL 不发布该事件并沿既有 owned error-sink 路径处理，ring 序号不因失败发布而推进。`files.changed` SHALL 是普通 ring 事件（正常 `<epoch>:<seq>`、保留、`min−1` 回放、`replay.gap` 与活跃 turn.start 刷新规则，SSE `event:files.changed`）。消息快照中每个步骤 SHALL 带 `changes: {path, added, removed, kind}[] | null`：无变更的步骤（含全部非 edit/write/browser 步骤、未绑定会话的步骤与未收到工具结束帧即被结算的步骤）为 `null`，否则为该列解析后的数组（1..50 项，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`）。步骤随消息删除（regenerate、删会话）时一并删除。

#### Scenario: 归约器候选提取
- **WHEN** 已知 `edit` 调用成功结束，`details:{diff:"+3|a\n+4|b\n-3|x\n 2|ctx", path:"/ws/src/app.ts"}`；已知 `write` 调用成功结束，`details:{resolvedPath:"/ws/out/index.html"}`；另一已知 `edit` 调用的 `details.perFileResults` 为 `[{path:"a.md",diff:"+1|x"},{path:"",diff:"+1|y"},{path:"b.md",diff:7},{path:"c.md",diff:"-2|z"}]` 且顶层另有 `path`/`diff`
- **THEN** 三者的返回结果分别为 `files.changed` 紧接 `step.end`：`files` 依次为 `[{path:"/ws/src/app.ts",added:2,removed:1,kind:"edit"}]`、`[{path:"/ws/out/index.html",added:null,removed:null,kind:"write"}]`、`[{path:"a.md",added:1,removed:0,kind:"edit"},{path:"c.md",added:0,removed:1,kind:"edit"}]`；`stepId` 为各自 toolCallId；`step.end` output 不含 details

#### Scenario: 失败、非 edit/write 与原型键（归约器侧）
- **WHEN** `edit` 以帧 `isError:true` 结束；`edit` 以 `result.isError:true` 结束；`bash` 成功且 `details:{exitCode:0}`；`read` 成功且带 `details.resolvedPath`；以 `ast_edit` 登记的调用结束帧带 `details.path`+`diff`；`edit` 的 `details` 为数组，或其 `path`/`diff`/`perFileResults`/`resolvedPath` 只存在于原型上；未知 toolCallId 或重复的结束帧
- **THEN** 以上均不产生 `files.changed`；已知调用只输出其 `step.end`，未知与重复结束无任何事件

#### Scenario: edit 与 write 的推导
- **WHEN** 绑定空间根为 `<ws>` 的会话中，fake-omp `edit-write` 场景（omp-test-harness）发出 `edit` 结束帧 `details:{path:"<ws>/notes.md", diff:"+1|a\n+2|b\n-3|c\n 4|d"}` 与 `write` 结束帧 `details:{resolvedPath:"<ws>/out/report.html"}`
- **THEN** 两个步骤各自 ring 中 `files.changed` 紧先于其 `step.end`，payload 分别为 `{files:[{path:"notes.md",added:2,removed:1,kind:"edit"}]}` 与 `{files:[{path:"out/report.html",added:null,removed:null,kind:"write"}]}`，`stepId` 为数字步骤 id；快照中两步骤 `changes` 等值；SSE 与 `chat_steps.changes` 中不出现 `<ws>` 的绝对路径

#### Scenario: 多文件与重复路径
- **WHEN** 一次 `edit` 结束帧的 `perFileResults` 为 `[{path:"a.md",diff:"+1|x"},{path:"b.md",diff:"-2|y"},{path:"a.md",diff:"+5|z"}]`（相对路径）
- **THEN** 该步骤 `changes` 为 `[{path:"a.md",added:2,removed:0,kind:"edit"},{path:"b.md",added:0,removed:1,kind:"edit"}]`

#### Scenario: 空间外与符号链接逃逸
- **WHEN** 候选分别为 `/etc/passwd`、`../other/x.md`、空间根本身、与根同前缀的兄弟目录下的文件、空间内指向空间外的符号链接目录下的 `link/x.md`（存在与不存在各一）、空间内指向空间外的悬空符号链接本身（含带结尾分隔符的写法 `dangling/`）、符号链接环、以及经「目标含 `..` 的符号链接」到达的悬空符号链接与符号链接环，同一帧另有一个空间内合法路径
- **THEN** 只有合法路径进入 `changes` 与事件；若这些非法候选单独出现，则无事件、`changes` 为 `null`

#### Scenario: 不存在的文件按父目录判定
- **WHEN** 候选是空间内一个已存在目录下不存在的文件（例如被 edit 删除），另一个候选的父目录也不存在
- **THEN** 前者以「父目录 realpath + 文件名」进入 `changes`，后者被丢弃

#### Scenario: 空间根不是规范路径
- **WHEN** 交给归属判定的空间根路径本身是符号链接（例如根目录被移走后换成指向别处的链接），候选是该路径下的文件
- **THEN** 整条事件被丢弃，无事件、`changes` 为 `null`

#### Scenario: 未绑定会话
- **WHEN** 未绑定工作空间的会话中 `write` 成功写入所有者根下的文件
- **THEN** 无 `files.changed` 事件，步骤 `changes` 为 `null`，`step.end` 照常发布

#### Scenario: 进程工作目录在空间根外
- **WHEN** 绑定会话的 omp 进程实际在空间根之外的目录里执行 `edit-write`（候选是该目录下的绝对路径）
- **THEN** 无 `files.changed` 事件，两步 `changes` 为 `null`，`step.end` 照常发布

#### Scenario: 失败与非 edit/write 工具
- **WHEN** `edit` 以 `isError:true` 结束，`bash` 执行 `echo x > a.md` 成功，`read` 返回 `details.resolvedPath`
- **THEN** 三者都不产生 `files.changed`，`changes` 均为 `null`

#### Scenario: 上限
- **WHEN** 一次 `edit` 的 `perFileResults` 解析出 60 个不同的空间内路径，另有一个相对路径 UTF-8 长度为 1025 字节
- **THEN** `changes` 恰为派生次序中前 50 个合法路径，超长路径不在其中

#### Scenario: 原始候选上限与同路径只判定一次
- **WHEN** 一条事件携带 150 个候选：前 100 个中有 40 个不同的空间内路径（其余为这 40 个路径的重复，含 `./a.txt` 与 `a.txt` 这类规范化后相同的写法），第 101–150 个是另外 50 个空间内路径
- **THEN** `changes` 恰为那 40 个路径（按首次出现次序，重复项的 `added`/`removed` 已求和）；第 101–150 个候选一个都不在其中，且未对它们做任何文件系统访问；前 100 个候选的文件系统判定次数等于其中规范化后互不相同的路径数（40），而不是 100

#### Scenario: 持久化失败
- **WHEN** 写入 `chat_steps.changes` 失败
- **THEN** 不发布 `files.changed`，ring 序号不因其推进，失败沿 owned error-sink 路径处理，不产生伪造的变更

#### Scenario: 超长或过深的候选不触达文件系统
- **WHEN** 空间内有符号链接 `l -> .`，一条事件的候选为 `l/` 重复 200 次后接 `a.txt`（分量超过 128 个，解析结果是空间内的 `a.txt`），以及一个规范化后超过 4096 字节的路径
- **THEN** 两个候选都不在 `changes` 中，且没有任何以它们为目标的文件系统访问；同一事件里的普通候选 `a.txt` 照常进入 `changes`

#### Scenario: 浏览器截图进入文件变更
- **WHEN** 绑定空间根为 `<ws>` 的会话中，已登记为 `browser` 的调用成功结束，`details.xdev` 为 `{tool:"browser",mode:"execute",inner:{action:"run",screenshots:[{dest:"screenshots/s1.png"},{dest:"<TMPDIR>/omp-sshots-9.png"},{dest:""},{bytes:3}]}}`，且 `<ws>/screenshots/s1.png` 存在
- **THEN** 该步骤 ring 中 `files.changed` 紧先于其 `step.end`，`files` 恰为 `[{path:"screenshots/s1.png",added:null,removed:null,kind:"write"}]`（相对路径以 `--cwd` 为基准，空间外的 `TMPDIR` 路径被丢弃，空串与缺 `dest` 的元素不产生候选）；快照中该步骤 `changes` 等值
- **WHEN** 已登记为 `browser` 的调用以 `isError:true` 结束；`details.xdev.tool` 为 `"other"`；`inner` 只在原型上有 `screenshots`；`inner.screenshots` 为对象；未绑定会话中带截图的 `browser` 调用成功结束
- **THEN** 均无 `files.changed`，`changes` 为 `null`，`step.end` 照常发布

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `消息线程` 的助手块次序；它在工具调用组之外，不随工具调用组的收起而隐藏。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击打开会话页的工作空间侧边栏并定位到该文件（workspace-sidebar「从卡片定位到文件」），不导航、不改变地址。会话 `workspaceId` 不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径（无从拼出逻辑路径），`查看详情` 照常渲染，其 accessible name 与 tooltip 为 `查看详情 <相对路径>`——侧边栏只需要 `workspaceId`。会话 `workspaceId` 为 `null` 时行只显示空间内相对路径，不渲染 `查看详情`（没有工作空间就没有侧边栏）。用临时空间的会话（会话视图 `temporaryWorkspace` 为 true，session-metadata「会话视图扩展键」）属于这一情形的行呈现——临时空间不在 `listWorkspaces` 结果里，行只显示空间内相对路径，`查看详情 <相对路径>` 照常渲染（文件页不列临时空间；这个按钮打开的工作空间侧边栏就是从会话进入临时空间文件的入口）——且它的空间是**可解析**的（见下）。

**空间可解析**的定义（本条与 `产物卡` 共用；`产物面板` 已由 s1f-files-page 移除）：会话 `workspaceId` 非 null，且要么它在已成功读取的 `listWorkspaces` 结果里，要么该会话 `temporaryWorkspace` 为 true。后一种判定只看会话视图，不依赖空间列表：列表读取中或读取失败时，临时空间会话仍是空间可解析的。其余情形（`workspaceId` 为 null；`temporaryWorkspace` 为 false 而 `workspaceId` 不在列表中、列表读取中或读取失败）为空间不可解析。空间是否可解析只决定产物卡是否渲染（`产物卡`）与行里显示逻辑路径还是相对路径；`查看详情` 是否渲染只取决于 `workspaceId` 是否非 null。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内、工具调用组之外出现名为 `文件变更（2 个）` 的卡片（工具调用组保持收起时它仍可见），第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后工作空间侧边栏打开并选中 `src/app.ts`，URL 仍是该会话的地址、没有到 `/files` 的导航；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `temporaryWorkspace` 为 false 且 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间（`workspaceId` 为 null），或 `temporaryWorkspace` 为 false 而空间列表读取中或读取失败
- **THEN** 三种情形的卡片行都只显示相对路径，都不渲染产物卡；`workspaceId` 非 null 的两种情形每行仍有 `查看详情 <相对路径>` 按钮，点击打开工作空间侧边栏并定位到该文件；`workspaceId` 为 null 的情形没有 `查看详情` 按钮，页面也没有工作空间侧边栏

#### Scenario: 临时空间会话的文件变更卡
- **WHEN** 账号在一个用临时空间的会话（`temporaryWorkspace` 为 true，`workspaceId` 不在 `listWorkspaces` 结果中）里完成一回合，步骤 `changes` 为 `[{path:"out/index.html",added:null,removed:null,kind:"write"},{path:"notes.md",added:3,removed:0,kind:"edit"}]`；另一例同样的会话在空间列表读取失败时渲染
- **THEN** 两例都出现名为 `文件变更（2 个）` 的卡片，两行分别含 `写入` 与 `out/index.html`、`+3` 与 `notes.md`（只有空间内相对路径，没有 `tmp-` 开头的目录名，也没有绝对根路径）；两行各有 `查看详情 <相对路径>` 按钮，点击 `查看详情 notes.md` 后工作空间侧边栏打开、对该会话的 `workspaceId` 请求 `tree` 并选中 `notes.md`，URL 不变；该消息仍渲染 `index.html` 与 `notes.md` 的产物卡

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感；文件名里唯一的 `.` 在开头时视为无扩展名，如 `.env`、`.html`）派生产物卡，位置在文件变更卡之后（同样在工具调用组之外）；代码卡的正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本；html 卡与图片卡自身不拉取正文（见下）。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击 SHALL 打开会话页的工作空间侧边栏、定位到该文件并显示其渲染视图（workspace-sidebar「从卡片定位到文件」；渲染视图由隔离预览来源提供，同空间的相对资源可加载，不受 1 MiB 文本上限约束，见 file-previewers「隔离来源的嵌入与令牌」）；卡片自身 SHALL NOT 为此调用 `fetchPreview`，SHALL NOT 打开对话框，SHALL NOT 渲染任何 `srcdoc` iframe；卡片本身不内嵌 iframe。窄屏下侧边栏是模态层，关闭后焦点 SHALL 回到打开它的按钮，且不因此滚动消息线程（规则在 workspace-sidebar）。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，`下载`（`Icon download`，accessible name `下载 <文件名>`）SHALL 是一个链接，`href` 为 `downloadUrl(workspaceId, path)`（`/api/workspaces/<id>/download?path=<编码后的路径>`，file-operations「下载」），带 `download` 属性——与 file-previewers「预览头、下载与不可预览的呈现」的下载链接同一实现。下载由浏览器直接导航完成：服务端写 `file.download` 审计、不受图片预览上限约束；卡片 SHALL NOT 为下载调用 `fetchPreview`，SHALL NOT 经 `fetch` 读取文件内容，SHALL NOT 创建 Blob 地址；文件已不存在时由浏览器自己报告下载失败，页面不显示错误。不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（s1f-files-page 之前预览 API 的其余可预览文本类型；这个集合不随该 change 扩大）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入；成功时按钮图标换成对勾约 2 秒，并渲染一个视觉隐藏的 `role="status"` 文本 `已复制`，不显示 Toast；剪贴板不可用、抛错或 reject 时就地显示 `复制失败`；响应带截断标记时不写剪贴板并就地显示 `文件过大，无法复制`。
其它扩展名（含无扩展名）不派生产物卡（仍在文件变更卡中列出）；可派生的扩展名集合不随 s1f-files-page 新增的预览格式扩大——其它格式经文件变更卡的 `查看详情` 在侧边栏里预览与下载。`在编辑器中打开` SHALL 不渲染。`复制代码` 的预览请求失败（如文件已被删除的 404、415、网络错误）或返回的类型不是文本时 SHALL 就地显示失败文案：`ApiError` 信封 message（其余情况用 request_failed 的安全文案），不写剪贴板、不留下未处理拒绝；401 不另出提示（沿用客户端既有的未登录通知）。「就地显示」指在触发控件旁渲染一行 `role="alert"` 文本，该卡片下一次操作成功或再次触发操作时清除；产物卡 SHALL NOT 调用 Toast。拉取期间该卡片的操作按钮禁用，重复点击不并发请求；拉取结束时若焦点已不在任何元素上（浏览器在按钮禁用时把焦点移到 `body`），焦点 SHALL 回到被点的那个操作按钮且不因此滚动页面（`preventScroll`），焦点在别处时不动；组件卸载、切换会话或换账号时 SHALL abort 进行中的拉取，被 abort 的拉取不出任何提示。会话空间不可解析（`文件变更卡` 的定义）时不渲染产物卡；用临时空间的会话空间可解析，产物卡照常渲染，其定位、下载与复制以该会话的 `workspaceId`（临时空间的 id）调用与正式空间相同的按 id 端点（temporary-workspaces「临时空间的可见性」：按 id 的 file 端点对所有者的临时空间照常工作；s1f-files-page 新增的 `download`、`preview-token` 等按 id 的端点同样只经所有者作用域的 `rootOf` 解析，不区分临时与正式）。user 消息不渲染产物卡。

#### Scenario: html 预览隔离
- **WHEN** 助手消息变更含 `out/index.html`，点击 `打开网页预览 index.html`（卡头按钮与卡脚链接各一次）
- **THEN** 两次都使工作空间侧边栏打开并选中 `out/index.html`、显示渲染视图：一个 `src` 在隔离预览来源下、`sandbox` 属性不含 `allow-same-origin` 的 iframe（file-previewers「隔离来源的嵌入与令牌」）；卡片标签 `HTML`、卡脚有 `可交互预览`；无 `在编辑器中打开`；页面里没有以 `index.html` 为名的对话框，没有 `srcdoc` iframe；卡片没有调用预览 API（`GET …/file` 的次数不因点击卡片而增加）
- **WHEN** 该 html 文件超过 1 MiB
- **THEN** 渲染视图照常加载完整文件，页面没有 `文件超过 1 MiB，仅预览前 1 MiB` 的提示（截断只作用于侧边栏里的源码视图）
- **WHEN** 窄屏下转录贴底、回合仍在输出时从较早一条消息的 html 产物卡打开预览，期间内容把该卡片顶出转录视口，随后以 Escape 或 `关闭` 关闭侧边栏
- **THEN** 焦点回到打开它的 `打开网页预览 index.html` 按钮，消息线程不因焦点归还而滚动（仍贴底跟随，不出现 `回到最新`）

#### Scenario: 图片下载与代码复制
- **WHEN** 变更含 `assets/chart.PNG` 与 `src/app.ts`，查看 `下载 chart.PNG` 并点击 `复制代码 app.ts`
- **THEN** 前者卡片标签 `PNG`，`下载 chart.PNG` 是一个链接，`href` 恰为 `/api/workspaces/<该空间 id>/download?path=assets%2Fchart.PNG`（或等价编码）且带 `download` 属性，页面没有为它发出 `GET …/file` 请求、没有创建 Blob 地址；后者卡片标签 `TS`，剪贴板写入恰为预览 API 返回的文本，按钮图标换为对勾，存在 `role="status"` 文本 `已复制`，页面无 Toast；约 2 秒后图标恢复

#### Scenario: 不派生与失败
- **WHEN** 变更含 `main.py` 与已被外部删除的 `gone.md`，点击 `复制代码 gone.md` 时预览 API 返回 404
- **THEN** `main.py` 只在文件变更卡中列出、无产物卡；`gone.md` 点击后该按钮旁出现 `role="alert"`，文本为信封文案，页面无 Toast，无剪贴板写入、无未处理拒绝
- **WHEN** 剪贴板写入被 reject；另一次预览响应带截断标记；随后再次点击同一按钮且这次成功
- **THEN** 前两者分别在该按钮旁以 `role="alert"` 显示 `复制失败` 与 `文件过大，无法复制`（后者无剪贴板写入）；再次点击时该 `role="alert"` 即被清除，成功后不再出现

#### Scenario: 拉取中与卸载
- **WHEN** 点击 `复制代码 app.ts` 后预览响应尚未返回，再次点击该按钮；另一例在该预览响应返回之前切换到另一个会话，随后响应返回
- **THEN** 前者只发出一个预览请求，该按钮在响应返回前为禁用；后者的请求被 abort，迟到的响应不写剪贴板、不出任何提示；两例全程都没有 Blob 地址被创建

#### Scenario: 临时空间会话照常渲染产物卡
- **WHEN** 用临时空间的会话（`temporaryWorkspace` 为 true）的助手消息变更含 `out/index.html`、`assets/chart.png` 与 `notes.md`，依次点击 `打开网页预览 index.html`、查看 `下载 chart.png`、点击 `复制代码 notes.md`
- **THEN** 三张产物卡都渲染（标签 `HTML`、`PNG`、`MD`）；`打开网页预览 index.html` 使工作空间侧边栏打开并以渲染视图选中 `out/index.html`（没有对话框，卡片没有为此发出 `file` 请求，预览令牌以该会话的 `workspaceId` 签发）；`下载 chart.png` 是指向 `/api/workspaces/<该会话的 workspaceId>/download?path=assets%2Fchart.png`（或等价编码）的链接；`复制代码 notes.md` 恰发出一次 `GET /api/workspaces/<该会话的 workspaceId>/file?path=notes.md` 并写入剪贴板；空间列表读取失败的另一例结果相同
- **WHEN** 该会话的临时空间随后被转正（`temporaryWorkspace` 变为 false、空间出现在 `listWorkspaces` 结果中）并重取列表
- **THEN** 产物卡仍在，文件变更卡的行改为显示逻辑路径，`查看详情` 的可访问名随之改为 `查看详情 <逻辑路径>`
