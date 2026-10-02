# Proposal: conversation-search（#538，父 tasks 7.7）

## Why
长会话里找一句说过的话只能靠滚。父 change 的 conversation-search 规定顶栏给一个 `对话内搜索` 入口：纯前端对当前会话已加载消息的正文做子串匹配，按匹配消息计数，逐条跳转时把消息滚入视并做消息级高亮。这是顶栏三个槽位里最后一个，合入后三按钮全序成立。

## What Changes
- 新建 `web/src/features/chat/search-match.ts`：纯函数 `matchMessages(messages, query)`。
- 新建 `web/src/features/chat/conversation-search.tsx`：`useConversationSearch(sessionId, view)`（搜索的全部状态与分支）与搜索框组件。
- `web/src/features/chat/scroll-follow.tsx`：`FollowTranscript` 增 `handleRef`，暴露 `scrollToMessage(id)`。
- `web/src/features/chat/conversation-view.tsx`：消息 `<article>` 带 `data-message-id`、当前匹配标记；搜索框位置；把句柄交给 `FollowTranscript`。
- `web/src/features/chat/topbar-actions.ts`：`chatTopbar()` 多收 `对话内搜索` 槽（带 `expanded`）。
- `web/src/features/chat/page.tsx`：接线（+3 行）。
- `web/src/features/chat/messages.css`：搜索框与高亮样式。
- 新建 `web/test/search-match.test.ts`（U1–U4）、`web/test/chat-page-search.test.tsx` 与 `web/test/chat-page-search-follow.test.tsx`（合计 S1–S20）及共用的 `web/test/chat-page-search-support.tsx`。
- ADDED `conversation-search`「对话内搜索框」「跳转与消息级高亮」；MODIFIED `chat-web`「会话页」（顶栏 actions 句、搜索框位置句、Scenario「顶栏入口」三按钮版）；MODIFIED `session-sidebar`「会话条目菜单与重命名」与 `spa-shell`「路由 IA 与侧栏」（槽位现状句）。

## Non-goals
- 跨会话搜索；步骤输出、thinking、审批、卡片、错误文案内搜索；消息内字符级高亮（demo 的 `.cs-mark`）。
- demo 的 `第 i / n 处匹配` Toast（有意不渲染）；demo 的 200ms 输入防抖（匹配是一次线性扫描，不需要）。
- ui-walk 的搜索步骤（8.2b）；`web/src/ui/**`、shell、`stream.ts`、server 不动。
- `重命名`、`产物面板` 两个槽位的行为（本刀只断言它们的 DOM 次序）。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **两个既有测试文件有改动**：issue 写「既有测试文件不改动」。顶栏多一个按钮后，对 banner 按钮的整表断言必然变化：`web/test/chat-page-session-rename-pin.test.tsx:470,487,527`（`["重命名", "产物面板"]` → `["重命名", "对话内搜索", "产物面板"]`）与 `:539`（≤760px，前面多 `打开导航`）；`web/test/chat-page-artifacts-panel.test.tsx:101,108,265` 同样三处整表断言，以及 P1 的两个 `chatTopbar(...)` 单元调用（`:124`、`:131`，签名多一个参数）与紧随其后的产出断言（键序多一项 `search`、`artifacts` 的下标由 `[1]` 变 `[2]`）。只改这些期望与调用，不动其余断言。`web/test/chat-scroll-follow.test.tsx` 零 diff（issue 点名的那一个，作为贴底跟随规则的回归网）。
2. **搜索状态不在 `conversation-search.tsx` 的组件里，而在同文件的 hook 里**：顶栏按钮由 `page.tsx` 上报（需要 `expanded` 与 `onSelect`），搜索框渲染在 `ConversationView` 里，状态必须在两者的共同祖先；放进 hook（同 7.6 的 `useArtifactsPanel`）让 `page.tsx` 只多 3 行、`ChatPage` 的认知复杂度不变。
3. **`scrollToMessage` 在调用内同步重算贴底状态**：父文只写「`scrollIntoView`，贴底跟随规则照旧」。浏览器的 scroll 事件在下一帧才派发；在那之前到达的流式增量会让仍处于贴底状态的转录滚回底部，把刚做的跳转冲掉。所以跳转后立即按新位置重算（规则与用户滚动相同），不等 scroll 事件。子 delta 把这一点与「找不到消息时不做任何事」「跳到贴底位置后仍继续跟随」写进 Requirement，并加 Scenario「跳转到底部的匹配后继续跟随」。
4. **输入法组合输入期间的 Enter / Escape 不生效**：父文未写。中文查询经输入法输入，组合期间的 Enter 是「上屏」而不是「下一个」；同 `composer.tsx:55-56` 与 `ui/escape-fallback.ts:32` 的既有做法。子 delta 加一句与 Scenario「组合输入期间的按键不生效」。
5. **输入框用 `Input variant="search"` 基元**（`type="search"`，自带搜索图标与聚焦描边），计数器与三个图标按钮排在它右侧；demo 是一个把输入框、计数与按钮都包进去的胶囊（demo:323-327）。用基元而不是在 feature 里重写一份输入框样式；次序、文案与 demo 相同。
6. **子 delta 另加父文未写的可观察行为**：搜索框是页面列的第一个子节点（在 alert 之上）；计数器在搜索框打开期间始终在 DOM 中；三个图标按钮的图标名；查询按字面使用、不去首尾空白；历史未读到时 `0/0`；没有当前匹配而 `n>0` 时前进取第一条、后退取末条；原当前不再匹配后即使重新匹配也不自动恢复；关闭时焦点归还不依赖按钮在点击时已获得焦点；回到原会话时搜索框不自动重开；新增 Scenario「原当前不再匹配」；每条消息 `<article>` 带 `data-message-id`（写进 chat-web「会话页」）。
7. **chat-web「顶栏入口」的措辞沿用 7.6 的「顶栏的 actions 区恰有…」**（父文「banner 内在面包屑之外恰有…」在 ≤760px 不成立，banner 里还有 `打开导航`）；chat-web 的 actions 句保留主规格里「由有序常量 `CHAT_TOPBAR_ACTIONS` 构造」的说法。
8. **多两个现状句 delta（`session-sidebar`、`spa-shell`）**：两处「`对话内搜索` 槽位尚不产出」在本刀合入后不再成立。`session-sidebar` 的 Scenario「顶栏重命名入口」同时换成父文的三按钮版。
9. **父文「demo 按匹配处数计数」不属实，子 delta 删去**：demo 的 `convSearch`（`resource/workbuddy-live-demo.html:2020`）对每条消息至多 `push` 一次，同样按匹配消息计数。子 delta 把「跳转与消息级高亮」里的这半句改成「计数口径与 demo 相同」；父 proposal「与 demo 的有意偏差」第 1 条的后半句与父 delta 的同一句在父 change rebase 时一并更正。
10. **`messages.css` 有改动**：issue 的 PR Boundary 没列样式文件；搜索框与高亮需要样式，`chat.css` 已 797/800 行，所以进 `messages.css`。
11. 只并入父 delta 的对话内搜索部分；新能力规格的 `Purpose` 在归档时取父 delta 的 Purpose 原文。

## Impact
- web：两个新产品文件、五个既有产品文件改动、三个新测试文件加一个 support、两个既有测试文件的期望更新。server 无改动。
- 运行时：选中会话时顶栏多一个按钮；搜索不发任何请求。搜索框打开时转录区变矮约一行（36px 加 8px 行距）（贴底时仍贴底，由既有的尺寸变化重算保证）。
- 依赖：#529、#531、#537、#489 已合并。
