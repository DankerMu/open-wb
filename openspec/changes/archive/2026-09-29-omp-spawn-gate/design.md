# Design: omp-spawn-gate（#652）

Change surface:
- 新模块 `server/src/sessions/omp/spawn-gate.ts`：`SpawnGate`。
- `SessionRuntime.#acquire`（`runtime.ts:347-403`）与 `shutdown()`（`:193-206`）；`SessionRuntimeOpts` 增 `spawnGate?`、`log?`。
- `sessionRuntimeOpts`（`pool.ts:180-203`）；`SessionSupervisor` 构造；`SessionSupervisorRuntime` 增 `spawnConcurrency?`；`SessionSupervisorOptions` 增 `log?`。
- `registerSessions`（`sessions/index.ts`）、`createApp` assembly（`app.ts:77/137-156`）透传 `log`。
- `agent-config.ts` 新键；`server.ts` 新增导出纯函数 `appAssemblyOf(config)`，main 路径改为调用它。

Must preserve:
- 池语义（omp-pool 全部既有需求）：准入先于 spawn；名额在 `admit` 登记时占用，排队中的 runtime 照常占名额；驱逐、`agent_capacity`、退出即释放不变。队列深度因此 ≤ `OMP_MAX_PROCESSES`。排队中的 prompt 持有 `claimedAssistantId`、排队中的 command 受 `controls.held` 覆盖，两者都被池判为 busy（`pool.ts:69-71,151`），不会被驱逐。
- 未注入 `spawnGate` 的 `SessionRuntime`（直接构造它的既有单测）行为逐字不变。
- 握手本身（ready → negotiate v2 → get_state）、10000ms 缺省、失败时终止子进程的路径不变。deadline 本来就在 `spawnOmp` resolve 之后起算（`process.ts:276-281`）；排队放在 `OmpProcess` 之外，自然不计入。
- 停止意图与「延迟握手期间停止」：从调用方看，排队等于更慢的握手、deadline 冻结；既有 stop-intent 场景与 `session-stop*` 语义不变。
- `onError` 语义（`#retain` 与 `throwCollected`）不变：日志端口不经 `onError`，否则每次握手超时都会让关停失败。
- import `server.ts` 仍零副作用（`server-entry-silent.test.ts`）。

Must add/change:
1. `SpawnGate`（≤80 行）：`constructor(limit)`；`acquire(): { granted: Promise<() => void>; cancel(): void }`。有空闲许可时 `granted` 立即兑现，否则 FIFO 排队；兑现值为幂等 `release()`，归还后交给队首。排队中 `cancel()` 移出队列并以 `AgentUnavailableError("runtime shutdown")` 拒绝 `granted`；已兑现后 `cancel()` 为空操作。不设排队超时、不设 `close()`（排队者都属于某个 runtime，由其 `shutdown()` 取消）。
2. `SessionRuntime`：
   - `#acquire`：`closed` 检查之后、`#nextGen` 自增与 token 签发之前，若有 `spawnGate` 则 `acquire()`、把 `cancel` 记在 runtime 上并 `await granted`。
   - **许可在取得之后的每条退出路径上都归还**：`try/finally` 覆盖从 grant 到 `boot` 结算的整段——含复查 `closed`、`tokens.issue` 抛错（`ReadmissionRequired`、store/token 故障、fork 临时进程不可重获取，`pool.ts:215/221/235/267`）、`new OmpProcess`/`proc.start()` 同步抛错，以及 `boot` resolve 或 reject。归还发生在 `boot` 结算时，不等 `#retire` 完成（否则失败的启动会在 TERM_GRACE + KILL_GRACE 期间占住许可）：`runtime.ts:390-393`（启动成功后复查 closed）与 `:398-401`（catch）两条路径上，许可都 SHALL 在 `await this.#retire(gen)` 之前归还。
   - `shutdown()`：同步调用当前排队的 `cancel()`（若有），再走既有流程。排队期间尚无 generation，`shutdown()` 立即返回 `#retired`（`runtime.ts:201-204`）；被取消的 `#acquire` 以 `runtime shutdown` 拒绝，从未调用 `spawnImpl`。
   - 握手超时日志：`#acquire` 的 catch 入口、`await this.#retire(gen)` 之前，若错误是 `AgentUnavailableError` 且 `message === "handshake timeout"`，调用 `log?.({ event: "omp_handshake_timeout", sessionId, reason: "handshake timeout", elapsedMs })`。`elapsedMs` 取 `performance.now()` 之差（与握手 deadline 的裸 `setTimeout` 同一真实时间源，不取注入时钟），起点为进入 `#acquire`（含排队），终点为进入该 catch（不含退役耗时），取整。`log` 抛出或返回 thenable 均吞掉，原错误照常传播。其它启动失败不记录。
   - 行数：`runtime.ts` 现为 788 行（上限 798）。放不下时把一个与本改动无关的纯 helper 搬到既有邻近模块（#650 搬 argv 的先例），不得把 gate 逻辑挪进 `OmpProcess`。
3. supervisor 构造时 `new SpawnGate(options.runtime.spawnConcurrency ?? availableParallelism())`，与 `log`（缺省空操作）放进一个 supervisor 持有的共享对象，经 `sessionRuntimeOpts` 交给会话 slot（`supervisor.ts:418`）与 fork 临时 runtime（`branching.ts:257`），两处共用同一 gate 实例。gate 对象不进 `SessionSupervisorRuntime`（那是配置）。
4. 配置：`OMP_SPAWN_CONCURRENCY`，`resolvePositiveInteger` 同一纪律；缺省 `os.availableParallelism()`。`AgentSettings.ompSpawnConcurrency` → `sessionRuntimeOf` → `SessionSupervisorRuntime.spawnConcurrency`。
5. 日志接线：`SessionSupervisorOptions.log?`、`RegisterSessionsOptions.log?`、`AssemblyDependencies.log?` 逐层透传（缺省丢弃）。`server.ts` 新增导出纯函数 `appAssemblyOf(config)`，返回 main 路径传给 `createApp` 的完整 assembly（`runtime`、可选 `upstream`、`log`）；main 路径 SHALL 以 `assembly: appAssemblyOf(config)` 调用。`log` 把记录序列化为一行 JSON，经 `writeManagedLine(process.stderr, …)` 写出，写失败吞掉（与 `emitStderrRecord` 同一纪律）。构造 assembly 本身不写任何输出。记录恰为四个键；会话 id 是已出现在 URL 中的公开标识，不属于 spec 禁止写入输出流的 session 凭据值。

Governing invariant: 任一时刻，已取得许可而许可尚未归还的 acquisition 数 ≤ gate limit；每个许可在其 acquisition 的任一退出路径上恰归还一次；每个排队者最终要么取得许可，要么因其 runtime 关停被取消，且被取消者从未 spawn；握手 deadline 只覆盖子进程 spawn 之后的握手。

最坏排队时间：队列深度 ≤ `OMP_MAX_PROCESSES`，每个持有者最多占用一次握手 deadline，因此排队 ≤ `ceil(cap / K) × handshakeTimeoutMs`（缺省 cap=16、4 vCPU 时 K=4，最多 4 批；实测 K=4 最慢 ready 约 2.0s）。有这个上界，排队超时是 YAGNI。

Sibling surfaces:
- 全部 acquisition 都经 `#readyGeneration` → `#acquire`（唯一调用点 `runtime.ts:331`；`proc.start()` 唯一一处 `:361`）：prompt、command（regenerate/fork 的 `get_branch_messages`/`branch`/`get_state`）、pid-less spawn 失败后的下一次获取。
- fork 临时 runtime：同一 gate；`stopQuietly(temp)` 调 `shutdown()` 取消其排队。supervisor `shutdown()` 先 `#forks.close()`（`branching.ts:208`）再 shutdown 各 slot，关停不因排队挂起。
- `#translate`（`supervisor.ts:740`）会丢掉原因，所以日志必须在 runtime 里发；`sanitizeError`（`runtime.ts:779`）保留原消息。
- 缺省 limit 随宿主 CPU 数：既有 supervisor 测试若在同一时刻持有超过 CPU 数个握手，会被串行化而变慢，但不改变结果；实现者如发现既有测试因此超时，停下上报，不要改既有 helper 的缺省。

Seams under test: `SpawnGate` 单元；`SessionSupervisor` + 真实 fake-omp 子进程（`slow-ready`、`no-ready`、`no-ready-hang`）+ 包装 `spawnImpl` 记录 spawn/ready 时刻 + 注入时钟（仅用于控制退役 grace）；`createApp`/REST 的 502；`server.ts` 的 `appAssemblyOf` 与 `resolveServerConfig`；`agent-config` 纯解析器。

Required evidence（新测试；`D`、`H` 为毫秒）:
- G1 `SpawnGate`：limit=2 时第三个排队；`release` FIFO 交给队首且幂等；排队中 `cancel` → `granted` 以 `runtime shutdown` 拒绝且不占许可；已兑现后 `cancel` 为空操作。
- G2 上限：`spawnConcurrency=1`、`maxProcesses=3`，fake `slow-ready`（`D=300`）三会话同时 prompt：「已 spawn 未 ready」并发峰值 = 1；三个 prompt 都返回 202（握手成功、prompt 已派发）。`slow-ready` 的首个回合挂起到 abort 为止（`fake-omp.mjs:34-35`），所以随后对三个会话 stop，回合以 `stopped` 收尾。master 上峰值 = 3 → 红。
- G3 排队不计入 deadline：`spawnConcurrency=1`、`handshakeTimeoutMs=H=1500`、`slow-ready D=600`，三会话同时 prompt。断言：三个 prompt 都返回 202（随后 stop 收尾，同 G2）；第 2、3 个的 spawn 时刻分别不早于第 1、2 个的 ready 时刻；第 3 个从 prompt 到 ready 的总耗时 > H。每次握手约为 node 启动 + D（本机约 0.8s），距 H 有约 0.7s 余量。master 上无串行 → 次序断言红。
- G4 关停取消排队，两层：
  - G4a（supervisor 行为）：`spawnConcurrency=1`，A 为 `no-ready-hang` 正在握手，B 排队；`supervisor.shutdown()` → B 的 prompt 以 502 `agent_unavailable` 结束，`spawnImpl` 调用次数只计 A，关停完成。
  - G4b（变异判别，runtime 层）：两个 `SessionRuntime` 共用一个 `SpawnGate(1)`，A 为 `no-ready-hang` 且握手 deadline 取缺省 10000ms（或不小于测试等待时长），B 排队；只对 B 调 `shutdown()`。断言在 A 仍持有许可时（A 的 boot 尚未结算、未推进任何时钟）B 的请求已以 `runtime shutdown` 拒绝、B 从未 spawn、B 的 `shutdown()` 已 resolve。去掉 `cancel` 的变异下 B 要等 A 的 boot 结算，断言时点不成立 → 红（不靠测试超时）。
- G5 失败即归还：`spawnConcurrency=1`、`handshakeTimeoutMs` 小，A 为 `no-ready`，B 排队。握手超时后 `#failStartup` 会 SIGKILL A（`process.ts:663-691`），A 真实退出，`waitNative` 立即返回，所以单靠注入时钟卡不住 A 的退役。测试用 `spawnImpl` 包装器扣住 A 子进程的 `exit`/`close` 事件，等测试放行才转发（包装器放在新测试文件里），并注入时钟，使 A 的 `#retire` 停在 grace 等待中。断言：A 的退役尚未完成时 B 已 spawn、B 的 prompt 返回 202；随后放行事件、推进时钟，A 退役完成。变异：把任一条路径上的 `release` 挪到 `await this.#retire(gen)` 之后 → 红。
- G6 fork 共用许可：`spawnConcurrency=1`，一个会话正在慢握手时 fork 另一会话 → fork 临时进程的 spawn 不早于前者 ready；两者都成功。
- G7 许可不泄漏：`spawnConcurrency=1`，让 A 在取得许可后 `tokens.issue` 抛错（例如注入一个会抛错的 tokens 端口，或用 fork 临时进程已 spawn 过后的不可重获取路径），断言排队中的 B 仍能 spawn 并完成。
- L1 握手超时日志（系统时钟，不注入）：fake `no-ready`、`handshakeTimeoutMs` 小，REST prompt → 502 `agent_unavailable`；`log` 恰收到一条记录，键集合恰为四个，`sessionId` 为该会话 id，`elapsedMs ≥ handshakeTimeoutMs`。ENOENT 启动失败不产生记录；`log` 抛出时 502 照旧、无未处理异常。
- L2 生产接线：`appAssemblyOf(resolveServerConfig(env, entry))` 的 `runtime` 等于 `sessionRuntimeOf(config)`，且含 `log`；调用该 `log(record)` 时 stderr spy 恰见一行 LF 结尾 JSON、键集合恰为四个；构造 assembly 本身零输出；import `server.ts` 仍零输出。
- C1 配置：仿 `omp-max-processes-config.test.ts`：缺省 = `availableParallelism()`（测试现算）；`1`、`2`、`2147483647` 生效；非法值（空串、`0`、`abc`、`-1`、`1.5`、`+3`、`016`、` 8`、`2147483648`）启动失败、stderr 恰一行 generic failure、错误只命名键；`sessionRuntimeOf` 透传。
- 红：G2、G3、G4、L1、L2、C1 在 master 上为红。变异：`release` 挪到 `#retire` 完成之后 → G5 红；去掉 `shutdown()` 的 `cancel` → G4b 红；去掉 grant→boot 段的 `finally`（只在 boot 结算时归还）→ G7 红。
- 编排者另做：测试 VPS（4 vCPU / 7.4Gi）官方 omp v18.0.10 linux-x64（SHA256 校验）+ 编译产物，缺省配置冷态 16 会话并发 prompt 多轮无握手超时 502；同机 master 对照复现。PR 与任何被跟踪文件不写该机地址或用户名。

Review focus:
1. 许可在 grant 之后的每条退出路径上恰归还一次，且在 boot 结算时归还、不等退役。
2. `shutdown()` 同步取消排队；被取消者从未 spawn；supervisor 关停与 fork 临时进程停止都不会挂在排队上。
3. 日志只在 runtime 的 catch 内、`handshake timeout` 时发；`log` 失败不改变 502；不经 `onError`。
4. 会话 slot 与 fork 临时进程共用同一 gate 实例；未注入 gate 的 runtime 行为不变。
5. `appAssemblyOf` 被 main 路径真实使用，import 仍零副作用。

Non-goals:
- 握手超时可配置或按在途数放大（选项 B）。
- `OMP_MAX_PROCESSES` 缺省值、驱逐算法、omp 启动性能、首次冷启动 natives 解压的内存峰值预热。
- 其它启动失败与一般会话故障的日志（`observeSessionFault` 在生产为空操作是独立缺陷，见 #664）。

Open Questions: 无。
