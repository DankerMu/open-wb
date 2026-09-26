# Tasks: error-codes-turn-control（#450）

## 1. 码表与归属集（父 tasks 1.2 原文）

- [ ] 1.2 `server/src/core/errors/index.ts` 十一码 → 十三码（`agent_capacity` 503 `Agent 容量已满，请稍后重试`、`approval_settled` 409 `该审批已处理`），`server/src/http/errors.ts` 状态映射与 `CONTENT_PARSER_OWNED_ROUTES` 六 → 十（加 `/api/sessions/:id/stop`、`/api/sessions/:id/regenerate`、`/api/sessions/:id/fork`、`/api/sessions/:id/approvals/:approvalId`）；验证：新建测试文件断言错误表十三码的状态与文案、归属集恰为十条（路由存在前仅为集合成员断言）

## 2. Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 错误信封是全部 REST 的公共契约 → 十三码信封断言 + `handleHttpError` 接缝归属断言 |
| Schema / columns / units / field names | yes | 信封字段 code/message 固定 → body 恰 `{error:{code,message}}` 断言 |
| Error handling / rollback / partial outputs | yes | 意外错误不伪装 → 伪造 code/statusCode 普通对象仍 generic 5xx 断言 |
| Legacy compatibility / examples | yes | 既有十一码与六条归属不变 → 既有错误测试不改（或只改计数期望）全绿 + 新文件逐码断言 |
| Auth / permissions / secrets | no | 不改 guard；401 次序由既有测试覆盖 |
| Config / project setup | no | 无配置 |
| File IO / path safety / overwrite | no | 不涉 |
| Concurrency / shared state / ordering | no | 纯表驱动映射 |
| Resource limits / large input / discovery | no | body limit 属路由切片 |
| Release / packaging / dependency compatibility | no | 无依赖改动 |
| Documentation / migration notes | no | 源码注释同步即可（review 检查） |

## 3. 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/*.test.ts`；既有测试文件只允许 design「Sibling surfaces · 消费者」所列改动（`auth-lifecycle.test.ts` 穷尽守卫表补两码 + 标题十一→十三），其它既有测试不动、不删断言。
- [ ] 正向新断言（两新码信封、no-store 两例、四新归属身份 400）先对未改源码跑红，再实现跑绿；负向守卫断言标注「始终为绿」（记录命令与结果）。
- [ ] 测试接缝按 design「Seams under test」：不在 `/api/sessions/*` 注册探针、不挂载产品端点、不新增导出。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。
