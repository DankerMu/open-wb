# Design: approval-bar（#480）

父设计 D5 已定审批条形态与多条审批模型，proposal 已列偏离。这里只写落到现有代码上时被逼出的约束。行号指当前 origin/master（`341d7cb`）。篇幅超出 runbook 的 20–40 行目标，与 #476 先例相当，因为 Required evidence 须逐条可执行。

## Change surface
- **`web/src/features/chat/approval-bar.tsx`**（新建，≤150 行）：唯一导出 `ApprovalBars({ approvals, onAnswer })`。`approvals` 为空时返回 `null`。
  - 每条的外层是 `<fieldset aria-labelledby={头部文字 id}>`，key 为 `approval.id`。`<fieldset>` 的隐式 role 是 `group`；biome 推荐规则不接受 `div role="group"`，先例见 `welcome.tsx:17`。
  - 可访问名只取头部文字：`需要你的确认` / `已允许执行` / `已拒绝执行`。
    - `Icon name="shield"` 不传 label，因而是 `aria-hidden`（`icon.tsx:80-83`）。
    - 工具徽章放在被引用元素之外，否则名会变成「需要你的确认 bash」。
  - 工具徽章用 `Tag`（`ui/tag.tsx`，class `chat-approval-tool`），文本为 `approval.tool`，不读 title。
  - 正文为 `<p className="chat-approval-body">{title}</p>`，文本节点即 title 全文。
  - 只有 pending 条渲染倒计时和按钮：
    - 倒计时是一个 `<p className="chat-approval-countdown">`，文本 `（${n}s 内未操作将自动允许）`，其中 `n = Math.max(0, Math.ceil((expiresAt - now) / 1000))`；
    - 两个 `Button`：`允许` 用 `variant="primary"`，`拒绝` 用 `secondary`。
  - demo 的进度条 `.bar` 与秒数 `.cd`（demo:2410）**不渲染**，条内只有这一个倒计时元素。
  - 单条组件自持 `const [sent, setSent] = useState(false)`，按钮 `disabled={sent}`。
    - 点击时先 `setSent(true)`，再 `void onAnswer(id, decision).then((retry) => { if (retry) setSent(false); })`；
    - 条卸载后 setState 为空操作（React 19）；
    - 条被 `turn.start` 重置清除（carry-forward 80）时只是卸载，不会残留卡死状态。
  - **计时**：每个含 ≥1 条 pending 的列表恰有一个 `setInterval(…, 1000)`，只用来触发重渲染（`useState` 计数器）。
    - `now` 在渲染时读 `Date.now()`，所以 pending 由无到有的首帧就是新鲜值：新请求首帧即 60，不会拿到过期的 `now`；
    - 无 pending 或卸载时 `clearInterval`；
    - 计时器放在列表组件里，每秒只有这棵子树重渲染，`MessageArticle` 的 `memo`（`conversation-view.tsx:60`）不受影响；
    - `n` 到 0 后仍显示 `（0s 内未操作将自动允许）`，按钮可用，等权威事件或快照改写。
- **`turn-actions.ts`**（210 → ≤290）：在 `useTurnActions` 内新增 `answerApproval = useCallback((approvalId, decision) => Promise<boolean>)`，并加入返回对象（`:209`）。
  - 围栏、结果分支与对账合在一个函数里会超过 biome `noExcessiveCognitiveComplexity` 15，须拆成 hook 内的 `useCallback` 或文件内的非导出辅助函数（先例：#476 拆 `parseMessage`）。
  - 依赖只用已注入的成员：`clientRef`、`mountedRef`、`requestedSessionRef`、`installSnapshot`、`openSource`、`setPromptError`。**不新增 `TurnActionDeps` 成员，不调用 `abortMutation`，不写 `mutationControllerRef`/`mutationGenerationRef`/`setSubmitting`/`setMutationOwner`。**
  - 流程：
    1. 读取 `ownedClient = clientRef.current` 与 `sessionId = requestedSessionRef.current`。`sessionId` 为 null 时 resolve `false`。
    2. `setPromptError(null)`，同 `dispatchPrompt:146`。
    3. 调 `ownedClient.decideApproval(sessionId, approvalId, decision)`，不传 signal。作答是写操作，不中止它。
    4. 结果处理，先过围栏，再按结果分支：
       - 围栏：`!mountedRef.current || ownedClient !== clientRef.current || requestedSessionRef.current !== sessionId` 时 resolve `false`，不写任何 UI；
       - 200 → resolve `false`，body 不写入视图（proposal 偏离 3）；
       - `isUnauthorized`（`errors.ts:3`）→ resolve `false`，登录交接由客户端 `onUnauthorized` 负责；
       - `error instanceof ApiError && error.status === 409 && error.code === "approval_settled"` → 启动对账，resolve `false`。按 code 判别，见 carry-forward 第 2 行；该谓词只在本文件内定义，不导出；
       - 其它 → `setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) })`，resolve `true`。
    - 返回的 Promise 永不 reject。
  - **对账**：`ownedClient.getMessages(sessionId)`，结果处理：
    - resolve 时先过同一围栏，再 `installSnapshot(snapshot, ownedClient)`，然后 `openSource(snapshot, ownedClient)`；
    - reject 时不写 UI：不设 alert，不关源。
    - 不在 GET 之前 `closeSource()`（proposal 偏离 5），理由：
      - 旧连接在 GET 期间继续交付 `approval.resolved`；
      - `openSource` 在同一同步段内先关旧源（`page.tsx:186`）再开新源，不会出现两个源同时交付；
      - 新源每次 open 都会重新拉快照（`stream.ts:303-308`），所以即便对账晚于一次 `loadHistory` 或 `dispatchPrompt` 的受理对账才落地，也会自行收敛到最新快照（期间视图可能短暂回退）。
    - 不复用 `loadHistory`：它先置 `loading`、先关源、失败时报历史错误，三点都与「静默对账」冲突。
    - 只 `installSnapshot` 而不重连是**禁止**的：旧源随后会把已被新快照覆盖的帧（如 `text.delta`）再次归约，造成正文重复。
- **`conversation-view.tsx`**（164 → ≤185）：
  - `ConversationViewProps` 加 `onAnswerApproval`，经 `MessageThread` 传给 `MessageArticle`；
  - 助手分支在 `.chat-msg-main` 内、`.chat-md`（`:83`）**之前**渲染 `<ApprovalBars approvals={message.approvals} onAnswer={onAnswerApproval} />`；
  - 用户分支不渲染（快照已保证 user 消息的 `approvals` 为 `[]`）。
- **`page.tsx`**（620 → ≤630）：
  - `:314` 解构处加 `answerApproval`；
  - `:605-617` 给 `ConversationView` 加 prop `onAnswerApproval={answerApproval}`；
  - 其余不动，不搬 `createAndSelect`/`submitComposer`（carry-forward 76）。
- **`messages.css`**：新增 `.chat-approvals`、`.chat-approval`（含 `--allow`/`--deny` 修饰）、`-head`、`-tool`、`-body`、`-countdown`、`-ops` 规则。
  - `.chat-approval-body` 含 `white-space: pre-wrap;`；
  - fieldset 复位 `margin: 0; padding…; min-inline-size: 0; border…`，同 `.chat-quick-row`（`chat.css:199-207`），防止 390px 视口溢出；
  - 颜色只用语义 token：`--wb-status-warning*`、`--wb-status-success*`、`--wb-status-error*`，见 `tokens.css:73-120`。demo 按钮的 `#fff` 用 `Button variant="primary"` 替代。

## Governing invariant
每个审批条只按自己的 `approval.id` 作答，且每次点击只发一次请求。条的决定只来自权威来源：`approval.resolved` 事件，或快照（含 409 后的对账快照）。作答请求不影响 prompt 的 mutation fence 与 composer 锁定。

## Must preserve
- `dispatchPrompt` 的 fence 语义（`turn-actions.ts:133-207`）不变。prompt POST 在途时旧源仍开着（`:160` 才关），期间到达的审批可以作答；作答不得中止在途的 prompt（A13）。
- composer 锁定仍只由 `generating` 决定（`page.tsx:581-586`）：running 时 textarea 禁用（`composer.tsx:35`），发送键 aria-label 为 `生成中`（`:66-68`）。本刀不改锁定逻辑。
- 助手块结构：avatar 仍是 `article.firstElementChild`，`.chat-md` 仍在步骤卡之前（`chat-messages.test.tsx:151-179` M4）。审批条插在 `.chat-md` 之前，不改变这两点。
- `turn-actions.ts` 不含 `useState`/`useEffect`/`useRef`/`useMemo`，不导入 `./page.js`；导出只供 `page.tsx` 使用（主 spec「会话页源码模块划分」）。因此 `useTurnActions` 在 `page.tsx:314` 的调用位置仍与行为无关，carry-forward 77 不被触发（G2 锁定）。`TurnActionDeps` 不加成员；hook 内多一个 `useCallback`，只是 hook 数量的静态变化，调用位置不变。`ApprovalBars` 的 hook 属于独立组件，不影响 `ChatPage` 的 hook 次序。
- `page.tsx` 仍含 `useTopbar(`，不含 `<h1`、`routes/`（`topbar.test.tsx:285-287`）。

## Sibling surfaces
- **必然破坏的既有测试：无。** 依据：
  - 既有 web 夹具的消息都带 `approvals: []`（`chat-stream-support.ts:23/33/70`，#476 已补齐），此时 `ApprovalBars` 返回 `null`，DOM 不变；
  - 没有测试直接渲染 `ConversationView`/`MessageArticle`，也没有测试调用 `useTurnActions`（`grep -rln` 为空）。
  - **允许的既有测试编辑：无**（issue：「既有测试文件不增长」）。实现后若 `npm test`/`make typecheck` 暴露清单外的破坏，停下上报，不改既有测试。
- 约束新代码、且恒绿的既有守卫：
  - `chat-messages.test.tsx:210-215` M5（messages.css 无字面颜色）；
  - `ui-guardrails.test.ts:46-57`（features 下 css/tsx 无 hex/rgba、无 `--wb-palette-`）与 `:92-107`（无 `ui-button`）；
  - `chat-composer.test.tsx:77-86` C2（composer 表单内恰一个按钮，审批按钮不在表单内）；
  - `chat-messages.test.tsx:200-208` M5（全 web/src 无 `innerHTML`：title 只作文本节点渲染）。
- 生产消费者：`index.ts` 导出面不变；e2e ui-walk 在 8.2a 之前不涉审批；smoke 不涉 web。

## Seams under test
- 新建 `web/test/chat-approval-bar.test.tsx`（≤800 行），全部走页面级：
  - `renderChatPage(`/?session=${SESSION_ID}`, routes)`（`chat-page-support.tsx:24`，内部 `vi.stubGlobal("EventSource", FakeEventSource)`）；
  - 事件经 `latestSource()` 的 `emitOpen()`/`emitData(type, "1:n", payload)` 送入（`chat-stream-support.ts:151-208`，先例 `chat-page.test.tsx:144-160`）；
  - 请求断言经 `fetchMock.mock.calls` 过滤路径 `/api/sessions/${SESSION_ID}/approvals/<id>`，并比对 `JSON.parse(init.body)`；
  - 快照由本文件自建：展开 `chatSnapshot({ status: "running", cursor })` 后替换 `messages[1]` 的 `approvals`。`chat-stream-support.ts` 不改。
  - messages 路由会在初次加载、每次 `emitOpen`、对账时各命中一次，所以用闭包变量按阶段返回快照，不用数组 `shift()`。
- **注入时钟**：web 现无 `Date.now`/`setInterval` 使用者，仓库的注入惯例是 stub 全局（`EventSource`）与 fake timers（`ui-toast.test.tsx:48`）。本刀不加生产 seam，时钟就是平台时钟：
  - 每个用例在 `renderChatPage` **之前**调用 `vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })` 与 `vi.setSystemTime(T0)`；
  - 推进时钟用 `act(() => { vi.advanceTimersByTime(1000); })`；
  - `afterEach` 调 `cleanupChatPage()` 与 `vi.useRealTimers()`。
  - `setTimeout` 不 fake：`settle()`（`chat-stream-support.ts:91`）、Radix Toast 与 RTL 超时照常运行。
  - **禁止 `vi.waitFor`**：fake timers 下它每次轮询都会 `advanceTimersByTime(interval)`（`node_modules/vitest/dist/chunks/test.DNmyFkvJ.js:3380`），倒计时会被悄悄推进。
  - RTL 的 `findBy*`/`waitFor` 轮询用的是被 fake 的 `setInterval`，只在 DOM 变更时复查，所以只能等待 DOM 谓词。断言 fetch 次数前先 `await act(settle)`。
- 源码守卫：`readRepoFile` + `ruleBody`/`stripComments`（`ui-support.ts:65`，先例 `chat-composer.test.tsx:211-226`）。

## Required evidence
常量：`T0 = 1_750_000_000_000`，`TITLE = "Allow tool: bash\nReason: run ls"`。页面加载 running 快照（assistant id 0，cursor `1:0`）后 `emitOpen`，事件序号从 `1:1` 起。

| ID | 输入 | 期望 |
|---|---|---|
| A1 pending（红） | `approval.request{0,7,"bash",TITLE,T0+60000}` | 助手 article 内 `getAllByRole("group",{name:"需要你的确认"})` 长度 1；`.chat-approval-tool` 文本 `bash`；`.chat-approval-body` 的 `textContent === TITLE`（含 `\n`）；组内匹配 `/内未操作将自动允许/` 的元素恰 1 个、文本 `（60s 内未操作将自动允许）`；无 `progressbar`，无文本匹配 `/^\d+s$/` 的元素；`允许`/`拒绝` 可用；**守卫**：textarea `disabled`，`getByText("生成中",{exact:true})` 存在（该 `<p role="status">` 无可访问名，先例 `chat-composer.test.tsx:133-139`） |
| A2 tick（红） | A1 后推进 1000ms；再推进 59000ms；再推进 5000ms | 依次为 `（59s …）`、`（0s …）`、`（0s …）`，按钮仍可用 |
| A3 允许 200（红） | A1 后 POST 用 `deferredResponse` 挂起；连续两次 `fireEvent.click(允许)`（各自 act）；**resolve 之前**断言；再对实时源 `emitGap()`，令重拉快照中 id 7 仍 pending（仍挂起 POST）；然后 resolve 200 六键 `decision:"allow"`，`await act(settle)` | resolve 之前：该路径 POST 恰 1 次，body `{"decision":"allow"}`；两按钮已 `disabled`；组名仍为 `需要你的确认`；gap 重装快照后按钮仍 `disabled`、无第二个 POST（`sent` 按 `approval.id` 保留，不因列表替换复位）。resolve 后：头部与组名仍为 `需要你的确认`（200 body 不回写，变异「应用 200 body」→ 红）；随后 `approval.resolved{0,7,"allow"}` → 组名 `已允许执行`，无按钮、无倒计时，徽章 `bash` 与正文 TITLE 仍在 |
| A4 deny/timeout（红） | 两条 pending 7、8；resolved{8,"deny"}、resolved{7,"timeout"} | 8 → `已拒绝执行`，7 → `已允许执行`；均无按钮、无倒计时 |
| A5 409 对账（红） | A1 后点 `允许` → 409 `{error:{code:"approval_settled",message:"该审批已处理"}}`；对账 GET 返回同快照但 7 为 `decision:"timeout"` | 无 `role=alert`，无 `.ui-toast`；组名 `已允许执行`；messages GET 次数 +1（在新 source `emitOpen` 之前计数，open 会再拉一次快照，见 `stream.ts:303-308`）；原 source `closeCount === 1`；`FakeEventSource.instances` +1。反例：同为 409 但 code 为 `session_busy` → 走 A6 路径（alert + 解禁，无对账 GET），证明按 code 判别 |
| A5b 对账失败（红） | 同 A5，但对账 GET 返回 502 信封 | 无 alert；原 source `closeCount === 0`，无新 source；该条仍为 `需要你的确认` 且按钮禁用；随后 `approval.resolved{7,"timeout"}` 经旧源到达 → `已允许执行` |
| A6 其它信封（红） | A1 后点 `拒绝` → 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}` | `role=alert` 文本 `Agent 运行时不可用`；无对账 GET；该条两按钮恢复可用（proposal 偏离 4）；再点 `拒绝` → 第二次 POST 发出、alert 先被清除 |
| A7 两条独立（红） | request 7 后 request 8（均 bash） | 两个同名组，文档序 7→8，第二个 request 未替换第一个；点 8 的 `拒绝` → 只发 `/approvals/8` `{"decision":"deny"}` 一次，只禁用第二组两按钮，第一组按钮可用且倒计时在；resolved{8,deny} → 第二组 `已拒绝执行`，第一组仍 `需要你的确认`，textarea 仍禁用；点 7 `允许` + resolved{7,allow} → 第一组 `已允许执行`，两组均无按钮 |
| A8 刷新 pending（红） | 初始快照即含 `{id:7,tool:"bash",title:TITLE,requestedAt:T0-20000,expiresAt:T0+40000,decision:null}` | 首屏 `（40s 内未操作将自动允许）`；推进 1000ms 后为 `（39s …）`；点 `允许` 发出 `/approvals/7` POST |
| A9 刷新终态（红） | 快照含两条 done 助手：一条 `[{7,timeout}]`，一条 `[{8,deny}]`，另一条助手 `approvals:[]` | 前两者组名分别为 `已允许执行`、`已拒绝执行`，无按钮、无倒计时；第三条 article 内无 `group`、无 `.chat-approvals` |
| A10 徽章取字段（红） | request `{tool:"python", title:"Allow tool: bash\nReason: x"}` | 徽章为 `python`（重解析 title 的变异 → `bash`，红） |
| A11 计时器生命周期（红） | A1 时；A3 resolved 后 | `vi.getTimerCount()` 为 1；resolved 后为 0（无 pending 不留 interval）。若 RTL 轮询干扰计数，改用 `vi.spyOn(globalThis, "setInterval")` 与 `clearInterval` 的调用次数作证：只调 1 次 set，resolved 后 clear 1 次 |
| A12 围栏（红） | A1 后点 `允许`，POST 用 `deferredResponse` 挂起；导航到另一会话后令其 409 | 旧会话无对账 GET，无新 source 指向旧会话，无 alert |
| A12b 对账 GET 阶段围栏（红） | A1 后点 `允许`，POST 立即 409 `approval_settled`；对账 GET 用 `deferredResponse` 挂起；导航到会话 B，待 B 的源建好后令 GET_A 返回快照 | B 源 `closeCount === 0`；导航后无新建 URL 指向 A 的 `FakeEventSource`；无 alert；视图仍为 B（`openSource` 自身不查 `requestedSessionRef`，只有 `installSnapshot` 自检，故漏掉 GET 阶段围栏会关掉 B 的源） |
| A12c 账号续期围栏（fix pass 1） | `renderChatPageWithAuthProbe` 下 A1 后点 `允许`，POST 挂起；`renewAccount` 续期（同一会话仍选中、新 client 源建好）后令其 409 `approval_settled` | 无 messages GET；新源 `closeCount === 0`；source 数量不增；无 alert（`openSource` 不查 client，漏掉 client 臂会关新账号的源） |
| A13 不动 prompt fence（红） | done 会话发 prompt，prompt POST 挂起；旧源送 `turn.start{2}` 与 `approval.request{2,9,…}`；点 `允许` → 200；再令 prompt 202 `{userMessageId:1,assistantMessageId:2}` | prompt 的受理对账照常发生：messages GET +1 并安装、开新源。复用 `abortMutation` 的变异会中止 prompt，不再对账，因此红 |
| G1 CSS（`pre-wrap` 红，颜色恒绿） | `ruleBody(stripComments(messages.css), ".chat-approval-body")` | 含 `white-space: pre-wrap;`；既有颜色守卫全绿 |
| G2 源码守卫（恒绿） | `readRepoFile("web/src/features/chat/turn-actions.ts")` | 不含 `useState(`、`useEffect(`、`useRef(`、`useMemo(`、`./page.js` |
| G3 既有套件（恒绿） | `npm test --workspace web` | 既有测试零 diff 全绿 |

**Scenario → 证据映射**：
- chat-web「审批条挂起、允许与拒绝」→ A1、A2、A3、A4、A5；「同一消息两条并行审批分别作答」→ A7；「刷新后审批状态保留」→ A8、A9。
- tool-approval「审批条交互」→ A8（快照剩 40s，递减 1s；与 spec 的 42→41 同构）、A3；「超时与拒绝文案」→ A4；「同一消息多个审批条」→ A7。
- tool-approval「审批快照」的「刷新后继续作答」→ A8；「历史决定可见」→ A9；「多条审批的快照与归约」由 #476 的 `chat-stream-approvals.test.ts` 证明，不改。

**红/绿**：A1–A13 与 G1 的 `pre-wrap` 断言先对 master 跑红，记录失败输出。下列变异逐一临时施加，确认对应用例变红，并把结果记入 PR body：
- 200 body 写入视图 → A3；
- 徽章解析 title → A10；
- 每条各自一个 interval，或无 pending 时不清理 → A11；
- 仅按 status 409 判别 → A5 反例；
- 对账不重连 → A5（`instances` 不增）；
- 作答前调 `abortMutation` → A13；
- 失败后不解禁 → A6；
- 去掉对账 GET 阶段围栏 → A12b；
- `ownsAnswer` 去掉 client 臂 → A12c；
- `<ApprovalBars>` 挪到正文之后 → A1（`compareDocumentPosition`）；
- 只在 POST 响应后才禁用 → A3；
- approvals 变化时复位 `sent` → A3。

## Non-goals
见 proposal Non-goals。

## Review focus
1. 作答 handler 不触碰 mutation fence（A13）；围栏只用已注入的三个 ref（A12）。
2. 409 按 `error.code` 判别；对账先 GET、成功后同步段内 `installSnapshot` + `openSource`；失败时静默且保留旧源（A5、A5b）。
3. 非乐观更新：200 不回写视图；按钮状态只在条内，失败时解禁（A3、A6）。
4. 计时：每个含 pending 的列表一个 interval，`now` 在渲染时取值，无 pending 即清除；条内只有一个倒计时元素（A1、A2、A11）。
5. 可访问名只取头部文字；徽章直接取 `tool`；正文是 title 全文且按文本渲染；行数在预算内；`turn-actions.ts` 无 hook 状态（A1、A10、G1、G2）。
