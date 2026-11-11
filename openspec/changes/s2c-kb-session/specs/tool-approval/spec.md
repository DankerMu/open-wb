## MODIFIED Requirements

### Requirement: 审批请求识别
omp 子进程 SHALL 按 omp-runtime 的 spawn 契约以该会话的有效审批档位启动（`--approval-mode` 取 `always-ask`、`write` 或 `yolo`，session-permission-tier「档位与 omp 审批模式」）。除下文 `kb_search` 的传输层放行之外，下面的识别规则与档位无关，也与被请求确认的是哪个工具无关：`always-ask` 档下写文件类工具（`write`、`edit` 等）的确认请求与 `write` 档下 bash、eval 的确认请求走同一条路径；`yolo` 档下 omp 若仍发出符合形状的请求，同样按审批处理。`OmpProcess` 收到 `extension_ui_request` 时 SHALL 分流（omp-runtime「RPC IO and child observation」）：`method==="select"`、`title` 以 `Allow tool: ` 开头、首行工具名不是 `browser`，且 `options` 恰为两种闭合形状之一——`["Approve","Deny"]`，或恰三项、首项 `Approve`、末项 `Deny`、中间一项匹配 `^Approve .+ for this session$`（omp v18.12.3 对被档位抬高的 bash / write / edit / eval / task 提示附带的「本会话内放行」选项，其中的名字是 omp 的策略键、不钉成工具名）→ 视为审批请求向上抛出而不自动应答，`tool` 与 `title` 都是原文；`title` 整体恰为 `Allow tool: browser`、或恰为 `Allow tool: browser\nReason: <不含换行的一行>`，且 `options` 恰为 `["Approve","Deny"]` 的 `select` 是浏览器 eval prelude 的卡，由进程自己立即应答 `Approve`、不作为审批（#1563，owner 2026-10-20；痕迹见 browser-runtime「浏览器调用审计」）——题目按整体匹配：omp v18.0.10 真 `browser` 工具的 `Allow tool: browser\nAction: …` 卡不是 prelude 卡，落入 cancel（omp-runtime「RPC IO and child observation」）；其它任何 `extension_ui_request`（含 `confirm`/`input`/`editor`、options 为其它形状的 `select`、title 不匹配的 `select`）SHALL 维持既有行为，立即以 `{type:"extension_ui_response",id,cancelled:true}` 回绝。工具名 SHALL 取 `title` 首行 `Allow tool: <name>` 的 `<name>`（去首尾空白），解析为空则记为 `unknown`，但仍走审批流。宿主作答 SHALL 只写 `Approve` 或 `Deny`，永远不写中间那一项：omp 的「本会话内放行」是其进程内存里的授权集合，宿主不向用户暴露它。`eval` 的审批 `title` 是 `Allow tool: eval\nLanguage: <语言>\nCode:\n<代码>`（omp 把代码截到 2000 个 UTF-16 码元后加省略标记，与 bash 的 `Command:` 同一规则），宿主 SHALL 原样登记与发布，不改写、不改名（owner 2026-10-20 Q4：用户在卡上看到的就是将要执行的代码）；v18.0.10 时代对 `write xd://browser` 的浏览器改写已删除（browser-runtime「浏览器操作的可读描述」REMOVED）。审批帧 SHALL 不进入 `applyFrame` 归约（归约器对其无事件、无状态变化）。
**`kb_search` 的传输层放行**（2026-11-10 owner 拍板；`docs/reviews/2026-11-10-omp-host-tools.md` §2.4）：
- **形状**：`method==="select"`、`title` 整体恰为 `Allow tool: kb_search`、`options` 为上述两种闭合形状之一的请求，先于上面的审批识别判定。
- **非 `always-ask` 档**：这一代进程以 `write` 或 `yolo` 启动时，`OmpProcess` SHALL 立即写 `{type:"extension_ui_response", id, value:"Approve"}`。不登记审批、不发审批事件、不写 `chat_approvals`、不审计，与浏览器预载卡同一写法。
- **`always-ask` 档**：按审批识别照常交给所有者，`tool="kb_search"`。
- **其余**：`title` 带第二行或工具名不同的请求不适用本条。

理由：`kb_search` 只读、只检索调用者自己的库，过滤在宿主手里，不是「命令」；`always-ask` 的承诺是每次都问。

#### Scenario: 识别为审批
- **WHEN** fake-omp `approval` 脚本在 `message_end(toolUse)` 与 bash 的 `tool_execution_start` 之后（与真 omp v18.12.3 实测一致）发 `extension_ui_request{id:"r1",method:"select",title:"Allow tool: bash\nCommand: echo workbuddy-smoke",options:["Approve","Approve bash for this session","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="bash"`，`title` 为原文
- **WHEN** 同一 title 的 select 的 `options` 为 `["Approve","Deny"]`（工具自带的强制提示，如 bash 的 `Critical pattern detected`），或 `["Approve","Approve shell:echo for this session","Deny"]`
- **THEN** 两者同样作为审批上抛，`tool="bash"`

#### Scenario: 非审批 UI 请求仍回绝
- **WHEN** 子进程发 `extension_ui_request{method:"confirm"}`、`{method:"input"}`、`{method:"select",options:["A","B"]}`、`{method:"select",title:"Pick one",options:["Approve","Deny"]}`、`{method:"select",title:"Allow tool: bash",options:["Approve","Approve bash","Deny"]}`（中间项不含 `for this session`）或 `{method:"select",title:"Allow tool: bash",options:["Approve","Approve bash for this session","Deny","Other"]}`
- **THEN** 每个都立即收到对应 id 的 `cancelled:true`，不向 owner 上抛审批请求

#### Scenario: 工具名解析失败
- **WHEN** 审批 `title` 为 `Allow tool: ` 后紧跟换行
- **THEN** 仍作为审批请求上抛给 owner，`tool="unknown"`，不被自动回绝

#### Scenario: 写文件工具的确认同样识别为审批
- **WHEN** fake-omp `approval-write` 脚本（argv 含 `--approval-mode always-ask`）在 `message_end(toolUse)` 与 write 的 `tool_execution_start` 之后发 `extension_ui_request{id:"w1",method:"select",title:"Allow tool: write\nPath: workbuddy-report.html",options:["Approve","Approve write for this session","Deny"]}`
- **THEN** stdin 未收到 `cancelled` 应答；`OmpProcess` 的 owner 收到审批请求，`tool="write"`，`title` 为原文；随后的登记、事件、作答、超时与审计与 bash 审批相同（`chat_approvals.tool="write"`，`session.approval` 的 `detail.tool="write"`）

#### Scenario: 浏览器调用的审批改写为浏览器操作
- **WHEN** 档位 `write` 的会话里收到 `title` 为 `Allow tool: eval\nLanguage: javascript\nCode:\nawait browser.open({ name: "main", url: "https://example.com/a" });` 的审批请求（`options` 为三项形状）；另一次收到 `title` 为 `Allow tool: write\nPath: xd://browser\nContent:\n{"action":"open","url":"https://example.com/a"}` 的两项审批（#1563 之前被改写成「浏览器：打开 …」的那种 title）
- **THEN** （标题沿用 #1563 之前的规格以便归档保留该场景；它命名的行为被 #1563 反转）两者都不再改写为浏览器操作——`xd-browser.ts` 已删：前者作为审批上抛，`tool="eval"`，`title` 逐字为原文；`chat_approvals` 的 `tool`/`title` 与 `approval.request` 事件同为这些值，作答后 `session.approval` 审计的 `detail.tool="eval"`；作答 `allow` 时发给子进程的值恰为 `Approve`；后者 `tool="write"`、`title` 原文，没有 `浏览器：` 前缀与 ⚠ 行

#### Scenario: 浏览器审批与浏览器步骤配对
- **WHEN** 上例 `eval` 的审批之后到达同一调用的 `tool_execution_start{toolName:"eval"}`（或反序），其间与之后子进程发出若干 `Allow tool: browser` 的 prelude 卡
- **THEN** 该审批与该 `eval` 步骤按「确认与步骤配对」以名字 `eval` 配对（`step.start.approvalId` 或 `approval.request.stepId` 之一非 null，快照 `stepId` 为该步骤 id）；prelude 卡不进入未配对审批队列，也不改变配对结果

#### Scenario: 浏览器 prelude 的卡不是审批
- **WHEN** 一个已批准的 `eval` 步骤运行中，子进程发 `extension_ui_request{id:"p1",method:"select",title:"Allow tool: browser",options:["Approve","Deny"]}`
- **THEN** 子进程立即收到 `{id:"p1",value:"Approve"}`；owner 没有收到审批请求，`chat_approvals` 没有新行，没有 `approval.request` 事件，没有 `session.approval` 审计；回合结束时没有滞留的未配对审批
- **WHEN** 子进程发 `{id:"p2",method:"select",title:"Allow tool: browser\nAction: open\nTab: main\nURL: https://example.com",options:["Approve","Deny"]}`（omp v18.0.10 真 `browser` 工具的卡）
- **THEN** 它收到 `{id:"p2",cancelled:true}`，不被自动放行、也不作为审批上抛

#### Scenario: `kb_search` 在 write 档由传输层放行
- **WHEN** 假 omp `host-tool` 场景以 `--approval-mode write` 运行，发 `extension_ui_request{id:"r1", method:"select", title:"Allow tool: kb_search", options:["Approve","Approve kb_search for this session","Deny"]}`
- **THEN** stdin 立即收到 `{type:"extension_ui_response", id:"r1", value:"Approve"}`；owner 没有收到审批请求；`chat_approvals` 没有新行；SSE 没有 `approval.request`

#### Scenario: `kb_search` 在 always-ask 档照常审批
- **WHEN** 同一场景以 `--approval-mode always-ask` 运行
- **THEN** 该请求作为审批上抛，`tool="kb_search"`，`title` 为原文；未作答之前 stdin 没有对 `r1` 的应答

#### Scenario: 只有恰好的标题适用放行
- **WHEN** `write` 档下收到 `title:"Allow tool: kb_search\nReason: x"` 或 `title:"Allow tool: kb_search_extra"` 的同形 select
- **THEN** 两者都不由传输层放行，按审批识别上抛
