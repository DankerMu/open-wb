# Design: approval-snapshot（#476）

父设计 D5（快照 `approvals` 形状，作答 200 与快照元素同形）、D6（`approvals` 键与 `approval.*` 事件跨端同刀）、「模块拆分」（`stream-approvals.ts` 新建，`stream.ts` 不拆）。这里只写落到现有代码时被逼出的约束。

## Change surface
- **`server/src/sessions/store-approvals.ts`**：新增快照投影（名称自定，如 `approvalsBySession(db, sessionId, decoder)` → `Map<messageId, 元素[]>`）。
  - 一条 SQL：`chat_approvals` JOIN `chat_messages`，条件 `m.session_id = ? AND m.role = 'assistant'`，`ORDER BY a.id ASC`（proposal 偏离 4）。
  - `tool`/`title` 用 `CAST(... AS BLOB)` 加 `createSqliteTextDecoder` 解码，与 `settlePendingApproval` 相同（`:85-86`、`:107-119`）。
  - 输出恰六键 `{id, tool, title, requestedAt, expiresAt, decision}`，数值经 `Number()`，`decision` 为 `null` 或 `allow|deny|timeout`。
- **`server/src/sessions/store.ts`**（proposal 偏离 1）：
  - 定义并导出可空 decision 的元素类型；`ApprovalView`（`:96-103`）改为与它同形，推荐 `extends` 后把 `decision` 收窄为非 null；
  - `MessageView`（`:55-62`）加 `approvals`；
  - `getMessages`（`:229-269`）对该会话调用一次投影，在 `:266` 的 view 上挂 `approvals: byMessage.get(id) ?? []`。
- **`server/src/sessions/store-branch.ts:36`**：返回类型改为 `Omit<MessageView, "steps" | "approvals">`，只改这一行。
- **`server/src/sessions/rest.ts`**（proposal 偏离 2）：
  - `PublicMessage`（`:48-55`）加 `approvals`；
  - `toPublicHistory`（`:231-255`）按 `message.approvals.map(toPublicApproval)` 投影；
  - `toPublicApproval`（`:257-266`）的参数与返回类型放宽到可空元素类型，函数体不动；
  - `authorizeOwnedBeforeParse`（`:101-111`）不动：`approvals` 在 `getMessages` 的 tree 里，自然与 `streamCursor` 同栈捕获。
- **`web/src/lib/session-contract.ts`**：
  - `ChatMessage`（`:24-31`）加 `approvals: ChatApproval[]`；
  - `parseMessage`（`:137-159`）键集加 `approvals`，交给一个 helper：`parseJsonArray(value, parseApproval)`（`parseJsonArray` 在 `web/src/lib/api-json.ts`，`parseApproval` 在 `session-contract.ts:232-250`，均为 #472 已有）→ `id` 严格递增 → `role === "user"` 时长度必须为 0。拆成 helper 是为了守住 biome 认知复杂度 ≤15。`ChatApproval` 保持模块私有（knip）。
- **`web/src/features/chat/stream-approvals.ts`**（新建）：
  - 视图元素类型 `{id, tool, title, expiresAt, decision}`，可写作 `Omit<ChatMessage["approvals"][number], "requestedAt">`；
  - 快照 → 视图映射；
  - 两个 payload 解码器：`hasExactlyKeys` 严格键集；`messageId`/`approvalId`/`expiresAt` 为安全整数，`tool`/`title` 为字符串；resolved 的 `decision ∈ allow|deny|timeout`，不含 null；
  - 两个纯归约：对 `M extends { approvals: View[] }` 泛型，不依赖 `stream.ts` 的非导出类型；未变化时返回同一引用。
  - 对 `stream.ts` 只能有 `import type`，不得值导入（无环）。
- **`web/src/features/chat/stream.ts`**，只增接线，预算 722 → ≤770：
  - 事件联合（`:37-43`）与 `DATA_EVENTS`（`:68-75`）各加两类，监听经 `:274` 的既有 filter 自动注册；
  - `applyChatEvent`（`:104-143`）加两个 case，经 `replaceAssistant` 调用归约，不传 `sessionStatus`（proposal 偏离 5）；
  - `decodeEvent`（`:607-622`）加两个 case；
  - `ChatMessageView`（`:18-25`）加 `approvals`；`chatStateFromSnapshot`（`:83-101`）映射；`turn.start` 字面量（`:109-116`）与 `emptyAssistant`（`:208-217`）置 `[]`。

## Governing invariant
server 每条消息恒有 `approvals`：按 `id` 升序、恰六键、只含本会话 assistant 消息的行，user 消息恒为 `[]`，与 `streamCursor` 同一次 preParsing 捕获；作答 200 body 与快照元素由同一个六键投影产生。web 严格接受这个形状并拒绝一切偏离。审批事件只按 `approvalId` 增改，从不覆盖其它项；`approval.resolved` 从不补建审批；未变化时返回同一引用。`approval.request` 指向快照中不存在的 assistant 时，沿用 `replaceAssistant` 对其它 assistant 事件（`text.delta`/`step.start`）的既有语义：补建该 assistant，并带上这一条 pending 审批。

## Must preserve
- `requireOwnedSession`/`noStoreSessionHeaders` 签名与 401/404 行为（`rest.ts:81-93`）：
  - stop 路由在 preParsing 与 handler 两处调用它（`:179`、`:186`），handler 读 `tree.session.status`；
  - 审批路由在 preParsing 调用（`:119`）；
  - `stream/sse.ts` 也调用它。
  这几处的 tree 都会多出 `approvals`，但都不使用它。
- 审批路由注册与 handler（`rest.ts:194-204`）逐字节不变；200 body 仍是六键（`session-approval-rest.test.ts` E1 用 `toStrictEqual` 守护）。
- `SessionOwnerStore`（`rest.ts:22-24`）与 `SessionSupervisorPort`（`:15-20`）不变，`session-rest-helpers.ts` 因此零 diff。
- web 未知事件类型仍忽略（`chat-stream-recovery.test.ts:392` 的 `future.event`）；`step.end` 不放宽；`api-sessions.ts` 只 `import type` 自 `api.js`。

## Sibling surfaces（必然破坏的既有断言与允许改动）
允许改动一律是：往既有消息 DTO 或视图字面量里插入 `approvals: []`；兄弟键 `steps` 写作 `[] as []` 的地方同样写 `approvals: [] as []`。不删、不放宽任何断言，不改其它值。
- **server**（`toEqual` 精确比对消息对象，缺 `approvals` 即红）：
  - `session-store.test.ts:58`（it `:19`）：`:69` user、`:77` assistant；
  - `session-rest.test.ts:158`（it `:127`）：`:169`、`:177`、`:185`、`:193`；
  - `session-rest.test.ts:722`（it `:696`）：`:733`、`:741`、`:749`、`:757`；
  - `session-snapshot.test.ts:119`（it `:105`）：`:130`、`:138`；
  - `session-store-stopped.test.ts:170`（it `:149`）：`:181`、`:189`。
  零 diff：`session-rest.test.ts:74`（`messages: []`）、`:468`/`:662`（DB 行）、`session-snapshot.test.ts:27`（`toMatchObject`）、`session-supervisor-pool.test.ts:130`（两侧都来自 `getMessages`）、`session-stop-intent-windows.test.ts:174`，以及全部 `session-approval*`/`session-sse*`/`session-stop*` 测试。
- **web**（严格解析拒绝缺键的 DTO，`toEqual` 比对视图，TS 类型要求字段存在）：
  - `chat-stream-support.ts`：`:22` `historyUser`（`as []`）、`:31` `userView`（`as []`）、`:67` `chatSnapshot` 的 assistant；
  - `chat-stream.test.ts`：DTO `:27`（`as []`）、`:67`；视图 `:36`（`as []`）、`:116`、`:142`、`:203`、`:229`、`:265`、`:285`、`:313`、`:341`、`:448`；
  - `chat-stream-connection.test.ts`：DTO `:28`；视图 `:113`、`:121`；
  - `chat-stream-stopped.test.ts`：视图 `:61`、`:88`；
  - `api-sessions.test.ts`：`:47`、`:55`、`:237`、`:245`。`:345` 在「a missing nested message field」拒绝用例里，**不改**，它必须继续被拒绝。基准 `snapshot` 加上 `approvals` 之后，展开它的各条拒绝用例才仍是因各自声明的原因被拒；
  - `api-turn-control.test.ts`：`:268`、`:276`；
  - `chat-page-ownership-support.ts`：`:92`、`:100`、`:117`、`:125`、`:161`；
  - `chat-page-ownership-gaps.test.tsx`：`:58`（`as []`）、`:75`、`:83`、`:194`、`:202`、`:238`、`:246`、`:336`、`:344`；
  - `chat-page-lifecycle.test.tsx`：`:61`。
  其余 web 测试经 `chatSnapshot`/`historyUser`/`userView` 间接获得该键，零 diff。上表是按 `role:` 字面量与 `toEqual` 调用点 grep 出的清单。实现后若 `npm test`/`make typecheck` 暴露清单外的破坏，只允许同一种插入，并在 PR body 列出多出的行号。
- 生产消费者：`conversation-view.tsx` 只读已有字段，零 diff；审批条渲染归 #480。smoke（`smoke/chat.hurl:44-45` jsonpath）与 ui-walk 不受影响。

## Seams under test
- **server**，新建 `server/test/session-approval-snapshot.test.ts`（≤800 行）。不 import `store-approvals.ts`/`approvals.ts`，不碰私有字段。
  - 确定性层：`withSessionRest`（`session-rest-helpers.ts:42`，store 无 `emit`）。
    - 造行用公开的 `store.insertApproval(sessionId, {requestId, tool, title}, requestedAt)`（只在 assistant running 时成功）。
    - 已结算行由夹具直接 `UPDATE chat_approvals SET decision=?, decided_at=? WHERE id=?`（#464 先例）。
    - 终态用 `store.finishTurn`；读取用 `getSessionMessages`/`cookieFor`；捕获钩子用 `supervisor.onStreamCursor`（`session-snapshot.test.ts:105-149` 先例）。
  - 真实层：`openApprovalWorld("approval"|"approval-parallel")`（`session-approval-helpers.ts:85`）、`pendingApproval`（`:393`）、`waitForRows`（`:246`）、`world.clock.advance`、`waitForTurn(world.fixture, …)`（`session-supervisor-helpers.ts:510`）；inject GET messages 与 `POST /api/sessions/:id/approvals/:approvalId` 带 `world.cookie`。
  - 元素一律对 `response.json()` 用 `toStrictEqual`，不走 `expectWorkspaceResponse`（`toEqual`）：`toStrictEqual` 还会拒绝值为 `undefined` 的多余键，也让元素断言不依赖共享 helper。
  - 夹具只在新测试文件内自带：已结算行用内联 SQL 写入，不给 `session-approval-helpers.ts`/`session-rest-helpers.ts` 加 helper。
- **web**，新建 `web/test/chat-stream-approvals.test.ts`（≤800 行）。
  - 解析经 `createApiClient().getMessages` + `vi.stubGlobal("fetch")` + `jsonResponse`/`captureApiError`/`expectRequestFailure`（`support.ts`；先例 `api-turn-control.test.ts:262-305`）。
  - 归约经 `chatStateFromSnapshot`/`applyChatEvent`，输入 `deepFreeze`（先例 `chat-stream.test.ts:43`）。
  - 连接器经 `connectChat`/`FakeEventSource.emitData`/`emitOpen`（`chat-stream-support.ts:193-273`），安装首个快照同 `chat-stream-stopped.test.ts:36-42`。
  - 带审批的快照由新测试文件自建：展开 `chatSnapshot()` 后替换 `messages`，或写自己的字面量。`chat-stream-support.ts` 只允许「Sibling surfaces」里的三处插入，不加选项、不加 helper。

## Required evidence
常量：`T=1_700_000_000_000`、`E=T+60_000`、`TITLE_U="Allow tool: bash\nCommand: echo 中文 😀\u0000尾"`。

**server**
| ID | 输入 | 期望 |
|---|---|---|
| S1 无记录（红） | 会话一轮 user/assistant，`finishTurn(done)`，无审批行；GET | 200 + no-store；两条消息 `Object.keys(...).sort()` 恰为 `["approvals","content","createdAt","id","role","status","steps"]`，`approvals` 均 `toStrictEqual([])` |
| S2 单 pending 六键（红） | running 回合 `insertApproval({requestId:"r1",tool:"bash",title:TITLE_U}, T)`；GET | assistant `approvals` `toStrictEqual([{id,tool:"bash",title:TITLE_U,requestedAt:T,expiresAt:E,decision:null}])`（不含 `requestId`/`decidedAt`/`messageId`）；user `[]` |
| S3 id 序与独立决定（红） | 同一 assistant 先插 r1 于 T+5000、再插 r2 于 T（id 大而 requestedAt 小）；SQL 把 r2 置 `deny` | `[{id:r1,…,requestedAt:T+5000,decision:null},{id:r2,…,requestedAt:T,expiresAt:E,decision:"deny"}]`，严格按 id 升序（按 `requested_at` 排序的变异变红） |
| S4 历史决定（红） | 第一轮：插行后 SQL 置 `deny`，再 `finishTurn(done)`；第二轮：插两行，分别置 `allow`、`timeout`，再 `finishTurn(done)` | 第一轮 assistant `approvals[0].decision==="deny"`；第二轮为 `["allow","timeout"]`；两条 user `[]` |
| S5 不泄露（红） | 同 owner 两会话 A、B 各一行；再 SQL 直接向 A 的 **user** 消息插一行 `chat_approvals` | GET A 只含 A assistant 的行，A user 仍 `[]`；GET B 只含 B 的行（去掉 `role='assistant'` 过滤的变异使 A user 非空，变红） |
| S6 preParsing 同栈捕获（红） | A 有 pending 行；`supervisor.onStreamCursor` 回调内 SQL 把该行置 `allow` 再返回游标；GET 两次 | 第一次响应该元素 `decision:null`（tree 先于游标捕获，handler 不重读），第一次 GET 之后 `cursorCalls` 恰为 `[A]`；第二次响应为 `decision:"allow"`，此时 `cursorCalls` 为 `[A,A]`；两次均 no-store |
| S7 真实挂起 + 作答同形（红） | `approval`：`pendingApproval`，GET；POST `{decision:"allow"}` 得 body B；`waitForTurn(done)` 后再 GET | 第一次：user `[]`，assistant `toStrictEqual([{id:row.id,tool:"bash",title:TITLE,requestedAt:T,expiresAt:T+TTL_MS,decision:null}])`，会话 running；第二次：assistant `approvals` `toStrictEqual([B])`，`B.decision==="allow"` |
| S8 拒绝历史（红） | `approval`：pending → POST deny 得 B → `waitForTurn(done)` → GET | `approvals` `toStrictEqual([B])`，`decision:"deny"` |
| S9 超时（红） | `approval`：pending → `world.clock.advance(TTL_MS)` → `waitForTurn(done)` → GET | `approvals[0]` `toStrictEqual({…,decision:"timeout"})` |
| S10 并行（红） | `approval-parallel`：`waitForRows(world,2)` 与两条 `approval.request` 后 GET；POST 第二条 allow 后 GET；POST 第一条 deny 后 GET | 依次为 `[null,null]`、`[null,"allow"]`、`["deny","allow"]`，id 严格升序；最终回合 `done` |
| S11 守卫（恒绿） | 既有 server 全量 | 除「Sibling surfaces」允许清单外零 diff 全绿；`session-approval-rest.test.ts` 零 diff（200 六键不变）。「Approval answer, snapshot and settled conflict」中恢复的超时 WHEN/THEN，除快照面（S9）之外的三个子句（该行读为 `timeout`、子进程收到 `Approve`、发布 `approval.resolved{decision:"timeout"}`）由既有 `server/test/session-approvals.test.ts:156` R4 证明，已在 master 上为绿 |

**web**
| ID | 输入 | 期望 |
|---|---|---|
| W1 解析通过（红） | 快照含 stopped 会话/消息/步骤；user `[]`；assistant A `[]`；B 单 pending；C 两条 `[{id:7,decision:"timeout"},{id:8,decision:null}]` | `getMessages` resolve 值 `toEqual` 输入，数组顺序不变 |
| W2 整体拒绝（红） | 以 W1 为底逐项替换：user 缺 `approvals`；assistant 缺 `approvals`；`approvals:null`；`approvals:{}`；元素多 `decidedAt`；元素缺 `requestedAt`；`decision:"maybe"`；`tool:1`；元素 id `2**53`；`[8,7]` 乱序；`[7,7]` 重复；user `approvals` 含一条合法元素 | 每项都是 `expectRequestFailure(…, 200)`；W1 底样本通过作为对照 |
| W3 快照 → 视图（红） | `chatStateFromSnapshot(deepFreeze(W1))` | 每条视图 `approvals` `toStrictEqual` 输入去掉 `requestedAt` 后的逐项映射（顺序不变），user `[]`；输入未被修改 |
| W4 请求与结算（红） | running 快照，assistant id 0，`approvals:[]`；request{0,7,bash,TITLE,E} → resolved{0,7,allow} | 第一步 `approvals` `toStrictEqual([{id:7,tool:"bash",title:TITLE,expiresAt:E,decision:null}])`，`status==="running"`，`messages[0]` 与输入同一引用；第二步只有 `decision` 变为 `allow` |
| W5 同一引用（红） | 基于 W4 第一步状态 S：resolved(8)；对 `approvals:[]` 的消息 resolved(7)；对不存在的消息 99 resolved（`toBe` 输入）；另起一子例：对不存在的消息 99 request(7) → 补建 assistant 99，其 `approvals` 恰为那一条 pending（与 `step.start` 等事件对未知 assistant 的既有行为一致，钉住语义）；对 user 消息 -3 request 与 resolved；再次 request(7)。基于 W4 第二步状态：重放 request(7)、重放 resolved(7,allow) | 除「消息 99 request(7)」子例外，每次都 `toBe` 输入，消息数不变，resolved 不补建；重放 request 不把 `allow` 改回 null。「消息 99 request(7)」子例：结果不 `toBe` 输入，消息数 +1，`messages.at(-1)` `toStrictEqual` `{id:99, role:"assistant", content:"", status:"running", steps:[], approvals:[{id:7,tool,title,expiresAt,decision:null}], error:null}`，会话 `status` 不变，原有各消息保持同一引用 |
| W6 turn.start 清空（红） | W4 第二步后 turn.start(0) | 该消息 `approvals` `toStrictEqual([])`，其它消息同一引用 |
| W7 不改会话状态（红，proposal 偏离 5） | 快照会话 `done`、assistant 已有 `[7]`：request(7)；request(9) | 前者 `toBe` 输入；后者 `status` 仍为 `done`、`approvals` ids `[7,9]` |
| W8 并行与回放（红） | running：request(8) → request(7) → resolved(8,deny)，再原样重放三事件 | 两次 request 后 ids `[7,8]`，id 8 元素与第一步同一引用；resolved 后 7 为 null、8 为 deny，会话 running；重放三事件每步 `toBe`；结果 `approvals` 与 `chatStateFromSnapshot`（快照 `[{7,null},{8,deny}]`）的 `approvals` 相等 |
| W9 同一游标（红） | `connectChat(chatSnapshot({cursor:{epoch:1,seq:5}}))`，open 并安装同一快照；`emitData` approval.request(1:5)、approval.resolved(1:6,{0,7,allow})、turn.end(1:7,{0,stopped}) | `events` `toStrictEqual([{type:"approval.resolved",data:{messageId:0,approvalId:7,decision:"allow"}},{type:"turn.end",data:{messageId:0,status:"stopped"}}])`；`loads` 长度 1 |
| W10 连接器交付（红） | 同 W9 安装后：request(1:6,{0,7,bash,TITLE,E})、resolved(1:7,{0,7,deny}) | `events` 为两条逐字解码的事件；`context.state` assistant `approvals` 为 `[{id:7,…,decision:"deny"}]` |
| W11 非法 → 重同步（红） | 每项用一个按 W9 安装好的新连接发送：request 多键、缺 `expiresAt`、`approvalId:1.5`、`approvalId:2**53`、`messageId:"0"`、`title:1`；resolved `decision:null`、`"maybe"`、`"Allow"`、多键；合法 request 配 id `"1:01"` | 每项都使 `loads` 长度 +1，`events` 不增（master 上无监听，`loads` 不增，所以红） |
| W12 守卫（恒绿） | 既有 web 全量 | 除允许清单外零 diff 全绿；`future.event` 仍被忽略 |

**红/绿**：S1–S10、W1–W11 在 master 上为红，先对 master 跑红并记录。以下变异逐一临时施加，失败输出记入 PR body：投影按 `requested_at` 排序 → S3；去掉 `role='assistant'` → S5；handler 内另行读取审批 → S6；投影多出 `decided_at` → S2/S7 的 `toStrictEqual`；web 不检升序 → W2；resolved 未命中时仍复制 → W5；request 接线传 `"running"` → W7。

## Non-goals
见 proposal Non-goals。

## Review focus
1. 六键只有一个投影：`toPublicApproval` 被 `toPublicHistory` 与审批路由共用，审批路由逐字节不变；S7/S8 用 `toStrictEqual` 证明快照元素等于 200 body。
2. 投影 SQL：`role='assistant'`、`ORDER BY a.id`、按会话取行、BLOB 解码（S3、S5、S2）；类型定义在 `store.ts`，`store-branch.ts` 只改一行类型。
3. web 严格性：user 非空、乱序、重复、多键/缺键、未知 decision 都整体拒绝（W2）；解码器不接受 `decision:null`。
4. 归约引用语义：未命中与重放一律返回同一引用；`approval.resolved` 从不补建审批；`approval.request` 指向不存在的 assistant 时，按 `replaceAssistant` 既有语义补建该 assistant（W5 子例）；不改会话状态（W5、W7、W8）。
5. 行数与边界：`wc -l` 记入 PR body，`stream.ts` ≤770 且只有接线；`stream-approvals.ts` 对 `stream.ts` 只有 `import type`；既有测试 diff 只有允许清单里的插入。
