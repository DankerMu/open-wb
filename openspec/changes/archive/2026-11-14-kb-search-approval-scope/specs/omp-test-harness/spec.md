# omp-test-harness Spec Delta

> kb-search-approval-scope（#2011）：假 omp 新增 `host-tool-register-conflict` 场景。

## MODIFIED Requirements

### Requirement: 假 omp host tool 场景
假 omp SHALL 另支持场景 `host-tool`、`host-tool-parallel`、`host-tool-abort`、`host-tool-register-fail` 与 `host-tool-register-conflict`，帧形按 `docs/reviews/2026-11-10-omp-host-tools.md` §2.3、§2.4、§2.7（v18.12.3 实测）：
- **`set_host_tools`**：`host-tool`、`host-tool-parallel`、`host-tool-abort` 三个场景都应答 `{command:"set_host_tools", success:true, data:{toolNames:<请求里各定义的 name>}}`，并把请求记入入站帧记录。
- **`host-tool`**：prompt 回合在 `agent_start` 之后依次发两次 `kb_search` 调用。
  - 每次调用的 `arguments` 为 `{question, kb_ids}`：取 prompt 文本里 `KB:<kbId>` 记号给出的 kb_id，第一次的 `question` 为 prompt 文本，第二次为 prompt 文本加 ` 详细说明`。
  - `tool_execution_start` 带顶层 `intent`，值为 `第 <n> 轮`。
  - 帧序随 argv 的 `--approval-mode`：
    - `yolo`：`host_tool_call`、`tool_execution_start`。
    - `write`、`always-ask`：`tool_execution_start`，然后是 `extension_ui_request{method:"select", title:"Allow tool: kb_search", options:["Approve","Approve kb_search for this session","Deny"]}`，收到 `Approve` 才发 `host_tool_call`；收到 `Deny` 时以失败的 `tool_execution_end` 结束这次调用。
  - 收到对应 `id` 的 `host_tool_result` 后，发 `tool_execution_end{result:<收到的 result 原样>, isError:<收到的 isError 是否为真>}`。
  - 两次调用都结束后发正文与终态 `agent_end`。
  - 分支命令 `get_branch_messages` / `branch`（含 argv 的 `--branch-entry`）与场景 `branch` 应答相同，供 regenerate 在注册之后走同一进程。
- **`host-tool-parallel`**：prompt 回合在 `agent_start` 之后、宿主应答任何一个之前，连发三个 `host_tool_call`：两个 `kb_search`（`kb_ids` 分别为 `KB:<kbId>` 记号给出的第一、二个 kb_id，没有第二个时重复第一个）与一个 `toolName:"other"`。每个调用的 `tool_execution_start` 紧随其 `host_tool_call`，帧序按 `yolo`，不论 argv 的档位。三个结果各自到达后，各发 `tool_execution_end`；全部结束后发正文与终态 `agent_end`。
- **`host-tool-register-fail`**：对 `set_host_tools` 回 `{id:<请求 id>, type:"response", command:"set_host_tools", success:false, error:"host tools rejected"}`；其余命令与无场景时相同。
- **`host-tool-register-conflict`**（kb-search-approval-scope，#2011）：同上，`error` 恰为 `RPC host tool "kb_search" conflicts with an existing tool`（v18.12.3 实测原文）；设环境变量 `WORKBUDDY_FAKE_CONFLICT_PREFIX=<串>` 时 `error` 为该串接冲突原文（用于「只认恰好相等」的对照）。不进 `SCENARIOS`、不接管 prompt，与 `host-tool-register-fail` 相同。
- **`host-tool-abort`**：发出第一次 `host_tool_call` 之后不等应答。收到 `abort` 时，依次发 `host_tool_cancel{targetId}`、`tool_execution_end{isError:true, result:{content:[{type:"text", text:"Host tool \"kb_search\" was aborted"}]}}`、`turn_end{stopReason:"aborted"}` 与终态 `agent_end`，再应答 `abort`。之后收到的 `host_tool_result` 被记录但不产生任何帧。

#### Scenario: 场景帧序
- **WHEN** 以 `--approval-mode yolo` 选 `host-tool`，发 `set_host_tools` 与 prompt `查一下 KB:k1`，对两次 `host_tool_call` 各回一个结果
- **THEN** 输出依次含 `set_host_tools` 的成功应答、第一次 `host_tool_call{arguments:{question:"查一下 KB:k1", kb_ids:["k1"]}}`、它的 `tool_execution_start{intent:"第 1 轮"}` 与 `tool_execution_end`、第二次调用（`question` 末尾为 ` 详细说明`）及其两帧，最后是终态 `agent_end`；入站帧记录含两帧 `host_tool_result`
- **WHEN** 以 `--approval-mode write` 选同一场景
- **THEN** 每次 `host_tool_call` 之前都有 `Allow tool: kb_search` 的 `select`，未应答之前不发 `host_tool_call`

#### Scenario: 并发与注册失败
- **WHEN** 选 `host-tool-parallel`，发 prompt `查一下 KB:k1 KB:k2`，暂不应答任何调用
- **THEN** 输出里依次有三个 `host_tool_call`（`kb_ids` 分别为 `["k1"]`、`["k2"]`，第三个 `toolName:"other"`），之前没有任何 `tool_execution_end`
- **WHEN** 选 `host-tool-register-fail`，发 `set_host_tools{id:"r1", tools:[…]}`
- **THEN** 输出恰一帧 `{id:"r1", type:"response", command:"set_host_tools", success:false, error:"host tools rejected"}`

#### Scenario: 中止
- **WHEN** 选 `host-tool-abort`，第一次 `host_tool_call` 之后发 `abort`，再发该调用的 `host_tool_result`
- **THEN** 输出依次为 `host_tool_cancel{targetId:<该调用 id>}`、失败的 `tool_execution_end`、`turn_end{stopReason:"aborted"}`、`agent_end`、`abort` 的成功应答；迟到的结果之后没有新帧

#### Scenario: 注册冲突场景
- **WHEN** 选 `host-tool-register-conflict`，发 `set_host_tools{id:"r1", tools:[…]}`；另一例同时设 `WORKBUDDY_FAKE_CONFLICT_PREFIX=x`
- **THEN** 前者应答 `{id:"r1", type:"response", command:"set_host_tools", success:false, error:"RPC host tool "kb_search" conflicts with an existing tool"}`；后者 `error` 为 `xRPC host tool "kb_search" conflicts with an existing tool`
