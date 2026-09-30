# Tasks: parser-owner-identities（#512）

## 1. http-service-skeleton — parser 归属集（父 tasks 1.3 原文）

- [ ] 1.3 `server/src/http/errors.ts`：content-parser 归属集由 URL 集合改为 `method + matched route` 精确身份集合并去掉 :69 的 POST-only 门：A 的十条 + `POST /api/sessions`（POST 归属）+ `PATCH /api/sessions/:id`（PATCH 归属）= 十二条；`DELETE /api/sessions/:id` 不在集合内（带 malformed body 的 DELETE 走既有「非归属已注册路由」语义）。验证：新建 `server/test/http-parser-owners.test.ts`，走 `handleHttpError` + `requestShaped` 接缝（先例 `server/test/auth-request-errors.test.ts:405-436`，不挂载产品路由）：十二条身份逐条以真实 parser 错误（malformed/empty/非 JSON/超限）→ 400 `bad_request`；同路径 `DELETE /api/sessions/:id` 的 parser 错误不被 PATCH 映射覆盖（通用 5xx）；其它方法打到归属路径、`GET` 归属集路由与伪造错误码不映射；错误码表仍十三码。经 production `createApp` 的四类 parser 失败断言归 4.1（POST）与 4.2（PATCH）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 对外错误合同（400 vs 500）→ design 证据 1–4 |
| Legacy compatibility / examples | yes | 十条既有身份与 404/500 语义不变 → 证据 1（回归护栏）、5、7 |
| Error handling / rollback / partial outputs | yes | 伪造错误、非本身份方法不映射 → 证据 3、4 |
| Schema / columns / units / field names | yes | 错误码表仍十三码 → 证据 6 |
| Concurrency / shared state / ordering | no | 纯函数判定，无状态 |
| File IO / path safety / overwrite | no | 不涉 |
| Resource limits / large input / discovery | no | 超限错误只作为映射输入（证据 1），`bodyLimit` 属 4.1 |
| Config / project setup | no | 不涉 |
| Auth / permissions / secrets | no | 不改 guard；映射发生在 guard 之后 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/http-parser-owners.test.ts`（≤800 行）；`auth-request-errors.test.ts` 零改动；`http-typed-errors.test.ts` 只删 `["POST", "/api/sessions"]` 一条并把 describe 标题「恰十条身份」改为「恰十二条身份」。
- [ ] 每条新断言先在实现前跑红，再实现跑绿（记录命令与结果）；十条既有身份与回归项为护栏，实现前即绿。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate parser-owner-identities --strict --no-interactive` 通过。
