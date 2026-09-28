# Proposal: fork-button（#479）

## Why
父 change `s1c-turn-control-governance` tasks 7.3b（epic #448，issue #479）。

server 端 fork 已就位：`POST /api/sessions/:id/fork`（#466/#469），body `{messageId}`，201 返回 `{session, draft}`，失败码为 400 `bad_request`、409 `session_busy`、502 `agent_unavailable`、503 `agent_capacity`。失败不写任何行：对齐 502 发生在事务之前，CAS 复核失败时事务不写行（turn-control「从此处分叉 REST」）。web 端 `forkSession(id, messageId)` 与严格解析 `parseSessionFork`（#472，`web/src/lib/api-sessions.ts:167-185`、`session-contract.ts:245-252`）、`git-branch` 图标（#477，`icon.tsx:78`）、`turn-actions.ts` 落点（#489）也已合入。页面上还没有入口：用户消息只渲染气泡正文（`conversation-view.tsx:88-96`），没有操作行。本刀补上用户消息的 `从此处分叉`，覆盖恰调一次、composer 锁定、201 后经既有 `?session=` 选择路径跳转、刷新列表、草稿写入但不发送，以及失败内联。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded（agree：呈现改动按前端通用契约须真实浏览器收口，归 8.2d；201 的续体是一次导航加草稿写入，跨会话切换、账号续期、卸载共享页面级 fence 与 composer 锁定状态）
Blast radius: 迟到的 201 把用户从已切到的会话拽走，或覆盖其草稿 → 串会话；锁不释放 → composer 卡死；草稿被切会话 effect 清掉或被自动发送 → 多出一次 prompt；失败时导航或刷新 → 丢失当前会话视图；按钮漏出到助手消息，或锁定期间可点 → 重复 fork
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Legacy compatibility / examples；Auth / permissions / secrets
Evidence floor: 新建 `web/test/chat-fork-button.test.tsx`（≤800 行）中 design「Required evidence」F1–F10 全绿，标红者先对 master 跑红；G1–G3 恒绿；既有测试只有 design「Sibling surfaces」列出的 4 处期望改动，行数不增；`npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `message-actions.tsx`：导出 `ForkAction({ disabled, onFork })`（名字可调）。它渲染 `.chat-msg-actions` 行，行内只有一个 `Button variant="ghost" size="icon" type="button"`，类 `chat-msg-action`，`Icon git-branch`，aria-label 与 `title` 均为 `从此处分叉`。没有 Toast。顶部注释补上用户消息行。
- `conversation-view.tsx`：`MessageArticle` 的用户分支在正文（及既有 steps/error）之后渲染 `ForkAction`，作为 user article 的末子元素。`disabled` 取 `composerDisabled`，点击时调用 `onFork(message.id)`。助手分支不变。`ConversationViewProps` 与 `MessageThread` 加 `onFork`。
- `turn-actions.ts`：`useTurnActions` 加 `forkTurn(messageId): Promise<void>`（仍只用 `useCallback`，见 design）。`TurnActionDeps` 加 `historyGenerationRef`、`selectSession`、`setForkOwner` 三项。
- `page.tsx`：
  - 新增 `useState` 保存 fork 锁的归属 `forkOwner`；
  - `composerDisabled = generating || ownsMutation(forkOwner, client, requestedSessionId)`，`sendDisabled` 改由 `composerDisabled` 推导；
  - `selectSession` 的 `useCallback` 挪到 `useTurnActions` 调用之前（`const` 的 TDZ 要求，与 hook 次序无关，见 design）；
  - 解构 `forkTurn`，经 `ConversationView` 下传。
- 测试：新建 `web/test/chat-fork-button.test.tsx`。另有 4 处既有断言因「用户消息无按钮」被本功能推翻，按 design「Sibling surfaces」只改期望、不增行。

## Capabilities
- MODIFIED chat-web「会话页」：以主 spec 现文为底，逐字并入父 delta 的 **User messages** `从此处分叉` 句与 Scenario「从用户消息分叉」。本 slice 之后，该 requirement 中属于 S1c 回合控制的部分全部交付。与父 delta 只差 Welcome state 段一处与本 issue 无关的措辞，见 delta 顶部说明。
- MODIFIED turn-control「回合控制 web 呈现」：逐字取父 delta 全文，加入 `从此处分叉` 句与 Scenario「分叉跳转与草稿」。本 slice 之后该 requirement 全部交付。

## Impact
- 行数预算（实测记入 PR body）：`page.tsx` 627 → ≤645；`turn-actions.ts` 362 → ≤400；`conversation-view.tsx` 225 → ≤245；`message-actions.tsx` 59 → ≤90；新测试文件 ≤800。
- 零 diff：`api-sessions.ts`、`api.ts`、`session-contract.ts`、`stream.ts`、`stream-approvals.ts`、`types.ts`、`ownership.ts`、`session-path.ts`、`session-nav.tsx`、`composer.tsx`、`approval-bar.tsx`、`icon.tsx`、CSS、server、Makefile、CI、e2e。
- e2e：`ui-walk.spec.ts:711-717` 用 `user.locator("p").first()` 读用户正文。按钮不是 `<p>`，也没有文本，所以不受影响。真实浏览器走查归 8.2d。

## 偏离与决定
1. **fork 锁是 page 级独立状态 `forkOwner`，只进 `composerDisabled`，不进 `generating`。**
   - 与 #478 相同的是按身份释放的 page 级归属，不借用 prompt 的 mutation fence（理由同 regenerate-button 偏离 1）。
   - 与 #478 不同的是 fork 不是回合：Composer card 段写的是「While a turn is running」才换 `停止` 与 `生成中`。fork 在途时没有可停的东西，所以 textarea 与 `发送` 禁用，但 toolbar 不出现 `停止`/`生成中`。
   - 否决的更简方案是按钮局部 pending。它挡不住另一条用户消息的 `从此处分叉`、`重新生成` 和 composer 发送，会对同一源会话并发写入。
2. **201 的续体在同一同步段内依次执行 `setDraft(draft)`、`refreshList(ownedClient)`、`selectSession(session.id)`，前面有围栏。** 导航复用侧栏选择用的 `selectSession`（`page.tsx:401-406`，push，保留无关 search/hash），因此 Back 会回到源会话。草稿不需要额外机制：`draft` 是 page 级 state，切会话与换 client 的 effect 都不写它（design「Must preserve」）。
3. **围栏 = `ownsSessionWrite`（client + 选中会话 + 挂载）加「点击后未重载历史」令牌 `historyGenerationRef`。** 后者挡住 ABA：切走再切回源会话之后，迟到的 201 不再导航。regenerate 接受了 ABA（regenerate-button 偏离 5）。fork 的续体是把用户带离当前会话，所以更严格。`owned()` 同时守 201 与失败两个分支：ABA 之后迟到的错误也不写回源会话（F8 只断言 201 一支，错误支与 F6-409 同一条件）。该令牌同时保证点击时捕获的 `selectSession` 闭包里的 search/hash 仍是当前值（`loadHistory` 依赖 `location.*`）。（已裁定保留，见 Orchestrator decisions）。
4. **被围栏挡下的 201 只释放锁：不导航、不写草稿、不刷新列表。** 代价是新会话已在 server 建成，但要等下一次列表刷新才出现在侧栏。这与 `createAndSelect` 被围栏挡下时的行为一致（`page.tsx:446-453`）。
5. **任何失败都只内联信封并释放锁，不对账、不刷新列表。** fork 失败不写行（见 Why），与 regenerate 的 502 对账（`isUncommittedRegenerate`）不同。网络失败被 `fetchResponse` 包成 status 0 的 `ApiError`（`api.ts:449-455`），201 body 不合严格解析被包成 `requestFailed(201)`（`api-sessions.ts:179-182`），两者文案都是 `请求失败，请稍后重试`。其中 201 body 解析失败时 server 可能已建成新会话，web 拿不到 id，本刀不处理。见 Orchestrator decisions。
6. **放置：操作行是 user article 的末子元素，CSS 零 diff。** `.chat-msg-user`（`messages.css:28-34`）本身就是气泡，所以图标落在气泡背景内的左下角。另一种做法是把行作为 article 的兄弟节点并加一条 CSS 右对齐，那样超出 PR Boundary（CSS 未列入）。视觉判断交给 8.2d。见 Orchestrator decisions。
7. **与 issue 验收「既有测试零 diff」的偏离：4 处既有断言须改期望。** 这些断言断言「用户消息内无任何按钮」，本来就写作「直到 #479」（regenerate-button design「Must preserve」）。按父 tasks 通用纪律「既有测试只改期望值」改为按名查询，行数不增。清单见 design「Sibling surfaces」。
8. **`selectSession` 挪到 `useTurnActions` 之前。** 原因是 `const` 的 TDZ：它要作为 dep 传入。它是纯 `useCallback`，没有 effect 时序。挪动不触碰 carry-forward :76 所说的 `createAndSelect`/`submitComposer` 与 effect 的次序。`useTurnActions` 仍不含 hook 状态，:77 的守卫条件不被触发。

## Orchestrator decisions（原 Open questions，已裁定）
- ABA 令牌：保留（复用既有 `historyGenerationRef`，一次比较；证据 F8）。
- 放置：接受气泡内放置、CSS 零改动（demo 无 fork 控件；真浏览器外观由 8.2d ui-walk 收口）。
- 被围栏挡下的 201 与 201 body 解析失败：只释放锁，不刷新列表。
- 4 处既有测试期望改动（`chat-copy.test.tsx:169`、`chat-regenerate-button.test.tsx:195/210/222`）：接受，只改期望、不增行，PR body 偏离清单列出。
- Welcome state 措辞差异（主 spec `S1c` vs 父 delta change B）：不归本刀，留待 #486 收尾对账。
- carry-forward :107（fork 草稿为 omp 回显文本）：只记录，归 #494/#495。

## Non-goals
- `重新生成`（7.3a #478，已合入）、停止与 `stopped` 呈现（7.2 #477）、审批条（7.4 #480）。
- server fork 语义与状态码（5.2b #469）、API 方法与解析（7.1 #472）、`git-branch` 注册（7.2）。
- 真实浏览器与视口矩阵（8.2d）；demo 无 fork UI，不引用 demo 行（父 proposal「与 demo 的有意偏差」第 3 条）。
- carry-forward :107 的真实二进制 draft 文本问题（#494/#495）。
