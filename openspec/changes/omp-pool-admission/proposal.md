# Proposal: omp-pool-admission（#463）

## Why
父 change `s1c-turn-control-governance` tasks 4.1（epic #448，issue #463）。

今天 `#dispatchNew`（`server/src/sessions/supervisor.ts:227-271`）不设上限，会话再多也照样 spawn。空闲回收发生在 runtime 内部（`runtime.ts:738-749`），supervisor 不接 `onExit`（`:246-262` 构造 opts 时没有传）。回收后 `Slot` 仍留在 `#slots`，下次 prompt 复用这个已死 slot，由 runtime 自行重 spawn（父 design D1 所说的 slot 泄漏）。

本刀依赖的前置件均已就绪：
- #462：`onExit` 恒接线，每个取得 pid 的 generation 恰回调一次，且在 token 撤销之后；
- #487：`pool.ts` 落点；
- #450：`agent_capacity` 503 码；
- #451：`maxProcesses` runtime 字段。

本刀把三件事作为同一个不变量交付：活进程登记、串行准入与最久空闲驱逐、退出即释放名额。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：AGENTS.md Critical Path「omp 子进程治理」：进程计数、驱逐、退出释放)
Blast radius: 名额泄漏或少计会导致活进程数超过 cap（资源耗尽），或者误报 503；错选受害者会杀掉回合中或挂起审批的进程；回合中退出时删 slot 或 shutdown，会丢残留帧、破坏游标封口语义；准入失败留下副作用会污染会话行或 epoch
Selected risk packs: Public API / CLI / script entry；Config / project setup；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建 `server/test/session-supervisor-pool.test.ts`（A1–A8）与 `server/test/session-supervisor-pool-exit.test.ts`（E1–E7，含 E3b），用真实 fake-omp 子进程（需精确控制时序处用 FakeChild）、cap=1/2、注入时钟；R 项先红后绿，M 项按变异检查记入 PR body；既有测试零改动全绿（只允许 helper `RuntimeOptions` 加一个可选字段）；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0

## What Changes
- `server/src/sessions/pool.ts`：新增 `ProcessPool`，承载活进程登记（准入序号、最近活动时刻、`busy` 谓词、`evicting` 标记）、Promise 链串行的准入临界区（`live<cap` 放行；`==cap` 选 `(lastActive, seq)` 最小的非忙者执行 retire，等其退出后重判；无候选抛 `HttpError("agent_capacity")`），以及同步幂等的 `release`。`Slot` 加 `entry` 字段。
- `server/src/sessions/supervisor.ts` 接线：
  - prompt 懒 spawn（`#dispatchNew`）改为先经 `#pool.admit`；
  - runtime opts 接 `onExit`，同步释放名额；该 slot 不在回合中时经既有 `#retireSlot` 退役，回合中则待 pump 收尾后退役；
  - `#retireSlot` 在 shutdown 之后释放名额，覆盖无 pid 失败；
  - 复用条件加「登记仍在」；
  - tokens 适配器 `issue` 拒绝已释放登记的 slot，堵住 runtime 内部重获取的旁路，复用分支据此回退一次新准入；
  - 新增只读 `liveProcessCount()`；
  - `maxProcesses` 缺省取 16。
- `server/src/agent-config.ts`：导出既有常量 `DEFAULT_OMP_MAX_PROCESSES`。
- 测试：两个新建测试文件；`session-supervisor-helpers.ts` 的 `RuntimeOptions` 加 `maxProcesses?: number`。

## Capabilities
- ADDED `omp-pool`「活进程集合与上限不变量」：取父 delta 同名块中本刀交付的部分，裁剪见 spec 引注（regenerate/fork 来源 → #465/#466，控制占用子句 → #473/#465/#466，Scenario「临时进程计入上限」→ #466、「控制占用期间不可驱逐」→ #465，「上限恒成立」只含 prompt）。
- ADDED `omp-pool`「串行化准入与最久空闲驱逐」：同上，fork 先退回与 regenerate/fork 拒绝副作用 → #465/#466；外加自写 Scenario「空闲回收进行中到达的 prompt 仍经准入」。
- ADDED `omp-pool`「进程退出即释放名额」：父块全部行为由本刀交付，按实现改述 slot 删除时点，并去掉准入路径枚举。
- 不改 chat-sessions：「会话 supervisor 源码模块划分」已规定 `pool.ts` 承载准入、驱逐与名额，本刀使它成立，不需要 MODIFIED；「REST prompt 受理与补偿」的 503 句归 #467（偏离 10）。

## Impact
- 源码：
  - `pool.ts` 60 → 约 150；
  - `supervisor.ts` 658 → 约 715（≤800，超过 760 时先把判定挪进 `pool.ts`）；
  - `agent-config.ts` 改 1 个 token。
- 零 diff：`omp/` 全部、`rest.ts`、`store*.ts`、`events.ts`、`turn-control.ts`、`index.ts`、`app.ts`、web、fake-omp。
- 新测试文件每个 ≤800 行；实测 `wc -l` 记入 PR body。
- 缺省 cap 16 下，既有部署与既有测试的行为不变（最多 3 个并发会话）。

## 偏离与决定
1. **命名**：issue/父文的 `#admitProcess`、`#liveProcesses` 是示意名，实际落为 `pool.ts` 的 `ProcessPool`（`admit`/`release`/`holds`/`touch`/`size`），supervisor 以私有字段 `#pool` 持有。理由是 #593 review 与主 spec「会话 supervisor 源码模块划分」要求 `pool.ts` 承载准入、驱逐与名额。写成 `SessionSupervisor` 的 `#private` 成员，会让那条 SHALL 不成立。spec 中的准入点相应改述为「`sessions/pool.ts` 的进程池准入」，归档时父 delta 三处 `#admitProcess` 措辞须同步（父 omp-pool spec `:44` 两处、`:67` 一处）。
2. **控制占用输入**：issue 写「登记是否持有控制占用」。控制占用登记（4.2a #473、4.4 #465、4.5 #466）尚不存在，本刀不建字段、不留桩。登记只保存 `PoolMember.busy()` 谓词，今天 = claim 或 pump 仍在，后续刀把「所属会话持有控制占用」并入同一谓词。「此项今天恒为假」这一说法是如实的：还没有任何代码能登记控制占用。
3. **最近活动时刻的刷新源**：父文写「与 runtime 空闲计时器同源：子进程帧到达或 prompt 受理即刷新」。runtime 还会被回合外的帧刷新（`runtime.ts:401`），supervisor 在不改 `omp/`（PR Boundary）的前提下看不到这些帧。实际刷新源为 prompt 受理、pump 每帧、回合结束。差异只影响受害者排序，不影响上限不变量。spec 按实际改写；归档时父块须改为相同措辞，或由后续刀给 runtime 加活动钩子（见 Open questions）。
4. **slot 删除时点**：父文「同步……删除 slot 登记」改为「同步释放名额；slot 经既有 retire 路径删除，回合中退出待回合收尾后删除」。证据是 `session-supervisor-stream.test.ts:73`：回合中原生退出后，游标须保持数值、残留帧须继续发布。同步删 slot 会让 `streamCursor` 回落为 `seq:null`；在 onExit 内 shutdown 会先于逻辑退出使回合失败，丢掉管道残留帧。**归档对账**：#463 归档时，父 omp-pool「进程退出即释放名额」（父 spec `:67` 写 onExit 同步删除 slot 登记）须改用子 delta 的 slot 删除时点措辞；否则 #465/#466 之后会把错误措辞原样推进主 spec。
5. **不在回合中的退出，在 onExit 内调用 `runtime.shutdown()`**（经 `#retireSlot`）。这是 carry-forward #573 所说的「按调用链推演安全、但无测试」的情形，因此按其要求补 runtime 级测试 E7：(a) 空闲崩溃，即本设计实际走的路径；(b) 回合中崩溃，按 carry-forward 原样。另加 supervisor 级真实子进程用例 E3b（回合间 SIGKILL）：这是 onExit 内 `#closeStdin` 作用于 Node 已销毁的真实 stdin 的唯一路径，须证明不产生保留故障。onExit 在任何情况下都不调用 `respondApproval`。
6. **堵住 runtime 内部重获取的旁路**（自写 Scenario）：`runtime.ts:246-267` 在当前代已退出或正在 retire 时自行 `#acquire`，而空闲回收由 runtime 内部发起，supervisor 看不见。空闲计时器触发与原生退出之间到达的 prompt 会走复用路径，runtime 随即 spawn 一个未计数的进程。本刀在 tokens 适配器 `issue`（spawn 前唯一的同步钩子、早于 bump）拒绝已释放登记的 slot，复用分支回退为一次新准入（202，或按上限 503），不向用户暴露 502。issue 与父文未列此路径，spec 自写 Scenario 固定它，归档时父 delta 须补。
7. **PR Boundary 外的一处源码改动**：`agent-config.ts:9` 给 `DEFAULT_OMP_MAX_PROCESSES` 加 `export`，使 supervisor 的缺省值与配置解析共用同一常量（carry-forward #451：undefined → 16）。不改 `app.ts`，回退 runtime 靠 supervisor 的缺省值兜底。
8. **公开只读访问器 `liveProcessCount()`**：仅供测试观察「集合为空」「无残留登记」，先例是 `supervisor.ts:148` 的 `sessionStreamSubscriberCount`。slot 表本身不暴露：「`#slots` 不含 A」经 E1 的行为证明（A 再 prompt 必经准入并驱逐 B）。
9. **helper 编辑**：`session-supervisor-helpers.ts` 的 `RuntimeOptions` 加可选 `maxProcesses`，纯类型、零行为变化，这是唯一允许的既有测试文件编辑。
10. **REST 503 规范句不在本刀**：父 chat-sessions「REST prompt 受理与补偿」的增量（`agent_capacity` → 503、控制占用 409、stopped 可发）归 #467（5.1b）等 REST 刀。路由代码不变：`rest.ts:130-136` 对任何错误都 `rollbackPrompt` 后再抛，映射器由 `http-typed-errors.test.ts:22` 证明；本刀的真实路由 503 证据（A6）挂在 omp-pool「全部在回合中」Scenario 下。
11. **测试文件名**：`session-supervisor-admission.test.ts` 已被占用（既有重复准入用例），新文件取 `session-supervisor-pool{,-exit}.test.ts`。

## Open questions（上报编排者，本刀不处理）
- 父 omp-pool「活进程集合与上限不变量」括注（偏离 3）在归档对账时如何处理：采用子 delta 措辞（推荐），或另开 issue 给 `SessionRuntime` 加活动回调。
- 边角：若回合中退出的 slot 在 pump 收尾前被新准入替换（REST 下只有 turn.end 同步 sink 重入这一条路可达），旧 slot 的退役不在 `#slots` 中，`shutdown()` 不会等待它的 stdout 排空。此时它的子进程已死、token 已撤销，只剩 ≤8s 的排空。记录为已知边界，不修。

## Non-goals
- `OMP_MAX_PROCESSES` 解析与启动失败（1.3 #451，已交付）。
- regenerate/fork 经准入（4.4 #465 / 4.5 #466），fork 源进程先 retire（#466），临时进程计入上限（#466）。
- 控制占用的登记与释放（4.2a #473 / 4.4 / 4.5）；本刀只提供 `busy` 谓词扩展点。
- REST 503 规范句与路由改动（#467），web 容量文案（7.2 #477）。
- 池参数实测定参（9.2 #494）。
- `omp/` 任何改动，含 carry-forward 所记既有问题：`runtime.ts` 长时间静默的活跃回合会被空闲回收。
