# Design: omp-pool-admission（#463）

父设计：D1「池治理落在 supervisor 准入点，不下沉到 runtime」「准入后 spawn/握手失败且无 pid 时由准入方同步释放名额」「runtime 增 `onExit` 接线……同时修复 slot 泄漏」；Risks「驱逐正在被另一请求准入的空闲进程 → Promise 链串行化」；「模块拆分」`supervisor.ts` → `pool.ts`（准入/驱逐/名额）。主 spec chat-sessions「会话 supervisor 源码模块划分」已规定 `pool.ts` SHALL 承载准入、驱逐与名额，故登记表、临界区与选受害者全部落在 `pool.ts`，`supervisor.ts` 只接线（#593 review）。

## Change surface
- **`server/src/sessions/pool.ts`**（60 → 约 150）：新增
  - `interface PoolMember { busy(): boolean; retire(): Promise<void> }`：由准入方提供。`busy` 为真即「在回合中」，不可驱逐；`retire` 执行既有 retire 序列，resolve 于进程退出、名额已释放之后。
  - `interface PoolEntry { member; seq; lastActive; evicting }`：`seq` 为准入序号（单调），`lastActive` 取注入时钟。
  - `class ProcessPool(cap, now)`：`admit(member): Promise<PoolEntry>`（经 `#tail` Promise 链串行）、`release(entry | undefined)`（同步、按身份、幂等）、`holds(entry | undefined)`、`touch(entry | undefined)`、`get size()`。
  - 临界区 `#admitNow` 为循环：`size < cap` → 登记并返回；否则在 `!evicting && !member.busy()` 的登记中取 `(lastActive, seq)` 最小者，置 `evicting = true`，`await member.retire()` 后重判；无候选 → `throw new HttpError("agent_capacity")`。`evicting` 保证同一登记不会被第二次选中；即使 retire 返回后登记仍在（按现行 runtime 不可达），也只会被排除，不会死循环。
  - `Slot` 加字段 `entry: PoolEntry | undefined`。
- **`server/src/sessions/supervisor.ts`**（658 → 约 715，实测记入 PR body；若超过 760，先把 `#turnFree` 与 onExit 判定挪成 `pool.ts` 纯函数）：
  - 构造（`:90-96`）：`#pool = new ProcessPool(runtime.maxProcesses ?? DEFAULT_OMP_MAX_PROCESSES, () => clock.now())`，其中 clock 为 `runtime.clock` 或系统时钟。`:42` 注释改为「undefined → 16」。
  - `#dispatchNew`（`:227-271`）：`#claim` 之后 `await #pool.admit({busy: () => #turnFree(slot) 取反, retire: () => #retireSlot(slot)})`。准入抛错时释放本次 claim 再抛出，此时尚未 new runtime，所以无 epoch、token、spawn、行变更。准入后若 `#closed`，释放登记与 claim，抛 `agent_unavailable`。`slot.entry = entry`，opts 追加 `onExit: () => this.#onProcessExit(slot)`。
  - `#onProcessExit(slot)`：只做两步，均同步、不抛错、不写 stdin、不调 `respondApproval`：
    1. `#pool.release(slot.entry)`；
    2. `#turnFree(slot)`（`claimedAssistantId === undefined && pump === undefined`）为真时 `void this.#retireSlot(slot)`。
    回合中不做第 2 步，见决定 1。
  - `#retireSlot`（`:581-597`）：在 `await slot.retiring` 之后、identity 删除（`:594`）之前加 `#pool.release(slot.entry)`。这一点覆盖无 pid 失败的准入方释放；有 pid 时 onExit 已释放，此处为幂等空操作。
  - pump 收尾（`:305-309`）：`releasePumpExit` 之后，登记已释放且 `#turnFree(slot)` 为真时 `void this.#retireSlot(slot)`。
  - `#prompt`（`:191-213`）：
    - 复用条件加 `#pool.holds(live.entry)`，否则走 `#dispatchNew`。不另加「先退役已退出 slot」的分支：onExit 与 pump 收尾都在 slot 变为 `#turnFree` 的同一同步段内设好 `retiring`，既有 `existing.retiring` 等待（`:192-194`）已覆盖，不存在「已退出、不在回合中、未在 retire」的窗口。
    - 复用分支若失败原因是 `ReadmissionRequired`，在既有 retire（`:217-219`）之后**无条件**改走一次 `#dispatchNew`（决定 3）；关停中由 `#dispatchNew` 准入后的 `#closed` 检查给出 `agent_unavailable`，哨兵错误永不到达 `#translate`，不会成为 generic 5xx。
  - `#bindDispatch` 入口、`#pump` 每帧、pump 收尾各 `#pool.touch(slot.entry)`。
  - tokens 适配器 `issue`（`:507-533`）：清 `acquisitionFault` 后、`bumpStreamEpoch` 之前，若 `!#pool.holds(slot.entry)`，则 `slot.acquisitionFault = new ReadmissionRequired()` 并抛出。`ReadmissionRequired` 是模块内非导出的 Error 子类。
  - 公开只读访问器 `liveProcessCount(): number`，返回 `#pool.size`，先例是 `:148` 的 `sessionStreamSubscriberCount`（仅测试使用）。
- **`server/src/agent-config.ts:9`**：`const DEFAULT_OMP_MAX_PROCESSES` 加 `export`，这是唯一改动（proposal 偏离 7）。`app.ts:140-146` 的回退 runtime 不动。
- **`server/test/session-supervisor-helpers.ts:30-39`**：`RuntimeOptions` 加 `maxProcesses?: number`，纯类型，零行为变化。

## Governing invariant
`#pool.size` = 已准入且未释放的登记数 ≥ 实际存活的 omp 子进程数，且恒 ≤ cap。成立的依据有三：
- 每次 spawn 前必有一次 `issue`，而 `issue` 只放行持有未释放登记的 slot；
- 一个 `SessionRuntime` 只对应一次准入，第二次 `issue` 必然遇到已释放的登记；
- 登记只在进程退出（onExit）或 runtime 已 shutdown（`#retireSlot`）之后释放。

## 决定（每条附强制它的证据）
1. **回合中退出只释放名额，不删 slot、不 shutdown**。守护是 `session-supervisor-stream.test.ts:73`：回合中 `nativeExit(1)` 之后，游标必须仍是 `{1,2}`，残留 delta 必须以 seq 3 发布。
   - 若在 onExit 删 slot，`streamCursor`（`:109-116`）会回落为 `seq:null`。
   - 若在 onExit 调 shutdown，`runtime.ts:186` 的 `#failActiveTurn` 会早于 `#onLogicalExit`（`:491`）执行，管道内残留帧被丢弃。
   - 该回合按既有路径收尾后（pump 的 catch `:392-394`，或正常结束走 pump 收尾），再进入 `#retireSlot`。
   - 第二个守护是 `stream.test.ts:184`：复用派发在途时 `nativeExit(2)`，派发仍须在 epoch 1 成功。onExit 此时看到 claim 已存在，只释放名额。
2. **不在回合中的退出，在 onExit 内调用 `#retireSlot`，即在子进程 `exit` 监听内调用 `runtime.shutdown()`**。这样既有机制照常生效：`#prompt` 等待 `retiring`，`shutdown()` 遍历 `#slots` 时能 await 它，删除仍按 identity 判定（`:594`）。
   - 空闲回收时 `gen.retiring` 已设，shutdown 只是复用同一 promise。
   - 空闲崩溃时 shutdown 发起 `#runRetire`，并使 `runtime.ts:486-487` 的 `#watchHeldPipe` 因 `gen.retiring` 已设而跳过。
   - 这正是 carry-forward #573 要求补测的情形，见 E7（空闲变体是本设计实际走的路径；回合中变体按 carry-forward 原样补上，作为 runtime 契约守护）。
3. **runtime 内部重获取的旁路由 `issue` 闸门关闭**。`runtime.ts:246-267` 的 `#readyGeneration` 在当前代正在 retire 或原生已退出时，会自行 `#acquire`，supervisor 不参与。空闲回收由 runtime 内部发起（`:738-749`），supervisor 看不见，而 PR Boundary 禁止改 `omp/`。
   - 窗口：空闲计时器已触发、原生退出尚未发生时到达的 prompt，会走复用路径（此时登记仍在）。
   - 这类重获取发生在 `await this.#retired`（`:247`）之后，因此必然晚于 onExit 释放登记。
   - `issue`（`runtime.ts:278`，spawn 前唯一的同步钩子）据此拒绝，且早于 bump，epoch 不动。派发以 `ReadmissionRequired` 失败，`#prompt` 退役旧 slot 后改走一次新准入：调用方看到的是 202 或按上限规则的 503，不会是 502。
   - 只选「回退重准入」这一种处理，不另设错误码。
4. **slot 身份即 generation 身份**：决定 3 保证每个 slot 的 runtime 只有一代取得过 pid，所以 onExit 闭包捕获的 `slot` 就是那一代的身份。
   - 过期退出不删除替换后的 slot，靠 `#retireSlot` 既有的 `#slots.get(id) === slot`（`:594`）；名额释放按登记对象身份进行，不受此限。
   - 按现行代码，替换总是等旧 slot 退役完成（`:191-194`，以及 `faults.test.ts:311`「replacement waits」）。所以「替换之后才到的过期退出」是结构性守护，公开 seam 不可达，不单独编测。
   - `faults.test.ts:311` 末尾对旧子进程第二次 `nativeExit(9)`，被 `runtime.ts:479` 的 `gen.native` 守卫挡住，不会第二次 onExit。
5. **控制占用 = `PoolMember.busy()` 谓词的扩展点**。控制占用登记（4.2a #473、4.4 #465、4.5 #466）尚不存在，本刀不建字段、不留桩，`busy` 今天就是「claim 或 pump 仍在」。
   - claim 自 `#claim` 起、至 pump 收尾 `releasePumpExit`（`pool.ts:37-47`）止，覆盖派发在途、回合进行、挂起审批。
   - 后续刀把「所属会话持有控制占用」并入同一谓词。fork 临时进程没有 slot，自行实现一个 `PoolMember`，接口不必改。
6. **最近活动时刻的刷新源** = `#bindDispatch` 入口（prompt 受理）+ pump 每帧 + pump 收尾（回合结束），时钟用注入的 `runtime.clock`，打平时按 `seq`。runtime 空闲计时器另外还会被回合外的帧刷新（`runtime.ts:401`），supervisor 在不改 `omp/` 的前提下看不到这些帧，因此 spec 按实际刷新源改写（proposal 偏离 3）。
7. **不加 runtime 活性 getter**：曾考虑给 `SessionRuntime` 加「当前代是否存活/正在 retire」的 getter，让复用条件直接判断、免去 `issue` 闸门。因 PR Boundary 禁止改 `omp/` 而否决。
8. **undefined 语义**：`maxProcesses` 缺省（`app.ts` 回退 runtime、测试 helper 都不传）取 `DEFAULT_OMP_MAX_PROCESSES`（16），与 `agent-config.ts` 同一常量。`supervisor.ts:246-262` 按名复制 runtime 字段，`maxProcesses` 不进入 `SessionRuntimeOpts`，runtime 不需要它。

## Must preserve
- `supervisor.ts:181-225` 既有两处 `session_busy`、shutdown 期 `agent_unavailable`，以及 `#translate`（`:612-623`）。`HttpError("agent_capacity")` 原样透传；REST `rest.ts:130-136` 捕获一切错误后 `rollbackPrompt` 再抛，映射器 `http/errors.ts:17` 给出 503。
- 每次 generation 获取 epoch 恰 +1（`:510`）；准入拒绝与 `ReadmissionRequired` 都发生在 bump 之前。
- `shutdown()`（`:152-170`）先 retire 全部 slot，再等 admissions 与 pumps；关停后 `liveProcessCount() === 0`。
- `runtime.ts`、`process.ts`、`rest.ts`、`store*.ts`、`events.ts`、`app.ts`、web 零 diff。

## Sibling surfaces
- **必然变红的既有测试：无。** 既有测试同时活跃的会话最多 3 个（`server-assembly`、`server-startup-order`），小于缺省 16；没有断言依赖「空闲后复用同一 slot」。允许的既有文件编辑只有 `session-supervisor-helpers.ts` `RuntimeOptions` 那一个可选字段。
- **零 diff 且全绿**：`session-supervisor{,-admission,-claims,-faults,-sinks,-stream,-subscribe}.test.ts`、`session-rest.test.ts`、`session-sse{,-lifecycle}.test.ts`、`session-snapshot.test.ts`、`omp-runtime*.test.ts`、`omp-approval-requests.test.ts`、`omp-max-processes-config.test.ts`（`:182-199` 断言 runtime 对象原样传递，不受影响）、`server-assembly.test.ts`、`server-startup-order.test.ts`。
- **须逐条确认的守护**（恒绿）：`stream.test.ts:73`（决定 1）、`:142`（空闲死亡后游标 `{1,null}`，下一回合 `{2,3}`）、`:184`（决定 1）；`faults.test.ts:311`（决定 4）；`session-supervisor.test.ts:57`（空闲后 `--resume`、epoch 2）、`:215`（崩溃残留，epoch 2）、`:271`（missing-session 502 补偿：有 pid 的握手后失败，onExit 在派发在途时触发，只释放名额）。
- **agent_capacity 无持久化副作用**：拒绝发生在 `new SessionRuntime` 之前，没有 bump、token、spawn、`setSessionFile`；受理对由 REST `rollbackPrompt`（`rest.ts:134`）补偿。503 信封的证明分两层：映射器由 `http-typed-errors.test.ts:22` 覆盖；真实 prompt 路由由新测试 A6 覆盖（精确 body、`no-store`、行与状态不变）。chat-sessions「REST prompt 受理与补偿」中 503 那句的 spec 归 5.1b #467（proposal 偏离 10）。

## Seams under test
- 新建 `server/test/session-supervisor-pool.test.ts`（A 组）与 `session-supervisor-pool-exit.test.ts`（E 组），各 ≤800 行；不访问私有字段，不 import `pool.ts`（它的导出只供 sessions/ 使用）。
- **装配**：`openBareSession({...rt.runtime, maxProcesses: N})`（helpers `:200-208`）。更多会话用 `createSession(app, cookie)`（`:302`）创建，发送用 `postPrompt`（`session-rest-helpers.ts`），等待用 `waitForTurn`/`waitFor`。
- **真实子进程**：`createRealFakeRuntime(scenario)`（`:87-121`），可 `setScenario`。测试内包装其 `spawnImpl`：
  - 每次 spawn 前把 `children.filter(c => c.exitCode === null && c.signalCode === null).length` 记入 `liveAtSpawn`（「以真实子进程观察」）；
  - 审批用例追加 `--approval-mode write`（`fake-omp.mjs:35`，末次生效）；
  - 需要时给 `stdout` 加 `data` 监听，解析 JSONL 等到 `extension_ui_request`。
- **FakeChild**：`createControlledRuntime(configure(child, call, ordinal))`（`:123-151`），可按序号配置 `closeOnEof`、自动或挂起回合，liveness 取 `exitCode/signalCode`。
- **区分 `--resume`**：fake 回报 `resume ?? DEFAULT`（`fake-omp.mjs:115`），所以在首个 prompt 前用 SQL 给 A 预置 `omp_session_file = "/tmp/open-wb-463-a.jsonl"`，用 `resumePath(args)` 断言。
- **无 pid**：包装器按模式切换：
  - `missing`：真实 `spawn(<临时目录下不存在的绝对路径>, …)`，加 `on("error", noop)`，照 `omp-runtime-exit-pending.test.ts:134-143`；
  - `throw`：同步抛错；
  - `valid`：委托真实 fake。
- **runtime 级 E7**：照 `omp-runtime-exit-pending.test.ts:561-603` 的 `openWired` 直接 `new SessionRuntime`，由 `onExit` 回调记录并 `void runtime.shutdown()`。包装 `child.stdout.destroy` 计数，用 `clock.pending()` 查计时器。
- **注意**：`createClock().advance` 会触发所有会话的到期计时器。A 组累计推进须小于 `IDLE_MS`（10_000）。
- **注意**：凡「Y prompt → 驱逐 X」一步之前，都先 `waitForTurn(X, "done"|"failed")`。X 的 pump 收尾前 claim 仍在，`busy()` 为真，结果会随机变成 503。

## Required evidence
R 表示先红后绿（相对「不含对应机制」的实现）；G 表示守护，恒绿；M 表示变异检查：临时删掉该机制，对应用例必须变红，结果记入 PR body。凡用例都断言 `max(liveAtSpawn) ≤ cap-1`。

**A 组（`session-supervisor-pool.test.ts`）**
- **A1 R 并发准入不越界**：cap=1，真实 `hang-prompt`，两会话 `Promise.all` 发 prompt。状态码多重集为 `{202,503}`；spawn 1 次；503 为精确信封。
- **A2 R 上限恒成立**：cap=2，4 会话并发，`hang-prompt`。结果 2×202、2×503；spawn 2 次；每个 503 返回时 `liveProcessCount() === 2`，两个 202 会话均为 `running`。
- **A3 R 驱逐最久空闲者**：cap=2，真实 normal。
  - A（预置文件）完成回合 → `advance(100)` → B 完成回合 → `advance(100)` → C prompt。
  - A 的子进程 stdin 结束并退出，C 的 spawn 在 A 退出之后；B 子进程 `exitCode/signalCode` 为 null、`stdin.writableEnded` 为 false；C 返回 202。
  - `waitForTurn(C, "done")` → A 再 prompt → 驱逐 B（最近活动 B 早于 C）→ A 的 spawn 带 `--resume /tmp/open-wb-463-a.jsonl`，202。A 的 `stream_epoch` 为 2，历史为 4 条消息，前两条原样保留。
- **A4 R 按活动而非准入序**：cap=2。A 完成 → `advance(100)` → B 完成 → `advance(100)` → A 在同一进程上完成第二回合 → C prompt。被驱逐的是 B，A 的子进程存活。M：把选择键改为 `seq` 时本例变红。
- **A5 R 打平取准入更早者**：cap=2，不推进时钟，A、B 各完成一回合 → C 驱逐 A。
- **A6 R 全部在回合中（FakeChild）**：cap=1。
  - 子进程 0 = B：自动完成、`closeOnEof`；子进程 1 = A：`closeOnEof`，发 `Hello` 后挂起；子进程 2 = B：自动完成、`closeOnEof`。三个子进程都要 `closeOnEof`，否则驱逐会卡在 `TERM_GRACE_MS`（注入时钟无人推进）。
  - B 完成 → A prompt 驱逐 B → A 挂起 → 快照 B 的行与会话行 → B prompt 返回 503，body 恰为 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}`，带 `cache-control: no-store`。
  - B 的消息行、`status: done`、`stream_epoch`、`omp_session_file` 与快照逐字相等；spawn 2 次；A 子进程 `stdin.writableEnded` 为 false，`exitCode/signalCode` 为 null。
  - 随后 `completeHeldTurn(A)` → `waitForTurn(A, "done")` → B prompt → A 的 stdin 结束并退出 → spawn 第 3 次（`--resume`）→ 202。
- **A7 R 挂起审批中**：cap=1，真实 `approval` 场景，argv 追加 write。等到 A 的 stdout 出现 `extension_ui_request` 后 B prompt，返回 503；A 子进程存活、stdin 未结束。收尾不会挂住：#462 P1/F6（`omp-runtime-exit-pending.test.ts`）已证明 r1 挂起时 stdin EOF 使 fake 以 `{0,null}` 退出。
- **A8 R 驱逐中不重复选中**：cap=1。A 用 `hang-eof` 完成回合，然后 `setScenario("hang-prompt")`，B、C 并发 prompt。
  - 等到 A 的 `stdin.writableEnded` 后，两个请求都仍 pending，spawn 仍为 1 次。
  - `advance(5000)` → A 以 `signalCode === "SIGTERM"` 退出 → spawn 恰为 2 次；B、C 的状态码多重集为 `{202,503}`。
  - M：去掉 `#tail` 串行后本例或 A1 变红。

**E 组（`session-supervisor-pool-exit.test.ts`）**
- **E1 R 空闲回收后不泄漏**：cap=1，真实 normal；照 A3 给 A 预置 `omp_session_file`（否则 `--resume` 与 B 同为 `DEFAULT_SESSION`，无法区分）。
  - A 完成回合 → `advance(IDLE_MS)` → A 退出；`liveProcessCount() === 0`。
  - B prompt 返回 202，spawn 2 次；B 的准入没有驱逐任何进程（B spawn 时 `liveAtSpawn` 为 0，且无 retire 发生）。
  - `waitForTurn(B, "done")` → A 再 prompt → B 的 stdin 结束并退出，之后 A 才 spawn，带 `--resume <A 文件>`，epoch 2。
  - 注意：删掉 onExit 的 release 时，`#retireSlot` 的 release 仍会在排空后兜底，本例不会稳定变红；该变异映射到 E5。
- **E2 R 无 pid 启动失败**：cap=1，按 AC 连续两次 ENOENT：会话 A、会话 B 都用 `missing` 模式，各一次 prompt（用不同会话，使各自 epoch 都停在 1）。
  - 两次都返回 502 `agent_unavailable` 精确信封；受理对被补偿（`expectCompensatedIdleSession`，`:293`）；每次之后 `liveProcessCount() === 0`。
  - 随后 A 用 `valid` 模式 → 202，spawn 调用共 3 次，只有第 3 次取得 pid。
  - 可选追加：在 `valid` 之前，会话 C 用 `throw` 模式（spawnImpl 同步抛错）一次，断言与 `missing` 相同（502、补偿、计数 0），spawn 调用总数相应 +1。
  - M：删掉 `#retireSlot` 中的 release 后，第一次失败后 `liveProcessCount()` 为 1，**第二次**尝试即返回 503（不是 502）。
- **E3 R 回合中外部 kill**：cap=1，真实 `hang-prompt`。`process.kill(pid, "SIGKILL")` → 观察到退出后立刻 `liveProcessCount() === 0`；`waitForTurn(A, "failed")`；之后 B prompt 返回 202，无驱逐，spawn 2 次。
- **E3b 回合间外部 kill（真实子进程，决定 2 在真实进程上的唯一新路径）**：cap=1，真实 normal，A 预置文件并完成回合，`process.kill(pid, "SIGKILL")`。
  - R：观察到退出后立刻 `liveProcessCount() === 0`。
  - G：onExit 在 Node 已销毁 `child.stdin` 之后于 exit 监听内调用 `#retireSlot` → `runtime.shutdown()` → `#closeStdin`，不产生保留故障：`openRecordingSession` 的 `errors` 为空，随后 `app.close()` 正常 resolve。
  - B prompt 返回 202，无驱逐，spawn 2 次；`waitForTurn(B, "done")` → A 再 prompt → 驱逐 B → `--resume <A 文件>`，202。
  - 父文「回合中崩溃」由 E3 覆盖，#462 X5 覆盖的是 runtime 级回合间崩溃；本条是其 supervisor 级对应。
- **E4 R 关停**：cap=2，A 用 `hang-prompt` 进行回合，B 在回合间空闲存活。`await fixture.app.close()` 之后：
  - 全部子进程已退出，`liveProcessCount() === 0`；
  - A 为 `failed`；
  - `streamCursor(A).seq` 与 `streamCursor(B).seq` 均为 null；
  - `supervisor.prompt` 以 `agent_unavailable` 拒绝。
- **E5 R 回合中退出，名额与 ring 相互独立（FakeChild）**：cap=1。子进程 0 = A：发 `Hello` 后挂起（无需 `closeOnEof`，它由测试 `nativeExit` + `endStdout` 结束）；子进程 1 = B、子进程 2 = A 重起：自动完成、`closeOnEof`。A 挂起在 `Hello`，游标 `{1,2}`。
  - `nativeExit(1)` 后同步断言 `liveProcessCount() === 0`，游标仍为 `{1,2}`。
  - 残留 delta → 游标 `{1,3}`；再 `message_end` error 与 `agent_end` → `failed`；`endStdout` → `seq: null`。
  - B prompt 返回 202；`waitForTurn(B, "done")` → A 再 prompt → 驱逐 B → epoch 2。
  - M：删掉 onExit 的 release 后，`nativeExit(1)` 之后的同步断言 `liveProcessCount() === 0` 稳定变红（`#retireSlot` 的兜底要等回合收尾与排空）。这是该变异的映射用例。
- **E6 R 空闲回收进行中到达的 prompt 仍经准入（FakeChild）**：cap=1。子进程 0 = A1：自动完成，**不** `closeOnEof`；其余自动完成并 `closeOnEof`。
  - A 完成 → `advance(IDLE_MS)` → 等到 A1 的 `stdin.writableEnded`。
  - 预置 A 的 `omp_session_file`（同 A3）。A prompt 保持 pending → `A1.nativeExit(0)`、`A1.endStdout()` → A 返回 202，spawn 2 次，`resumePath(calls[1].args)` 等于 A 的会话文件，`stream_epoch` 为 2（恰 +1），`liveProcessCount() === 1`。
  - `waitForTurn(A, "done")` → B prompt → A2 的 stdin 结束并退出之后 B 才 spawn → 202。
  - M：删掉 `issue` 闸门后，A2 不计入名额，B 不驱逐就 spawn，`liveAtSpawn` 出现 1，用例变红。
- **E7 G shutdown 在 onExit 内（runtime 级，FakeChild，stdout 保持打开）**：
  - (a) **空闲崩溃**：回合完成后 `nativeExit(1)`，`onExit` 内 `void runtime.shutdown()`。
    - `waitImmediate` 之后 `clock.pending() === 1`：只有 `#runRetire` 的排空计时，没有 `#watchHeldPipe`。
    - `advance(8000)` → `stdout.destroy` 恰调用 1 次，shutdown resolve；`exits` 长度 1，token 恰撤销 1 次。
  - (b) **回合中崩溃**（carry-forward #573 原样）：
    - 迭代到 prompt ACK 后 `nativeExit(1)`，`onExit` 内 `void runtime.shutdown()`。
    - 迭代器以 `AgentUnavailableError` 失败；`clock.pending() === 1`。
    - `advance(8000)` 后 `stdout.destroy` 恰 1 次，`exits` 长度 1。
- **G 守护**：Sibling surfaces 所列既有测试零改动全绿；`bash scripts/size-guard.sh` 与 knip 零新增。

## Review focus
- `#admitNow` 的临界区边界：从判定到登记之间只有对受害者 `retire` 的 await；`evicting` 排除；`busy` 谓词覆盖派发在途（claim 先于准入登记）。
- 名额释放的全部出口：onExit（有 pid）、`#retireSlot`（shutdown 之后，覆盖无 pid）、准入后发现 `#closed`。释放不重复计数：按身份幂等。onExit 只在不在回合中时调用 `#retireSlot`。
- `issue` 闸门位于 bump 之前，只拒绝已释放登记的 slot；`ReadmissionRequired` 只在复用分支回退一次。
- `ProcessPool` 的 `release`/`holds`/`touch` 对 `undefined` 登记为空操作，只用于 `#dispatchNew` 在准入 await 期间 slot 尚无登记的窗口。
