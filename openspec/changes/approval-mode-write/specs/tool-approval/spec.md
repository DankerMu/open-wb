# Spec delta: tool-approval（#481，父 tasks 2.1b）

> 以主 spec「审批请求识别」为底，只并入父 delta 同名块首句「omp 子进程 SHALL 按 omp-runtime 修订后的 spawn 契约以 `--approval-mode write` 启动。」（#460 归档时明确留给 #481）。三个 Scenario 保持主 spec 原样；其 THEN 中 supervisor/落库/事件表述（父文）属 #464 已交付行为但未随 #464 归档推进，不在本刀交付范围，留待 #486 收尾对账。

## MODIFIED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 修订后的 spawn 契约以 `--approval-mode write` 启动。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]`（顺序与内容精确）且 `title` 以 `Allow tool: ` 开头 → 视为审批请求向上抛出而不自动应答；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 不同的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 bash 的 `tool_execution_start` 之后、执行前发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nCommand: echo workbuddy-smoke",options:["Approve","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="bash"`，`title` 为原文

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}` 或 `{method:"select",title:"Pick one",options:["Approve","Deny"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，不向 owner 上抛审批请求

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍作为审批请求上抛给 owner，`tool="unknown"`，不被自动回绝
