# Proposal: stop-dispatched-path（#473）

## Why
父 change `s1c-turn-control-governance` tasks 4.2a（epic #448，issue #473）。

前置件已就位，但没有任何一方把它们接成「停止」：runtime `abort(): Promise<OmpFrame> | false`（#488，`server/src/sessions/omp/runtime.ts:225-240`）、归约器 aborted → `turn.end stopped` 与纯函数 `applyStop`（#455，`events.ts:121-126`，至今无 src 调用方）、审批作答结算 `ApprovalRegistry.decide`（#464，`approvals.ts:110-124`）、web 已能解析 `stopped`（#472）。supervisor 没有 stop 端口（`supervisor.ts` 公开面只有 `prompt`/`decide`/`subscribe`/`shutdown` 等），也从不写 `abort`。本刀交付已派发回合的停止：按进入 stop 时的快照逐条 Deny 挂起审批 → 写 `abort` → 回合经普通归约收尾；`OMP_ABORT_GRACE_MS` 内 `agent_end` 未到 → 既有 retire + `applyStop`；同一回合重复 stop 只一帧 `abort`。三者共同保证每个回合恰一条路径发出 `turn.end`。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」；abort 次序、有界退回 retire、审批 Deny 结算与控制并发都只能用真实子进程与真实 SQLite 证明)
Blast radius: Deny 晚于 `abort` → 真 omp 的 abort 等在未应答 select 上，回合挂到 grace；grace 不取消 → 正常收尾的进程 8s 后被误 retire；退回走 `applyFailure` → web 收到 `error` 并把停止显示为失败；去重缺失 → 第二帧 `abort`（runtime 不去重）；abort Promise 未 catch → 退回/崩溃时 unhandledRejection 使进程崩溃；Deny 结算失败仍写 `abort` → 有决定无落库
Selected risk packs: Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Public API / CLI / script entry；Resource limits / large input / discovery；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-stop.test.ts`、`session-stop-faults.test.ts` 与 helper `session-stop-helpers.ts`（各 ≤800 行），真实 fake-omp 子进程 + 真实 SQLite + 注入时钟 + 真实 `createApp`→`registerSessions` 装配；design「Required evidence」S1–S9 全绿，红/绿按 design 标注；既有测试零 diff；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0

## What Changes
- `server/src/sessions/turn-control.ts`：新增停止编排（示意名 `TurnStops`），经构造时注入的小端口工作，对 `supervisor.ts` 只有类型导入：
  - 按回合（`assistantMessageId`）登记「停止已在途」，第二次 stop 复用同一 Promise；
  - 读挂起审批快照，逐条经 `decide(…,"deny")` 结算；
  - 调 `slot.runtime.abort()`，同步挂 `.catch`；
  - 以注入时钟布 `OMP_ABORT_GRACE_MS = 8000`（模块私有常量）；到期标记该回合「已退回」并调既有 retire；
  - 回合结束时撤销等待。
- `server/src/sessions/supervisor.ts` 只接线：
  - 构造 `TurnStops`；
  - 公开 `stop(sessionId): Promise<void>`；
  - pump catch 在「已退回」时以 `applyStop` 取代 `applyFailure`；
  - pump 收尾时撤销该回合的等待。
- `server/src/sessions/approvals.ts`：加一个只读快照访问器（示意名 `pendingFor(slot): number[]`，按 `approvalId` 升序），约 8 行（偏离 1）。
- 测试：两个新测试文件 + 一个新 helper；既有测试与 helper 零 diff。

## Capabilities
- MODIFIED turn-control「中断帧归约与有界退回」「stopped 终态」：父 delta 整段逐字（全量交付，含 #455 fixture 指派给本刀的句子与 Scenario）。
- ADDED turn-control「停止生成 REST」：只收 supervisor 已派发路径与停止已在途去重；REST 形状 → #475，停止意图 → #490，控制占用括注 → #465（见 delta 引注）。
- ADDED tool-approval「停止与终态对挂起审批的结算」：只收第 1–3 条、其次序句与「停止：」段；第 4–6 条与非作答结算 → #474。
- MODIFIED chat-stream「审批事件发布」：主 spec + 父文两处停止片段（逐字）。
- MODIFIED chat-sessions「Supervisor ordered persistence and publication」：主 spec + 父文「Stop is the one exception」整句。
- MODIFIED chat-sessions「会话持久化与回合刷盘」：主 spec + 对账段「`stopped` rows … SHALL NOT be touched」与 Scenario「Startup reconciliation」的 stopped 子句。
- 不收：turn-control「会话级控制占用」（偏离 2）；chat-sessions「会话 supervisor 源码模块划分」不改：主 spec 已写 `turn-control.ts` 承载「stop/regenerate/fork 的回合控制编排」，`approvals.ts` 加只读访问器仍属其「审批编排」职责。

## Impact
- 行数：
  - `supervisor.ts` 749 → 目标 ≤780，硬上限 785；超出则把更多逻辑挪进 `turn-control.ts`。
  - `turn-control.ts` 68 → 约 170。
  - `approvals.ts` 204 → 约 212。
  - 实测 `wc -l` 记入 PR body。
- 零 diff：`rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`index.ts`、`omp/` 全部、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs`（793/800，不加场景）、全部既有测试与 helper。
- 5.1a #475 合入前 `stop` 无 src 调用方（同 #464 的 `decide`）；knip 不报公开类方法，`OMP_ABORT_GRACE_MS` 不导出。

## 偏离与决定
1. **PR Boundary 外改 `approvals.ts`（约 8 行只读访问器）**。issue 的触碰集只列 `turn-control.ts` + `supervisor.ts`，但快照只能从审批登记处读：`#registrations` 是私有字段（`approvals.ts:51`），store 没有列出 pending 行的方法（`store.ts:123-147`），而 issue 禁止改 `store*.ts`。`approvals.ts` 不在 issue 的禁改清单内。访问器只读，不改登记、计时或结算语义。
2. **不交付 turn-control「会话级控制占用」**（issue「Desired behavior」列了「stop 自身持有、不被占用阻塞」）。当前代码没有控制占用结构（`grep -rn 控制占用|controlClaim server/src` 为空），也没有读取它的一方：prompt 在回合中本就因 store `session_busy` 被拒，regenerate/fork 尚不存在，回合中的进程已由 `busy()` 视为不可驱逐（`pool.ts:65-68`、`supervisor.ts:297-300`）。只写不读的集合是死代码，无从测试。owner 记录：编排者已于 2026-09-27 在 #465 issue 正文加入「**In Scope 补充（自 #473 移交，2026-09-27）：**」，把「已就位的 `supervisor.stop(sessionId)` 在其调用期间持有该会话的控制占用，并且永不因占用返回 409」移交 4.4 #465，由其新测试文件验证（stop 在途时 regenerate 409 `session_busy`；regenerate 持有占用时 stop 不被阻塞）。
3. **Deny 结算失败则 stop 以原错误拒绝、不写 `abort`**（issue 未规定）。审批行仍 pending 时写 `abort`，真 omp 会等在 select 上，这时 abort 的效果只剩有界退回。与 `decide` 的失败语义一致（#464 决定 5：行、计时器、`markPending` 保持）。拒绝时清除「停止已在途」标记，修复后可再次 stop。CAS 未命中（`approval_settled`，快照后被并发作答，`approvals.ts:116-118`）或 `not_found`（行已级联删除，同 `#expire` 的处理 `approvals.ts:149-155`）视为已结算，跳过该条。证据：S8（结算失败）、S8b（`approval_settled` 跳过）。`not_found` 跳过在运行中回合不可达（运行中的 assistant 行不会被级联删除：regenerate 只作用于非 running 会话），与偏离 7 一样只经代码审查。
4. **第二次 stop 返回首次的同一 Promise**。两次调用都在 `abort` 写出后 resolve，二者都不再结算、不再写帧。去重必须在调用 `abort()` 之前判定：runtime 不去重（#488 open question），grace 期间 `gen.retiring` 仍为 undefined，第二次 `abort()` 会写出第二帧。grace 只在首次 stop 布下，二次 stop 不重布。
5. **「同一回合二次停止」以 stdin 拦截计帧，而非 probe `frames=`**。`abort-ignored` 回合挂起期间会话 running、不能再发 prompt；有界退回后进程已退出，probe 无从取得（carry-forward #456/#561）。子 delta 的 Scenario 措辞随之修正，父 delta 归档对账时采纳。
6. **tool-approval 两个停止 Scenario 不断言 `decision`/审计**（按 issue 验收），但断言 `approval.resolved{deny}` 先于 `turn.end(stopped)`：chat-stream 本刀并入的「含停止前的 deny」一句需要这条证据，它是事件次序，不是行值。`decision`/审计由 `decide` 路径交付并已由 #464 R2/R3/R8 证明，#474 归档时恢复父 Scenario 全文。
7. **`abort()` 返回 `false` 时直接返回、不写帧、不登记意图**（issue 原文，4.2b #490 替换）。这是过渡行为，不写进 spec（#490 会改写它），也不为它写测试：若写测试，#490 必须删改本刀的测试文件。
8. **关停后的 stop 以 `agent_unavailable` 拒绝**，与 `prompt`/`decide` 的关停闸门一致（`supervisor.ts:133-136,193-196`）。

## Open questions（上报编排者，本刀不处理）
- omp v18.0.10 内部 silent-abort（`message_end aborted` + `errorId silent-abort` 后继续）在没有 stop 的情况下也被归约为 `stopped`（#455 起）。carry-forward 提名本刀为候选 owner，但 issue #473 正文未纳入。本刀不改归约器（`events.ts` 在禁改清单）。
- `/compact` 这类等待迟到输出的 slash 回合，在 abort 后只会收到 `response{command:"abort"}`，没有 `agent_end`（#488 A4）。本刀的 8000ms 有界退回先于 120000ms 本地命令 grace 到达，回合以 `stopped` 收尾并 retire 进程。这是预期行为，不另测。
- `agent_end` 与 grace 到期落在同一宏任务窗口时（生产上窗口只有 pump 的微任务，注入时钟下不可达），进程会被多 retire 一次，但由于 `!mapper.ended` 守卫，`turn.end` 仍恰一次（design Must preserve 3）。
- 父 delta「同一回合二次停止」措辞：见偏离 5。

## Non-goals
- 停止意图（登记、派发回执后兑现、获取失败丢弃）→ 4.2b #490。
- REST 路由与 202/204/400 → 5.1a #475。
- 审批 `decision`/审计断言，以及崩溃/有界退回/关停/对账的非作答 `deny` 结算 → 4.3（已交付）/4.6 #474。本刀的有界退回用例不涉审批。
- 归约器与 `finishTurn(stopped)` → 3.1（已交付）；runtime `abort()`/`command()` → 2.2b（已交付）；控制占用（含 stop 持有占用）→ 4.4 #465（其 issue 正文「In Scope 补充（自 #473 移交，2026-09-27）」）；web → 7.2。
- fake-omp 任何改动。
