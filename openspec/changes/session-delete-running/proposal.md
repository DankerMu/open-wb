# Proposal: session-delete-running（#526）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.3c（epic #509，design D3 第 2 步、「落刀次序（三刀）」）。4.3b（#525，PR #691）已落非 running 路径，对 `running` 会话返回过渡 409。本刀让删除内含停止：在 DELETE 已持有的控制占用下执行 A 的停止序列，等回合终态落库或受理被补偿，再进入 4.3b 尾段，并移除过渡 409。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 DELETE 路由对 running 会话的行为（409 → 停止后 204）；Critical Path「omp 子进程治理」——停止序列恰一次 `abort`、审批 `deny` 结算、有界退回、获取失败补偿；supervisor `retire` 原语的排序（先排空 pump）；store 回合释放信号。
Selected risk packs: Public API / CLI / script entry（DELETE running 语义）；Concurrency / shared state / ordering（占用下的 stop、并发 stop 汇合、等待 (a)/(b)、pump 排空后才封存 generation）；Error handling / rollback / partial outputs（终态落库失败 → 5xx 行保留占用释放；获取失败补偿）；Legacy compatibility / examples（retire 对空闲会话行为不变、既有 stop/admission 测试全绿）
Evidence floor: `server/test/session-delete.test.ts`（或同目录新测试文件）覆盖 design「Required evidence」；过渡 409 用例被替换；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/session-delete.ts`：`requireIdle` 的 running → 409 分支改为 running 路径：`await supervisor.stop(id)` → `await store.turnReleased(id)` → 4.3b 尾段（墓碑 → `retire` → 不变量 → 删除事务 → unlink）。
- `server/src/sessions/store.ts`（+ `store-approvals.ts` 的 `releaseTurn`/终态落库失败处）：`SessionStore.turnReleased(sessionId): Promise<void>`——无在途回合立即 resolve；否则在该回合释放（结算或 `rollbackPrompt` 补偿）时 resolve；回合已处于或进入 faulted（delta flush 或终态落库失败）时以该错误 reject。
- `server/src/sessions/supervisor.ts`：`retire` 先等待该会话在途 pump（若有）再执行既有 `#retireSlot`。
- 测试：替换 #525 的过渡 409 用例为 running 路径用例。

## Capabilities
- MODIFIED `session-metadata`「会话删除」：以父 delta 的第 2 步、「第 2–4 步失败」句、Scenario「删除运行中的会话先停止」「删除时停止意图遇获取失败」与「删除期间的并发请求」第一组 WHEN/THEN 替换 main 的过渡行为；**保留** main 中 #525 加入的第 5 步 unlink 前校验与 Scenario「会话文件路径不在所有者会话目录内」（父 delta 尚未含，见 #692 记录）；main 的 Scenario「运行中删除的过渡拒绝」本应有意移除（#525 proposal 已预先声明），但 OpenSpec 校验器禁止 MODIFIED 丢弃既有 Scenario 且无豁免（REMOVED 与 ADDED 同名亦被拒）；故保留该名，内容改写为取代它的真实行为（running 删除不再 409，按停止路径完成 204），对应证据 7。父 change 归档前 rebase 时同样适用。
- MODIFIED `chat-sessions`「Session module registration and teardown」：main 原文 + `retire` 先等待在途 pump；组 10 的 `agentDir` 漂移不并入。

## Impact
- server：`session-delete.ts`、`store.ts`、`store-approvals.ts`、`supervisor.ts`（+ 抽出的纯逻辑模块）；测试 `session-delete.test.ts`（+ helpers）。不触碰 `rest*.ts`、`omp/`、web。
- 与 issue 的偏差：issue PR Boundary 写「只改 `session-delete.ts` + 测试，不触碰 `supervisor.ts`、`store*.ts`」，但等待条件无法只在 `session-delete.ts` 内实现：
  1. (b)「受理被补偿」由 `rest.ts:200` prompt 路由的 catch 调用 `rollbackPrompt` 完成，不经 supervisor、不发布事件；(a) 与 (b) 唯一共同的点是 store 的 `releaseTurn`（`store-approvals.ts:313`，由 `finishOwnedTurn` :309 与 `rollbackPrompt` `store.ts:449` 调用）。故 SessionStore 增 `turnReleased`。
  2. (a) 的「`turn.end` 已发布」：`#commit` 在 `persistEvent`（其中释放 store 回合）之后还可能 `await this.#approvals.settled(...)`，再 `#publish`；`#publish` 在 `generation.sealed` 时不入环不扇出，而 `#retireSlot` 会封存 generation（`supervisor.ts:683-711` `#publish`、`:760-780` `#retireSlot`）。若 DELETE 在 store 释放后立刻 `retire`，`turn.end{stopped}` 会被丢弃。故 `retire` 先等待在途 pump 再封存（公开 `retire` 唯一调用方是删除）。
  3. 回合 faulted（flush 或终态落库失败，`store.ts:776`、`store-approvals.ts:303`）、补偿事务失败，或 slot 级 infra 故障使回合比其 pump 活得久（`supervisor.ts:150/674/706`，只置 `slot.infraFaulted`）时，store 回合不会释放，只等释放会无界挂起；spec「第 2–4 步失败 → 通用 5xx」要求此时失败返回。故 `turnReleased` 在 faulted 时 reject，store 增 `faultTurn`，supervisor 在 `pump.finally` 标记孤儿回合，`rollbackPrompt` 失败时置 fault。
  4. `supervisor.ts`（794 行）因此须同 PR 抽出一段纯逻辑以守住 800 行。
- 依赖：#525 已合并；A #467/#469/#490/#464/#474/#456/#458/#461 已合并。

## Non-goals
- A 的 stop 语义本身、审批结算、有界退回常量；web 删除交互（7.2b）；smoke（8.1）。
