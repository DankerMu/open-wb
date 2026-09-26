# Spec delta: omp-runtime（#460 审批请求识别与 respondApproval）

> 「RPC IO and child observation」整段逐字取父 delta（本 issue 全量交付；父文「Extension UI cancellation」替换主 spec 同名 Scenario，「Child crash or write failure」逐字保留）。「omp 运行时源码模块划分」以主 spec 为底，只加 `ui-requests.ts` 一句与 Scenario「UI 请求分类模块边界」（父 delta 无此 requirement）。未在此 delta 的父内容：生产 argv 切 `write`（「子进程 spawn 契约」）→ #481；`markPending/clearPending` 与 `onExit` 恒接线（「每会话生命周期」）→ #462；`abort()`/`command()`（「相关命令 API 与回合中断」）→ #488。

## MODIFIED Requirements

### Requirement: RPC IO and child observation
The transport SHALL classify every `extension_ui_request` frame. A frame whose `method` is exactly `select`, whose `options` array is exactly `["Approve","Deny"]` in that order and whose `title` string starts with `Allow tool: ` is an **approval request**: the transport SHALL NOT answer it itself, SHALL expose it to its owner as an approval request carrying the frame `id`, the full `title` and a `tool` name parsed from the first line of the title after `Allow tool: ` (parsing failure or empty name yields `unknown`, and the request still counts as an approval request), and SHALL keep the child waiting. Every other extension UI request (any other `method`, a `select` with different options or a non-matching title, or a request lacking a string `id` handled as before) SHALL be cancelled immediately with `{type:"extension_ui_response",id:<request id>,cancelled:true}` exactly as before. The transport SHALL expose `respondApproval(id, decision)` that writes exactly one `{type:"extension_ui_response",id,value:"Approve"}` for `allow` or `{…,value:"Deny"}` for `deny`; a second answer for the same `id` SHALL NOT be written. Neither the transport nor SessionRuntime SHALL ever answer an approval request on its own under any condition — no timeout answer, no fallback `Deny`, no answer on stop, retirement, shutdown or child exit; `respondApproval` called by the owner is the only writer of an approval answer, and an approval left unanswered when the child exits simply ends with that child (settlement of its record is the owner's concern). It SHALL expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

#### Scenario: Extension UI cancellation
- **WHEN** the fake requests extension UI during a prompt with a non-approval shape (`method` other than `select`, or a `select` whose options are not exactly `["Approve","Deny"]` or whose title does not start with `Allow tool: `)
- **THEN** it receives {type:extension_ui_response,id:the-request-id,cancelled:true} without user interaction and proceeds

#### Scenario: Approval request is surfaced, not cancelled
- **WHEN** the fake, spawned with `--approval-mode write`, sends `extension_ui_request{method:"select",title:"Allow tool: bash\n…",options:["Approve","Deny"]}` before a bash step
- **THEN** no `extension_ui_response` is written for that id until the owner answers, the owner observes one approval request with that id, `tool` equal to `bash` and the original title, and the fake emits no further turn frames while it waits

#### Scenario: Approval answers map to exact values
- **WHEN** the owner answers an outstanding approval request with `allow`, and separately another with `deny`, and then answers either a second time
- **THEN** exactly one `extension_ui_response{id,value:"Approve"}` respectively `{id,value:"Deny"}` reaches the child, the fake proceeds (executing on Approve, reporting `tool_execution_end{isError:true}` on Deny), and the second answer writes nothing
- **WHEN** the title first line cannot be parsed as `Allow tool: <name>`
- **THEN** the request is still surfaced as an approval request with `tool` equal to `unknown` and is not auto-cancelled

#### Scenario: Unanswered approval is never answered by the runtime
- **WHEN** an approval request is outstanding and the owner does not call `respondApproval`, while the injected clock advances well past 60000ms and the generation is then retired or shut down
- **THEN** no `extension_ui_response` (neither `Approve`, `Deny` nor `cancelled`) is ever written for that id by the transport or runtime; retirement proceeds with the normal stdin→TERM→KILL contract

#### Scenario: Child crash or write failure
- **WHEN** a child crashes, is signalled, fails to spawn, or a command cannot be written
- **THEN** affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`omp/commands.ts` SHALL 承载 `SessionRuntime` 的模块级辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助）以及 command/abort/pending 计时面，由 `omp/runtime.ts` 引用；它 SHALL 不新增未被引用的导出，且对 `runtime.ts` 只有类型导入。`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名与导入路径 SHALL 保持在 `runtime.ts`/`process.ts`。`omp/ui-requests.ts` SHALL 承载 `extension_ui_request` 的分类（审批请求或即时回绝）、审批 `title` 的工具名解析与 `extension_ui_response` 应答帧形状：它是无状态的纯函数模块，不持有传输状态、不写子进程 stdin，不导入 `./process.js`、`./runtime.js` 或 `./commands.js`；`OmpProcess` 仍是 `extension_ui_response` 的唯一写出者，由它决定是否与何时写出。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`runtime.ts` 从 `./commands.js` 引用上述辅助而 `commands.ts` 对 `./runtime.js` 只有 `import type`，runtime/process 测试全绿

#### Scenario: UI 请求分类模块边界
- **WHEN** 运行 `knip`、`bash scripts/size-guard.sh`，并检查 `server/src/sessions/omp/` 的导入方向与 `extension_ui_response` 写出点
- **THEN** `process.ts` 从 `./ui-requests.js` 引用分类、工具名解析与应答帧形状；`ui-requests.ts` 不导入 `./process.js`、`./runtime.js`、`./commands.js`；`server/src/sessions/omp/` 中只有 `process.ts` 向子进程 stdin 写出 `extension_ui_response`；size-guard 退出 0，knip 无未引用导出
