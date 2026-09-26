# Design: fake-omp-approval-scenarios（#458）

Change surface: 只改 `server/test/support/fake-omp.mjs` 的 `parseArgs`（:81-95）、`dispatch`（:120-143）、`handlePrompt`（:276-307）、`handleAbort`（:369-380），另加审批门控辅助函数；新建 `server/test/fake-omp-approval.test.ts`。协议事实见父 design Context 与 D7。帧形状及其源码行号见 tasks.md「帧形状」。
Must preserve:
- 缺省与既有场景逐字节不变，无论 argv 带 `yolo`、`write` 还是不带该参数。
- `extension-ui` 的 `handleUi`/`pendingUi`（:340-357）不动：只有门控启用时，`extension_ui_response` 才路由到新处理器。
- abort-ok/abort-ignored 的 `idle→pending→done`（:39-40,292-295,363-380）不进入 `selecting` 态。`handleAbort` 改写后对这两个场景等价，#456 用例 `fake-omp-abort.test.ts` 零改动全绿。
- `emitToolRound`（:409-428）照旧输出 `content:[]` 与无 `isError` 的结束帧。
Must add/change: `--approval-mode` 同名参数取最后一次出现的值。`gated = APPROVAL_SCENARIOS.has(scenario) && approvalMode === "write"`，在进程启动时一次算定，只有值恰为 `write` 才门控。模块状态增加 `pendingSelects: Map<selectId, call>`、`approvedAny`、`deferredAbort`（`{id}` 或 undefined），`abortTurn` 增加 `selecting` 态。
Governing invariant: 门控回合中，每条 select 的应答立即且只发出它自己那次调用的 `tool_execution_end`。abort 被记下后，在最后一条应答的 `tool_execution_end` 之后才发 aborted 三帧（`message_end aborted` → `agent_end` → `response{id,command:"abort"}`），决不早于任何一条 `tool_execution_end`，也决不与正常完成帧并存。
State machine（仅 `gated`，入站帧经串行队列逐条处理；handler 必须在发完帧后返回，不得 await 应答）：

| 状态 | `prompt` | `extension_ui_response{id}` | `abort{id}` |
|---|---|---|---|
| `idle` | ack → `agent_start` → 3 段 delta → `message_end toolUse` → 每个调用一帧 `tool_execution_start` → 每个调用一帧 select → `selecting` | 忽略，无帧 | parallel/then-abort：无帧、不记录；approval：`unsupported` 兜底 |
| `selecting` | 不属契约（宿主会得到 SessionBusyError，不会发出） | id 不在 `pendingSelects`（未知或已答）：忽略，无帧。否则删除该 id，发该调用的结束帧（Approve 为成功帧，否则为拒绝帧）。表空时：有 `deferredAbort` 则发 aborted 三帧并转 `done`；否则 approval 发 `finishTurn` 并转 `done`；parallel 在 `approvedAny` 时发 `finishTurn` 并转 `done`，否则转 `pending`；then-abort 转 `pending` | parallel/then-abort：`deferredAbort ??= {id}`，无帧；approval：`unsupported` 兜底 |
| `pending` | 不属契约 | 忽略，无帧 | 发 aborted 三帧（回显该 id）→ `done` |
| `done` | 缺省路径（`probeReport` 或 `completeTurn(DELTAS,true)`） | 忽略，无帧 | parallel/then-abort：无帧；approval：`unsupported` |

「Approve」的判定：`frame.cancelled` 为假值且 `frame.value === "Approve"`，同 `rpc-mode.ts:524-531` 与 `wrapper.ts:337`。`Deny`、其它值、缺少 value、`cancelled` 为真（即使同时带 `value:"Approve"`）一律产生同一个拒绝帧。abort 与 prompt 一起流水线写入时，它在 prompt handler 发完 select 之后才被处理，等同「select 挂起时到达」。

Sibling surfaces:
- 消费 fake-omp 的既有测试文件都不需要编辑，会必然失败的既有断言为 0。这些文件包括直接引用的 10 个 `*.test.ts`，以及经 `session-supervisor-helpers.ts`/`server-startup-helpers.ts` 间接使用的测试。
- 下游消费者：
  - #460（`approval` + probe，验证 `extension_ui_response` 恰一次）。fake 对重复应答静默忽略，所以「第二次不写帧」只能靠 probe `frames=` 或 stdin 计数证明。
  - #464（`approval`/`approval-parallel`；`r1`/`r2`；超时由宿主发 `Approve` 后正常完成）。
  - #473（`approval-then-abort`/`approval-parallel`；回合结束后的 probe 走 `done` 缺省路径）。
  - #474（经 6.6；本场景证明的 Deny→abort 次序由它引用）。
  - #470 6.6（复用 select 形状、`r1`/`r2` 与拒绝帧，在状态机上加链式第二条）。
  - #461 6.5（复用 `emitAbortedEnd`）。
Seams under test: 只用 `fake-omp-helpers.ts` 的 `startFake({scenario,extraArgs})`/`startPromptedSession`/`HANDSHAKE`/`PROMPT`/`response`/`isTextDelta`/`asRecord`/`closeSession`/`stopFakeChildren`。`extraArgs` 追加在 helper `OMP_FLAGS` 的 `--approval-mode yolo`（:20-21）之后（:65），靠「取最后一次」生效。不访问夹具内部状态。
Required evidence: tasks.md 证据 1–11。1–3、5–10 先红，4、11 为恒绿守卫。
Non-goals: 见 proposal.md。
Review focus: (1) 表中每一格与实现一一对应，尤其 `selecting` 态的 abort 与最后一条应答；(2) abort-ok/abort-ignored/extension-ui 与缺省逐字节不变（证据 11 + #456 用例）；(3) 帧形状与 omp 源码行号相符；(4) 每条观察窗都用 helper 的 `/timed out/` 拒绝写法，同时证明无帧且进程存活。
