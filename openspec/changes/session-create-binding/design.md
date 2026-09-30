# Design: session-create-binding（#523）

父设计：D2「会话元数据 REST」POST 决定、「模块拆分」（`rest-metadata.ts`、`store-metadata.ts`）；http-service-skeleton「统一错误信封」归属集（1.3 已落，`server/src/http/errors.ts` `CONTENT_PARSER_OWNED_ROUTES` 含 `"POST /api/sessions"`）。行号为 origin/master。

- **Change surface**：`server/src/sessions/rest.ts:162-165`（现 POST 处理，改为调用 `rest-metadata.ts` 的注册函数）；`server/src/sessions/rest.ts:37-40`（`SessionRestDependencies`，增必填 `metadata`、`workspaceRootOf`）；`server/src/sessions/index.ts:62`（`registerSessionRoutes(app, { store, supervisor })`）；`server/test/session-rest-helpers.ts:59`（独立路由 harness 的同一调用，接线一处，含一个 import）；新建 `server/src/sessions/rest-metadata.ts`、`server/src/sessions/store-metadata.ts`、`server/test/session-metadata-rest.test.ts`。
- **Must preserve**：
  - 无 body（无 Content-Type 且无内容）创建的请求与响应逐字不变：201、八键、三新键 null、`title` null、`status` idle、no-store、不审计；web `createSession()` 与 `smoke/chat.hurl:16` 不受影响；`store.create`（`store.ts:250`）保留（既有测试与内部使用）。
  - 其余会话路由、owner 预检次序（cookie guard 401 先于解析）、no-store、`http/errors.ts` 归属集与错误码表（十三码）不变。
  - sessions 不 import `workspaces/`；所有者判定只经 `registerSessions` 选项已注入的 `workspaceRootOf(ownerId, workspaceId)`（2.2）。
  - 创建不建目录、不 spawn、不调用 supervisor。
  - 既有测试文件的断言零改动；唯一的既有测试改动是 `server/test/session-rest-helpers.ts:59` 的 harness 接线一处（加 `createSessionMetadataStore` 的 import）：`registerSessionRoutes(app, { store, supervisor, metadata: createSessionMetadataStore(db, { emit }), workspaceRootOf: () => null })`（`db` 在 :52 闭包内，`emit` 已 import）；经该 harness 的无 body 创建（`session-rest.test.ts:44-49`、`session-snapshot-metadata.test.ts:101-106` 等）因此保持 201。
- **Must add/change**：
  - `rest-metadata.ts` 导出 `registerSessionCreateRoute(app, { metadata, workspaceRootOf })`（或等价命名），由 `registerSessionRoutes`（`SessionRestDependencies` 增必填 `metadata` 与 `workspaceRootOf`）在原位置调用（保持路由注册次序）。依赖单向：`rest.ts` → `rest-metadata.ts`，`rest-metadata.ts` 不 import `rest.ts`（避免循环 import 的顶层 ReferenceError）——no-store 以本地 hook 设置与 `rest.ts:103` `noStoreSessionHeaders` 相同的头（可从一个无依赖的共享位置 import，或本地常量），201 视图由 `store-metadata` 直接返回同键序八键对象。
    - 路由选项 `{ bodyLimit: SESSION_CREATE_BODY_LIMIT (16 * 1024), onRequest: <no-store hook> }`。
    - 处理：`request.body === undefined` → `{}`；否则 `parseCreateBody(body)`：非 plain object（数组、`null`、原始值——含根实例默认 text/plain parser 产出的字符串 body；validator SHALL NOT 对字符串 `JSON.parse`）→ 400；键集 ⊄ `{workspaceId, scene}` → 400；`workspaceId` 在场且非字符串（含 `null`）→ 400；`scene` 在场且 ∉ `{"office","code","design"}`（含 `null`、大小写变体、空串）→ 400。400 一律 `throw new HttpError("bad_request")`。
    - `workspaceId` 在场：`workspaceRootOf(principal.id, workspaceId) === null` → `throw new HttpError("not_found")`（不存在、属他人、非 32 位小写 hex 三者经 `rootOf` 同一 null 分支，信封逐字相同）。`workspaceRootOf` 自身抛错（根存在但不是普通目录/不安全）→ 原样上抛（通用 5xx；创建不需要目录可用，但不把不变量破坏伪装成成功）——在 PR 记录此取舍。
    - 通过后 `metadata.createSession(principal.id, input)` → `reply.code(201).send(view)`，`view` 由 `store-metadata` 直接返回，键序 `id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt`。
  - `store-metadata.ts` 导出 `createSessionMetadataStore(db, { emit })`，其 `createSession(ownerId, { workspaceId?, scene? })`：
    - `runOwnedTransaction(db, "session create rollback failed", () => { INSERT INTO chat_sessions(id, owner_id, title, status, created_at, updated_at, workspace_id, scene) VALUES (?, ?, NULL, 'idle', ?, ?, ?, ?); if (workspaceId !== undefined) emit(db, { kind: "session.bind", actorId: ownerId, title: "绑定工作空间", workspaceId, detail: { sessionId: id, scene: scene ?? null } }); })`；插入必须恰改 1 行（`requireChanges`）。
    - `id` 与时间戳生成方式同 `store.create`（`randomBytes(16).toString("hex")`、`Date.now()`，`created_at === updated_at`）。
    - 返回八键视图，`pinnedAt: null`，`scene`/`workspaceId` 为请求值或 null。
    - `emit` 依赖与 `createSessionStore` 相同的注入（`index.ts` 已有的 `emit` import）；审计 `detail` 序列化与既有 `emit` 规则一致。
  - `index.ts`：`const metadata = createSessionMetadataStore(options.db, { emit })`，`registerSessionRoutes(app, { store, supervisor, metadata, workspaceRootOf: options.workspaceRootOf })`。
  - 认知复杂度 ≤15（`parseCreateBody` 按需拆分）；无 route schema（归属判定由 1.3 的共享映射器按 method + route 完成）。
- **Sibling surfaces**：`accounts` 的 `GET /api/audit`（`server/src/accounts/index.ts:13`）按既有规则返回新 kind，无需改动；`http/errors.ts` 已含该身份；`store.ts` 的 `SESSION_COLUMNS`/`toSessionView`（5.1）已投影三列，列表与快照自动反映绑定。
- **残余**：`store-metadata` 不感知 `SessionStore` 的 `closed` 标志（`assertOpen`）；preClose 之后路由不再受理请求，故不引入跨模块的关闭状态。
- **Required evidence**（`server/test/session-metadata-rest.test.ts`；production `createApp`（经已导出的 `openBareSession(createRealFakeRuntime().runtime)`，其 `fixture.db` 为同一连接、`calls` 记录 spawn）+ `app.inject()` + 真实 SQLite；工作空间经 `POST /api/workspaces` 建立（`sandboxRoot` 先 mkdir）；审计经 `GET /api/audit` 与 SQL 读取。RED：证据 2、3、4、5 中的「超 16 KiB」与 `text/plain`（根实例默认 text/plain parser 把它解析为字符串，现路由忽略 body → 201）、6、7、8 在实现前红（现路由不读 body、无 `bodyLimit`），记录；证据 1 与证据 5 的 malformed JSON、空 body 带 `application/json`、`application/octet-stream` 为 characterization 守卫（1.3 已使其 400），记录）：
  1. 无 body 与 JSON `{}` 各一次 → 两次 201，恰八键、三新键 null、`title` null、`status` idle、no-store；`audit_events` 行数不变。
  2. 建 W 后以 `{workspaceId:W.id, scene:"code"}` 创建 → 201 `workspaceId=W.id`、`scene="code"`、`pinnedAt` null；SQL 读 `chat_sessions.workspace_id`/`scene` 同值；`GET /api/audit` 恰新增一条 `session.bind`（`title:"绑定工作空间"`、`workspaceId=W.id`、`detail:{sessionId:<新 id>, scene:"code"}`、`actorId` 为 owner）；`GET /api/sessions` 列出该会话且八键一致；spawn 调用数为 0（无 omp 子进程）。另：仅 `{scene:"design"}` → 201 `scene="design"`、`workspaceId` null、不审计；仅 `{workspaceId:W.id}` → 201、`scene` null、审计 `detail.scene` 为 null。
  3. 第二账号用第一账号的 W.id、第一账号用随机 32 位小写 hex、用 `abc` → 三次 404，状态码、`cache-control`、`content-type`、`content-length` 与 body 逐字节相等（不比较 `date` 等随时间变化的头）；`chat_sessions` 与 `audit_events` 行数不变。
  4. `{scene:"chat"}`、`{scene:null}`、`{scene:"Office"}`、`{scene:""}`、`{workspaceId:null}`、`{workspaceId:1}`、`{title:"x"}`、`[]`、`null`、`"x"`（JSON 字符串根）→ 均 400 `bad_request` + no-store，行数不变。
  5. 经 production `createApp` 的 parser 失败：malformed JSON、空 body 带 `application/json`、`application/octet-stream`（真正的 `FST_ERR_CTP_INVALID_MEDIA_TYPE`，先例 `session-approval-rest.test.ts:358`）、超 16 KiB（如 `{"scene":"code","pad":"<16 KiB+>"}`）→ 400 `bad_request` + no-store，行数不变；恰 16 KiB 以内的合法 body（含填充空白）→ 201（边界）。另：`text/plain` body（含内容像 JSON 的 `{}`）→ 400 `bad_request`（validator 的非 plain object 规则，不 `JSON.parse` 字符串），行数不变。
  6. 审计写入失败 → 绑定创建失败（通用 5xx）且无会话行：以真实 SQLite `CREATE TEMP TRIGGER … BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'x'); END` 构造（同一连接，先例 `session-store-reconcile.test.ts:26`；触发器须在 `POST /api/workspaces` 之后建，否则 `workspace.create` 审计先被拦下）；同触发器下未绑定创建仍 201（不审计路径不受影响）。
  7. `GET /api/audit` 对管理员返回该 `session.bind`；第二个非管理员账号的 `GET /api/audit` 不含该条（既有可见规则）。
  8. `rootOf` 抛错分支：建好 W 后把其目录替换为同名普通文件，再以 `{workspaceId:W.id}` 创建 → 通用 500（非 404、非 502），会话行与审计行均无新增。
  9. 回归：既有测试文件断言零改动全绿（`session-rest-helpers.ts` 仅接线一处）；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0；PR 记录 `rest.ts` 前后行数。
