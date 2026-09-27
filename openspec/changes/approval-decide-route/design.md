# Design: approval-decide-route（#468）

父设计 D5（作答 → CAS → 200/409）、D6（归属集六 → 十）。这里只写 D5/D6 落到 `rest.ts` 时被现有代码逼出的约束。

## Change surface
- **`server/src/sessions/rest.ts`**（217 → 约 290）
  - `SessionSupervisorPort` 加 `decide(sessionId: string, approvalId: number, decision: "allow" | "deny"): Promise<ApprovalView>`，`ApprovalView` 从 `./store.js` 类型导入（#454 carry-forward）。
  - 路由参数类型 `{ id: string; approvalId: string }`，注册：`app.post("/api/sessions/:id/approvals/:approvalId", { onRequest: noStoreSessionResponse, preParsing: <专用 hook> }, handler)`。
    - 模板字符串须与 `http/errors.ts:57` 逐字一致；不设 `bodyLimit`（proposal 偏离 4）。
  - 专用 preParsing（同步、先于 body 解析）：
    - `requireOwnedSession(store, request)`，401/404 语义与既有 `rest.ts:73-83` 相同；
    - `parseApprovalId(params.approvalId)`：匹配 `/^[1-9][0-9]*$/` 且 `Number.isSafeInteger`，否则 `throw new HttpError("not_found")`。
    - 不复用 `authorizeOwnedBeforeParse`（`:91-101`）：它的 `streamCursor` 捕获与 WeakMap 属于快照合同，本路由不需要。
  - handler 依次：
    - `parseDecision(request.body)`：plain object、键集恰为 `decision`、值严格 `"allow"|"deny"`，否则 `HttpError("bad_request")`。plain-object 原型检查从 `parsePromptMessage`（`:196-203`）抽成共享的 `requirePlainRecord(body)`，两处共用，行为不变，避免 jscpd 重复块；
    - 重新 `parseApprovalId`（纯函数）；
    - `await dependencies.supervisor.decide(request.params.id, approvalId, decision)`：经 `dependencies.supervisor` **按属性在请求时调用**，不得在注册时解构或 bind，E6–E16（含 E10b）的 `vi.spyOn(fixture.supervisor, "decide")` 依赖这一点；
    - 返回 200，body 为显式投影 `{id, tool, title, requestedAt, expiresAt, decision}`，不透传 store 对象。
  - 错误不在路由内映射：
    - `HttpError`（`not_found`/`approval_settled`/`agent_unavailable`）原样抛给 `handleHttpError`；
    - 非 `HttpError` 保持 generic 500。
- **`server/src/sessions/supervisor.ts`**（proposal 偏离 1，+3 行）：`decide` 首行加 `if (this.#closed) { return Promise.reject(new HttpError("agent_unavailable")); }`，与 `prompt()` `:133-136` 同形。
- **`server/test/session-rest-helpers.ts`**（proposal 偏离 3）：`createSupervisor()` 加一个 `decide` 成员，调用即以 `Error("unexpected decide call")` 拒绝。

## Governing invariant
作答请求只有两种结局：一是在任何副作用之前被拒绝（没有 `decide` 调用或 `decide` 拒绝、没有写库、没有 `extension_ui_response`、没有 `approval.resolved`）；二是经 `decide` 恰好结算一次，并返回该审批的六键对象。每个响应都带 route-owned `Cache-Control: no-store`。

## Must preserve
- `requireOwnedSession`/`noStoreSessionHeaders` 的签名与行为（`rest.ts:66-83`）：`stream/sse.ts:8,76-78` 仍在消费它们。
- 既有四条路由逐字节不变，包括 prompt 的 `authorizeOwnedBeforeParse`→`acceptPrompt`→`rollbackPrompt` 次序（`rest.ts:124-142`）。
- `decide` 的结算语义不动（`approvals.ts:110-124`，CAS 与审计同事务，`store-approvals.ts:72-115`）。`approval_settled`/`not_found` 由那里抛出，路由不另行判定。
- `http/errors.ts` 零 diff。归属判定只看 `request.routeOptions.url`（`:69-90`），模板不一致就是 generic 500。
- `index.ts` 的 preClose 次序（`:57-66`）：supervisor 先关，store 后关。

## Sibling surfaces（必然改动只有一处；其余既有测试零 diff 全绿）
- **会改**：`session-rest-helpers.ts:80-101`，stub 缺 `decide` 会让 `make typecheck` 失败（`server/tsconfig.json` 的 include 含 `test`）。只允许按 Change surface 加这一个成员。
- **零 diff**：
  - `session-rest.test.ts:225,286`：探针只打 prompt 与 messages；
  - `http-typed-errors.test.ts:52,187-189`、`auth-request-errors.test.ts:440-515`：用伪造的 request 直驱 `handleHttpError`，不挂产品端点，因此不会与新路由 `FST_ERR_DUPLICATED_ROUTE`；
  - `server-assembly.test.ts:466`：spy `registerSessions` 透传；
  - 全部 `session-approvals*.test.ts`：直接调 `supervisor.decide`，都不在关停后调用，`#closed` 守卫对它们不可见；
  - `session-sse*.test.ts`：`requireOwnedSession` 行为不变。
- 生产消费者：web `decideApproval`（#472）按 `error.code` 分支。本刀只需让三个 409/404/502 的 code 逐字正确（E3、E10、E14）。

## Seams under test（全部可在当前代码上执行；不 import `approvals.ts`/`store-approvals.ts`，不碰私有字段）
- 装配：`openApprovalWorld("approval" | "approval-parallel")`（`session-approval-helpers.ts:85`），即生产 `createApp`→`registerSessions`→真实 fake-omp（argv 带 `write`）+ 注入时钟 `T`。
- 挂起审批与会话：
  - `pendingApproval(world[, session])`（`:393`）；
  - 同 owner 的第二会话：`extraSession` + `pendingApproval(world, extra)`，每个 gated 回合一个新进程；
  - 他人 cookie：`cookieFor(world.fixture.app, "zhaoliu")`（`session-rest-helpers.ts:116`）。
- 副作用观察：
  - 帧：`responses(world.spawned[i])`（stdin 记录器）；
  - 行与审计：`approvalRows`/`approvalRow`、`approvalAuditCount`/`auditCount`；
  - 事件：`ofType(world.events, "approval.resolved")`；
  - 调用：`vi.spyOn(world.fixture.supervisor, "decide")`（真实实例，路由按属性调用）；
  - 回合：`waitForTurn`（`session-supervisor-helpers.ts:510`）。
- 真实 socket：
  - `withListeningApp(world.fixture.app, …)`（`raw-http-helpers.ts:17`）配 `fetch`（先例 `workspace-http-errors.test.ts:93-107`）；
  - `withListeningApp` 结束时会关 app，afterEach 的 `fixture.close()` 再关一次是安全的（`withApp` 先例同样叠加两次关闭）；
  - 超限输入经真实 socket 发送的先例：`model-proxy-wire.test.ts:178-179`。
- 关停：E14 直接调 `fixture.supervisor.shutdown()`，因为测试到达不了守卫所保护的在途窗口。`app.close()` 一开始，`inject` 就以 `FST_ERR_REOPENED_CLOSE_SERVER` 拒绝（fastify.js:483-491），真实 socket 上的新请求则被 Fastify 以 503 短路（lib/route.js:477-497）。
- 输入与信封：
  - `PARSER_INPUTS`/`OVERSIZED_PARSER_INPUT`（`http-guard-helpers.ts:66`、`session-rest-helpers.ts:25`）直接 import，不复制（jscpd ≤3%）；
  - 信封常量取自 `session-db-helpers.ts:18-20` 与 `session-rest-helpers.ts:17`。

## Required evidence（新建 `server/test/session-approval-rest.test.ts`；S 为 owner 会话，A 为其 pending 行 id；「无副作用」= spy 0 次 + A 行 `decision`/`decided_at` 不变 + `approvalAuditCount` 不变 + 无 `extension_ui_response` + 无 `approval.resolved`）

| ID | 输入 | 期望输出 |
|---|---|---|
| E1 允许（红） | `nowMs=T+1000`，POST `{"decision":"allow"}` | 200，no-store，body `toStrictEqual({id:A,tool:"bash",title:TITLE,requestedAt:T,expiresAt:T+60000,decision:"allow"})`；响应返回时 A 行已是 `allow`/`T+1000`、`approvalAuditCount=1`；stdin 恰 `[{type:"extension_ui_response",id:"r1",value:"Approve"}]`；恰一个 resolved `allow`；随后 bash 步骤 `done`、回合 `done` |
| E2 拒绝（红） | 同 E1，`deny` | 200 `decision:"deny"`；帧 `value:"Deny"`；bash 步骤 `failed`，output `Tool call denied by user: bash`；助手与会话 `done` |
| E3 已结算再答（红） | E1 后 POST deny；E2 后 POST allow | 409，body 恰 `{error:{code:"approval_settled",message:"该审批已处理"}}`，no-store；行仍为首次决定；帧、审计、resolved 各恰 1 |
| E4 超时后作答（红） | `clock.advance(60000)`，等回合 `done`，再 POST allow | 409 `approval_settled`；行 `timeout`/`T+60000`；帧恰 1（`Approve`）；审计恰 1 |
| E5 并发作答（红） | `Promise.all` 两个 inject（allow 与 deny） | 状态排序后为 `[200,409]`；行值等于 200 那个 body 的 `decision`；帧、审计、resolved 各恰 1 |
| E6 body 形态（红） | `{"decision":"maybe"}`、`{}`、`{"decision":"allow","x":1}`、`{"decision":"timeout"}`、`{"decision":"ALLOW"}`、`{"decision":null}`、`{"Decision":"allow"}`、`null`、`[]`、`"allow"`、`{` | 每个都是 400 `BAD_REQUEST_ENVELOPE` + no-store，且无副作用；之后合法 allow → 200（证明 pending 未被破坏） |
| E7 媒体类型（红） | `application/x-www-form-urlencoded` 与 `text/plain`，均携 `decision=allow` | 都是 400 + no-store，无副作用：前者是 CTP invalid media，由归属集映射；后者被 Fastify 默认 text parser 解析成字符串，再被 validator 拒绝 |
| E8 未认证（红） | 无 cookie：合法 body、`{`、`OVERSIZED_PARSER_INPUT` | 401 `UNAUTHORIZED_ENVELOPE` + no-store、无 set-cookie，无副作用（master 上 catch-all 的 401 没有 no-store） |
| E9 他人/未知会话（红） | zhaoliu cookie + S；owner cookie + `f`×32；每种各发合法 body、`{`、`OVERSIZED_PARSER_INPUT` | 全部 404 `NOT_FOUND_ENVELOPE` + no-store（畸形/超限 body 也是 404，证明先于 parser），无副作用 |
| E10 未知与外会话 approvalId（红） | S2 为同 owner 的第二会话，挂起行 B；POST S/`A+1000`、POST S/`B`，均为合法 allow | 两者与 E9 未知会话 404 的 `payload` 字符串、`cache-control`、`content-type` 逐一相等；spy 被调 2 次且都以 `not_found` 拒绝；A、B 行仍 NULL；两个子进程都无应答帧；审计 0 |
| E10b 畸形 body 不泄露 id 存在性（红） | 同 E10 装配（S 挂起 A，S2 挂起 B）；对 S/`A`、S/`A+1000`、S/`B` 各发 `{`（CTP 映射路径）与 `{"decision":"maybe"}`（handler validator 路径），共 6 个请求 | 6 个响应全部 400 `BAD_REQUEST_ENVELOPE`，`payload` 字符串、`cache-control`（`no-store`）、`content-type` 两两相等；spy 0 次；A、B 行仍 NULL；两个子进程均无应答帧；审计 0（偏离 2 的无存在性探测面证据） |
| E11 非 canonical id（红） | `01`、`0${A}`、`abc`、`0`、`-1`、`+1`、`1e3`、`1.0`、`${A}x`、`9007199254740993`；各发合法 body 与 `{` | 全部 404 且与 E9 逐字节相同，no-store；spy 0；A 仍可随后以 `/${A}` allow → 200 |
| E12 并行分别作答（红） | `approval-parallel`，两行 r1<r2；先 POST r2 行 allow，再 POST r1 行 deny | 第一次 200 后 r2 行 `allow`、r1 行仍 NULL；第二次 200 `deny`；stdin 应答序恰 `[{id:"r2",value:"Approve"},{id:"r1",value:"Deny"}]`；回合 `done` |
| E13 结算事务失败（红，路由不吞错） | `db.exec` 建触发器 `BEFORE INSERT ON audit_events WHEN NEW.kind='session.approval' BEGIN SELECT RAISE(ABORT,'approval audit blocked'); END`，POST allow；`DROP TRIGGER` 后再 POST allow | 第一次：500，body 恰 `{error:{message:"服务器内部错误"}}`，no-store；行仍 NULL，无帧、无 resolved、审计 0；第二次 200 `allow`、帧恰 1 |
| E14 关停后作答（红：master 无路由；仅有路由而无守卫时为 200 并写库） | pending 后 `await world.fixture.supervisor.shutdown()`；快照 A 行与 `approvalAuditCount`；POST allow | 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}` + no-store；A 行与快照相等（不断言具体值，#474 前后都成立）；审计数不变；无 `extension_ui_response` |
| E15 真实 socket parser owner（红） | 先挂起 A，再 `withListeningApp`（行/审计/帧/spy 断言全部在回调内、`app.close()` 之前完成）；owner cookie 下 `fetch` POST S/A，逐一发送 `PARSER_INPUTS` 四项（malformed、empty、unsupported media、1.1 MB 超限） | 每项 400 `BAD_REQUEST_ENVELOPE`，`cache-control: no-store`，无 set-cookie；spy 0；A 行 NULL；无帧；审计 0；`app.hasRoute({method:"POST",url:"/api/sessions/:id/approvals/:approvalId"})===true`（与 `errors.ts:57` 字面相同） |
| E16 真实 socket 401/404 先于 parser（红） | 同一监听（断言同样在回调内完成）：无 cookie、zhaoliu cookie + S、owner cookie + 未知会话；各发 malformed JSON、empty JSON body 与 unsupported media（超限输入不经 socket 发送：401/404 在 preParsing 返回、服务端不读完 1.1 MB body，客户端写入可能被连接关闭打断成 EPIPE/ECONNRESET；超限的 401/404 由 E8/E9 的 inject 覆盖） | 401 `UNAUTHORIZED_ENVELOPE` 或 404 `NOT_FOUND_ENVELOPE`，均带 no-store；spy 0；A 行 NULL；无帧 |
| E17 守卫（恒绿） | 既有 `session-rest*.test.ts`、`session-approvals*.test.ts`、`http-typed-errors.test.ts`、`auth-request-errors.test.ts`、`session-sse*.test.ts` | 零 diff 全绿（除 `session-rest-helpers.ts` 那一处成员） |

E15/E16 的行、审计、帧与 spy 断言 SHALL 在 `withListeningApp` 回调内、`app.close()` 之前完成：`withListeningApp` 结束时的 `app.close()` 会经 `closeSessions` 调 `supervisor.shutdown()`，#474 之后关停会把 pending 审批以 `deny` 结算并写审计；回调内断言与 E14 一样不依赖 #474 之前或之后的关停结算行为。

**红/绿**
- E1–E16（含 E10b）在 master 上为红：master 上该路径落入 `/api/*` catch-all，返回 404 且不带 no-store。
- 下列变异各须使对应用例变红，逐一临时施加并把失败输出记入 PR body：
  - 去掉 supervisor `#closed` 守卫 → E14 得到 200，并写入决定与审计；
  - 路由模板与 `errors.ts:57` 不一致（如 `:approvalID`）→ `request.params.approvalId` 为 undefined，`parseApprovalId` 在 preParsing 抛 404：E15 的四项 parser 输入都得到 404 `NOT_FOUND_ENVELOPE`（而非 400），E1 等也因 404 变红；`hasRoute` 按路径模式匹配、不看参数名，实测仍为 true，所以参数改名只由 400→404 抓到。`parseApprovalId` 对非字符串输入 SHALL 返回 404 而非抛 TypeError；路径段不同的模板（如 `/api/sessions/:id/approval/:approvalId`）实测落入 `/api/*` catch-all 得 404（`hasRoute` 为 false），该变异同样使 E15 变红；
  - `parseDecision` 放行 `timeout` → E6；
  - `approvalId` 用 `Number()`/`parseInt` 而不做 canonical 校验 → E11（`0${A}` 结算了 A）；
  - 返回 store 对象而非显式投影 → E1 在加入额外字段的变异下失败（`toStrictEqual`）；
  - 在 handler 内而非 preParsing 做会话 owner 校验 → E9（畸形 body 得到 400）。

## Non-goals
见 proposal Non-goals。另外：`approvalId` 行归属在 body 解析前判定（proposal 偏离 2，留待 #476 之后）。

## Review focus
1. 路由模板字面与 `errors.ts:57` 相同；E15 是在生产 `createApp` 上经真实 socket 得到的 400，而不是 inject。
2. 所有 404 逐字节相同，且非 canonical id 与会话 404 都先于 parser（E9–E11）；畸形 body 的 400 与 id 是否存在无关（E10b）。
3. body validator 只放行 `allow|deny` 两个值和恰好一个键；200 body 是显式六键投影。
4. `decide` 按属性调用、错误原样上抛；`supervisor.ts` 的 diff 只有 `#closed` 守卫三行（`wc -l` 记入 PR body，≤760）。
5. `session-rest-helpers.ts` 的 diff 只有一个 `decide` 成员。
