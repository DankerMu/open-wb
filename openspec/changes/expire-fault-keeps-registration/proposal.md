# Proposal: expire-fault-keeps-registration（#662，owner 决议：只做方向 A）

## Why
`Approvals.#expire` 的超时事务失败时先删登记再进 fault sink（`server/src/sessions/approvals.ts`）。随后的 infra retire 调用 `abandon`，它只遍历仍在登记表里的审批，这一条被漏过：行保持 `decision IS NULL` 直到重启对账，期间 owner 作答 `allow` 能命中 CAS、返回 200 并写下 `allow` 审计，而工具从未执行。

## What Changes
- `approvals.ts` `#expire`：fault 分支不删登记，交给 `#fault` → 退役 → `abandon` 统一 deny。
- `server/test/session-approvals-infra-fault.test.ts` F2：r1 在退役后为 `deny` 且有审计；owner 对 r1 作答 `allow` 得 409 `approval_settled`。
- 规格：tool-approval MODIFIED「停止与终态对挂起审批的结算」——一句规则、一句已知残留、Scenario 的 r1 结果。

## Non-goals（owner 决议）
- 不改作答 REST 契约（方向 B 不做）。
- `abandon` 自身 deny 事务失败、`register` 半途失败两种 NULL 行仍由启动对账兜底，作为已知残留写入规格。
- 方向 A 是尽力而为：存储持续失败时 `abandon` 的 deny 同样失败，落入上一条残留。
