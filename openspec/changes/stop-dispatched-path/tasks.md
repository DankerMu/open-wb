# Tasks: stop-dispatched-path（#473）

## 4. omp-pool / turn-control / tool-approval — supervisor（父 tasks 4.2a 原文）

- [ ] 4.2a `turn-control.ts` 停止（已派发路径）：`stop(sessionId)` 在其调用期间持有该会话控制占用。该回合 `prompt` 帧已写出时，经 4.3 的作答结算以 `deny` 结算该回合**全部** pending 审批（以进入 stop 时读取的快照为准，写 `abort` 前不重读），每条次序为「落库+审计（同一事务）→ 发 `Deny` 帧 → 发布 `approval.resolved`」，再 `abort`，回合经普通归约路径（`message_end aborted` → `agent_end` → `turn.end stopped`）结束；`OMP_ABORT_GRACE_MS`=8000 内 `agent_end` 未到 → 既有 retire 路径 + `applyStop` 合成 `turn.end stopped`（不发 `error`；`applyStop` 只用于此有界退回，每个回合恰一条路径发出 `turn.end`）。runtime `abort(): Promise<response> | false` 返回 `false`（`prompt` 帧尚未写出）时的停止意图归 4.2b：本刀在该分支不登记意图、不写帧、直接返回，且在 4.2b 合入前 `stop` 无 REST 调用方（5.1a 依赖 4.2b）。验证（新建测试文件，fake-omp；本 task 不断言审批 `decision`/审计，那些归 4.3/4.6，这里只断言帧序与 `turn.end stopped`）：`abort-ok` 用例（恰一个 `turn.end stopped`、助手与会话 `stopped`、后续 prompt 在同一进程完成）；`abort-ignored` 用例（可注入时钟越过 grace → 有界退回，`applyStop` 恰一个 `turn.end stopped` 且无 `error`）；`approval-then-abort`/`approval-parallel` 各一用例（回合结束后 probe `frames=` 断言所有 `extension_ui_response` 先于 `abort`，最终 `turn.end stopped`）；「二次 stop 只发一帧」（重复 stop 只一个 `abort`）；「对账不触碰 stopped」（`reconcileOnStartup` 后 stopped 行不变）；「持久化失败不发布」（stopped 结算事务失败时 ring 无 `turn.end`）
  - 本 fixture 的裁定（见 proposal「偏离与决定」）：「持有该会话控制占用」不在本刀交付（偏离 2，已移交 #465，见其 issue 正文「In Scope 补充（自 #473 移交，2026-09-27）」）；快照经 `approvals.ts` 只读访问器取得（偏离 1）；「二次 stop 只发一帧」以 stdin 拦截计帧（偏离 5）。
- [ ] （本 fixture 追加，见 proposal 偏离 3、4、8）Deny 结算失败时 stop 以原错误拒绝、不写 `abort`、清除在途标记；第二次 stop 返回首次的同一 Promise，grace 只布一次；关停后 stop 拒绝 `agent_unavailable`。验证：design S5a、S5b、S8、S8b、S9

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | Deny 先于 `abort` 的帧序、快照不重读、二次 stop 去重、grace 与 `agent_end` 竞争、每回合恰一个 `turn.end`、快照后被并发作答的审批跳过 → S1–S5b、S8b；变异表 |
| Error handling / rollback / partial outputs | yes | `stopped` 结算失败不发布、Deny 失败不写 `abort`、abort Promise 拒绝被 catch、退回不发 `error`、CAS 未命中不使 stop 失败 → S2、S7、S8、S8b；`not_found` 跳过不可达，只经代码审查（design Non-goals） |
| Public API / CLI / script entry | yes | 新公开端口 `SessionSupervisor.stop(sessionId)`：resolve 即 `abort` 已写出、不等 `agent_end`；关停后拒绝 → S1、S9；knip 零新增 |
| Resource limits / large input / discovery | yes | 有界退回 retire 后释放名额，正常收尾不误 retire 进程 → S1（`advance(8000)` 后存活）、S2（`liveProcessCount()===0`） |
| Legacy compatibility / examples | yes | 非停止回合的失败路径（`applyFailure`）、审批作答结算与对账行为不变；web 依赖「中断不发 error」→ Sibling surfaces 既有测试零 diff 全绿、S6 |
| Schema / columns / units / field names | no | 无 schema/事件形状变化；`stopped` 枚举与 `turn.end` 形状已由 #449/#455 交付 |
| Config / project setup | no | `OMP_ABORT_GRACE_MS` 是内部常量，不做配置 |
| File IO / path safety / overwrite | no | 不涉文件（probe 写入路径是 fake 的既有能力） |
| Auth / permissions / secrets | no | 本刀无 REST（鉴权归 #475）；Deny 经既有 `decide` 的会话归属校验 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；`docs/architecture/system.md` 归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/turn-control.ts`、`supervisor.ts`（只接线）、`approvals.ts`（只读访问器，proposal 偏离 1）；`rest.ts`、`store*.ts`、`events.ts`、`pool.ts`、`index.ts`、`omp/`、`app.ts`、`core/`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] `turn-control.ts` 对 `./supervisor.js` 只有 `import type`（或无导入），不经 `sessions/index.ts` 导出；`OMP_ABORT_GRACE_MS` 不导出；grace 与 retire 回调同步、不抛；abort Promise 在返回同一同步段内挂 catch。
- [ ] 新测试只写进新建文件：`server/test/session-stop.test.ts`（S1–S6）、`session-stop-faults.test.ts`（S7–S9，含 S8b）、helper `session-stop-helpers.ts`，各 ≤800 行；审批用例经 `openApprovalWorld`（内含 `gateApprovals` 的 argv `write` 注入）+ `rt.setScenario`，不改 `session-supervisor-helpers.ts`/`session-approval-helpers.ts`；不 import `turn-control.ts`/`approvals.ts`，不访问私有字段。
- [ ] 既有测试允许的改动：**无**。design「Sibling surfaces」所列既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：S1–S5b、S7–S9（含 S8b）在 master 上为红，S6 的对账断言是恒绿守护；design 变异表逐一临时施加并确认对应用例变红，失败输出记入 PR body。
- [ ] 实测 `wc -l server/src/sessions/{supervisor,turn-control,approvals}.ts` 与新测试文件并记入 PR body；`supervisor.ts` ≤780（硬上限 785）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`openspec validate stop-dispatched-path --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」，列出 proposal「偏离与决定」各条与 Open questions。
