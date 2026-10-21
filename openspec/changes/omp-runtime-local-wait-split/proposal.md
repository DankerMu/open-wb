# omp-runtime-local-wait-split — 从 runtime.ts 拆出本地完成等待与回执结算（#1600）

## Why

`server/src/sessions/omp/runtime.ts` 正好 800 行（`scripts/size-guard.sh:6` `MAX=800`，判定 `lines -gt MAX`），自 #652 起一直贴着上限，已有 5 处方法之间靠删空行省地方。下一个改它的 PR——修 bug、补注释、加一种帧——都得先删行或顺带拆文件；#1594 / PR #1598 已经因此把本该写在 `abort()` 上的注释写到了 `commands.ts` 的 `isTurnStart` 上。#452 只把模块级辅助搬进了 `commands.ts`，`SessionRuntime` 类本身的各块职责仍在 `runtime.ts`。

## What

纯搬迁，不改行为：

- **本地完成等待 → 新模块 `server/src/sessions/omp/local-wait.ts`**（#553 引入的一块，issue 的推荐刀）：`LocalWait` 接口与 `#onLocalFrame` / `#awaitOutput` / `#localState` / `#clearLocalWait` 成为一个小类（如 `LocalCompletionWait`），构造参数是注入时钟、`current(): Turn | undefined`（即 `this.#turn`）与 `complete(turn)`（即 `this.#completeTurn`）；方法 `onFrame(turn, frame)`、`clear()`、`clearFor(genId)`（`#retire` 里按 genId 清等待）。`runtime.ts` 里 `#completeTurn` / `#failTurn` / `#abandon` / `#retire` 的清等待改为调用它。判定仍由 `local-command.ts` 的纯函数 `decideLocalCompletion` 做，`local-command.ts` 不改。
- **回执结算 → `commands.ts` 的自由函数**：`#resolveReceipt` / `#rejectReceipt` / `#rejectPendingReceipts` 改为接收 `pending: Set<Turn>` 的函数（`receiptSettled` 守卫、从集合删除、resolve / reject 次序原样）。单拆它余量太少（issue），与上一刀合起来达到目标。
- 目标：`runtime.ts` ≤740 行（至少 60 行余量，issue 建议值），`local-wait.ts` 与 `commands.ts` 都远低于 800。
- 规格：omp-runtime「omp 运行时源码模块划分」写入 `local-wait.ts` 的职责、导入方向与行数目标，`commands.ts` 的职责加回执结算，并加一个 Scenario。
- 不做：任何行为变化；`process.ts`（787 行）的拆分；retire / 回收流程的拆分（issue 的备选刀：await 次序与计时器归属属关键路径，另起）；把 #1598 写在 `isTurnStart` 上的注释挪回 `abort()`；调 size-guard 阈值。

## Triage

```text
Issue type: refactor (pure move)
Fixture level: expanded
Upstream suggested level: expanded (issue: 形式参照 #452，refactor，fixture level expanded)
Level rationale: expanded — touches the omp child-process governance critical path (AGENTS.md) and the module-division Requirement; the move itself is mechanical but turn completion, abort and retire all clear the local wait, so ordering must be preserved exactly.
Blast radius: every omp turn's completion path (local-only `/` turns, turn end, failure, abandon, retire) and every prompt's dispatch receipt; a wrong move either leaks a grace timer, completes a stale turn, or settles a receipt twice / never
Selected risk packs: Concurrency / state machine (timer ownership and the stale-turn / stale-wait guards move with the code; clear order in complete / fail / abandon / retire unchanged); Resource limits (no timer left armed after clear; the injected clock is the only timer source); not selected — Auth / secrets, File IO, Schema, Config, Public API (SessionRuntime signature and import path unchanged), Error handling (same errors, same receipts), Release / packaging
Evidence floor: existing runtime / process test files unchanged and green (incl. real fake-omp child tests, `omp-runtime-local-command.test.ts`, `omp-runtime-abort-start.test.ts`); `npm test --workspace server` ×3 for the runtime files (race check); `bash scripts/size-guard.sh`; `wc -l runtime.ts` ≤740; `make anti-drift` (knip / jscpd zero new); typecheck; `make check`; `git diff -M` shows moves plus call-site rewrites only
```
