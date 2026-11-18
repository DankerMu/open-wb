## MODIFIED Requirements

### Requirement: `kb_search` 的注册
会话 slot 的 omp 进程 SHALL 按以下规则注册并执行宿主工具 `kb_search`。fork 与撤回的临时进程 SHALL NOT 注册，也不注入处理函数：它们只执行命令，不跑模型回合，也不执行派发前对齐的第 2、3 步（chat-sessions「派发前按会话设置对齐进程」）。
- **定义来源**：`kb_search` 的定义由知识库模块按会话的所有者给出（knowledge-bases「会话检索 `kb_search`」）。知识库关闭，或对所有者可见的库一个都没有（knowledge-bases「可见范围判定」：自有库与共享给他的库都没有）时，没有定义。
- **注册与对齐**：是派发前对齐的第 3 步（chat-sessions「派发前按会话设置对齐进程」）：
  - 每个 generation 记下它上次成功注册的库清单（`[{id, name}]`），新 generation 为「尚未注册」。host tool 不随会话文件保存（记录 §2.8），所以 spawn 与 resume 出的每个新 generation 都从「尚未注册」开始。
  - 每次派发都重新取定义，与所记的库清单比较：有定义而尚未注册或清单不同时，发 `set_host_tools{tools:[<定义>]}`，带 `loadMode:"essential"`（缺省 `loadMode` 的工具对模型不可见，记录 §2.1）；没有定义而所记清单非空时，发 `set_host_tools{tools:[]}`；其余情形不发。
  - 应答须为 `success:true`，且 `data.toolNames` 恰为 `["kb_search"]`（撤下时为 `[]`），成功后才更新所记清单；否则按该步失败处理。
  - **注册冲突**（kb-search-approval-scope，#2011）：应答 `success:false` 且 `error` 整体恰为 `RPC host tool "kb_search" conflicts with an existing tool`（v18.12.3 实测，工作空间里有项目层同名工具 `.omp/tools/kb_search`；实测记录 §2.10）时，这一步 SHALL 以 409 `kb_tool_conflict` 失败；其余失败照旧是 502 `agent_unavailable`。两种失败的后续相同：slot 退役、受理被补偿、入站帧里没有 `prompt`；下一次派发照常重新 spawn 再试，不缓存冲突。omp 的 `error` 原文 SHALL NOT 进入 HTTP 响应、日志、审计或 SSE。
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

#### Scenario: 注册冲突
- **WHEN** 假 omp 以 `host-tool-register-conflict` 场景对 `set_host_tools` 回 `success:false`、`error:"RPC host tool "kb_search" conflicts with an existing tool"`；对照：同一场景的 `error` 带前缀或后缀（如 `xRPC host tool "kb_search" conflicts with an existing tool`）
- **THEN** 前者这次 prompt 以 409 `kb_tool_conflict` 失败，body 恰为 `{"error":{"code":"kb_tool_conflict","message":"工作空间里有同名的项目工具 kb_search（.omp/tools），与知识库检索冲突，改名或移除后再试"}}`；对照仍是 502 `agent_unavailable`
- **THEN** 两者都补偿受理、入站帧里没有 `prompt`、slot 被退役；响应、日志行与 SSE 都不含 omp 的 `error` 原文

#### Scenario: 临时进程不注册
- **WHEN** 所有者有库时对该会话 fork 一次、撤回一次
- **THEN** 两个临时进程的入站帧里都没有 `set_host_tools`

#### Scenario: 只以所有者执行
- **WHEN** 账号 A 有库 `kA`，账号 B 有库 `kB`；在 A 的会话里，假 omp `host-tool` 场景以 `kb_ids:["kB"]` 发 `host_tool_call`
- **THEN** stdin tee 截获的应答 `isError:true`，文本为 `知识库 kB：未找到该知识库`；假 RAGFlow 没有收到检索请求
