## ADDED Requirements

### Requirement: 假 omp host tool 场景
假 omp SHALL 另支持场景 `host-tool` 与 `host-tool-abort`，帧形按 `docs/reviews/2026-11-10-omp-host-tools.md` §2.3、§2.4、§2.7（v18.12.3 实测）：
- **`set_host_tools`**：两个场景都应答 `{command:"set_host_tools", success:true, data:{toolNames:<请求里各定义的 name>}}`，并把请求记入入站帧记录。
- **`host-tool`**：prompt 回合在 `agent_start` 之后依次发两次 `kb_search` 调用。
  - 每次调用的 `arguments` 为 `{question, kb_ids}`：取 prompt 文本里 `KB:<kbId>` 记号给出的 kb_id，第一次的 `question` 为 prompt 文本，第二次为 prompt 文本加 ` 详细说明`。
  - `tool_execution_start` 带顶层 `intent`，值为 `第 <n> 轮`。
  - 帧序随 argv 的 `--approval-mode`：
    - `yolo`：`host_tool_call`、`tool_execution_start`。
    - `write`、`always-ask`：`tool_execution_start`，然后是 `extension_ui_request{method:"select", title:"Allow tool: kb_search", options:["Approve","Approve kb_search for this session","Deny"]}`，收到 `Approve` 才发 `host_tool_call`；收到 `Deny` 时以失败的 `tool_execution_end` 结束这次调用。
  - 收到对应 `id` 的 `host_tool_result` 后，发 `tool_execution_end{result:<收到的 result 原样>, isError:<收到的 isError 是否为真>}`。
  - 两次调用都结束后发正文与终态 `agent_end`。
- **`host-tool-abort`**：发出第一次 `host_tool_call` 之后不等应答。收到 `abort` 时，依次发 `host_tool_cancel{targetId}`、`tool_execution_end{isError:true, result:{content:[{type:"text", text:"Host tool \"kb_search\" was aborted"}]}}`、`turn_end{stopReason:"aborted"}` 与终态 `agent_end`，再应答 `abort`。之后收到的 `host_tool_result` 被记录但不产生任何帧。

#### Scenario: 场景帧序
- **WHEN** 以 `--approval-mode yolo` 选 `host-tool`，发 `set_host_tools` 与 prompt `查一下 KB:k1`，对两次 `host_tool_call` 各回一个结果
- **THEN** 输出依次含 `set_host_tools` 的成功应答、第一次 `host_tool_call{arguments:{question:"查一下 KB:k1", kb_ids:["k1"]}}`、它的 `tool_execution_start{intent:"第 1 轮"}` 与 `tool_execution_end`、第二次调用（`question` 末尾为 ` 详细说明`）及其两帧，最后是终态 `agent_end`；入站帧记录含两帧 `host_tool_result`
- **WHEN** 以 `--approval-mode write` 选同一场景
- **THEN** 每次 `host_tool_call` 之前都有 `Allow tool: kb_search` 的 `select`，未应答之前不发 `host_tool_call`

#### Scenario: 中止
- **WHEN** 选 `host-tool-abort`，第一次 `host_tool_call` 之后发 `abort`，再发该调用的 `host_tool_result`
- **THEN** 输出依次为 `host_tool_cancel{targetId:<该调用 id>}`、失败的 `tool_execution_end`、`turn_end{stopReason:"aborted"}`、`agent_end`、`abort` 的成功应答；迟到的结果之后没有新帧

### Requirement: 受控上游知识库检索标记
受控假上游 SHALL 支持标记 `WORKBUDDY_KB_SEARCH:<kbId>`（`kbId` 到下一个空白为止，空即无标记）。以本回合最后一条 user 消息之后的 `role:"tool"` 消息条数为准：
- 0 条：回一次 `kb_search` 调用，`arguments` 为 `{question:<去掉标记后的 user 文本，首尾空白去掉>, kb_ids:[kbId], i:"第 1 轮"}`。
- 1 条：回第二次 `kb_search`，`question` 为第一次的问句加 ` 详细说明`，`i` 为 `第 2 轮`。
- 2 条及以上：回固定正文 `已根据知识库检索结果作答。`。

只有请求的 `tools` 里有 `kb_search` 时标记才生效；没有时按无标记处理，以便证明注册失效时不会凭空出现调用。

#### Scenario: 标记的三个阶段
- **WHEN** 向假上游依次发三次请求：user 文本 `WORKBUDDY_KB_SEARCH:k1 工单超时`、`tools` 含 `kb_search`，其后分别带 0、1、2 条 tool 消息
- **THEN** 前两次回 `kb_search` 调用，`question` 依次为 `工单超时` 与 `工单超时 详细说明`，`kb_ids` 都是 `["k1"]`；第三次回正文 `已根据知识库检索结果作答。`
- **WHEN** 同一 user 文本而 `tools` 不含 `kb_search`
- **THEN** 按无标记的缺省回合应答
