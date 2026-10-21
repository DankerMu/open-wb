# markdown-body-error-boundary — 助手正文转换栈溢出时的本地错误边界与纯文本回退（#1534）

## Why

助手正文经 `MessageBody`（`web/src/features/chat/message-segments-view.tsx:42-55`）→ `MarkdownBody`（`markdown-body.tsx:93-98`）→ 拷入层 `MarkdownText` 同步做 Markdown→hast 转换。嵌套够深时 unified 生态递归栈溢出：`"> ".repeat(3000) + "x"` 在 `mdast-util-to-hast` 的 `blockquote` 处理器抛 `RangeError: Maximum call stack size exceeded`；#1533 接入 `rehype-raw` 后 `"<div>".repeat(1700) + "x"` 在 `hast-util-from-parse5` 处多一条同类路径。web 端没有任何错误边界（`grep ErrorBoundary|errorElement|getDerivedStateFromError` 零命中），根路由（`router.tsx:80-92`）也没配 `errorElement`，异常一路冒到 react-router，默认错误页替换整个应用壳——侧栏、会话列表、输入框全部消失，且内容已持久化，重开会话照样崩。#848 引入 `MarkdownBody` 时没加边界，之后一直没补。

## What

- `message-segments-view.tsx`：给每个正文段的 `MarkdownBody` 套一个本地错误边界（class 组件，`getDerivedStateFromError`），转换抛错时回退渲染 `whitespace-pre-wrap` 的纯文本原文（React 文本节点，不经 HTML 解析，无 XSS 面）；`text` 与抛错时不同才清错误态（快照原地重装等文本变化时重试；流式 `text.delta` 只追加，嵌套不会变浅，所以回退态在流式期间通常保持；同一文本再次抛错只是再落回回退态，不循环）；错误只影响这一个正文段，同一消息的其它块、其它消息与应用壳不受影响。
- 测试（`web/test/chat-markdown-html.test.tsx` 或新文件）：以 `"> ".repeat(N) + "x"` 与 `"<div>".repeat(N) + "x"` 两种正文触发溢出（N 取能在 jsdom/vitest 下稳定触发的值，断言行为不绑定阈值），断言正文以纯文本显示原文、`<script>` 字面可见、助手 `article` 仍在、页面没有 react-router 默认错误页的 `Unexpected Application Error!`、`console.error` 没收到它那条 `Error handled by React Router default ErrorBoundary` 消息、同会话其它消息与壳仍在；正常深度 Markdown 回归不变。没有本地边界时 react-router 8 的 `RenderErrorBoundary` 会接住异常并渲染默认错误页（`hooks.js:642,646,771`），所以「红」不是未捕获异常，而是上面三个可观测量翻转。
- 不做：根路由 `errorElement`（issue 的备选，只是整页兜底，用户仍看不到会话；本 change 的局部边界已覆盖主路径，纵深防御另议）；上游库补丁；长度 / 深度截断（阈值不可移植）；#1533 白名单。

`design.md` 省略：compact 级，一个组件级边界 + 测试，无 API / 格式 / 状态改动。

## Triage

```text
Issue type: bug
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; S — one local boundary component + tests)
Blast radius: one chat-page component; a wrong boundary either swallows nothing (test red: react-router's default error page replaces the shell, the 助手 article never appears) or swallows too much (regression tests of normal Markdown red) or never retries after a text change (rerender test red)
Selected risk packs: Error handling / rollback (the boundary must catch the render-time stack overflow (RangeError, or V8's SyntaxError "Stack overflow" when the stack runs out inside a regex — measured on x86-64), fall back to plain text, and retry when the text changes); Resource limits / large input (the bug IS a large input exhausting the stack: the test constants N are fixed with margin — the issue's measured 3000 / 1700 or larger, not a probed minimum — because vitest + React + jsdom sit on a deeper call stack than bare node; production never truncates or caps depth); Auth / permissions / secrets — XSS face (the fallback is a React text node, never dangerouslySetInnerHTML; asserted with a literal <script> in the fallback). Existing markdown tests staying green is Must preserve, not a Legacy-compatibility trigger
Evidence floor: npm test --workspace web (full web suite incl. the new cases, green); the two overflow cases red before the boundary exists (react-router default error page, no 助手 article, RR console.error message) and green after; typecheck; make check; size-guard; no server/ change
```
