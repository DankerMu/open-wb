# Proposal: chat-scroll-follow（#290）

## Why
S1e 组 4 的 4.5（依赖 1.2 已合入）。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把"回到最新"列为**计划遗漏**（demo:2011-2029 行所在段，纯前端）。现状：`web/src/features/chat/conversation-view.tsx:223` 的 `.chat-transcript` 是普通滚动容器，没有任何滚动逻辑——打开长历史停在顶部，流式新内容不跟随，也没有回到底部的入口。

父 design 决策 8（D8）已拍板：`scroll` 监听，距底 > `clientHeight` 显示 `回到最新`，自动跟随只在贴底时；新呈现拆到 `features/chat/scroll-follow.tsx`。

## What Changes
- **新 `web/src/features/chat/scroll-follow.tsx`**：
  - 模块私有 hook `useScrollFollow(ref, content)` → `{ showJump, jumpToLatest }`。贴底状态 `pinned` 放在 ref 里（每次 scroll 都更新，不触发渲染）。
  - 导出组件 `FollowTranscript({ content, children })`，渲染 `div.chat-transcript-frame` > `div.chat-transcript`（滚动元素）+ 条件渲染的 `button.chat-jump-latest`（`Icon chevron-down` + `回到最新`）。
- **`conversation-view.tsx`**：选中会话时 transcript 槽改为 `<FollowTranscript key={requestedSessionId} content={historyView}>`；欢迎态保持原 `div.chat-transcript` + `WelcomeIntro` 不变。
- **`messages.css`**：`.chat-transcript-frame`（定位容器）与 `.chat-jump-latest`（改编自 demo:399-401，只用语义 token）。
- **测试**：新 `web/test/chat-scroll-follow.test.tsx`（F1–F8）。

## Non-goals
- 对话内搜索（demo 本身不定位，审查报告标待拍板）。
- 虚拟滚动（issue Out of Scope）。
- 发送新消息时强制回到底部（demo:2713 会重置；spec 只规定"贴底才跟随"，本刀不加）。
- 平滑滚动动画（demo 实际也是 `behavior: 'auto'`）。
- 消息渲染（4.1 已合入）。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底，在 Step cards 段末句 "No fabricated time or todo state." 之后插入 `回到最新` 句（父 delta 原句的细化：仅选中会话渲染、贴底容差 4px、显示后保持到到底或点击、内容增长也会触发显示、打开/切换会话从底部开始），新增 Scenario「回到最新」。

## Impact
- 新增：`web/src/features/chat/scroll-follow.tsx`、`web/test/chat-scroll-follow.test.tsx`。
- 修改：`web/src/features/chat/{conversation-view.tsx,messages.css}`。
- 不加依赖，不动服务端、`web/src/ui/**`、`page.tsx`、`stream.ts`、e2e。

## 与 oracle 偏差留痕
- demo 的"贴底"阈值是距底 < 100px，且按钮只在流式期间上滚时出现（demo:2514-2518）。本刀按父 delta：显示阈值为距底 > 一屏（`clientHeight`），贴底容差 4px，流式与否都生效。
- demo 按钮 `display:none` 常驻 DOM；本刀不渲染（未显示时 DOM 中不存在），与"不摆占位控件"一致。
- demo `z-index: 50`；本仓按钮只需压过同一定位容器内的消息，用 `z-index: 1`。

## Risk triage
Issue type: feature（独立呈现件，mechanical）
Fixture level: expanded
Upstream suggested level: expanded (agree：同组 4 声明；滚动事件、内容更新与会话切换三者的次序是共享状态问题)
Blast radius: 会话态 transcript 槽的元素结构（新增 `.chat-transcript-frame` 包装层）；欢迎态与 composer 不动；jsdom 与 e2e 现有定位均不经过 `.chat-transcript`。
Selected risk packs: Public API / CLI / script entry（按钮可访问名 `回到最新`、`.chat-transcript` 滚动元素）；Concurrency / shared state / ordering（scroll 事件 / layout effect / 会话 key 重挂载）；Resource limits / large input / discovery（长历史、持续增长的流式内容）；Legacy compatibility / examples（欢迎态结构、W5 composer 身份）。
Evidence floor: `make check` exit 0；`web/test` 全绿含新 `chat-scroll-follow.test.tsx`；反向注入八项各红；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。

- 新增定位包装层可能打断欢迎态布局或 composer 身份：欢迎态不包装；包装只替换 composer 之前的那个兄弟槽位，composer 位置不变。`chat-page.test.tsx` W5 证明。
- 滚动跟随时序：在 layout effect 中滚动（绘制前），滚动发生前的贴底状态来自上一次 scroll 事件。F2/F3 证明。
- 切换会话需要重置状态：`key={requestedSessionId}` 重挂载。F6 证明。
