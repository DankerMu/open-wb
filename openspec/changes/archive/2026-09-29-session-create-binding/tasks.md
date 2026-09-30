# Tasks: session-create-binding（#523）

## 4. session-metadata — 创建与绑定（父 tasks 4.1 原文）

- [ ] 4.1 新建 `server/src/sessions/rest-metadata.ts` + 新建 `server/src/sessions/store-metadata.ts` 的 `createSession(owner, {workspaceId?, scene?})`：`POST /api/sessions` 入 parser 归属集（`bodyLimit` 16 KiB）；无 body 与 `{}` → 201 三新键 null；有 body 须为 `{workspaceId?, scene?}` 子集（多余键、`workspaceId` 非字符串或 `null`、`scene` 非三值、数组/`null` 根 → 400）；`workspaceId` 经所有者作用域 `rootOf` 为 null（不存在/他人/形态不合法）→ 三者逐字相同的 404、不写行；插入与 `session.bind` 审计（`title:"绑定工作空间"`，`detail:{sessionId, scene}`）同一事务，未绑定不审计；201 八键 DTO。验证：新建 `server/test/session-metadata-rest.test.ts`（production `createApp` + inject + 真实 SQLite）覆盖 201 三态、400 各形状、经 `createApp` 的四类 parser 失败（malformed JSON/空 body 带 `application/json`/非 JSON media/超 16 KiB）→ 400 `bad_request`、404 三者响应字节相等、审计行与会话行同事务（注入审计失败 → 无会话行）、`GET /api/audit` 对管理员返回该 `session.bind` 事件而非管理员不可见；`smoke/chat.hurl:16` 与 web 既有无 body 创建不受影响（5.1 之后的 `session-rest.test.ts` 不再改动且全绿）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | POST body 合同与 201 八键视图 → 证据 1、2、4 |
| Auth / permissions / secrets | yes | 所有者作用域 `rootOf`、404 三源不可区分、审计可见规则 → 证据 3、7 |
| Error handling / rollback / partial outputs | yes | 400/404 零写入、审计失败无会话行、`rootOf` 抛错 → 证据 3、4、5、6、8 |
| Resource limits / large input / discovery | yes | 16 KiB `bodyLimit` → 证据 5 |
| Legacy compatibility / examples | yes | 无 body 创建不变、既有测试冻结 → 证据 1、9 |
| Concurrency / shared state / ordering | no | 单事务插入，无共享内存态 |
| File IO / path safety / overwrite | no | 创建不建目录；路径只经 `rootOf` 判存在性 |
| Schema / columns / units / field names | no | 列由 1.1、投影由 5.1 提供 |
| Config / project setup | no | 装配只在 `index.ts` 内传依赖 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建的 `server/test/session-metadata-rest.test.ts`（≤800 行）；既有测试文件断言零改动，唯一既有测试改动为 `server/test/session-rest-helpers.ts:59` harness 接线一处（见 design）。
- [ ] RED 集合以 design「Required evidence」的划分为准：先在实现前跑红，再实现跑绿（记录命令与结果）；其余按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-create-binding --strict --no-interactive` 通过。
