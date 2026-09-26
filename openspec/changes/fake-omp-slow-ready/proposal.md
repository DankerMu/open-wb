## Why
这是父 change `s1c-turn-control-governance` 的 tasks 6.5（epic #448，issue #461）。

2.2b #488（runtime `abort()` 在 `prompt` 帧写出前返回 `false`）与 4.2b #490（supervisor 停止意图）需要一个真实 fake-omp 子进程，能把「获取/握手窗口」拉长到可观察，让宿主在 prompt 尚未派发时动作。现在的 fake 要么立即发 `ready`，要么（`no-ready`/`no-ready-hang`）永不发，做不到。

另外 `server/test/support/fake-omp.mjs` 已有 793 行。AGENTS.md:107 规定文件 ≤800 行（size-guard 不扫 `.mjs`，规则照样适用）。本 issue 净增约 30 行，6.6 #470 还要再加 30–40 行。所以本 PR 先做一次纯搬迁拆分，再加 `slow-ready`（carry-forward #458/#459 已写明这项义务）。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: 本 PR 必须先纯拆分 fake-omp.mjs。这个夹具有 13 个直接消费的测试文件，CI `uid-isolation` job 还以 omp uid 执行它。另外，stdin 关闭与挂起的 ready 计时器存在竞态（Concurrency），而且要给出零改动的既有测试清单（Legacy）。这两个 expanded 触发条件成立。先例 #458/#459 同样覆写为 expanded)
Blast radius: #488/#490 的「派发回执后 abort」与停止意图用例。延迟不生效时，这些用例测不到获取窗口；持有回合与 abort-ok 不一致时，它们的 aborted 帧序与 probe `frames=` 会失真。拆分做错时，call-proxy（`fake-omp.test.ts` 的 6 个用例、`server-startup-order.test.ts` 的生产入口用例）和 CI `uid-isolation` 会回归。
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs；Auth / permissions / secrets；Release / packaging / dependency compatibility
Evidence floor: 提交 1（纯拆分）：既有测试零 diff 全绿，新旧逐字节对照矩阵全部相同。提交 2：新建 `server/test/fake-omp-slow-ready.test.ts`（真实子进程），覆盖 tasks.md 证据 E1–E6 与守卫 G1–G3。两个提交都要让 `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0，并用 `wc -l` 核对行数。PR body 附 CI `uid-isolation` job 在 PR head 上的绿色运行链接。

## What Changes
- 提交 1，纯搬迁、行为不变（见 design.md「拆分」）：
  - 把 `fake-omp.mjs:596-793` 移到新建的 `server/test/support/fake-omp-proxy.mjs`。这段代码是 call-proxy 的上游客户端：`parseToolCall`、`loadBaseUrl`、models.yml 解析、`postChat`、SSE 重组。移过去的代码只依赖 `node:` 内建模块。
  - 新模块只导出 `parseToolCall`、`loadBaseUrl`、`postChat`。
  - `fake-omp.mjs` 删掉 `:9-10` 的 http/https 导入，增加一行相对导入。
  - 预期行数：主文件 793 → 593，新模块 207。
- 提交 2，在 `fake-omp.mjs` 中新增 `slow-ready`：
  - `parseArgs` 解析 `--ready-delay-ms <n>`，取最后一次出现的值，与 `--scenario` 的位置无关。
  - 只在 `slow-ready` 下校验：`/^\d+$/` 且 ≤2147483647，缺省 500；非法值使进程在模块求值时抛错退出（退出码 1、stdout 无帧）。
  - `ready` 帧扣到延迟到期再发。字节与现有 `ready` 相同，并位于串行 queue 的队头。
  - 延迟期间 stdin 关闭：立即 `exit(0)`，不发任何帧。
  - 把 `"slow-ready"` 加入 `ABORT_SCENARIOS`（`:24`），因此其后行为与 `abort-ok` 逐字节一致。
  - 其它 scenario 完全忽略这个 knob。
- 新建 `server/test/fake-omp-slow-ready.test.ts`：真实子进程，只用未改动的 `fake-omp-helpers.ts`。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：以当前主 spec 为底，全部 Scenario 原样保留。并入父 delta 的以下部分，均逐字：
  - `slow-ready`/`--ready-delay-ms` 段，插在「Existing scenarios and defaults SHALL remain unchanged.」之前；
  - Scenario「延迟握手」，按父 delta 次序插在「并行审批各自应答」与「select 挂起时 abort 被延后」之间。
  - 场景枚举句追加 `slow-ready`。不照抄父 delta 的「eight scripted scenarios (…approval-chain-abort-ignored…)」，因为 6.6 尚未交付。
- MODIFIED `omp-test-harness`「假 omp 入站帧记录」：主 spec 原文，加上 #459 延后的 Scenario「延迟握手期间停止 → 帧序 prompt,abort」（逐字取父 delta）。加入后该 requirement 与父 delta 逐字一致，全部交付。
- ADDED `omp-test-harness`「假 omp 夹具模块划分」：自写，写模块职责与导入方向，先例是 `2026-09-26-session-store-split`。
- 留给 6.6 #470：`approval-chain-abort-ignored` 段、场景枚举的最终形态、Scenario「审批链上 abort 被忽略」。

## Impact
- 涉及测试支撑脚本 `fake-omp.mjs`、新模块 `fake-omp-proxy.mjs`、一个新测试文件。
- 不触碰 `server/src/**`、任何既有测试文件、`fake-omp-helpers.ts`、`session-supervisor-helpers.ts`、CI 脚本与 sudoers 规则。
- 行数：提交 1 后主文件为 593 行；提交 2 后 ≤630 行（硬上限 740），给 #470 留出 ≥110 行余量。

## 偏离与决定
- **超出 issue PR Boundary**（issue 只允许改 `fake-omp.mjs` 并新建一个测试文件）：本 PR 另新建 `server/test/support/fake-omp-proxy.mjs`。
  - 理由：AGENTS.md:107 的 800 行上限；#470 还要继续增长。
  - 先例：父 tasks.md:6/:21 的 2.0 式条件拆分（「若后续将超限，同刀拆出」）。
  - 形式：拆分是本 PR 的第一个独立提交，先验证全绿，再加 `slow-ready`。仍是一个 PR。
- **拆分缝选 call-proxy 上游客户端，不选派单建议的审批状态机**。派单建议的切法是审批 factory：`abortTurn`/`deferredAbort`/`pendingSelects`/`approvedAny` 要经 getter/setter 跨模块，`handlePrompt`/`dispatch`/`handleAbort` 仍然读写它们，这不是纯搬迁；逐字节对照的面会是整个回合状态机；主文件只降到约 703 行。proxy 尾段是纯函数：没有模块状态，没有回调，只依赖 `node:` 内建模块。主文件因此降到 593 行，余量更大。
- **ADDED 模块划分 requirement 不在父 delta 里**：沿用 session-store-split 先例与 carry-forward（#452）的要求。归档时原样推进，父 delta 不需要对账。
- **延迟期间 stdin 关闭 = 立即退出、零帧**：issue 验收写「不挂起」。如果把延迟放进 queue 再等关闭，「不挂起」就变成「挂起整段延迟」，而 knob 没有上限。父 delta 括号里的「`ready` does eventually arrive」按稳态描述理解，不适用于关闭的情形。
- **非法 knob 抛错退出**：issue 规定取值为「非负整数」。如果静默回落到 500，这条约束就形同虚设，下游计时用例可能因错误的理由通过。超过 2147483647 的值会让 `setTimeout` 溢出成 1ms，所以也算非法。
- **消费者编号**：2.2b = #488，4.2b = #490（`gh issue view` 核对）。

## Non-goals
- 其它 S1c scenario（6.6 #470 `approval-chain-abort-ignored`）；probe `frames=` 的记录规则（6.4 #459 已交付）。
- runtime `abort()` 返回 `false` 的语义（2.2b #488）；supervisor 停止意图（4.2b #490）；给 `session-supervisor-helpers.ts` 增加传 knob 的入口。
- `no-ready`/`no-ready-hang` 与其它既有 scenario 的任何行为变化。
- ready 之前写入的入站帧的契约：父 spec 写「not expected」。本实现会在 `ready` 之后再处理它们，但不做断言。
- 修改父 delta 段落里硬编码的测试文件名（runbook 规则 2 的隐患，#459 已记）。
