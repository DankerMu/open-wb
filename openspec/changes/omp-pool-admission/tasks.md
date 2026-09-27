# Tasks: omp-pool-admission（#463）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.1 原文）

- [ ] 4.1 `pool.ts` 池治理：`#liveProcesses` 登记（最近活动时刻、是否回合中、是否持有控制占用）、`#admitProcess()` 串行临界区（`live<cap` 放行；`==cap` 驱逐"非回合中且不持有控制占用且最近活动时刻最早"者并等待其 shutdown；无可驱逐抛 `agent_capacity`）、`onExit` 回调删 slot（修复泄漏）、准入后 spawn/握手失败且无 pid 时由准入方同步释放名额。验证（新建测试文件，fake-omp，cap=1/2）：「上限恒成立」（任意时刻活进程数 ≤cap）、「并发准入不越界」（并发 N 个 prompt 活进程数 ≤cap）、「驱逐中的进程不重复选中」、「崩溃与关停释放」名额、「无 pid 启动失败由准入方同步释放」（cap=1 连续两次 ENOENT 后第三次有效 bin → 202）；第三个会话触发驱逐、全忙 503、被驱逐会话下次 prompt 以 `--resume` 起、空闲回收后 `#slots` 不含该会话
- [ ] （本 fixture 追加，非父 tasks 原文，见 proposal「偏离与决定」6）tokens 适配器 `issue` 拒绝已释放登记的 slot，复用分支回退一次新准入；验证：design E6
- [ ] （carry-forward #573 追加，见 proposal「偏离与决定」5）onExit 内 `runtime.shutdown()` 的 runtime 级守护；验证：design E7(a)(b)

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `SessionSupervisor` 新增只读 `liveProcessCount()`；prompt 端口新增 503 结果；`agent-config.ts` 新增导出 → A1/A2/A6、E2/E4；knip 零新增 |
| Config / project setup | yes | `maxProcesses` 缺省语义（undefined → `DEFAULT_OMP_MAX_PROCESSES`=16，同一常量）→ 既有测试（均不传 cap）零改动全绿；`omp-max-processes-config.test.ts` 零 diff |
| Concurrency / shared state / ordering | yes | 准入临界区串行、驱逐等待期间第二次准入、onExit 在子进程 exit 监听内运行（真实进程 stdin 已被 Node 销毁）、复用派发与空闲 retire 竞速 → A1、A2、A8、E3b、E6、E7；守护 `stream.test.ts:73/:184`、`faults.test.ts:311` |
| Resource limits / large input / discovery | yes | 本刀核心：活进程数 ≤ cap，驱逐最久空闲者，退出即释放名额 → A1–A8、E1–E6，`liveAtSpawn` 真实子进程采样 |
| Legacy compatibility / examples | yes | 缺省 16 下既有行为不变；空闲后 `--resume`、epoch+1、游标封口语义不变 → Sibling surfaces 全部零 diff，重点守护 `session-supervisor.test.ts:57/:215/:271`、`stream.test.ts:73/:142/:184` |
| Error handling / rollback / partial outputs | yes | `agent_capacity` 无持久化副作用（`rollbackPrompt` 补偿，无 bump、token、spawn）；无 pid 失败由准入方释放；关停后集合为空 → A6（行与会话逐字不变）、E2、E4 |
| Auth / permissions / secrets | no | token 签发与撤销次序不变（闸门早于 `issue` 内签发）；不涉鉴权 |
| Schema / columns / units / field names | no | 无 schema、DTO 或事件形状变化；503 信封由 #450 定义 |
| File IO / path safety / overwrite | no | 不涉文件；`omp_session_file` 只读用于 `--resume` |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | `docs/architecture/system.md` sessions 行归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/pool.ts`、`supervisor.ts`，以及 `agent-config.ts` 的一个 `export`（偏离 7）。`omp/`、`rest.ts`、`store*.ts`、`events.ts`、`turn-control.ts`、`index.ts`、`app.ts`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] 登记表、临界区、选受害者在 `pool.ts`（class + 类型）；`supervisor.ts` 只接线，不以 `#private` 成员实现池逻辑；`pool.ts` 不值导入 `./supervisor.js`；不经 `sessions/index.ts` 导出。
- [ ] onExit 回调同步、不抛、不写 stdin、不调 `respondApproval`；只做「释放名额 + 不在回合中时 `void #retireSlot`」。
- [ ] 新测试只写进新建文件 `server/test/session-supervisor-pool.test.ts`、`server/test/session-supervisor-pool-exit.test.ts`，各 ≤800 行；E 组文件超 800 行时，允许把 runtime 级的 E7 移到第三个新建文件（如 `server/test/omp-runtime-exit-shutdown.test.ts`）。不 import `src/sessions/pool.ts`，不访问私有字段。
- [ ] 既有测试允许的改动**只有**：`server/test/session-supervisor-helpers.ts` 的 `RuntimeOptions` 加 `maxProcesses?: number`（纯类型）。design「Sibling surfaces」所列既有测试零 diff 全绿。
- [ ] 红/绿：A1–A8、E1–E6（含 E3b 的名额断言）在去掉对应机制时失败（缺 `liveProcessCount`、无上限、无闸门），记录失败输出；E7、E3b 的无故障断言与既有守护恒绿；M 项（选择键改 `seq` → A4；去掉 `#tail` 串行 → A8/A1；删 onExit release → E5；删 `#retireSlot` release → E2 第二次即 503；删 `issue` 闸门 → E6）逐一临时变异，确认对应用例变红，结果记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/pool.ts server/src/sessions/supervisor.ts <两个新测试文件>`，与 proposal Impact 对照，记入 PR body（`supervisor.ts` 起点 658）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate omp-pool-admission --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
