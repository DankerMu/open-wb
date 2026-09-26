# Proposal: runtime-exit-pending（#462）

## Why
父 change `s1c-turn-control-governance` tasks 2.2a（epic #448，issue #462）。

`SessionRuntime` 现在只在「有活跃回合时逻辑退出」这一种情况下调用 `onExit`（`server/src/sessions/omp/runtime.ts:380-391`，调用点在 `:384`）。空闲回收、回合间 retire、驱逐、关停、回合间崩溃都不上报，而且 supervisor 根本没有传 `onExit`（`server/src/sessions/supervisor.ts:263-279`）。这就是父 design D1 所说的 slot 泄漏根因。

另外，空闲计时器（`runtime.ts:622-633`）不认识挂起的审批。一个审批只要挂起超过 `OMP_IDLE_MS`，进程就会被回收（#460 E9 实证，`server/test/omp-approval-requests.test.ts:464-478`）。

本刀提供两个运行时不变量，4.1 #463 的名额释放和 4.3 #464 的「挂起不回收」都建立在它们之上：
- `onExit` 恒接线：每个取得过 pid 的 generation，原生退出恰上报一次，且在 token 撤销之后。
- 按 id 的 pending 集合暂停空闲计时。

按编排者决定，本刀还承接 #460/#569 遗留的运行时审批转接（`onApproval` + `respondApproval` 透传），见「偏离与决定」1。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：omp 子进程治理 Critical Path。涉及退出上报、token 撤销次序、空闲回收，以及审批转接闸门；改动 `SessionRuntime` 公开 API)
Blast radius: `onExit` 漏报或重报时，#463 的名额会泄漏或重复释放；回调早于撤销时，owner 会在 token 仍有效时就释放名额；pending 不暂停时，挂起审批的进程会被回收；pending 泄漏时，进程永不回收；转接闸门漏过终态或过期 generation 的审批时，#464 会在终态消息上插入 pending 行（违反 D5）
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Auth / permissions / secrets；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建一个测试文件（建议 `server/test/omp-runtime-exit-pending.test.ts`），用真实 fake-omp 子进程加注入时钟，按 design「Required evidence」覆盖 X1–X9、P1–P5、F1–F6、G1–G2（审批用例的 argv 在测试内由 `yolo` 换成 `write`；只有真实子进程到不了的两条闸门分支用 FakeChild 合成帧）。R 项先红后绿，G 项恒绿。`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 退出 0。既有测试零改动全绿

## What Changes
- `server/src/sessions/omp/runtime.ts`：
  - **`onExit` 恒接线**：调用点从 `#onLogicalExit`（`:384`，只在有活跃回合时调用，拿不到原生退出时会编造 `{code:null,signal:null}`）移到 `#onNativeExit`（`:368-378`），紧跟在 `this.#revoke(gen)`（`:374`）之后。
    - 该监听只挂在取得了 pid 的子进程上（`:321-330`），并由 `gen.native` 保证每个 generation 只进一次（`:369`）。
    - 构造选项签名不变，仍是 `onExit?: (exit: OmpExit) => void`（`:59`），`exit` 为 `{code, signal}`。
  - **pending 集合**：新增公开方法 `markPending(approvalId: string | number): void` 与 `clearPending(approvalId: string | number): void`。
    - 集合挂在当前 generation 上，随 generation 丢弃。
    - 集合非空时，`#resetIdle` 不装定时器；首个 mark 清掉已装的定时器；最后一个 id 被 clear 时，以完整空闲期限重装。
    - 重复 mark、clear 不存在的 id 都是空操作（不重置计时）。
  - **审批转接**（编排者追加）：
    - 新增构造选项 `onApproval?: (request: ApprovalRequest) => void`。`#bindProcess`（`:337-347`）订阅 `OmpProcess` 的 `approval` 事件，经与 `#onFrame`（`:350-356`）同构的 generation/回合闸门后同步转给 owner，未通过闸门的丢弃。
    - 新增 `respondApproval(id: string, decision: ApprovalDecision): void`，透传给当前 generation 的 `OmpProcess.respondApproval`；没有当前 generation 时为空操作。
    - 类型以语句级 `import type { ApprovalDecision, ApprovalRequest } from "./ui-requests.js"` 引入。
- `server/src/sessions/omp/commands.ts`：`Generation` 结构（`:23-37`）新增 `pending: Set<string | number>`。它是 2.0 为 pending 计时面预留的落点。若抽出 pending 辅助函数，也放在这里，且必须被引用（knip）。
- 新建一个测试文件：在测试内包装 `createRealFakeRuntime(...).runtime.spawnImpl`，做 `yolo→write` 替换并记录 stdin，与 #460 `launch()` 同法（`server/test/omp-approval-requests.test.ts:61-88`）。另加源码导入边界守护。

## Capabilities
- MODIFIED `omp-runtime`「每会话生命周期」：整段逐字取父 delta，本 issue 全量交付。
- ADDED `omp-runtime`「审批请求经 SessionRuntime 转接」：父 delta 无此文字，由本 issue 自写。
- MODIFIED `omp-runtime`「omp 运行时源码模块划分」：以主 spec 为底，自写追加一句（`runtime.ts`/`commands.ts` 对 `./ui-requests.js` 只有语句级 `import type`）和一个 Scenario「运行时对 UI 请求模块只有类型依赖」；原有两个 Scenario 逐字保留。

## Impact
- 源码只涉及 `runtime.ts`、`commands.ts`。以下文件零 diff：`process.ts`、`ui-requests.ts`、supervisor、store、`server/test/support/fake-omp*.mjs`、全部既有测试与 helper（含 `session-supervisor-helpers.ts`）。
- 行数估算：
  - `runtime.ts` 661 → 约 705（上限 720，超出时先把 pending 簿记抽到 `commands.ts`）。增量构成：类型导入 1、选项与字段 3、`markPending`/`clearPending` 约 18、`respondApproval` 3、`approval` 订阅与闸门约 14、`#resetIdle` 条件 1、`#acquire` 字面量 1、`onExit` 移位净 0。
  - `commands.ts` 156 → 约 157–175。
  - 新测试文件 ≤800（size-guard 扫 `server/test`）。
  - 实测 `wc -l` 记入 PR body。
- supervisor 本刀**不**传 `onExit`/`onApproval`，行为与今天相同：`onExit` 仍无人接收，审批仍无人转接。接线属于 4.1 #463 和 4.3 #464。

## 偏离与决定
1. **Scope 追加：运行时审批转接**（编排者决定；来源 carry-forward #460 fixture、#569 review）。
   - 缺口：#460 给 `OmpProcess` 加了 `approval` 事件与 `respondApproval`，但 `SessionRuntime` 既不转发事件，也不暴露应答。supervisor 拿不到 `OmpProcess`，#464 的 PR Boundary 又禁止触碰 `omp/`。本 issue 本来就在改 `runtime.ts` 公开 API，所以承接 `onApproval` 选项与 `respondApproval` 透传。这超出了 issue In Scope，issue Out of Scope 写的「审批识别与 `respondApproval`（2.1a）」指的是 transport 层，已由 #460 交付。
   - 闸门理由：`OmpProcess` 的 `approval` 事件绕过了 `#onFrame` 的 generation/回合闸门（`runtime.ts:350-356`）。不设闸门的话，#464 会对回合间或过期 generation 的审批插入 pending 行，违反父 D5「终态消息不存在 `decision NULL` 的审批」。闸门条件与 `#onFrame` 逐项相同：`this.#generation === gen`，并且 `turn !== undefined && turn.genId === gen.id && turn.sent`。
2. **pending 集合不自动绑定审批事件**（编排者决定）。
   - 转接不调用 `markPending`。`markPending`/`clearPending` 始终由 owner 显式调用，消费者是 4.3 #464：它登记审批时 mark，结算时 clear。
   - 佐证：自动绑定会使 #460 E9（`omp-approval-requests.test.ts:464-478`：未 mark 时 idle 照常回收挂起审批的进程）变红，而既有测试不得改动。
   - 建议 #464 在 `onApproval` 回调内同步调用 `markPending`（`node:sqlite` 是同步 API），避免 generation 在异步间隙里切换后，把 mark 落到后继 generation 上。
3. **模块边界守护加强**（编排者决定）。`runtime.ts` 需要 `ApprovalRequest`/`ApprovalDecision` 类型，取语句级 `import type`（#460 design 已预告 #462 这样引入）。不选行内 `import { type X }`，因为它的擦除取决于编译选项。不改 `process.ts` 做 re-export，因为 PR Boundary 不允许。
   - 新测试文件里的守护 G1：`runtime.ts`/`commands.ts` 中凡引用 `./ui-requests.js` 的语句都必须是 `import type`；不得有值导入、副作用导入、动态导入或 re-export；不得引用 `answerFrame`/`cancelFrame`/`approvalRequest`。
   - 守护 G2：`server/src/sessions/` 下除 `omp/process.ts`、`omp/ui-requests.ts` 外，任何 `.ts` 都不得值导入 `ui-requests.js`，也不得出现 `extension_ui_response` 字面量。这样 #464 的 `sessions/approvals.ts` 只能经 `runtime.respondApproval` 应答。
   - #460 E10（`omp-approval-requests.test.ts:485-494`）不改。
4. **spec 拆分**（编排者决定）。
   - 「每会话生命周期」由本 issue 全量交付，逐字取父块。
   - 父 delta 里没有任何段落写到运行时向 owner 转发审批。已核对：omp-runtime「RPC IO and child observation」只写到 transport 向其 owner 上抛，以及「Neither the transport nor SessionRuntime SHALL ever answer」；tool-approval 父 delta `:9`、`:81` 只写 `OmpProcess` 分流与 supervisor 调 `markPending`；omp-pool、turn-control 都没有这段。所以子 delta 自写 ADDED「审批请求经 SessionRuntime 转接」。
   - **归档时父 omp-runtime delta 须补同一块**（推进后按 runbook 改为 MODIFIED，并与主 spec 逐字一致），由编排者对账。
   - 模块划分 requirement 的追加句是自写，父 delta 无此块，原样推进。
5. **`onExit` 签名保持 `onExit(exit: OmpExit)`**：issue Key interfaces 写的是 `onExit(code, signal)`。保持现有 `{code, signal}` 单参形状，是为了不破坏既有调用方 `omp-runtime.test.ts:628`、`omp-runtime-io.test.ts:353`，载荷信息相同。
6. **`onExit` 调用点在原生退出而非逻辑退出**，有两个依据：
   - 已验证：Node 对不存在的可执行文件 `spawn` 时 pid 为 `undefined`，只发 `error(ENOENT)` 与 `close(-2, null)`，不发 `exit`。`process.ts` 把 `close` 转成自身的 `exit` 事件（`:413-415` → `#onChildClose` → `#publishExit`），再进入 `runtime.ts` 的 `#onLogicalExit`。如果恒接线放在逻辑退出点，未取得 pid 的 generation 也会触发一次回调，载荷是编造的：现有代码在 `gen.native` 为空时回落为 `{code:null,signal:null}`（`runtime.ts:384`），transport 的 exit 事件本身则带 `{code:-2}`。
   - 父 omp-pool delta `:67` 要求「进程退出立即释放名额，与 ring 排空独立」，而逻辑退出要等管道排空，最长 8s。
   - 可见的行为变化：回合中崩溃时，`onExit` 早于迭代器失败（原先在其后）。没有既有断言依赖这个次序（见 design Sibling surfaces）。
7. **「五路退出」按运行时公开面映射**。运行时唯一的公开 retire 入口是 `shutdown()`：supervisor 的回合间 retire 与驱逐都经 `#retireSlot` → `runtime.shutdown()`（`supervisor.ts:598-613`），在运行时这一侧不可区分。因此证据以子进程行为区分：
   - 回合间 retire 用 EOF 退出，结果 `{0,null}`；
   - 驱逐式 retire 用 `hang-term` 走满 TERM/KILL 升级，结果 `{null,"SIGKILL"}`。
   - 另按父文「crash during or between turns」补一条回合间崩溃（X5），并补一条取得 pid 后的启动失败（X8）。后者对应 omp-pool 父 delta `:67`「已取得 pid 后的启动失败」，是 #463 名额账依赖的路径。
8. **两条闸门分支用合成帧证明**，因为真实 fake-omp 到不了：
   - fake 只在 prompt 回合内、`prompt` 帧之后发 select，所以「无活跃回合」的审批只能用 FakeChild `emitLine` 构造（先例 #460 E4/E6）。
   - 运行时只在子进程原生退出之后（此时 `OmpProcess` 已关写入，`process.ts:574-578` 不再上抛审批），或在 pid-less generation 上替换、丢弃 generation。所以「过期 generation」的审批只能用「完成握手的 pid-less FakeChild」构造（见 design F2）。

## Open questions（上报编排者，本刀不处理）
- `respondApproval(id, …)` 不携带 generation 身份，只透传给当前 generation。fake 的 select id 在每个进程内固定为 `r1`/`r2`，真实 omp 用 Snowflake id（`resource/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:591`）。若 #464 对已退出 generation 的审批迟到作答，而后继 generation 恰好也挂起了同名 id（只可能在 fake 下出现），应答会落到后继进程。按父 D5，进程退出时 #474 会以 `deny` 结算、不发帧，CAS 会让迟到作答 409，所以正常路径到不了运行时。建议 #464 fixture 显式断言这一点。
- 既有问题（carry-forward #547）：长时间静默的活跃回合会被空闲回收（`runtime.ts:622-633`）。pending 暂停只覆盖审批挂起期，不修这个问题。

## Non-goals
- supervisor 接线 `onExit`、名额释放、删 slot：4.1 #463。`onExit` 保持可选，`supervisor.ts:263-279`、`SessionSupervisorRuntime`（`:32-44`）、`app.ts:140-146` 的回退 runtime 都不动。
- 审批登记、60s 计时、结算，以及调用 `markPending`/`clearPending`/`respondApproval`：4.3 #464。
- `command(frame)` 与 `abort()`：2.2b #488。停止意图：4.2b #490。生产 argv 切到 `write`：2.1b #481。
- `process.ts` 的任何改动，包括 carry-forward #569 记录的 retire 期间 cancel 写入已 end 的 stdin，那是既有问题。
