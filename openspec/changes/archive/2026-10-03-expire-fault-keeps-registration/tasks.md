# Tasks: expire-fault-keeps-registration（#662）

Fixture level: compact

## 1. 实现
- [x] 1.1 `approvals.ts` `#expire`：非 `not_found` 的事务失败不再 `registrations.delete`，直接进 `#fault`；JSDoc 同步（「drops the registration」不再成立）。先核对 `#fault` 在该路径上必然同步到达 `abandon(slot)`（`supervisor.ts` 的 fault sink → `#retireSlot`）；若存在到不了 `abandon` 的分支（例如 slot 已退役），停下报告，不要自行加兜底删除。
- [x] 1.2 F2（`session-approvals-infra-fault.test.ts`）：触发器只阻断 r1 的 timeout 更新；退役后 r1 与 r2 均为 `deny`、`decided_at` 非空，审计恰为两条 `deny`；owner 对 r1 `POST …/approvals/:id {decision:"allow"}`（或该测试文件现有的作答入口）得 409 `approval_settled`，r1 仍为 `deny`，无 `allow` 审计；再推进一个 TTL 无 `timeout`、无帧；保留故障仍只有一条（TIMEOUT_BLOCKED）。
- [x] 1.3 新用例：r1 的 timeout 与 deny 更新都被阻断（存储持续失败；两个触发器用不同的错误消息，以便断言两条来源）→ r1 保持 NULL、保留故障含两条错误来源、无未处理 rejection、关停仍暴露保留故障——钉住「已知残留」的如实行为，不断言 owner 作答结果。
- [x] 1.4 不改其它被跟踪文件。**一处例外**：`server/test/session-approvals-faults.test.ts` 的 R16b 用 `BLOCK_AUDIT` 阻断全部 `session.approval` 审计，r1 的超时事务失败后登记现在保留，`abandon` 的 `deny` 同样被阻断，保留故障由 1 条变 2 条（proposal Non-goals 已写明的行为）。该用例 `errors` 的长度断言改为 2，并断言两条都含 `AUDIT_BLOCKED`；其余断言不动。

## Must preserve
- 该文件其余用例（F1、F3… 及 E 系列）与全部审批测试断言不动且全绿（R16b 的 `errors` 条数除外，见 1.4；F3 的请求与 409 断言可提取为与 F2 共用的 helper，断言内容不变）；非 infra 路径（作答、超时、stop、终态 deny）零变化。
- `abandon` 的次序（先撤计时器/登记/pending，再 CAS）不变。

## Required evidence
- E1 RED→GREEN：1.2 的新断言在未改 `approvals.ts` 时失败（r1 为 NULL、owner `allow` 得 200），改后通过。
- E2 `npm test --workspace server` 全绿（文件数/测试数）；F2 所在文件连跑 10 次无偶发失败。
- E3 `make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、`openspec validate expire-fault-keeps-registration --strict --no-interactive` exit 0。

## Negative controls
- N1 恢复 `registrations.delete` → 1.2 失败（r1 NULL / 200）。
- N2 `abandon` 跳过已到期的登记 → 1.2 失败。

## Risk packs
| Pack | Selected | 理由 → 证据 |
|---|---|---|
| State machine / lifecycle / concurrency | yes | 登记生命周期与退役同步段 → 1.1 核对、1.2、1.3 |
| Audit / security-relevant records | yes | 不为未执行工具写 `allow` 审计 → 1.2 |
| Error handling / fault retention | yes | 保留故障条数与关停暴露不变 → 1.2、1.3 |
| 其它 | no | 无 REST 契约、schema、UI 改动 |
