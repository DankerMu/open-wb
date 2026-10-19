# Spec Delta

## MODIFIED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 的 spawn 契约以该会话的有效审批档位启动（`--approval-mode` 取 `always-ask`、`write` 或 `yolo`，session-permission-tier「档位与 omp 审批模式」）。下面的识别规则与档位无关，也与被请求确认的是哪个工具无关：`always-ask` 档下写文件类工具（`write`、`edit` 等）的确认请求与 `write` 档下 bash 的确认请求走同一条路径；`yolo` 档下 omp 若仍发出符合形状的请求，同样按审批处理。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流：`method==="select"` 且 `options` 恰为 `["Approve","Deny"]`（顺序与内容精确）且 `title` 以 `Allow tool: ` 开头 → 视为审批请求向上抛出而不自动应答；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 不同的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。例外是浏览器调用（#912）：omp v18.0.10 的浏览器工具不在顶层，模型经 `write` 写虚拟路径 `xd://browser` 调用它，其审批 `title` 为 `Allow tool: write\nPath: xd://browser\nContent:\n<content>`（`<content>` 是浏览器参数 JSON，omp 按字段截到 2000 个 UTF-16 码元并加省略标记，截断后不是合法 JSON；omp 只在 `always-ask` 与 `write` 档对它请求审批）。`title` 以 `Allow tool: write\nPath: ` 开头、其后含 `\nContent:\n`，且两者之间的文本（第一处 `\nContent:\n` 之前的全部，路径本身含换行时也是）按 browser-runtime「浏览器操作的可读描述」判定为浏览器设备的路径时（与 omp 同一规则：`[xd://browser]`、`[xd://browser#ABCD]`、`XD://browser`、夹带制表符或换行的写法同样算），工具名 SHALL 记为 `browser`，`title` SHALL 改写：第一处 `\nContent:\n` 之后的全部文本按 browser-runtime「浏览器操作的可读描述」解析成功时，改写为该描述的摘要行与标志行，`action` 为 `run` 且参数带字符串 `code` 时再接 `代码：` 一行与 `code` 原文，各段以 `\n` 相接；解析失败时改写为 `浏览器操作（参数过长，以下为原文）` 一行、`⚠ 参数被截断，无法确认是否启动外部程序或连接外部浏览器` 一行，再接该处之后的原文。改写在审批登记之前完成：`chat_approvals.tool`/`title`、`approval.request` 事件、与步骤的按名配对（工具步骤的登记名同为 `browser`，chat-stream「纯协议事件归约」）与审计 `detail.tool` 都只用改写后的值。其它任何审批的工具名与 `title` 不变。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。

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

#### Scenario: 浏览器调用的审批改写为浏览器操作
- **WHEN** 档位 `write` 的会话里依次收到三个审批请求，`title` 分别为 `Allow tool: write\nPath: xd://browser\nContent:\n{"action":"open","url":"https://example.com/a"}`、`Allow tool: write\nPath: xd://browser\nContent:\n{"action":"run","name":"main","code":"return await tab.screenshot()","app":{"cdp_url":"http://10.0.0.5:9222"}}`、`Allow tool: write\nPath: xd://browser\nContent:\n{"action":"run","code":"x[…5000ch elided…]"`（截断、不是合法 JSON）
- **THEN** 三者都作为审批请求上抛，`tool="browser"`；`title` 依次恰为 `浏览器：打开 https://example.com/a`、`浏览器：在标签页 main 执行脚本\n⚠ 连接外部浏览器：http://10.0.0.5:9222\n代码：\nreturn await tab.screenshot()`、`浏览器操作（参数过长，以下为原文）\n⚠ 参数被截断，无法确认是否启动外部程序或连接外部浏览器\n{"action":"run","code":"x[…5000ch elided…]"`；`chat_approvals` 的 `tool`/`title` 与 `approval.request` 事件同为这些值，作答后 `session.approval` 审计的 `detail.tool="browser"`；随后同一调用的 `browser` 步骤与该审批配对
- **WHEN** 审批 `title` 的第二行分别为 `Path: [xd://browser]`、`Path: [xd://browser#0A1B]`、`Path: XD://browser`，以及路径为 `xd://browser` 后接一个换行（`Path: xd://browser` 与 `Content:` 之间多出一个空行），其余与第一例相同
- **THEN** 四者都识别为 `browser`，`title` 与第一例相同
- **WHEN** 审批 `title` 为 `Allow tool: write\nPath: notes/xd://browser`，或 `Allow tool: write\nPath: xd://browser2\nContent:\n{}`，或 `Allow tool: write\nPath: xd://Browser\nContent:\n{}`
- **THEN** 三者都按普通 `write` 审批处理，`tool="write"`，`title` 为原文
