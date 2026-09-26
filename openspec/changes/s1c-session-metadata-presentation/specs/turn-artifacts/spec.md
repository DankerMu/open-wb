# Spec: turn-artifacts

## Purpose
定义「这一轮改了哪些文件」的端到端契约：从 omp `edit`/`write` 工具结束帧的 `details` 推导候选变更，在绑定工作空间根内做 realpath 归属判定与相对化，`chat_steps.changes` 持久化与 `files.changed` 事件，快照步骤 `changes`，以及 web 的文件变更卡、按扩展名派生的产物卡（HTML、图片、代码）与顶栏产物面板。纯归约器侧映射见 chat-stream `纯协议事件归约`，web DTO/事件解析见 chat-web；本 spec 拥有推导、归属、上限、持久化次序与呈现。

## ADDED Requirements

### Requirement: 文件变更推导与归属
纯归约器 SHALL 只对已知 running 调用的 `tool_execution_end` 推导候选变更，且仅当 `toolName` ∈ {`edit`, `write`}（`ast_edit` 的 details 无 `diff`/`path`/`perFileResults`，不在集合内）、帧与结果都未标记失败（`isError` 与 `result.isError` 均不为 `true`）、`result.details` 为普通对象时；读取 SHALL 不访问对象原型。
- `edit`：`details.perFileResults` 为非空数组时，对其中每个 `path` 为非空字符串且 `diff` 为字符串的元素各产生一个候选；否则 `details.path` 为非空字符串且 `details.diff` 为字符串时产生一个候选；两者皆不满足则不产生。候选 `kind:"edit"`，`added` 为该 diff 按 `\n` 切分后匹配 `^\+\d+\|` 的行数，`removed` 为匹配 `^-\d+\|` 的行数（omp 编号 diff 格式 `+N|text`/`-N|text`/` N|text`，上下文行与其它行不计）。
- `write`：`details.resolvedPath` 为非空字符串时产生一个候选 `{kind:"write", added:null, removed:null}`（omp write 帧无 diff，故无行数）；缺失则不产生。
有候选时，归约器 SHALL 在该调用的 `step.end` 之前、同一返回结果中紧邻输出一条 `files.changed{messageId, stepId:<toolCallId 字符串>, files:[{path:<details 中的原始路径>, added, removed, kind}]}`（候选按上述出现次序）；无候选时不输出。`bash`、`read`、`memory_edit` 及其它任何工具 SHALL 永不产生 `files.changed`：经 bash/heredoc/脚本等途径写入的文件不进入文件变更卡，这是明确的覆盖边界而非遗漏。
SessionSupervisor SHALL 在持久化前对候选做归属判定（归约器无 IO，此步属 supervisor）：
1. 会话未绑定工作空间（`workspace_id` 为 NULL）→ 丢弃整条事件，不落库、不发布，该步骤 `changes` 保持 NULL。
2. 路径解析：绝对路径原样使用；相对路径以该会话 omp 进程的 `--cwd`（即绑定空间根，见 session-metadata）为基准拼接。
3. 取该路径的 realpath；路径不存在（例如 edit 删除了文件）时取其父目录的 realpath 再拼接文件名；两者都失败则丢弃该候选。结果 SHALL 严格位于绑定空间根的 realpath 之内（以「根 realpath + 路径分隔符」为前缀；根自身、根外路径、经符号链接逃出根的路径一律丢弃）。
4. 保存值为相对空间根、以 `/` 分隔的路径；UTF-8 编码超过 1024 字节的丢弃。
5. 同一步骤内解析到同一相对路径的多个候选合并为一项，`added`/`removed` 求和，位置取首次出现处。
6. 合并后超过 50 项时只保留派生次序中的前 50 项，其余丢弃，不记录被丢弃的数量。
7. 无候选幸存 → 不落库、不发布。
取证分工：`±` 行数推导只由 fake-omp `edit-write` 场景驱动的服务端集成测试证明；真 omp 链路（ui-walk，受控假上游 `WORKBUDDY_WRITE` 标记，见 omp-test-harness `受控上游思考与写入标记`）只能证明 `write` 变更（`写入`、无行数）。
有幸存项时，supervisor SHALL 先提交该步骤行的 `chat_steps.changes`（JSON 数组文本，元素键恰为 `path`、`added`、`removed`、`kind`；可空 TEXT 列由 chat-sessions 的 035 迁移新增），提交成功后以持久化步骤数字 id 发布 `files.changed{messageId, stepId:<数字步骤 id>, files}`，随后才落库并发布该调用的 `step.end`；落库失败 SHALL 不发布该事件并沿既有 owned error-sink 路径处理，ring 序号不因失败发布而推进。`files.changed` SHALL 是普通 ring 事件（正常 `<epoch>:<seq>`、保留、`min−1` 回放、`replay.gap` 与活跃 turn.start 刷新规则，SSE `event:files.changed`）。消息快照中每个步骤 SHALL 带 `changes: {path, added, removed, kind}[] | null`：无变更的步骤（含全部非 edit/write 步骤与未绑定会话的步骤）为 `null`，否则为该列解析后的数组（1..50 项，`kind:"edit"` 时 `added`/`removed` 为非负安全整数，`kind:"write"` 时二者为 `null`）。步骤随消息删除（regenerate、删会话）时一并删除。

#### Scenario: edit 与 write 的推导
- **WHEN** 绑定空间根为 `<ws>` 的会话中，fake-omp `edit-write` 场景（omp-test-harness）发出 `edit` 结束帧 `details:{path:"<ws>/notes.md", diff:"+1|a\n+2|b\n-3|c\n 4|d"}` 与 `write` 结束帧 `details:{resolvedPath:"<ws>/out/report.html"}`
- **THEN** 两个步骤各自 ring 中 `files.changed` 紧先于其 `step.end`，payload 分别为 `{files:[{path:"notes.md",added:2,removed:1,kind:"edit"}]}` 与 `{files:[{path:"out/report.html",added:null,removed:null,kind:"write"}]}`，`stepId` 为数字步骤 id；快照中两步骤 `changes` 等值；另一回合的 bash 步骤 `changes` 为 `null`

#### Scenario: 多文件与重复路径
- **WHEN** 一次 `edit` 结束帧的 `perFileResults` 为 `[{path:"a.md",diff:"+1|x"},{path:"b.md",diff:"-2|y"},{path:"a.md",diff:"+5|z"}]`（相对路径）
- **THEN** 该步骤 `changes` 为 `[{path:"a.md",added:2,removed:0,kind:"edit"},{path:"b.md",added:0,removed:1,kind:"edit"}]`

#### Scenario: 空间外与符号链接逃逸
- **WHEN** 候选分别为 `/etc/passwd`、`../other/x.md`、空间根本身、以及空间内指向空间外的符号链接 `link/x.md`，同一帧另有一个空间内合法路径
- **THEN** 只有合法路径进入 `changes` 与事件；若四个非法候选单独出现，则无事件、`changes` 为 `null`

#### Scenario: 未绑定会话
- **WHEN** 未绑定工作空间的会话中 `write` 成功写入所有者根下的文件
- **THEN** 无 `files.changed` 事件，步骤 `changes` 为 `null`，`step.end` 照常发布

#### Scenario: 失败与非 edit/write 工具
- **WHEN** `edit` 以 `isError:true` 结束，`bash` 执行 `echo x > a.md` 成功，`read` 返回 `details.resolvedPath`
- **THEN** 三者都不产生 `files.changed`，`changes` 均为 `null`

#### Scenario: 上限
- **WHEN** 一次 `edit` 的 `perFileResults` 解析出 60 个不同的空间内路径，另有一个相对路径 UTF-8 长度为 1025 字节
- **THEN** `changes` 恰为派生次序中前 50 个合法路径，超长路径不在其中

#### Scenario: 持久化失败
- **WHEN** 写入 `chat_steps.changes` 的事务失败
- **THEN** 不发布 `files.changed`，失败沿 owned error-sink 路径处理，不产生伪造的变更

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `会话页` 的助手块次序。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击以客户端导航前往 `/files?ws=<workspaceId>`（files-web 当前以 `?ws=` 表示空间，无文件预选参数；定位到该文件需 files-web 另行扩展，不在本 change）。会话 `workspaceId` 为 `null`、不在空间列表中或列表读取失败时，行只显示空间内相对路径，不渲染 `查看详情`。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。

#### Scenario: 卡片内容与跳转
- **WHEN** 账号 `zhangsan` 在绑定空间（`dir` 为 `proj`）的会话中完成一回合，步骤 `changes` 分别为 `[{path:"src/app.ts",added:2,removed:1,kind:"edit"}]` 与 `[{path:"out/index.html",added:null,removed:null,kind:"write"}]`
- **THEN** 助手消息内出现名为 `文件变更（2 个）` 的卡片，第一行含 `+2`、`-1` 与 `zhangsan/proj/src/app.ts`，第二行含 `写入` 与 `zhangsan/proj/out/index.html`；点击第一行 `查看详情 zhangsan/proj/src/app.ts` 后 URL 为 `/files?ws=<该空间 id>`；页面任何文本与属性中不出现空间绝对根路径

#### Scenario: 仅在步骤结束后出现
- **WHEN** running 回合收到某步骤的 `files.changed` 但尚未收到其 `step.end`，随后收到 `step.end`
- **THEN** `step.end` 之前该消息无文件变更卡，之后出现

#### Scenario: 同一消息多步骤同一路径
- **WHEN** 同一助手消息两个步骤先后修改 `a.md`（ordinal 0 为 `+1`，ordinal 1 为 `+4 -2`）
- **THEN** 卡头为 `文件变更（1 个）`，该行显示 `+4` 与 `-2`

#### Scenario: 空间不可解析
- **WHEN** 会话 `workspaceId` 不在 `listWorkspaces` 结果中
- **THEN** 卡片行只显示相对路径，无 `查看详情` 按钮，也不渲染产物卡

### Requirement: 产物卡
会话页 SHALL 从每条助手消息的去重变更行（与文件变更卡同一汇总、同一顺序）按路径扩展名（取末段文件名最后一个 `.` 之后、大小写不敏感）派生产物卡，位置在文件变更卡之后；正文 SHALL 只在用户操作时经既有预览 API（`fetchPreview(workspaceId, path)`，`GET /api/workspaces/:id/file?path=`）拉取，不预取、不存副本、不新增服务端端点。每张卡为 `role="group"`（accessible name 为文件名），卡头含文件图标、文件名与类型标签；三类：
- `html`：`Icon globe`，标签 `HTML`，卡头按钮与卡脚链接均为 `打开网页预览`（accessible name `打开网页预览 <文件名>`），卡脚另有 `可交互预览` 说明。点击后拉取文本并打开 `Dialog`（标题为文件名），内含 `<iframe sandbox="allow-scripts" srcdoc="<取回文本>" title="<文件名>">`，sandbox SHALL 不含 `allow-same-origin` 或其它令牌；卡片本身不内嵌 iframe。预览响应带截断标记（超过 1 MiB）时 Dialog 在 iframe 上方显示 `文件超过 1 MiB，仅预览前 1 MiB`。
- `png` → 标签 `PNG`，`jpg`/`jpeg` → 标签 `JPG`：`Icon image`，按钮 `下载`（`Icon download`，accessible name `下载 <文件名>`）。点击后拉取图片 Blob URL，以 `download=<文件名>` 的临时链接触发下载后撤销该 URL；不生成缩略图。
- `md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx`（预览 API 其余可预览文本类型）→ 代码卡：`Icon file-code`，标签为大写扩展名，按钮 `复制代码`（`Icon copy`，accessible name `复制代码 <文件名>`）。点击后拉取文本，经 `navigator.clipboard.writeText` 写入并 Toast `已复制到剪贴板`；剪贴板不可用、抛错或 reject 时 Toast `复制失败`；响应带截断标记时不写剪贴板并 Toast `文件过大，无法复制`。
其它扩展名不派生产物卡（仍在文件变更卡中列出）。`在编辑器中打开` SHALL 不渲染。预览请求失败（如文件已被删除的 404、415、网络错误）时 SHALL 显示 Toast，文案为 `ApiError` 信封 message（request_failed 用其安全文案），不打开 Dialog、不留下未处理拒绝；拉取期间该按钮禁用，重复点击不并发请求；组件卸载或切换会话时 SHALL abort 进行中的拉取并撤销已创建的 Blob URL。会话空间不可解析时不渲染产物卡。`globe`、`download`、`package` 三个 lucide 名由本 change 加入共享 `Icon` 注册表（`web/src/ui/icon.tsx`；`image`、`file-code`、`chevron-right`、`copy` 已存在）。

#### Scenario: html 预览隔离
- **WHEN** 助手消息变更含 `out/index.html`，点击 `打开网页预览 index.html`，预览 API 返回文本 `<h1>hi</h1><script>document.title='x'</script>`
- **THEN** 打开标题为 `index.html` 的 Dialog，内含 `sandbox` 属性恰为 `allow-scripts`、`srcdoc` 为该文本的 iframe；卡片标签 `HTML`、卡脚有 `可交互预览`；无 `在编辑器中打开`；预览 API 恰被调用一次且在点击之前未被调用
- **WHEN** 预览响应带 `X-Workbuddy-Truncated: 1`
- **THEN** Dialog 内显示 `文件超过 1 MiB，仅预览前 1 MiB`

#### Scenario: 图片下载与代码复制
- **WHEN** 变更含 `assets/chart.PNG` 与 `src/app.ts`，分别点击 `下载 chart.PNG` 与 `复制代码 app.ts`
- **THEN** 前者卡片标签 `PNG`，触发以 `chart.PNG` 为文件名的下载且其 Blob URL 随后被撤销；后者卡片标签 `TS`，剪贴板写入恰为预览 API 返回的文本并 Toast `已复制到剪贴板`

#### Scenario: 不派生与失败
- **WHEN** 变更含 `main.py` 与已被外部删除的 `gone.md`，点击 `复制代码 gone.md` 时预览 API 返回 404
- **THEN** `main.py` 只在文件变更卡中列出、无产物卡；`gone.md` 点击后出现信封文案 Toast，无剪贴板写入、无未处理拒绝

### Requirement: 产物面板
选中会话时，会话页 SHALL 经 spa-shell 顶栏 `actions` 插槽注入 `产物面板` 图标按钮（`Icon package`，accessible name 与 tooltip `产物面板`）；欢迎态不渲染。点击时 SHALL 以当前聊天视图中全部已结束步骤的 `changes` 按路径聚合（同一路径取最新者：消息次序靠后者优先，同一消息内步骤 ordinal 大者优先；位置取首次出现处）：结果为空时只显示 Toast `当前任务暂无产物`、不打开抽屉；否则打开右侧 `Drawer`（对话框 accessible name `产物面板`），每项一行，行内容与文件变更卡行相同（计数或 `写入`、逻辑路径、`查看详情`），且对可派生产物卡的扩展名附带同名操作按钮（`打开网页预览`/`下载`/`复制代码`，行为同产物卡）；抽屉脚部 `关闭` 按钮，Escape 与遮罩亦关闭，关闭后焦点归还 `产物面板` 按钮。抽屉打开期间视图更新时列表随之更新。面板不读取任何新端点，完全由快照与事件归约的视图派生。

#### Scenario: 聚合与空态
- **WHEN** 会话两条助手消息分别变更 `a.md`（`+1`）与 `a.md`（`+3 -1`）、`out/index.html`（写入），点击顶栏 `产物面板`
- **THEN** 打开名为 `产物面板` 的抽屉，恰两行：`a.md` 显示 `+3`、`-1`，`out/index.html` 显示 `写入` 并带 `打开网页预览` 按钮；`关闭` 后焦点回到 `产物面板` 按钮
- **WHEN** 当前会话没有任何非空 `changes`（含未绑定空间的会话）
- **THEN** 点击后出现 Toast `当前任务暂无产物`，无抽屉
