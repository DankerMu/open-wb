# Proposal: thinking-merge-persist（#519）

## Why
父 change `s1c-session-metadata-presentation` tasks 3.3（epic #509，design D5「合并、落库、发布」「上限」）。3.1（#514）让归约器对每个非空 `thinking_delta` 产出 `thinking.delta`，但 supervisor 在 `persistEvent` 把它丢弃，`chat_messages.thinking` 恒为 NULL。本刀在 supervisor 侧合并（2048 UTF-8 字节 / 2000 ms / 其它事件前 / 终态前）、有界落库（32768 码点 + `…（已截断）`）并在同一同步段内发布。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: SSE 公共事件契约新增一类普通 ring 事件；supervisor 发布漏斗 `#publish`（所有 ring 入队的唯一点，`supervisor.ts:683`）新增发布前冲刷；新计时器生命周期（pump、retire、关停）；`chat_messages.thinking` 写入。Critical Path「omp 子进程治理」的提交/故障路径。
Selected risk packs: Concurrency / shared state / ordering（冲刷位置、同步段、计时器与 pump/REST 结算交错、回放）；Error handling / rollback / partial outputs（落库失败不发布走 owned error-sink、infraFault 下丢弃、终态前冲刷）；Resource limits / large input / discovery（32768 码点上限、代理对、ring 代价）；Public API / CLI / script entry（SSE `thinking.delta` 事件与回放）；Legacy compatibility / examples（text.delta 逐条发布/缓冲落库纪律不变、既有 supervisor/SSE/store 测试）
Evidence floor: 新建 `server/test/thinking-buffer.test.ts` 与 `server/test/session-thinking.test.ts` 覆盖 design「Required evidence」；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- 新建 `server/src/sessions/store-thinking.ts`：`appendThinking(db, messageId, chunk): string`——共享上限 32768 码点、不拆代理对、越限那次落「填满前缀 + `…（已截断）`」并返回实际落库片段，此后返回空串不写；单条 `UPDATE chat_messages SET thinking = COALESCE(thinking,'') || ? WHERE id = ?`。`store.ts` 挂 `appendThinking(messageId, chunk)`。
- 新建 `server/src/sessions/thinking-buffer.ts`：`ThinkingBuffers`（每 slot 当前回合一个缓冲，注入 `SessionClock`，端口 `{append, publish, fault}`，`ApprovalRegistry`/`TurnStops` 同型）。
- `server/src/sessions/supervisor.ts` 接线：`#commit` 把归约器的 `thinking.delta` 交给缓冲（不经 `persistEvent`）；`#publish` 对任何非 `thinking.delta` 事件先同步冲刷该 slot 缓冲；`#retireSlot` 清计时器（infraFault 时丢弃缓冲）。
- `server/src/sessions/events.ts`：导出 `TRUNCATED_MARK`（与 step 截断同文单一来源）。
- 两个新测试文件。

## Capabilities
- ADDED `thinking-fold`（新 capability）「thinking.delta 合并发布与持久化」：父 delta 该 Requirement 全文与六条 Scenario（快照 `thinking` 投影已由 5.1 落地，句子为真；本刀测试直接读列）。
- MODIFIED `chat-stream`「纯协议事件归约」：main 原文，只把过渡句「Until the supervisor slices for thinking and file changes land …」改为只针对 `files.changed`，thinking 指向新 Requirement。
- ADDED `chat-stream`「思考与文件变更事件发布」：只含父 delta 的 thinking 部分 + `files.changed` 过渡句；两条 Scenario 按 thinking-only 改写（`files.changed` 部分由 3.4 以 MODIFIED 补回）。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **冲刷位置**：issue 写「定时刷出投递到 pump 的同一串行提交链（不与帧提交交错）」。但 spec 要求在 `approval.*` 之前冲刷，而 REST 结算的 `approval.resolved` 经 `ApprovalRegistry` 的 publish 端口（`approvals.ts:225-259`）发布，不在 pump 链上；pump-only 的串行链无法满足。`ring.push` 唯一调用点是 `#publish`（`supervisor.ts:683`），故冲刷钩子放在 `#publish`（任何非 thinking 事件入 ring 前）与计时器，每次冲刷为「`appendThinking` → `ring.push`」的同步段（中间无 await）。「不与帧提交交错」由此归结为「落库与入 ring 之间无 await」；pump 串行处理帧，缓冲只含已到达帧的内容，故 ring 次序仍等于上游到达次序。
2. **既有测试文件改动**：issue 要求既有测试零改动，但 `server/test/session-persist-new-events.test.ts:96-137`「supervisor — a real thinking turn … publishes no thinking.delta … stores no thinking」断言的正是本刀取消的过渡行为，必然变红。处理：删除该 describe 块（其场景由 `session-thinking.test.ts`「合并与落库」取代）、同时删去因此未使用的 import/常量（`postPrompt`、`createRealFakeRuntime`、`waitForTurn`、`waitForContent`、`assistantIdFor`、`eventsFor`、`openRecordingSession`、`ANSWER` 等）并更新文件头注释；`:70-94` 的 `persistEvent` 单测保持（`persistEvent` 对 `thinking.delta` 仍返回 `undefined`——supervisor 在调用它之前截走该事件）。
3. **`turn-control.ts` 注释**：`:268-270` 的「until the thinking (3.3) and file-change (3.4) supervisor slices replace these branches」改为说明 thinking 由 supervisor 缓冲在 `persistEvent` 之前截走、files.changed 待 3.4；仅注释，不改逻辑（issue PR Boundary 未列该文件）。
4. 父 chat-stream「思考与文件变更事件发布」是 thinking + files 合写；子 delta 只 ADD thinking 半并加过渡句，两条 Scenario 保留名称、内容改为 thinking-only。3.4 以 MODIFIED 补全；父 change 该 Requirement 与 thinking-fold Requirement 届时应为 MODIFIED（ADDED→MODIFIED 漂移，同 session-metadata）。

## Impact
- server：新 `store-thinking.ts`、`thinking-buffer.ts`；`supervisor.ts`、`store.ts`（挂接）、`events.ts`（导出常量）、`turn-control.ts`（注释）；测试两新文件 + `session-persist-new-events.test.ts` 删一个 describe。不触碰归约规则、`stream/`、web。
- 依赖：#514、#510、#518（fake `thinking` 场景与 `--thinking-repeat`/`--hold-after-thinking`）、A #487、#490 均已合并。

## Non-goals
- 归约映射（3.1）；`files.changed` supervisor 分支（3.4）；快照投影（5.1，已落）；web 折叠块（7.4）；`models.yml` reasoning（1.2）；fake-upstream `WORKBUDDY_THINK`（6.3）；text.delta 纪律。
