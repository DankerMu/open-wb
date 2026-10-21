## MODIFIED Requirements

### Requirement: omp 运行时源码模块划分
`server/src/sessions/omp/` 下的运行时实现 SHALL 保持每个源文件 ≤800 行（`scripts/size-guard.sh`）。`omp/commands.ts` SHALL 承载 `SessionRuntime` 的模块级辅助（waiter 与 generation/turn 结构、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助、提示回执的结算（#1600））以及 command/abort/pending 计时面，由 `omp/runtime.ts` 引用；它 SHALL 不新增未被引用的导出，且对 `runtime.ts` 只有类型导入。`SessionRuntime`、`OmpProcess`/`spawnOmp` 的公开签名与导入路径 SHALL 保持在 `runtime.ts`/`process.ts`。 `omp/local-wait.ts` SHALL 承载本地完成等待（#1600）：一个 `/` 回合在只本地完成的结果之后等迟到的 `command_output` 或等到宽限期满（`local-command.ts` 的 `decideLocalCompletion` 与 `LOCAL_COMMAND_GRACE_MS`），持有等待中的回合与它在注入时钟上的计时器；它经构造参数取得时钟、「当前回合」与「完成回合」回调，不持有 generation、不写子进程 stdin，对 `./runtime.js` 至多只有 `import type`，`runtime.ts` 经它的方法开始、判定与清除等待。`runtime.ts` SHALL 留出余量：拆分后 ≤740 行。`omp/ui-requests.ts` SHALL 承载 `extension_ui_request` 的分类（审批请求或即时回绝）、审批 `title` 的工具名解析与 `extension_ui_response` 应答帧形状：它是无状态的纯函数模块，不持有传输状态、不写子进程 stdin，不导入 `./process.js`、`./runtime.js` 或 `./commands.js`；`OmpProcess` 仍是 `extension_ui_response` 的唯一写出者，由它决定是否与何时写出。`runtime.ts` 与 `commands.ts` 对 `./ui-requests.js` SHALL 至多有语句级 `import type`（不得有值导入、副作用导入、动态导入，也不得 re-export 其中的符号），审批请求的类型可由此引入，应答帧的构造与写出不得出现在这两个文件中。

#### Scenario: 模块划分可持续验证
- **WHEN** 运行 `bash scripts/size-guard.sh`、`knip` 与 server 测试
- **THEN** size-guard 退出 0，knip 无未引用导出，`runtime.ts` 从 `./commands.js` 引用上述辅助而 `commands.ts` 对 `./runtime.js` 只有 `import type`，runtime/process 测试全绿

#### Scenario: UI 请求分类模块边界
- **WHEN** 运行 `knip`、`bash scripts/size-guard.sh`，并检查 `server/src/sessions/omp/` 的导入方向与 `extension_ui_response` 写出点
- **THEN** `process.ts` 从 `./ui-requests.js` 引用分类、工具名解析与应答帧形状；`ui-requests.ts` 不导入 `./process.js`、`./runtime.js`、`./commands.js`；`server/src/sessions/omp/` 中只有 `process.ts` 向子进程 stdin 写出 `extension_ui_response`；size-guard 退出 0，knip 无未引用导出

#### Scenario: 运行时对 UI 请求模块只有类型依赖
- **WHEN** 检查 `server/src/sessions/omp/runtime.ts` 与 `commands.ts` 中引用 `./ui-requests.js` 的全部语句
- **THEN** 每一条都是语句级 `import type`，不存在值导入、副作用导入、动态导入或 re-export；两个文件都不含 `extension_ui_response` 字面量，也不引用应答帧构造函数

#### Scenario: 本地完成等待独立成模块
- **WHEN** 运行 `knip`、`bash scripts/size-guard.sh`、`wc -l server/src/sessions/omp/runtime.ts` 与 server 测试，并检查 `server/src/sessions/omp/` 的导入方向
- **THEN** `runtime.ts` ≤740 行；`runtime.ts` 从 `./local-wait.js` 引用等待类、从 `./commands.js` 引用回执结算；`local-wait.ts` 与 `commands.ts` 对 `./runtime.js` 都只有 `import type`（或不导入）；knip 无未引用导出；`omp-runtime-local-command.test.ts`、`omp-runtime-abort-start.test.ts` 与其余 runtime / process 测试文件不改一行全绿
