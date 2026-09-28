# Design: regenerate-route（#467）

父设计 D3（`POST /api/sessions/:id/regenerate`：任何 body → 400；running/占用中 → 409；形态不符 → 400；202 `{assistantMessageId}`）与 D6（归属集十条）。本文只写把 D3 的 REST 面与「占用中 prompt 受理前 409」落到 `rest.ts` 时，现有代码逼出来的约束（HEAD `31eef0e`）。

## Change surface
- **`server/src/sessions/rest.ts`**
  - `SessionSupervisorPort`（`:15-20`）加两个成员：`regenerate(sessionId: string, ownerId: string): Promise<{ assistantMessageId: number }>` 与 `controlHeld(sessionId: string): boolean`。
  - `STOP_BODY_LIMIT`（`:74-75`）改名为 bodyless 通用名（如 `BODYLESS_BODY_LIMIT`），值 1 与注释不变，stop 路由（`:178`）随之改引用。
  - 注册 `app.post<{ Params: SessionIdParams }>("/api/sessions/:id/regenerate", { bodyLimit, onRequest: noStoreSessionResponse, preParsing: authorizeSessionBeforeParse }, handler)`。
    - 模板字面必须与 `http/errors.ts:55` 逐字一致。
    - preParsing 用 `authorizeSessionBeforeParse`（`:125-133`），不能用 `authorizeOwnedBeforeParse`（`:102-112`）：后者会调用 `supervisor.streamCursor`（`:109`），而 401/404/400 必须早于任何 supervisor 调用。
  - regenerate handler（`async`）依次执行：
    1. `request.body !== undefined` → `throw new HttpError("bad_request")`（同 stop，`:183-185`）；
    2. `const principal = currentPrincipal(request)`；
    3. `const { assistantMessageId } = await dependencies.supervisor.regenerate(request.params.id, principal.id)`；
    4. `return reply.code(202).send({ assistantMessageId })`。
  - handler 的实现约束：
    - body 由路由显式构造，不透传 supervisor 返回的对象，因为 web 的 `parseRegenerateAccepted` 要求键集恰为这一个键（`web/src/lib/session-contract.ts:237-243`）；
    - 不做路由层状态预检（proposal 偏离 8）；
    - 不写 try/catch，不做错误映射：`#control`/`#translate`（`supervisor.ts:328-336,736-746`）已把 omp 错误转成 canonical `HttpError`，非 `HttpError` 在 async handler 中经 `handleHttpError` 成为 generic 500；
    - `regenerate`/`controlHeld` 必须按属性在请求时调用，不得在注册时解构或 bind，否则 spy 失效。
  - prompt handler（`:156-174`）：在 `parsePromptMessage`（`:161`）之后、`acceptPrompt`（`:162`）之前插入 `if (dependencies.supervisor.controlHeld(request.params.id)) { throw new HttpError("session_busy"); }`。
    - 检查、`acceptPrompt` 与 `supervisor.prompt` 的同步前缀之间不得出现 await（proposal 偏离 1）。
- **`server/test/session-rest-helpers.ts`**（proposal 偏离 2）：`createSupervisor()` 在 `stop`（`:106-108`）之后加两个成员：
  - `regenerate() { return Promise.reject(new Error("unexpected regenerate call")); }`；
  - `controlHeld() { return false; }`。

## Governing invariant
- 每个 regenerate 请求都带 route-owned no-store，并恰好落入以下三种结局之一：
  - 在任何 supervisor 调用（含 `streamCursor`）、`branch` 帧与写库之前被拒绝，优先级为 401 → 404 → 400；
  - 恰调用一次 `supervisor.regenerate(id, principal.id)`，resolve 后返回 202，body 恰为 `{assistantMessageId}`；
  - 该调用 reject 后返回信封：409/400/404/502/503，或 generic 500。
- 每个 prompt 请求的优先级为 401 → 404（preParsing）→ 400（parse）→ 409（`controlHeld`）→ `acceptPrompt`（404 复核 / 409 running）。
- 占用中的 prompt 不写任何行，也不消耗 AUTOINCREMENT 序号。

## Must preserve
- `requireOwnedSession`/`noStoreSessionHeaders`/`SessionOwnerStore` 的导出与行为（`rest.ts:22-24,77-94`），`sessions/stream/sse.ts` 仍在消费它们。
- 既有五条路由的行为不变：
  - prompt 的「`acceptPrompt` → `supervisor.prompt` → 拒绝时 `rollbackPrompt`」次序（`:162-168`）不变，只在它之前多一个同步检查。这条补偿仍服务于控制占用以外的所有 supervisor 拒绝：`agent_unavailable`、`agent_capacity`、按回合 `#claims` 的 `session_busy`（`supervisor.ts:302-303` 的 `claimed !== undefined`）与未知错误。移到受理之前的只有控制占用这一种；
  - stop 除常量改名外零行为变化。
- `supervisor.#prompt` 的占用检查（`supervisor.ts:302-305`）不动，它是纵深防御，#465 的测试直接调用 `supervisor.prompt`。
- `supervisor.regenerate`/`controlHeld`（`supervisor.ts:180-192`）、`Regenerations`（`branching.ts:58-82`）、`ControlClaims`（`turn-control.ts:165-203`）零 diff。
- web 消费方：`regenerateSession` 发送无 body、无 content-type 的 POST（`web/src/lib/api-sessions.ts:152-158`，`requestOptions` 只设 credentials/signal，`web/src/lib/api.ts:342-347`），以 202 为期望状态。
- Fastify 解析时机与 CTP 触发输入同 #475 design「Must preserve」：limit 为 1 时，`{`、空 JSON、octet-stream `x`、`{}` 分别触发四个 CTP 码；`1`（json）、`x`/`""`（text/plain）会被解析出 body，由第 1 步拦下。

## Sibling surfaces（必然改动只有一处；其余既有测试零 diff 全绿）
- **会改**：`session-rest-helpers.ts:77-111`。端口加宽后 stub 缺成员会让 `make typecheck` 失败（`server/tsconfig.json` 的 include 含 `test`）。只允许按 Change surface 加这两个成员。
- **零 diff 且须仍绿**（守卫）：
  - `session-regenerate.test.ts:165-186`（R3）与 `session-fork-helpers.ts:306-312`（`expectSourceClaimed`）：在占用期间经 REST 注入 prompt，断言 409 `SESSION_BUSY_ENVELOPE`，并比对行快照。受理前拒绝后结果不变。`snapshot` 不含 `sqlite_sequence`，所以这两处测试也证明不了「无瞬时写入」，要由 P1/R5 证明。
  - `session-rest.test.ts`：prompt 全部用例（stub `controlHeld` 恒 false）。
  - `session-supervisor-claims.test.ts:105-123`：真实 supervisor 上经 REST 的 prompt 期望 202，按回合 claim 的 rejection 仍走受理后补偿，不受本刀影响。
  - `session-stop-rest.test.ts`：只受常量改名影响，行为不变。
  - `session-approval-rest.test.ts`、`session-sse*.test.ts`：路由与 `requireOwnedSession` 行为不变。
  - `http-typed-errors.test.ts:48-53,180-189`：用伪造的 request 直驱 mapper，不挂产品路由。
  - `server-assembly.test.ts:468`：spy 透传 `registerSessions`。

## Seams under test（全部可在当前代码上执行；不 import `supervisor.ts`/`branching.ts`/`turn-control.ts`，不碰私有字段）
- **Stub 装配**：`withSessionRest`（`session-rest-helpers.ts:43`）。
  - 用 `vi.spyOn(fixture.supervisor, "regenerate" | "controlHeld")` 控制与观察；
  - 用 `vi.spyOn(fixture.store, "acceptPrompt")` 做 call-through 观察，`rest.ts:162` 按属性调用；
  - 造会话：`store.create`/`acceptPrompt`/`finishTurn`；他人 cookie 用 `cookieFor(app, "zhaoliu")`；
  - 行比对用 `sessionRows`/`messageRows`（`session-store-helpers.ts:215-233`）。
- **真实装配**：`openRegenWorld`、`regenWorlds`、`seedDone`、`HOLD`、`heldLine`、`snapshot`、`epochOf`、`sessionFile`、`types`、`waitDead`、`answered`、`promptsAgain`、`QUESTION`、`P`，均来自 `session-regenerate-helpers.ts`，生产 `createApp` 装配加真实 fake-omp `branch`；另用 `spawnedAt`（`session-approval-helpers.ts:276`）取每个子进程的 stdin 记录。
  - 经 REST 发起的 held regenerate 在新文件内本地组合，命名为 `restHeldRegenerate`：`openRegenWorld({hold})` + `seedDone` + REST regenerate 不 await + `heldLine`。不得复用 `heldRegenerate` 这个名字：`session-fork-helpers.ts:267` 已导出同名的 supervisor 层版本（签名 `(worlds, hold)`），`session-regenerate.test.ts:52` 另有一个文件私有版本。
  - 池满：本地组合 `scriptedRuntime` 与 `openRecordingSession({...rt.runtime, maxProcesses: 1})`，先例 `session-regenerate-faults.test.ts:41-47,119-137`；断言用 `expectCapacity`（`session-supervisor-pool-helpers.ts:179`）。这是受控 FakeChild 运行时，不是真实 fake-omp 子进程，不需要 `REAL` 超时。
- **序号 oracle**：`SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'`。`chat_messages.id` 为 AUTOINCREMENT（`034_chat_turn_control.sql:43-44`，RENAME 后行名随表名），受理后再回滚会使 seq 前进 2。它与 `acceptPrompt` spy 一起，是唯一能区分「瞬时写入」与「从未写入」的观察点。它的鉴别力体现在变异表第 1 行（去掉检查）：真实世界 R5 里被注入的 prompt 仍得 409，行快照也仍相等（受理后被 supervisor 拒绝并回滚），只有 spy 为 1 次、seq 前进 2。它的鉴别力不来自 master 上的红：master 上 R5 在更早处就红了（见「红/绿」）。
- **同步段 oracle（微任务探针）**：`controlHeld` 返回 false 时，在其调用内 `queueMicrotask` 记下 `acceptPrompt` spy 的调用次数：
  ```ts
  controlHeld.mockImplementation(() => { queueMicrotask(() => seen.push(acceptSpy.mock.calls.length)); return false; });
  ```
  检查与 `acceptPrompt` 之间没有 await 时，`acceptPrompt` 在这个微任务之前同步执行，`seen` 为 `[1]`；插入任何 await 后，续体排在该微任务之后，`seen` 为 `[0]`。
- **真实 socket**：`withListeningApp`（`raw-http-helpers.ts:17`）配 `fetch`。行、帧与 spy 的断言都在回调内完成，先例 `session-stop-rest.test.ts:531-593`。
- **体输入与请求 helper**：`session-stop-rest.test.ts` 里的 `WIRE_BODIES`/`INJECT_BODIES`/`headersFor`/`wireStop` 是测试文件私有，不能 import。在新建 helper `server/test/session-bodyless-rest-helpers.ts` 中按路由参数化重写一份，供本刀使用，#469 也可复用；不改 stop 测试。
- **信封**：`BAD_REQUEST_ENVELOPE`/`NOT_FOUND_ENVELOPE`/`UNAUTHORIZED_ENVELOPE`/`INTERNAL_ERROR_ENVELOPE`（`session-db-helpers.ts:18-21`），`SESSION_BUSY_ENVELOPE`/`AGENT_UNAVAILABLE_ENVELOPE`/`OVERSIZED_PARSER_INPUT`/`UNKNOWN_SESSION_ID`（`session-rest-helpers.ts:14-26`），`expectCapacity`。一律 import。

## Required evidence
所有响应都断言 `cache-control: no-store`。202 断言 `JSON.parse(payload)` 的键集恰为 `["assistantMessageId"]`，值为安全整数。

stub 用例中的「无副作用」指：`regenerate` spy 0 次，`supervisor.calls`/`cursorCalls` 为空，行快照相等。

**`session-regenerate-rest.test.ts`（stub）**

| ID | 输入 | 期望 |
|---|---|---|
| A1（红） | done/failed/stopped 三个会话（`acceptPrompt`+`finishTurn`）；spy `mockResolvedValue({assistantMessageId: 41})`；另一例返回 `{assistantMessageId: 7, extra: 1}` | 每个都是 202，payload 恰为 `{"assistantMessageId":41}`；多余键不外泄，payload 恰为 `{"assistantMessageId":7}`；spy 每次恰 1 次，参数为 `(id, "u1")`；`supervisor.cursorCalls` 为空 |
| A1b（红） | spy 返回 `deferred()` 的 promise | 几个宏任务后 inject 仍未返回；`resolve()` 后才得到 202 |
| A2（红） | spy 分别 reject：`HttpError("session_busy"/"bad_request"/"agent_unavailable"/"agent_capacity"/"not_found")`、`Error("x")`，以及 `mockImplementation(() => { throw … })` | 依次为 409 `SESSION_BUSY_ENVELOPE`、400、502、`expectCapacity`、404、500 `INTERNAL_ERROR_ENVELOPE`（不回显消息）、500；行不变；无 unhandledRejection |
| A3（红） | 无 cookie × {无 body、`{`、`OVERSIZED_PARSER_INPUT`} | 401 `UNAUTHORIZED_ENVELOPE`，无副作用 |
| A4（红） | zhaoliu cookie + owner 的 done 会话；owner + `UNKNOWN_SESSION_ID`；各 × {无 body、`{`、`OVERSIZED_PARSER_INPUT`} | 全部 404，payload 两两逐字节相同，无副作用 |
| A5（红） | running 与 done 两个会话 × `INJECT_BODIES`（`{}`、`{"x":1}`、`{`、空 json、`1` json、`x`/空 text/plain、`1` 无 content-type、octet-stream、超限） | 每个都是 400 `BAD_REQUEST_ENVELOPE`，无副作用；之后把 spy 设为 `mockResolvedValue({assistantMessageId: 41})`，同一会话无 body → 202，spy 1 次（stub 默认拒绝，不 mock 会得到 500） |
| P1（红） | done 会话；`controlHeld` spy `mockReturnValue(true)`；有效 prompt | 409 `SESSION_BUSY_ENVELOPE`；`acceptPrompt` spy 0 次；`supervisor.calls` 为空；行快照与 `chat_messages` seq 均不变；`controlHeld` 以该会话 id 被调用。之后改为 `mockReturnValue(false)`，同一 prompt → 202 |
| P2（红） | running 会话 + `controlHeld` 为真 | 409；`acceptPrompt` spy 0 次（master 上为 1 次） |
| P5（红） | done 会话；`controlHeld` 按「同步段 oracle」的探针实现，返回 false；`acceptPrompt` call-through spy；有效 prompt | 202；`seen` 恰为 `[1]`；`controlHeld` 恰 1 次 |
| P3（守卫，恒绿） | `controlHeld` 为真时：body 非法 → 400；zhaoliu → 404；无 cookie → 401 | 优先级如 Governing invariant；404/401 时 `controlHeld` 未被调用 |
| P4（守卫，恒绿） | 「REST prompt 受理与补偿」父文增量：stopped 会话 prompt；stub prompt reject `agent_capacity`（从 idle/done/failed/stopped 出发）；`agent_capacity` 叠加回滚删除被 authorizer 拒绝（先例 `session-rest.test.ts:637-672`） | 202；`expectCapacity`，并恢复原 title/status/updatedAt/history，受理对被删除；generic 500，不是 503 |

**`session-regenerate-rest-real.test.ts`（R1–R5、W1–W2 为真实 fake-omp 子进程，用 `REAL`；R6 为受控 FakeChild，不用 `REAL`；`regenWorlds()` 管生命周期）**

| ID | 输入 | 期望 |
|---|---|---|
| R1（红） | `answered(world)`，得到活进程与真实步骤；REST regenerate 无 body | 202，id 大于旧 assistant id，且等于回合结束后 history 末条 id；`spawnedAt(0).stdin` 新增帧类型恰为 `get_branch_messages`、`branch{entryId:"fake-entry-2"}`、`get_state`、`prompt{message:QUESTION}`；旧行及其步骤已删除；`sessionFile` 匹配 `/branch-/`；回合 `done`，messages 为 user(QUESTION) → assistant(done) |
| R1b（红） | `seedDone` 的 failed/stopped 变体（`finishTurn(id, "failed"/"stopped")` + `presetSessionFile(P)`） | 各 202，回合完成 `done` |
| R2（红） | `seedDone`；GET messages 读 `streamCursor.epoch=E`；`supervisor.subscribe` 收集 live；REST regenerate | 202；spawn 以 `--resume P`；`epochOf` 为 E+1；live 恰一个 `turn.start`，末个为 `turn.end{messageId:<202 id>,status:"done"}`；之后 GET messages 的 `streamCursor.epoch === E+1` |
| R3（红） | 同一世界：running（只 `store.acceptPrompt`）、idle（`createSession`）、末条为 user（同 #465 R7 的 SQL 造法）；另开 `openRegenWorld({entries:["other"]})`+`seedDone` | 依次为 409 `SESSION_BUSY_ENVELOPE`、400、400，`snapshot(db, s, true)` 不变，`rt.calls` 为 0；mismatch 为 502 `AGENT_UNAVAILABLE_ENVELOPE`，stdin 不含 `branch`，snapshot 不变，`waitDead(0)` 后 `promptsAgain` 为 202 |
| R4（红） | `restHeldRegenerate(HOLD.state)`；两种改写各执行一次，写法同 #465 R6（`session-regenerate.test.ts:257-296`）：`status` 改为 running，或插入一条更新的 assistant；放行 gate | 原 REST 请求为 409 `SESSION_BUSY_ENVELOPE`；snapshot 等于改写后的状态；`waitDead(0)`；`controlHeld` 为 false；撤销改写后 `promptsAgain` 为 202 |
| R5（红） | 对 `HOLD.ready/messages/branch/state` 各执行一次 `restHeldRegenerate(hold)`；记下 snapshot(withEpoch)、seq、stdin 长度与 spawn 数；`acceptPrompt` call-through spy；依次注入 REST prompt 与 REST regenerate | 两者都是 409 `SESSION_BUSY_ENVELOPE`；`settle` 后 snapshot、seq（去掉检查的变异下前进 2）、stdin 长度与 spawn 数都不变（seq 的鉴别力见「序号 oracle」）；`acceptPrompt` spy 0 次。放行 gate 后原请求 202，其 id 为回合完成后的末条 id，`controlHeld` 为 false |
| R6（红） | 池满（受控 FakeChild，`scriptedRuntime([{prompt:"hold"},{}])`）：`maxProcesses: 1`，另一会话经 REST prompt 持有回合（`{prompt:"hold"}`）；`seedDone`；REST regenerate | `expectCapacity`；snapshot 不变；`controlHeld` 为 false；spawn 数 1 |
| W1（红） | S 为 running（`store.acceptPrompt`），D 为 `seedDone`；`regenerate` call-through spy；`withListeningApp` 下对 S、D 各发 `WIRE_BODIES` 中每一项 | 每个都是 400 `BAD_REQUEST_ENVELOPE`，带 no-store，无 set-cookie；spy 0 次；snapshot 不变；`rt.calls` 为 0。其中 CTP 输入得 400 而不是 500，证明 `routeOptions.url` 属于 `errors.ts:55`（carry-forward :3）；`hasRoute` 为 true。随后无 body 请求：S → 409 `SESSION_BUSY_ENVELOPE`，D → 202 且键集恰为 `assistantMessageId`；spy 2 次；回调内等 D 的回合 `done` |
| W2（红） | 无 cookie、zhaoliu + S、owner + 未知 id；各 × {`{`、空 json、octet-stream} | 401 `UNAUTHORIZED_ENVELOPE` 或 404 `NOT_FOUND_ENVELOPE`，带 no-store，spy 0 次，snapshot 不变 |
| G（守卫，恒绿） | Sibling surfaces 所列既有测试 | 除 stub 那两个成员外零 diff，全绿 |

**红/绿**
- **跑红的前提**：先把 `session-rest-helpers.ts` 的两个 stub 成员（`regenerate`、`controlHeld`）加上，再对 master 源码跑 RED。否则 `vi.spyOn(supervisor, "controlHeld" | "regenerate")` 会因成员不存在而抛错（"does not exist"），得到的是装配错误，不是红。
- A1–A5、R1–R4、R6、W1–W2 在 master 上的红因：stub 装配里该路径没有路由，返回 Fastify 默认 404；生产装配里落入 catch-all，返回不带 no-store 的 404/401。
- R5 在 master 上的红因：held regenerate 经 REST 发起，master 没有该路由，请求落入 catch-all 404，不会 spawn，`heldLine` 超时。它在 master 上根本走不到 prompt 注入，所以不能拿来证明 seq oracle 的鉴别力，那由变异表第 1 行证明。
- P1 在 master 上首先红在状态码：`rest.ts` 不调用 `controlHeld`，prompt 被受理，stub 的 prompt resolve，得到 202 ≠ 409。
- P2 在 master 上红在 `acceptPrompt` spy 次数：running 会话本来就由 `acceptPrompt` 返回 409，但 spy 为 1 次，不是 0 次。
- P5 在 master 上红在 `seen` 为 `[]`：master 不调用 `controlHeld`。
- P3/P4/G 恒绿。
- 下列变异各须使对应用例变红。逐一临时施加，失败输出记入 PR body：

| 变异 | 变红用例 |
|---|---|
| 去掉 prompt 的 `controlHeld` 检查 | P1（202）、P2（spy 次数）、P5（`seen` 为 `[]`）、R5（仍 409、行快照相等，但 `acceptPrompt` spy 1 次、seq 前进 2） |
| 检查挪到 `acceptPrompt` 之后 | P1、P2、R5（`acceptPrompt` spy 次数；P1/R5 另有 seq 前进） |
| 检查与 `acceptPrompt` 之间插入任何 `await` | P5（`seen` 为 `[0]`）。P1/R5 抓不到：请求到达前占用已为真，有无 await 都是 409 |
| owner 校验放进 handler，不在 preParsing | A4、W2（带 `{` 时得 400，不是 404） |
| preParsing 换成 `authorizeOwnedBeforeParse` | A1、A5 的 `cursorCalls` 断言。A3 抓不到：root guard 本身是 preParsing hook（`server/src/http/guard.ts:36`），401 先于路由 hook。A4 也抓不到：`requireOwnedSession`（`rest.ts:108`）在 `streamCursor` 之前就抛 404 |
| 去掉 `request.body !== undefined` 检查 | A5、W1（`1`/`x`/空 text/plain 触达 supervisor） |
| 透传 supervisor 返回的对象，或返回 200/201 | A1（`extra` 键、状态码） |
| 不 await regenerate | A1b、A2 |
| 路径段或参数名改动 | A1、W1（CTP 输入得 500/404，不是 400） |
| 去掉 no-store | 全部用例 |

- 只经代码审查（状态码上不可观察）：去掉 `bodyLimit`，此时 `{}` 会被解析，再被第 1 步拦下，结果仍是 400。

## Non-goals
见 proposal Non-goals。

## Review focus
1. prompt 检查的位置在 `parsePromptMessage` 之后、`acceptPrompt` 之前，中间无 await（由 P5 的微任务探针证明）；「去掉检查」变异下 R5 确实只靠 `acceptPrompt` spy 与 seq 变红。
2. regenerate 路由模板与 `errors.ts:55` 字面一致；W1 在生产 `createApp` 上经真实 socket 得到的是 CTP 输入的 400，不是 500。
3. 401 → 404 → 400 先于任何 supervisor 调用（含 `streamCursor`）；handler 无 try/catch、无路由层状态预检；202 body 由路由显式构造。
4. `session-rest-helpers.ts` 的 diff 只有那两个成员，其中 `controlHeld` 返回 false；`rest.ts` 行数（`wc -l`）记入 PR body。
5. spec 引注里的每处裁剪，其去向（#469 或偏离 4）在归档对账时可追溯。
