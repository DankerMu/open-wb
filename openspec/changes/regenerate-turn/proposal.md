# Proposal: regenerate-turn（#465）

## Why
父 change `s1c-turn-control-governance` tasks 4.4（epic #448，issue #465），另含 #473 移交的补充：stop 在调用期间持有控制占用，且永不因占用返回 409。

omp 没有原生 regenerate，只有 `get_branch_messages`/`branch`（父 design D3）。依赖均已就位：
- `command(frame)` runtime 面：#488（`runtime.ts:243-284`）；
- 假 omp `branch` 场景与 `--branch-entry` 旋钮：#457/#552；
- 进程池准入与 `ReadmissionRequired` 回退：#463；
- `store-branch.ts` 落点：#454；
- stop 与停止意图：#473/#490；
- 终态结算审批：#474。

本刀交付 supervisor 侧的 `regenerate`，以及把 prompt/regenerate/stop 串起来的会话级控制占用。REST 路由留给 #467。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」，涉及控制占用并发、驱逐与 CAS 数据一致性)
Blast radius: 占用漏放则会话永久 409；占用漏查则并发 prompt 在 `#commanding` 期间撞 runtime 同步 busy 而 retire 掉 regenerate 的进程；CAS 漏判则删错助手行或覆盖并发回合；dispatchCount 不平衡则 ring 永不封口；提交后失败可能复活旧行或让回合卡在 running
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Resource limits / large input / discovery；Schema / columns / units / field names；File IO / path safety / overwrite；Error handling / rollback / partial outputs；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-regenerate{,-faults}.test.ts`（真实 fake-omp `branch` 子进程 + 真实 SQLite；FakeChild 仅用于退出/空列表/池/派发窗口），R/F 先红后绿，M 变异记入 PR body；前置纯移动 commit 既有测试零 diff 全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 全部退出 0

## What Changes
- **前置纯移动**（独立首个 commit，偏离 1）：把 `ReadmissionRequired`、generation token 适配器与 dispatch/pump 计数释放函数从 `supervisor.ts` 原样移到 `pool.ts`，使 `supervisor.ts` 在功能落地后仍 ≤798 行。
- **`turn-control.ts`**：
  - `ControlClaims`：按会话计数的控制占用；
  - `Regenerations`：执行序为预检 → 取得进程 → `get_branch_messages` → 比对 → `branch` → `get_state` → CAS 事务 → 同步派发，外加各段失败映射。
- **`supervisor.ts`**：
  - 新增公开 `regenerate(sessionId, ownerId)` 与同步 `controlHeld(sessionId)`；
  - `#prompt` 同步前缀按占用拒绝；
  - 池成员 `busy` 纳入占用；`#onProcessExit` 在占用期间只释放名额、不退役 slot；
  - `stop()` 在调用期间持有占用；
  - 活 slot 复用 / 新准入泛化为 `#onSlot`/`#onNewSlot`，供 prompt 与 regenerate 共用。
- **`store-branch.ts`**：单事务 CAS。复核会话非 running 且末条 assistant id 等于预检值，然后删旧行（步骤与审批级联）、插新 running 行、写 `omp_session_file` 与 status。
- **`store.ts`**：新增 `SessionStore` 方法，调该事务并登记内存 Turn；`acceptPrompt` 的 Turn 构造抽成共用 helper（偏离 2）。
- 测试：两个新测试文件 + 一个新 helper 文件。

## Capabilities
- turn-control：
  - ADDED「会话级控制占用」，只含 regenerate 与 stop，另有自写计数句与 Scenario「stop 持有占用且不被占用阻塞」；
  - ADDED「重新生成 REST」，只含 supervisor 部分；
  - MODIFIED「停止生成 REST」：并入 stop 占用括注与 #490 移交的两处 regenerate 片段。
- chat-sessions：MODIFIED「Supervisor dispatch and generation binding」，并入 regenerate 与控制占用部分和两个 Scenario。
- omp-pool：
  - MODIFIED「活进程集合与上限不变量」：regenerate 来源、控制占用子句、Scenario「控制占用期间不可驱逐」；
  - MODIFIED「串行化准入与最久空闲驱逐」：regenerate 路径与「不改动任何行」。
- tool-approval：MODIFIED「chat_approvals 持久化」，Scenario「级联删除」WHEN 取父文。
- omp-runtime：MODIFIED「子进程 spawn 契约」，补回 #481 留下的末句中 regenerate 的一半。
- 各块裁剪与去向见各 spec 顶部引注。未交付部分：fork 的全部片段 → #466；REST 路由、202、受理前占用检查、「会话 REST」合并措辞 → #467。

## Impact
- 源码（实测记入 PR body）：

  | 文件 | 当前行数 | 目标 |
  |---|---|---|
  | `supervisor.ts` | 785 | commit 1 后 ≤705，commit 2 后 ≤775（硬上限 798） |
  | `pool.ts` | 161 | ≤260 |
  | `turn-control.ts` | 236 | ≤440 |
  | `store-branch.ts` | 115 | ≤175 |
  | `store.ts` | 694 | ≤725 |

- 零 diff：`omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`app.ts`、`fake-omp*.mjs`、web、全部既有测试文件。
- `SessionSupervisorPort` 不变，REST 行为不变，只多了一种 prompt 被拒原因：占用中 → 既有 409 + `rollbackPrompt`。

## 偏离与决定
1. **前置纯移动越过 PR Boundary（`pool.ts`）**。
   - 实测：只把三个计数释放函数移出时，功能稿约 811 行（>800）；再移出 `#adapter` 与 `ReadmissionRequired` 后约 761 行。
   - 移动的是 generation 的记录与准入闸门，属主 spec「会话 supervisor 源码模块划分」给 `pool.ts` 的职责；`pool.ts` 判定规则（`:129-160`）不动。
   - 以独立 commit、`--color-moved` 与既有测试零 diff 保证是纯移动（先例 #487 的 4.0b）。
2. **`store.ts` 越过 PR Boundary**：内存 Turn 登记（`activeTurns`/`activeSessions`）只在 `store.ts` 闭包里，事务本体仍在 `store-branch.ts`（carry-forward :10/:11 对 fork 的同一裁定）。
3. **REST prompt 的注入在 #467 之前是「受理 → supervisor 拒绝 → `rollbackPrompt`」**：结束后的行与注入前逐字相同，但过程中有瞬时写入（且消耗 AUTOINCREMENT 序号）。spec 中「不写任何行」只对 regenerate 注入断言，prompt 的受理前拒绝归 #467。
   - 补偿在同一串微任务内完成，早于任何子进程 I/O，因此 regenerate 的 CAS 看不到瞬时行。
4. **提交前任何失败都 retire 进程**，包括文本不一致与空列表，超出父文「branch 之后」。
   - 理由：runtime 在 `get_state` 后已切换 resume 路径（`runtime.ts:274-277`）；只要一条 catch，不必推理哪条命令已到达 omp。
   - 可观察结果仍满足父 Scenario：行不变，随后 prompt 202。
5. **Scenario 时点改写**，均在 spec 引注中写明：
   - 注入时点改为「应答未到」：应答与下一次写帧、`get_state` 应答与事务之间虽有 await，但只经过微任务，没有 I/O 或宏任务边界，外部请求插不进来，所以父文所说的间隙无法构造；
   - 「最终事务复核失败」与「控制占用期间不可驱逐」同理；
   - 「正常重新生成」按假 omp 固定列表（`fake-entry-2`/`"second question"`）改写。
6. **fork 注入延后**：fork 不存在，issue 验收「注入 prompt/regenerate/fork」中的 fork 随 #466 补测。
7. **命名**：`acceptRegenerate`、`replaceLastAssistant`、`ControlClaims`、`Regenerations`、`#onSlot`、`#onNewSlot` 均为示意名，实现可改，行为不可改。
8. **自写 spec 内容**（归档时父 delta 须采纳）：
   - 「会话级控制占用」的计数与同步判定句，以及 Scenario「stop 持有占用且不被占用阻塞」；
   - 「停止生成 REST」的 Scenario「regenerate 派发前停止」。

## Open questions（上报编排者，本刀不处理）
- **提交后 `finishTurn` 自身失败**（S7 类残留）：新行停在 running，Turn 已 faulted，regenerate 以该错误 reject。与 carry-forward :73 所记 stop 的 S7 残留同源，建议并入同一新 issue。
- **提交后派发失败不发布 `turn.end`/`error`**：与 prompt 预进度失败一致。但 regenerate 没有 REST 补偿，在线订阅者只能靠 502 响应或快照刷新得知 `failed`。是否要合成 `turn.end(failed)`，交 #467/#477 决定。
- carry-forward :52（「在回合中」的 spec 措辞与 `busy()` 含派发在途的差异）属 #463 归档对账，本刀扩展 `busy` 后差异仍在，不在本刀修。

## Non-goals
- REST `POST /api/sessions/:id/regenerate`、202 形状、prompt 受理前占用检查、「会话 REST」合并措辞：#467（5.1b）。
- fork 与其在控制占用、池、spawn 契约中的全部片段：#466（4.5）。
- web「重新生成」按钮：7.3a。真二进制验证：9.3。
- `omp/`、假 omp 任何改动；新增假 omp 场景（`fake-omp.mjs` 793/800）。
