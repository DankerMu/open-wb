# Design: stop-route（#475）

父设计 D2（`POST /api/sessions/:id/stop`：running → 202 `{}`；非 running → 204；任何 body → 400）与 D6（归属集六 → 十）。本文只写把 D2/D6 落到 `rest.ts` 时，现有代码逼出来的约束（HEAD `8600850`）。

## Change surface
- **`server/src/sessions/rest.ts`**
  - `SessionSupervisorPort`（`:15-19`）加 `stop(sessionId: string): Promise<void>`。
  - 本地常量 `STOP_BODY_LIMIT = 1`，注释照抄 `auth/index.ts:92`（proposal 偏离 4）。
  - 注册 `app.post<{ Params: SessionIdParams }>("/api/sessions/:id/stop", { bodyLimit: STOP_BODY_LIMIT, onRequest: noStoreSessionResponse, preParsing: <专用 hook> }, handler)`。模板字面必须与 `http/errors.ts:54` 逐字一致。
  - 专用 preParsing（同步）只调 `requireOwnedSession(dependencies.store, request)`（`:80-90`）后 `done(null, payload)`，形状同 `authorizeApprovalBeforeParse`（`:110-119`）。
    - 不复用 `authorizeOwnedBeforeParse`（`:98-108`）：它会调 `supervisor.streamCursor`，而 404/400 必须早于任何 supervisor 调用。
  - handler（`async`），依次：
    1. `request.body !== undefined` → `throw new HttpError("bad_request")`，同 logout（`auth/index.ts:252-254`）；
    2. `const tree = requireOwnedSession(dependencies.store, request)`，在 handler 内重读；
    3. `tree.session.status !== "running"` → `return reply.code(204).send()`；
    4. 否则 `await dependencies.supervisor.stop(request.params.id)`，再 `return reply.code(202).send({})`。
  - 第 2–4 步之间不得有 await：判定与 `stop()` 内部的 `runtimeState` 读取（`supervisor.ts:212`）必须处在同一同步段（proposal 偏离 1）。
  - `stop` 必须按属性在请求时调用（`dependencies.supervisor.stop(...)`），不得在注册时解构或 bind，否则测试 spy 失效。
  - 错误不在路由内映射，不用 try/catch，也不按消息嗅探：
    - `HttpError("agent_unavailable")`（关停后，`supervisor.ts:209-211`）原样上抛，得到 502；
    - 同步抛出（`runtimeState` 的 store 故障）与非 `HttpError` 拒绝（Deny 结算失败，#473 偏离 3）都在 async handler 内变成拒绝，经 `handleHttpError`（`http/errors.ts:113-128`）成为 generic 500。
    - 这两类响应都保留 onRequest 设的 no-store。
- **`server/test/session-rest-helpers.ts`**（proposal 偏离 3）：`createSupervisor()` 在 `decide`（`:101-103`）之后加 `stop() { return Promise.reject(new Error("unexpected stop call")); }`。

## Governing invariant
每个 stop 请求恰好落入以下三种结局之一，且都带 route-owned no-store：
- 在任何 supervisor 调用（含 `streamCursor`）、帧与写库之前被拒绝：401 → 404 → 400，依此优先级；
- 同一同步段读到非 running → 204，无 body，没有 supervisor 调用；
- 恰调用一次 `supervisor.stop`，resolve 后返回 202，body 恰为 `{}`；reject 则返回信封（502 或 generic 500）。

## Must preserve
- `requireOwnedSession`/`noStoreSessionHeaders`/`SessionOwnerStore` 的导出与行为（`rest.ts:21-23,73-90`），`sessions/stream/sse.ts:8,76-78` 仍在消费它们。
- 既有五条路由逐字节不变，包括 prompt 的 `acceptPrompt`→`supervisor.prompt`→`rollbackPrompt` 次序（`rest.ts:142-160`）；R4 依赖这条既有补偿。
- `supervisor.stop` 语义不动（`supervisor.ts:207-218`，`turn-control.ts:65`）；`http/errors.ts:47-58` 零 diff。
- web 消费方：`stopSession` 发送无 body、无 content-type 的 POST（`web/src/lib/api-sessions.ts:133-134`），把 204 视为 `"idle"`，把 202 以外的 2xx 视为错误（`:136-142`），并以 `isStopAccepted`（`session-contract.ts:211-213`）严格校验 202 body 恰为 `{}`。
- Fastify 5.12.1 的解析时机：无 content-type 且 `content-length` 为 0 或缺省时不解析，body 为 `undefined`（`handle-request.js`）；有 content-type 时总会跑 parser，所以 `text/plain` 空 body 会解析成 `""`。parser 查找先于 limit 检查（`content-type-parser.js:191-203,241-245`）。
  - 因此 limit 为 1 时，四个 CTP 码都能用 ≤2 字节触发：`{`→INVALID_JSON，空 JSON→EMPTY_JSON，`x` octet-stream→INVALID_MEDIA，`{}`→BODY_TOO_LARGE。
  - 会被解析出来的 body 只有 1 字节的 `1`（json）、`x`/`""`（text/plain），它们由第 1 步拦下。

## Sibling surfaces（必然改动只有一处；其余既有测试零 diff 全绿）
- **会改**：`session-rest-helpers.ts:75-106`。stub 缺 `stop` 会让 `make typecheck` 失败，只允许按 Change surface 加这一个成员。
- **零 diff**：
  - `session-rest.test.ts`、`session-approval-rest.test.ts`：只打既有路由；
  - `session-sse*.test.ts`：`requireOwnedSession` 行为不变；
  - `session-stop*.test.ts`、`session-stop-intent*.test.ts`：直接调 `supervisor.stop`，语义不变；
  - `http-typed-errors.test.ts:48-53,180-189`、`auth-request-errors.test.ts`：用伪造的 request 直驱 mapper，不挂产品路由；
  - `auth-lifecycle.test.ts`（logout，常量本地化不影响）；
  - `server-assembly.test.ts:466`：spy 透传 `registerSessions`。

## Seams under test（全部可在当前代码上执行；不 import `supervisor.ts`/`turn-control.ts`，不碰私有字段）
- **Stub 装配**：`withSessionRest`（`session-rest-helpers.ts:42`）。
  - 会话由 `store.create`/`store.acceptPrompt`/`store.finishTurn(id, "done"|"failed"|"stopped")` 造出（`store.ts:123-137`，`FinishStatus` 含 `stopped`，`:34`）。
  - 观察：`vi.spyOn(fixture.supervisor, "stop")`，用 `mockResolvedValue`、`mockReturnValue(deferred().promise)`、`mockRejectedValue` 或 `mockImplementation(() => { throw … })` 控制；另查 `supervisor.calls`/`cursorCalls` 不增。
  - 他人 cookie：`cookieFor(app, "zhaoliu")`（`:119`）。
  - 行：`sessionRows`/`messageRows`/`sessionRow`（`session-store-helpers.ts:215-233`），比对 `updated_at` 与行数。
- **真实装配**：`openStopWorld`（`session-stop-helpers.ts:53`），即生产 `createApp`→`registerSessions`、真实 fake-omp 与注入时钟。
  - 任意场景：`world.rt.setScenario(...)`，或用 `intentWorlds(true).open(scenario)`（`session-stop-intent-helpers.ts:35`）。后者在文件级挂 afterEach：先 SIGKILL 残留子进程，再 close，并断言无 unhandledRejection；它对 stub 用例同样生效且无害。
  - 复用：`heldTurn`/`afterPrompt`/`abortCount`/`turnEnds`/`expectNoError`/`history`/`listedStatus`/`probeFrames`/`GRACE_MS`（`session-stop-helpers.ts`）、`delayReady`/`handshakeBound`/`PROBED`/`frameTypes`/`ended`（`session-stop-intent-helpers.ts:24-121`）、`spawnedAt`/`settle`/`waitForEvent`/`extraSession`/`prompted`/`ofType`/`sessionEvents`/`REAL`（`session-approval-helpers.ts`）。
  - 调用观察：`vi.spyOn(world.fixture.supervisor, "stop")` 只做 call-through spy，不替换实现。
- **握手时限**：`handshakeBound(world, 1_000)` 是真实 `setTimeout`（`process.ts:700-706`），每次派发都会重读。只要用例在失败后再派发，就必须先 `handshakeBound(world, undefined)` 并 `setScenario`（#605 教训）；R4 不再派发。
- **真实 socket**：`withListeningApp(world.fixture.app, …)`（`raw-http-helpers.ts:17`）配 `fetch`（先例 `session-approval-rest.test.ts:150-165`；那是 test 文件，不能 import，本文件自写一个小 helper）。
  - 行、帧与 spy 的断言都在回调内、`app.close()` 之前完成。
  - `fetch` 无 body 的 POST 会发 `content-length: 0`，与 web 相同。
- **信封**：`BAD_REQUEST_ENVELOPE`/`NOT_FOUND_ENVELOPE`/`UNAUTHORIZED_ENVELOPE`/`INTERNAL_ERROR_ENVELOPE`（`session-db-helpers.ts:18-21`）、`AGENT_UNAVAILABLE_ENVELOPE`/`OVERSIZED_PARSER_INPUT`/`UNKNOWN_SESSION_ID`（`session-rest-helpers.ts:13-25`）。一律 import，不复制（jscpd ≤3%）。

## Required evidence（新建 `server/test/session-stop-rest.test.ts`）
「无副作用」= 以下全部成立：
- stop spy 0 次；
- stub 的 `calls`/`cursorCalls` 不增；
- `sessionRows`/`messageRows` 与请求前快照相等；
  - 例外：真实世界（W1/W2 及任何在持有中的真实回合上做比对的用例）里，持有中回合的 running assistant 在第一个 `text.delta` 时挂了一个真实 `setTimeout(FLUSH_MS=2_000)`（`store.ts:188,619`），触发时会把正文追加进该行 `content`（`store.ts:639-650`）。所以对这一行只比较除 `content` 外的字段（`id`/`session_id`/`role`/`status`/`created_at`，`MessageRow` 见 `session-store-helpers.ts:33-40`；flush 只改 `content`），行数照常比；其余行照常整行比对。这与 #468 `expectUntouched`（`session-approval-rest.test.ts:121-130`）只断言目标字段的先例一致。
- 真实世界里 `abortCount(afterPrompt(stdin)) === 0`。

所有响应都断言 `cache-control: no-store`。202 断言 `payload === "{}"`，204 断言 `payload === ""`。

| ID | 输入 | 期望 |
|---|---|---|
| A1 running（红） | stub；`acceptPrompt` 使会话 running；spy `mockResolvedValue` | 202，`payload === "{}"`；spy 恰 1 次，参数为该会话 id；随后会话仍 running（路由不等回合结束） |
| A1b 等 stop resolve（红） | 同 A1，spy 返回 `deferred()` 的 promise | 几个宏任务后 inject 仍未返回；`resolve()` 后才得到 202 `{}` |
| A2 非 running（红） | stub；四个会话：idle（新建），以及经 `acceptPrompt`+`finishTurn` 结束为 done/failed/stopped 的三个 | 每个都是 204、payload 为空，无副作用（`updated_at` 与消息行数不变） |
| A3 未认证（红） | 无 cookie × {无 body、`{`、`OVERSIZED_PARSER_INPUT`} | 401 `UNAUTHORIZED_ENVELOPE`，无副作用 |
| A4 他人/未知（红） | zhaoliu cookie + owner 的 running 会话；owner cookie + `UNKNOWN_SESSION_ID`；各 × {无 body、`{`、`OVERSIZED_PARSER_INPUT`} | 全部 404，payload 与 content-type 两两相等，无副作用（畸形/超限 body 也得 404，证明先于 parser） |
| A5 body（红） | stub；running 与 done 两个会话 × {`{}` json、`{"x":1}` json、`{` json、空 json、`1` json、`x` text/plain、空 text/plain、`1` 无 content-type、`x` octet-stream、`OVERSIZED_PARSER_INPUT`} | 每个都是 400 `BAD_REQUEST_ENVELOPE`，无副作用；之后同一会话无 body → running 202（spy 1 次）、done 204 |
| A6 stop 故障映射（红） | running 会话；spy 分别设为：同步 `throw new Error("runtimeState fault")`、`mockRejectedValue(new Error("deny settle failed"))`、`mockRejectedValue(new HttpError("agent_unavailable"))` | 依次为 500 `INTERNAL_ERROR_ENVELOPE`（不回显消息）、500 同上、502 `AGENT_UNAVAILABLE_ENVELOPE`；进程级 unhandledRejection 为空 |
| R1 运行中停止 / Stop is accepted（红） | `openStopWorld("abort-ok")`，`heldTurn`；REST stop | 202 `{}`；恰一个 `turn.end{messageId,status:"stopped"}`，无 error；`abortCount(afterPrompt(spawnedAt(0).stdin)) === 1`；`listedStatus === "stopped"`；history 中 assistant 为 `stopped`，且没有 `running` 步骤。随后再 stop → 204，`abortCount` 仍为 1，消息行数与 `updated_at` 不变；`extraSession` 的 idle 会话 stop → 204；spy 恰 1 次。最后 `probeFrames(world) === PROBED`（stopped 会话上的后续 prompt 返回 202 且完成） |
| R2 同一回合二次停止 REST 面（红） | `abort-ignored`，`heldTurn`；REST stop ×2；`clock.advance(GRACE_MS)` | 两次都是 202 `{}`；两次之间与之后 `listedStatus === "running"`、`turnEnds` 为空（202 不等回合结束的确定性证据）；`abortCount === 1`；spy 2 次；advance 后恰一个 `turn.end(stopped)`，无 error |
| R3 派发前停止 REST 面（红） | `slow-ready` + `delayReady(world, 2_000)`；REST prompt 不 await；`waitFor(spawned[0])`；REST stop | stop 返回 202 `{}` 时：`spawnedAt(0).stdin` 为 `[]`，prompt 的 inject 仍 pending。随后 prompt 返回 202，键集恰为 `{userMessageId,assistantMessageId}`；恰一个 `turn.end(stopped)`，无 error；`probeFrames === PROBED` |
| R4 派发前 stop 后获取失败（红） | `no-ready-hang` + `handshakeBound(world, 1_000)`；REST prompt 不 await；`waitFor(spawned[0])`；REST stop | stop 返回 202 `{}` 时：prompt 仍 pending，`spawnedAt(0).stdin` 为 `[]`（锁定「stop 先于失败落地」，补上 #605 test-evidence 中 F1 的缺口）。之后 prompt 返回 502，payload 恰为 `AGENT_UNAVAILABLE_ENVELOPE` 且带 no-store（与 #490 I8 `session-stop-intent-windows.test.ts:227` 同源）；history 的 `messages` 为 `[]`、`session.status === "idle"`（受理对已经 `rollbackPrompt` 删除）；该会话无 `turn.end`、无 `error`；`frameTypes(stdin)` 不含 `abort`；`waitFor(liveProcessCount() === 0)`；最后再 stop → 204；spy 恰 1 次。不再派发，因此不恢复握手时限 |
| W1 真实 socket：bodyless 拒绝（红） | 生产装配：会话 S 先 `heldTurn`（spawned[0]）；随后 `setScenario("normal")`，对 `extraSession` D 执行 `prompted` 并等其 `turn.end` done；spy 之后 `withListeningApp`。S、D 各 × {`{}` json、`{` json、空 json、`x` octet-stream、`1` json、`x` text/plain、空 text/plain} | 回调内：每个请求都是 400 `BAD_REQUEST_ENVELOPE`，无 set-cookie，无副作用（前四个是 CTP 错误，得到 400 而不是 500，证明 `routeOptions.url` 属于 `errors.ts:54` 的归属集）；`hasRoute({method:"POST",url:"/api/sessions/:id/stop"}) === true`。随后无 body 的 fetch：D → 204（body `""`），S → 202（`await text() === "{}"`）；spy 恰 1 次；`waitFor(abortCount === 1)` |
| W2 真实 socket：401/404 先于 parser（红） | 同一类世界，S 为 running；无 cookie、zhaoliu + S、owner + 未知 id；各 × {`{` json、空 json、`x` octet-stream} | 401 `UNAUTHORIZED_ENVELOPE` 或 404 `NOT_FOUND_ENVELOPE`，都带 no-store，无副作用 |
| G 守卫（恒绿） | Sibling surfaces 所列既有测试 | 除 stub 那一个成员外零 diff，全绿 |

**红/绿**
- A1–A6、R1–R4、W1–W2 在 master 上都是红的。stub 装配里该路径没有路由，Fastify 返回默认 404。生产装配里该路径落入 `/api/*` catch-all（`app.ts:172`，`sendNotFound`），返回的 404/401 都不带 no-store。
- 下列变异各须使对应用例变红。逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| 不判 status、总调 stop | A2（spy 次数与 202） |
| owner 校验放进 handler 而不是 preParsing | A4、W2（带 `{` 的他人/未知请求得到 400，而不是 404） |
| 去掉 `request.body !== undefined` 检查 | A5、W1（`1`/`x`/空 text/plain 得到 202/204） |
| 返回 200，或 body 不是 `{}` | A1、R1（payload/status） |
| 不 await stop（fire-and-forget） | A1b（在 resolve 之前就返回 202）、A6（拒绝的情形下仍返回 202，并出现 unhandledRejection） |
| catch stop 错误后返回 202/204 | A6 |
| 去掉 route onRequest no-store | 全部用例的 no-store 断言 |
| 路由参数改名（如 `:sessionId`）或改路径段 | A1、W1 等：`params.id` 缺失时，`getMessages(undefined, …)` 返回 404 或抛出（得到 500），不会是 202/400；改路径段则落入 catch-all 得到 404。`hasRoute` 按路径模式匹配、不看参数名，参数改名时它仍为 true（#468 design 实测），所以 W1 的判据是 CTP 输入得到 400 而不是 500/404，不靠 `hasRoute` |

- 只经代码审查（状态码上不可观察）：
  - 去掉 `bodyLimit: 1`：此时 `{}` 会被解析，再被第 1 步拦下，结果仍是 400；
  - 状态读取与 `stop()` 之间插入 await：竞态窗口无法确定性构造。

## Non-goals
见 proposal Non-goals。另外：S7 类残局下 202 不生效（proposal Open questions）。

## Review focus
1. 路由模板与 `errors.ts:54` 字面一致；W1 在生产 `createApp` 上经真实 socket 得到的是 CTP 输入的 400，不是 500。
2. 优先级为 401 → 404 → 400 → 状态判定，且都先于任何 supervisor 调用（含 `streamCursor`）；404 两两逐字节相同。
3. 状态判定与 `stop()` 在同一同步段内完成（第 2–4 步之间没有 await）；不读 `runtimeState`；handler 为 async，没有 try/catch。
4. 202 body 恰为 `{}`，204 无 body；web 的 `stopSession`/`isStopAccepted` 契约不破。
5. `session-rest-helpers.ts` 的 diff 只有一个 `stop` 成员；`rest.ts` 行数（`wc -l`）记入 PR body。
