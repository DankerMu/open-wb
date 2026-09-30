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
