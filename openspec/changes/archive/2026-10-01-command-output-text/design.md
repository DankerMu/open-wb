# Design: command-output-text（#554）

父设计：D15「决定：命令回复归约」「决定：本地完成的等待」。行号为 origin/master（42670a3）。

- **Change surface**：`server/src/sessions/events.ts`（`EventState` :65-73、`createEventState` :80-93、`applyFrame` :95-117、`evolve` :297-316；403 行）；新建 `server/test/session-events-command.test.ts`、`server/test/supervisor-command-output.test.ts`。
- **omp 事实**：`command_output{type, text}` 无 `id`；`/todo` 无参先输出再回执 `response{command:"prompt", success:true, data:{agentInvoked:false}}`；`/compact` 先回执后输出，被 `abort` 取消时无输出（D15；fake `slash` 复刻于 `fake-omp.mjs:589-615`，文本常量 `TODO_OUTPUT`/`COMPACT_OUTPUT`）。
- **Governing invariant**：归约器无 IO、无时钟、不累积正文；state 只多一个布尔。助手正文 = 该回合各 `command_output.text` 以 `\n` 连接（首条无前缀），由既有 `text.delta` → `appendDelta` 路径落库。
- **Must preserve**：
  - `applyFrame` 入口的终态守卫（`state.ended` → 无事件、state 不变）覆盖新 case。
  - `applyAgentStart`：已 `started` 时不再产出 `turn.start`、不重置——`command_output` 置 `started` 后到达的 `agent_start` 因此无事件。
  - 成功的 prompt ACK（`response … success:true`）仍无事件（`applyPromptFailure` 只处理失败）；`command_output` 不参与 requestId 关联。
  - 既有 chat-stream 全部 Scenario；`session-events.test.ts`（含 :98-128 噪声帧列表）零 diff 全绿；返回事件不别名 state；两个 state 相互隔离。
  - `supervisor.ts` 零改动：`turn.start`/`text.delta` 走既有 `persistEvent`；本地完成由 runtime（10.2）结束迭代后 pump 末尾补 `turn.end done`（`mapper.ended` 为假）；等待期 stop 走 A 的 stop 例外（grace 后 `applyStop`）。#519 的 thinking 缓冲对这些事件为空操作。
- **Must add/change**：
  - `EventState` 增 `readonly commandOutputSeen: boolean`；`createEventState` 初值 `false`；`evolve` 的 patch 增 `commandOutputSeen?`。
  - `applyFrame` 增 `case "command_output": return applyCommandOutput(state, frame);`。
  - `applyCommandOutput`：`typeof frame.text !== "string"` → `{state, events: []}`（state 同一引用）；否则事件为 `[...(state.started ? [] : [turn.start{messageId}]), text.delta{messageId, delta: state.commandOutputSeen ? "\n" + text : text}]`，state 置 `started: true`、`commandOutputSeen: true`。空字符串 `text` 仍是字符串：按规则产出（首条 delta 为 `""`，后续为 `"\n"`）。
- **Sibling surfaces**：web 流归约（`web/src/features/chat/stream.ts`）对 `turn.start` 后的 `text.delta` 无来源假设；SSE 回放无特殊处理；regenerate/fork 对命令锚点的 400 属 10.4b；runtime 本地完成等待（`omp/local-command.ts`，`LOCAL_COMMAND_GRACE_MS = 120_000`）。
- **残余**：
  - 等待到期后才到的压缩输出按当时活跃回合处理（无回合则丢弃），可能并入下一回合正文——父 spec 已明示的残余；本刀后该文本变为用户可见（下一回合正文前多出 `Compaction complete.`），不在本刀处理。
  - 范围外发现（10.2 既有行为，回报父 change）：Scenario「advances 120 000 ms → done」隐含 idle > 120 000 ms；部署若把 `OMP_IDLE_MS` 设到 120 000 以下，静默压缩以 `failed` 而非 `done` 结束。
  - 「真实回合中后到的 `agent_start` 不重复 `turn.start`」只有纯函数 P1 覆盖（fake `slash` 不发 `agent_start`，supervisor 为直通）。
- **Required evidence**（RED：P1、P2 中「`agent_start` 先到再 `command_output`」与 `text:""` 两例、P3 的「两个独立 state 互不影响」与「修改返回事件不影响后续输出」两例、S1–S2 在实现前红（无 `turn.start`/`text.delta`、正文为空）；P2 的非字符串 `text` 一例、P3 的终态后无事件一例、S3、S4 为 characterization（现已成立，锁定不回归）——红与绿的断言放在不同 `it`；以实际运行记录）：
  - 纯函数 `session-events-command.test.ts`（`createEventState` + `applyFrame`/`applyStop`/`applyFailure`）：
    - P1（「Command output becomes assistant text」）：无 `agent_start` 下依次 `command_output{text:"No todos. Use /todo append <task> to start one."}`、`command_output{text:"second"}`、`command_output{output:"x"}`、成功 ACK `response{command:"prompt", success:true, data:{agentInvoked:false}}`、`agent_start` → 各步返回 `events` 依次恰为 `[turn.start, text.delta(原文)]`、`[text.delta("\nsecond")]`、`[]`、`[]`、`[]`，messageId 均为绑定值；末 state 非终态、`started` 为真，state 的任何字段都不含输出文本（序列化后不含该串）。
    - P2：`agent_start` 先到再 `command_output` → `[turn.start]` 然后 `[text.delta(text)]`（不重复 `turn.start`）；`text` 为数字/对象/缺失/null → 无事件且 state 为同一引用；`text:""` → 首条 `text.delta{delta:""}`、次条 `"\n"`。
    - P3：终态后（分别经 `applyStop`、`agent_end`、匹配的失败 `response`）的 `command_output` → `[]` 且 state 同一引用；两个独立 state 互不影响；修改返回事件对象不影响后续输出。
  - 集成 `supervisor-command-output.test.ts`（真实 fake `slash` + 真实 SQLite + production `createApp`/supervisor，`POST …/prompt`；旋钮与注入时钟的传法照 `session-thinking.test.ts`，既有 helper 零改动。**同步点**：`POST …/prompt` 的 202 只等派发不等回执，S3/S4 在推进时钟或发 stop 之前先等注入时钟上出现 `ms === 120000` 的计时器（包一层 `clock.setTimeout` 记录，同 `session-thinking.test.ts:67-87`），证明 runtime 已进入本地完成等待）：
    - S1 `/todo`：记录事件恰为 `turn.start`、一条 `text.delta`、`turn.end{done}`；在 `onEvent` 收到 `turn.end` 的同一同步回调内读 `chat_messages`，助手 content 已精确等于 `No todos. Use /todo append <task> to start one.` 且状态为 `done`（正文先于 `turn.end` 发布落库；`appendDelta` 只入缓冲，落库在终态事务）；无 `chat_steps` 行；消息与会话 `done`；无 `error` 事件、error sink 为空。
    - S2 `/compact`：同三事件；同样在 `turn.end` 回调内读到 content 精确等于 `Compaction complete.` 且 `done`（输出晚于回执，仍先于 `turn.end` 落库）。
    - S3 `slash --compact-silent` + `/compact`：该用例把 `runtime.idleMs` 覆写为大于 120 000 的值（如生产默认 600 000；`RuntimeOptions.idleMs` 可写，helper 不改）——否则共用注入时钟的 idle（测试默认 10 000 ms）先到期，回合以 `error` + `turn.end failed` 结束（`omp-runtime-local-command.test.ts:187-205` 先例）；到达同步点后、推进 120 000 ms 前断言回合仍 running、无事件；推进后恰一条 `turn.end{done}`，无 `turn.start`/`text.delta`，content 为空串，会话 `done`。
    - S4 `slash --compact-silent`（idle 保持测试默认，不覆写：grace 8000 < idle 10 000）到达同步点后 `POST …/stop` → 202；子进程收到 `abort` 帧并回 `response{command:"abort"}`、无 `command_output`；注入时钟过 `OMP_ABORT_GRACE_MS`（8000 ms）→ runtime 退役、恰一条 `turn.end{stopped}`、无 `error`；content 为空、会话与助手 `stopped`。
  - 既有：`session-events.test.ts` 零 diff；`omp-runtime-local-command.test.ts`、`fake-omp-slash.test.ts`、`session-thinking.test.ts` 全绿。
  - 门禁：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0。
