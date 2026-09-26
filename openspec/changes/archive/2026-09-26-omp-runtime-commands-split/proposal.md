# Proposal: omp-runtime-commands-split（#452）

## Why
父 change `s1c-turn-control-governance` tasks 2.0（epic #448）。`server/src/sessions/omp/runtime.ts` 797 行、`process.ts` 732 行，距 size-guard 800 行硬限无余量；2.1a（审批识别）、2.2a（onExit/pending 计时）、2.2b（command/abort）的新增代码放不进去。父 design「模块拆分（size-guard）」规定首刀做纯搬迁、行为不变的拆分。

## Triage
Issue type: refactor
Fixture level: expanded
Upstream suggested level: expanded (agree: AGENTS.md Critical Path「omp 子进程治理」——spawn/回收路径的搬迁须以真实 fake-omp 子进程测试证明帧次序与退出上报不变)
Blast radius: 全部对话回合——搬迁若改变 await 次序、计时器归属或错误类型，会使回合挂起、进程泄漏或错误被误报。
Selected risk packs: Concurrency / shared state / ordering（私有状态与计时器随搬迁跨文件，不得改变次序）；Legacy compatibility / examples（公开 API 与既有测试不变）；Error handling / rollback / partial outputs（错误类型与退出上报不变）
Evidence floor: runtime/process 既有测试文件零改动全绿（含真实 fake-omp 子进程的 omp-* 测试）；`bash scripts/size-guard.sh`、`make lint`、`make typecheck`、`make anti-drift`（knip/jscpd 零新增）、`npm test --workspace server` 退出 0；diff 只含搬迁与 import/export。

## What Changes
- 新建 `server/src/sessions/omp/commands.ts`：逐字搬入 `runtime.ts` 的模块级内部辅助（waiter/Generation/Turn 接口、子进程存活与 stdio 辅助、延时竞速、deferred 与帧判定辅助，清单见 design），作为 2.2a/2.2b 的落点；拆分后 `runtime.ts` ≤ 680 行。
- 不建 `ui-requests.ts`：父条件「若超限」不成立（`process.ts` 732 + 2.1a 约 40 ≈ 772 < 800），`process.ts` 零改动。
- 不新增测试（纯搬迁，行为不变的证明是既有测试原样通过）。

## Capabilities
- ADDED `omp-runtime`「omp 运行时源码模块划分」：记录 size-guard 落点与纯搬迁约束（父 delta 无对应 requirement；父 design「模块拆分」为依据）。

## Impact
- 仅 `server/src/sessions/omp/{runtime,commands}.ts`；不触碰任何测试文件与 `server/src/sessions/*.ts`。

## Non-goals
- 任何新行为（2.1a/2.1b/2.2a/2.2b）、store/supervisor/web 拆分、新增测试。
