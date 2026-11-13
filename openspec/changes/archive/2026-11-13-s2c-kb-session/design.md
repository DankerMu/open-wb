## Context

S2b 交付了单轮检索（knowledge-bases「单轮检索」），并把 `kb_search` 的契约写进了规格，但没有注册和分派。本 change 把这条链路接通：
会话里的 omp 模型调用 `kb_search`，app-server 对每个指定的库做一次单轮检索，把切片与出处交还给模型，同时在会话页画出检索卡。
用户还可以在输入框里「引用」知识库，作为对模型的提示。

### omp 的 host tool 事实（`docs/reviews/2026-11-10-omp-host-tools.md`，v18.12.3；与任何文档不符时以记录为准）

- 注册（§2.1）：
  - `set_host_tools{tools}` 整体替换宿主工具集，应答 `data.toolNames`。
  - 缺省 `loadMode` 的工具不进模型的 `tools`，也没有发现入口；`loadMode:"essential"` 才可见。
- schema 改写（§2.1、§2.2）：
  - omp 往参数 schema 里加必填的 `i`（concise intent）。
  - `host_tool_call.arguments` 不含 `i`，`tool_execution_start` 顶层另带 `intent`。
- 帧（§2.3）：
  - `host_tool_call{id, toolCallId, toolName, arguments}`，宿主以 `host_tool_result{id, result:{content, details?}, isError?}` 应答。
  - `yolo` 下 `host_tool_call` 先于 `tool_execution_start`。
  - `write`、`always-ask` 下顺序是 `tool_execution_start` → 审批 → `host_tool_call`。
- 审批（§2.4）：`write`、`always-ask` 下每次调用都发 `select`，标题恰为 `Allow tool: kb_search`，选项三项（含 session grant）。
- `details` 与进度（§2.5）：
  - `details` 原样到 `tool_execution_end.result.details`，不进上游。
  - `host_tool_update` 变成 `tool_execution_update`。
- 并发（§2.6）：同一条回复里的多个调用，其 `host_tool_call` 同时到达。
- 中止（§2.7）：
  - 5 s 内 omp 不会自己超时。
  - `abort` 先发 `host_tool_cancel{targetId}`，步骤以 `Host tool "kb_search" was aborted` 失败。
  - 取消之后再到的结果被忽略。
- resume（§2.8）：新进程没有宿主工具，必须重新注册。

### 主干现状

- **进程**：
  - 唯一的 `new OmpProcess` 在 `SessionRuntime.#openProcess`（`server/src/sessions/omp/runtime.ts:436`），只经 `#acquire` 启动；`#readyGeneration` 负责所有重新 spawn（含 resume）。
  - 会话 slot 由 `supervisor.ts` `#onNewSlot` 经 `buildSessionRuntime`（`pool.ts:296`）建。
  - fork 与撤回的临时进程由 `branch-temp.ts` `branchAt` 建，只执行命令，没有 `onApproval`。
- **帧**：
  - `OmpProcess.#onFrame`（`process.ts:561`）先 `emit("frame")`，再分流 `extension_ui_request` 与 `response`。
  - `SessionRuntime.#onFrame` 在没有已发送的回合时丢帧，所以协议帧必须在 `OmpProcess` 层应答。
- **审批**：
  - `#onUiRequest`（`process.ts:584`）依次判 `approvalRequest`（推给所有者）、`isPreludeCard`（传输层应答 `Approve`）、其余取消。
  - `#opts.approvalMode` 可读，现在不用。
- **事件**：
  - `events.ts` 有十三种事件。
  - `turn.retry` 在 `turn-control.ts:261` 原样返回、不落库，序号由 `RingBuffer.push` 分配。
- **附件**：
  - `parsePromptBody`（`prompt-attachments.ts:47`）键集恰为 `{message}` 或 `{message, attachments}`。
  - 后缀由 `attachmentSuffix`（`slash-commands.ts:324`）唯一构造。
  - 分支对位（`branch-temp.ts:191`）逐字节比较 `content + suffix`。
- **kb**：
  - `retrieveForBase`（`kb/retrieval.ts:93`）不判 `state`，也传不下 `AbortSignal`（`ragflow-retrieval.ts:69`）；但 `ragflow-client.ts` 的 `json(…, signal)` 已支持中止。
  - `kb/index.ts` 不向其它模块暴露任何句柄。
  - 库没有改名接口，名称建后不变。
- **web**：
  - 快照的 `parseMessage` 严格十三键（`session-contract.ts:377`）。
  - 「+」菜单在 `capability-bar.tsx` `CommandMenu`。
  - 步骤卡是通用组件，`tool-summary.ts` 把 `kb_search` 归到「其它」。
- **CI**：smoke 与 ui-walk 两个 job 不配 RAGFlow，知识库关闭；官方 omp 用例在 `WORKBUDDY_OMP_TEST=1` 门下，CI 跳过。

## Grill 结论（2026-11-10，owner 逐分支拍板）

| # | 分支 | 结论 | 落点 |
|---|---|---|---|
| G1 | 切分 | S2c 拆成两个 change：本 change 为 A（会话接入），可见范围四档为 B，A 合入后另跑流水线 | Goals / Non-Goals |
| G2 | 审批 | `write`、`yolo` 由传输层应答 `Approve`；`always-ask` 照常推给所有者 | D4 |
| G3 | 检索范围 | 调用者可见的全部库；本 change 中「可见」=「自己拥有」 | D5 |
| G4 | 非 ready 的库 | 跳过并在结果里注明 | D5 |
| G5 | 库清单 | 写进 `kb_search` 的描述，列全部可见库，只写 id 与名称；清单变了在下一次派发前重发 | D3 |
| G6 | 知识库引用 | 只作提示：消息后接固定文字列出引用的库，按消息存储，与附件后缀同一处构造 | D8 |
| G7 | 多库结果 | 模型传了哪些库，就对每个库各返回至多 6 条，按库分组 | D5 |
| G8 | 库数上限 | 每次调用至多 5 个库，超出即报错并说明 | D5 |
| G9 | 注册条件 | 知识库开启且至少有一个可见库才注册；每个新进程都注册；`loadMode:"essential"` | D3 |
| G10 | 部分失败 | 逐库注明；不存在与不可见同一句话；一个库都没成功才 `isError` | D5 |
| G11 | 检索卡 | 一回合一张卡，每次调用一行（第 N 轮、意图或问句、命中条数）；不画「充分性判定」「采纳切片」 | D10 |
| G12 | 卡片数据 | 结构化命中只走实时流（占序号、不落库，先例 `turn.retry`）；刷新后只剩各轮问句与状态 | D7 |
| G13 | 二轮验收 | CI 脚本化两轮；真实模型的第二轮由验收清单新增一行（`待签`），owner 走查 | D11 |
| G14 | 协议细节（实测） | 按 `toolCallId` 关联；并发；取消即中止 RAGFlow 请求、迟到结果丢弃；`details` 不进模型 | D1、D2、D6 |
| G15 | 检索参数（S2b 契约） | 用该库已存的参数，会话检索不写回、不审计 | D5 |

另经 grill 剪掉的组件与复活条件见 Non-Goals。

## Goals / Non-Goals

**Goals:**
- 会话里的 omp 模型能经 `kb_search` 检索调用者自己的知识库，只有切片与出处进入上下文（CONTEXT.md 不变量 2）。
- 模型可以按自己的判断多次调用 `kb_search`（ADR-0017）；每次调用在会话页上可见。
- 用户能在输入框引用知识库，作为对模型的提示。
- 链路的协议面（注册、分派、取消、审批）在 CI 里由假 omp 覆盖，在本机由官方 omp 门控用例覆盖。

**Non-Goals:**
- **可见范围四档、共享只读、跨账号检索审计、部门与项目组字段**：change B。B 的开放项（部门与项目组数据在 S3a 之前的来源、跨账号审计的粒度与库所有者能否看到、共享库的检索测试范围、四档设置界面）留给 B 的 grill。
- **`kb_list` 工具**：库清单写进描述已足够。复活条件：用户的库多到描述明显拖长上下文，或 owner 走查发现模型选不准库。
- **全局检索并发限流**：每次调用至多 5 个库，单库请求有 30 s 期限。复活条件：RAGFlow 出现过载或排队超时。
- **跨库去重**：不同库的数据集互不重叠，不会重复。
- **宿主侧的充分性判定与改写**：与 ADR-0017 冲突。
- **检索卡的持久化**（G12）：复活条件：owner 要求刷新后仍看到命中切片。
- **会话检索的审计**：自己的库不审计（S2b：检索本身不写审计），跨账号审计属于 B。
- **HTTP smoke 的会话检索分支，以及 ui-walk 里真实链路的检索**：CI 的 smoke 与 ui-walk 不配 RAGFlow，本 change 不改 CI 文件；ui-walk 只用 `page.route` 桩（D11，`ui-walk-center-kb.ts` 的先例）。复活条件：change B 需要双账号的端到端走查。
- **`make smoke-kb` 的会话检索断言**：要真实模型，归 owner 验收。
- **fork 与撤回回填知识库引用**：消融结论是，去掉它只会让草稿少了引用标签。模型仍可检索全部库，用户重新引用一次即可；而 fork / 撤回应答的「恰三键」写在五份规格里。复活条件：owner 走查认为分叉或撤回后丢失引用造成困扰。

## Decisions

### D1 host tool 协议放在 `OmpProcess`，语义靠注入

新文件 `server/src/sessions/omp/host-tools.ts` 承载帧的解析与应答，`OmpProcess.#onFrame` 在 `extension_ui_request` 分流旁边把
`host_tool_call` / `host_tool_cancel` 交给它。`OmpProcessOpts` 多一个可选的 `hostTools`：

```ts
interface HostToolHandler {
  // 只由 OmpProcess 调用；signal 在取消或进程退出时中止
  call(toolName: string, args: unknown, signal: AbortSignal): Promise<{ text: string; details?: object; isError: boolean }>;
}
```

- **在途表**：以 `host_tool_call.id` 为键，存 `AbortController`。
- **`host_tool_cancel{targetId}`**：中止对应的处理并删掉这一项；之后它的结果不写。
- **进程退出、写端关闭或 `#writesClosed`**：中止全部在途处理，不再写任何帧。
- **处理函数抛错**：回 `isError`，文本为「工具执行失败」；错误原文不进帧，也不进日志。
- **未注入 `hostTools`，或工具名未知**：回 `isError`，文本为「未知工具」。
- **应答**：`{type:"host_tool_result", id, result:{content:[{type:"text", text}], details?}, isError?}`，经现有的 `#write`，遵守帧长上限。
- **结果过大**：序列化后超过 1 MiB 时先去掉 `details` 重试；仍超过就改回 `isError`，文本为「工具结果过大」。每个调用恰有一帧应答，否则 omp 会一直等（§2.7），回合挂死。
- **绑定**：处理函数在构造进程时绑定，进程存活期间不变。会话 slot 的处理函数由 `pool.ts` `buildSessionRuntime` 绑定为「以 slot 的所有者执行」，经 `SessionRuntimeOpts` 传到 `OmpProcessOpts.hostTools`；只有 `supervisor.ts` `#onNewSlot` 这条路径传它。模型给的 kb_id 只按这个所有者判定，不同会话的进程不会串号。

放在 `OmpProcess` 而不是 `SessionRuntime`：`SessionRuntime.#onFrame` 在没有已发送回合时丢帧（主干现状），而 omp 等不到应答会一直挂着（§2.7）。
`sessions` 不导入 `kb`：处理函数由 `app.ts` 注入，依赖规则不加新边（`docs/architecture/system.md` §4 的 `sessions → kb` 改写为「经注入」）。

### D2 帧序与并发

- 不假定 `host_tool_call` 先于或晚于 `tool_execution_start`（§2.3）。`host-tools.ts` 只认 `id`，不碰步骤；步骤仍由 `tool_execution_*` 驱动（`events.ts`）。
- 同一进程的多个在途调用并发执行，互不等待（§2.6）。

### D3 注册：派发前对齐的第 3 步

注册不挂在 `runtime.ts` 的 `#acquire` / `#runPrompt` 上，而是进入现有的派发前对齐（chat-sessions「派发前按会话设置对齐进程」）。
对齐由 `supervisor.ts` 在每次派发前执行：第 1 步档位与能力，第 2 步 `set_model` / `set_thinking_level`（`composer-align.ts`，以 `slot.generation.applied` 记这一代已对齐的值），之后是 `prompt`。
本 change 在第 2 步之后插入第 3 步「宿主工具」，放在 `composer-align.ts` 旁的新文件 `sessions/host-tool-align.ts`，用同一套 `commandOn` 与 `slot.generation`。

- **定义**：`definitionFor(ownerId)` 由 kb 模块给出（D5），经 `app.ts` 注入 supervisor。知识库关闭，或所有者一个库都没有时为 `null`。
- **每一代记下已注册的库清单**：新 generation（spawn 与 resume，§2.8）从「尚未注册」开始，所以 G9 的「每个新进程都注册」落实为「每个新 generation 的首次派发前注册」。
- **比较与发送**：每次派发都重新取定义，与所记清单（`[{id, name}]`，依 `created_at` 排序）比较：
  - 有定义，而尚未注册或清单不同：发 `set_host_tools{tools:[定义]}`。
  - 没有定义而所记清单非空：发 `set_host_tools{tools:[]}`，表示撤下。
  - 其余：不发。这一代从来没有定义时一帧 `set_host_tools` 都不发，知识库关闭的部署帧序不变。
- **应答**：须为 `success:true` 且 `data.toolNames` 恰为 `["kb_search"]`（撤下时为 `[]`），成功后才更新所记清单。失败与第 1、2 步失败同样处理：retire slot，prompt 以 `agent_unavailable` 失败。
- **临时进程**：fork 与撤回的 `branch-temp.ts` 不跑对齐的第 2、3 步，也不注入处理函数，所以不注册。
- **不做的事**：
  - 回合进行中库清单变了，不重发（回合内一致更简单）。
  - 不为对齐而重新 spawn。
- **定义的固定部分**：`name:"kb_search"`、`label:"知识库检索"`、`loadMode:"essential"`。参数 schema 为 `{question:string, kb_ids:string[] (minItems 1, maxItems 5)}`，`additionalProperties:false`。
- **描述**：中文说明（含「证据不足时可以改写问句或换库再次调用」），末尾逐行列 `- <名称>（<id>）`。

### D4 `kb_search` 的审批由传输层应答

`ui-requests.ts` 增加 `isKbSearchApproval(frame)`：`method:"select"`、标题恰为 `Allow tool: kb_search`、选项为 tool-approval「审批请求识别」的两种闭合形状之一（实测的三项 `["Approve","Approve kb_search for this session","Deny"]` 属于其一）。

`#onUiRequest` 在 `approvalRequest` 之前判它。这一代进程的 `approvalMode` 不是 `always-ask` 时，写 `answerFrame(id,"allow")`，不登记审批、不发审批事件；是 `always-ask` 时走原路径交给所有者。

理由：`kb_search` 只读，过滤在宿主手里，不是「命令」；而 `always-ask` 的承诺是每次都问。这是 F-CHAT-12「只问命令」档下唯一一个由宿主放行的非预载工具，tool-approval 规格写明。

### D5 会话检索：`kb/session-search.ts`

kb 模块新增 `createKbSessionSearch(deps)`，`registerKb` 把它交回给 `app.ts`。知识库关闭时 `app.ts` 拿到的是 `null`，处理函数与定义源都不注入。返回三个函数：

- **`definitionFor(ownerId)`**：读 `store.listBases(ownerId)`（本地，不访问 RAGFlow）。空则 `null`，否则给出 D3 的定义。
- **`execute(ownerId, args, signal)`**：
  1. **参数**：
     - 键集恰为 `question`、`kb_ids`。
     - `question` 为字符串：去掉首尾空白后非空、至多 1000 码点、不含 C0 控制字符（`\t`、`\n` 除外）与 DEL（与检索测试同一判定，复用同一个函数）。
     - `kb_ids` 为 1–5 个非空字符串的数组，重复的按首次出现去重。
     - 不符就 `isError`，文本说明哪里不符；超过 5 个时写明「一次至多检索 5 个知识库」。
  2. **逐库判定**（按去重后的次序）：
     - 不是该账号的库：`not_found`。不存在与不可见是同一种结果，文本里不回显任何名称。
     - `state` 不是 `ready`：`not_ready`。
     - 其余并发做一次单轮检索（`retrieveForBase(…, signal)`）：成功为 `ok`（命中可以为空），`kb_unavailable` / `kb_rejected` 为 `failed`。
  3. **结果**：
     - `isError` 当且仅当没有任何一个库是 `ok`。
     - 文本按库分段：`知识库「<名称>」（<id>）：命中 N 条` 后逐条 `[k] <文档名>（相似度 0.xxxx）` 加换行与切片原文。
     - 其余状态各一行：`知识库 <id>：未找到该知识库`、`知识库「<名称>」（<id>）：正在重建，本轮未检索`、`知识库「<名称>」（<id>）：检索失败`。
     - `details` 为 `{bases:[{kbId, name, status, hits}]}`。`not_found` 的 `name` 为 `null`、`hits` 为 `[]`；`hits` 与 `RetrievalHit` 同形。
  4. **不做的事**：不写回检索参数，不写审计；切片原文不进日志。

- **`resolveReferences(ownerId, ids)`**：知识库引用的受理用（D8），全部是该账号的库时返回 `[{id, name}]`，否则 `null`。

单轮检索仍是唯一的检索实现（knowledge-bases「单轮检索」的扫描用例加一条：`session-search.ts` 只经 `retrieveForBase` 检索）。

### D6 单轮检索可取消

- `RetrievalQuery` 多可选的 `signal`，`ragflow-retrieval.ts` 把它传给 `json(…, signal)`。
- `retrieveForBase(deps, base, question, signal?)` 往下传；重排降级的那一次重试也传同一个 signal，已中止时不发出。
- 中止的结果与期限到期同为 `kb_unavailable`，与 `ragflow-client.ts` 现有写法一致。
- 检索测试端点不传 signal，行为不变。

### D7 `kb.hits` 事件：派生、占序号、不落库

- **派生**：`events.ts` 的运行中工具条目，对名为 `kb_search` 的调用记下 `tool_execution_start` 的 `intent`（非空字符串，否则 `null`）。其 `tool_execution_end` 未失败、`result.details` 是普通对象且有自有属性 `bases` 时，在 `step.end` 之前发 `kb.hits{messageId, stepId, intent, bases}`。`bases` 原样取 `details.bases`，reducer 不校验，与 `todo.updated` 的分工相同。
- **校验**：supervisor 在发布前严格校验 `bases`，结构不符就丢弃这个事件，并写一行不含切片原文的 stderr 记录。
- **stepId**：reducer 给出的是 omp 的 `toolCallId`。`persistEvent` 与 `step.end`、`files.changed` 一样，经 `steps.toolIds` 映射成落库的步骤 id；映射不到（该步骤没有登记）时丢弃这个事件。所以 `kb.hits.stepId` 与同一步骤的 `step.start.stepId` 相等。
- **存储**：映射之后 `persistEvent` 对 `kb.hits` 与 `turn.retry` 同样原样返回、不写库。
- **可见性**：同一 epoch 内带 `Last-Event-ID` 重连可以回放；从完整快照恢复的连接看不到它（G12）。

### D8 知识库引用（F-CHAT-5b）

- **迁移 052**：`chat_messages` 加 `knowledge_bases TEXT NULL`，与迁移 042 同一写法：只 `ADD COLUMN`，无缺省、无 CHECK、不回填。
- **prompt body**：键集扩为 `{message}`、`{message, attachments}`、`{message, knowledgeBases}`、`{message, attachments, knowledgeBases}` 四种。`knowledgeBases` 为 1–5 个互不相同的非空字符串。
  - 每个都须是调用者的库，否则 404 `not_found`：不存在、别人的库与知识库关闭，三者不可区分。
  - 它在附件判定之后、受理之前判定，不审计。
  - 引用不放宽空文本规则：去掉首尾空白后为空的文本仍须带非空的 `attachments`。只引用库不提问没有意义，放宽还要给标题另加一种取材来源。
- **落库**：存紧凑 JSON `[{id, name}]`，名称取受理时的本地值；无引用为 NULL。解析与附件同一纪律：任何一项不合规则整列读作 `[]`。
- **后缀**：`attachmentSuffix` 原地改名为 `promptSuffix(paths, kbs)`，它是唯一构造。
  - 结构为附件段（与现在逐字节相同）之后接引用段：两个 U+000A、固定说明行 `用户在本条消息中引用了以下知识库，可以用 kb_search 检索：`，再对每项接 U+000A、`- `、名称、`（`、id、`）`。
  - 两段都空时为空串；只有引用时以引用段开头。
  - 无引用时与现在逐字节相同，存量会话的分支对位不受影响。
- **对位**：wire candidates 由落库的附件与引用快照共同重建（`branching.ts` 与 `branch-temp.ts` 都经 `promptSuffix`）。
- **视图**：
  - 消息快照多第十四键 `knowledgeBases: [{id, name}]`，助手消息恒为 `[]`。
  - fork 拷贝被复制消息的列原值，新会话的分支对位要用它。
  - fork 与撤回的应答不变，不回填引用（见 Non-Goals）。
- **web**：
  - 「+」菜单在「上传文件」之后加「引用知识库…」，只在 `GET /api/kb/status` 为开启时出现。弹出的列表来自 `listKnowledgeBases`；非 `ready` 的库也可引用，检索时由 D5 注明。
  - 引用标签与文件附件同一行，可移除；欢迎态可暂存。
  - 用户气泡显示引用的库名。

### D9 web 的严格解析与 API

- `session-contract.ts` 的 `parseMessage` 改为十四键，`ChatKnowledgeBaseRef` 严格键集 `{id, name}`；fork 与撤回应答不变。
- `api-sessions.ts` 的 prompt body 在引用非空时带 `knowledgeBases`。
- 服务端视图与 web 严格解析同一 PR 落地，是跨服务契约对（S2b `BaseView.retrieval` 的先例）。

### D10 检索卡

- **合卡**：一条助手消息里，名为 `kb_search` 的步骤合成一张「知识库检索」卡，放在第一个 `kb_search` 步骤的分段位置。后续的 `kb_search` 步骤并进同一张卡，不再单独出现。
- **工具段**：`tool-summary.ts` 不把 `kb_search` 计入工具段摘要。
- **卡头**：`知识库检索 · <库名、库名>`（取 `kb.hits` 里 `ok` 的库名，没有时只写「知识库检索」）、轮数、状态（检索中 / 检索完成 / 检索失败）。
- **每次调用一行**：`第 N 轮`、意图（`kb.hits.intent`，没有时用步骤 detail 里的 `question`）、命中条数（没有 `kb.hits` 时不显示）、行状态。展开后按库列出命中：文档名、相似度、切片原文。
- **刷新或从快照恢复后**：只有步骤，行里显示问句与状态，不显示命中（G12）。
- **新组件**：`web/src/features/chat/kb-search-card.tsx`。会话视图归约（`stream.ts`）把 `kb.hits` 按 `stepId` 挂到消息上；`kb.hits` 的严格键集为 `{messageId, stepId, intent, bases}`，不符则重新同步完整快照（与 `turn.retry` 同一纪律）。

### D11 测试与夹具

- **假 omp**：新场景 `host-tool`，按记录 §2.3 / §2.7 的帧形。
  - prompt 回合先发 `set_host_tools` 的应答形态检查（记录入站帧）。
  - 再依次发两次 `kb_search` 的 `tool_execution_start` + `host_tool_call`，各自等宿主的 `host_tool_result` 后发 `tool_execution_end`（`result` 原样）。
  - 场景变体 `host-tool-abort`：第一次调用后不等结果，收到 `abort` 时发 `host_tool_cancel` 与失败的 `tool_execution_end`。
  - 场景变体 `host-tool-parallel`：同一条回复里连发三个 `host_tool_call`（第三个的 `toolName` 为 `other`），不等任何应答，再按到达顺序收齐三个结果。
  - 场景变体 `host-tool-register-fail`：`set_host_tools` 回 `success:false`，供注册失败的用例。
  - 其余场景收到 `set_host_tools` 时回按 `id` 关联的 `success:false`。
  - `--approval-mode write` 时，在 `host_tool_call` 之前发 `Allow tool: kb_search` 的 `select`，等应答。
- **观察宿主写出的帧**：假 omp 的入站帧记录只有帧类型，看不到载荷。协议用例改用 `server/test/support/omp-runtime.ts` 的 `capturePromptWrites` 同一手法截获子进程 stdin（stdin tee），断言 `host_tool_result` 的 `id`、文本、`details` 与 `isError`。
- **受控假上游**：标记 `WORKBUDDY_KB_SEARCH:<kbId>`。本回合第一次请求回 `kb_search{question:<原问句>, kb_ids:[kbId]}`；本回合已有一条 tool 消息时，回第二次 `kb_search{question:<原问句> 详细说明}`；已有两条时回固定正文。
- **官方 omp 门控用例** `server/test/omp-official-host-tools.test.ts`（`WORKBUDDY_OMP_TEST=1`）：
  - 用 `createApp` 起服务，接受控假上游与假 RAGFlow。
  - 发带标记的 prompt，断言两次 `kb_search`、两次 `kb.hits`；假 RAGFlow 恰收到两次检索；第二、第三次上游请求的 tool 消息只含切片文本，不含 `details` 的键名 `bases`。
  - 在 `write` 档跑，断言没有 `approval.request`。
- **ui-walk 分支** `web/e2e/ui-walk-chat-kb.ts`（`ui-walk-center-kb.ts` 的先例）：
  - 用 `page.route` 应答 `/api/kb/status`（开启）与 `/api/kb/bases`，走查「+」菜单的 `引用知识库…`、选择列表与引用标签。
  - 截获 prompt 请求，断言 body 带 `knowledgeBases`，再由 route 回 202。
  - 用 route 给出一份含两个 `kb_search` 步骤与引用的消息快照，走查用户气泡的引用列表与刷新形态的检索卡，视口矩阵与 error oracle 照常。
  - 实时 `kb.hits` 形态由 web 单测覆盖，不在 ui-walk 里桩 SSE。

### D12 模块划分与行数

- **新文件**：`sessions/omp/host-tools.ts`（协议）与 `kb/session-search.ts`（语义）。
- **`process.ts`**（760 行）：只加分流与 `#onUiRequest` 的一个判断，帧的处理全在 `host-tools.ts`。`ui-requests.ts` 保持无状态的纯判定函数，`OmpProcess` 仍是唯一写帧的地方。
- **`runtime.ts`**：不加注册逻辑，只把 `hostTools` 从 `SessionRuntimeOpts` 透传给 `OmpProcessOpts`。
- **对齐**：第 3 步放在新文件 `sessions/host-tool-align.ts`，`supervisor.ts`（785 行）只加一处调用。
- **web**：新组件单独成文件；`use-chat-session.ts`（796 行）只加接线，放不下先移出欢迎态首次发送；归约加在 `stream.ts` 旁的新文件 `stream-kb-hits.ts`，与 `stream-failure.ts` 同一先例。

### Sketch seams under test

1. **`OmpProcess` 的帧边界 + 假 omp `host-tool` 场景**（已有 seam）：注册、并发调用、取消、进程退出、审批的传输层应答，全在真实子进程上观察入站与出站帧。
2. **`createApp` 的 HTTP / SSE 边界 + 假 omp + 假 RAGFlow**（最高的服务端 seam）：prompt 受理、引用落库与后缀、`kb.hits` 发布与不落库、fork 拷贝引用后的对位；断言看 SSE、快照、假 RAGFlow 的请求记录与假 omp 的入站帧。
3. **`createKbSessionSearch` 的 `execute`**（kb 语义）：对假 RAGFlow 覆盖参数校验、逐库状态、文本格式与 `details`、取消。
4. **web 会话视图归约与组件渲染**（vitest），加 ui-walk 的 `page.route` 桩分支（真实浏览器）：严格解析、`kb.hits` 归约、检索卡、引用入口与标签。
5. **官方 omp 门控用例**（本机证据）：真实 omp 与受控上游、假 RAGFlow 的端到端两轮。

## Not yet specified

- 真实模型下「证据不足就改写再查」的触发率：工具描述的措辞是否足以引导，只有 owner 走查（CK 新行）才知道。触发率不足时用什么手段强化（措辞、系统提示、示例），现在说不清。

## Risks / Trade-offs

- **白盒关键路径**：`OmpProcess` 的新协议面写错，会让回合挂死，或把结果写给已取消的调用 → 取消与退出的用例在真实子进程上跑（seam 1）；PR 标注请求白盒审查。
- **`write` 档的放行例外**：模型可以不经用户确认就检索知识库 → 只读、只限调用者自己的库，`always-ask` 不受影响；tool-approval 规格写明。
- **`i` 字段是 omp 的实现细节**：升级 omp 时可能变 → 意图缺失时退回问句（D10），不依赖它。
- **检索卡不持久化**：刷新后丢命中 → owner 已接受（G12）。
- **库多时描述变长**：每个库一行 → Non-Goals 的复活条件盯住它。
- **omp 行为里没测到的部分**（记录 §2.4、§2.6、§2.7）：`Deny` 与 session grant 之后的行为、`write` 档的并行调用、宿主超过 5 s 不应答时 omp 是否超时都没测。→ 宿主保证每个调用恰一帧应答，不依赖 omp 超时；`Deny` 的假 omp 帧形按 tool-approval 的既有审批写，组 9 第二刀在真实 omp 的 `write` 档回归；与实测不符时以记录补测为准。
- **单轮检索被并发调用**：一次 `kb_search` 至多 5 次并发 RAGFlow 请求，再加上降级重试 → 期限 30 s 不变，至多 10 次出站。

## Migration Plan

- 迁移 052 只加可空列，回滚即 `git revert`，存量行读作 NULL，没有回填。
- `promptSuffix` 在无引用时与旧后缀逐字节相同，存量会话的重新生成、fork 与撤回对位不受影响。
- 知识库关闭的部署完全不注册 `kb_search`，行为与本 change 之前相同。

## Open Questions

无。
