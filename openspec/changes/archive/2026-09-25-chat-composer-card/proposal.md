# Proposal: chat-composer-card（#288）

## Why
S1e 组 4 的 4.3，依赖 1.1（#275 `Icon`/`Button` 基元）与 1.2（#276 `ui-pulse` 动效类），两者都已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把 composer 与会话列表状态列为实现偏差：
- 现 composer 是带可见标签的裸 textarea 加文字 `发送` 按钮（`web/src/features/chat/conversation-view.tsx:218-266`）。demo 是卡片：textarea 在上、底部工具栏右侧是圆形发送图标按钮（demo:2576-2603）。
- 会话列表项把服务端英文状态 `running|done|failed|idle` 原样显示成一枚徽章（`conversation-view.tsx:66-72`）。
父 design 决策 8（D8）已拍板：会话项 `role=status`，aria-label 为 `<title> <状态>`，可见点 + 视觉隐藏中文状态，running 加 `ui-pulse`；composer 运行中时 toolbar 出现 `role=status` `生成中`，发送按钮 aria-label 为 `生成中`；ui-walk 的 `selectedSessionStatus` 同 PR 改为中文，`generatingStatus` 保持不变。

## What Changes
- 新 `web/src/features/chat/status-label.ts`：`SESSION_STATUS_LABEL`，映射 `running→运行中`、`done→已完成`、`failed→失败`、`idle→未开始`。步骤徽章（4.2 #287）可复用前三项。
- 新 `web/src/features/chat/composer.tsx`：`Composer({ disabled, draft, generating, onChangeDraft, onSubmit, placeholder, sendDisabled })`。
  - 结构：`<form className="chat-composer">` 内有 `div.chat-composer-card`；卡内依次是视觉隐藏的 `<label>`（文本 `给助手发消息`）、textarea、`div.chat-composer-toolbar`；卡外是提示行 `Enter 发送 · Shift+Enter 换行`。
  - textarea 的键盘逻辑（Enter 发送；Shift/Alt/Ctrl/Meta、composing、keyCode 229、repeat 不发送）原样搬入，不改语义。
  - 工具栏：`generating` 时先渲染 `p.chat-composer-pending[role=status]`，文本 `生成中`；然后是唯一控件，即 `Button`（`variant="primary" size="icon"`，`type="submit"`，`className="chat-send"`），内容 `Icon send`，aria-label 在 `generating` 时为 `生成中`，否则为 `发送`，禁用条件 `sendDisabled` 不变。
- `conversation-view.tsx`：
  - composer 改用 `<Composer>`，placeholder 由 `requestedSessionId` 决定：无选中为 `今天帮你做些什么`，有选中为 `继续追问，或派一个新任务…`。
  - 会话项：`role=status` 元素内含 `aria-hidden` 的点（`chat-session-dot chat-session-dot-<status>`，running 另加 `ui-pulse`）和 `span.ui-sr-only`（中文状态）；aria-label 为 `<title> <中文状态>`。按钮 aria-label 仍为 title。不再显示英文状态文本。
  - props：删掉 `composerLabel`/`generatingLabel`（文案进入 `Composer`），加 `composerPlaceholder` 或由 view 自行计算（实现取舍，design 定为 view 计算）。
- `page.tsx`：删 `COMPOSER_LABEL`/`GENERATING_LABEL` 常量，同步调整传给 `ConversationView` 的 props。
- `chat.css`：composer 卡、工具栏、圆形发送按钮、会话项的点（running 用 `--wb-status-warning`，idle 用 `--wb-text-tertiary`），删掉徽章样式 `.chat-session-status-*` 与可见 label 样式。只用语义 token，加来源注释 demo:282-298、363-378。
- 测试：
  - 新 `web/test/chat-composer.test.tsx`：C1–C6（见 design）。
  - `web/test/chat-page-ownership-gaps.test.tsx:357` `${PROMPT} done` → `${PROMPT} 已完成`。
  - 其它文件里依赖英文会话状态或发送按钮名的断言，按 design 改写规则处理。
- ui-walk：`web/e2e/ui-walk.spec.ts:746` `toHaveText("running")` → `"运行中"`，`:800` `"done"` → `"已完成"`；`generatingStatus` 不改；`bash running|bash done`（步骤徽章，归 #287）不改。

## Non-goals
附件、模型切换、麦克风、停止、工作区/权限底栏（归各自阶段）；欢迎态内容（4.4 #289）；Markdown、气泡、步骤卡（4.1 #286、4.2 #287）；`回到最新`（4.5 #290）；会话项的时间、更多菜单与图标（demo 的 `.conv-item-time`/`.conv-item-more` 无后端契约）；页面生成状态逻辑（`generating`/`sendDisabled` 的来源不变）。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底，替换列表状态句为父 delta 的 status element 句（加 `idle` → `未开始`），在 `Page SHALL derive…` 段前插入父 delta 的 **Composer card** 段，composer 锁定句补 `on the send button`。其余父 delta 内容（Markdown、步骤卡、欢迎态、回到最新）留给各自 issue。

## Impact
`web/src/features/chat/{composer.tsx,status-label.ts}`（新）、`conversation-view.tsx`、`page.tsx`、`chat.css`；`web/test/chat-composer.test.tsx`（新）、`web/test/chat-page-ownership-gaps.test.tsx`，以及 design 改写规则点名的其它测试；`web/e2e/ui-walk.spec.ts` 两处期望。不加依赖，不动服务端。

## 与 oracle 偏差留痕
- 父 delta 的会话状态只列 `运行中|已完成|失败`，服务端还有 `idle`（新建会话、尚无回合，`web/src/lib/session-contract.ts:3`）。demo 对应 `.conv-item-status--pending`（灰点，无文字）。本刀把 `idle` 映射为 `未开始`，写入子 delta；archive PR 同步父 delta（tasks 3.0）。
- demo textarea 无可见标签；父 delta 要求 "labeled multi-line textarea"。标签保留但视觉隐藏（`.ui-sr-only`），可访问名 `给助手发消息` 与 ui-walk `getByLabel("给助手发消息")` 不变。
- demo 发送按钮底色为 `--wb-palette-black-90`（暗色 `white-90`）。ui-guardrails 禁止 feature 使用 palette，改用 `Button` 基元 primary 变体。
- issue 的 Desired behavior 列了 "verification-harness 真实回合 THEN 的会话项 `已完成`"。父 delta（`s1e-frontend-parity/specs/verification-harness/spec.md:27`）把会话项 `已完成` 与步骤徽章 `bash 已完成`（#287）写在同一句 THEN 里，本刀不能整句提前晋升；已晋升文本 "bash和session均done" 语义不错。本刀只改 ui-walk 两处期望，verification-harness 的整段晋升留给 #287（或 6.1）。
- demo composer 外层有 `.composer-slot` 渐变托盘与吉祥物；托盘属欢迎态视觉（4.4），吉祥物是上游品牌图形（ATTRIBUTION §4），本刀都不做。

## Risk triage
- ui-walk 的完成 oracle 是会话项 status 文本。中文化与 e2e 期望必须同 PR，否则 CI 红。本地 ui-walk 为必需证据。
- 发送按钮运行中改 aria-label 为 `生成中`：按 `name: "发送"` 找按钮的测试在运行中会找不到。改写规则钉住，只在非运行态按 `发送` 查找。
- Playwright `getByRole`/`getByLabel` 默认子串匹配：`生成中` 同时是按钮名与 status 文本。`generatingStatus` 按 `role=status` + `hasText ^生成中$` 过滤，按钮不是 status，不冲突。C5 静态钉住按钮不带 `role=status`。
- 状态元素内容从英文变中文，可能有测试按 `getByText("running")` 查找。改写规则要求全仓 grep。
