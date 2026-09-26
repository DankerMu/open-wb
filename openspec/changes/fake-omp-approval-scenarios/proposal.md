## Why
父 change `s1c-turn-control-governance` tasks 6.3（epic #448，issue #458）。审批链路的服务端测试（2.1a #460 识别与 `respondApproval`、4.3 #464 登记/计时/作答、4.2a #473「先 Deny 后 abort」停止帧序、4.6 #474 非作答结算）都要用真实子进程演出 omp v18.0.10 在 `--approval-mode write` 下的行为：先 `tool_execution_start`，再发审批 select，未应答不前进，abort 要等 select 应答后才兑现。现有 fake-omp 忽略 `--approval-mode`，唯一的 UI 请求场景 `extension-ui` 只发 `confirm`、只认 `cancelled`，演不出这些行为。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: 带多个状态的状态机加延后 abort，是组 4 帧序断言的 oracle；它和 abort-ok/abort-ignored 共用 `abortTurn` 与 `handleAbort`，也和 `extension-ui` 共用 `extension_ui_response` 分发，因此 Concurrency 与 Legacy 两个 expanded 触发条件都成立)
Blast radius: #460/#464/#473/#474 的帧序断言。规则写错时，这些用例证明的是假命题，例如「Deny 先于 abort」其实没有被确定性兑现；共享状态改坏时，abort-ok/abort-ignored/extension-ui 的既有用例和 #456 的消费者会一起回归。
Selected risk packs: Concurrency / shared state / ordering；Legacy compatibility / examples；Schema / columns / units / field names；Error handling / rollback / partial outputs；Public API / CLI / script entry
Evidence floor: 新建 `server/test/fake-omp-approval.test.ts`（真实子进程）覆盖 tasks.md 证据 1–11。正向断言先红后绿，yolo 与既有场景的守卫恒绿。既有 fake-omp 测试零改动全绿。`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。

## What Changes
- `server/test/support/fake-omp.mjs`：
  - `parseArgs` 增加 `--approval-mode <mode>`，同名参数出现多次时取最后一次。
  - 新增 `--scenario approval|approval-parallel|approval-then-abort`。仅当 mode 恰为 `write` 时启用审批门控状态机，否则三者与 `normal` 逐字节相同。
  - 既有 `abortTurn` 状态增加 `selecting` 态，abort 三帧抽成共用的 `emitAbortedEnd(id)`。abort-ok/abort-ignored/extension-ui 与缺省行为逐字节不变。
- 新建 `server/test/fake-omp-approval.test.ts`：真实子进程，只用未改动的 `server/test/fake-omp-helpers.ts`。

- spec 自写一句「每进程只门控首个回合」：父 delta 的 `approval`/`approval-parallel` 段没有这条规则，而 fixture 与消费者（#460/#473 回合后 probe）依赖它；归档 PR 同步补入父 delta（#565 评审 P2）。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：以当前主 spec 为底（已含 abort-ok/abort-ignored/branch），并入父 delta 的三部分，均逐字：argv `--approval-mode <mode>`，`approval`/`approval-then-abort`/`approval-parallel` 三段，Scenario「审批 select 门控 bash」「并行审批各自应答」「select 挂起时 abort 被延后」。以下部分不在本 delta，由对应 issue 归档时并入：`approval-chain-abort-ignored`（6.6 #470）、`slow-ready`（6.5 #461）、probe `frames=`/入站帧记录（6.4 #459）。

## Impact
- 只涉及测试支撑脚本与一个新测试文件。不触碰 `server/src/**`、既有测试文件与 `fake-omp-helpers.ts`。

## 偏离与决定（依据 omp v18.0.10 源码与下游 issue 验收）
- 消费者编号更正：派单里写的「#462 2.1a」「#463 4.3」有误，经 `gh issue view` 核对，2.1a 是 #460，4.3 是 #464。#462 是 2.2a，#463 是 4.1，两者都不消费本场景。
- select id 固定为 `r1`、`r2`，按工具调用顺序分配。#464 验收直接写 fake 收到 `{id:"r1",value:"Approve"}`、`request_id="r1"`，父 6.6 也用 `r1/r2`。真实 omp 用 Snowflake id（`rpc-mode.ts:656`），所以 `r1`/`r2` 只是 fake 契约。生产代码必须按帧 `id` 关联，不得假设 id 格式。
- Approve 后的 `tool_execution_end` 沿用 `normal` 的成功帧，不带 `isError` 键，与 issue「无 isError」一致。真实 omp 写的是 `isError:false`（`agent-loop.ts:2690` → `:2465-2471`），归约器只认 `isError === true`（`server/src/sessions/events.ts:196`），语义等价。
- write 模式下 toolUse 的 `message_end.message.content` 带 `{type:"toolCall",id,name,arguments}` 块（`ai/src/types.ts:827-831`），满足父 spec「carrying two bash tool calls」的字面要求。yolo 下走 `normal` 原路径，仍是 `content:[]`。
- 每个进程只演一次门控回合，同 abort-ok 的 `done` 约定：回合结束后（完成或 aborted），后续 prompt 走缺省 `probeReport`/`completeTurn`。#460/#473 在回合后发 probe prompt 取 `frames=`，依赖这一点。
- 纯 `approval` 场景不注册 abort 处理器，入站 abort 落入既有无 id 的 `unsupported` 兜底，不属契约。需要停止帧序的用例改用 `approval-then-abort`/`approval-parallel`。
- 一个回合只记录第一个 abort：`selecting` 态重复 abort、`done`/`idle` 态 abort 都不发帧（沿用 #456 的约定）。真实 omp 对每个 abort 都会回 `success:true`。宿主重复 stop 只发一帧 abort（父 D2），所以不影响消费者。
- 不模拟：toolResult 的 `message_start`/`message_end`；拒绝后模型的后续调用；Approve 后在已 abort 信号下真实执行 bash 的结果；`method:"cancel"` 帧（审批 select 不带 signal，真实 omp 也不发，见 `wrapper.ts:332` 与 `rpc-mode.ts:654,665-675`）；`tool_execution_start.intent`。

## Non-goals
- `approval-chain-abort-ignored`（6.6 #470）、probe `frames=`（6.4 #459）、`slow-ready`（6.5 #461）。
- `OmpProcess` 审批识别（2.1a #460）、supervisor 审批登记/计时/结算（4.3 #464）、停止（4.2a #473）。
- 形状不符的 select（其它 options 或 title）不由 fake 演出，#460 以合成帧直接喂分类器。
- `extension-ui` 场景的行为变化。
