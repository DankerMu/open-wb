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
- 2026-11-14（#2004）补测 §2.1 撤下、§2.4 Deny、§2.9、§2.10：不用探针，用门控用例 `server/test/omp-official-host-tools.test.ts`
  （`WORKBUDDY_OMP_TEST=1`，同一官方 v18.12.3 二进制）。服务端是应用装配（`openProxiedApp`：createApp → SessionSupervisor，
  真实模型代理与模型注册表），上游是受控假上游的知识库检索标记（同样由脚本发起工具调用），RAGFlow 是假 RAGFlow；
  regenerate、fork、删库都走应用的 REST。下面这几节的结论就是这些用例断言的值。

## 2. 结论

### 2.1 注册与可见性

- `set_host_tools` 的应答为 `{command:"set_host_tools", success:true, data:{toolNames:["kb_search"]}}`。
- **缺省 `loadMode` 时工具对模型不可见**：之后的上游请求里，`tools` 恰为 `read,bash,edit,eval,glob,grep,task,wait,todo,web_search,write`，
  没有 `kb_search`，也没有任何用来发现工具的工具；系统提示不提 `kb_search`。
- 定义带 `loadMode:"essential"` 时，`kb_search` 出现在 `tools` 末尾，系统提示也提到它。
- 撤下全部（宿主发 `set_host_tools {tools:[]}`，2026-11-14）：应答原文为
  `{"id":"rt-4","type":"response","command":"set_host_tools","success":true,"data":{"toolNames":[]}}`，宿主接受，
  同一进程这一回合以 `turn.end done` 结束；之后的上游请求 `tools` 恰为 `read,bash,edit,eval,glob,grep,task,wait,todo,web_search,write`，
  没有 `kb_search`。历史里旧的 `kb_search` 调用与 tool 消息照常回放。
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

`always-ask` 下回 `Deny`（2026-11-14；宿主经 supervisor 的 `decide` 拒绝，与审批端点同一路径）：每次调用的帧序是
`tool_execution_start` → `select` →（宿主答 `Deny`）→ `tool_execution_end`，没有 `host_tool_call`、没有 `host_tool_cancel`，回合不挂起：

```
{"type":"tool_execution_end","toolCallId":"call_…","toolName":"kb_search",
 "result":{"content":[{"type":"text","text":"Tool call denied by user: kb_search"}],"details":{}},"isError":true}
```

下一次上游请求带 `{role:"tool", content:"Tool call denied by user: kb_search", tool_call_id}`。受控上游把这条 tool 消息算作一轮，
所以第二次调用也弹 `select`、也被拒；第三次请求得到固定答复，回合以 `turn.end done` 结束。宿主侧：两条 `approval.request`
（`tool:"kb_search"`，标题 `Allow tool: kb_search`）、两条 `approval.resolved{decision:"deny"}`，两个 `kb_search` 步骤以
`status:"failed"`、`output` 为上面那段文本结束；没有 `kb.hits`、没有 `kb_hits_invalid`，假 RAGFlow 没有收到检索。

假 omp（`server/test/support/fake-omp-host-tool.mjs`）的自选帧序与此一致；它的 `result` 没有 `details:{}`，其余相同。

没有测：选「Approve kb_search for this session」之后的行为。

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

### 2.9 branch 之后（regenerate 与 fork，2026-11-14）

- regenerate：宿主在会话自己的进程上发 `get_branch_messages` → `branch` → `get_state` → `prompt`，中间没有 `set_model`、
  没有 `set_host_tools`（这一代记下的库清单没变）。`branch` 之后的新回合，每个上游请求的 `tools` 里恰有一个 `kb_search`，
  两次调用都落到宿主（`host_tool_call`），SSE 有两组 `step.start` / `kb.hits` / `step.end`，假 RAGFlow 收到两次检索。
  整个用例只有一个 `ready`、一帧 `set_host_tools` 应答：**omp 的 `branch` 不丢 host tool**，同一进程不必重新注册。
- fork：源会话的进程先退役；临时进程（`ready` → `negotiate_protocol` → `get_state` → `get_branch_messages` → `branch` → `get_state`）
  不发 `set_host_tools`。fork 提交之后，fork 出的会话第一条 prompt 起新一代进程（一个 `ready`），这一代恰注册一次，
  应答 `toolNames:["kb_search"]`；上游 `tools` 里恰有一个 `kb_search`，SSE 有两条 `kb.hits`，没有审批（`write` 档）。

### 2.10 项目层同名工具 `.omp/tools/kb_search`（2026-11-14）

下面「所有者有库」「所有者没有库」两条由门控用例断言；「最小形式」里 `.md`、不带 `loadMode` 的可见性与 `kb_probe` 对照三项
是同一天用同一装配跑的一次性探针，原始帧只留在本机，没有进用例。

- omp 能加载的最小形式：会话工作空间（进程 cwd）下的 `.omp/tools/kb_search.js`，默认导出一个工厂，返回带
  `name`、`description`、`parameters`（普通 JSON Schema 即可）与 `execute` 的对象（参考克隆 `loader.ts` 的 `isLoadableCustomTool`）。
  - `.omp/tools/kb_search.md`（frontmatter `name: kb_search`）不加载：参考克隆的加载器拒绝 `.md` / `.json`；探针里这时注册照常成功、调用落到宿主。
  - 不带 `loadMode` 时工具对模型不可见（与 §2.1 的 host tool 相同）：探针里所有者没有库、只有这个文件时，上游 `tools` 没有 `kb_search`。
    带 `loadMode:"essential"` 才进 `tools`。
  - 对照探针：工作空间里只放另一个名字的工具（`.omp/tools/kb_probe.js`，`essential`）时，`kb_probe` 出现在 `tools` 里，
    `kb_search` 照常注册、调用落到宿主——项目层工具确实从会话 cwd 加载，冲突只因同名。
- 所有者有库（宿主照常注册）：omp 拒绝注册，
  `{"type":"response","command":"set_host_tools","success":false,"error":"RPC host tool \"kb_search\" conflicts with an existing tool"}`。
  不带 `loadMode` 的最小形式就会这样（带 `essential` 的探针结果相同）。宿主按 §2.1 的契约处理：这一步失败，slot 退役，
  prompt 回 502 `agent_unavailable`；没有任何上游请求、没有 `host_tool_call`、没有检索，上游 `tools` 里 `kb_search` 的项数与调用落点都无从谈起。
  用例连发两条 prompt：每条都起新进程（第二个 `ready`）、重新注册、再次被拒、再次 502。只要工作空间里有这个文件，
  所有者有库时该工作空间里的 prompt 就都失败。
- 所有者没有库（宿主一帧 `set_host_tools` 都不发）：`essential` 的项目工具出现在 `tools` 里（恰一个 `kb_search`）。
  omp 为它发标题恰为 `Allow tool: kb_search` 的 `select`，`write` 档下传输层立即答 `Approve`：没有 `approval.request`，
  所有者看不到；项目工具的 `execute` 运行，上游 tool 消息是它返回的文本，没有 `host_tool_call`、没有检索。
  原先标 [INFERENCE] 的「同标题即放行」由此实测成立：同名项目工具在 `write` 档下绕过了所有者审批。它属于 ADR-0012 已接受残余
  （项目层 `.omp/tools` 不拦）的延伸，是否仍按已接受处理待所有者确认。
