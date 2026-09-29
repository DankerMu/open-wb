# Tasks: infra-fault-approval-deny（#619）

## 1. 实现

- [ ] 1.1 `ApprovalRegistry.abandon(slot)`（design「Must add/change」）。
- [ ] 1.2 `#retireSlot` 在 `slot.infraFaulted` 为真时调用它，并保留返回的错误。

## 2. 测试

- [ ] 2.1 新建 `server/test/session-approvals-infra-fault.test.ts`，含 F1(a)、F1(b)、F2、F3、F4，复用 `session-approval-helpers.ts` 与 `session-supervisor-helpers.ts`（不改 helper；需要的新 helper 放在新文件里）。
- [ ] 2.2 红：F1、F2、F3 在 master 上为红；变异（去掉 infraFaulted 条件）的结果写入报告。
- [ ] 2.3 既有 R15、R16a、R16b、R18、`session-settlement*`、`session-stop*` 全绿；如有期望改动，只允许加强断言并逐条列出。

## 3. 验证

- [ ] 3.1 `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 全部退出 0；`wc -l server/src/sessions/{supervisor,approvals}.ts` 记入报告（supervisor ≤798）。
- [ ] 3.2 `openspec validate infra-fault-approval-deny --strict --no-interactive` 通过。
- [ ] 3.3（编排者）归档 PR：定点同步父 change `s1c-turn-control-governance` 的 tool-approval delta 中同名需求。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Error handling / rollback / partial outputs | yes | infra 故障后的审批结算；结算自身失败时不留计时器 → F1、F2、F4 |
| Concurrency / shared state / ordering | yes | 与 `#expire`、`decide`、`settled()` 的竞争只由 CAS 裁决；同步段位置 → F1–F3、review focus 3、4 |
| Schema / columns / units / field names | yes | `decision` 取值（deny，不是 timeout）与审计 `detail.decision` → F1、F2 |
| Legacy compatibility / examples | yes | 非 infra retire 与六条既有路径不变 → 既有测试全绿、变异 |
| Documentation / migration notes | yes | tool-approval spec 结算路径由六条增为七条，父 change A 同步 → delta、3.3 |
| Public API / CLI / script entry | no | 没有新的公开接口（`abandon` 仅供 supervisor 内部使用；knip 零新增） |
| Config / project setup | no | 无配置 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Auth / permissions / secrets | no | REST 鉴权不变 |
| Resource limits / large input / discovery | no | 名额释放路径不变（F4 守护） |
| Release / packaging / dependency compatibility | no | 无依赖变化 |

## 通用纪律

- [ ] 源码边界：只改 `server/src/sessions/approvals.ts` 与 `supervisor.ts`（一处接线）；`store*.ts`、`turn-control.ts`、`omp/`、web、fake-omp 零 diff。确需改动时先停下上报。
- [ ] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
