# Proposal: supervisor-split（#487）

## Why
这是父 change `s1c-turn-control-governance` 的 tasks 4.0b（epic #448）。`server/src/sessions/supervisor.ts` 现为 772 行（origin/master `e23febb` 实测；issue 写 770，#451 之后多了 2 行）。size-guard 硬限 800 行，余量放不下 4.1–4.6 的接线：池治理、停止、审批、regenerate/fork、非作答结算。父 design「模块拆分（size-guard）」规定这一组的首刀是纯搬迁，并固定了落点名称。

## Triage
Issue type: refactor
Fixture level: expanded
Upstream suggested level: expanded (agree: 触及 AGENTS.md Critical Path「omp 子进程治理」。slot 认领释放与 generation 结构跨文件搬迁后，搬错会让进程泄漏，或让回合卡在 `session_busy`)
Blast radius: 所有会话的派发与回合落库。认领释放 `releaseClaim`/`releasePumpExit` 或事件落库映射 `persistEvent` 若发生语义漂移，会话会一直 busy，或步骤、正文丢失。
Selected risk packs: Concurrency / shared state / ordering（认领与泵退出的释放次序）；Legacy compatibility / examples（`supervisor.ts` 导出集合与全部导入方不变）；Error handling / rollback / partial outputs（预进度失败后的 drain 与 retire 次序）
Evidence floor: 以下各项全部满足：既有测试零 diff 全绿（server 97 文件 / 1638 例，与 `e23febb` 相同）；三条逐字搬迁 diff 输出为空；`bash scripts/size-guard.sh` 退出 0，且 `supervisor.ts` ≤ 661 行；`make lint`、`make typecheck`、`make anti-drift`（含 knip 零新增）、`npm run build --workspace server` 退出 0。

## What Changes
- 新建 `server/src/sessions/pool.ts`，逐字搬入 slot 登记：`Generation`/`Slot` 记录形状，以及回合认领释放 `ClaimSlot`/`releasePumpExit`/`releaseClaim`。
- 新建 `server/src/sessions/turn-control.ts`，逐字搬入回合派发辅助：事件落库映射 `persistEvent`，以及预进度失败后的帧排空 `drain`。
- `supervisor.ts` 删去这些块，新增两行 import，并保留 `releasePumpExit` 的再导出：`export { releasePumpExit } from "./pool.js";`，因为 `server/test/session-supervisor-claims.test.ts:2` 从 `supervisor.js` 导入它。类的全部方法原地不动。
- 不新增测试，也不改任何测试（纯搬迁）。

偏离/澄清（相对 issue 正文）：
1. **本刀不建 `approvals.ts`。** issue 的验收要求「三个新文件各承载真实搬迁内容（非空、非占位）」，又要求「不留空文件或占位导出」。但 `supervisor.ts` 里没有任何审批登记、计时或结算代码，`grep -ci approv server/src/sessions/supervisor.ts` 结果为 0，也就没有能诚实搬进去的块。硬凑一个块等于占位。两条互相冲突时，本刀取「非空、非占位」这条约束，由 4.3（#464）新建 `approvals.ts`。#464 的 PR Boundary 已经把 `approvals.ts` 列为它的文件，归属不变。
2. `turn-control.ts` 首刀承载的是「回合事件落库映射与预进度排空」，没有 stop/regenerate/fork。这两个辅助就是现有的派发辅助（issue 原文为「先搬既有 slot 登记与派发辅助」）。之后 4.2a/4.2b/4.4/4.5 在同一文件加入编排，停止回合的 `turn.end stopped` 也经 `persistEvent` 落库。
3. 三个生成代计数私有方法 `#releaseDispatch`/`#releasePump`/`#sealGeneration` 留在类内。把它们改成模块函数要改 7 处调用点，已经不是逐字搬迁。如果 4.1 需要这部分空间，由 4.1 自己上提。

## Capabilities
- ADDED `chat-sessions`「会话 supervisor 源码模块划分」：记录 size-guard 落点、模块的长期职责和依赖方向。父 delta 没有对应的 requirement，依据是父 design「模块拆分（size-guard）」，与 #454/#471 先例同形。

## Impact
- 只涉及 `server/src/sessions/supervisor.ts`，以及新建的 `pool.ts`、`turn-control.ts`。
- 不触碰：`server/test/**`、`store*.ts`、`omp/`、`rest.ts`、`events.ts`、`index.ts`、web。

## Non-goals
- 任何新行为：`#admitProcess`（4.1）、stop（4.2a/4.2b）、审批（4.3/4.6）、regenerate/fork（4.4/4.5）。
- 新建 `approvals.ts`（见偏离 1）。
- 类方法改写为模块函数。
- 调整 size-guard 阈值。
