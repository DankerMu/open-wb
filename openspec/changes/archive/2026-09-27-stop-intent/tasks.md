# Tasks: stop-intent（#490）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.2b 原文）

- [ ] 4.2b `turn-control.ts` 停止意图：若该回合 `prompt` 帧尚未写出（runtime 仍在获取/握手，`abort(): Promise<response> | false` 返回 `false`），`stop(sessionId)` 登记停止意图后返回；该回合 prompt 派发回执 resolve 后 supervisor 立即对同一 generation 调 `abort()`（意图路径的 `abort` 在 stop 调用返回后写出），此后即 4.2a 的已派发路径，回合经普通归约路径（`message_end aborted` → `agent_end` → `turn.end stopped`）结束，本分支不以 `applyStop` 合成；用户消息已进入 omp 历史，助手正文为 abort 前已到达的增量；获取/派发失败时走与无停止意图时完全相同的失败路径（既有 `rollbackPrompt` 补偿受理对、prompt 返回既有错误），停止意图随之丢弃；停止意图不改写其它路径已先达到的终态。验证（新建测试文件，fake-omp）：「`abort()` 返回 false 时按停止意图收尾」（fake `slow-ready`（6.5）打开获取窗口：派发前 stop → prompt 照常受理并返回原受理结果，随后 probe `frames=` 恰为 `negotiate_protocol,get_state,prompt,abort,prompt`，助手消息与会话最终 `stopped`、恰一个 `turn.end stopped`，probe 即同一进程上的后续 prompt 且正常完成）；获取失败分支用既有 `no-ready-hang` → 与无停止意图时完全相同：supervisor 以既有派发失败错误拒绝且无 `turn.end`、停止意图随之丢弃；受理对经 `rollbackPrompt` 删除与 prompt REST 的既有错误响应属 REST 层既有行为，由 5.1a 的 inject 用例覆盖
  - 本 fixture 的裁定（见 proposal「偏离与决定」）：意图按回合 id 登记（偏离 1）；「获取/握手」含准入、等上一进程退役与重新准入（偏离 2，#603 评审发现）；丢弃点在 `#prompt` 外层 catch（偏离 3）；兑现点在 pump 登记之后（偏离 4）；兑现直接 `abort`、不重读快照（偏离 5）。验证：design I1–I8、F1、F2。
- [ ] （本 fixture 追加，见 proposal 偏离 2、4、6）准入/等退役/重新准入窗口的 stop 登记意图；`setSessionFile` 失败时不写 `abort`；失败路径以对照世界证明等同，失败时意图确实丢弃；兑现后的回合正常完成或崩溃时终态不被改写。验证：design I2、I4–I8、F1、F2

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 四个派发前窗口的登记；兑现恰一次且在 prompt 帧之后、pump 登记之后；二次 stop 去重；意图跨重新准入存活；与回合正常完成/崩溃的竞争 → I1–I7、F2；变异表 |
| Error handling / rollback / partial outputs | yes | 获取失败与回执后派发失败都丢弃意图（同一回合再派发不写 `abort`）、失败路径与无意图时相同；兑现的 abort Promise 被 catch；不改写 `done`/`failed` → F1、F2、I8、I4、I5 |
| Public API / CLI / script entry | yes | `SessionSupervisor.stop(sessionId)` 语义扩展：派发前 resolve 即意图已登记；关停后仍拒绝 `agent_unavailable`（#473 S9 守护） → I1、I2；knip 零新增 |
| Resource limits / large input / discovery | yes | 驱逐与重新准入窗口的 stop 不改变准入/驱逐结果；grace 在正常完成时撤销、不误 retire → I4（`advance(8000)` 后存活）、I3（退回后名额释放）、I6、I7 |
| Legacy compatibility / examples | yes | #473 已派发路径与既有失败路径逐字不变 → Sibling surfaces 既有测试零 diff 全绿、F1/F2 对照 |
| Schema / columns / units / field names | no | 无 schema/事件形状变化 |
| Config / project setup | no | 无新配置；`OMP_ABORT_GRACE_MS` 仍为模块私有常量 |
| File IO / path safety / overwrite | no | 不涉文件（probe 写入是 fake 既有能力） |
| Auth / permissions / secrets | no | 本刀无 REST；stop 鉴权归 #475 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；文档归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/turn-control.ts` 与 `supervisor.ts`（只接线）；`rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`approvals.ts`、`index.ts`、`omp/`、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] `turn-control.ts` 对 `./supervisor.js` 只有 `import type` 或无导入，不经 `sessions/index.ts` 导出；兑现调用同步、不抛；abort Promise 在返回它的同一同步段内挂 catch；`TurnStops.#run` 与兑现都不引入真实 await。
- [ ] 新测试只写进新建文件：`server/test/session-stop-intent.test.ts`（I1–I5）、`session-stop-intent-windows.test.ts`（I6、I7、F1、F2、I8）、helper `session-stop-intent-helpers.ts`，各 ≤800 行；世界经 `openStopWorld` + `rt.setScenario` 或 `createRealFakeRuntime` + `openRecordingSession({...runtime, maxProcesses: 2})`；不改 `session-stop-helpers.ts`、`session-approval-helpers.ts`、`session-supervisor-helpers.ts`；不 import `turn-control.ts`，不访问私有字段。
- [ ] 既有测试允许的改动：**无**。design「Sibling surfaces」所列既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：I1–I7 在 master 上为红（`waitFor` 8s 截止或 `afterPrompt` 不含 `abort`），F1、F2、I8 与既有测试为恒绿守护；I1 的 helper 必须包 `spawnImpl` 追加 `--ready-delay-ms 2000`；`timersDueAt(T+8000)` 只在 `settle()`/`pump.finally` 之后读取（与 `SHUTDOWN_BUDGET_MS` 同为 8000，见 design「Required evidence」）；design 变异表逐一临时施加并确认对应用例变红，失败输出记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/{supervisor,turn-control}.ts` 与新测试文件并记入 PR body；`supervisor.ts` 目标 ≤786、硬上限 798，超出先停下上报（proposal Impact 预案需编排者认可）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate stop-intent --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：父 turn-control delta「停止生成 REST」逐字采纳本子 delta 的自写 Scenario「获取失败丢弃停止意图」「准入与前代退役等待期间停止」；父块保留 `202 {}`、regenerate 与控制占用片段的完整目标文本（仍为 MODIFIED，#475/#465 交付）。
