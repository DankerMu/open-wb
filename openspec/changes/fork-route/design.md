# Design: fork-route（#469）

父设计 D4（fork：源进程先 retire、临时进程 branch、事务内拷贝，201 `{session, draft}`）与 D6（归属集十条）。本文只写把 D4 的 REST 面落到 `rest.ts` 时，现有代码逼出来的约束（HEAD `9ba79ab`）。

## Change surface
- **`server/src/sessions/rest.ts`**
  - `SessionSupervisorPort`（`:15-22`）加 `fork(sessionId: string, ownerId: string, messageId: number): Promise<ForkResult>`，`type ForkResult = Awaited<ReturnType<SessionSupervisor["fork"]>>`，经已有的 `./supervisor.js` 类型导入（`:13`）；不 import `./branching.js`（proposal 决定 3）。
  - 常量 `FORK_BODY_LIMIT = 1_024`，写在 `BODYLESS_BODY_LIMIT`（`:77`）旁，注释写明理由（proposal 决定 2）。
  - `parseForkMessageId(body: unknown): number`，放在 `parseDecision`（`:319-330`）旁，同形：
    - `requirePlainRecord(body)`；
    - `Object.keys(record).length === 1 && Object.hasOwn(record, "messageId")`；
    - `Number.isSafeInteger(record.messageId) && record.messageId > 0`；
    - 任一不满足即 `throw new HttpError("bad_request")`。
  - 注册 `app.post<{ Params: SessionIdParams }>("/api/sessions/:id/fork", { bodyLimit: FORK_BODY_LIMIT, onRequest: noStoreSessionResponse, preParsing: authorizeSessionBeforeParse }, handler)`。
    - 模板字面必须与 `http/errors.ts:56` 逐字一致。
    - preParsing 用 `authorizeSessionBeforeParse`（`:127-135`），不能用 `authorizeOwnedBeforeParse`（`:104-114`）：后者会调用 `supervisor.streamCursor`（`:111`），而 401/404/400 必须早于任何 supervisor 调用。
  - handler（`async`）依次执行：
    1. `const messageId = parseForkMessageId(request.body)`；
    2. `const principal = currentPrincipal(request)`；
    3. `const result = await dependencies.supervisor.fork(request.params.id, principal.id, messageId)`；
    4. `return reply.code(201).send({ session: toPublicSession(result.session), draft: result.draft })`。
  - handler 的实现约束：
    - 201 body 由路由显式构造，`session` 复用 `toPublicSession`（`:241-255`），不透传 supervisor 返回的对象（web `parseSessionFork`/`parseSession` 要求键集恰为 `session,draft` 与五键，`web/src/lib/session-contract.ts:98-116,245-252`）；
    - 不做路由层状态预检，不读 `runtimeState`（proposal 决定 1 末项）；
    - 不写 try/catch，不做错误映射：`#control`/`#translate`（`supervisor.ts:328-336,736-747`）已把 omp 错误转成 canonical `HttpError`，非 `HttpError` 在 async handler 中经 `handleHttpError` 成为 generic 500；
    - `fork` 必须按属性在请求时调用，不得在注册时解构或 bind，否则 spy 失效。
- **`server/test/session-rest-helpers.ts`**（proposal 决定 7）：`createSupervisor()` 在 `regenerate`（`:109-111`）之后加一个成员 `fork() { return Promise.reject(new Error("unexpected fork call")); }`。

## Governing invariant
- 每个 fork 请求都带 route-owned no-store，并恰好落入以下三种结局之一：
  - 在任何 supervisor 调用（含 `streamCursor`）、spawn、omp 帧与写库之前被拒绝，优先级为 401（root guard）→ 404（preParsing）→ 400（parser 或 `parseForkMessageId`）；
  - 恰调用一次 `supervisor.fork(id, principal.id, messageId)`，resolve 后返回 201，body 恰为 `{session:{id,title,status,createdAt,updatedAt}, draft}`；
  - 该调用 reject 后返回信封。其次序由 `Forks#precheck`（`branching.ts:212-242`）与执行序决定：`not_found` 404 → 非该会话 user 消息 400 → running 或占用中 409 → `omp_session_file` NULL 502 → `pool.admit` 503 → 对齐失败 502 → CAS 复核 409 → 提交故障 502；关停后 502（`supervisor.ts:329-331`）；非 `HttpError` 为 generic 500。
- fork 持有源会话占用期间，同一会话经 REST 的 prompt/regenerate/fork 都得 409，且不写任何行、不消耗序号；原 fork 照常 201。

## Must preserve
- `requireOwnedSession`/`noStoreSessionHeaders`/`SessionOwnerStore` 的导出与行为（`rest.ts:24-26,84-96`），`sessions/stream/sse.ts` 仍在消费它们。
- 既有六条路由逐字节不变，包括 prompt 的「`controlHeld` → `acceptPrompt` → `supervisor.prompt` → 拒绝时 `rollbackPrompt`」同步前缀（`:162-174`）。`requirePlainRecord` 只被复用，不改。
- `supervisor.fork`/`controlHeld`（`supervisor.ts:185-192`）、`Forks`（`branching.ts:189-325`）、`ControlClaims`（`turn-control.ts:165-203`）、`store.commitFork`（`store.ts:150,368`）零 diff。
- web 消费方：`forkSession` 发 `Content-Type: application/json` 的 `JSON.stringify({ messageId })`，期望状态 201（`web/src/lib/api-sessions.ts:167-185`）。`parseSession` 要求 id 匹配 `/^[0-9a-f]{32}$/`（`session-contract.ts:76`），与 `Forks#precheck` 的 `randomBytes(16).toString("hex")`（`branching.ts:234`）一致。
- Fastify 5.12.1：`content-length > limit` 不读 body 直接报 `FST_ERR_CTP_BODY_TOO_LARGE`（`content-type-parser.js:244-245`）；空 JSON 与 malformed/原型污染 JSON 分别报 `FST_ERR_CTP_EMPTY_JSON_BODY`、`FST_ERR_CTP_INVALID_JSON_BODY`（`:317-327`）；`text/plain` 按默认 parser 解析成字符串，由 `parseForkMessageId` 拦下。

## Sibling surfaces（必然改动只有一处；其余既有测试零 diff 全绿）
- **会改**：`session-rest-helpers.ts:77-117`。端口加宽后 stub 缺成员会让 `make typecheck` 失败。只允许按 Change surface 加这一个成员。
- **零 diff 且须仍绿**（守卫）：
  - `session-fork.test.ts`、`session-fork-faults.test.ts`：直接调 `supervisor.fork`，其中 REST prompt 注入（`session-fork-helpers.ts:307-312` 的 `expectSourceClaimed`）已是受理前 409，行为不变；
  - `session-rest.test.ts`、`session-stop-rest.test.ts`、`session-regenerate-rest{,-real}.test.ts`、`session-approval-rest.test.ts`、`session-sse*.test.ts`：路由与 `requireOwnedSession` 行为不变；
  - `http-typed-errors.test.ts:51,185`：用伪造 request 直驱 mapper，不挂产品路由，不会 `FST_ERR_DUPLICATED_ROUTE`；
  - `server-assembly.test.ts`：spy 透传 `registerSessions`。
- 生产装配 `sessions/index.ts:51` 把真实 `SessionSupervisor` 交给 `registerSessionRoutes`，结构上满足加宽后的端口。

## Seams under test（全部可在当前代码上执行；不 import `supervisor.ts`/`branching.ts`/`turn-control.ts` 的值，不碰私有字段）
- **Stub 装配**：`withSessionRest`（`session-rest-helpers.ts:43`）。用 `vi.spyOn(fixture.supervisor, "fork")` 控制与观察；造会话用 `store.create`/`acceptPrompt`/`finishTurn`；他人 cookie 用 `cookieFor(app, "zhaoliu")`（`:130`）；行比对用 `persistenceSnapshot`（`session-store-helpers.ts:263`）；无 unhandledRejection 用 `collectRejections`（`session-stop-helpers.ts:172`），先例 `session-regenerate-rest.test.ts:51-61`。
- **请求**：`postSessionAction`/`wireSessionAction`/`onWire`/`expectEnvelope`/`messageSeq`/`MALFORMED_JSON`/`EMPTY_JSON`/`OCTET`（`session-bodyless-rest-helpers.ts:22-32,68-127`）。JSON body 以 `{name, payload: JSON.stringify({messageId}), contentType: "application/json"}` 传入，`BodyInput` 结构兼容；`OVERSIZED_PARSER_INPUT`（`session-rest-helpers.ts:22-26`）只经 inject 发送。
- **真实装配**（生产 `createApp` + 真实 fake-omp `branch`）：`forkWorlds`、`openForkWorld`、`openCappedWorld`、`openForkScripted`、`seedTwoTurns`、`realSource`、`turn`、`rowCounts`、`sessionRowOf`、`messagesOf`、`stepsOf`、`approvalsOf`、`insertApproval`、`listedIds`、`subscribeQuietly`、`FIRST`（`session-fork-helpers.ts`）；`HOLD`、`heldLine`、`held`、`sendPrompt`、`snapshot`、`epochOf`、`sessionFile`、`types`、`promptsAgain`、`QUESTION`、`scriptedAt`（`session-regenerate-helpers.ts`）；`spawnedAt`、`REAL`、`settle`（`session-approval-helpers.ts`）；`expectCapacity`、`expectWithinCap`、`isLive`、`presetSessionFile`（`session-supervisor-pool-helpers.ts`）；`openStopWorld`+`heldTurn`（running 源会话）；`getSessionMessages`（`session-rest-helpers.ts:134`）。
  - 经 REST 发起的 fork 在新文件内本地组合，命名 `postFork`/`restHeldFork`。不得复用 `forkAt`/`expectForkDone`/`expectSourceClaimed`/`heldRegenerate` 这些名字，它们已由 `session-fork-helpers.ts` 导出为 supervisor 层版本。
  - 第五个间隙（临时进程关停未完成）：`openForkScripted(worlds, [{ keepStdout: true }, {}])`，先例 F3（`session-fork-faults.test.ts:182-201`）。等待临时 stdin EOF 的 `tempClosing`（`:63-68`）是文件私有的，在新文件内用 `waitFor` 重写约 5 行。
- **序号 oracle**：`messageSeq(db)` 与 `vi.spyOn(world.fixture.store, "acceptPrompt")` call-through，区分「瞬时写入后回滚」与「从未写入」（同 #467 design「序号 oracle」）。
- **真实 socket**：`withListeningApp`（`raw-http-helpers.ts:17`）配 `fetch`。行、帧与 spy 的断言都在回调内完成。
- **信封**：`BAD_REQUEST_ENVELOPE`/`NOT_FOUND_ENVELOPE`/`UNAUTHORIZED_ENVELOPE`/`INTERNAL_ERROR_ENVELOPE`（`session-db-helpers.ts:18-21`），`SESSION_BUSY_ENVELOPE`/`AGENT_UNAVAILABLE_ENVELOPE`/`UNKNOWN_SESSION_ID`（`session-rest-helpers.ts:14-20`），`expectCapacity`。一律 import，不复制。

## Required evidence
所有响应都断言 `cache-control: no-store`。201 断言 `JSON.parse(payload)` 的键集恰为 `["session","draft"]`，`session` 键集恰为 `id,title,status,createdAt,updatedAt`（无 `parent_session_id`/`omp_session_file`），`draft` 为字符串。

stub 用例中的「无副作用」指：`fork` spy 0 次，`supervisor.calls`/`cursorCalls` 为空，`persistenceSnapshot` 相等。

**`session-fork-rest.test.ts`（stub）**

| ID | 输入 | 期望 |
|---|---|---|
| A1（红） | done 会话，body `{"messageId":7}`；spy 依次 `mockResolvedValue` 四个结果，`session.status` 分别为 idle/done/failed/stopped，其中一个的 `session` 另带 `parent_session_id`/`omp_session_file`/`extra`，顶层另带 `extra` | 每个都是 201，payload 恰为 `JSON.stringify({session:{id,title,status,createdAt,updatedAt},draft})`，多余键不外泄；spy 每次恰 1 次，参数为 `(id, "u1", 7)`；`cursorCalls` 为空 |
| A1b（红） | spy 返回 `deferred()` 的 promise | 几个宏任务后 inject 仍未返回；`resolve()` 后才得到 201 |
| A2（红） | spy 分别 reject：`HttpError("session_busy"/"bad_request"/"agent_unavailable"/"agent_capacity"/"not_found")`、`Error("x")`，以及 `mockImplementation(() => { throw … })` | 依次为 409 `SESSION_BUSY_ENVELOPE`、400、502、`expectCapacity`、404、500 `INTERNAL_ERROR_ENVELOPE`（不回显消息）、500；行不变；无 unhandledRejection |
| A3（红） | 无 cookie × {合法 body、`{`、`OVERSIZED_PARSER_INPUT`} | 401 `UNAUTHORIZED_ENVELOPE`，无副作用 |
| A4（红） | zhaoliu cookie + owner 的 done 会话；owner + `UNKNOWN_SESSION_ID`；各 × {合法 body、`{`、`OVERSIZED_PARSER_INPUT`} | 全部 404，payload 两两逐字节相同，无副作用 |
| A5（红） | done 会话，spy 不 mock（stub 默认拒绝 → 500）；body：`{}`、`{"messageId":"1"}`、`{"messageId":[1]}`、`{"messageId":null}`、`{"messageId":true}`、`{"messageId":1.5}`、`{"messageId":0}`、`{"messageId":-1}`、`{"messageId":9007199254740992}`、`{"messageId":1e400}`、`{"messageId":1,"x":1}`、`{"MessageId":1}`、`[1]`、`null`、`1`、`"x"`、`{"__proto__":{"messageId":1}}`；`text/plain` 的 `{"messageId":1}`；`application/x-www-form-urlencoded` 的 `messageId=1`；`OCTET`；`MALFORMED_JSON`；`EMPTY_JSON`；无 content-type 的 `1`；无 body；`OVERSIZED_PARSER_INPUT`；`{"messageId":1}` 加 1100 个空格（超 1 KiB） | 每个都是 400 `BAD_REQUEST_ENVELOPE`，无副作用；之后把 spy 设为 resolve，同一会话合法 body → 201，spy 1 次 |
| A6（红） | running 会话（只 `acceptPrompt`）× {`{`、`{"messageId":"1"}`} | 400，不是 409；无副作用 |

**`session-fork-rest-real.test.ts`（R1–R5、W1–W2 中的真实 fake-omp 子进程用 `REAL`；R5 第五间隙与 R6 为受控 FakeChild，不用 `REAL`；`forkWorlds()` 管生命周期；`fork` 与 `acceptPrompt` 只做 call-through spy）**

| ID | 输入 | 期望 |
|---|---|---|
| R1（红） | `openForkWorld()`；两次真实 `turn`（FIRST、QUESTION），源进程存活；`insertApproval(db, a1, "r-allow", "allow", 70)`；`presetSessionFile` 到 `realSource()`；`subscribeQuietly`；REST fork u2 | 201，`session` 恰五键：`title` 为 FIRST，`status` 为 done；`draft` 为 QUESTION。新会话的 GET messages 为 u1、a1 两条副本（新 id），a1 副本带原步骤，`approvals` 为一条 `decision:"allow"` 且 `tool/title/requestedAt/expiresAt` 为原值，`streamCursor` 为 `{epoch:0,seq:null}`，响应 session 与 GET 的 `session` 均无 `parent_session_id`。`sessionRowOf(new).parent_session_id` 为源 id，`omp_session_file` 匹配 `/branch-/`。源 `snapshot(withEpoch)` 不变，`unchanged()`，源进程未收到新帧且不再存活，`liveAtSpawn[1]` 为 `[]`。临时进程在 201 时已不存活，`epochOf` 两会话都不变，`subscribeQuietly` 收到 `[]`，`world.events` 长度不变。`GET /api/sessions` 列出两会话，每项恰五键 |
| R2（红） | `seedTwoTurns` 后 REST fork u1；另开 `openForkWorld({entries:[FIRST]})` 且 a1 为 stopped/failed，fork u2，随后对新会话 REST regenerate | 前者 201，`status:"idle"`，`draft` 为 FIRST，新会话 messages 为 `[]`；后者 201，`status` 分别为 stopped/failed，随后 regenerate 为 202，spawn 以 `--resume <新文件>` 进行，回合 done |
| R3（红） | 同一世界（`seedTwoTurns`，另建同 owner 会话）：assistant a1、他会话的 u1、`999999` → 400；`UPDATE … omp_session_file = NULL` 的会话 → 502 `AGENT_UNAVAILABLE_ENVELOPE`。另开世界：#466 R6 的两种对齐失败（`openForkWorld({entries:["other"]})`+`u2Text:"other"` fork u2；`openForkWorld()`+`extraTurn` fork u3）→ 502；`openStopWorld("abort-ok")`+`heldTurn` 的 running 源 fork 其 user 消息 → 409 `SESSION_BUSY_ENVELOPE`（先例 `session-fork.test.ts` R6/R7） | 每个都是 `rowCounts` 与源 `snapshot` 不变，`held` 为 false；预检用例 `rt.calls` 为 0；对齐失败时 stdin 不含 `branch`、临时进程已退出；running 源的子进程 stdin 未结束、帧数不变 |
| R4（红） | `openCappedWorld(1)`，两次真实 `turn` 后源进程存活；REST fork u1 | 201 `status:"idle"`；`liveAtSpawn[1]` 为 `[]`，`expectWithinCap(liveAtSpawn, 1)`；201 时 `liveProcessCount()` 为 0；随后对新会话 REST prompt 以 `--resume <新文件>` spawn，得 202 并完成回合 |
| R5（红） | 四个 `HOLD` 间隙（ready/messages/branch/state）各用 `openForkWorld({hold})`，第五个间隙用 `openForkScripted([{keepStdout:true},{}])` 等临时 stdin EOF；`seedTwoTurns`，REST fork u2 不 await；记下源 `snapshot(withEpoch)`、`rowCounts`、`messageSeq`、临时 stdin 长度、spawn 数；`acceptPrompt` call-through spy；依次注入 REST prompt、REST regenerate、REST fork u2 | 三者都是 409 `SESSION_BUSY_ENVELOPE`；`settle` 后上述快照、计数、序号、stdin 长度与 spawn 数都不变，`acceptPrompt` spy 0 次，`unchanged()`；放行（`gate.release()` 或 `endStdout`+`exit(0)`）后原请求 201，`draft` 为 QUESTION，会话数 +1，`held` 为 false |
| R6（红） | `openForkScripted([{prompt:"hold"},{}], 1)`，另一会话经 REST prompt 持有回合；`seedTwoTurns`；REST fork u2 | `expectCapacity`；`rowCounts` 不变，`held` 为 false，`rt.calls` 为 1；`completeHeldTurn` 后再 fork 得 201 |
| W1（红） | S 为 running（`store.acceptPrompt`，无进程），D 为 `seedTwoTurns`；`fork` call-through spy；`withListeningApp` 下对 S、D 各发 `MALFORMED_JSON`、`EMPTY_JSON`、`OCTET`、`{"messageId":<该会话 user id>}` 加 1100 个空格、`{"messageId":"<id>"}`、`text/plain` 的合法 JSON | 每个都是 `onWire(400, BAD_REQUEST)`（no-store、无 set-cookie）；spy 0 次；两会话 snapshot 不变；`rt.calls` 为 0；CTP 输入得 400 而不是 500，证明 `routeOptions.url` 属于 `errors.ts:56`（carry-forward :3）；`hasRoute({method:"POST",url:"/api/sessions/:id/fork"})` 为 true。随后合法 body：S → 409 `SESSION_BUSY_ENVELOPE`，D → 201 且键集如上；spy 2 次 |
| W2（红） | 无 cookie、zhaoliu + S、owner + 未知 id；各 × {`MALFORMED_JSON`、`EMPTY_JSON`、`OCTET`} | 401 `UNAUTHORIZED_ENVELOPE` 或 404 `NOT_FOUND_ENVELOPE`，带 no-store，spy 0 次，snapshot 不变 |
| G（守卫，恒绿） | Sibling surfaces 所列既有测试 | 除 stub 那一个成员外零 diff，全绿 |

**红/绿**
- **跑红的前提**：先把 `session-rest-helpers.ts` 的 `fork` stub 成员加上，再对 master 源码跑 RED。否则 `vi.spyOn(supervisor, "fork")` 会因成员不存在而抛错，得到的是装配错误，不是红。
- A1–A6 在 master 上的红因：stub 装配里该路径没有路由，返回 Fastify 默认 404。R1–R6、W1–W2 的红因：生产装配里落入 catch-all，返回不带 no-store 的 404/401（R5 在 master 上 fork 不 spawn，`heldLine` 超时）。
- G 恒绿。R1 中「不暴露 `parent_session_id`」与「列表每项恰五键」两项断言在 master 上已成立（proposal 决定 5），因 201 不可达而随 R1 一起红。
- 下列变异各须使对应用例变红。逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| 透传 supervisor 返回的对象 | A1（多余键） |
| 返回 200/202 | A1、R1、W1 |
| 不 await `fork` | A1b、A2 |
| 只查 `typeof messageId === "number"` | A5（`1.5`/`0`/`-1`/`2^53`/`1e400` 触达 spy，stub 默认拒绝得 500） |
| 不查键数 | A5（`{"messageId":1,"x":1}` 得 500） |
| 去掉 `bodyLimit` | A5、W1（空白填充的合法 body：stub 得 500，真实得 201） |
| owner 校验放进 handler，不在 preParsing | A4、W2（带 `{` 时得 400，不是 404） |
| preParsing 换成 `authorizeOwnedBeforeParse` | A1 的 `cursorCalls` 断言 |
| 路径段改动（如 `/forks`） | A1、W1（CTP 输入得 404，`hasRoute` 为 false） |
| 在 handler 内先查 running 返回 409 | A6 不抓（仍 400 在前）；R3 不抓（结局同为 409）。只经代码审查：proposal 决定 1 禁止路由层状态预检 |
| 去掉 no-store | 全部用例 |

## Non-goals
见 proposal Non-goals。

## Review focus
1. 路由模板与 `errors.ts:56` 字面一致；W1 在生产 `createApp` 上经真实 socket 得到的是 CTP 输入的 400，不是 500。
2. 401 → 404 → 400 先于任何 supervisor 调用（含 `streamCursor`）；handler 无 try/catch、无路由层状态预检；201 body 由路由显式构造，`session` 恰五键。
3. `parseForkMessageId` 只放行恰一个键、正安全整数；`FORK_BODY_LIMIT` 的注释写明理由。
4. R5 五个间隙的注入都在受理前 409（`acceptPrompt` 0 次、序号不前进），原 fork 照常 201。
5. `session-rest-helpers.ts` 的 diff 只有 `fork` 一个成员；`rest.ts` 行数（`wc -l`）记入 PR body。
