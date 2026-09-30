# Proposal: session-metadata-patch（#524）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.2（epic #509，design D2「PATCH 决定」「重命名与 `rollbackPrompt`」、「模块拆分」）。1.1 已加列、1.3 已把 `PATCH /api/sessions/:id` 放入 parser 归属集（`server/src/http/errors.ts:59`）、5.1 已投影八键、4.1 已建 `rest-metadata.ts`/`store-metadata.ts`；但会话仍无修改标题/场景/置顶的路由，且 `rollbackPrompt`（`server/src/sessions/store.ts:409`）无条件以受理前标题恢复（`store.ts:434-438`），在受理与补偿之间写入的标题会被抹掉。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 REST 修改路由的请求/响应合同与错误码（200/400/401/404）；所有者边界（他人/未知 404 先于 body 解析）；store 受理补偿路径（`rollbackPrompt` 标题规则，错一处即抹掉用户重命名或把前缀标题残留）；侧栏排序语义（PATCH 不改 `updated_at`）。
Selected risk packs: Public API / CLI / script entry（PATCH body 合同与 200 八键）；Auth / permissions / secrets（owner 预检先于解析、404 不可区分）；Error handling / rollback / partial outputs（任一字段非法整体 400 零写入；补偿不撤销重命名）；Concurrency / shared state / ordering（PATCH 与在途受理共享 `titleTouched` 内存标志；运行中修改）；Resource limits / large input / discovery（16 KiB `bodyLimit`）；Legacy compatibility / examples（既有补偿对未 PATCH 会话的行为不变、既有测试冻结）
Evidence floor: `server/test/session-metadata-rest.test.ts` 追加 PATCH 用例、新建 `server/test/session-title-rollback.test.ts`，覆盖 design「Required evidence」；既有测试文件零改动；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/rest-metadata.ts`：注册函数改名 `registerSessionMetadataRoutes`，在 POST 之外新增 `PATCH /api/sessions/:id`（preParsing owner 预检、16 KiB `bodyLimit`、no-store、手写 exact validator、200 八键）；写入 `title` 成功后同步通知 SessionStore 标记在途受理。
- `server/src/sessions/store-metadata.ts`：新增 `patchSession(ownerId, sessionId, patch)`（单条所有者作用域 UPDATE，只写所给列，0 行 → null）。
- `server/src/sessions/store.ts`：Turn 增 `titleTouched`；SessionStore 增 `noteTitleWrite(sessionId)`；`rollbackPrompt` 仅当受理本身写了前缀（`previousTitle === null`）且未被标记时把标题恢复为 NULL，否则保留当前标题；为复用八键投影导出 `SessionView`、`SESSION_COLUMNS`、`SessionDbRow`、`toSessionView`（仅加 `export`）。
- `server/src/sessions/rest.ts`：调用改名后的注册函数并传入 `store`。
- 测试：追加一个既有新文件（4.1 建）、新建一个；其余既有测试文件零改动。

## Capabilities
- ADDED `session-metadata`「会话元数据修改」：父 delta 全文。
- MODIFIED `session-metadata`「绑定不可改与工作目录」：并入父 delta 的 PATCH `workspaceId` 400 句与 Scenario「PATCH 不能改绑定」，其余为 main 原文（main 已含 #521 的 `rootOf` 拒绝解析窄例外，保留）。
- MODIFIED `session-metadata`「会话元数据审计」：main 原文 + 「`PATCH /api/sessions/:id` 不写审计。」；`session.delete`（4.3b）不并入。
- MODIFIED `chat-sessions`「会话持久化与回合刷盘」：父 delta 全文——即 `rollbackPrompt` 标题规则三句与 Scenario「Rename survives prompt compensation」；同 Requirement 中父 delta 的创建持久化两句（`workspace_id`/`scene`/`pinned_at` 由创建写入、受理/结算/对账不改）为 4.1 已实现行为的追补（#523 未并入该 Requirement），一并落入。
- MODIFIED `chat-sessions`「会话 REST」：main 原文 + PATCH 路由（九路由）、「PATCH 遵循 session-metadata『会话元数据修改』」句、会话视图含 PATCH 响应、Owner isolation Scenario 的 PATCH 与非法 PATCH body；DELETE（4.3）、`GET /api/commands`/`agentDir`/命令 400（组 10）、fork 先建行与继承（4.4）、`stopped` 句不并入。
- MODIFIED `http-service-skeleton`「统一错误信封」：main 原文 + PATCH content-parser 句与 Scenario「会话元数据 parser owner 的真实 HTTP 边界」的 PATCH 一组 WHEN/THEN；DELETE 句与其 WHEN/THEN（4.3b）不并入。

## Impact
- server：`rest-metadata.ts`、`store-metadata.ts`、`store.ts`（Turn 标志、`noteTitleWrite`、`rollbackPrompt` 条件、四处 `export`）、`rest.ts`（一处调用）。不触碰 `supervisor.ts`、`omp/`、`http/errors.ts`、`index.ts`、web。
- 与 issue 的偏差：
  - issue 写「preParsing 复用 `requireOwnedSession`」，但它在 `rest.ts`，`rest-metadata.ts` 不得 import `rest.ts`（单向依赖，4.1 已定）；改为经注入的 `store.getMessages(id, principal.id) === null` → 404，与 `requireOwnedSession` 同一语义与 chat-sessions「会话 REST」的 id-scoped 授权句，不捕获快照/游标。
  - issue 写 Turn 增 `titleSetByPrompt`；受理写前缀当且仅当 `previousTitle === null`（`store.ts:356-357`），故由其派生，不另存字段。
  - `store.ts` 除 Turn/`rollbackPrompt` 外新增 `noteTitleWrite` 方法与四处 `export`（为 `patchSession` 复用八键投影，避免复制 `toSessionView`）。
- 依赖：#523（4.1）已合并并归档（#687/#688）。

## Non-goals
- DELETE 与 retire 编排（4.3a/b/c）、fork 继承（4.4）、web `patchSession` 客户端之外的 UI（7.2a）、smoke PATCH 条目（8.1）。
