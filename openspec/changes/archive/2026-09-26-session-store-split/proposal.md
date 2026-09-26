# Proposal: session-store-split（#454）

## Why
父 change `s1c-turn-control-governance` tasks 4.0a（epic #448）。`server/src/sessions/store.ts` 798 行，距 size-guard 800 行硬限无余量；3.1（stopped 结算）、4.3（审批行读写）、4.4/4.5（regenerate/fork 事务）、4.6（`settlePendingForMessage`）、5.3（快照投影）都要往 store 加代码。父 design「模块拆分（size-guard）」规定首刀做纯搬迁。

## Triage
Issue type: refactor
Fixture level: expanded
Upstream suggested level: expanded (agree: 持久化状态与终态事务——搬迁若改变事务边界或调用次序会丢数据或残留 running)
Blast radius: 全部会话持久化——事务原语、终态结算或启动对账的任何语义漂移都会破坏回合一致性。
Selected risk packs: Concurrency / shared state / ordering（事务与计时器次序）；Legacy compatibility / examples（`createSessionStore` 导出面与全部导入方不变）；Error handling / rollback / partial outputs（owned 事务回滚语义不变）
Evidence floor: 既有测试零改动全绿（测试总数与 origin/master 相同）；`bash scripts/size-guard.sh` 0 且 `store.ts` ≤ 640 行；knip 零新增；`make lint`、`make typecheck`、`make anti-drift`、`npm run build --workspace server` 0；orchestrator 逐字比对搬迁块。

## What Changes
- 新建 `server/src/sessions/store-branch.ts`、`server/src/sessions/store-approvals.ts`，按 design 搬迁清单逐字搬入 `store.ts` 的模块级辅助（仅增 `export` 与 import 行）；`store.ts` 改为 import，并为新文件所需的 7 个内部类型声明加 type-only `export`（不经 `sessions/index.ts` 对外暴露）。
- 不新增测试（纯搬迁，行为不变的证明是既有测试原样通过）。

## Capabilities
- ADDED `chat-sessions`「会话 store 源码模块划分」：记录 size-guard 落点、模块长期职责与依赖方向（父 delta 无对应 requirement；依据父 design「模块拆分」）。

## Impact
- 仅三个 `server/src/sessions/store*.ts` 文件；不改测试、`supervisor.ts`、`omp/`、`rest.ts`、`events.ts`、web。

## Non-goals
- 任何新行为（3.1/4.3–4.6/5.3）、`supervisor.ts` 拆分（4.0b）、size-guard 阈值调整。
