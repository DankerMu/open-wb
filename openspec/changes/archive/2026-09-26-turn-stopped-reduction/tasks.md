# Tasks: turn-stopped-reduction（#455）

## 3. 归约与 stopped 结算（父 tasks 3.1 原文）

- [ ] 3.1 `server/src/sessions/events.ts`：`message_end{stopReason:"aborted"}` 记为中断，终止 `agent_end` 发 `turn.end{status:"stopped"}` 且无 `error`；新增纯 `applyStop(state)`（有界退回用，恰一次）；`turn.end.status` 联合加 `stopped`；审批 `extension_ui_request` 不进归约。同 PR 把 `store.ts` `FinishStatus` 放宽为 `done|failed|stopped`，并实现 stopped 结算（`finishTurn(stopped)` 把仍 running 的步骤结算为 `stopped`，助手消息与会话为 `stopped`）；`supervisor.ts:689` 的 `turn.end` 穷举随之通过。验证：新建表驱动测试文件覆盖 aborted/error/正常三路与 `applyStop` 幂等；新建 store 测试证明 `finishTurn(stopped)` 三表落为 `stopped`、已 settled 步骤不变

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | `turn.end.status` 是 SSE 公共事件契约，`applyStop` 是新导出 → 归约表驱动用例 + `expectTypeOf` 三值联合 |
| Schema / columns / units / field names | yes | 三表 status 新值 `stopped`、stopped 步骤 output 为 NULL → store 用例逐列读回 + REST GET 读回 |
| Legacy compatibility / examples | yes | error/正常路径、过滤集、`close()` failed、既有测试不变 → error/done 守护用例 + 既有测试仅 design 所列一处改动全绿 |
| Concurrency / shared state / ordering | yes | 首个原因胜出、终态后静默、单事务结算 → 先 error 后 aborted/反之用例、终态后三类输入静默、TEMP TRIGGER 原子性用例 |
| Error handling / rollback / partial outputs | yes | 结算事务失败不留半态、rollback 恢复 `stopped` → TEMP TRIGGER 用例（快照不变、重试一次）+ rollback 用例 |
| Config / project setup | no | 无配置项 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Auth / permissions / secrets | no | REST 读回走既有 owner cookie，鉴权不变 |
| Resource limits / large input / discovery | no | 无新限额 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 文档归 9.1 #486；web 解析 `stopped` 归 7.1 #472（D6 次序见 design） |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进两个新建文件（建议 `server/test/session-events-stop.test.ts`、`server/test/session-store-stopped.test.ts`）；REST GET 读回用例放在 store 新文件内（`withSessionRest`），不新增第三个文件、不改 REST 源码。
- [ ] 既有测试唯一允许的改动：`server/test/session-events.test.ts:248` 期望值改为 `[{type:"turn.end",data:{messageId:MESSAGE_ID,status:"stopped"}}]`，`:241` 标题改写为新语义；不删断言、不改 helper（`session-store-helpers.ts` 的 seed 联合不加 `stopped`）。其余既有测试零改动全绿。
- [ ] 源码边界：`events.ts` + `store.ts`；`supervisor.ts`、`store-approvals.ts`、`store-branch.ts`、`rest.ts`、web 零 diff；`finishStep` 参数类型保持 `"done"|"failed"`。
- [ ] 红/绿：按 design「Required evidence」R/G 标注执行——运行时 R 项在未改 `events.ts` 时 vitest 失败；typecheck R 项在未改类型时 `make typecheck` 失败（记录输出）；G 项注明恒绿。另记录「只改 `events.ts`」时 `supervisor.ts:691` 的 typecheck 错误作为原子性证据。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate turn-stopped-reduction --strict --no-interactive` 通过。
