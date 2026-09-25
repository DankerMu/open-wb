# Proposal: chat-copy-action（#291）

## Why
这是 S1e 组 4 的任务 4.6，依赖 #279（`Toast`）与 #286（助手消息结构），两者均已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把消息操作条列为**计划遗漏**。

现状：`web/src/features/chat/conversation-view.tsx` 的助手块 `div.chat-msg-main` 里只有正文（`.chat-md`）、步骤卡和错误，没有任何操作入口，用户无法取得助手原文。

已有依据：
- 父 delta 的 Messages 段写明："每条助手消息有一个只含 `复制` 的操作条，经 `navigator.clipboard.writeText` 复制原文；剪贴板 API 缺失或 reject 时弹 Toast `复制失败`，异常不外泄"。
- 已晋升的 Messages 句也写了"`复制` copies the raw text"。但 #286 只交付了渲染部分，操作条那句没有随它晋升。

## What Changes
- **新 `web/src/features/chat/message-actions.tsx`**：导出 `MessageActions({ text })`。
  - 渲染 `div.chat-msg-actions`，里面只有一个 `Button`（ghost、icon 尺寸），`aria-label` 与 `title` 都是 `复制`，内容为 `Icon copy`（12，装饰性）。
  - 点击时在同一个 try 中 `await navigator.clipboard.writeText(text)`：成功弹 Toast success `已复制到剪贴板`（demo:1190 原文）；进入 catch 弹 Toast error `复制失败`。catch 覆盖三种失败：API 缺失（访问 `undefined.writeText` 抛 TypeError）、同步抛错、reject。
  - onClick 以 `void` 调用，异常不外泄。
- **`conversation-view.tsx`**：满足以下两个条件时，在助手块 `div.chat-msg-main` 末尾（正文、步骤卡、错误之后）渲染 `<MessageActions text={message.content} />`：
  - `message.status !== "running"`，与 demo:2394 的 `!isStreaming` 一致；
  - `message.content !== ""`，即有原文可复制。
- **`messages.css`**：操作条样式，改编自 demo:528-530，只用语义 token。
- **测试**：新 `web/test/chat-copy.test.tsx`，覆盖 C1–C6。

## Non-goals
- 不做重新生成（S1c）和赞/踩（明确不做）：demo 的另外三个按钮都不渲染。
- 不做 `execCommand('copy')` 回退（demo:1191）：spec 规定失败时弹 Toast。
- 不做代码块复制和产物复制：demo 里有，但它们属于其他呈现件，不在本刀。
- 不改用户消息：demo 的用户消息没有操作条。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底：
  - 在 Messages 段 "…a running assistant SHALL show a blinking caret (`ui-caret`) after the last character." 之后插入操作条句。它在父句的基础上细化了四点：仅非 running 且原文非空时渲染；按钮为图标按钮，可访问名为 `复制`；成功时弹 Toast `已复制到剪贴板`；同步抛错与 reject 同样按失败处理。
  - 新增 Scenario「复制助手原文」。

## Impact
- 新增：`web/src/features/chat/message-actions.tsx`、`web/test/chat-copy.test.tsx`。
- 修改：`web/src/features/chat/{conversation-view.tsx,messages.css}`。
- 不加依赖，不动服务端、`web/src/ui/**`（`ToastProvider` 已在 `main.tsx` 应用根挂载，测试侧由 `web/test/render-app-router.tsx` 挂载）、`page.tsx`、`stream.ts`、e2e。

## 与 oracle 偏差留痕
- demo 的操作条有四个按钮，本刀只渲染 `复制`，这与父 delta 一致：无后端契约支撑的控件不渲染。
- demo 失败时会回退到 `execCommand` 并照样提示"已复制"；本刀按 spec 提示 `复制失败`。
- demo 对空回复也渲染操作条；本刀在原文为空时不渲染，因为没有东西可复制。
- issue 的 PR Boundary 写的是在 `chat-page.test.tsx` 增加三分支用例；本刀改为新建 `web/test/chat-copy.test.tsx`，与同组 4.1/4.2/4.5 的做法一致（`chat-messages`/`chat-steps`/`chat-scroll-follow` 各自独立成文件），`chat-page.test.tsx` 不改。

## Risk triage
Issue type: feature（独立呈现件，mechanical）
Fixture level: expanded
Upstream suggested level: expanded（同意：同组 4 的声明；剪贴板是浏览器权限面，失败路径必须收敛为 Toast）
Blast radius: 助手块 DOM 末尾多一个操作条。现有测试的定位（`article[aria-label=助手]` 首子元素为头像、`.chat-md` 在前、region 步骤卡）不受影响。M4 断言 `within(article).queryByRole("img")` 为 null，而装饰性 Icon 带 `aria-hidden`，所以不受影响。
Selected risk packs: Public API / CLI / script entry（按钮可访问名 `复制`、Toast 文本）；Auth / permissions / secrets（剪贴板权限拒绝即 reject 路径）；Error handling / rollback / partial outputs（API 缺失、reject、同步抛错三条失败路径收敛为 Toast，无未捕获异常）；Legacy compatibility / examples（M1–M5、步骤卡、W5 等现有断言）。
Evidence floor: `make check` exit 0；`web/test` 全绿，含新 `chat-copy.test.tsx`；反向注入各红；`npm run build --workspace web` exit 0；`ci-compiled-server.sh ui-walk`（CI 环境变量）1 passed。
