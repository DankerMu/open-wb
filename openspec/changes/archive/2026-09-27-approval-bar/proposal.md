# Proposal: approval-bar（#480）

## Why
父 change `s1c-turn-control-governance` tasks 7.4（epic #448，issue #480）。

#476 已把 `approvals` 放进快照与视图态（`stream-approvals.ts:8` `ChatApprovalView`，`stream.ts:33`），#468 上线了作答 REST，#472 提供了 `decideApproval`（`api-sessions.ts:187-205`）。但 web 还没有这些数据的消费者：`conversation-view.tsx:60-97` 的 `MessageArticle` 不读 `approvals`，用户看不到审批，也无法作答。本刀补上审批条组件和作答接线，快照恢复、多条并行审批与倒计时一并交付。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：呈现改动按前端通用契约须真实浏览器收口（组 8 ui-walk），且作答接线触碰会话页共享 fence 与 EventSource 重连路径)
Blast radius: 作答打错 id 或错会话 → 替用户批准/拒绝了另一条工具调用；乐观更新或吞掉 409 → 界面与服务端决定不一致；借用 prompt 的 mutation fence → 作答中止进行中的 prompt；拒绝失败后无法重试 → 该工具在超时后被自动允许；倒计时漂移或多计时器 → 文案错误、空转重渲染
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Legacy compatibility / examples；Auth / permissions / secrets
Evidence floor: 新建 `web/test/chat-approval-bar.test.tsx`（≤800 行）中 design「Required evidence」A1–A13 全绿，标红先行者在 master 上为红；G1–G3 恒绿；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；既有测试零 diff

## What Changes
- 新建 `web/src/features/chat/approval-bar.tsx`，导出 `ApprovalBars`：按消息 `approvals` 的 id 升序渲染审批条。
  - 每条是一个 `<fieldset>`（隐式 `role="group"`），以头部文字命名。
  - 头部显示 `需要你的确认`、`已允许执行` 或 `已拒绝执行`，带 `Icon shield`。
  - 工具名徽章直接显示 `tool` 字段。
  - 正文是 `title` 全文，`white-space: pre-wrap`。
  - pending 条显示一句倒计时和 `允许`/`拒绝` 两个按钮。
  - 每条的「已发送」状态由该条组件自己持有；每个含 pending 的列表有一个秒级 tick。
- `turn-actions.ts`：`useTurnActions` 增加 `answerApproval(approvalId, decision)`，负责作答请求、409 `approval_settled` 后的快照对账与重连、其它信封的内联错误。它不使用 prompt 的 mutation fence，也不引入 `useState`/`useEffect`。
- `conversation-view.tsx`：`ConversationView` → `MessageThread` → `MessageArticle` 逐层传递一个稳定回调；审批条渲染在 `.chat-msg-main` 内、`.chat-md` 之前。
- `page.tsx`：解构 `answerApproval`，并作为 prop 传给 `ConversationView`。
- `messages.css`：新增 `.chat-approval*` 规则，只使用语义 token。
- 测试：新建 `web/test/chat-approval-bar.test.tsx`；既有测试不改。

## Capabilities
- MODIFIED chat-web「会话页」：以主 spec 现文为底，并入两部分，其余段落与 Scenario 保持主 spec 原样（归 #477/#478/#479）：
  - 父 delta 的 **Approval bar** 段，逐字，裁去 `停止` 子句；
  - 三个审批 Scenario（「审批条挂起、允许与拒绝」「同一消息两条并行审批分别作答」「刷新后审批状态保留」），同样裁去 `停止` 子句。
- MODIFIED tool-approval「审批快照」：取父 delta 同名块逐字，补回「页面渲染审批条」「web 显示 `已拒绝执行`」两处 web 子句。本刀后该 requirement 全部交付。
- ADDED tool-approval「web 审批条」：父 delta 逐字，裁去末句 `停止` 子句；三个 Scenario 全部交付。

## Impact
- 行数预算（实测记入 PR body）：
  - `page.tsx` 620 → ≤630（carry-forward 76：剩余余量留给 #477/#478/#479）；
  - `turn-actions.ts` 210 → ≤290；
  - `conversation-view.tsx` 164 → ≤185；
  - `approval-bar.tsx` 新建，≤150；
  - `messages.css` 387 → 约 440（不在 size-guard 扫描范围，受颜色守卫约束）；
  - 新测试文件 ≤800。
- 零 diff：`stream.ts`、`stream-approvals.ts`、`session-contract.ts`、`api-sessions.ts`、`api.ts`、`errors.ts`、`types.ts`、`composer.tsx`、`web/src/ui/**`（`Icon shield` 已注册于 `icon.tsx:44`）、server、Makefile、e2e。
- 生产 argv 仍为 `yolo`（#481 之前），生产上 `approvals` 恒为 `[]`，审批条不会出现。首次真实可见要等 #481 与 8.2a。

## 偏离与决定
1. **`停止` 子句不在本刀交付。** issue In Scope 与验收都写了「有 pending 时 composer 仍锁定且 `停止` 可用」，但 `停止` 按钮归 7.2 #477。#477 仍为 OPEN，master 上没有这个按钮（`grep -rn 停止 web/src` 只命中 `status-label.ts:9` 的 `已停止` 与 `files/dialogs.tsx:67` 的对话框文案），#480 也不依赖 #477。
   - 本刀只断言「composer 仍锁定」。这由 `page.tsx:581-586` 的 `historyView?.status === "running"` 保证，属于恒绿守卫。
   - 三处 `停止` 子句从 delta 中裁去，见两个 spec delta 的 blockquote。
   - 实现开工时若 #477 已在 master：按父 delta 原文恢复这三处子句，并在 A1 追加断言 `getByRole("button",{name:"停止"})` 可用，在 PR body 说明。若尚未合入：由 #477 与 #480 中后归档者恢复。
   - 父 chat-web Scenario「停止生成」写的是「无挂起审批」，所以目前没有任何切片断言「有挂起审批时 `停止` 可用」，已上报编排者。
2. **工具名徽章取 `tool` 字段，web 不解析 title。** 父 tasks 7.4 原文（以及父 design.md:87 D5）写「title 首行 `Allow tool: <name>` 解析」。父 spec（chat-web Approval bar 段：「the web does not re-parse」）与 issue In Scope 较晚定稿，写明解析由 server 完成、结果放在 `tool`。本刀按 spec 实现，A10 用 `tool:"python"` 配 `Allow tool: bash` 的 title 钉住这一点。tasks.md 仍逐字引用父 task 原文，另加一条说明。父 tasks/design 措辞的漂移留给归档 PR 处理。
3. **作答 200 的 body 不写入视图。** spec 要求「不乐观更新，随 `approval.resolved` 或下一份权威快照重渲染」，所以按钮保持禁用、头部不变，直到事件或快照到达（A3）。
4. **非 `approval_settled` 的失败后，该条按钮恢复可用。** spec 只规定「恰调一次」「其它信封内联 composer」，没有规定失败后能否再答。若失败后保持禁用，一次瞬时失败的「拒绝」会在 60s 后变成自动允许，用户无从补救。所以 502/400/404、`request_failed` 这类失败显示内联错误并解禁该条（A6）。一次点击仍只发一次请求。
5. **409 对账失败时静默。** 409 表示该审批已被结算，结算时已发布 `approval.resolved`。对账是「先 GET、成功后 `installSnapshot` + `openSource`」，GET 之前不关旧连接，所以 GET 失败时实时连接仍在，不显示错误、视图不变（A5b）。这与 `dispatchPrompt` 的「先关源」次序不同，理由见 design。
   偏离 4、5 的行为 spec 没有明文，只写在 design 里（由 A6、A5b 钉住），不并入 spec delta。
6. **越出 PR Boundary：改 `messages.css`。** issue 的文件清单没有 CSS。但 `white-space: pre-wrap` 与状态配色需要样式规则：feature 下禁止字面颜色（`ui-guardrails.test.ts:46-57`），内联 `style={}` 也不是本仓写法。助手消息的样式本来就在 `messages.css`，只追加 `.chat-approval*` 规则，不改已有规则。

## Open questions（上报编排者）
- `停止` 子句的归属与恢复时机（偏离 1）。建议写入 carry-forward：#477 与 #480 中后归档者，以已推进的主 spec 为底恢复父文，并补「pending 审批时 `停止` 可用」断言。
- carry-forward 80（decide 发布的 `approval.request`/`resolved` 可能早于 pump 的 `turn.start`，web 的 `turn.start` 重置随后清空 `approvals`）：不影响本刀验收，因为测试显式驱动事件顺序。真实影响是审批条可能短暂消失，直到下一次快照或重放。服务端 CAS 保证不会重复作答。根因在 server 发布次序，`stream.ts` 在本刀 PR Boundary 之外。仍属 out-of-scope。
- 父 tasks 7.4 与父 design D5（design.md:87）的「title 首行解析」措辞与 spec 不一致，建议归档 PR 顺带改成「取 `tool` 字段（server 解析）」。

## Non-goals
- 快照解析与 `approval.*` 归约（5.3 #476）；`decideApproval` 方法（7.1 #472）；server 审批 REST、事件与超时（5.2a #468、组 4）。
- composer `停止` 按钮及其在 pending 审批下的可用性（7.2 #477，见偏离 1）；重新生成（#478）；分叉（#479）。
- `turn.start` 重置与 server 审批事件发布次序（carry-forward 80）；200 body 回写视图。
- 真实浏览器与视口矩阵（8.2a ui-walk，与 #481 同 PR）；新增图标、新增 UI 基元。
