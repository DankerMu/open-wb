# Design: fake-omp-slash-scenario（#552）

父设计：design D15「事实」段与 D12 补记；omp 对照 `resource/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1019-1054`（内建命令 `output: text => output({type:"command_output", text})`，回执 `success(id,"prompt",{agentInvoked: builtinResult.agentInvoked === true})`）、:1086-1088（`abort` → `success(id,"abort")`，无 `data`）、`slash-commands/helpers/todo.ts:246-260`、`slash-commands/builtin-lifecycle.ts:140-190`（`compact` 经 `runCommandInBackground`，回执先于输出）。行号为 origin/master。

- **Change surface**：`server/test/support/fake-omp.mjs` 的 `BRANCH_MESSAGES`（:52-57）、`VALUE_ARGS`（:59-66）与 `parseArgs`（:136-147）、`dispatch`（:202-224）、`handleBranchMessages`/`handleBranch`（:292-328）、`handlePrompt`（:358-）；新测试文件；`fake-omp-metadata-scenarios.test.ts:526` 一行删除。
- **Must preserve**：
  - 既有全部场景（含 A 的八个与 `thinking`/`edit-write`）出站帧逐字节不变；既有 argv 解析不变（取值型参数一律吞掉下一 token；缺值语义逐键不变）；新旋钮被其它场景完全忽略、与 `--scenario` 次序无关。
  - `branch` 不带 `--branch-entry` 时 `get_branch_messages` 列表逐字不变（两条固定 entry），`branch{entryId}` 的写文件/切换/错误路径不变。
  - 串行 queue 与 `inbound` 记录点（`onLine`）不变；probe 回报不变；`handleAbort` 与 `abortable` 对既有场景不变。
- **Must add/change**：
  - 常量：`TODO_OUTPUT = "No todos. Use /todo append <task> to start one."`、`COMPACT_OUTPUT = "Compaction complete."`、`COMPACT_DELAY_MS = 50`。
  - `handlePrompt` 在发回执**之前**判定：`scenario === "slash"` 且 `frame.message` 严格等于 `/todo` 或 `/compact`（`===`，不 trim；`/todo append x`、` /todo`、非字符串一律不命中）→ 进入 slash 分支并返回，不发 `agentInvoked:true` 回执，不发 `agent_start`/`agent_end`；否则走既有路径（`slash` 不在 `turns` 表中，故走 probe/`normal`）。
    - `/todo`：`emit({type:"command_output", text: TODO_OUTPUT})`，然后 `emit({id, type:"response", command:"prompt", success:true, data:{agentInvoked:false}})`。
    - `/compact`：先发同形回执；无 `--compact-silent` 时再 `setTimeout(COMPACT_DELAY_MS)` 登记一个待输出，定时器到期时把 `emit({type:"command_output", text: COMPACT_OUTPUT})` **追加到串行 queue**（`queue = queue.then(...)`，不直接 emit，保证不与进行中的回合帧交错）；有 `--compact-silent` 时不登记定时器，此后不发任何帧。
    - 待输出以 token 登记在模块级 `Set` 中（可同时存在多个 `/compact`，每个各自输出一次）。定时器到期回调**不**移出集合，只把 `() => pending.delete(token) ? emit({type:"command_output", text: COMPACT_OUTPUT}) : undefined` 追加到串行 queue——输出是否发出在出队时判定，凡在输出出队前被处理的 `abort` 都能取消它（包括「abort 行已排进 queue、随后定时器到期」的情形）。
  - `slash` 下 `dispatch` 注册 `abort` → 新处理函数：`clearTimeout` 集合中全部定时器并清空，然后 `emit({id: frame.id, type:"response", command:"abort", success:true})`（无 `data`，同 omp）。任何时刻（无待输出、`--compact-silent`、`normal` 回合之后）都回执。只有输出已出队并发出之后才处理到的 `abort` 不影响已发出的输出。
  - stdin 关闭：沿用既有 `rl.on("close")`（queue 排空后退出 0）；未到期的待输出随进程退出丢弃，不保证发出（spec 未规定，宿主不依赖）。
  - `parseArgs`：布尔旋钮改为表驱动（`--hold-after-thinking` → `hold`、`--compact-silent` → `silent`，结果缺省 `false`）；`--branch-entry <text>` 可重复，按 argv 序收集到数组（缺省 `[]`），值为紧随其后的 token（原样，含前导空格；同取值型参数一律吞掉下一 token）；位于 argv 末尾缺值时不追加条目。`parseArgs` 认知复杂度 ≤15。
  - `branch` 列表：固定两条（`fake-entry-1`/`first question`、`fake-entry-2`/`second question`）之后，按序追加 `{entryId: "fake-entry-<3+i>", text}`；整个列表在模块顶层计算一次并冻结，进程生命周期内不变。`handleBranchMessages`/`handleBranch` 使用该列表，对追加条目的行为与固定条目完全相同。`--branch-entry` 在非 `branch` 场景下被忽略（`get_branch_messages` 仍为 unsupported）。
- **Line budget**：`fake-omp.mjs` 改后 ≤ 800 行（当前 720）。可抽 `promptAck(id, agentInvoked)` 供既有 `agentInvoked:true` 回执与新回执共用（输出字节不变）。放不下即停止回报；不拆新模块、不压缩既有注释以腾行。
- **Sibling surfaces**：
  - 宿主 `server/src/sessions/omp/process.ts` 生产 argv（:71-87）不含 `--compact-silent`/`--branch-entry`，无冲突。
  - `server/test/session-supervisor-helpers.ts` 在生产 argv 之后追加 `--scenario <name>`，与新旋钮位置无关。
  - `fake-omp-metadata-scenarios.test.ts` 的模块划分用例：import 规则不变（本 PR 不改 import），删除 720 断言后 800 断言仍覆盖。
- **Required evidence**（`server/test/fake-omp-slash.test.ts`，真实子进程，经 `fake-omp-helpers.ts` 的 `startFake`/`startPromptedSession` 等既有 helper；每条先红后绿）：
  1. `slash` 握手后收 `/todo`（`id:"req_todo"`）→ 恰两帧、逐字段 `toEqual`：`{type:"command_output", text:"No todos. Use /todo append <task> to start one."}`，然后 `{id:"req_todo", type:"response", command:"prompt", success:true, data:{agentInvoked:false}}`；其后 ≥200 ms 静默窗口无任何帧。
  2. 同一进程再收 `/compact`（`id:"req_compact"`）→ 首帧为同形回执（回显 id），第二帧为 `{type:"command_output", text:"Compaction complete."}`，1 s 内到达；其后 ≥200 ms 静默。不断言到达间隔下界（父进程观察到的间隔受管道调度影响，CI 下不稳）；「输出经定时器延后、存在可取消窗口」由证据 5 证明。
  3. 同一进程再收 ` /session delete`（首字符 U+0020）→ 帧序列与另起一个 `normal` 进程收同一 prompt 的帧序列 deep-equal（`agent_start`、三段 delta、bash 工具 start/end、`message_end`、终止 `agent_end`，回执 `agentInvoked:true`），且无 `command_output`。另：`slash` 收 `/todo append x` 同样与 `normal` deep-equal（证明精确匹配）。
  4. `slash --compact-silent` 收 `/compact` → 恰一帧回执；300 ms 静默；再发 `abort{id:"req_abort_y"}` → 恰一帧 `{id:"req_abort_y", type:"response", command:"abort", success:true}`；再 200 ms 静默（无 `command_output`）；关闭 stdin → 进程退出码 0。
  5. `slash`（无 silent）在同一次 `session.write([{id:"req_compact_x", type:"prompt", message:"/compact"}, {id:"req_abort_x", type:"abort"}])` 中写入两行（同仓库 `write([PROMPT, ABORT])` 先例，与负载无关的确定性构造）→ 恰得两帧：`/compact` 回执，然后 `{id:"req_abort_x", type:"response", command:"abort", success:true}`；此后 300 ms（远超 50 ms）内无 `command_output`。
  5b. 多个待输出：`slash` 在同一次 write 中连发两个 `/compact`（`req_c1`、`req_c2`）→ 两个回执（按序回显 id）之后恰两条 `command_output{text:"Compaction complete."}`，其后 200 ms 静默；另起进程同一次 write 连发两个 `/compact` 与一个 `abort` → 两个回执与 abort 回执，300 ms 内无 `command_output`。
  6. `slash` 无待输出时收 `abort{id}` → 恰一帧 abort 回执（「always answered」）。
  7. `branch --branch-entry " /help 这是什么" --branch-entry "继续"` 并带 `--session-dir <tmp>` → `get_branch_messages` 的 `data.messages` 恰为 `[{fake-entry-1,first question},{fake-entry-2,second question},{fake-entry-3," /help 这是什么"},{fake-entry-4,"继续"}]`；`branch{entryId:"fake-entry-4"}` 回 `{text:"继续", cancelled:false}`，`<tmp>` 下新增一个非空 `.jsonl`，随后 `get_state.sessionFile` 等于该文件；`branch{entryId:"fake-entry-3"}` 回 `text` 恰为 ` /help 这是什么`（前导空格保留）。
  8. 缺值：`--scenario branch --branch-entry`（旋钮为最后一个参数）→ 列表恰为两条固定 entry。
  9. 旋钮隔离：(a) `normal` 带 `--compact-silent --branch-entry x` 与不带时，对 prompt `/compact`（`id:"req_n"`）的帧序列 deep-equal，且回执 `agentInvoked:true`、含完整 normal 回合、无 `command_output`（证明只有 `slash` 识别命令）；(b) `branch` 不带旋钮时列表恰为两条固定 entry；(c) `slash` 带 `--branch-entry x` 时 `get_branch_messages` 回 `success:false`、`error:"unsupported"`。
  10. 行数：`wc -l server/test/support/fake-omp.mjs` ≤ 800（由既有模块划分用例的 800 断言覆盖，PR 写明实测值）。
