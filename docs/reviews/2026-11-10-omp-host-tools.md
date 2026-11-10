# omp v18.12.3 host tool 实测记录：S2c 会话内检索的协议前提

change `s2c-kb-session` 的 omp 事实只以本文件为准。本地参考克隆 `resource/oh-my-pi` 停在 v18.0.10（没有 v18.12.3 的 tag），
它的 `docs/rpc.md`（§`set_host_tools` payload、§Host Tool Sub-Protocol）只作背景；与本文件不符时以本文件为准。

## 1. 方法（2026-11-10）

- 二进制：`make omp-fetch` 装到 `var/omp/omp` 的官方 v18.12.3（darwin-arm64，SHA256 校验通过），`--version` 输出 `omp/18.12.3`。
- 进程：探针脚本导入 `npm run build` 产出的 `server/dist`，用 `spawnOmp`（`server/src/sessions/omp/process.ts:70`）起进程。
  argv、env、托管状态目录、host overlay（`writeHostOverlay`，`browserEnabled:false`）、托管 `models.yml`（`writeManagedModelsYml`）
  与 app-server 生产 spawn 一致。握手照 `OmpProcess`：等 `ready`，`negotiate_protocol` 协商到 2，`get_state`。
- 上游：探针自带的 OpenAI 兼容假上游，按脚本回 SSE。每次请求记录 `tools` 名单、`kb_search` 的工具定义与 `role:"tool"` 消息。
  **所有工具调用都是脚本发出的**：真实模型会不会调用 `kb_search`、会不会发起第二轮，本记录没有测。
- 工具定义：`{name:"kb_search", label, description, parameters:{question:string, kb_ids:string[]}, additionalProperties:false}`。
- 探针脚本与原始结果只保存在会话 scratchpad，不入库。

## 2. 结论

### 2.1 注册与可见性

- `set_host_tools` 的应答为 `{command:"set_host_tools", success:true, data:{toolNames:["kb_search"]}}`。
- **缺省 `loadMode` 时工具对模型不可见**：之后的上游请求里，`tools` 恰为 `read,bash,edit,eval,glob,grep,task,wait,todo,web_search,write`，
  没有 `kb_search`，也没有任何用来发现工具的工具；系统提示不提 `kb_search`。
- 定义带 `loadMode:"essential"` 时，`kb_search` 出现在 `tools` 末尾，系统提示也提到它。
- omp 改写参数 schema：在 `properties` 最前面加 `i: {type:"string", description:"concise intent"}`，并把 `i` 加进 `required`
  （上游看到的是 `required:["question","kb_ids","i"]`）。

### 2.2 参数里的 `i`

模型按改写后的 schema 传 `{i:"查工单超时规则", question:"工单超时", kb_ids:["kb1"]}` 时：

- `host_tool_call.arguments` 恰为 `{question:"工单超时", kb_ids:["kb1"]}`，没有 `i`。
- `tool_execution_start` 带顶层 `intent:"查工单超时规则"`，`args` 同样没有 `i`。

### 2.3 一次调用的帧

- `host_tool_call`：`{type, id, toolCallId, toolName:"kb_search", arguments}`。`id` 是 omp 生成的十六进制串，宿主用它应答；
  `toolCallId` 与 `tool_execution_*` 的 `toolCallId` 相同。
- 宿主应答 `{type:"host_tool_result", id, result:{content:[{type:"text", text}]}}` 后，omp 发 `tool_execution_end`
  （`result` 原样，`isError:false`），下一次上游请求带 `{role:"tool", content:<text>, tool_call_id}`。
- **帧序随审批档位不同**：
  - `yolo`：`host_tool_call` 先到，然后才是 `tool_execution_start`。
  - `write`、`always-ask`：`tool_execution_start` → 审批 `select` → 获准后才有 `host_tool_call`。
- `isError:true`：`tool_execution_end.isError` 为 `true`，`result.content` 为宿主给的文本；上游的 tool 消息就是这段文本。

### 2.4 审批

`write` 与 `always-ask` 下，每次调用都发：

```
{"type":"extension_ui_request","id":"<id>","method":"select","title":"Allow tool: kb_search",
 "options":["Approve","Approve kb_search for this session","Deny"]}
```

应答 `{type:"extension_ui_response", id, value:"Approve"}` 后调用继续。`yolo` 下不发。这个帧满足
`approvalRequest`（`server/src/sessions/omp/ui-requests.ts`）的全部条件，现有代码会把它当成普通审批推给所有者。
启动时另有一帧 `extension_ui_request{method:"setWidget", widgetKey:"autoresearch"}`，与审批无关。

没有测：Deny，以及选「Approve kb_search for this session」之后的行为。

### 2.5 `details` 与进度

- `host_tool_result.result.details` 原样进入 `tool_execution_end.result.details`，**不进上游**：tool 消息只有 `content` 的文本。
- `host_tool_update{id, partialResult:{content, details}}` 变成 `tool_execution_update{toolCallId, toolName, args, partialResult}`。

### 2.6 并发

模型在同一条回复里给出两个 `kb_search` 调用（`yolo`）：两个 `host_tool_call` 在宿主应答任何一个之前就都到了（1.5 s 内），
随后各自的 `tool_execution_start`；两个结果分别应答，各自 `tool_execution_end`。`write` 下的并行调用没有测。

### 2.7 中止

- 宿主不应答时，5 s 内 omp 不会自己让调用超时（更长时间没有测）。
- 发 `abort` 后：先 `host_tool_cancel{id, targetId:<host_tool_call 的 id>}`，再 `tool_execution_end`
  （`isError:true`，文本 `Host tool "kb_search" was aborted`），随后 `turn_end{stopReason:"aborted"}`、`agent_end`，`abort` 的应答成功。
- 取消之后宿主再发这次调用的 `host_tool_result`：omp 不报错，进程继续存活。

### 2.8 resume

用 `--resume <sessionFile>` 起新进程续接一个调用过 `kb_search` 的会话：

- 不发 `set_host_tools` 时，上游 `tools` 没有 `kb_search`；历史里旧的 `kb_search` 调用与 tool 消息照常回放。
- 发 `set_host_tools` 之后的下一次请求，`tools` 里重新有 `kb_search`。

host tool 不随会话文件保存：每个新进程都要重新注册。
