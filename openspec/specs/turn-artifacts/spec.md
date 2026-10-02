# turn-artifacts Specification

## Purpose
定义「这一轮改了哪些文件」的端到端契约：从 omp `edit`/`write` 工具结束帧的 `details` 推导候选变更，在绑定工作空间根内做 realpath 归属判定与相对化，`chat_steps.changes` 持久化与 `files.changed` 事件，快照步骤 `changes`，以及 web 的文件变更卡、按扩展名派生的产物卡（HTML、图片、代码）与顶栏产物面板。纯归约器侧映射见 chat-stream `纯协议事件归约`，web DTO/事件解析见 chat-web；本 spec 拥有推导、归属、上限、持久化次序与呈现。
## Requirements
### Requirement: 文件变更推导与归属
纯归约器 SHALL 只对已知 running 调用的 `tool_execution_end` 推导候选变更，且仅当该调用在 `tool_execution_start` 登记的工具名 ∈ {`edit`, `write`}（`ast_edit` 的 details 无 `diff`/`path`/`perFileResults`，不在集合内；结束帧自带的 `toolName` 不参与判定）、帧与结果都未标记失败（`isError` 与 `result.isError` 均不为 `true`）、`result.details` 为普通对象时；读取 SHALL 不访问对象原型（只读自有属性）。
- `edit`：`details.perFileResults` 为非空数组时，对其中每个 `path` 为非空字符串且 `diff` 为字符串的元素各产生一个候选；否则 `details.path` 为非空字符串且 `details.diff` 为字符串时产生一个候选；两者皆不满足则不产生。候选 `kind:"edit"`，`added` 为该 diff 按 `\n` 切分后匹配 `^\+\d+\|` 的行数，`removed` 为匹配 `^-\d+\|` 的行数（omp 编号 diff 格式 `+N|text`/`-N|text`/` N|text`，上下文行与其它行不计）。
- `write`：`details.resolvedPath` 为非空字符串时产生一个候选 `{kind:"write", added:null, removed:null}`（omp write 帧无 diff，故无行数）；缺失则不产生。
有候选时，归约器 SHALL 在该调用的 `step.end` 之前、同一返回结果中紧邻输出一条 `files.changed{messageId, stepId:<toolCallId 字符串>, files:[{path:<details 中的原始路径>, added, removed, kind}]}`（候选按上述出现次序）；无候选时不输出。`bash`、`read`、`memory_edit` 及其它任何工具 SHALL 永不产生 `files.changed`：经 bash/heredoc/脚本等途径写入的文件不进入文件变更卡，这是明确的覆盖边界而非遗漏。
在 supervisor 侧的归属判定、相对化、上限与持久化落地之前，supervisor SHALL 丢弃归约器输出的 `files.changed`（不落库、不发布、不占 ring 序号，原始路径不出现在 SSE 上；chat-stream「纯协议事件归约」）。

#### Scenario: 归约器候选提取
- **WHEN** 已知 `edit` 调用成功结束，`details:{diff:"+3|a\n+4|b\n-3|x\n 2|ctx", path:"/ws/src/app.ts"}`；已知 `write` 调用成功结束，`details:{resolvedPath:"/ws/out/index.html"}`；另一已知 `edit` 调用的 `details.perFileResults` 为 `[{path:"a.md",diff:"+1|x"},{path:"",diff:"+1|y"},{path:"b.md",diff:7},{path:"c.md",diff:"-2|z"}]` 且顶层另有 `path`/`diff`
- **THEN** 三者的返回结果分别为 `files.changed` 紧接 `step.end`：`files` 依次为 `[{path:"/ws/src/app.ts",added:2,removed:1,kind:"edit"}]`、`[{path:"/ws/out/index.html",added:null,removed:null,kind:"write"}]`、`[{path:"a.md",added:1,removed:0,kind:"edit"},{path:"c.md",added:0,removed:1,kind:"edit"}]`；`stepId` 为各自 toolCallId；`step.end` output 不含 details

#### Scenario: 失败、非 edit/write 与原型键（归约器侧）
- **WHEN** `edit` 以帧 `isError:true` 结束；`edit` 以 `result.isError:true` 结束；`bash` 成功且 `details:{exitCode:0}`；`read` 成功且带 `details.resolvedPath`；以 `ast_edit` 登记的调用结束帧带 `details.path`+`diff`；`edit` 的 `details` 为数组，或其 `path`/`diff`/`perFileResults`/`resolvedPath` 只存在于原型上；未知 toolCallId 或重复的结束帧
- **THEN** 以上均不产生 `files.changed`；已知调用只输出其 `step.end`，未知与重复结束无任何事件

### Requirement: 文件变更卡
会话页 SHALL 为每条助手消息汇总其**已结束**步骤（status 非 `running`）的 `changes`：按路径去重，同一路径取步骤 ordinal 最大者的值、位置取首次出现处；汇总非空时渲染一张文件变更卡（`role="group"`，accessible name 为头部文本），位置见 chat-web `会话页` 的助手块次序。卡头为 `文件变更（N 个）`（N 为去重后的项数），每行依次为：`kind:"edit"` 时 `added > 0` 显示 `+<added>`、`removed > 0` 显示 `-<removed>`（两者皆 0 时不显示计数）；`kind:"write"` 时显示 `写入`；随后是逻辑路径 `<account>/<dir>/<path>`（`account` 取当前 Principal，`dir` 取该会话 `workspaceId` 在 `listWorkspaces` 结果中的空间 `dir`，按 ADR-0011 不渲染绝对 `root`）；行尾 `查看详情` 按钮（`Icon chevron-right`，accessible name 与 tooltip `查看详情 <逻辑路径>`），点击以客户端导航前往 `/files?ws=<workspaceId>`（files-web 当前以 `?ws=` 表示空间，无文件预选参数；定位到该文件需 files-web 另行扩展，不在本 change）。会话 `workspaceId` 为 `null`、不在空间列表中、空间列表读取中或读取失败时，行只显示空间内相对路径，不渲染 `查看详情`。回合 running 期间尚未结束的步骤的 `changes` 不参与汇总（卡片在 step.end 之后出现）。user 消息不渲染文件变更卡。

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
- **WHEN** 会话 `workspaceId` 不在 `listWorkspaces` 结果中，或会话未绑定空间，或空间列表读取中或读取失败
- **THEN** 卡片行只显示相对路径，无 `查看详情` 按钮

