# Design: session-delete-running（#526）

父设计：D3 第 2 步、「超时」、「落刀次序（三刀）」；A turn-control「停止生成 REST」（`TurnStops`，`server/src/sessions/turn-control.ts:45-163`）。行号为 origin/master（1a0679b）。

- **Change surface**：`server/src/sessions/session-delete.ts`（`requireIdle` 与 `deleteSession`）；`server/src/sessions/store.ts:157-192`（`SessionStore` 增 `turnReleased`）、`:216-235`（Turn 增释放信号）、`:663-690` `openTurn`、`:774-778`（flush 失败处）；`server/src/sessions/store-approvals.ts:300-325`（终态落库失败处与 `releaseTurn`）；`server/src/sessions/supervisor.ts:318-333`（`retire`）；`server/test/session-delete.test.ts`（+ `session-delete-helpers.ts`）。
- **Must preserve**：
  - 4.3b 全部行为：非 running 删除、占用、墓碑、删除事务与审计、unlink 前校验、204/401/404/409/5xx（#525 证据 1–7、9–13 全绿，仅证据 8 过渡 409 被替换）。
  - A 的 stop 语义：`supervisor.stop`（`supervisor.ts:275-287`）经 `#controls.during` 计数持有、不因 DELETE 的持有而阻塞；重复 stop 汇入同一 `TurnStops` entry（`turn-control.ts:67-80`）——一次 `deny` 快照、一帧 `abort`、一个 grace；停止意图、有界退回 `OMP_ABORT_GRACE_MS`=8000（`turn-control.ts:16`）与 `#expire`（`:156-162`，保留 entry 使 pump 以 `stopped` 结算）。
  - `retire` 对无在途 pump 的会话行为逐字不变（#516 证据全绿）。
  - `rollbackPrompt`、`finishOwnedTurn`、flush 语义不变（只多出释放/失败通知）；既有 store/supervisor/stop 测试全绿。
  - 不另设计时器：上界完全来自 A 的 grace、retire 升级（5000/8000 ms）与获取失败的既有有界路径。
- **Must add/change**：
  - `store.ts` / `store-approvals.ts`：
    - Turn 增一个一次性结算的信号（例如 `released: Promise<void>` 及其 `resolve`/`reject`，在 `openTurn` 创建；`released.catch(() => undefined)` 防未处理拒绝）。
    - `releaseTurn`（`store-approvals.ts:313`）调用 resolve。
    - 两处置 `faulted = true` 的地方（`store.ts:776` delta flush、`store-approvals.ts:303` 终态落库）调用 reject(该错误)；已 settle 的 promise 再 resolve/reject 无效（之后 flush 重试成功不改变 DELETE 已得到的失败）。
    - `SessionStore.turnReleased(sessionId): Promise<void>`：无在途回合 → `Promise.resolve()`；在途回合已 `faulted` → `Promise.reject(turn.fault)`；否则返回该回合的 `released`。不查库、不 `assertOpen`。
    - `bash scripts/size-guard.sh`：`store.ts` 现 785 行，须 ≤800——必要时把纯函数（如 `titlePrefix`）移到 `store-branch.ts` 等既有模块，行为不变。
  - `supervisor.ts` `retire(sessionId)`：`const slot = this.#slots.get(sessionId); if (slot !== undefined) { await slot.pump?.catch(() => undefined); await this.#retireSlot(slot); }`（pump 在进入时读取；`pump.finally` 先于该 await 的续体运行，它若已发起 `#retireSlot`，`retire` 的调用汇入 `slot.retiring`）。JSDoc 前置条件补一句：在途 pump 先被排空，以便刚落库的终态事件在封存前发布。≤800 行（现 794）。
  - `session-delete.ts`：
    - `requireIdle` 改为 `requireOwned`：`getMessages` null → 404；返回 `status`。
    - `deleteSession`：占用（不变）→ `requireOwned` → 若 `status === "running"`：`await deps.supervisor.stop(sessionId)`，再 `await deps.store.turnReleased(sessionId)`（任一 reject → 通用 5xx，经既有 `finally` 释放占用；此时墓碑尚未加入）→ 然后（running 或非 running）加入墓碑 → 4.3b 尾段不变。
    - deps 的 `supervisor` Pick 增 `stop`，`store` Pick 增 `turnReleased`。
    - 删除 4.3b 的过渡 409 分支。
- **并发推理**：
  - DELETE 持有占用期间：prompt（`rest.ts:190`）、regenerate/fork（`branching.ts:73/206`）、第二个 DELETE（`controlHeld`）均 409；用户 stop 不经占用检查（`rest.ts:222-225`），`supervisor.stop` 汇入 DELETE 的 entry → 202 `{}`、无第二帧 `abort`、无重复 `deny`。
  - (a) abort-ok：`abort` → `agent_end` → pump `#commit` 落库 `stopped`（释放 store 回合，`turnReleased` resolve）→ 可能 `await approvals.settled` → `#publish` 扇出 `turn.end` → pump 结束。DELETE 续体在释放后运行，加入墓碑、`retire` 先等 pump，故订阅者先收到 `turn.end{stopped}`，再被 `onEnd` 结束。
  - (a) abort-ignored：grace 到期 `#expire` 置 `expired` 并 retire slot（封存 generation，`turn.end` 不再扇出——A 既有语义），pump 走 catch → `applyStop` → 落库 `stopped` → 释放 → DELETE 继续；`retire` 汇入已在进行的退役。
  - (b) 停止意图 + 获取失败：`stop` 在 `dispatching` 阶段登记意图后 resolve；获取失败 → `#prompt` 释放 stop entry 并拒绝 → `rest.ts:196` `rollbackPrompt` 移除受理对、释放 store 回合 → `turnReleased` resolve → DELETE 以非 running 状态继续；无 pump、无 `abort` 帧。
  - (b') 停止意图 + 获取成功：`dispatched()` 写出意图欠下的 `abort`，随后同 (a)。
  - faulted：flush 或终态落库失败 → `turnReleased` reject → DELETE 5xx，会话行保留（仍为 running/faulted，由既有 infraFault 路径与重启对账处理），占用释放、墓碑未加入。
- **Sibling surfaces**：web 删除确认框的 pending 态（7.2b）依赖本刀的最长等待（约 8 s grace + 退役升级）；SSE 订阅者收到 `turn.end{stopped}` 后因 `onEnd` 结束；`GET /api/audit` 可见 `session.approval decision=deny` 与 `session.delete`。
- **残余**：
  - 终态落库失败后的会话保持 running/faulted，DELETE 反复 5xx 直至重启对账——与 A 的 infraFault 语义一致，不在本刀修复。
  - abort-ignored 路径订阅者收不到 `turn.end`（A 既有：grace 退回封存 generation 后不再发布）。
- **Required evidence**（`server/test/session-delete.test.ts`，必要时拆出同目录新测试文件；production `createApp` + 真实 fake-omp 场景（`createRealFakeRuntime` 的 `--scenario` 选择，`session-supervisor-helpers.ts:88-120`）或受控 runtime + `app.inject()` + SSE 夹具；可复用 `session-stop-helpers.ts`/`session-stop-intent-helpers.ts` 的既有造数与 `approval-then-abort` 场景；会话文件须在所有者会话目录内（沿用 #525 造数约束）；时钟推进用注入时钟。RED：证据 1–5、7 在实现前红（过渡 409）；证据 6 的「占用下并发 409」与 #525 相同为 characterization、其「原 DELETE 完成 204」部分为 RED；以实际运行记录）：
  1. abort-ok + 挂起审批（「删除运行中的会话先停止」第一条）：回合进行中且有一条挂起审批，两个 SSE 订阅已打开 → DELETE → 审批行 `decision=deny` 且审计有 `session.approval`（`decision:"deny"`）；fake 收到 `Deny` 先于 `abort`，且恰一帧 `abort`；每个订阅者在连接结束前收到 `approval.resolved{decision:"deny"}` 与恰一个 `turn.end{status:"stopped"}`（顺序如此，之后无事件）；删除前一刻（`turnReleased` 之后、删行之前可经 SQL/事件观察）助手消息与会话为 `stopped`；子进程退出；行被删除；审计 `session.delete`（`messageCount` 为删除前消息数）；204。
  2. abort-ignored（第二条）：DELETE 挂起在等待终态；推进注入时钟过 8000 ms → 进程退役、回合以 `stopped` 落库、无 `error` 事件；DELETE 204；行已删。推进前断言 DELETE 未返回（有界等待确由 grace 驱动）。
  3. abort-ignored + 并发 stop（第三条）：DELETE 挂起期间 `POST …/stop` → 202 `{}`；推进时钟过 8000 ms → DELETE 204；fake 自始至终恰收到一帧 `abort`。
  4. slow-ready + 获取失败（「删除时停止意图遇获取失败」）：`slow-ready`（`--ready-delay-ms`）下 prompt 受理后仍在获取/握手，DELETE 登记停止意图（`abort()` 返回 false 路径）；随后在 ready 延迟内令子进程退出（握手超时是真实 `setTimeout`，不用它驱动）→ prompt 502 `agent_unavailable`，受理对已补偿；fake 未收到 `prompt` 或 `abort` 帧；DELETE 204，`GET /api/audit` 恰新增一条 `session.delete`（`messageCount:0` 若会话此前无消息）；此后该 id 的 DELETE、PATCH、`GET …/messages` 均为 404（非 409）；`controlHeld` 为 false；同 owner 另一会话的 prompt 202 且其 DELETE 不 409。
  5. 并发请求（「删除期间的并发请求」第一条）：DELETE 挂起在等待终态（abort-ignored）时，对同一会话 prompt、regenerate、fork、第二个 DELETE → 均 409 `session_busy`，无行变化、fake 无新帧；推进时钟后原 DELETE 204；此后 DELETE → 404。
  6. 失败规则（「第 2–4 步失败」）：以 `CREATE TEMP TRIGGER … BEFORE UPDATE OF status ON chat_messages WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(ABORT,'x'); END`（或等价的终态落库注入）使 abort-ok 回合的终态落库失败 → DELETE 通用 5xx；会话行与消息行保留；`controlHeld` 为 false；之后对该会话新建 `GET …/events` 不被立即结束（墓碑未残留）。
  7. 回归（#525 证据 8 的替换，即 Scenario「运行中删除的过渡拒绝」的改写内容）：running 会话 DELETE 不再返回 409 而是停止后 204；#525 其余证据全绿；既有 `session-retire.test.ts`、stop/intent/admission 测试全绿（retire 的 pump 排空与 `turnReleased` 未改变它们）。
  8. store 单元（同一新测试文件或其 describe）：`turnReleased` 对无回合会话立即 resolve；受理后 `rollbackPrompt` → resolve；受理后注入 flush 失败（既有 flush 故障夹具）→ reject 为该错误。
  9. 门禁：`npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；PR 记录 `store.ts`、`supervisor.ts`、`session-delete.ts` 与测试文件前后行数。
