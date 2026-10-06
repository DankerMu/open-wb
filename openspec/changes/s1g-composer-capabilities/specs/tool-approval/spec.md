## MODIFIED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 的 spawn 契约以该会话的有效审批档位启动（`--approval-mode` 取 `always-ask`、`write` 或 `yolo`，session-permission-tier「档位与 omp 审批模式」）。下面的识别规则与档位无关，也与被请求确认的是哪个工具无关：`always-ask` 档下写文件类工具（`write`、`edit` 等）的确认请求与 `write` 档下 bash 的确认请求走同一条路径；`yolo` 档下 omp 若仍发出符合形状的请求，同样按审批处理。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]`（顺序与内容精确）且 `title` 以 `Allow tool: ` 开头 → 视为审批请求向上抛出而不自动应答；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 不同的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 `message_end(toolUse)` 之后、bash 的 `tool_execution_start` 之前（与真 omp v18.0.10 实测一致）发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nCommand: echo workbuddy-smoke",options:["Approve","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="bash"`，`title` 为原文

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}` 或 `{method:"select",title:"Pick one",options:["Approve","Deny"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，不向 owner 上抛审批请求

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍作为审批请求上抛给 owner，`tool="unknown"`，不被自动回绝

#### Scenario: 写文件工具的确认同样识别为审批
- **WHEN** fake-omp `approval-write` 脚本（argv 含 `--approval-mode always-ask`）在 `message_end(toolUse)` 之后发 `extension_ui_request{id:"w1",method:"select",title:"Allow tool: write\nPath: workbuddy-report.html",options:["Approve","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="write"`，`title` 为原文；随后的登记、事件、作答、超时与审计与 bash 审批相同（`chat_approvals.tool="write"`，`session.approval` 的 `detail.tool="write"`）
