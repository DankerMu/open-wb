# Tasks: session-dto-metadata（#517）

## 5. 跨端 DTO（父 tasks 5.1 原文）

- [ ] 5.1 跨端同刀：server `store.ts` `SESSION_COLUMNS`/`toSessionView` 八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}` 作用于列表、创建、消息快照 `session` 与 A 的 fork 201；消息投影增 `thinking: string|null`（用户消息恒 null）；步骤投影增 `changes: Change[]|null`（列 NULL → `null`，非空 JSON → 解析数组）；web `web/src/lib/session-contract.ts` 会话八键严格解析（`scene` ∈ 三值|null、`workspaceId` 为 32 位小写十六进制字符串|null、`pinnedAt` 非负安全整数|null）、消息 `thinking`、步骤 `changes`（元素键恰 `path/added/removed/kind`，`kind` ∈ `edit|write`，计数为非负安全整数或 null）——缺键/多键/值不合法整体视为无效成功响应；`web/src/lib/api-sessions.ts` 签名改为 `createSession(body?, options?)`（`options` 仍为 `ApiRequestOptions`、保留 `signal`；有 body 才发 `application/json`），`web/src/features/chat/page.tsx:555` 调用改为 `createSession(undefined, { signal })`；增 `patchSession(id, patch)`（空对象不发请求、`TypeError` 拒绝）、`deleteSession(id)`（恰 204 成功、200 视为无效）。既有夹具迁移（仅以共享常量单行展开补键，常量定义在新建 `server/test/session-meta-fixtures.ts` 与 `web/test/session-meta-fixtures.ts`）：server `session-rest.test.ts`（:58-64 五键 `toEqual` 迁出到新文件；:100-120、:160-164、:169-208、:468-474、:722-760 会话/消息/步骤对象补键）、`session-snapshot.test.ts`（:118-150）、`session-store.test.ts`（:33-80 `list`/`getMessages` 期望）；web `api-sessions.test.ts`（另 :79、:135 调用改为 `createSession(undefined, options)`）、`chat-page-ownership-support.ts`、`chat-stream-support.ts`、`chat-stream.test.ts`、`chat-stream-connection.test.ts`、`chat-page-lifecycle.test.tsx`、`chat-page-ownership.test.tsx`、`chat-page-ownership-gaps.test.tsx`、`chat-page.test.tsx`、`chat-steps.test.tsx`、`chat-messages.test.tsx`、`chat-copy.test.tsx`、`chat-composer.test.tsx`（:159）、`sidebar.test.tsx`（:108）；清单以 5.1 PR 的 `make typecheck` + `make test` 为准，清单外若有文件需补键同样只允许共享常量单行展开并在 PR 中列出。验证：server 新建 `server/test/session-snapshot-metadata.test.ts`：四处投影形状（列表、创建、快照 `session`、fork 201，含迁入的五键→八键 `toEqual`）、NULL/非 NULL `changes`、快照消息 `thinking` 恰等于 `chat_messages.thinking` 列值；web `step.end` 事件 payload 若携带 `changes` 键 → 视为形状不符触发重同步（chat-web「步骤 args 与输出分栏」，落 `session-contract-metadata.test.ts`）；web 新建 `web/test/session-contract-metadata.test.ts` 与 `api-sessions-metadata.test.ts` 断言解析三键、拒绝旧五键/多键/非 32 位小写十六进制 `workspaceId`、三方法请求形状、`createSession(undefined, {signal})` 可取消、204/200 分支；`bash scripts/size-guard.sh` 退出 0 且 PR 记录 `session-rest.test.ts` 5.1 前后行数（预期净约 +8，≤800）

注：父任务行中的 `page.tsx:555` 在当前 master 为 `web/src/features/chat/page.tsx:466`，`api-sessions.test.ts:79/:135` 为 `:81/:137`，`session-rest.test.ts:468-474` 为 DB 行 `objectContaining`、无需补键，迁移文件清单与允许的三种改动以 design「共享夹具常量（同刀迁移例外）」为准；消息/步骤投影在 A 拆出的 `store-branch.ts`，公开形状映射在 `rest.ts`，`ApiClient` 类型在 `api.ts`（见 proposal Impact）。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | REST 四处会话视图、快照消息/步骤键、`ApiClient` 三方法签名 → 证据 1–3、7、8 + typecheck |
| Schema / columns / units / field names | yes | 五列 → 键名、null 语义、`pinnedAt` 毫秒、`workspaceId` 32 hex、`changes` 元素规则 → 证据 1–3、5 |
| Legacy compatibility / examples | yes | 旧五键/七键/六键整体拒绝、`createSession` 调用形状迁移、既有夹具只经共享常量补键 → 证据 5、7、9 |
| Error handling / rollback / partial outputs | yes | malformed success 不部分采用、204/200 分支、空 patch `TypeError`、错误信封 → 证据 6、8 |
| Concurrency / shared state / ordering | no | 只读投影，不改快照捕获次序 |
| File IO / path safety / overwrite | no | `changes.path` 只是透传字符串，归属判定在 3.4 |
| Resource limits / large input / discovery | no | `changes` 1..50 上限由证据 5 覆盖，无新增 IO |
| Auth / permissions / secrets | no | 路由与所有权不变 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 同仓同部署 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建文件（各 ≤800 行）；既有测试仅限 design「共享夹具常量（同刀迁移例外）」的 (a)–(c) 三种改动，不增长其它内容。
- [ ] RED 集合以 design「Required evidence」的划分为准：该集合先在实现前跑红，再实现跑绿（记录命令与结果）；其余按 characterization 记录。
- [ ] `make typecheck`、`make test`（server 覆盖率 ≥80%，web 全绿）、`make lint`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate session-dto-metadata --strict --no-interactive` 通过。
