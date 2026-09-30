# Proposal: session-create-binding（#523）

## Why
父 change `s1c-session-metadata-presentation` tasks 4.1（epic #509，design D2「POST 决定」、「模块拆分」）。1.1 已加列、1.3 已把 `POST /api/sessions` 放入 parser 归属集、5.1 已让 201 为八键、2.2 已注入所有者作用域 `workspaceRootOf` 并让绑定会话按空间根 spawn；但创建路由仍不读 body（`server/src/sessions/rest.ts:162-165`），会话无法经 REST 绑定空间或选择场景。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 REST 创建路由的请求/响应合同与错误码（201/400/404）、审计不变量（绑定与审计同事务）、所有者边界（他人空间不可区分地 404）；既有无 body 创建（web、`smoke/chat.hurl:16`）必须不变。
Selected risk packs: Public API / CLI / script entry（POST body 合同与 201 视图）；Auth / permissions / secrets（所有者作用域 `rootOf`、404 三源不可区分、审计可见规则）；Error handling / rollback / partial outputs（400/404 零写入、审计失败则无会话行）；Resource limits / large input / discovery（16 KiB `bodyLimit`）；Legacy compatibility / examples（无 body 创建不变、`session-rest.test.ts` 冻结）
Evidence floor: 新建 `server/test/session-metadata-rest.test.ts` 覆盖 design「Required evidence」；既有测试文件断言零改动（唯一改动为 `session-rest-helpers.ts` 的 harness 接线）；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- 新建 `server/src/sessions/rest-metadata.ts`：`POST /api/sessions` 的处理（16 KiB `bodyLimit`、no-store、手写 exact validator、所有者作用域 404、调用 metadata store），`rest.ts` 只把该路由的注册委托过去。
- 新建 `server/src/sessions/store-metadata.ts`：`createSession(ownerId, {workspaceId?, scene?})`——一个 SQLite 事务内插入会话行，绑定时同事务 `emit` `session.bind`；返回八键视图。
- `server/src/sessions/index.ts`：构造 metadata store（同一 DB、同一 `core/audit` `emit`）并把它与 `workspaceRootOf` 交给路由注册。
- 新测试文件一个；既有测试文件断言零改动（唯一改动为 `session-rest-helpers.ts` 的 harness 接线）。

## Capabilities
- MODIFIED `chat-sessions`「会话 REST」：只把 POST 句替换为父 delta 的可选 body 句；父 delta 同 Requirement 的 PATCH/DELETE 路由与十路由计数（4.2/4.3）、`GET /api/commands`/`agentDir`/命令 400（组 10）、fork 先建行与继承（4.4）、`stopped` 句不并入。
- MODIFIED `http-service-skeleton`「统一错误信封」：只并入 `POST /api/sessions` 可选 body 归属路由两句与 Scenario「会话元数据 parser owner 的真实 HTTP 边界」的 POST 两组 WHEN/THEN；PATCH（4.2）与 DELETE（4.3b）句及其 WHEN/THEN 不并入；父 delta 对既有「四路由」Scenario 的措辞改写为父相对 main 的漂移，本刀保留 main 原文。
- ADDED `session-metadata`「会话创建与空间绑定」：父 delta 全文。
- ADDED `session-metadata`「会话元数据审计」：只含 `session.bind`——去掉 `session.delete` 条目（4.3b）与「`PATCH` 不写审计」句（4.2）；父 Scenario「审计形状」依赖删除（4.3b），本刀以其 bind 半部写成 Scenario「绑定审计形状」，4.3b 以父 delta 全文替换本 Requirement。

## Impact
- server：`rest.ts`（接线）、`index.ts`（装配）、两个新模块、一个新测试。不触碰 `supervisor.ts`、`store.ts`、`omp/`、`http/errors.ts`、web。
- 与 issue 的偏差：`server/test/session-rest-helpers.ts:59` 的独立路由 harness 直接调用 `registerSessionRoutes(app, { store, supervisor })`，而 POST 改由 metadata store 处理——该 harness 须改一行接线（传入 `metadata` 与 `workspaceRootOf: () => null`），否则冻结的 `session-rest.test.ts` 等经该 harness 的无 body 创建会 typecheck 失败或 500。既有测试文件的断言零改动。
- 依赖：`session-metadata` 主 spec 由 `session-workspace-cwd`（#521）归档建立（#686 已合并），本 change 向其 ADDED 两条 Requirement。

## Non-goals
- PATCH（4.2）、DELETE 与 retire 编排（4.3b/c）、fork 继承（4.4）、web 欢迎页场景胶囊与 footer 空间选择（7.3）、`smoke/session-meta.hurl`（8.1）。
