# Tasks: session-store-split（#454）

## 4. store 纯搬迁（父 tasks 4.0a 原文）

- [ ] 4.0a 纯搬迁、行为不变：`server/src/sessions/store.ts`（798 行）拆出 `store-approvals.ts` 与 `store-branch.ts`（regenerate/fork 事务与行拷贝的落点），先搬既有消息/步骤行读写辅助使 `store.ts` 留出余量。验证：`bash scripts/size-guard.sh` 退出 0、store 既有测试不改动全绿、`knip` 零新增

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 事务原语与 flush 计时随搬迁跨文件 → 逐字搬移 + 既有 store/supervisor 测试（真实 SQLite）零改动全绿 |
| Legacy compatibility / examples | yes | `createSessionStore` 导出面与导入方不变 → `git diff --stat -- server/test` 为空 + typecheck |
| Error handling / rollback / partial outputs | yes | owned 事务回滚与错误包装不变 → 既有回滚/故障测试零改动全绿 |
| Release / packaging / dependency compatibility | no | 无依赖变化（build 作为回归命令） |
| Public API / CLI / script entry | no | 无对外 API 变化 |
| Config / project setup | no | 不涉 |
| Schema / columns / units / field names | no | SQL 文本逐字不变（Legacy 包覆盖） |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | owner 过滤 SQL 逐字不变 |
| Resource limits / large input / discovery | no | 行数上限由 size-guard 覆盖 |
| Documentation / migration notes | no | 归 9.1 |

## 通用纪律（继承父 tasks.md）
- [ ] 纯搬迁：`bash scripts/size-guard.sh` 0（`store.ts` ≤ 640）+ 既有测试**不改动**全绿 + knip 零新增；搬迁清单按 design。
- [ ] 不新增测试，不触碰 `server/test/**`、`supervisor.ts`、`omp/`、`rest.ts`、`events.ts`。
- [ ] `npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0；`openspec validate session-store-split --strict --no-interactive` 通过。
