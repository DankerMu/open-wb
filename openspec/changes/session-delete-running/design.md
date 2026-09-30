# Design: session-delete-running（#526）

父设计：D3 第 2 步、「超时」、「落刀次序（三刀）」；A turn-control「停止生成 REST」（`TurnStops`，`server/src/sessions/turn-control.ts:45-163`）。行号为 origin/master（1a0679b）。

- **Change surface**：`server/src/sessions/session-delete.ts`（`requireIdle` 与 `deleteSession`）；`server/src/sessions/store.ts:157-192`（`SessionStore` 增 `turnReleased`）、`:216-235`（Turn 增释放信号）、`:678-699` `openTurn`、`:774-778`（flush 失败处）；`server/src/sessions/store-approvals.ts:300-325`（终态落库失败处与 `releaseTurn`）；`server/src/sessions/supervisor.ts:318-333`（`retire`）；`server/test/session-delete.test.ts`（+ `session-delete-helpers.ts`）。
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
    - 两处置 `faulted = true` 的地方（`store.ts:776` delta flush、`store-approvals.ts:303` 终态落库）调用 reject(该错误)；已 settle 的 promise 再 resolve/reject 无效。（实现中查明：flush 故障是 sticky 的——故障后 `appendDelta` 先重抛原错误、flush 定时器不再启动，故「故障后重试成功」经公开 API 不可达，证据 9b 断言的是这一行为。）
    - `rollbackPrompt` 的补偿事务失败（`store.ts:423-448` 在 `releaseTurn` 之前抛出）时，同样置该回合 `faulted`/`fault` 并 reject 其信号，再原样抛出。
    - `SessionStore.faultTurn(assistantMessageId, error): void`：对仍在途的该回合置 `faulted`/`fault` 并 reject 其信号（无该回合 → no-op）；供 supervisor 标记孤儿回合。
    - `SessionStore.turnReleased(sessionId): Promise<void>`：无在途回合 → `Promise.resolve()`；在途回合已 `faulted` → `Promise.reject(turn.fault)`；否则返回该回合的 `released`。不查库、不 `assertOpen`。
    - `bash scripts/size-guard.sh`：`store.ts` 现 785 行，须 ≤800——必要时把纯函数（如 `titlePrefix`）移到 `store-branch.ts` 等既有模块，行为不变。
  - `supervisor.ts` 孤儿回合：slot 级 infra 故障（approvals `#fault` `supervisor.ts:150`、`#commit` catch `:674`、`#publish` sink 失败 `:706`）只置 `slot.infraFaulted`，pump 退出（`:584`/`:604-607`）或跳过终态提交（`:624`）后 store 回合仍在 `activeTurns`、`faulted=false`，等待其释放的 DELETE 会无界挂起。故在 `pump.finally`（`:540-549`）中无条件调用 `store.faultTurn(assistantMessageId, new Error("turn outlived its event pump"))`：`faultTurn` 按 assistantMessageId 定位，回合已释放时为 no-op，不查库（避免在 `void pump.finally` 回调里因 SELECT 抛错产生未处理拒绝）；`faultTurn` 自身不得抛出。pump 的所有非故障退出路径都已释放回合（fixture review 已核对），故该条件等价于 infra 故障孤儿。
  - `supervisor.ts` `retire(sessionId)`：`const slot = this.#slots.get(sessionId); if (slot !== undefined) { await slot.pump?.catch(() => undefined); await this.#retireSlot(slot); }`（pump 在进入时读取；`pump.finally` 先于该 await 的续体运行，它若已发起 `#retireSlot`，`retire` 的调用汇入 `slot.retiring`）。JSDoc 前置条件补一句：在途 pump 先被排空，以便刚落库的终态事件在封存前发布。`supervisor.ts` 现 794 行，加上排空与孤儿检查会超过 800：须同 PR 把一段纯逻辑（例如 `#readReplay`/`#listenersFor`/`#removeListener`/`#fanout` 的订阅者表，或 `#failure`）抽到 `supervisor-faults.ts` 或新的同目录模块，行为逐字不变，`bash scripts/size-guard.sh` 退出 0。
  - `session-delete.ts`：
    - `requireIdle` 改为 `requireOwned`：`getMessages` null → 404；返回 `status`。
    - `deleteSession`：占用（不变）→ `requireOwned` → 若 `status === "running"`：`await deps.supervisor.stop(sessionId)`，再 `await deps.store.turnReleased(sessionId)`（任一 reject → 通用 5xx，经既有 `finally` 释放占用；此时墓碑尚未加入）→ 然后（running 或非 running）加入墓碑 → 4.3b 尾段不变。
    - deps 的 `supervisor` Pick 增 `stop`，`store` Pick 增 `turnReleased`。
    - 删除 4.3b 的过渡 409 分支。
- **并发推理**：
  - DELETE 持有占用期间：prompt（`rest.ts:193`）、regenerate/fork（`branching.ts:73/206`）、第二个 DELETE（`controlHeld`）均 409；用户 stop 不经占用检查（`rest.ts:222-225`），`supervisor.stop` 汇入 DELETE 的 entry → 202 `{}`、无第二帧 `abort`、无重复 `deny`。
  - (a) abort-ok：`abort` → `agent_end` → pump `#commit` 落库 `stopped`（释放 store 回合，`turnReleased` resolve）→ 可能 `await approvals.settled` → `#publish` 扇出 `turn.end` → pump 结束。DELETE 续体在释放后运行，加入墓碑、`retire` 先等 pump，故订阅者先收到 `turn.end{stopped}`，再被 `onEnd` 结束。（实现中查明：即使不排空，`sealGeneration` 在 `pumpCount > 0` 时不封存（`pool.ts:311`），订阅者也要等 `#retireSlot` 完成才被结束，顺序同样成立但依赖时序；排空把它变成构造保证。）
  - (a) abort-ignored：grace 到期 `#expire` 置 `expired` 并 retire slot（封存 generation，`turn.end` 不再扇出——A 既有语义），pump 走 catch → `applyStop` → 落库 `stopped` → 释放 → DELETE 继续；`retire` 汇入已在进行的退役。
  - (b) 停止意图 + 获取失败：`stop` 在 `dispatching` 阶段登记意图后 resolve；获取失败 → `#prompt` 释放 stop entry 并拒绝 → `rest.ts:200` `rollbackPrompt` 移除受理对、释放 store 回合 → `turnReleased` resolve → DELETE 以非 running 状态继续；无 pump、无 `abort` 帧。
  - (b') 停止意图 + 获取成功：`dispatched()` 写出意图欠下的 `abort`，随后同 (a)。
  - faulted：flush 失败、终态落库失败、补偿事务失败，或 slot 级 infra 故障使回合比 pump 活得久（`pump.finally` → `faultTurn`）→ `turnReleased` reject（DELETE 前已成孤儿的回合经 `faulted` 检查立即 reject）→ DELETE 5xx，会话行保留（仍为 running/faulted，由既有 infraFault 路径与重启对账处理），占用释放、墓碑未加入。
- **Sibling surfaces**：web 删除确认框的 pending 态（7.2b）依赖本刀的最长等待（约 8 s grace + 退役升级）；SSE 订阅者收到 `turn.end{stopped}` 后因 `onEnd` 结束；`GET /api/audit` 可见 `session.approval decision=deny` 与 `session.delete`。
- **残余**：
  - 终态落库失败后的会话保持 running/faulted，DELETE 反复 5xx 直至重启对账——与 A 的 infraFault 语义一致，不在本刀修复。
  - abort-ignored 路径订阅者是否收到宽限后的 `turn.end{stopped}`：证据 2 在 onEvent 上观察到了该事件，SSE 侧未单独取证。
- **Required evidence**（`server/test/session-delete.test.ts`，必要时拆出同目录新测试文件；production `createApp` + 真实 fake-omp 场景（`createRealFakeRuntime` 的 `--scenario` 选择，`session-supervisor-helpers.ts:88-120`）或受控 runtime + `app.inject()` + SSE 夹具；可复用 `session-stop-helpers.ts`/`session-stop-intent-helpers.ts`（含 `handshakeBound` `:84`）的既有造数；会话文件须在所有者会话目录内（沿用 #525 造数约束）；时钟推进用注入时钟；触发 retained fault 的用例按 `session-stop-faults.test.ts` 用 `closeAfterRetainedFault` 收尾。「删除前一刻的状态」经 `CREATE TEMP TABLE` + `CREATE TEMP TRIGGER … BEFORE DELETE ON chat_sessions` 把 `OLD.status` 与该会话助手消息状态写入临时表观察。RED：除证据 11（门禁）外全部在实现前红（过渡 409、`turnReleased`/`faultTurn` 不存在）；证据 5 中「占用下并发 409」本身为 characterization，其「原 DELETE 完成 204」为 RED；以实际运行记录）：
  1. 挂起审批 + 停止（「删除运行中的会话先停止」第一条）：fake `approval-then-abort` + `--approval-mode write`（`abort-ok` 不产生审批，`fake-omp.mjs:34/41-46`；该场景把 abort 推迟到 Deny 的 end 帧之后，`fake-omp-approval.test.ts:329-333`），回合进行中有一条挂起审批，两个 SSE 订阅已打开 → DELETE → 审批行 `decision=deny` 且审计有 `session.approval`（`decision:"deny"`）；fake 收到 `Deny` 先于 `abort`，且恰一帧 `abort`；每个订阅者在连接结束前依次收到 `approval.resolved{decision:"deny"}` 与恰一个 `turn.end{status:"stopped"}`，之后无事件；临时表记录删除前会话与助手消息为 `stopped`；子进程退出；行被删除；审计 `session.delete`；204。
  2. abort-ignored（第二条）：DELETE 挂起在等待终态；推进前断言 DELETE 未返回；推进注入时钟过 8000 ms → 进程退役、回合以 `stopped` 落库（临时表）、无 `error` 事件；DELETE 204；行已删。
  3. abort-ignored + 并发 stop（第三条）：DELETE 挂起期间 `POST …/stop` → 202 `{}`；推进时钟过 8000 ms → DELETE 204；fake 自始至终恰收到一帧 `abort`。
  4. slow-ready + 获取失败（「删除时停止意图遇获取失败」）：`slow-ready`（`--ready-delay-ms`）下 prompt 受理后仍在获取/握手，DELETE 登记停止意图；随后在 ready 延迟内令子进程退出（握手超时为真实 `setTimeout`；子进程退出不好控制时以 `handshakeBound` 为后备）→ prompt 502 `agent_unavailable`，受理对已补偿；fake 未收到 `prompt` 或 `abort` 帧；DELETE 204，`GET /api/audit` 恰新增一条 `session.delete`；此后该 id 的 DELETE、PATCH、`GET …/messages` 均 404（非 409）；`controlHeld` 为 false；同 owner 另一会话 prompt 202 且其 DELETE 不 409。
  5. 并发请求（「删除期间的并发请求」第一条）：DELETE 挂起在等待终态（abort-ignored）时，对同一会话 prompt、regenerate、fork、第二个 DELETE → 均 409 `session_busy`，无行变化、fake 无新帧；推进时钟后原 DELETE 204；此后 DELETE → 404。
  6. 终态落库失败（「第 2–4 步失败」）：`CREATE TEMP TRIGGER … BEFORE UPDATE OF status ON chat_messages WHEN NEW.status = 'stopped' BEGIN SELECT RAISE(ABORT,'x'); END` 使 abort-ok 回合终态落库失败 → DELETE 通用 5xx；会话行与消息行保留；`controlHeld` 为 false；之后对该会话新建 `GET …/events` 不被立即结束（墓碑未残留）。
  7. 纯 abort-ok 与过渡取代（issue 验收第一条 + Scenario「运行中删除的过渡拒绝」改写内容）：fake `abort-ok` 回合进行中、一个订阅 → DELETE 不返回 409；临时表记录删除前会话与助手消息为 `stopped`；订阅者先收到 `turn.end{status:"stopped"}` 再连接结束；204。#525 其余证据全绿；`session-retire.test.ts`、stop/intent/admission 测试全绿。
  8. 孤儿回合（P1）：fake `approval` 场景 + `CREATE TEMP TRIGGER … BEFORE INSERT ON chat_approvals BEGIN SELECT RAISE(ABORT,'x'); END` 使审批落库失败（slot infraFaulted、pump 退出、回合未释放）→ DELETE 通用 5xx（有界返回，不挂起）；`controlHeld` 为 false；会话行保留；再次 DELETE 同样 5xx 且立即返回。
  9. store 单元：`turnReleased` 对无回合会话立即 resolve；受理后 `rollbackPrompt` → resolve；受理后注入 flush 失败 → reject 为该错误；受理后以触发器使补偿事务失败 → `rollbackPrompt` 抛出且 `turnReleased` reject；`faultTurn` 使在途回合的等待 reject、对已 faulted 回合再次 `turnReleased` 立即 reject。
  10. retire 排空（chat-sessions「Session module registration and teardown」新增句）：受控 runtime / supervisor 级用例，让回合终态时仍有挂起审批，使 pump 在 `#commit` 的 `await approvals.settled` 处让出（`supervisor.ts:659-671`）；在 store 释放后立即调用 `retire` → 订阅者先收到 `approval.resolved` 与 `turn.end` 再被 `onEnd` 结束；锁定「`turn.end` 先于连接结束」的排序契约。实现中查明去掉排空该用例不变红（`sealGeneration` 在 `pumpCount > 0` 时不封存，见并发推理），故为 characterization；变异结果在 PR 记录。
  11. 门禁：`npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；PR 记录 `store.ts`、`store-approvals.ts`、`supervisor.ts`（及抽出模块）、`session-delete.ts` 与测试文件前后行数。
