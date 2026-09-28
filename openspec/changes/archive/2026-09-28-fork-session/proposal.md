# Proposal: fork-session（#466）

## Why
父 change `s1c-turn-control-governance` tasks 4.5（epic #448，issue #466）。

omp 的 `branch` 会把当前进程切到新会话文件，所以不能在源会话的活进程上做（父 design D4）。fork 的做法是：源会话的存活进程先 retire，再起一个**临时**进程 `--resume <源文件>` 执行 `get_branch_messages → branch → get_state`，最后在一个 SQLite 事务里 CAS 复核并拷贝分叉点之前的行。

依赖均已就位：
- `command(frame)` 与「fork 临时进程的 owner 接入不递增 epoch 的 token 适配器」：#488（`runtime.ts:243-284`）；
- 进程池准入：#463（`pool.ts:89-163`）；
- 控制占用与 branch 命令族编排：#465（`turn-control.ts:164-357`）；
- 假 omp `branch` 场景：#457/#552（`fake-omp.mjs:52-55,84-92,343-366`）；
- `store-branch.ts` 落点：#454；schema（`parent_session_id`、`chat_approvals`）：#449。

本刀交付 supervisor 侧的 `fork(sessionId, ownerId, messageId)`，以及控制占用、进程池、spawn 契约中的 fork 部分。REST 路由 `POST /api/sessions/:id/fork` 与 201 映射留给 #469（5.2b）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」，涉及临时进程计数、源进程先退回、控制占用并发与行拷贝事务)
Blast radius: 源进程未先退出则同一 `.jsonl` 被两个进程打开；临时进程漏计则越过 `OMP_MAX_PROCESSES`；临时进程漏关则名额与 token 泄漏、shutdown 挂住；CAS 漏判或事务不原子则拷贝出与 omp 文件不一致的历史、留下半个会话；占用漏放则源会话永久 409
Selected risk packs: Public API / CLI / script entry；Auth / permissions / secrets；Concurrency / shared state / ordering；Resource limits / large input / discovery；Schema / columns / units / field names；File IO / path safety / overwrite；Error handling / rollback / partial outputs；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-fork{,-faults}.test.ts` + `session-fork-helpers.ts`（真实 fake-omp `branch` 子进程 + 真实 SQLite；FakeChild 只用于退出、关停间隙、池与事务故障），R/F 先红后绿、M 变异记入 PR body；前置纯移动 commit 既有测试零 diff 全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 全部退出 0

## What Changes
- **前置纯移动**（独立首个 commit，偏离 2）：
  - `Regenerations` 及其端口/计划类型、`TERMINAL`、`record()`（`turn-control.ts:204-363`）原样移入新文件 `server/src/sessions/branching.ts`；
  - `#onNewSlot` 的 `SessionRuntimeOpts` 组装（`supervisor.ts:392-415`）抽成 `pool.ts` 的 `sessionRuntimeOpts(base, per)`。
- **`branching.ts`**：
  - regenerate 的 `branch → get_state` 段（`turn-control.ts:296-315`）抽成模块函数，与 fork 共用；
  - 新增 `Forks`：预检 + 占用、先 retire 源会话进程、临时进程准入与构造、按序号+文本对齐、`branch`/`get_state`、关停临时进程、提交事务；外加 `close()`，供 shutdown 关停在途临时进程。
- **`pool.ts`**：新增临时进程的 token 适配器：不递增 epoch，只允许获取一次，且名额必须仍在。
- **`supervisor.ts`**：
  - 公开 `fork(sessionId, ownerId, messageId): Promise<{session, draft}>`，与 `regenerate` 共用 closed 检查、错误翻译、`#track`；
  - `retireSource` 端口；`shutdown()` 在等待 admissions 之前调用 `Forks.close()`。
- **`store-branch.ts`**：新增 fork 单事务，依次：CAS 复核源会话、插入新会话行、按显式列 `INSERT … SELECT` 拷贝消息/步骤/审批、置新会话 status。
- **`store.ts`**：`SessionStore.commitFork(...)`：调用该事务，并以 `SESSION_COLUMNS`/`toSessionView` 返回新会话五字段视图（偏离 3）。
- 测试：两个新测试文件 + 一个新 helper 文件。

## Capabilities
- turn-control：
  - ADDED「从此处分叉 REST」，只含 supervisor 部分；执行序按偏离 1 改写；
  - MODIFIED「会话级控制占用」，并入 fork 部分，Scenario「regenerate 各 RPC 间隙」注入补 fork；新增「fork 各 RPC 间隙」（时点改为「应答未到」，另加一个自写间隙）；「失败后释放占用」取父文。
- chat-sessions：
  - MODIFIED「Supervisor dispatch and generation binding」，并入 fork 句与 Scenario「Fork temporary runtime is not a generation」；「Control claim excludes …」取父文；
  - MODIFIED「会话 supervisor 源码模块划分」，加入 `branching.ts`（偏离 2）。
- omp-pool：MODIFIED「活进程集合与上限不变量」「串行化准入与最久空闲驱逐」「进程退出即释放名额」，三块均以父文为底（前两块的改写见 spec 引注）。
- omp-runtime：MODIFIED「子进程 spawn 契约」，末句按父文整句替换。
- tool-approval：不改。父 tool-approval delta 没有 fork 文本，审批行拷贝规定在 turn-control「从此处分叉 REST」中；「chat_approvals 持久化」不涉及拷贝。
- 各块的裁剪与去向见各 spec 顶部引注。未交付部分：REST 路由、body 形态、201/no-store、「会话 REST」fork 段 → #469；prompt 受理前占用检查与「不写任何行」→ #467。

## Impact
- 源码行数（实测记入 PR body）：

  | 文件 | 当前 | commit 1 后 | 终点 |
  |---|---|---|---|
  | `turn-control.ts` | 439 | ≤290 | ≤290 |
  | `branching.ts` | — | ≤185 | ≤450 |
  | `supervisor.ts` | 767 | ≤760 | ≤790（硬上限 798） |
  | `pool.ts` | 256 | ≤290 | ≤315 |
  | `store.ts` | 719 | 719 | ≤760 |
  | `store-branch.ts` | 169 | 169 | ≤320 |

- 零 diff：`omp/`、`rest.ts`、`approvals.ts`、`events.ts`、`index.ts`、`app.ts`、`store-approvals.ts`、`fake-omp*.mjs`、web、全部既有测试文件。
- `SessionSupervisorPort`（`rest.ts:15-20`）不变，REST 行为不变；新增 `SessionStore.commitFork` 为必选方法，测试中没有手写的 `SessionStore` 实现（`grep -rn "SessionStore" server/test`）。

## 偏离与决定
1. **新会话行在最终事务内插入，而非「先建新会话行」**。偏离 issue In Scope、父 tasks 4.5 与父 spec 执行序。
   - 理由：
     - 先建的行在进程崩溃时会成为孤儿（空 idle 会话，带源标题与 `parent_session_id`）。唯一的清扫点 `reconcileOnStartup` 受主 spec 约束（chat-sessions `spec.md:61`「preserving all other fields/rows」），不能删它。
     - 先建的行在 fork 期间出现在 `GET /api/sessions` 中，可以被 prompt。这样就必须对新 id 再持有一份占用，并在事务里 CAS 新行。
     - 在事务内插入后，没有孤儿、没有补偿删除、没有第二份占用。
   - 可观察结果仍满足父 Scenario：失败后新会话不存在于 `GET /api/sessions`；成功时新会话行形状与父文相同。
   - 新会话 id 在预检段预生成（`randomBytes(16)` hex，同 `store.ts:229`），用作临时进程的 token 键，在事务内插入。
   - 改写的句子（归档时父 delta 须采纳）：
     - turn-control「从此处分叉 REST」：执行序首箭头，「删除已建的新会话行」三处；
     - chat-sessions 绑定块补偿括注「removing a pre-created fork session row」；
     - omp-pool「fork 路径删除已建的新会话行」。
   - **备选**（若编排者坚持先建）：新会话行在预检同步段插入。此时以下三点是**必需**的：
     - 对新 id 同样持有控制占用；
     - 事务 CAS 新行仍为 `idle`、文件 NULL、零消息；
     - 失败路径删行。

     崩溃孤儿则作为已知残留记录，清扫另开 issue，因为要改 reconcile 规格。
2. **新建 `branching.ts` 与前置纯移动**，越过 PR Boundary（issue 写 `turn-control.ts`；新增文件、`pool.ts`）。
   - 实测 `turn-control.ts` 为 439/440，fork 编排放不下（carry-forward :103）。
   - `supervisor.ts` 为 767，不抽取时接线后估算约 792；抽出 runtime 选项组装后可留出余量。
   - regenerate 与 fork 共用 branch 命令段与 entry 解析，放在一处，jscpd 不会报重复。
   - 以独立 commit + `--color-moved` + 既有测试零 diff 证明是纯移动（#487/#465 先例）。
   - 须 MODIFIED chat-sessions「会话 supervisor 源码模块划分」（#464 先例）。
   - `pool.ts` 的判定规则（`:131-162`）不动。
3. **`store.ts` 越过 PR Boundary**：
   - `commitFork` 的接线（`SessionStore` 方法、`SESSION_COLUMNS`/`toSessionView` 读回视图）留在 `store.ts`；
   - 事务本体在 `store-branch.ts`，不值导入 `store.ts`/`store-approvals.ts`（carry-forward :10/:11 的裁定）。
4. **Scenario 时点**：
   - 「fork 各 RPC 间隙」改为「应答未到」（carry-forward :103，同 #465）。另自写可构造的第五个间隙「临时进程关停未完成」：`get_state` 之后先关停临时进程（等子进程退出），再提交事务，这个窗口有真实的 I/O 边界。
   - 「fork 最终事务复核失败」**保留**父文「`get_state` 应答后、事务提交前」，理由同上。
5. **自写 spec 内容**（归档时父 delta 须采纳）：
   - chat-sessions 失败映射句扩为 regenerate 与 fork 两条路径；
   - turn-control 括注「末条被拷贝 assistant 仍为 `running` 时视为事务失败」；
   - 第五个间隙。
6. **命名**：`Forks`、`commitFork`、`sessionRuntimeOpts`、`temporaryTokens`、`retireSource`、`branching.ts` 中的共用函数名均为示意名，实现可改，行为不可改；`branching.ts` 文件名按 spec 固定。

## Open questions（上报编排者，本刀不处理）
- 偏离 1 需编排者确认；否决则按备选段落实施，fixture 相应改写。
- 审批 `decision` NULL 的历史行（#474 之前的数据，carry-forward :84）会按「原值」拷贝成非 running 会话上的 pending 行，之后可被作答，但没有活进程。生产在 #481 之前为 yolo，不可达。是否在拷贝时结算为 `deny`，交 #486 收尾或新 issue。
- carry-forward :102（OPEN）：提交后派发失败会让 SQLite 领先于 omp 文件。之后 fork 到该序号及其后的 user 消息会永久 502（对齐不上）。与 regenerate 同源，归同一新 issue。
- **偏离 1 的下游（须写入 carry-forward）**：父 chat-sessions「会话 REST」fork 段（父 `specs/chat-sessions/spec.md:147`「create the new session row first」，Scenario `:183-188`「on 502 the pre-created session row is removed」）归 #469。#466 归档时，父 delta 须在 turn-control「从此处分叉 REST」与 chat-sessions「会话 REST」**两处**采纳事务内插入的措辞；#469 的 fixture 须以推进后的主 spec 为底，不得逐字照抄父文，否则会在 REST 层把「先建新会话行」重新引入。
- 真实 omp 的 `branch` 新文件在进程被 stdin EOF 关停后是否已完整落盘，以及首条 user 消息走 `newSession({parentSession})` 路径（carry-forward :30），归 9.3 真二进制验证。

## Non-goals
- REST `POST /api/sessions/:id/fork`、body 形态、201/no-store、content-parser 归属、「会话 REST」fork 段：#469（5.2b）。prompt 受理前占用检查：#467。
- web「从此处分叉」：7.3b。smoke/ui-walk 分叉条目：8.1d/8.2d。真二进制验证：9.3。
- 035 元数据列（`workspace_id`/`scene`/`pinned_at`、`thinking`、`changes`）的 fork 继承：change B D14，届时由 B 在本刀的显式列清单上追加。
- 整会话 `--fork` 克隆、助手消息处 fork（父 Non-goals）。
- `omp/`、假 omp 任何改动（`fake-omp.mjs` 793/800）；`reconcileOnStartup` 改动。
