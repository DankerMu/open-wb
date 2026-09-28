# Proposal: regenerate-button（#478）

## Why
父 change `s1c-turn-control-governance` tasks 7.3a（epic #448，issue #478）。

server 端 regenerate 已就位：`POST /api/sessions/:id/regenerate`（#467），无 body，202 返回 `{assistantMessageId}`，失败码为 409 `session_busy`、400 `bad_request`、502 `agent_unavailable`、503 `agent_capacity`。web 端 `regenerateSession(id)`（#472，`web/src/lib/api-sessions.ts:152-165`）、`refresh-cw` 图标（#477）、`turn-actions.ts` 落点（#489）也已合入。页面上还没有入口：助手消息操作条只有 `复制`（`message-actions.tsx:4-27`），且只在正文非空时出现（`conversation-view.tsx:114`）。所以 stopped 后正文为空的末条回答（8.2c 的走查对象，carry-forward :112）连操作条都没有。本刀补上末条助手消息的 `重新生成`：可用性判定、恰调一次、composer 锁定、202 后对账替换、失败内联。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded（agree：呈现改动按前端通用契约须真实浏览器收口，归组 8 ui-walk 8.2c；regenerate 的两段异步〔POST→202、GET→装快照〕跨会话切换、账号续期与卸载共享页面级 fence 与 composer 锁定状态）
Blast radius: 迟到的 202/GET 关掉当前会话的 EventSource、装入别的会话快照 → 转录串会话；锁定状态不释放 → composer 卡死；借用 prompt 的 mutation fence → 中止或解锁另一会话的在途 prompt；本地合成新行 → 与 SSE 帧重复成两条助手行；非末条或 running 时可点 → 409 噪音；空正文出 `复制` → 复制出空串
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Legacy compatibility / examples；Auth / permissions / secrets
Evidence floor: 新建 `web/test/chat-regenerate-button.test.tsx`（≤800 行）中 design「Required evidence」R1–R12 全绿，标红者先对 master 跑红；G1–G3 恒绿；既有测试零 diff；`npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `message-actions.tsx`：
  - `MessageActions` 增加可选 `regenerate` 入参（`{ disabled, onRegenerate }`，名字可调）；
  - `复制` 只在 `text !== ""` 时渲染；
  - 有 `regenerate` 时在 `复制` 之后渲染 `重新生成`：`Button variant="ghost" size="icon" type="button"`，类 `chat-msg-action`，`Icon refresh-cw`，aria-label 与 `title` 均为 `重新生成`；
  - 点击后 handler resolve `true` 时出 Toast `正在重新生成…`（`info`，demo:2485）。
  - 顶部注释「a single 复制 button」随之改写。
- `conversation-view.tsx`：
  - `MessageThread` 判定可用性：末条消息 `role === "assistant"`，且 `historyView.status ∈ {done, failed, stopped}`。只把 `regenerate` 传给这一条。
  - `MessageArticle` 的操作条条件由 `status !== "running" && content !== ""`（`:114`）放宽为 `status !== "running" && (content !== "" || regenerate 可用)`（carry-forward :112）。
  - `重新生成` 的 `disabled` 取 `composerDisabled`。
- `turn-actions.ts`：`useTurnActions` 增加 `regenerateTurn(): Promise<boolean>`，负责 POST、两段 `ownsSessionWrite` 围栏、202 后对账（`closeSource` → GET → `installSnapshot` + `openSource` + `refreshList`）、错误内联，以及在每个分支按身份释放 regenerate 锁。`TurnActionDeps` 只加一个 setter。不新增 hook，不碰 prompt 的 mutation fence。
- `page.tsx`：
  - 新增一个 `useState`，保存 regenerate 锁的归属 `{client, sessionId} | null`；
  - `generating` 加一项「当前 client 与选中会话持有的 regenerate 锁」；
  - 解构 `regenerateTurn`，经 `ConversationView` 下传。
- 测试：新建 `web/test/chat-regenerate-button.test.tsx`；既有测试零 diff。

## Capabilities
- MODIFIED chat-web「会话页」（部分交付）：以主 spec 现文为底，逐字并入父 delta 的以下部分：
  - **Messages** 段的操作条改写句、`重新生成` 两句、`Like/dislike are dropped.`；
  - 业务错误段的 503 括注「on prompt or regenerate」；
  - Scenario「重新生成末条回答」全文，「容量已满内联提示」的 regenerate 句。
  - 未交付：**User messages** 的 `从此处分叉` 与 Scenario「从用户消息分叉」归 7.3b #479。
- MODIFIED turn-control「回合控制 web 呈现」（部分交付）：主 spec 原文加父 delta 的 `重新生成` 句。两个既有 Scenario 不变。`从此处分叉` 句与「分叉跳转与草稿」归 #479。

## Impact
- 行数预算（实测记入 PR body）：`page.tsx` 622 → ≤632；`turn-actions.ts` 292 → ≤350；`conversation-view.tsx` 199 → ≤225；`message-actions.tsx` 28 → ≤60；新测试文件 ≤800。
- 零 diff：`api-sessions.ts`、`api.ts`、`session-contract.ts`、`stream.ts`、`stream-approvals.ts`、`types.ts`、`ownership.ts`、`composer.tsx`、`approval-bar.tsx`、`icon.tsx`、CSS（`.chat-msg-action` 及其 `:hover:not(:disabled)` 已有）、server、Makefile、CI、e2e。
- e2e 不查询助手操作条（`web/e2e/` 无 `复制`/`chat-msg-action` 引用），不受影响。真实浏览器走查归 8.2c。

## 偏离与决定
1. **regenerate 锁是 page 级新状态，不借用 prompt 的 mutation fence。** 理由见 design「Change surface」与「Governing invariant」。概括如下：
   - `submitting`/`mutationOwner`/`mutationControllerRef` 由 prompt 独占。会话切换 effect 只在存在 `pendingCreateSend` 时清它们（`page.tsx:347-355`）；
   - 被围栏挡下的 `dispatchPrompt` 续体直接 return，不清理（`turn-actions.ts:155-164`）；
   - 所以 regenerate 若写这些字段，要么在被围栏的迟到结果后卡住（`mutationControllerRef` 非空时 `submitComposer` 直接 return，`page.tsx:517`），要么解锁另一会话的在途 prompt。
   - 新状态放 `page.tsx`，不放 `turn-actions.ts`。G2（`chat-approval-bar.test.tsx:660-665`）禁止后者出现 `useState(`/`useRef(`。因此 `useTurnActions` 仍无 hook，carry-forward :77 的 hook 次序守卫不被触发。
2. **对账复用 prompt 受理后的尾段（close → GET → install + open + refreshList），不按 `assistantMessageId` 本地合成新行。**
   - 父 turn-control 句写的是「以响应的 `assistantMessageId` 替换」，issue 写的是「不在本地合成」。两者结果形状一致。
   - `assistantMessageId` 在 web 中不被使用。归档对账时可把父句措辞改成「对账替换」（见 Open questions）。
3. **202 后 GET 失败沿用 prompt 的 accepted 失败语义**（`turn-actions.ts:106-114`）：
   - 显示 `streamError`，内容为信封文案加 `。请刷新页面后重试`；
   - regenerate 锁照常释放；
   - composer 按既有「终端连接失败」规则保持锁定，切走再切回（`loadHistory` 清 `streamError`，`page.tsx:260`）即恢复。
   - 这不是卡死：design R5 用「切走再切回后可用」证明锁已释放。
4. **regenerate 在途时 `停止` 可点**（`generating` 为真，与 prompt 在途一致）。提交前窗口内的 stop 是 204 空操作，regenerate 照常跑完，web 无法中止这一窗口（carry-forward :101）。只记录，不修。design R6 断言 204 不打断 regenerate 的对账。
5. **单槽锁。** 场景：A 的 regenerate 在途时切到 B 并在 B 上 regenerate，B 的锁覆盖 A 的锁。
   - 若 A 的 POST 仍未返回时切回 A，A 的 composer 不再锁定，`重新生成` 可点；
   - 此时再点，server 持有占用，返回 409 `session_busy` 内联，无害。
   - 按身份释放保证 A 的迟到结果不会解锁 B（design R10）。
6. **`重新生成` 在 composer 锁定期间禁用（`disabled={composerDisabled}`），不隐藏。** 可见性只由「末条 + 会话终态」决定。这样恰一次与「prompt 在途不可点」由同一条件得到。
7. **issue 验收「分叉继承 done|failed|stopped 的会话末条助手可见」**：web 看不到 `parent_session_id`（严格解析不入视图）。分叉会话在 web 中与同状态普通会话无从区分，所以由 done/failed/stopped 三态用例覆盖，不单设用例。真实分叉路径归 #479 与 8.2d。
8. **regenerate POST 返回 502（或非 `ApiError`）时，内联信封、释放锁之外再静默对账**（`reconcileSettled`，仍归属才调）。server 在事务提交后派发失败也返回 502：旧助手行已删、新行与会话结算为 failed，不复活旧行（turn-control「重新生成 REST」，`server/src/sessions/branching.ts:126-157`）。web 无法区分提交前后，所以一律以快照为准；提交前的 502 只是重装同一快照。409/400/503/401 证明未提交，不对账。代价：`turn-actions.ts` 350 → 362，超出 Impact 的 ≤350 预算。证据 design R4-502a/b。

## Orchestrator decisions（原 Open questions，已裁定）
- 偏离 3：采纳推荐——202 后 GET 失败沿用 prompt accepted 失败语义（`streamError` + 刷新引导，composer 按既有终端失败规则锁定）。
- 偏离 5：接受单槽锁及其边角（再点得 server 409，无害），不做按会话多把锁。
- 偏离 4：记入 carry-forward，交 8.2c/#483/#485 走查注意；本刀不修。
- 偏离 2：父 turn-control「回合控制 web 呈现」的 `assistantMessageId` 替换措辞在 #478 归档对账时改为「受理后对账替换」。
- `refreshList` 保留（与 prompt 受理同尾段），R3 的列表 GET +1 为证据。
- 偏离 8（PR #632 review 第 1 轮 integration P2）：采纳——502 与非 `ApiError` 的 POST 失败静默对账，409/400/503/401 不对账；R4 拆出 R4-502a/b；`turn-actions.ts` 预算放宽到 362。

## Non-goals
- `从此处分叉`（7.3b #479）；停止按钮与 `stopped` 呈现（7.2 #477，已合入）；审批条（7.4 #480）。
- server regenerate 语义与状态码（5.1b #467）；API 方法与解析（7.1 #472）。
- 真实浏览器与视口矩阵（8.2c）；S7 类 server 残局；提交前窗口的 stop 空操作（偏离 4）。
