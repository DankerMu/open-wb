# Tasks: omp-runtime-commands-split（#452）

## 2. 纯搬迁（父 tasks 2.0 原文）

- [ ] 2.0 纯搬迁、行为不变：`server/src/sessions/omp/runtime.ts`（797 行）拆出 `server/src/sessions/omp/commands.ts`（command/abort/pending 计时面的落点，先搬既有相关请求与计时辅助）；`process.ts`（732 行）若 2.1a 后将超限，同刀拆出 `server/src/sessions/omp/ui-requests.ts`（`extension_ui_request` 分流）。验证：`bash scripts/size-guard.sh` 退出 0、runtime/process 既有测试不改动全绿、`knip` 零新增

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 私有状态与计时器可能随搬迁跨文件 → design 约束「只搬纯辅助/显式参数，不改时机」+ 既有真实 fake-omp 测试零改动全绿 |
| Legacy compatibility / examples | yes | 公开 API 与既有 import 方不变 → `git diff --stat -- server/test` 为空 + typecheck |
| Error handling / rollback / partial outputs | yes | 错误类型/退出上报不变 → 既有 omp-runtime/omp-process 失败路径测试零改动全绿 |
| Release / packaging / dependency compatibility | no | 无依赖/构建变化（`npm run build --workspace server` 仍作为回归命令跑） |
| Public API / CLI / script entry | no | 无对外 API 变化 |
| Config / project setup | no | 不涉 |
| Schema / columns / units / field names | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | 凭证注入路径（process.ts env 清单）不得改动，属 Legacy 包覆盖 |
| Resource limits / large input / discovery | no | 行数上限由 size-guard 命令覆盖 |
| Documentation / migration notes | no | 源码结构说明归 9.1（system.md §3.1 sessions 行） |

## 通用纪律（继承父 tasks.md）
- [ ] 纯搬迁：`bash scripts/size-guard.sh` 0（`runtime.ts` ≤ 680；`process.ts` 零改动）+ 既有测试**不改动**全绿 + knip 零新增；搬迁清单按 design「Must add/change」。
- [ ] `openspec validate omp-runtime-commands-split --strict --no-interactive` 通过。
- [ ] 不新增测试，不触碰 `server/test/**`、`server/src/sessions/*.ts` 与 `omp/process.ts`；不建 `ui-requests.ts`（非目标，理由见 design）。
- [ ] `npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。
