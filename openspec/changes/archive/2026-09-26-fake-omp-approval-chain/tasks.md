# Tasks: fake-omp-approval-chain（#470）

## 6. omp-test-harness — fake-omp

- [ ] 6.6 scenario `approval-chain-abort-ignored`：同 `approval`（仅 argv 含 `write` 时发 select）；第一条 select `r1` 被应答（任意值）后发该调用的 `tool_execution_end`（非 `Approve` 为 `isError`），再发第二个 bash `tool_execution_start` 与第二条 select `r2`；任何入站 `abort` 均不产生任何帧，进程存活到 stdin 关闭或收到信号（同 `abort-ignored`）。验证：新建契约测试（真实子进程）断言 `r1` 应答后的帧序列（`tool_execution_end` → `tool_execution_start` → `r2` select）、收到 abort 后无任何帧、stdin 关闭后退出

## 实现要点与必需证据

行号一律指 origin/master `1898c08` 的 `server/test/support/fake-omp.mjs`（626 行）。

### 状态表（仅 `gated`，即 scenario 为本场景且最后一个 `--approval-mode` 恰为 `write`）
入站帧经串行队列逐条处理（`:76-79`）；handler 发完帧后必须返回，不得 await 应答。

| 状态 | `prompt` | `extension_ui_response{id}` | `abort{id}` |
|---|---|---|---|
| `idle` | 同 `approval`：ack → `agent_start` → 3 段 delta → toolUse `message_end`（`content` 只有 C1 块）→ C1 start → `r1` select → `selecting` | 无帧 | 无帧，不记录 |
| `selecting`（`r1` 挂起） | 不属契约 | `r1`：删除该 id，发 C1 结束帧（Approve 为成功，否则为拒绝）→ C2 start → 登记 `r2` 并发 `r2` select，仍为 `selecting`。其它 id：无帧 | 无帧，**不写 `deferredAbort`** |
| `selecting`（`r2` 挂起） | 不属契约 | `r2`：删除该 id，发 C2 结束帧 → `pending`。其它 id（含已答的 `r1`）：无帧 | 无帧，不记录 |
| `pending`（`r2` 已答，永久挂起） | 不属契约（落入缺省路径，不断言） | 无帧 | 无帧 |

yolo（或不带 `write`）时：不门控，也不属 `abortable`（`:47`）。行为同 `normal`，abort 得到既有无 id 的 `unsupported`（`:187-192`）。

### 夹具实现（净增目标 15–30 行；`fake-omp.mjs` 硬上限 ≤740 行，#461 定的软上限；PR body 附 `wc -l`）
- `APPROVAL_SCENARIOS`（`:26`）加入 `"approval-chain-abort-ignored"`。于是 `gated`（`:46`）与 `abortable`（`:47`，`gated && scenario !== "approval"`）在 write 下都为真，abort 进入 `handleAbort`，不会落到 `unsupported`。`handlePrompt`（`:342-344`）的 `openSelects([CALL_1])` 原样适用。
- 把 `openSelects` 循环体（`:441-450`，登记 `pendingSelects` 并发 select）抽成共用的 `emitSelect(id, call)`，`openSelects` 与链式第二条都调用它，已有场景的输出逐字节不变。
- 链式第二条：`handleSelect`（`:456-468`）在本场景且刚答的是 `CALL_1` 时，发完 `toolEnd(CALL_1, approved)` 后依次 `emit(toolStart(CALL_2))`、`emitSelect("r2", CALL_2)` 并返回。`r2` 答完、`pendingSelects` 为空后进入 `settleSelects`（`:471-480`），走 `else` 分支置 `pending`：`deferredAbort` 恒为 undefined，`approval` 与 `approval-parallel` 两个条件对本场景都不成立。
- **陷阱（load-bearing）**：`handleAbort`（`:483-492`）先执行 `selecting` 分支 `deferredAbort ??= {id}`，`settleSelects` 又优先兑现 `deferredAbort`。本场景若只沿用 `scenario === "abort-ignored"` 的判断（`:488`，位于 `selecting` 分支之后），`r1` 挂起时到达的 abort 会在 `r1` 应答后被兑现成 aborted 三帧。所以本场景的忽略判断必须排在 `selecting` 分支**之前**，做法是只把 `:488` 的 `scenario === …` 这一个子句提到函数首行，并加入本场景；`|| abortTurn !== "pending"` 留在原处。若整句一起提前，`approval-then-abort`/`approval-parallel` 的延后 abort 会失效。对 `abort-ignored` 这是等价改写，因为它从不进入 `selecting`。漏掉这一点时，证据 3(a)–(c) 都在 `TAIL` 处变红：答完 `r2` 后会多出 aborted 三帧。证据 2 在 `r2` 答完后写 abort，守护另一种漏法，即 `pending` 态没有忽略本场景。
- 不装 SIGTERM 处理器；不加入 `:81`/`:93`/`:96` 的 hang 集合。stdin 关闭走既有 `queue.then(exit 0)`（`:87-90`）。
- 不改 `onLine` 的 `inbound` 记录点（`:164-166`），也不改 `fake-omp-proxy.mjs`。

### 帧形状（全部沿用 #458，钉在 omp v18.0.10 `33cc6b9a`；新测试文件自行定义同值常量，`fake-omp-approval.test.ts:31-78` 的常量未导出且不得改动）
- `C1 = {id:"tool-1", name:"bash", args:{command:"echo workbuddy-smoke"}}`；`C2 = {id:"tool-2", name:"bash", args:{command:"echo workbuddy-smoke-2"}}`。`toolCallId` 必须不同：归约器对已完成的 id 不再开步骤（`server/src/sessions/events.ts:162-167`）。
- toolUse 结束：`{type:"message_end", message:{role:"assistant", content:[{type:"toolCall", id:"tool-1", name:"bash", arguments:{command:"echo workbuddy-smoke"}}], stopReason:"toolUse"}}`。第二个调用前**没有**第二个 toolUse `message_end`（见 proposal 偏离）。
- start：`{type:"tool_execution_start", toolCallId, toolName:"bash", args}`。
- select：`{type:"extension_ui_request", id:"r1"|"r2", method:"select", title:"Allow tool: bash\nCommand: <args.command>", options:["Approve","Deny"]}`，恰这五个键。`r1` 的 title 是 `Allow tool: bash\nCommand: echo workbuddy-smoke`，`r2` 的是 `Allow tool: bash\nCommand: echo workbuddy-smoke-2`。
- 成功结束（仅 `frame.cancelled` 为假值且 `frame.value === "Approve"`）：`{type:"tool_execution_end", toolCallId, toolName:"bash", result:{content:[{type:"text",text:"workbuddy-smoke"}], details:{exitCode:0}}}`，不带 `isError` 键。C2 的成功输出也是 `workbuddy-smoke`。
- 拒绝结束（`Deny`、其它值、缺 value、`cancelled` 为真）：`{type:"tool_execution_end", toolCallId, toolName:"bash", result:{content:[{type:"text",text:"Tool call denied by user: bash"}], details:{}}, isError:true}`。

### 必需证据
新建 `server/test/fake-omp-approval-chain.test.ts`。只用 `fake-omp-helpers.ts` 的 `startFake`/`startPromptedSession`/`HANDSHAKE`/`PROMPT`/`response`/`isTextDelta`/`asRecord`/`closeSession`/`stopFakeChildren`，helper 不改。
- 约定：`CHAIN = "approval-chain-abort-ignored"`；`WRITE = ["--approval-mode","write"]`；`QUIET_MS = 300`；`ABORT = {type:"abort",id:"req_abort"}`；`afterEach(stopFakeChildren)`。
- 观察窗统一写成 `await expect(session.wait(() => session.frames.length > n, QUIET_MS)).rejects.toThrow(/timed out/)`。helper 超时报 `timed out`（`fake-omp-helpers.ts:127-129`），子进程退出报 `child exited before frame`（`:138-144`），所以一条断言同时证明「无帧」与「存活」。
- 「新增帧恰为 X」：先 `wait(() => frames.length >= n + k)`，再开观察窗，最后 `expect(frames.slice(n)).toEqual(X)`。
- `agent_start` 与 delta（`message_update`）帧的形状同 `fake-omp-approval.test.ts` 的 `delta()`。
- `PREFIX` 指 ack 之后的门控前缀：`agent_start`、`Hello `/`from `/`fake-omp` 三段 delta、toolUse `message_end`（C1 块）、C1 start、`r1` select。
- 「无收尾」断言：整个 `frames` 中没有 `agent_end`，没有 `command === "abort"` 的 response，没有 `stopReason` 为 `stop` 或 `aborted` 的 `message_end`。
- 请求 id 在进程内唯一：状态探针用 `state-2`。

1. Deny 链与 #474 形态（先红）
   - 输入：`startPromptedSession({scenario:CHAIN, extraArgs:WRITE})`。
   - 期望：
     - ack 之后恰为 `PREFIX`（逐帧 `toEqual`），随后观察窗无帧。
     - 写 `{type:"extension_ui_response",id:"r1",value:"Deny"}`，新增帧恰为 `[C1 拒绝结束, C2 start, r2 select]`，随后观察窗无帧。
     - 写 `ABORT`，观察窗无帧。
     - 写重复应答 `{type:"extension_ui_response",id:"r1",value:"Approve"}`，观察窗无帧。
     - 写 `{id:"state-2",type:"get_state"}`，得到 `response("state-2","get_state")`，证明队列未被阻塞。
     - 「无收尾」成立。此时 `r2` 仍挂起，与 #474 有界退回时的状态相同。
     - `closeStdin()`，`waitExit()` 为 `0`。
   - 为何先红：场景未实现时回落为 `normal`，没有 select，`PREFIX` 断言失败。
2. 应答组合（先红，`it.each` 三行：`[r1 应答, r2 应答]` = `[{value:"Approve"}, {value:"Deny"}]`、`[{cancelled:true}, {value:"Approve"}]`、`[{value:"approve"}, {cancelled:true,value:"Approve"}]`）
   - 期望：
     - `r1` 应答后新增帧恰为 `[C1 结束, C2 start, r2 select]`：第 1 行 C1 为成功结束，且 `"isError" in frame === false`；第 2、3 行为拒绝结束。随后观察窗无帧。
     - `r2` 应答后新增帧恰为一帧 C2 结束：第 1、3 行为拒绝，第 2 行为成功。随后观察窗无帧，回合挂起，不完成。
     - 再写 `ABORT`，观察窗无帧。「无收尾」成立。`closeStdin()` 后 `waitExit()` 为 `0`。
3. abort 的四个时机（先红，`it.each`）
   - 四行共用同一个结尾（记作 `TAIL`）：Deny `r2` → 新增帧恰为一帧 C2 拒绝结束 → 观察窗无帧 → 「无收尾」成立。只有 `r2` 答完后 `settleSelects` 才会执行，被错误记下的 `deferredAbort` 也只在这一步暴露，所以每一行都必须走到 `TAIL`。
   - (a) `r1` 挂起：`PREFIX` 之后写 `ABORT`，观察窗无帧；再 Deny `r1`，新增帧恰为 `[C1 拒绝结束, C2 start, r2 select]`（没有 aborted 三帧），随后观察窗无帧；然后 `TAIL`。
   - (b) `r1` 与 `r2` 之间：`PREFIX` 之后一次 `write([{type:"extension_ui_response",id:"r1",value:"Deny"}, ABORT])`，新增帧恰为同上三帧，随后观察窗无帧；然后 `TAIL`。
   - (c) `r2` 挂起：Deny `r1` 并等到 `r2` select，然后写 `ABORT`，观察窗无帧；然后 `TAIL`。
   - (d) idle：`startFake({scenario:CHAIN, extraArgs:WRITE})`，完成握手后写 `ABORT`，观察窗无帧；再写 `PROMPT`，得到 ack 与 `PREFIX`，门控未受影响；再 Deny `r1`，新增帧恰为同上三帧；然后 `TAIL`。
4. stdin 关闭后退出（先红，由证据 1、2 各自的末步覆盖）
   - 要求：进程处于挂起态（`r2` 挂起或已答）且已收到 abort 时，`closeStdin()` 后 `waitExit()` 为 `0`。helper 的 `EXIT_MS` 4s 上限（`fake-omp-helpers.ts:33`）同时证明不挂起。
5. SIGTERM 后退出（先红，另起一个实例）
   - 输入：按 `fake-omp-abort.test.ts:147-174` 先例，在文件内直接 `spawn(process.execPath, [FAKE, "--approval-mode", "write", "--scenario", CHAIN])`，不经 helper。
     - 用一个最小的本地 JSONL 读取器依次完成：等 `ready` → 写 `HANDSHAKE` → 等两条握手应答 → 写 `PROMPT` → 等 `r1` select → 写 Deny `r1` → 等 `r2` select → 写 `ABORT`。
     - 然后 `child.kill("SIGTERM")`。
   - 期望：`close` 事件为 `{code:null, signal:"SIGTERM"}`。这比先例的 `code !== null || signal === "SIGTERM"` 更严，因为本场景没有 SIGTERM 处理器。用例内以 `try/finally` 执行 `child.kill("SIGKILL")` 兜底。
   - 为何先红：场景未实现时没有 `r1` select，等待超时。
6. yolo 守卫（恒绿）
   - 输入：起三个进程：一个 `normal` 基线（不带 `--scenario`），两个变体：`startPromptedSession({scenario:CHAIN})`（helper 缺省 yolo，`fake-omp-helpers.ts:20-21`）与 `startPromptedSession({scenario:CHAIN, extraArgs:[...WRITE,"--approval-mode","yolo"]})`（验证取最后一次）。每个都等到终止 `agent_end`，再写 `ABORT`，等 `command === "abort"` 的应答。
   - 期望：两个变体的完整 `frames` 都与基线 `toEqual`，都不含 `extension_ui_request`，abort 都得到既有无 id 的 `{type:"response",command:"abort",success:false,error:"unsupported"}`。
   - 为何恒绿：未实现时未知场景本来就回落为 `normal`。

另外，既有 `fake-omp.test.ts`、`fake-omp-abort.test.ts`、`fake-omp-approval.test.ts`（守护 `openSelects` 抽取、`handleAbort` 改写与 `settleSelects` 的全部既有分支）、`fake-omp-branch.test.ts`、`fake-omp-frames.test.ts`、`fake-omp-slow-ready.test.ts`、`omp-*.test.ts`、`session-supervisor*.test.ts`、`server-startup-order.test.ts` 零改动全绿。必然变红的既有断言为 0。

### 后续消费者依赖的契约（4.6 #474）
- `r2` 与 `approval` 的 `r1` 同属识别形状，#460 的 `OmpProcess` 会上抛，#464 会登记第二条 pending 行。`r2` 在 stop 的 Deny `r1` 之后才出现，不在 stop 的 pending 快照里，留给有界退回结算。
- 回合永不发 `message_end`/`agent_end`。abort 永无应答，所以 grace 到期后走有界退回，`applyStop` 合成 `turn.end stopped`。
- 退回：`#runRetire`（`server/src/sessions/omp/runtime.ts:520-553`）先关 stdin，fake 立即 `exit(0)`，在 `TERM_GRACE_MS` 的第一段等待内结束，不需要 SIGTERM；SIGTERM 只是兜底。本场景不忽略 SIGTERM，所以 #474 测不到 SIGKILL 升级，那是 `hang-term` 的职责。
- 在 fake 这一侧，`r2` 由处理 `r1` 应答的 handler 同步发出，abort 在其后被处理。在宿主一侧，`r2` 的到达与 `abort` 的写出存在竞态，所以 #474 不断言两者的先后（issue 原文如此）。
- 每个进程只演一次门控回合，所以一个用例用一个进程。`session-supervisor-helpers.ts` 不做 yolo→write 替换（carry-forward #460），#474 须自带 spawnImpl，并追加 `--approval-mode write --scenario approval-chain-abort-ignored`。
- probe `frames=` 对宿主不可达：挂起期间 prompt 得 SessionBusyError，退回后进程已不在。需要计数 abort 帧时，按 carry-forward #561 拦截子进程 stdin。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 串行队列下 handler 必须返回；abort 与 `r1`/`r2` 应答的四种相对时机；`r2` 在 `r1` 应答内同步发出 → 证据 1（`state-2` 证明队列未阻塞）、3(a)–(d) |
| Legacy compatibility / examples | yes | 改动共用的 `handleAbort`/`openSelects`/`handleSelect`/`APPROVAL_SCENARIOS` → 证据 6 + 既有 `fake-omp-approval.test.ts`/`fake-omp-abort.test.ts`/`fake-omp-slow-ready.test.ts` 等零改动全绿 |
| Schema / columns / units / field names | yes | select、C1/C2 结束帧、toolUse 块沿用 #458 已钉的 omp 源码形状；第二个 `toolCallId` 与 select id 不同 → 证据 1、2 的 `toEqual` 精确帧 |
| Error handling / rollback / partial outputs | yes | abort 在任何状态都不得产生帧或被延后兑现；重复或未知应答无帧；挂起态仍可被 stdin 关闭或 SIGTERM 终止 → 证据 1、3、4、5 |
| Public API / CLI / script entry | no | 只新增一个 `--scenario` 取值；`--approval-mode` 解析沿用 #458，不改 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | 不涉；CI `uid-isolation` 只用 `hang-term`/probe，不受影响 |
| Resource limits / large input / discovery | no | 观察窗固定 300ms；最长用例（证据 1）约 4 个观察窗，低于 vitest 缺省 5s |
| Release / packaging / dependency compatibility | no | 零依赖脚本，不新增模块 |
| Documentation / migration notes | no | 契约写在 spec 与夹具注释里 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs` 与新建 `server/test/fake-omp-approval-chain.test.ts`；既有测试与 `fake-omp-helpers.ts` 零改动。
- [ ] 正向断言先红后绿：场景未实现时 fake 以缺省 `normal` 运行，没有 select，证据 1–5 失败即为红；证据 6 为恒绿守卫。PR body 记录 RED 与 GREEN 的输出。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（jscpd 当前全局 0.39%，≤3%；克隆数目标守住基线 35：帧常量用小工厂函数生成，如 `select(id, call)`、`start(call)`、`end(call, approved)`，不逐字照抄 `fake-omp-approval.test.ts:31-78`；证据 3(d) 的握手换一种写法；证据 5 的 SIGTERM spawn 骨架若无法避免克隆，预先允许。PR body 记录克隆数，每个新增克隆写明原因）、`bash scripts/size-guard.sh` 退出 0；`wc -l server/test/support/fake-omp.mjs` ≤740；`openspec validate fake-omp-approval-chain --strict --no-interactive` 通过。
