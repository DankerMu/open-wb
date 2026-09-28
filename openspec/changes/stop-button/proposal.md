# Proposal: stop-button（#477）

## Why
父 change `s1c-turn-control-governance` tasks 7.2（epic #448，issue #477）。

server 端停止已全部就位：`POST /api/sessions/:id/stop`（#475，202 `{}` / 204）、`turn.end stopped` 归约与落盘（#455/#473）。web 端 `stopSession(): Promise<"stopping"|"idle">` 与 `SESSION_STATUS_LABEL.stopped`（#472）、`turn-actions.ts` 落点（#489）也已合入。但页面上还没有 `停止` 入口：running 期间 composer 只把发送键改名 `生成中` 并禁用（`composer.tsx:65-74`）。`stopped` 助手消息也没有专门呈现：正文为空且无步骤时整块空白（`conversation-view.tsx:94-104`，carry-forward :22）。步骤徽章与侧栏圆点的 `stopped` 类名已经输出，但没有样式（#472 偏离 5 指派给本刀）。本刀补上停止按钮、已停止呈现、容量文案验收与三个图标注册。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：呈现改动按前端通用契约须真实浏览器收口（组 8 ui-walk 8.2b）；停止接线与 composer 锁定状态机、会话/账号 fence 共享页面级状态)
Blast radius: 停止键卡死在禁用态 → 用户在 S7 类残局或丢失 `turn.end` 后无法再停；停止键误作 submit → 发出 prompt；stop 走 prompt 的 mutation fence → 中止在途 prompt；迟到的 stop 结果写入别的会话 → 错误 Toast/告警；把 204 的 `"idle"` 写进视图 → 回合被误判结束、composer 提前解锁；占位写进 content → 复制出占位文本
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Error handling / rollback / partial outputs；Legacy compatibility / examples；Auth / permissions / secrets
Evidence floor: 新建 `web/test/chat-stop-button.test.tsx`（≤800 行）中 design「Required evidence」S1–S13 全绿，标红者先对 master 跑红；G1–G4 恒绿；allowed-edit 清单内三处既有断言按值改动，其余既有测试零 diff；`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `composer.tsx`：
  - running（`generating`）期间，toolbar 的发送键换成圆形主按钮 `停止`：`Button variant="primary" size="icon" type="button"`，`Icon square`，aria-label 与 `title` 均为 `停止`；
  - 按钮的「请求在途」禁用态由组件自己持有；
  - 202 → Toast `已停止生成`（`info`）。
  - `<p role="status">生成中</p>` 保持原样。
- `turn-actions.ts`：`useTurnActions` 增加 `stopTurn()`，负责 stop 请求、会话/账号 fence 与错误信封内联。不引入 hook 状态，不碰 prompt 的 mutation fence。
- `conversation-view.tsx`：
  - `stopped` 助手消息在正文之后渲染 `role="status"` 徽章 `已停止`（accessible name `助手消息 已停止`）；
  - 正文为空时，正文区显示占位 `（已停止生成）`；
  - 向 `Composer` 传入 `onStop` 与当前选中会话 id（用于停止键的禁用判定与 key）。
- `page.tsx`：解构 `stopTurn`，传给 `ConversationView`。
- `web/src/ui/icon.tsx`：注册 `square`、`refresh-cw`、`git-branch`。
- `chat.css`/`messages.css`：补 `stopped` 的圆点、步骤徽章、消息徽章与停止键样式，只用语义 token（偏离 1）。
- 测试：新建 `web/test/chat-stop-button.test.tsx`；既有测试只改 design「Sibling surfaces」列出的三处期望值。

## Capabilities
- MODIFIED chat-web「会话页」（部分交付）：以主 spec 现文为底，逐字并入父 delta 的以下部分：
  - 列表 `已停止`、步骤徽章 `已停止`、`stopped` 消息徽章与占位句；
  - Composer card 整段、业务错误段的 503 括注（只写 prompt）与锁定句；
  - Approval bar 末句 `停止` 子句（恢复 #480 所裁）；
  - Scenario「停止生成」「助手消息级已停止呈现」全文，「容量已满内联提示」裁去 regenerate 句；「审批条挂起、允许与拒绝」补回 `停止` 可用。
  - 未交付：`重新生成`/regenerate 503 归 #478，`从此处分叉` 归 #479。
- MODIFIED turn-control「回合控制 web 呈现」（部分交付）：主 spec 原文加父 delta 的三句（`stopped` 消息呈现、composer `停止`、503 文案）。Scenario「停止按钮与文案」以父原文原位替换 #472 的暂写版，新增「容量文案」。`重新生成` 句归 #478，`从此处分叉` 句与「分叉跳转与草稿」归 #479。
- MODIFIED tool-approval「web 审批条」：父 delta 同名块逐字，补回末句「会话 running 且存在 pending 审批时 composer 仍显示 `停止`」。本刀后该 requirement 全部交付。

## Impact
- 行数预算（实测记入 PR body）：`page.tsx` 621 → ≤626；`turn-actions.ts` 268 → ≤310；`conversation-view.tsx` 184 → ≤215；`composer.tsx` 82 → ≤130；`icon.tsx` 91 → ≤97；新测试文件 ≤800。CSS 不在 size-guard 范围，受颜色守卫约束。
- 零 diff：`stream.ts`、`stream-approvals.ts`、`session-contract.ts`、`api-sessions.ts`、`api.ts`、`errors.ts`、`status-label.ts`、`session-nav.tsx`、`approval-bar.tsx`、`message-actions.tsx`、server、Makefile、CI、e2e。
- e2e 只按 `form` 内 `role=status` 文本 `生成中` 取锚（`ui-walk-approval.ts:11-16`、`ui-shots.mjs:256-260`），不受影响。真实浏览器下的停止走查归 8.2b #484。

## 偏离与决定
1. **越出 PR Boundary：改 `chat.css`/`messages.css`。** issue 文件清单没有 CSS。但 `chat-session-dot-stopped`（`session-nav.tsx:46`）与 `chat-step-status-stopped`（`conversation-view.tsx:46`）这两个类名已经输出，却没有规则；#472 proposal 偏离 5 已把这两处样式指派给本刀。新徽章与停止键也需要样式。feature 下禁止字面颜色（`ui-guardrails.test.ts:46-57`），内联 `style={}` 也不是本仓写法。只追加规则，不改已有规则（#480 `messages.css` 先例）。
2. **没有持久的「停止中」状态（carry-forward :74）。** 父文写的是「disabled from click until the response or terminal state」，本刀照字面实现：
   - 停止键的禁用态只覆盖本次请求在途；任何响应（202/204/错误）落地后，若视图仍 running，按钮恢复可点；
   - composer 解锁与一切 `已停止` 呈现只来自权威状态（`turn.end stopped` 或快照）。
   - 因此既不存在「只能被 `turn.end` 释放」的状态，也不需要计时器。S7 类残局（202 但 stop 空转）下用户仍可再点（design S4）。
   - 代价：202 之后再点会再发一次 stop，再出一次 Toast。server 对同一回合的重复 stop 返回 202 且不写第二帧，所以无害。
3. **204 被动处理。** 204 的 `"idle"` 表示「server 判定非 running、未做任何事」，不是会话状态（carry-forward :22），本刀不把它写回视图，也不因此发对账 GET。composer 按下一份权威事件或快照收敛（design S3）。主动对账会与两个预期 204 的窗口竞争：受理前窗口，以及 regenerate 提交前窗口（carry-forward :101）。
4. **会话未选中时 `停止` 渲染为禁用。** 欢迎态建会话途中 composer 已锁，但还没有可停的会话 id。此时按钮在同一位置显示为禁用 `停止`，不回退为「禁用的发送」。这使 `chat-page-lifecycle.test.tsx:357` 只需改名（见 design allowed-edit）。
5. **容量文案在 master 上大概率已成立。** 现有 prompt 失败路径已经做到信封文案内联、恢复草稿、解锁（`turn-actions.ts:82-124`，`errors.ts:12`）。因此 S12 标为守卫，不作为红先行；本刀交付的是 spec 与验收证据，外加「web 不硬编码文案」源码守卫（G4）。若 S12 在 master 上为红，按红先行处理并记入 PR body。
6. **tooltip = `title` 属性**（`message-actions.tsx:21` 先例）；Toast 类型取 `info`（demo:2629）。
7. **「composer 的 `已停止` 文案」只是澄清，不是偏离。** 父 tasks 7.2 列了「会话点/步骤徽章/composer 的 `已停止` 文案」。但父 spec 与本 delta 都没有给 composer 定义 `已停止` 字样：composer 在 `stopped` 时的行为只是解锁并换回 `发送`（S2）。`已停止` 只出现在侧栏状态元素、步骤徽章与助手消息徽章上。
8. **202 晚于 `turn.end stopped` 到达**（按钮已随解锁卸载）：只要结果仍属于当前会话/账号/挂载，Toast 照常显示。围栏不检查「是否仍 running」。不设证据行。
9. **regenerate 提交前窗口内的停止是 204 空操作（carry-forward :101）**：regenerate 照常跑完，web 无法中止这一窗口。只记录，不修。
10. **改三处既有断言，与 issue 验收「既有测试零 diff 全绿」冲突。** issue 自己的 In Scope 要求 running 期间 toolbar 不能有 `发送`，以下三处在 master 上必然变红：`web/test/chat-composer.test.tsx:122-146`（C3，按钮名 `生成中`→`停止`、`disabled` true→false、标题随之改）、`:189`（C5 needle 去引号）、`web/test/chat-page-lifecycle.test.tsx:357`（按钮名 `生成中`→`停止`，`disabled` 仍 true）。只改期望值，文件不增长，不删不弱化其它断言；PR body 偏离清单须列出。

11. **测试 support 文件 `web/test/chat-page-lifecycle-support.tsx` 的 `mountAuthenticatedChatRouter` 包一层 `ToastProvider`（净增约 5 行，编排者批准）。** running 期间渲染的 `StopButton` 调 `useToast()`；该 harness 与生产入口 `main.tsx`、主 harness `render-app-router.tsx:15` 不同，不挂 Provider，致 4 条既有用例（A12c、lifecycle 两条、topbar T7）抛错。补齐 Provider 使 harness 与生产一致；不改断言、不改 `web/src`。
## Open questions（上报编排者；偏离 1 越界改 css 已获编排者批准）
- 偏离 2（编排者已确认）：按父文字面「请求在途即禁用」、不保留「停止中」状态；202 之后可重复点击并重复出 Toast（server 重复 stop 为 202 空操作，无害）。
- 偏离 3（编排者已确认）：204 被动、不对账，避免与受理窗口、regenerate 提交前窗口竞争。
- S7 类残局（finishTurn 持久化失败 → 行 running、supervisor 无 claim → stop 202 空转）是 server 侧问题（carry-forward :73/:74 OUT-OF-SCOPE）。web 端保证按钮可点，但无法自行恢复，仍需新 issue。
- 父 tasks 7.2 的「composer 的 `已停止` 文案」在 spec 中没有对应字样（偏离 7）。建议父 delta 归档对账时把 tasks 措辞改为「composer 解锁恢复 `发送`」。
- 父 turn-control Scenario「停止按钮与文案」写的是「发送按钮文案为 `停止`」，实现是「同一 toolbar 位置换成另一个按钮」。chat-web Composer card 段的措辞更准，不影响断言。父 delta 归档对账时可顺手统一。

## Non-goals
- `重新生成`（7.3a #478，含 regenerate 503 内联）、`从此处分叉`（7.3b #479）；`refresh-cw`/`git-branch` 只注册、不在本刀使用。
- API 方法、联合类型与归约（7.1 #472）；server；stop 路由语义（#475）；S7 类 server 残局。
- 真实浏览器与视口矩阵（8.2b #484）。
