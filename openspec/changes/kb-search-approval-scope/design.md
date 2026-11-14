# Design: kb-search-approval-scope

## Governing invariant

`write` 档下，任何不是宿主自己执行的工具调用，都不能借 `kb_search` 的名义跳过所有者审批。传输层放行 `Allow tool: kb_search`
只在「这张确认卡确实是宿主注册的 host tool 的」时成立；宿主能确定这一点的唯一依据，是这一代进程对宿主自己发出的 `set_host_tools` 的成功应答。

## D1 放行前提：这一代进程注册过 `kb_search`

- 状态归 `OmpProcess`（一个进程就是一代）：初始为「未注册」。只在 `#onFrame` 里按 id 对上宿主自己发出、仍在 pending 的 `set_host_tools` 请求的那条
  `response`（`process.ts:590-597` 的匹配路径）上同步更新：`success:true` 时按 `data.toolNames` 是否含 `kb_search` 置为「已注册」或「未注册」；
  `success:false`、请求失败、或 id 对不上任何宿主请求的 `response` 帧（omp 或项目层代码自发的）一律不改状态。`HostTools.onFrame` 看得到 stdout 的每一帧（`process.ts:589`），
  不能在那里按帧形更新。
- 放行判定：`approvalMode !== "always-ask"` 且 `isKbSearchApproval(frame)` 且「已注册」。三者缺一，就按审批识别（`approvalRequest`）走：
  `tool="kb_search"`、`title` 原文交给所有者，与其它工具相同（登记、事件、`chat_approvals`、审计都照常）。
- 为什么不放在 sessions 层（`slot.generation.hostTools`）：放行发生在 `OmpProcess#onUiRequest`，在进程帧的同步路径上。由进程观察自己的命令应答，
  不需要跨层回调，也不受 slot 与 generation 交接时序的影响。
- 时序：`set_host_tools` 在派发前对齐（第 3 步）完成，`prompt` 在它之后；确认卡只会出现在 `prompt` 之后，所以应答一定先于卡到达。
  回合中库清单变化不重发（omp-runtime 现有规则），状态在回合内不变。
- 撤下（`tools:[]` 成功）之后回到「未注册」：之后这一进程上出现的同形卡交给所有者。
- 行数预算：`process.ts` 现为 782 行（上限 800）。状态与判定逻辑放进 `omp/host-tools.ts`（`HostTools` 已是这一进程的宿主工具协议持有者）或
  `omp/ui-requests.ts`，`process.ts` 只多接线，目标 ≤ 790 行。

## D2 冲突分类

- 判别：`set_host_tools` 应答 `success:false` 且 `error` 字段恰为 `RPC host tool "kb_search" conflicts with an existing tool`（v18.12.3 实测原文，
  记录 §2.10）。只认恰好相等：前后缀不同、工具名不同的都不算。omp 升级改了文本，就退回 502（fail-closed），由官方门控用例发现。
- 携带：`runtime.#runCommand` 对 `success !== true` 抛 `AgentUnavailableError(\`${type} failed\`)`，丢掉了 `error`。要让对齐步骤看得到它：
  在抛出的错误上带上应答的 `error` 字符串（只作分类用的字段，不进 `message`），或等价做法。`host-tool-align.ts` 的 `register` 按 D2 判别，
  命中时抛 `HttpError("kb_tool_conflict")`，否则原样抛出（照旧 502）。
- 后果与现状相同：这一步失败 → slot 退役、受理被补偿、入站帧没有 `prompt`。下一条 prompt 仍会起新进程再试一次（文件可能已被移除），不做缓存或熔断（YAGNI）。
- 不泄漏：omp 的 `error` 原文不进 HTTP 响应、日志行（含 `onError` → `server.ts:220` `emitSessionFault` 的 `session_fault` 行）、审计或 SSE；对外只有码与固定文案。

## D3 错误码

- `kb_tool_conflict`：HTTP 409，文案 `工作空间里有同名的项目工具 kb_search（.omp/tools），与知识库检索冲突，改名或移除后再试`。
- 409 而不是 502：请求本身合法，冲突来自工作空间的当前内容，所有者改了文件就能恢复，与 `undo_conflict`、`session_archived` 同类。
- 走现有的 `HTTP_ERROR_MESSAGES` / `HTTP_ERROR_STATUSES` 两张表；web 原样展示信封文案，不改 web。

## Sibling surfaces

- **已注册之后才加载的同名项目工具**（[INFERENCE]，未实测）：不变量默认 omp 在 `set_host_tools` 成功之后不会再在同一进程里加载同名的项目层工具
  （#2004 的用例都在 spawn 之前写文件；#2011 评论第 3 条）。若 omp 中途加载它，D1 会放行。登记为残余，写进 knowledge-base.md 与实测记录。
- **批准之后的冒充展示**（残余）：所有者批准项目层同名工具之后，它的输出仍以 `kb_search` 步骤与检索卡出现；返回的 `details.bases` 形状合法时还会被做成
  `kb.hits`（`server/src/sessions/events.ts:311`、`server/src/sessions/kb-hits.ts:51`），看起来就是检索命中。本 change 只保证「不经审批不执行」，不处理展示；文档如实写成残余。

- regenerate：派发前对齐在 `branch` 之前，冲突时 409，不发 `get_branch_messages` / `branch`，旧消息不变（chat-sessions delta）。会话先跑完一回合、之后所有者建库，下一次派发撞上冲突，是这条路径的典型来源。
- fork / 撤回的临时进程：不注册（现有规则），D1 下它们永远「未注册」。它们不跑模型回合，不会出现确认卡；即使出现也交给所有者，不放行。
- resume 或 spawn 的新一代：从「未注册」开始，与 omp-runtime「每个新 generation 都从尚未注册开始」一致。
- `always-ask`：不受影响（本来就不放行）。
- `yolo`：omp 不发确认卡（§2.4），不受影响。
- 浏览器 prelude 卡与其它审批识别：判定顺序不变（`kb_search` 放行先于审批识别；不满足 D1 时落到审批识别）。

## 被拒绝的方案

- 宿主 host tool 改名（例如 `owb_kb_search`）：堵不住项目层工具起同一个新名字，还改变模型可见的工具名与全部帧，代价大。
- 放行时比对 `tool_execution_start` 的 `toolCallId` 是否随后出现 `host_tool_call`：确认卡先于 `host_tool_call`（§2.3），等不到。
