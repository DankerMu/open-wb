## ADDED Requirements

### Requirement: 宿主工具协议
`OmpProcess` SHALL 应答 omp 的宿主工具帧（`docs/reviews/2026-11-10-omp-host-tools.md` §2.3、§2.7，v18.12.3 实测），不论这一代进程上有没有正在派发的回合：
- **`host_tool_call{id, toolCallId, toolName, arguments}`**（`id` 为非空字符串）：
  - 交给构造时注入的宿主工具处理函数，同时给它一个中止信号。
  - 处理完成后写恰一帧 `{type:"host_tool_result", id, result:{content:[{type:"text", text}], details?}, isError?}`：`details` 只在处理函数给出普通对象时出现，`isError` 只在为真时出现。
  - 同一进程的多个调用 SHALL 并发处理，互不等待。
  - 没有注入处理函数，或处理函数不认识 `toolName` 时，SHALL 回 `isError:true`，文本为 `未知工具`。
  - 处理函数抛错时 SHALL 回 `isError:true`，文本为 `工具执行失败`；错误原文 SHALL NOT 进入帧、stdout 或日志。
  - `id` 不是非空字符串的帧 SHALL 被忽略，不写任何帧。
- **`host_tool_cancel{targetId}`**：中止 `targetId` 对应的在途处理。之后该调用 SHALL NOT 再写 `host_tool_result`；没有对应在途处理时忽略。
- **进程退出或写端关闭**：中止全部在途处理，SHALL NOT 再写任何帧。
- 应答帧经既有的写入路径，遵守帧长上限（「Bounded lossless RPC transport」）。
- 步骤事件仍只由 `tool_execution_*` 帧驱动（chat-stream「纯协议事件归约」）。本协议不假定 `host_tool_call` 与 `tool_execution_start` 的先后（记录 §2.3：`yolo` 下前者先到，`write` / `always-ask` 下后者先到）。

#### Scenario: 调用与应答
- **WHEN** 假 omp `host-tool` 场景发 `host_tool_call{id:"h1", toolCallId:"c1", toolName:"kb_search", arguments:{question:"q", kb_ids:["k1"]}}`，注入的处理函数返回 `{text:"r", details:{bases:[]}, isError:false}`
- **THEN** 假 omp 的入站帧记录恰有一帧 `{type:"host_tool_result", id:"h1", result:{content:[{type:"text", text:"r"}], details:{bases:[]}}}`，没有 `isError` 键

#### Scenario: 并发
- **WHEN** 假 omp 连发两个 `host_tool_call`（`h1`、`h2`），处理函数对 `h1` 挂起、对 `h2` 立即返回
- **THEN** `h2` 的结果先写出，`h1` 放行后再写出；两个处理函数都在 `h1` 放行之前被调用

#### Scenario: 取消与迟到的结果
- **WHEN** 处理函数对 `h1` 挂起，假 omp 发 `host_tool_cancel{targetId:"h1"}`，随后放行处理函数
- **THEN** 处理函数收到的信号已中止；入站帧记录里没有 `h1` 的 `host_tool_result`
- **WHEN** 处理函数对 `h1` 挂起时子进程退出
- **THEN** 信号已中止，进程退出之后没有任何写入

#### Scenario: 未知工具与失败
- **WHEN** `toolName` 为 `other`；另一例没有注入处理函数；再一例处理函数抛出 `Error("secret-detail")`
- **THEN** 前两例回 `isError:true` 与文本 `未知工具`；第三例回 `isError:true` 与文本 `工具执行失败`，`secret-detail` 不出现在任何帧与 stderr 里

### Requirement: `kb_search` 的注册
会话 slot 的 omp 进程 SHALL 按以下规则注册宿主工具 `kb_search`。fork 与撤回的临时进程 SHALL NOT 注册（它们只执行命令，不跑模型回合）。
- **定义来源**：`kb_search` 的定义由知识库模块按会话的所有者给出（knowledge-bases「会话检索 `kb_search`」）。知识库关闭，或所有者一个库都没有时，没有定义。
- **注册**：进程握手成功之后、这一代进程的第一次派发之前，有定义就发 `set_host_tools{tools:[<定义>]}`，带 `loadMode:"essential"`。
  - 缺省 `loadMode` 的工具对模型不可见（记录 §2.1）。
  - 应答须为 `success:true` 且 `data.toolNames` 恰为 `["kb_search"]`，否则这次启动按握手失败处理（`agent_unavailable`）。
  - host tool 不随会话文件保存（记录 §2.8），所以每次 spawn（含 resume）都重新注册。
- **派发前对齐**：每次派发 `prompt` 之前重新取定义，与这一代进程上次注册的库清单（`[{id, name}]`）比较：
  - 不同：先发 `set_host_tools`，等应答后再派发。没有定义时发 `tools:[]`，应答的 `toolNames` 须为 `[]`。
  - 相同：不发。
  - 对齐失败按派发失败处理（`agent_unavailable`），不派发 `prompt`。
- 这一代进程从来没有定义时，SHALL NOT 发任何 `set_host_tools`：知识库关闭的部署与本要求之前的帧序逐字节相同。
- 回合进行中库清单变化时 SHALL NOT 重发；也 SHALL NOT 为了对齐而重新 spawn。

#### Scenario: 握手后注册
- **WHEN** 知识库开启，所有者有一个库，会话首次派发
- **THEN** 假 omp 的入站帧依次为 `negotiate_protocol`、`get_state`、`set_host_tools`（`tools` 恰一项，`name:"kb_search"`、`loadMode:"essential"`）、`prompt`

#### Scenario: 不注册
- **WHEN** 知识库关闭；另一例知识库开启而所有者没有库
- **THEN** 两例入站帧里都没有 `set_host_tools`，`prompt` 紧随 `get_state` 之后

#### Scenario: 库清单变化后重发
- **WHEN** 第一个回合结束后所有者新建一个库，再派发一次；随后删掉全部库，再派发一次
- **THEN** 第二次派发前有一帧 `set_host_tools`，其定义的描述列出两个库；第三次派发前有一帧 `set_host_tools{tools:[]}`；清单不变的派发之前没有 `set_host_tools`

#### Scenario: 注册失败
- **WHEN** 假 omp 对 `set_host_tools` 回 `success:false`
- **THEN** 这次 prompt 以 `agent_unavailable` 失败，入站帧里没有 `prompt`

#### Scenario: 临时进程不注册
- **WHEN** 所有者有库时对该会话 fork 一次、撤回一次
- **THEN** 两个临时进程的入站帧里都没有 `set_host_tools`

### Requirement: host tool 的真实 omp 回归
`kb_search` 的注册、调用、审批放行与 `details` 不进上游，SHALL 有一条以钉住的官方 omp 二进制跑的回归用例（`server/test/omp-official-host-tools.test.ts`，`WORKBUDDY_OMP_TEST=1` 门下，CI 跳过）：
- 服务端用应用装配起来，接受控假上游与假 RAGFlow，所有者有一个 `ready` 的库。
- 会话档位为 `write`，prompt 带受控上游的知识库检索标记（omp-test-harness「受控上游知识库检索标记」）。

#### Scenario: 两轮检索
- **WHEN** 官方 omp v18.12.3 跑上述回合到 `turn.end`
- **THEN** SSE 依次有两个名为 `kb_search` 的 `step.start` / `step.end` 与两条 `kb.hits`，没有 `approval.request`
- **THEN** 假 RAGFlow 恰收到两次检索请求，`question` 依次为原问句与改写后的问句
- **THEN** 受控上游的第二、第三次请求的 tool 消息只含 `kb_search` 给模型的文本，不含 `details` 里的键名 `bases`
