## MODIFIED Requirements

### Requirement: RPC IO and child observation
The transport SHALL classify every `extension_ui_request` frame into four kinds; kind (0) is checked first, then (1), (2) and (3) as before. (0) A **kb_search card** (change `s2c-kb-session`, owner 2026-11-10; `docs/reviews/2026-11-10-omp-host-tools.md` §2.4): `method` is exactly `select`, the whole `title` is exactly `Allow tool: kb_search` (no further line) and `options` is one of the two closed approval shapes of kind (1). When this generation's process was started with approval mode `write` or `yolo`, the transport SHALL answer it immediately with `{type:"extension_ui_response",id,value:"Approve"}` and SHALL NOT expose, register or audit it (tool-approval「审批请求识别」); when it was started with `always-ask` the frame is handled as kind (1). The remaining three kinds. (1) An **approval request**: `method` is exactly `select`, the `title` string starts with `Allow tool: `, the tool name parsed from the first line of the title after `Allow tool: ` is not `browser`, and `options` is exactly one of the two closed shapes omp v18.12.3 emits — `["Approve","Deny"]`, or three items whose first is exactly `Approve`, whose last is exactly `Deny` and whose middle item matches `^Approve .+ for this session$` (the mode-raised prompt of bash, write, edit, eval and task; the middle item names omp's policy key, which need not equal the tool name, so it is matched by shape, not pinned to the name). The transport SHALL NOT answer it itself, SHALL expose it to its owner as an approval request carrying the frame `id`, the full `title` and the parsed `tool` name (parsing failure or empty name yields `unknown`, and the request still counts as an approval request), and SHALL keep the child waiting. (2) A **prelude card**: `method` is exactly `select`, the whole `title` is exactly `Allow tool: browser` or exactly `Allow tool: browser\nReason: <one line without a line break>` (nothing else: no further line, no other second line), and `options` is exactly `["Approve","Deny"]` — omp v18.12.3's browser eval prelude asks once per host call (`open`, `close`, `tabs`, `targets`, `run`, every tab helper) inside an `eval` that was already approved (or allowed by the tier); the card carries no action, URL or tool-call id (#1563, owner 2026-10-20). The transport SHALL answer it immediately with `{type:"extension_ui_response",id,value:"Approve"}`, SHALL NOT expose it as an approval request, SHALL NOT register or audit it (the trace is the `session.browser` audit derived from the eval step, browser-runtime「浏览器调用审计」), and SHALL expose only a `preludeApproval{id}` observation to its owner for tests and counting. The title is matched as a whole, not by its first line: `browser` is not a tool in v18.12.3, but omp v18.0.10 — which the host keeps running until the version flip of #1563 — has a real `browser` tool whose card is `Allow tool: browser\nAction: …\nTab: …[\nURL: …][\nCode:\n…]` with the same two options; it is mounted under `xd://` by default but a project-layer `tools.xdev: false` makes it a top-level tool, and the host overlay does not pin that key. Such a card SHALL fall into kind (3) and be cancelled, never auto-approved. (3) Every other extension UI request (any other `method`, a `select` with options of any other shape or a non-matching title, or a request lacking a string `id` handled as before) SHALL be cancelled immediately with `{type:"extension_ui_response",id:<request id>,cancelled:true}` exactly as before. The transport SHALL expose `respondApproval(id, decision)` that writes exactly one `{type:"extension_ui_response",id,value:"Approve"}` for `allow` or `{…,value:"Deny"}` for `deny` — the host never answers with the session-grant label, so omp's per-session approval set is never written; a second answer for the same `id` SHALL NOT be written. Apart from kind (0) under `write` / `yolo`, which is answered on arrival and never becomes an approval request, neither the transport nor SessionRuntime SHALL ever answer an approval request on its own under any condition — no timeout answer, no fallback `Deny`, no answer on stop, retirement, shutdown or child exit; `respondApproval` called by the owner is the only writer of an approval answer, and an approval left unanswered when the child exits simply ends with that child (settlement of its record is the owner's concern). The prelude card and the kb_search card of kind (0) under `write` / `yolo` are the only `extension_ui_request` frames the transport answers by itself; besides `extension_ui_response`, the only frames the transport writes on its own are the `host_tool_result` replies of「宿主工具协议」. It SHALL expose complete frames and one exit event containing code and signal, and handle child/stream/write errors without uncaught exceptions or unresolved pending command promises. It SHALL drain stderr without retaining raw unbounded payloads or logging credentials.

#### Scenario: Extension UI cancellation
- **WHEN** the fake requests extension UI during a prompt with a non-approval shape (`method` other than `select`; a `select` whose options are `["A","B"]`, `["Approve"]`, `["Approve","Deny","Other"]`, `["Approve","Approve bash","Deny"]` or `["Approve","Approve bash for this session","Deny","X"]`; or a `select` whose title does not start with `Allow tool: `)
- **THEN** it receives {type:extension_ui_response,id:the-request-id,cancelled:true} without user interaction and proceeds

#### Scenario: Approval request is surfaced, not cancelled
- **WHEN** the fake, spawned with `--approval-mode write`, sends `extension_ui_request{method:"select",title:"Allow tool: bash\n…",options:["Approve","Approve bash for this session","Deny"]}` after a bash `tool_execution_start`; separately one with options `["Approve","Deny"]`; separately one with options `["Approve","Approve shell:ls for this session","Deny"]`
- **THEN** no `extension_ui_response` is written for any of them until the owner answers, the owner observes one approval request per frame with that id, `tool` equal to `bash` and the original title, and the fake emits no further turn frames while it waits

#### Scenario: Approval answers map to exact values
- **WHEN** the owner answers an outstanding approval request with `allow`, and separately another with `deny`, and then answers either a second time
- **THEN** exactly one `extension_ui_response{id,value:"Approve"}` respectively `{id,value:"Deny"}` reaches the child (never the session-grant label), the fake proceeds (executing on Approve, reporting `tool_execution_end{isError:true}` on Deny), and the second answer writes nothing
- **WHEN** the title first line cannot be parsed as `Allow tool: <name>`
- **THEN** the request is still surfaced as an approval request with `tool` equal to `unknown` and is not auto-cancelled

#### Scenario: Prelude card is answered by the transport
- **WHEN** during an `eval` step the child sends `extension_ui_request{id:"p1",method:"select",title:"Allow tool: browser",options:["Approve","Deny"]}`, then one with title `Allow tool: browser\nReason: target not yet approved`
- **THEN** each immediately receives `{type:"extension_ui_response",id,value:"Approve"}`, the owner observes `preludeApproval{id}` for each and no approval request, no `chat_approvals` row and no audit row is created for them, and the child proceeds
- **WHEN** the child sends `{method:"select",title:"Allow tool: browser",options:["Approve","Approve browser for this session","Deny"]}`, a `confirm` whose title is `Allow tool: browser`, a `select` whose title is `Allow tool: browser\nAction: open\nTab: main\nURL: https://example.com` with options `["Approve","Deny"]` (omp v18.0.10's real `browser` tool), one whose title is `Allow tool: browser\nReason: a\nb` (a second line after `Reason:`), or one whose title is `Allow tool: browser ` (trailing space)
- **THEN** all are cancelled (not answered `Approve`), none is surfaced as an approval request, and the owner observes no `preludeApproval`

#### Scenario: Unanswered approval is never answered by the runtime
- **WHEN** an approval request is outstanding and the owner does not call `respondApproval`, while the injected clock advances well past 60000ms and the generation is then retired or shut down
- **THEN** no `extension_ui_response` (neither `Approve`, `Deny` nor `cancelled`) is ever written for that id by the transport or runtime; retirement proceeds with the normal stdin→TERM→KILL contract

#### Scenario: Child crash or write failure
- **WHEN** a child crashes, is signalled, fails to spawn, or a command cannot be written
- **THEN** affected promises reject, no readiness is fabricated, and actual child exits report their original code/signal exactly once

#### Scenario: kb_search card by approval mode
- **WHEN** a child started with `--approval-mode write` sends `extension_ui_request{id:"k1",method:"select",title:"Allow tool: kb_search",options:["Approve","Approve kb_search for this session","Deny"]}`; separately a child started with `--approval-mode always-ask` sends the same frame
- **THEN** the first child immediately receives `{type:"extension_ui_response",id:"k1",value:"Approve"}` and the owner observes no approval request and no `preludeApproval`; the second child receives no answer and the owner observes an approval request with `tool="kb_search"`

## ADDED Requirements

### Requirement: 宿主工具协议
`OmpProcess` SHALL 应答 omp 的宿主工具帧（`docs/reviews/2026-11-10-omp-host-tools.md` §2.3、§2.7，v18.12.3 实测），不论这一代进程上有没有正在派发的回合：
- **`host_tool_call{id, toolCallId, toolName, arguments}`**（`id` 为非空字符串）：
  - 交给构造时注入的宿主工具处理函数，同时给它一个中止信号。处理函数是这一代进程构造时绑定的，进程存活期间不变（「`kb_search` 的注册」规定它为谁执行）。
  - 处理完成后写恰一帧 `{type:"host_tool_result", id, result:{content:[{type:"text", text}], details?}, isError?}`：`details` 只在处理函数给出普通对象时出现，`isError` 只在为真时出现。
  - 同一进程的多个调用 SHALL 并发处理，互不等待。
  - 没有注入处理函数，或处理函数不认识 `toolName` 时，SHALL 回 `isError:true`，文本为 `未知工具`。
  - 处理函数抛错时 SHALL 回 `isError:true`，文本为 `工具执行失败`；错误原文 SHALL NOT 进入帧、stdout 或日志。
  - `id` 不是非空字符串的帧 SHALL 被忽略，不写任何帧。
- **帧长**：应答帧经既有的写入路径，遵守物理帧长上限（「Bounded lossless RPC transport」，至多 1 MiB）。序列化后超过上限时，SHALL 先去掉 `details` 重新序列化；仍超过时，SHALL 改写恰一帧 `{type:"host_tool_result", id, result:{content:[{type:"text", text:"工具结果过大"}]}, isError:true}`。无论哪种情形，每个调用都恰有一帧应答，omp 不会因为宿主没有应答而挂起（记录 §2.7：宿主不应答时 omp 至少 5 s 内不会自己让调用超时，更长时间没有测，所以不能依赖 omp 超时）。
- **`host_tool_cancel{targetId}`**：中止 `targetId` 对应的在途处理。之后该调用 SHALL NOT 再写 `host_tool_result`；没有对应在途处理时忽略。
- **进程退出或写端关闭**：中止全部在途处理，SHALL NOT 再写任何帧。
- 步骤事件仍只由 `tool_execution_*` 帧驱动（chat-stream「纯协议事件归约」）。本协议不假定 `host_tool_call` 与 `tool_execution_start` 的先后（记录 §2.3：`yolo` 下前者先到，`write` / `always-ask` 下后者先到）。

本要求的场景经测试对子进程 stdin 的截获（stdin tee）观察宿主写出的帧与载荷；假 omp 的入站帧记录只有帧类型（omp-test-harness「假 omp 入站帧记录」）。

#### Scenario: 调用与应答
- **WHEN** 假 omp `host-tool` 场景发 `host_tool_call{id:"h1", toolCallId:"c1", toolName:"kb_search", arguments:{question:"q", kb_ids:["k1"]}}`，注入的处理函数返回 `{text:"r", details:{bases:[]}, isError:false}`
- **THEN** stdin tee 截获恰一帧 `{type:"host_tool_result", id:"h1", result:{content:[{type:"text", text:"r"}], details:{bases:[]}}}`，没有 `isError` 键

#### Scenario: 并发
- **WHEN** 假 omp `host-tool-parallel` 场景在任何结果之前连发两个 `host_tool_call`（`h1`、`h2`），处理函数对 `h1` 挂起、对 `h2` 立即返回
- **THEN** `h2` 的结果先写出，`h1` 放行后再写出；两个处理函数都在 `h1` 放行之前被调用

#### Scenario: 取消与迟到的结果
- **WHEN** 处理函数对 `h1` 挂起，假 omp `host-tool-abort` 场景在收到 `abort` 时发 `host_tool_cancel{targetId:"h1"}`，随后放行处理函数
- **THEN** 处理函数收到的信号已中止；stdin tee 没有截获 `h1` 的 `host_tool_result`
- **WHEN** 处理函数对 `h1` 挂起时子进程退出
- **THEN** 信号已中止，进程退出之后没有任何写入

#### Scenario: 未知工具与失败
- **WHEN** 假 omp `host-tool-parallel` 场景的第三个调用 `toolName` 为 `other`；另一例没有注入处理函数；再一例处理函数抛出 `Error("secret-detail")`
- **THEN** 前两例回 `isError:true` 与文本 `未知工具`；第三例回 `isError:true` 与文本 `工具执行失败`，`secret-detail` 不出现在任何帧与 stderr 里

#### Scenario: 结果过大
- **WHEN** 处理函数返回的 `text` 与 `details` 合起来超过物理帧长上限、`text` 本身不超过；另一例 `text` 本身超过上限
- **THEN** 前者 stdin tee 截获恰一帧应答，不含 `details`、文本原样；后者恰一帧 `isError:true`、文本 `工具结果过大`；两例的回合都能走到终态 `agent_end`

### Requirement: `kb_search` 的注册
会话 slot 的 omp 进程 SHALL 按以下规则注册并执行宿主工具 `kb_search`。fork 与撤回的临时进程 SHALL NOT 注册，也不注入处理函数：它们只执行命令，不跑模型回合，也不执行派发前对齐的第 2、3 步（chat-sessions「派发前按会话设置对齐进程」）。
- **定义来源**：`kb_search` 的定义由知识库模块按会话的所有者给出（knowledge-bases「会话检索 `kb_search`」）。知识库关闭，或所有者一个库都没有时，没有定义。
- **注册与对齐**：是派发前对齐的第 3 步（chat-sessions「派发前按会话设置对齐进程」）：
  - 每个 generation 记下它上次成功注册的库清单（`[{id, name}]`），新 generation 为「尚未注册」。host tool 不随会话文件保存（记录 §2.8），所以 spawn 与 resume 出的每个新 generation 都从「尚未注册」开始。
  - 每次派发都重新取定义，与所记的库清单比较：有定义而尚未注册或清单不同时，发 `set_host_tools{tools:[<定义>]}`，带 `loadMode:"essential"`（缺省 `loadMode` 的工具对模型不可见，记录 §2.1）；没有定义而所记清单非空时，发 `set_host_tools{tools:[]}`；其余情形不发。
  - 应答须为 `success:true`，且 `data.toolNames` 恰为 `["kb_search"]`（撤下时为 `[]`），成功后才更新所记清单；否则按该步失败处理。
  - 这一代进程从来没有定义时，SHALL NOT 发任何 `set_host_tools`：知识库关闭的部署与本要求之前的帧序逐字节相同。
  - 回合进行中库清单变化时 SHALL NOT 重发；也 SHALL NOT 为了对齐而重新 spawn。
- **执行身份**：slot 的处理函数 SHALL 在构造这一代进程时绑定为「以该会话的所有者执行 `kb_search`」，与定义所针对的账号相同，进程存活期间不变。模型传入的任何 kb_id 都只按这个所有者判定（knowledge-bases「会话检索 `kb_search`」的 `not_found` 规则）。

本要求的帧序场景在 slot 层观察（假 omp 的入站帧记录）。所用会话的有效模型不支持推理，所以 `set_model` 之后没有 `set_thinking_level`（model-selection「模型与推理强度」）。

#### Scenario: 首次派发前注册
- **WHEN** 知识库开启，所有者有一个库，会话首次派发
- **THEN** 假 omp 的入站帧依次为 `negotiate_protocol`、`get_state`、`set_model`、`set_host_tools`、`prompt`；stdin tee 截获的 `set_host_tools` 的 `tools` 恰一项，`name:"kb_search"`、`loadMode:"essential"`

#### Scenario: 不注册
- **WHEN** 知识库关闭；另一例知识库开启而所有者没有库
- **THEN** 两例入站帧都是 `negotiate_protocol`、`get_state`、`set_model`、`prompt`，没有 `set_host_tools`

#### Scenario: 库清单变化后重发
- **WHEN** 第一个回合结束后所有者新建一个库，再派发一次；随后删掉全部库，再派发一次；再派发一次
- **THEN** 第二次派发的 `prompt` 之前有一帧 `set_host_tools`，其定义的描述列出两个库；第三次之前有一帧 `set_host_tools{tools:[]}`；第四次之前没有 `set_host_tools`

#### Scenario: 空闲回收后重新注册
- **WHEN** 第一个回合之后进程被空闲回收，库清单不变，再派发一次
- **THEN** 新进程的入站帧在 `prompt` 之前又有一帧 `set_host_tools`

#### Scenario: 注册失败
- **WHEN** 假 omp 以 `host-tool-register-fail` 场景对 `set_host_tools` 回 `success:false`
- **THEN** 这次 prompt 以 502 `agent_unavailable` 失败，受理对被补偿，入站帧里没有 `prompt`，该 slot 被退役

#### Scenario: 临时进程不注册
- **WHEN** 所有者有库时对该会话 fork 一次、撤回一次
- **THEN** 两个临时进程的入站帧里都没有 `set_host_tools`

#### Scenario: 只以所有者执行
- **WHEN** 账号 A 有库 `kA`，账号 B 有库 `kB`；在 A 的会话里，假 omp `host-tool` 场景以 `kb_ids:["kB"]` 发 `host_tool_call`
- **THEN** stdin tee 截获的应答 `isError:true`，文本为 `知识库 kB：未找到该知识库`；假 RAGFlow 没有收到检索请求

### Requirement: host tool 的真实 omp 回归
`kb_search` 的注册、调用、审批放行与 `details` 不进上游，SHALL 有一条以钉住的官方 omp 二进制跑的回归用例（`server/test/omp-official-host-tools.test.ts`，`WORKBUDDY_OMP_TEST=1` 门下，CI 跳过）：
- 服务端用应用装配起来，接受控假上游与假 RAGFlow，所有者有一个 `ready` 的库。
- 会话档位为 `write`，prompt 带受控上游的知识库检索标记（omp-test-harness「受控上游知识库检索标记」）。

#### Scenario: 两轮检索
- **WHEN** 官方 omp v18.12.3 跑上述回合到 `turn.end`
- **THEN** SSE 依次有两个名为 `kb_search` 的 `step.start` / `step.end` 与两条 `kb.hits`，每条 `kb.hits` 的 `stepId` 等于它之前那个 `step.start` 的 `stepId`；没有 `approval.request`
- **THEN** 假 RAGFlow 恰收到两次检索请求，`question` 依次为原问句与改写后的问句
- **THEN** 受控上游的第二、第三次请求的 tool 消息只含 `kb_search` 给模型的文本，不含 `details` 里的键名 `bases`
