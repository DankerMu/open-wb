# Design: regenerate-button（#478）

父设计 D3 已定 regenerate 语义，proposal 已列偏离。本文只写落到现有代码时被逼出的约束。行号指当前 master（`939da15`）。篇幅超出 20–40 行目标，与 #477/#480 先例相当，因为 Required evidence 须逐条可执行。

## Change surface
- **`turn-actions.ts`**（292 → ≤350）：新增 `regenerateTurn = useCallback((): Promise<boolean>)`，加入返回对象（`:291`）。`TurnActionDeps` 只加 `setRegenerateOwner`。
  - 流程：
    1. 读取 `ownedClient = clientRef.current` 与 `sessionId = requestedSessionRef.current`。`sessionId` 为 null 时 resolve `false`。
    2. 新建 `owner = { client: ownedClient, sessionId }`（新对象，身份即令牌）。依次执行 `setPromptError(null)`、`setRegenerateOwner(owner)`。
    3. 调 `ownedClient.regenerateSession(sessionId)`，不传 signal（写操作，不中止）。
    4. 定义 `release = () => setRegenerateOwner((cur) => (cur === owner ? null : cur))`。**每个分支都调用它，包括被围栏挡下的分支。**
    5. POST reject：
       - `ownsSessionWrite(ownedClient, sessionId) && !isUnauthorized(error)` 时 `setPromptError({client, sessionId, message: errorMessage(error)})`；
       - 然后 `release()`，resolve `false`。
       - 错误不是 409/400/503/401（即 502 与任何非 `ApiError`）且仍归属时，另调既有 `reconcileSettled(ownedClient, sessionId)`（GET → `installSnapshot` + `openSource`，自带 `ownsSessionWrite` 围栏）。事务提交后的派发失败同样返回 502，此时旧助手行已删、新行与会话为 failed（turn-control「重新生成 REST」，`server/src/sessions/branching.ts:126-157`），转录只能来自快照（proposal 偏离 8）。
    6. 202，**围栏一**：`!ownsSessionWrite(...)` 时 `release()`，resolve `false`。不 `closeSource`，不发 GET。
    7. 202 且仍归属：
       - `closeSource()`，发 `ownedClient.getMessages(sessionId)`，resolve `true`（Toast 在 202 时出，不等 GET）。
       - GET 成功，**围栏二**：仍归属时 `installSnapshot` + `openSource` + `refreshList(ownedClient)`，然后 `release()`；不归属时只 `release()`。`openSource`（`page.tsx:184-249`）自身不校验归属，所以围栏二必不可少。
       - GET 失败：仍归属且非 401 时，`setStreamError({client, sessionId, message: \`${errorMessage(error)}。${TERMINAL_REFRESH_GUIDANCE}\`})`（同 `:106-114`）；最后 `release()`。
    8. 返回的 Promise 永不 reject，GET 链不产生未处理 rejection。
  - **不调用** `abortMutation`，不写 `mutationControllerRef`/`mutationGenerationRef`/`setSubmitting`/`setMutationOwner`/`setCreating`/`pendingCreateSendRef`。不使用 `result.assistantMessageId`（proposal 偏离 2）。
  - 围栏复用 `ownsSessionWrite`（`:216-222`），不复制（jscpd）。
- **`page.tsx`**（622 → ≤632）：
  - 在 `:38-45` 的 state 块加 `const [regenerateOwner, setRegenerateOwner] = useState<… | null>(null)`。类型可复用 `ChatMutationOwner`（此时 `originSessionId === sessionId`，用 `ownsMutation` 判定），也可内联 `{client, sessionId}`；`types.ts`/`ownership.ts` 零 diff。
  - `:581-586` 的 `generating` 加一项：`regenerateOwner` 归属当前 `client` 与 `requestedSessionId`。
  - `:314` 解构 `regenerateTurn`，deps 加 setter。`:605-619` 给 `ConversationView` 加 `onRegenerate={regenerateTurn}`。
  - client 变更 effect（`:156-169`）可顺手 `setRegenerateOwner(null)`，不强制：锁按 client 归属，旧 client 的锁对新 client 不可见。
- **`conversation-view.tsx`**（199 → ≤225）：
  - `ConversationViewProps` 加 `onRegenerate`，与 `composerDisabled` 一起传入 `MessageThread`。
  - `MessageThread` 算出 `eligible = last?.role === "assistant" && ["done","failed","stopped"].includes(historyView.status)`，只给末条 `MessageArticle` 传 `regenerate={{ disabled: composerDisabled, onRegenerate }}`，其余传 `undefined`，以免破坏 `memo`（`:66`）对非末条的作用。
  - `:114` 改为 `message.status !== "running" && (message.content !== "" || regenerate !== undefined)`。
- **`message-actions.tsx`**（28 → ≤60）：
  - `复制` 仅在 `text !== ""` 时渲染，行为不变（`:6-13`）。
  - `regenerate` 存在时，在其后渲染 `Button aria-label="重新生成" title="重新生成" className="chat-msg-action" size="icon" variant="ghost" type="button" disabled={regenerate.disabled}`，内含 `<Icon name="refresh-cw" size={12} />`。
  - onClick：`void regenerate.onRegenerate().then((ok) => { if (ok) toast.show({ type: "info", message: "正在重新生成…" }); })`。
  - 改写 `:1` 注释。

## Governing invariant
`重新生成` 只出现在「末条消息为助手且会话状态 ∈ done/failed/stopped」的那一行。它在 composer 锁定期间禁用。从点击到 regenerate 自身所有分支结束，composer 被一把按身份释放的 page 级锁锁住。转录的替换只来自权威快照。POST 结果与 GET 结果在写任何 UI、关闭或打开任何 source 之前，都须通过 `ownsSessionWrite`（client + 选中会话 + 挂载）。

## Must preserve
- `turn-actions.ts` 不含 `useState(`、`useEffect(`、`useRef(`、`useMemo(`，不导入 `./page.js`（G2，`chat-approval-bar.test.tsx:660-665`）。所以 `useTurnActions` 在 `page.tsx:314` 的调用位置仍与行为无关，carry-forward :77 不被触发。新 `useState` 位于 `page.tsx` 既有 state 块内，不改变其它 hook 的相对次序。
- `dispatchPrompt` 及其 fence（`turn-actions.ts:138-212`）、`answerApproval`、`stopTurn`（`:272-289`）不变；`submitComposer` 的守卫（`page.tsx:517`）不变。
- `复制` 的行为与 DOM：
  - 名与 `title` 为 `复制`，装饰性 `svg.ui-icon`，行类 `.chat-msg-actions` 且为 `.chat-msg-main` 的末子元素（`chat-copy.test.tsx:147-170` C4）；
  - 空正文与 running 助手无 `复制`（C4 `:128-145`）；
  - 用户消息无按钮（`:168-169`，直到 #479）。
- 助手块结构：avatar 为 `article.firstElementChild`，`.chat-md` 在步骤卡之前（`chat-messages.test.tsx:151-179` M4）；审批条在 `.chat-md` 之前；`已停止` 徽章在 `.chat-md` 之后、`.chat-msg-actions` 之前（`chat-stop-button.test.tsx:477-518` S10）。
- composer 结构与 `生成中` status 元素原样（`composer.tsx:66-86`，e2e 锚点）。
- `page.tsx` 仍含 `useTopbar(`，不含 `<h1`、`routes/`（`topbar.test.tsx:285-287`）。

## Sibling surfaces
- **必然破坏、允许改动的既有断言：预期为零。** 逐项核对：
  - `chat-copy.test.tsx` 全部按名 `复制` 查询：C4 空正文 done 仍无 `复制`；C4 failed 例中 `lastElementChild === actions` 仍成立；
  - `chat-stop-button.test.tsx:477-518` S10 只断言 a1/a2 的 `复制`。末条 a4（failed、空正文）新增的 `重新生成` 行不在断言内；
  - 其余按钮查询限定在 `form`/审批 `group`/侧栏内，或按名查询（grep `web/test`、`web/e2e`）。
  - 实现后若 `npm test` 暴露任何既有断言破坏，停下上报，不改既有测试。
- Toast 依赖：`MessageActions` 已调 `useToast`。页面 harness 都挂有 `ToastProvider`（`render-app-router.tsx:15`、`chat-page-lifecycle-support.tsx:99`），无需改。
- 生产消费者：`index.ts` 导出面不变；e2e 不查询助手操作条；8.2c 的 ui-walk 重新生成走查归组 8。

## Seams under test
- 新建 `web/test/chat-regenerate-button.test.tsx`（≤800 行），全部走页面级：
  - `renderChatPage("/?session=${SESSION_ID}", routes)`（`chat-page-support.tsx:24`）；
  - 事件经 `latestSource().emitOpen()/emitData(type, "1:n", data)` 送入（`chat-stream-support.ts:175-190`）；
  - source 关闭看 `FakeEventSource.closeCount`（`:161`）与 `FakeEventSource.instances.length`。
- 快照由本文件自建：展开 `chatSnapshot(...)`（`chat-stream-support.ts:50`）后替换 `session.status`/`messages`/`streamCursor`，`stopped` 直接写在字面量里（#477 S10 先例）。messages 路由在初次加载、每次 `emitOpen`、对账时各命中一次，所以用闭包变量按阶段返回快照（#480/#477 先例）。support 文件不改。
- `REGEN = /api/sessions/${SESSION_ID}/regenerate`。用 `calls(fetchMock, REGEN)`（`support.ts:139`）核对 `init.method === "POST"` 且 `init.body === undefined`。在途断言用 `deferredResponse()`（`support.ts:27`），在 resolve 之前断言。
- 切会话：点侧栏 `OTHER_SESSION_ID` 会话（`chat-page-ownership-support.ts:9`）；续期：`renderChatPageWithAuthProbe` + `renewAccount`（`chat-page-lifecycle-support.tsx:130,162`）；卸载：`router.navigate("/center")`。三者均按 #477 S7/S7b/S7c（`chat-stop-button.test.tsx:334-418`）写法。
- Toast 取 `screen.queryByText("正在重新生成…")`。不 fake 计时器。

## Required evidence
D = done 会话 `saved title`，消息为 `historyUser` 加助手 id 0（done，`旧回答`），cursor `1:0`。N = 对账快照：会话 running，消息为同一 `historyUser` 加助手 id 5（running，`""`），cursor `1:3`。B = `OTHER_SESSION_ID` 的 done 会话 `other session`（助手 `B 回答`）。`BUSY_B` = B 的 regenerate 409 信封，文案 `B 会话忙`。

| ID | 输入 | 期望 |
|---|---|---|
| R1 可用性矩阵（红） | `it.each` 挂载：(a) D；(b) 会话 failed，助手 failed `""`；(c) 会话 stopped，助手 stopped `""`；(d) running 快照；(e) 会话 `idle`，[u, a done `x`]；(f) done，[u, a1 done `一`, u, a2 done `二`]；(g) done，[u, a done `一`, u] | (a)(b)(c)：末条助手 article 内恰一个 `重新生成`，可用、`type="button"`、`title="重新生成"`、含 `svg.lucide-refresh-cw`；(a) 中它排在 `复制` 之后（文档序）。(d)(e)(g)：全页无 `重新生成`。(f)：只有 a2 有，a1 只有 `复制`。所有用户 article 内无按钮 |
| R2 空正文行规则（红） | 会话 stopped，[u, a1 stopped `""`, u, a2 stopped `""`]；另挂 done，[u, a1 done `""`, u, a2 done `答`] | 第一例：a1 无 `.chat-msg-actions`；a2 的操作条恰一个按钮 `重新生成`、无 `复制`，正文区为 `（已停止生成）`。第二例：a1 无操作条；a2 有 `复制` 与 `重新生成` |
| R3 恰一次、锁定与对账替换（红） | D；REGEN 与对账 GET 均 `deferredResponse`；连续两次 `fireEvent.click(重新生成)`（各自 act）；resolve REGEN 202 `{assistantMessageId:5}`；然后 resolve GET 为 N；新 source `emitOpen`（此时 messages 路由仍返回 N）后依次 `text.delta{5,"新"}`、`text.delta{5,"回答"}`、`turn.end{5,"done"}`（`1:4`–`1:6`）；最后输入 `继续` 发送（prompt 202，messages 路由改返回含新一轮的快照） | REGEN resolve 前：REGEN 调用恰 1 次，POST 且无 body；`重新生成` disabled；textarea disabled；toolbar 有 `停止` 与 `生成中`、无 `发送`。202 后、GET 未返回时：`正在重新生成…` 出现；旧 source `closeCount === 1`；转录仍为 `旧回答`、助手 article 1 个（无本地合成）；composer 仍锁定（textarea disabled，`停止`/`生成中` 在，无 `发送`），`重新生成` disabled。GET 返回后：助手 article 恰 1 个、用户 article 恰 1 个，无 `旧回答`，无 `重新生成`（running），`/api/sessions` GET +1，新 source 已建。delta 后该唯一助手 article 正文 `新回答`（id 错位会追加第二行，所以助手 article 仍为 1 个）。`turn.end` 后回到 `发送`，`重新生成` 与 `复制` 重新出现。发送 `继续`：prompt 恰 1 次、受理对账照常（regenerate 未残留 mutation 状态） |
| R4 失败信封（红） | `it.each` D；REGEN 分别返回 409 `session_busy`、400 `bad_request`、503 `agent_capacity`（`Agent 容量已满，请稍后重试`） | `role=alert` 文本恰为信封 message；无 `正在重新生成…`；textarea 可用；toolbar 为 `发送`、无 `停止`/`生成中`；转录仍为 `旧回答`（助手 article 1 个）；messages GET 次数不变；source `closeCount === 0`；`重新生成` 再次可用 |
| R4-502a 提交前 502 对账（红） | D；REGEN 返回 502 `agent_unavailable`；messages 路由仍返回 D | `role=alert` 恰为 502 信封 message；无 `正在重新生成…`；composer 解锁（`发送` 在）；messages GET +1；旧 source `closeCount === 1`，新 source 已建；转录仍为 `旧回答`；`重新生成` 可用 |
| R4-502b 提交后 502 对账（红） | D；REGEN 返回 502；messages 路由返回会话 failed、同一条用户行加新 id 的助手行（failed、空正文） | `role=alert` 恰为 502 信封 message；composer 解锁；messages GET +1、新 source 已建；无 `旧回答`；助手 article 与用户 article 各恰 1 个；新助手行上 `重新生成` 可见且可用 |
| R5 202 后 GET 失败不卡死（红） | D + B；REGEN 202，对账 GET 返回 502 `Agent 运行时不可用`；然后点侧栏 B，再点回 `saved title`（此时 messages 返回 D） | GET 失败后：`role=alert` 含 `Agent 运行时不可用。请刷新页面后重试`；无未处理 rejection（`observeUnhandledRejections`）。切回 A 后：无 alert，textarea 可用，`发送` 在，`重新生成` 可用（残留锁的变异 → 仍锁定 → 红） |
| R6 regenerate 在途时停止（红） | D；REGEN 挂起；点 `重新生成`；点 toolbar `停止`，STOP 返回 204；然后 REGEN 返回 202，GET 返回 N | `停止` 可用；STOP 调用恰 1 次；无 `已停止生成`、无 alert；REGEN 202 后对账照常（messages GET +1、新 source、转录为 N）（carry-forward :101 记录） |
| R7 prompt 在途时不可点（红） | D；输入 `继续` 发送，prompt 挂起 | `重新生成` 可见且 disabled；点击不产生 REGEN 请求；prompt 202 后受理对账照常 |
| R8 切会话围栏·POST 段（红） | `it.each` 迟到结果 ∈ {202, 409}；A=D 且 REGEN_A 挂起，点击；切到 B；B 的 `重新生成` 可用，点击得 `BUSY_B` 内联；再令 REGEN_A 返回迟到结果 | 切到 B 后 B composer 未锁（A 的锁不外泄）。迟到结果后：alert 恰为 `B 会话忙`；无 `正在重新生成…`；B 的 source `closeCount === 0`，`FakeEventSource.instances` 数不变；A 的 messages GET 次数不变；B 转录为 `B 回答`，composer 可用 |
| R9 切会话围栏·GET 段（红，`it.each` 迟到 GET_A ∈ {200 N, 502}） | A=D；REGEN_A 202，对账 GET_A 挂起；切到 B（B 加载并 open）。200 例：再令 GET_A 返回 N。502 例：先令 B 带终端 stream error（`source.emitTransport(2)`，同 `web/test/chat-page-ownership.test.tsx:308-316`），再令 GET_A 返回 502 | 200 例：B 的 source `closeCount === 0`，instances 数不变；转录为 `B 回答`、无 A 内容；B composer 可用。502 例：alert 恰为 B 自己的 `…。请刷新页面后重试` 文案；B composer 仍锁定（textarea disabled，`生成中` 仍在）；页面无 A 内容 |
| R10 按身份释放（红） | A=D，REGEN_A 挂起并点击；切到 B，REGEN_B 挂起并点击；令 REGEN_A 返回 409；再令 REGEN_B 返回 `BUSY_B` | A 的 409 落地后 B 仍锁定（textarea disabled，`生成中` 在）且无 alert；B 的 409 后 B 解锁，alert 为 `B 会话忙` |
| R11 续期围栏（红） | `it.each` 迟到结果 ∈ {202, 409}；同一会话 D；旧 client 的 REGEN 挂起并点击；`renewAccount`；新 client 下 composer 可用，点 `重新生成` 得 409 `新账号忙`；再令旧 REGEN 返回迟到结果 | alert 恰为 `新账号忙`；无 `正在重新生成…`；新 client 的 source `closeCount === 0`；composer 可用 |
| R12 卸载围栏（红） | D；REGEN 挂起并点击；`router.navigate("/center")`；再令 REGEN 返回 202 | 无 `正在重新生成…`、无 alert、无 `console.error`；messages GET 次数不变 |
| G1 hook 守卫（恒绿） | 既有 `chat-approval-bar.test.tsx:660-665` G2 | 仍绿；本文件不复制该守卫 |
| G2 复制与已停止呈现（恒绿） | 既有 `chat-copy.test.tsx` 全文件、`chat-stop-button.test.tsx` S10 | 零 diff 全绿 |
| G3 既有套件（恒绿） | `npm test --workspace web` | 零 diff 全绿 |

**Scenario → 证据映射**：
- chat-web「重新生成末条回答」→ R1、R2、R3、R4（409/503 WHEN）；「容量已满内联提示」的 regenerate 句 → R4-503。
- Messages 段操作条改写句 → R1、R2、G2；业务错误段 503 括注 → R4-503。
- turn-control「回合控制 web 呈现」`重新生成` 句 → R1、R3。
- carry-forward :112 → R1(c)、R2；lesson 1（迟到结果围栏）→ R8、R9、R11、R12；lesson 2（不借 mutation fence）→ R3 末段、R6、R7、R10；lesson 3（锁的释放）→ R4、R5、R10。

**红/绿**：R1–R12 先对 master 跑红（master 无该按钮），记录失败输出。以下子断言在 master 上本就成立，不算红先行失败，由下列变异守卫：R1(d)(e)(g) 的「全页无 `重新生成`」、R2 两例中「a1 无操作条」、R2 第二例「a2 有 `复制`」。G1–G3 为守卫。下列变异逐一临时施加，确认对应用例变红，结果记入 PR body：
- 判「末条助手」而非「末条消息」→ R1(g)；按 `message.status` 或 `!== "running"` 判而不看会话状态 → R1(e)；所有助手都给 → R1(f)；
- 不放宽 `:114` → R1(b)(c)、R2；空正文也渲染 `复制` → R2；
- 按钮不受 `composerDisabled` 约束 → R3（第二次点击多发一次）、R7；
- 202 时本地合成新行，或 GET 前改写视图 → R3 的「GET 未返回时仍为 `旧回答`」；
- 错误分支不释放锁 → R4；GET 失败分支不释放 → R5；
- 202 时即释放锁（`release()` 挪到 `closeSource` 之后、GET 回调不再释放）→ R3 的「GET 未返回时仍锁定」；
- POST 失败后不对账 → R4-502a、R4-502b；409/400/503 也对账 → R4-409/400/503；
- 借用 `setSubmitting`/`setMutationOwner`/`mutationControllerRef` 作锁 → R5 或 R10（以实测为准，记入 PR body）；
- 去掉围栏一 → R8-202、R11-202、R12；去掉围栏二 → R9-200；GET 失败分支不查归属 → R9-502；错误分支不查归属 → R8-409、R11-409；释放不比身份 → R10；Toast 不经 handler 结果门控 → R8-202、R12。

## Non-goals
见 proposal Non-goals。

## Review focus
1. 两段异步各有围栏：202 后在 `closeSource` 之前查归属，GET 后在 `installSnapshot`/`openSource` 之前查归属。`openSource` 自身不查（R8、R9、R11、R12）。
2. 锁是 page 级独立状态，每个分支按身份释放。不写 prompt 的 mutation 字段，`turn-actions.ts` 仍无 hook（R3 末段、R5、R10、G1）。
3. 可用性只看「末条消息 + 会话状态」；空正文末条有操作条但无 `复制`（R1、R2）。
4. 替换只来自快照：202 后到 GET 前视图不变，`assistantMessageId` 不入视图（R3）。
5. 失败信封内联并解锁、无 Toast；409/400/503 转录不变，502 与非 `ApiError` 静默对账快照（可能已在 server 提交）；GET 失败走既有终端失败语义且可恢复（R4、R4-502a/b、R5）。
