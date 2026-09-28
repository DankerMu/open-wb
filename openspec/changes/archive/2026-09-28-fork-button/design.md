# Design: fork-button（#479）

父设计 D4 已定 fork 语义，proposal 已列偏离。本文只写落到现有代码时被逼出的约束。行号指当前 master（`5fa1f0e`）。篇幅超出 20–40 行目标，与 #477/#478/#480 先例相当，因为 Required evidence 须逐条可执行。

## Change surface
- **`turn-actions.ts`**（362 → ≤400）：新增 `forkTurn = useCallback((messageId: number): Promise<void>)`，加入返回对象（`:361`）。`TurnActionDeps` 加 `historyGenerationRef: RefObject<number>`、`selectSession: (sessionId: string | null) => void`、`setForkOwner`。
  - 流程：
    1. 读取 `ownedClient = clientRef.current`、`sessionId = requestedSessionRef.current`、`generation = historyGenerationRef.current`。`sessionId` 为 null 时 resolve。
    2. 新建 `owner = { client: ownedClient, originSessionId: sessionId, sessionId }`（新对象，身份即令牌）。定义 `release = () => setForkOwner((cur) => (cur === owner ? null : cur))` 与 `owned = () => ownsSessionWrite(ownedClient, sessionId) && historyGenerationRef.current === generation`。
    3. 依次执行 `setPromptError(null)`、`setForkOwner(owner)`，然后调 `ownedClient.forkSession(sessionId, messageId)`，不传 signal（写操作，不中止）。
    4. 201：先 `release()`。`owned()` 为假时到此为止（不导航、不写草稿、不刷新列表，proposal 偏离 4）。为真时在同一同步段内依次执行 `setDraft(fork.draft)`、`refreshList(ownedClient)`、`selectSession(fork.session.id)`。
    5. reject：先 `release()`。`owned() && !isUnauthorized(error)` 时 `setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) })`。不对账、不刷新（proposal 偏离 5）。
    6. 返回的 Promise 永不 reject。
  - **不调用** `closeSource`/`installSnapshot`/`openSource`/`reconcileSettled`：新会话的历史与 EventSource 全部由既有切会话 effect（`page.tsx:338-387` → `loadHistory` `:252-313`）负责，它会先 `closeSource()` 关掉源会话。不写 prompt 的 mutation 字段，不写 `regenerateOwner`。
  - jscpd（≤3%）：`release` 这一行与 `regenerateTurn`（`:309`）同形。若 `make anti-drift` 报重复，抽一个模块内小函数（如 `releaseIfOwner(setter, owner)`）供两处共用，不复制 `fail` 闭包。围栏复用 `ownsSessionWrite`（`:226-232`）。
- **`page.tsx`**（627 → ≤645）：
  - 在 `:46` 旁加 `const [forkOwner, setForkOwner] = useState<ChatMutationOwner | null>(null)`，位于既有 state 块内。
  - 把 `selectSession`（`:401-406`）整体挪到 `useTurnActions` 调用（`:315`）之前，作为 dep 传入，同时传入 `historyGenerationRef`、`setForkOwner`。
  - `:584-591` 改为：`generating` 不变；`const composerDisabled = generating || ownsMutation(forkOwner, client, requestedSessionId)`；`sendDisabled = composerDisabled || draft.trim().length === 0`。`ConversationView` 的 `composerDisabled` 取新值，`generating` 仍取 `generating`，另加 `onFork={forkTurn}`。
  - client 变更 effect（`:157-170`）可顺手 `setForkOwner(null)`，不强制：锁按 client 归属，旧 client 的锁对新 client 不可见。
- **`conversation-view.tsx`**（225 → ≤245）：`ConversationViewProps` 与 `MessageThread` 加 `onFork(messageId: number): Promise<void>`。`MessageArticle` 加两个原始值 prop：`forkDisabled: boolean` 与 `onFork`（`forkTurn` 是稳定的 `useCallback`），不要每次渲染新建对象，以免破坏 `memo`（`:71`）。用户分支（`:88-96`）在 `{error}` 之后渲染 `<ForkAction disabled={forkDisabled} onFork={() => void onFork(message.id)} />`。助手 article 的 `forkDisabled` 可传常量 `false`，锁切换时只重渲染用户 article。
- **`message-actions.tsx`**（59 → ≤90）：新增导出 `ForkAction`，渲染 `<div className="chat-msg-actions"><Button aria-label="从此处分叉" className="chat-msg-action" disabled={disabled} onClick={onFork} size="icon" title="从此处分叉" type="button" variant="ghost"><Icon name="git-branch" size={12} /></Button></div>`。`MessageActions` 不变。改写 `:1` 注释。

## Governing invariant
每条用户消息恰有一个 `从此处分叉`，助手消息没有。它在 composer 锁定期间禁用。从点击到 fork 自身所有分支结束，源会话的 composer 被一把按身份释放的 page 级锁锁住（不显示 `停止`/`生成中`）。201 的草稿写入、列表刷新与导航只在 `ownsSessionWrite` 且点击后未重载历史时，于同一同步段内发生。新会话的历史与 EventSource 只经既有 `?session=` 选择路径加载。任何失败都只写当前会话的内联错误。

## Must preserve
- `turn-actions.ts` 不含 `useState(`、`useEffect(`、`useRef(`、`useMemo(`，不导入 `./page.js`（G2，`web/test/chat-approval-bar.test.tsx:660-665`）。`useTurnActions` 仍无 hook 状态，carry-forward :77 的守卫条件不被触发。新 `useState` 在 `page.tsx` 既有 state 块内。挪到前面的 `selectSession` 是纯 `useCallback`，没有 effect 时序。
- `draft` 的写入者只有三处：`submitComposer`（`page.tsx:527`）、`restoreOwnedDraft`（`turn-actions.ts:66-78`，只在 create/prompt 失败时调用）、`onChangeDraft`。client effect（`:157-170`）与切会话 effect（`:338-387`）都不写 `draft`，所以 201 写入的草稿能活过导航。实现不得在这两个 effect 里加草稿清理。
- `historyGenerationRef` 只在 `loadHistory`（`:258`）、`fencePageWork`（`:99`）与无会话分支（`:362`）自增。`loadHistory` 依赖 `location.*`（`:307-309`），所以令牌不变即说明点击后没有任何导航或历史重载。
- `dispatchPrompt` 及其 fence（`turn-actions.ts:148-222`）、`answerApproval`、`stopTurn`、`regenerateTurn` 行为不变；`submitComposer` 的守卫（`page.tsx:520`）不变；`generating` 的六项不变（`停止`/`生成中` 只随回合出现）。
- 用户气泡：`p.chat-msg-body` 仍是 user article 的第一个 `<p>`（`chat-messages.test.tsx:82-97` M2；e2e `ui-walk.spec.ts:716`），气泡 CSS 不变（M2）。用户 article 无 avatar（M4 `:167`）。
- 助手操作条：`复制`/`重新生成` 的 DOM 与行为不变（`chat-copy.test.tsx` C4、`chat-regenerate-button.test.tsx` R1/R2、`chat-stop-button.test.tsx:477-518` S10）。
- 侧栏状态元素文案来自 `SESSION_STATUS_LABEL`（`status-label.ts:5` `idle: "未开始"`）；`session-nav.tsx` 零 diff。

## Sibling surfaces
- **必然破坏、允许改动的既有断言：4 处，只改期望，行数不增。** 它们断言「用户 article 内没有任何按钮」，本功能要求那里恰有 `从此处分叉`：
  1. `web/test/chat-copy.test.tsx:169`：`within(user).queryByRole("button")` 改为 `within(user).queryByRole("button", { name: "复制" })`，仍 `toBeNull()`。
  2. `web/test/chat-regenerate-button.test.tsx:195`（R1 eligible）
  3. `web/test/chat-regenerate-button.test.tsx:210`（R1 hidden）
  4. `web/test/chat-regenerate-button.test.tsx:222`（R1 (f)）

  第 2–4 处都把 `expect(within(user).queryAllByRole("button")).toHaveLength(0);` 改为 `expect(regenButtons(user)).toHaveLength(0);`，复用该文件已有 helper（`:104`）。
  - 已逐项核对、不破坏的查询：`chat-page-ownership-gaps.test.tsx:36-41` 限定在会话列表；`chat-composer.test.tsx:83`、`chat-stop-button.test.tsx:166` 限定在 form/toolbar；`chat-approval-bar.test.tsx:158`、`chat-stop-button.test.tsx:324` 限定在审批 group；`chat-stop-button.test.tsx:514` 与 `chat-regenerate-button.test.tsx:229-242` 的 `.chat-msg-actions` 限定在助手 article；其余按钮查询都按名，`从此处分叉` 不与之同名（grep `web/test`、`web/e2e`）。
  - 实现后若 `npm test` 暴露上述 4 处以外的破坏，停下上报，不改测试。
- Toast：`ForkAction` 不调 `useToast`，因此不扩大 carry-forward「MessageActions 无 provider 抛错」的面。
- 生产消费者：`index.ts` 导出面不变。e2e 不查询用户操作行。8.2d 的 ui-walk 分叉走查归组 8。

## Seams under test
- 新建 `web/test/chat-fork-button.test.tsx`（≤800 行），全部走页面级：
  - `renderChatPage("/?session=${SESSION_ID}&tab=x#frag", routes)`（`chat-page-support.tsx:24`）；
  - URL 用 `currentLocation()`/`expectChatLocation`（`support.ts:168`、`chat-page-support.tsx:34`）读取；
  - 事件与 source 用 `latestSource().emitOpen()`、`FakeEventSource.instances`、`closeCount`（`chat-stream-support.ts:151-210`）。
- 快照由本文件自建，写法同 `chat-regenerate-button.test.tsx:43-60` 的 `message`/`snapshotOf`。messages 路由在初次加载、每次 `emitOpen` 时各命中一次。support 文件不改。
- 201 body 的 `session` 键集必须恰为 `{id,title,status,createdAt,updatedAt}`，`id` 为 32 位小写十六进制（`session-contract.ts:76,98-110`），不能带 `parentSessionId`，否则会被当作非法 201 走错误分支。新会话 id 取 `FORK_ID = "c".repeat(32)`。
- `FORK = /api/sessions/${SESSION_ID}/fork`。每次调用从一个 `deferredResponse()` 队列（`support.ts:27`）取一个响应。用 `calls(fetchMock, FORK)` 核对 `init.method === "POST"`、`init.body === '{"messageId":3}'`。列表 GET 数用 `calls(fetchMock, "/api/sessions")` 中 method 非 POST 的条目计数（同一路径上的 POST 是 create）。
- 列表路由按阶段切换：在 resolve FORK 的 201 **之前**把列表回复换成含 N/N0 的版本，因为 `refreshList` 在 201 续体内同步发出。计数一律取「resolve 迟到结果前」的基线；F9 的基线取在 `renewAccount` 落定之后（续期本身会触发一次列表 GET，`page.tsx:166`）。
- 「未发送」的判据：`paths(fetchMock)` 中没有以 `/prompt` 结尾的路径，也没有 POST `/api/sessions`。
- 切会话：点侧栏 `OTHER_SESSION_ID` 会话（`chat-page-ownership-support.ts:9`）。续期：`renderChatPageWithAuthProbe` + `renewAccount`（`chat-page-lifecycle-support.tsx:130,162`）。卸载：`router.navigate("/center")`。写法与 #478 R8–R12 一致。当前选中的侧栏项用 `within(nav).getByRole("button", { current: true })` 定位：分叉会话复制了源 title，两项同名。

## Required evidence
S = A（`SESSION_ID`）的 done 会话 `saved title`，消息为 u1（id 1，`first question`）、a2（id 2，done，`一`）、u3（id 3，`second question`）、a4（id 4，done，`二`），cursor `1:0`。N = `FORK_ID` 的 done 会话（title `saved title`，`updatedAt` 大于 A），消息为 u10（`first question`）、a11（done，`一`），cursor `{epoch:0,seq:null}`。N0 = 同 id 的 `idle` 会话，消息为空。B = `OTHER_SESSION_ID` 的 done 会话 `other session`，消息为 u21（`B 问`）、a22（done，`B 回答`）。列表路由按阶段返回：分叉前为 `[A]` 或 `[A, B]`，201 之后加上 N/N0（排在最前）。`BUSY_B`：B 的 fork 返回 409，文案 `B 会话忙`。

| ID | 输入 | 期望 |
|---|---|---|
| F1 可用性（红） | 挂载 S；另挂载 running 快照 [u1, a2 running] | S：两个用户 article 各恰一个按钮，名为 `从此处分叉`，可用，`type="button"`，`title="从此处分叉"`，含 `svg.lucide-git-branch`，位于 `.chat-msg-actions` 内；该行是 user article 的 `lastElementChild`，且排在 `p.chat-msg-body` 之后。两个助手 article 内都没有 `从此处分叉`。running：用户按钮存在但 disabled，点击不产生 FORK 请求 |
| F2 分叉含历史（红） | S，URL `/?session=A&tab=x#frag`；先输入 `旧草稿`；FORK 挂起；对 u3 连续两次点击（各自 act）；然后 resolve 201 `{session:N, draft:"second question"}`；等 N 加载完，新 source `emitOpen` 后 flush | FORK 挂起期间：FORK 调用恰 1 次，POST，body `{"messageId":3}`；两个 `从此处分叉` 与 `重新生成` 均 disabled；textarea disabled，`发送` 在且 disabled；toolbar 无 `停止`、无 `生成中`；URL 不变。201 之后：URL 为 `/?session=${FORK_ID}&tab=x#frag`；A 的 source `closeCount === 1`；N 的 messages GET 恰 1 次（emitOpen 前），新 source 的 url 为 N 的 events 路径；转录为 [`first question`, `一`]，a11 上 `重新生成` 可用；列表 GET +1，侧栏共 2 项，`current` 项内状态元素名为 `saved title 已完成`；textarea 值为 `second question` 且可用，`发送` 可用。`emitOpen` 之后草稿仍为 `second question`；全程无 `/prompt` 请求，无 POST `/api/sessions`；无 alert |
| F3 分叉首条 → idle（红） | S；对 u1 点击；201 `{session:N0, draft:"first question"}`，N0 的 messages 为空 | FORK 请求为 POST、body 恰为 `'{"messageId":1}'`（钉住「被点击的那条」而非末条用户消息，写法同 `chat-copy.test.tsx` C5）；URL 为 `/?session=${FORK_ID}&tab=x#frag`；无 `article`，无 `重新生成`；`current` 侧栏项状态元素名为 `saved title 未开始`；textarea 值为 `first question` 且可用；无 `/prompt` 请求 |
| F4 锁定矩阵（红） | `it.each`：(a) S 上输入 `继续` 发送，prompt 挂起；(b) S 上点 a4 的 `重新生成`，REGEN 挂起 | 两例中所有 `从此处分叉` 都 disabled，点击不产生 FORK 请求。只断言在途期间；解锁后恢复可用由 F5 覆盖（对账快照为 running 时本就保持锁定，不在此断言） |
| F5 失败信封（红） | `it.each` S：先输入 `我的草稿`；FORK 分别返回 400 `bad_request`、409 `session_busy`、502 `agent_unavailable`、503 `agent_capacity`（`Agent 容量已满，请稍后重试`）；另一例 FORK 路由返回 `new TypeError()`（fetch reject，`api.ts:449-455` 包成 status 0 的 `ApiError`） | alert 文本恰为信封 message（fetch reject 例为 `请求失败，请稍后重试`）；URL 仍为 `/?session=A&tab=x#frag`；textarea 值仍为 `我的草稿` 且可用；`发送` 可用；列表 GET 数不变；A 的 messages GET 数不变；A 的 source `closeCount === 0`，`FakeEventSource.instances` 数不变；转录不变；`从此处分叉` 重新可用 |
| F6 切会话围栏（红，`it.each` 迟到结果 ∈ {201 N, 409}） | A=S，B 在列表；对 u3 点击，FORK_A 挂起；切到 B；在 B 输入 `B 草稿`，点 u21 的 `从此处分叉` 得 `BUSY_B`；再令 FORK_A 返回迟到结果 | 切到 B 后，B 的 textarea 与 `从此处分叉` 均可用（A 的锁不外泄）。迟到结果后：alert 恰为 [`B 会话忙`]；URL 仍为 `/?session=B…`；textarea 值仍为 `B 草稿`；列表 GET 数不变；无 N 的 messages GET；`FakeEventSource.instances` 数不变，B 的 source `closeCount === 0`；转录为 B |
| F7 按身份释放（红） | A=S，FORK_A 挂起并点击；切到 B，FORK_B 挂起并点击；令 FORK_A 返回 409；再令 FORK_B 返回 `BUSY_B` | A 的 409 落地后，B 仍锁定（textarea disabled，u21 的 `从此处分叉` disabled）且无 alert；B 的 409 后 B 解锁，alert 为 `B 会话忙` |
| F8 ABA（红） | A=S，对 u3 点击，FORK_A 挂起；切到 B；再切回 A（A 重新加载并 open）；令 FORK_A 返回 201 N | 切回 A 时 A 仍锁定（fork 在途）。201 之后：URL 为 `/?session=A…`；列表 GET 数不变；无 N 的 messages GET；A 解锁（锁已释放）；textarea 值不变 |
| F9 续期围栏（红，`it.each` 迟到结果 ∈ {201 N, 409}） | 同一 A；旧 client 的 FORK 挂起并点击；`renewAccount`；新 client 下输入 `新草稿`，点 `从此处分叉` 得 409 `新账号忙`；再令旧 FORK 返回迟到结果 | 续期后新 client 下 composer 可用；迟到结果后：alert 恰为 [`新账号忙`]；URL 仍为 `/?session=A`；textarea 值为 `新草稿`；无 N 的 messages GET；列表 GET 数不变 |
| F10 卸载围栏（红） | S；FORK 挂起并点击；`router.navigate("/center")`；再令 FORK 返回 201 N | `currentLocation()` 仍以 `/center` 开头；列表 GET 数不变；无 N 的 messages GET；无 `console.error`；无未处理 rejection（`observeUnhandledRejections`） |
| G1 hook 守卫（恒绿） | 既有 `chat-approval-bar.test.tsx:660-665` G2 | 仍绿；本文件不复制该守卫 |
| G2 既有呈现（恒绿） | `chat-copy.test.tsx`、`chat-messages.test.tsx` M2/M4、`chat-regenerate-button.test.tsx`、`chat-stop-button.test.tsx` S10 | 除「Sibling surfaces」4 处期望改动外零 diff，全绿 |
| G3 既有套件（恒绿） | `npm test --workspace web` | 全绿 |

**Scenario → 证据映射**：
- chat-web「从用户消息分叉」WHEN 1 → F1、F2、F4；WHEN 2 → F3。Messages 段 **User messages** 句：按钮、禁用、恰一次 → F1、F2、F4；跳转、刷新、草稿不发送 → F2、F3；400/409/502/503 内联 → F5。
- chat-web「Page SHALL … late responses … SHALL NOT mutate UI, navigate」与「User-initiated navigation SHALL invalidate stale mutation continuations」→ F6、F8、F9、F10。
- turn-control「回合控制 web 呈现」`从此处分叉` 句与「分叉跳转与草稿」→ F2。

**红/绿**：F1–F10 先对 master 跑红（master 没有该按钮），记录失败输出。以下子断言在 master 上本就成立，不算红先行失败，由下列变异守卫：F1 的「助手 article 内无 `从此处分叉`」，F5/F6/F9/F10 的「URL/计数不变」类否定断言。G1–G3 为守卫。下列变异逐一临时施加，确认对应用例变红，结果记入 PR body：
- 按钮不受 `composerDisabled` 约束 → F1 running、F2 第二次点击、F4；
- fork 锁写进 `generating`（或复用 `regenerateOwner`）→ F2「无 `停止`/`生成中`」；锁不进 `sendDisabled` → F2「`发送` disabled」；
- 201 不写草稿，或写后被清 → F2、F3 的草稿断言；201 后调 `dispatchPrompt`/`requestSubmit` → F2「无 `/prompt`」；
- 不调 `refreshList` → F2 的列表 GET +1 与 `current` 项；用 `navigate` 自拼 URL 且丢失 search/hash → F2 URL；
- 去掉 201 围栏 → F6-201、F9-201、F10；错误分支不查归属 → F6-409、F9-409；去掉 ABA 令牌 → F8；释放不比身份 → F7；
- 失败分支不释放锁 → F5（textarea 可用）；失败分支对账或刷新 → F5 的 GET 计数；
- 按钮渲染到助手消息 → F1。

## Non-goals
见 proposal Non-goals。

## Review focus
1. 201 的围栏（`ownsSessionWrite` 加历史令牌）位于任何 `setDraft`/`refreshList`/`selectSession` 之前，三者在同一同步段内执行（F6、F8、F9、F10）。
2. 新会话的历史与 source 只经既有切会话 effect 加载。`forkTurn` 自己不 GET、不 open（F2 的 GET 计数与 `closeCount`）。
3. 锁是 page 级独立状态，按身份释放，只进 `composerDisabled`/`sendDisabled`，不进 `generating`。`turn-actions.ts` 仍无 hook（F2、F7、G1）。
4. 草稿写入不被任何 effect 清掉，也不触发发送（F2、F3）。
5. 失败只内联、释放锁，不导航、不改草稿、不刷新、不对账（F5）。4 处既有测试改动与「Sibling surfaces」清单逐字一致。
