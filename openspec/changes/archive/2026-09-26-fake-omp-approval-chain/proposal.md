## Why
父 change `s1c-turn-control-governance` tasks 6.6（epic #448，issue #470）。4.6 #474 的有界退回结算用例要一个真实子进程演出这样的状态：stop 已 Deny 第一条审批并写出 `abort`，模型又发出第二条审批，而 abort 被忽略。于是 grace 到期、有界退回发生时，该回合仍有一条 pending 审批。现有场景演不出它：`approval-then-abort`/`approval-parallel` 会兑现 abort；`abort-ignored` 不发审批。

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: compact (agree: 测试支撑脚本 + 自带契约测试，无生产代码、无共享入口)
Compact despite Concurrency/Legacy packs: 只在 #458 的门控状态机上加一条链式分支。仍是单进程一条 promise 串行队列，无跨进程共享状态。本 issue 会重排 `handleAbort` 的判断顺序（对 `abort-ignored` 是等价改写），并从 `openSelects` 纯抽取 `emitSelect`（逐字节不变）。这两处分别由 `fake-omp-approval.test.ts`、`fake-omp-abort.test.ts`、`fake-omp-slow-ready.test.ts` 零改动全绿守护。state 表、陷阱和帧形状已钉在 tasks.md，所以不升 expanded（#458 改动这套状态机时定为 expanded）。
Blast radius: #474 有界退回用例的可信度。abort 若在 `r2` 应答后被兑现，或 `r2` 不出现，#474 就测不到「退回时仍有 pending 审批」。共用函数改坏时，`approval*`/`abort-*`/`slow-ready` 的既有用例会一起回归。
Selected risk packs: Concurrency / shared state / ordering；Legacy compatibility / examples；Schema / columns / units / field names；Error handling / rollback / partial outputs
Evidence floor: 新建 `server/test/fake-omp-approval-chain.test.ts`（真实子进程），覆盖 tasks.md 证据 1–6。1–5 先红后绿，6 为恒绿守卫。既有测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0；PR body 附 `wc -l server/test/support/fake-omp.mjs`（≤740）。design.md 省略：compact，无共享入口，无格式或 schema 变化，状态表与帧形状写在 tasks.md。

## What Changes
- `server/test/support/fake-omp.mjs`：新增 `--scenario approval-chain-abort-ignored`，加入 `APPROVAL_SCENARIOS`，所以只在最后一个 `--approval-mode` 恰为 `write` 时门控，否则同 `normal`。
  - 首个回合同 `approval` 开头，发出 `r1`。
  - `r1` 任意应答后，依次发 `tool-1` 的结束帧、`tool-2` 的 `tool_execution_start` 与 `r2` select。
  - `r2` 应答后发 `tool-2` 的结束帧，之后回合永久挂起。
  - 任何状态下的入站 `abort` 都不产生帧，也不被延后记录。
  - 进程在 stdin 关闭或 SIGTERM 时退出，不装 SIGTERM 处理器。
  - 复用 #458 的 `pendingSelects`、`toolStart`/`toolEnd`、select 形状与 `r1`/`r2` 编号，不另起状态机。
- 新建 `server/test/fake-omp-approval-chain.test.ts`：真实子进程，只用未改动的 `server/test/fake-omp-helpers.ts`。SIGTERM 用例按 `fake-omp-abort.test.ts:147-174` 先例在文件内直接 spawn。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：父 delta 整块逐字，相对当前主 spec 多三处：
  - 场景枚举句改为「support eight scripted scenarios (…)」；
  - `approval-chain-abort-ignored` 段；
  - Scenario「审批链上 abort 被忽略」。
  主 spec 现有的 11 个 Scenario 全部保留。归档后该 requirement 全部交付，父块与主 spec 逐字一致。其余 requirement 不动。

## Impact
- 只涉及测试支撑脚本与一个新测试文件。不触碰 `server/src/**`、既有测试文件、`fake-omp-helpers.ts`、`fake-omp-proxy.mjs`、`session-supervisor-helpers.ts`。
- `fake-omp.mjs` 当前 626 行。预计净增 15–30 行，#461 定的软上限为 ≤740。

## 偏离与决定（依据 omp v18.0.10 源码与 #474 验收）
- **第二个调用前不发第二个 `message_end stopReason toolUse`**：真实 omp 在模型的后续调用前会发 toolResult 的 message、新一轮 delta 与第二个 toolUse `message_end`。issue 验收与父 spec 规定「恰依次 `tool_execution_end` → `tool_execution_start` → `r2` select」，所以 fake 不演这些帧。首个 toolUse `message_end` 的 `content` 只有 `tool-1` 一块，因为回合开头「exactly like `approval`」。归约器不读 `message_end.content`（`server/src/sessions/events.ts:211-219` 只读 `stopReason`），`tool_execution_start` 按 `toolCallId` 开新步骤（`events.ts:156`）。
- **「`r1` 与 `r2` 之间」写入 abort 的定义**：fake 在处理 `r1` 应答的同一个 handler 里同步发出 `r2`，没有独立的「之间」状态。按 #458 证据 10 的先例，操作定义为一次 `write([r1 应答, abort])`：abort 在 `r2` 已写出后才被串行队列处理。
- **abort 永不回 `success:true`**：真实 omp 对每个 abort 都回应答（`rpc-mode.ts:1086-1088`）。本场景按 spec 模拟「abort 被忽略」，这是刻意偏离，与 `abort-ignored` 相同。
- **不属契约、不做断言的格**：
  - 挂起回合中写入的 prompt：`r2` 应答后会落入缺省 `probeReport`/`completeTurn` 路径，与 `abort-ignored` 在挂起后一致；宿主此时得到 SessionBusyError，不会发出。
  - 未知或重复的应答 id 静默忽略（沿用 #458）。证据 1 顺带断言重复的 `r1` 应答无帧，因为 #474 的 stop 只回答 `r1` 一次，这一格只作守卫。
- **SIGTERM 行为**：不同于 `hang-term`/`no-ready-hang`（`fake-omp.mjs:96-98` 忽略 SIGTERM，用来测 SIGKILL 升级），本场景对 SIGTERM 按 Node 缺省行为以信号退出。#474 的退回走 `runtime.ts:520-553` `#runRetire`：先关 stdin，只有在 `TERM_GRACE_MS` 内未退出才发 SIGTERM。本场景不在 `hang-*` 集合（`fake-omp.mjs:81,93`），stdin 关闭即 `exit(0)`，所以退回在第一步就结束，SIGTERM 只是兜底。

## Non-goals
- 其它 S1c scenario，包括 `approval`/`approval-parallel`/`approval-then-abort` 的任何行为变化（6.3 #458 已交付）。
- probe `frames=` 的记录规则（6.4 #459 已交付）。本场景的入站帧照常记录，不改记录点（`fake-omp.mjs:164-166`）。宿主够不到 probe：挂起期间 prompt 得 SessionBusyError，退回后进程已不在。与 `abort-ignored` 相同，本 issue 不断言 probe。
- supervisor 非作答路径结算（4.6 #474）；给 `session-supervisor-helpers.ts` 增加 yolo→write 替换入口（carry-forward #460：该 helper 不做替换，#474 自带 spawnImpl 包装）。
- 模拟真实 omp 第二个调用前的 toolResult message 与第二轮模型输出。
