# turn-artifacts Spec Delta

## MODIFIED Requirements

### Requirement: 文件变更推导与归属
纯归约器 SHALL 只对已知 running 调用的 `tool_execution_end` 推导候选变更，且仅当该调用在 `tool_execution_start` 登记的工具名 ∈ {`edit`, `write`}（`ast_edit` 的 details 无 `diff`/`path`/`perFileResults`，不在集合内；结束帧自带的 `toolName` 不参与判定；v18.0.10 时代的 `browser` 登记名已随 `xd://browser` 一起消失）、帧与结果都未标记失败（`isError` 与 `result.isError` 均不为 `true`）、`result.details` 为普通对象时；读取 SHALL 不访问对象原型（只读自有属性）。
- `edit`：`details.perFileResults` 为非空数组时，对其中每个 `path` 为非空字符串且 `diff` 为字符串的元素各产生一个候选；否则 `details.path` 为非空字符串且 `details.diff` 为字符串时产生一个候选；两者皆不满足则不产生。候选 `kind:"edit"`，`added` 为该 diff 按 `\n` 切分后匹配 `^\+\d+\|` 的行数，`removed` 为匹配 `^-\d+\|` 的行数（omp 编号 diff 格式 `+N|text`/`-N|text`/` N|text`，上下文行与其它行不计）。
- `write`：`details.resolvedPath` 为非空字符串时产生一个候选 `{kind:"write", added:null, removed:null}`（omp write 帧无 diff，故无行数）；缺失则不产生。
有候选时，归约器 SHALL 在该调用的 `step.end` 之前、同一返回结果中紧邻输出一条 `files.changed{messageId, stepId:<toolCallId 字符串>, files:[{path:<details 中的原始路径>, added, removed, kind}]}`（候选按上述出现次序）；无候选时不输出。`bash`、`read`、`memory_edit`、`eval` 及其它任何工具 SHALL 永不从归约器产生 `files.changed`：经 bash/heredoc/脚本等途径写入的文件不进入文件变更卡，这是明确的覆盖边界而非遗漏。

**浏览器截图（#912 Q9，#1563 Q5）**：omp v18.12.3 把浏览器截图（`tab.screenshot()` 等，宿主 overlay 的 `screenshotDir: screenshots`）写到会话 `<CWD>/screenshots/screenshot-<时间>.<ext>`，而 `eval` 的结束帧不带文件路径。SessionSupervisor SHALL 以目录比对补上这些候选（owner Q5「eval 结束后按调用开始时间比对」的细化：以回合开始时的名字集合为基线，不用调用开始时间）：绑定会话的每个回合在 supervisor 处理 `turn.start` 事件时（任何工具运行之前）经目录句柄同步读一次 `<空间根>/screenshots` 的直接条目名作为该回合的基线集合，记在回合内存状态里——只取名字、不 stat、不递归，至多读 4096 条；读取失败分三支：`ENOENT` 或 `ENOTDIR`（目录还不存在、或该名字是个文件）→ 空集、照常比对；其它错误（如无权限）或条目超过 4096 → 该回合整体不比对。该回合每个登记名为 `eval` 的调用的 `step.end` 到达时（不论成败）以同样方式再读一次：读取失败（任何错误）或超过 4096 条 → 本步无候选、基线不变；否则不在基线里的名字各成一个候选 `{path:"screenshots/<name>", added:null, removed:null, kind:"write"}`，按名字的码点序，并把这些名字并入基线（同一回合后面的 eval 不再重复登记）。4096 与「项目配置文件列表」枚举 `.omp` 的上限同值：宿主是所有会话共用的进程，截图目录没有清理策略，同步读取必须有上界。基线取在回合开始而不是 eval 的 `step.start`：pump 处理 start 帧时 omp 已在执行，先于宿主快照出现的文件会被漏掉；回合开始时没有工具在跑；代价是同一回合里先于 eval 由 bash / write 写进该目录的文件也会归到下一个 eval 步骤。同一回合里经 `tab.run` 等途径写进该目录的其它文件同样会进来（它们恰在截图目录里，接受）。未绑定会话、非 `eval` 步骤：不比对、不产生候选。这些候选 SHALL 经下面的归属判定后，按与归约器候选相同的次序规则写入与发布（`files.changed` 先于该调用的 `step.end`）。
SessionSupervisor SHALL 在持久化前对候选做归属判定（归约器无 IO，此步属 supervisor）；归约器输出里的原始路径 SHALL NOT 出现在 SSE 或 `chat_steps.changes` 中：
1. 会话未绑定工作空间（`workspace_id` 为 NULL）→ 丢弃整条事件，不落库、不发布，该步骤 `changes` 保持 NULL；此时不做任何文件系统访问。事件的 `stepId` 不是本回合已登记的调用时同样丢弃。
2. 原始候选上限：一条事件的候选超过 100 个时，只判定派生次序中的前 100 个，其余丢弃且 SHALL NOT 为它们做任何文件系统访问（不记录被丢弃的数量）。路径解析：绝对路径原样使用；相对路径以该会话 omp 进程的 `--cwd`（即绑定空间根，见 session-metadata）为基准拼接；随后做词法规范化（折叠 `.`、`..`、重复与结尾的路径分隔符，等同 Node `path.resolve`），后续各步只使用规范化后的路径。规范化后的路径 UTF-8 编码超过 4096 字节或路径分量超过 128 个时 SHALL 直接丢弃该候选，不做任何文件系统访问（`realpath` 逐分量解析，代价随分量数平方增长；穿过空间内自指符号链接的超长路径解析结果很短，第 4 步的 1024 字节规则拦不住）。同一条事件内规范化后相同的路径 SHALL 只做一次第 3 步的文件系统判定，其余复用首次的第 3–4 步结果（判定为丢弃的同样复用）。
3. 取该路径的 realpath；路径不存在（`lstat` 无此条目，例如 edit 删除了文件）时取其父目录的 realpath 再拼接文件名，拼接出的位置上已有条目（`lstat` 有此条目或失败）则丢弃；路径存在但取不到 realpath（悬空符号链接、符号链接环、无权限）、父目录的 realpath 也取不到、或路径无法交给文件系统（含 NUL 字节、过长），则丢弃该候选。结果 SHALL 严格位于绑定空间根的 realpath 之内（以「根 realpath + 路径分隔符」为前缀；根自身、根外路径、与根同前缀的兄弟目录、经符号链接逃出根的路径一律丢弃）；空间根 SHALL 是规范路径：其 realpath 取不到或不等于它自身（根被换成符号链接、经符号链接到达）时丢弃整条事件。截图候选另要求 realpath 是普通文件（目录与指向目录的链接丢弃）。
4. 保存值为该 realpath 相对空间根 realpath、以 `/` 分隔的路径（经空间内符号链接到达空间内文件的候选保存的是其真实位置）；UTF-8 编码超过 1024 字节的丢弃。
5. 同一步骤内解析到同一相对路径的多个候选合并为一项，`added`/`removed` 求和（`kind:"write"` 的项保持 `null`），位置与 `kind` 取首次出现处。
6. 合并后超过 50 项时只保留派生次序中的前 50 项，其余丢弃，不记录被丢弃的数量（因第 2 步，这 50 项取自前 100 个原始候选）。单条事件的同步文件系统判定因此至多 100 个互不相同的路径，每个路径不超过 4096 字节、128 个分量。
7. 无候选幸存 → 不落库、不发布、不占 ring 序号。
取证分工：`±` 行数推导只由 fake-omp `edit-write` 场景驱动的服务端集成测试证明；真 omp 链路（ui-walk，受控假上游 `WORKBUDDY_WRITE` 标记，见 omp-test-harness `受控上游思考与写入标记`）只能证明 `write` 变更（`写入`、无行数）；浏览器截图候选由真实 omp + Chromium 的 browser-runtime「CI browser-image job」证明，服务端测试以帧常量驱动归约器，以真实目录驱动目录比对与归属判定。
有幸存项时，supervisor SHALL 先提交该步骤行的 `chat_steps.changes`（JSON 数组文本，元素键恰为 `path`、`added`、`removed`、`kind` 且按此次序；只写入仍为 `running` 的步骤行，写不到恰一行即为失败），提交成功后以持久化步骤数字 id 发布 `files.changed{messageId, stepId:<数字步骤 id>, files}`（`files` 与该列解析后等值），随后才落库并发布该调用的 `step.end`（`step.end` 的落库不读写 `changes`）；落库失败 SHALL 不发布该事件并沿既有 owned error-sink 路径处理，ring 序号不因失败发布而推进。`files.changed` SHALL 是普通 ring 事件（正常 `<epoch>:<seq>`、保留、`min−1` 回放、`replay.gap` 与活跃 turn.start 刷新规则，SSE `event:files.changed`）。消息快照中每个步骤 SHALL 带 `changes: {path, added, removed, kind}[] | null`：无变更的步骤（含全部非 edit/write/eval 步骤、未绑定会话的步骤与未收到工具结束帧即被结算的步骤）为 `null`，否则为该列解析后的数组（1..50 项，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`）。步骤随消息删除（regenerate、删会话）时一并删除。

#### Scenario: 归约器候选提取
- **WHEN** 已知 `edit` 调用成功结束，`details:{diff:"+3|a\n+4|b\n-3|x\n 2|ctx", path:"/ws/src/app.ts"}`；已知 `write` 调用成功结束，`details:{resolvedPath:"/ws/out/index.html"}`；另一已知 `edit` 调用的 `details.perFileResults` 为 `[{path:"a.md",diff:"+1|x"},{path:"",diff:"+1|y"},{path:"b.md",diff:7},{path:"c.md",diff:"-2|z"}]` 且顶层另有 `path`/`diff`
- **THEN** 三者的返回结果分别为 `files.changed` 紧接 `step.end`：`files` 依次为 `[{path:"/ws/src/app.ts",added:2,removed:1,kind:"edit"}]`、`[{path:"/ws/out/index.html",added:null,removed:null,kind:"write"}]`、`[{path:"a.md",added:1,removed:0,kind:"edit"},{path:"c.md",added:0,removed:1,kind:"edit"}]`；`stepId` 为各自 toolCallId；`step.end` output 不含 details

#### Scenario: 失败、非 edit/write 与原型键（归约器侧）
- **WHEN** `edit` 以帧 `isError:true` 结束；`edit` 以 `result.isError:true` 结束；`bash` 成功且 `details:{exitCode:0}`；`read` 成功且带 `details.resolvedPath`；以 `ast_edit` 登记的调用结束帧带 `details.path`+`diff`；`eval` 成功结束且 `details.images` 非空；`edit` 的 `details` 为数组，或其 `path`/`diff`/`perFileResults`/`resolvedPath` 只存在于原型上；未知 toolCallId 或重复的结束帧
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
- **WHEN** 未绑定工作空间的会话中 `write` 成功写入所有者根下的文件；另一个未绑定会话里一个 `eval` 步骤在所有者根的 `screenshots/` 下写出一个文件
- **THEN** 两者都无 `files.changed` 事件，步骤 `changes` 为 `null`，`step.end` 照常发布；后者没有读过 `screenshots/` 目录

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
- **WHEN** 绑定空间根为 `<ws>` 的会话里，回合开始时 `<ws>/screenshots/` 已有 `old.png`；第一个 `eval` 步骤运行期间（在其 `tool_execution_end` 到达之前）`<ws>/screenshots/` 下出现 `screenshot-1.png`、一个子目录 `d/`（其中有 `x.png`）和一个指向空间外文件的符号链接 `l.png`；该步骤以 `done` 结束；第二个 `eval` 步骤运行期间出现 `screenshot-2.png`，并以 `isError:true` 结束；之后一个 `bash` 步骤运行期间出现 `screenshot-3.png`
- **THEN** 第一步 ring 中 `files.changed` 紧先于其 `step.end`，`files` 恰为 `[{path:"screenshots/screenshot-1.png",added:null,removed:null,kind:"write"}]`（`old.png` 在基线里，`d` 不是普通文件，`l.png` 逃出空间）；第二步同样恰为 `screenshots/screenshot-2.png`（失败的 eval 照样比对）；`bash` 步骤无 `files.changed`、`changes` 为 `null`；快照里两个 eval 步骤的 `changes` 等值；SSE 与 `chat_steps.changes` 不含 `<ws>` 的绝对路径
- **WHEN** 同一会话的下一个回合开始时 `screenshots/` 下已有前一回合的三个文件，本回合的 `eval` 步骤没有写出新文件；另一回合开始时 `<ws>/screenshots` 不存在，`eval` 步骤期间它被建出并写入 `screenshot-9.png`
- **THEN** 前者无 `files.changed`、`changes` 为 `null`；后者 `files` 恰为 `screenshots/screenshot-9.png`
- **WHEN** 回合开始时读取 `<ws>/screenshots` 失败（目录不可读）；另一回合开始时 `<ws>/screenshots` 是一个普通文件，`eval` 步骤期间它被换成目录并写入 `screenshot-7.png`；另一回合开始时目录里已有 4097 个条目
- **THEN** 第一与第三回合的 `eval` 步骤都不比对、无 `files.changed`，`step.end` 照常发布；第二回合（基线为空集）的 `eval` 步骤 `files` 恰为 `screenshots/screenshot-7.png`
- **WHEN** 回合开始时基线正常，第一个 `eval` 步骤期间目录被改成不可读（或条目增至 4097），随后第二个 `eval` 步骤期间目录恢复可读并新增 `screenshot-8.png`
- **THEN** 第一步无 `files.changed`、`changes` 为 `null`，基线不变；第二步 `files` 恰为该步期间相对基线新增的名字（含 `screenshot-8.png` 与第一步期间写入的文件）
