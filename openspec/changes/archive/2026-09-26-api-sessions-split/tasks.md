# Tasks: api-sessions-split（#471）

## 7. chat-web 纯搬迁（父 tasks 7.0a 原文）

- [ ] 7.0a 纯搬迁、行为不变：`web/src/lib/api.ts`（749 行）拆出 `web/src/lib/api-sessions.ts`（会话族方法）。验证：`bash scripts/size-guard.sh` 退出 0、web 既有测试不改动全绿、`knip` 零新增

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Legacy compatibility / examples | yes | `ApiClient` 公开面、`api.ts` 导出集合与 19 个既有导入方（11 源文件 + 8 测试文件）不变 → `git diff --stat -- web/test web/src/features` 为空 + `make typecheck` + web 测试 53 文件 / 1017 例全绿 |
| Error handling / rollback / partial outputs | yes | 错误信封、request_failed 与 401 通知经注入的原传输不变 → `web/test/api-sessions.test.ts` 的 409/502/401/非法响应用例零改动全绿 |
| Public API / CLI / script entry | no | 无 HTTP/CLI 变化；TS 公开面归 Legacy 包 |
| Config / project setup | no | 不涉 |
| File IO / path safety / overwrite | no | 不涉 |
| Schema / columns / units / field names | no | DTO 解析在 `session-contract.ts`，零改动 |
| Auth / permissions / secrets | no | `onUnauthorized` 原引用透传，由 Error handling 包的 401 用例覆盖 |
| Concurrency / shared state / ordering | no | 无共享状态；signal 透传逐字不变 |
| Resource limits / large input / discovery | no | 行数上限由 size-guard 覆盖 |
| Release / packaging / dependency compatibility | no | 无依赖变化（`npm run build --workspace web` 作回归命令） |
| Documentation / migration notes | no | 源码结构说明归 9.1 |

## 通用纪律（继承父 tasks.md）
- [ ] 纯搬迁：`bash scripts/size-guard.sh` 0（`api.ts` ≤ 700）+ 既有测试**不改动**全绿 + knip 零新增；搬迁清单与胶水边界按 design「Must add/change」。
- [ ] 不新增测试，不触碰 `web/test/**`、`web/src/features/**`、`web/src/lib/session-contract.ts`、server、Makefile、CI；允许的既有测试编辑：无。
- [ ] `api-sessions.ts` 对 `./api.js` 只有 `import type`；`api.ts` 不新增 export。
- [ ] `npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift` 退出 0；`openspec validate api-sessions-split --strict --no-interactive` 通过。
